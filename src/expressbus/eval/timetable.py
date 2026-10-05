"""Planned timetable (VGN GTFS) for a given service day, reduced to the study area.

The GTFS feed (https://www.vgn.de/opendata/GTFS.zip, CC-BY 3.0 DE, VGN GmbH) covers the
whole VGN region. We keep VAG lines (U-Bahn, tram, city/night/replacement bus) as the
"editable" network. Everything else inside the study area (S-Bahn, regional trains, Fürth
city buses, regional buses) stays as fixed background, since passengers use it too.

    python -m expressbus.eval.timetable   # download + preprocess once (~1 min)
"""

from __future__ import annotations

import io
import zipfile
from dataclasses import dataclass, field
from datetime import date

import httpx
import pandas as pd

from expressbus.data.vag import ROOT

GTFS_URL = "https://www.vgn.de/opendata/GTFS.zip"
GTFS_ZIP = ROOT / "data" / "raw" / "gtfs" / "vgn_gtfs.zip"
CACHE = ROOT / "data" / "processed" / "gtfs"

# Nürnberg + Fürth (+ a margin); stops outside are dropped
BBOX = {"lon_min": 10.90, "lon_max": 11.25, "lat_min": 49.33, "lat_max": 49.56}
# GTFS route_id prefix -> product. VAG = 11 (U), 12 (tram), 13 (bus), 16 (night), 17 (replacement)
PREFIX_PRODUCT = {"11": "UBahn", "12": "Tram", "13": "Bus", "16": "Bus", "17": "Bus", "1": "SBahn"}
EDITABLE = {"UBahn", "Tram", "Bus"}  # VAG products scenarios may change


def _station(stop_id: str) -> str:
    """'de:09564:1283:15:7' -> 'de:09564:1283' (merge platforms into one station)."""
    return ":".join(stop_id.split(":")[:3])


def preprocess(force: bool = False) -> None:
    if (CACHE / "stop_times.parquet").exists() and not force:
        return
    if not GTFS_ZIP.exists():
        GTFS_ZIP.parent.mkdir(parents=True, exist_ok=True)
        GTFS_ZIP.write_bytes(httpx.get(GTFS_URL, timeout=300, follow_redirects=True).content)
    CACHE.mkdir(parents=True, exist_ok=True)
    z = zipfile.ZipFile(GTFS_ZIP)

    def read(name, **kw):
        return pd.read_csv(io.BytesIO(z.read(name)), dtype=str, encoding="utf-8-sig", **kw)

    routes = read("routes.txt")
    routes["product"] = routes.route_id.str.split("-").str[0].map(PREFIX_PRODUCT)
    other = routes["product"].isna()
    routes.loc[other & (routes.route_type == "3"), "product"] = "OtherBus"  # infra fürth, regional buses
    routes.loc[other & routes.route_type.isin(["0", "1", "2"]), "product"] = "Rail"  # RB/RE
    routes = routes.dropna(subset=["product"])
    trips = read("trips.txt", usecols=["route_id", "service_id", "trip_id", "trip_headsign", "direction_id"])
    trips = trips.merge(routes[["route_id", "route_short_name", "product"]], on="route_id")
    trips = trips.rename(columns={"route_short_name": "line", "trip_headsign": "headsign", "direction_id": "direction"})

    stops = read("stops.txt")
    stops = stops[stops.location_type.fillna("0") != "1"]  # drop "Parent..." station rows
    stops["lat"], stops["lon"] = stops.stop_lat.astype(float), stops.stop_lon.astype(float)
    stops = stops[stops.lat.between(BBOX["lat_min"], BBOX["lat_max"]) & stops.lon.between(BBOX["lon_min"], BBOX["lon_max"])]
    stops["station"] = stops.stop_id.map(_station)
    stations = stops.groupby("station").agg(name=("stop_name", "first"), lat=("lat", "mean"), lon=("lon", "mean")).reset_index()

    st = read("stop_times.txt", usecols=["trip_id", "arrival_time", "departure_time", "stop_id", "stop_sequence"])
    st = st[st.trip_id.isin(trips.trip_id) & st.stop_id.isin(stops.stop_id)]

    def secs(col):
        p = col.str.split(":", expand=True).astype(int)
        return p[0] * 3600 + p[1] * 60 + p[2]

    st = pd.DataFrame({
        "trip_id": st.trip_id,
        "seq": st.stop_sequence.astype(int),
        "station": st.stop_id.map(_station),
        "arr": secs(st.arrival_time).astype("int32"),
        "dep": secs(st.departure_time).astype("int32"),
    }).sort_values(["trip_id", "seq"])
    # trips that touch the study area at >= 2 stops
    counts = st.groupby("trip_id").size()
    st = st[st.trip_id.isin(counts[counts >= 2].index)]
    trips = trips[trips.trip_id.isin(st.trip_id.unique())]
    st["seq"] = st.groupby("trip_id").cumcount().astype("int16")

    st.to_parquet(CACHE / "stop_times.parquet", index=False)
    trips.to_parquet(CACHE / "trips.parquet", index=False)
    stations.to_parquet(CACHE / "stations.parquet", index=False)
    read("calendar.txt").to_parquet(CACHE / "calendar.parquet", index=False)
    read("calendar_dates.txt").to_parquet(CACHE / "calendar_dates.parquet", index=False)


def active_services(day: date) -> set[str]:
    cal = pd.read_parquet(CACHE / "calendar.parquet")
    cd = pd.read_parquet(CACHE / "calendar_dates.parquet")
    ds = day.strftime("%Y%m%d")
    wd = ["monday", "tuesday", "wednesday", "thursday", "friday", "saturday", "sunday"][day.weekday()]
    on = set(cal[(cal[wd] == "1") & (cal.start_date <= ds) & (cal.end_date >= ds)].service_id)
    on |= set(cd[(cd.date == ds) & (cd.exception_type == "1")].service_id)
    on -= set(cd[(cd.date == ds) & (cd.exception_type == "2")].service_id)
    return on


@dataclass
class Timetable:
    """One service day. stop_times: trip_id, seq, station, arr, dep (seconds after midnight)."""

    day: date
    trips: pd.DataFrame  # trip_id, line, product, direction, headsign, route_id
    stop_times: pd.DataFrame
    stations: pd.DataFrame  # station, name, lat, lon
    notes: list[str] = field(default_factory=list)
    interline_groups: list[set[tuple[str, str]]] = field(default_factory=list)  # lines sharing vehicles

    def copy(self) -> Timetable:
        return Timetable(self.day, self.trips.copy(), self.stop_times.copy(), self.stations,
                         list(self.notes), [set(g) for g in self.interline_groups])

    @property
    def lines(self) -> list[tuple[str, str]]:
        """(product, line) of editable lines, sorted."""
        t = self.trips[self.trips["product"].isin(EDITABLE)][["product", "line"]].drop_duplicates()
        order = {"UBahn": 0, "Tram": 1, "Bus": 2}
        return sorted(map(tuple, t.values), key=lambda x: (order[x[0]], len(x[1]), x[1]))


_cache: dict[date, Timetable] = {}


def load_day(day: date) -> Timetable:
    if day not in _cache:
        preprocess()
        services = active_services(day)
        trips = pd.read_parquet(CACHE / "trips.parquet")
        trips = trips[trips.service_id.isin(services)].drop(columns="service_id").reset_index(drop=True)
        st = pd.read_parquet(CACHE / "stop_times.parquet")
        st = st[st.trip_id.isin(trips.trip_id)].reset_index(drop=True)
        stations = pd.read_parquet(CACHE / "stations.parquet")
        _cache[day] = Timetable(day, trips, st, stations)
    return _cache[day].copy()


if __name__ == "__main__":
    preprocess(force=True)
    tt = load_day(date(2026, 9, 28))
    print(f"{tt.day}: {len(tt.trips)} trips, {len(tt.stop_times)} stop events, {len(tt.lines)} VAG lines")
    print(tt.trips.groupby("product").size().to_dict())
