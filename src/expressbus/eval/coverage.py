"""Supply vs. demand: where is the network over- or under-supplied?

Demand proxy: residents per 300 m cell (Zensus 2022, 100 m grid, © Statistisches Bundesamt,
dl-de/by-2-0). Jobs, schools and shopping are NOT in this data, so the city centre and
business parks look "over-supplied" relative to residents; cells with few residents are
labelled "destination area" instead of being classified.

Supply: places offered per weekday (06–21 h) at stops within walking distance, with a
linear distance decay (bus/tram 400 m, U-Bahn/S-Bahn 600 m) and a nominal capacity per
departure. The index is places per resident relative to the city-wide median, on a log2
scale: 0 = typical, +1 = twice the typical supply, -1 = half.

For redistributing *bus* drivers the key signal is bus supply in cells that rail already
covers well (redundant bus places) vs. residents with little or no service at all.
"""

from __future__ import annotations

from collections import defaultdict
from datetime import date
from functools import lru_cache

import numpy as np
import pandas as pd
from pyproj import Transformer

from expressbus.data.vag import ROOT
from expressbus.eval.kpis import WINDOW
from expressbus.eval.timetable import BBOX, load_day

ZENSUS_CSV = ROOT / "data" / "raw" / "zensus" / "Zensus2022_Bevoelkerungszahl_100m-Gitter.csv"
ZENSUS_CACHE = ROOT / "data" / "processed" / "zensus_study_area.parquet"
REFERENCE_DAY = date(2026, 9, 28)
CELL_M = 300
CAPACITY = {"Bus": 70, "OtherBus": 70, "Tram": 160, "UBahn": 600, "SBahn": 600, "Rail": 600}  # places/departure
RADIUS_M = {"Bus": 400, "OtherBus": 400, "Tram": 400, "UBahn": 600, "SBahn": 600, "Rail": 600}
SERVICE_AREA_M = 1500
MIN_RESIDENTS = 60  # below this a cell is not classified (too few people for a per-capita index)
RAIL_COVERED_PLACES = 20_000  # rail places/day in reach above which a cell counts as rail-covered

_to3035 = Transformer.from_crs(4326, 3035, always_xy=True)
_to4326 = Transformer.from_crs(3035, 4326, always_xy=True)


def residents() -> pd.DataFrame:
    """Zensus 100 m cells in the study area: x, y (EPSG:3035 metres), pop."""
    if not ZENSUS_CACHE.exists():
        x0, y0 = _to3035.transform(BBOX["lon_min"], BBOX["lat_min"])
        x1, y1 = _to3035.transform(BBOX["lon_max"], BBOX["lat_max"])
        df = pd.read_csv(ZENSUS_CSV, sep=";", usecols=["x_mp_100m", "y_mp_100m", "Einwohner"])
        df = df[df.x_mp_100m.between(x0, x1) & df.y_mp_100m.between(y0, y1) & (df.Einwohner > 0)]
        df = df.rename(columns={"x_mp_100m": "x", "y_mp_100m": "y", "Einwohner": "pop"})
        ZENSUS_CACHE.parent.mkdir(parents=True, exist_ok=True)
        df.to_parquet(ZENSUS_CACHE, index=False)
    return pd.read_parquet(ZENSUS_CACHE)


def station_supply(day: date = REFERENCE_DAY) -> pd.DataFrame:
    """Per station and product: places offered 06–21 h and the lines serving it."""
    tt = load_day(day)
    st = tt.stop_times.merge(tt.trips[["trip_id", "product", "line"]], on="trip_id")
    last = st.groupby("trip_id").seq.transform("max")
    st = st[(st.seq < last) & (st.dep >= WINDOW[0]) & (st.dep < WINDOW[1])]  # departures only
    g = st.groupby(["station", "product"]).agg(deps=("trip_id", "size"), lines=("line", lambda s: sorted(set(s))))
    g = g.reset_index().merge(tt.stations, on="station")
    g["places"] = g.deps * g["product"].map(CAPACITY)
    g["x"], g["y"] = _to3035.transform(g.lon.values, g.lat.values)
    return g


@lru_cache(maxsize=1)
def supply_demand() -> dict:
    pop = residents()
    pop = pop.assign(cx=(pop.x // CELL_M).astype(int), cy=(pop.y // CELL_M).astype(int))
    cells = pop.groupby(["cx", "cy"]).agg(pop=("pop", "sum")).reset_index()
    cells["x"] = (cells.cx + 0.5) * CELL_M
    cells["y"] = (cells.cy + 0.5) * CELL_M

    sup = station_supply()
    cx, cy = cells.x.values, cells.y.values
    supply = {p: np.zeros(len(cells)) for p in CAPACITY}
    nearest_stop = np.full(len(cells), np.inf)
    nearest_vag = np.full(len(cells), np.inf)
    bus_lines: list[set] = [set() for _ in range(len(cells))]
    for r in sup.itertuples(index=False):
        rad = RADIUS_M[r.product]
        d = np.hypot(cx - r.x, cy - r.y)
        m = d < rad
        supply[r.product][m] += r.places * (1 - d[m] / rad)
        nearest_stop = np.minimum(nearest_stop, d)
        if r.product in ("Bus", "Tram", "UBahn"):
            nearest_vag = np.minimum(nearest_vag, d)
        if r.product == "Bus":
            for i in np.nonzero(d < RADIUS_M["Bus"])[0]:
                bus_lines[i].update(r.lines)

    # VAG service area only: cells within 1.5 km of a VAG stop
    keep = nearest_vag <= SERVICE_AREA_M
    cells = cells[keep].reset_index(drop=True)
    supply = {p: v[keep] for p, v in supply.items()}
    nearest_stop = nearest_stop[keep]
    bus_lines = [b for b, k in zip(bus_lines, keep) if k]
    cx, cy = cells.x.values, cells.y.values
    cells["bus"] = supply["Bus"]
    cells["other_bus"] = supply["OtherBus"]
    cells["rail"] = supply["Tram"] + supply["UBahn"] + supply["SBahn"] + supply["Rail"]
    cells["total"] = cells.bus + cells.other_bus + cells.rail
    cells["nearest_m"] = nearest_stop
    classified = cells["pop"] >= MIN_RESIDENTS
    per_cap = cells.total / cells["pop"].clip(lower=1)
    median = float(per_cap[classified & (cells.total > 0)].median())
    cells["index"] = np.log2(np.clip(per_cap / median, 1 / 16, 16))

    def cls(r):
        if r["pop"] < MIN_RESIDENTS:
            return "destination" if r.total > 0 else "empty"
        if r.nearest_m > 600 or r.total < 500:
            return "unserved"
        if r["index"] <= -1:
            return "under"
        if r["index"] >= 1:
            return "over"
        return "balanced"

    cells["class"] = cells.apply(cls, axis=1)
    cells["rail_covered"] = cells.rail >= RAIL_COVERED_PLACES
    lon, lat = _to4326.transform(cells.x.values, cells.y.values)
    cells["lat"], cells["lon"] = lat, lon
    cells["bus_lines"] = [sorted(s, key=_num) for s in bus_lines]

    # summary numbers
    total_pop = int(cells["pop"].sum())
    unserved = cells[cells["class"] == "unserved"]
    under = cells[cells["class"] == "under"]
    redundant = cells[cells.rail_covered & (cells.bus > 0)]
    summary = {
        "residents": total_pop,
        "median_places_per_resident": round(median, 1),
        "residents_unserved": int(unserved["pop"].sum()),
        "residents_under": int(under["pop"].sum()),
        "residents_over": int(cells.loc[cells["class"] == "over", "pop"].sum()),
        "bus_places_in_rail_covered": round(float(redundant.bus.sum() / max(1, cells.bus.sum())), 3),
    }

    # top lists: clusters of unserved/under-served residents, bus lines with most places where rail covers
    def cluster(df, n=10):
        out, used = [], np.zeros(len(df), bool)
        df = df.sort_values("pop", ascending=False).reset_index(drop=True)
        for i, r in df.iterrows():
            if used[i]:
                continue
            m = np.hypot(df.x - r.x, df.y - r.y) < 900
            m &= ~used
            used |= m.values
            grp = df[m]
            out.append({"lat": float(grp.lat.mean()), "lon": float(grp.lon.mean()), "residents": int(grp["pop"].sum()),
                        "nearest_stop_m": int(grp.nearest_m.min()), "places_per_resident": round(float(grp.total.sum() / grp["pop"].sum()), 1),
                        "bus_lines": sorted(set().union(*map(set, grp.bus_lines)), key=_num),
                        "lines": [f"Bus {x}" for x in sorted(set().union(*map(set, grp.bus_lines)), key=_num)]})
            if len(out) >= n:
                break
        return sorted(out, key=lambda c: -c["residents"])

    line_redundant = defaultdict(float)
    for r in redundant.itertuples(index=False):
        for ln in r.bus_lines:
            line_redundant[ln] += r.bus / max(1, len(r.bus_lines))
    line_total = defaultdict(float)
    for r in cells[cells.bus > 0].itertuples(index=False):
        for ln in r.bus_lines:
            line_total[ln] += r.bus / max(1, len(r.bus_lines))
    redundant_lines = [{"line": f"Bus {ln}", "share": round(v / line_total[ln], 2), "places": round(v)}
                       for ln, v in sorted(line_redundant.items(), key=lambda x: -x[1] / max(1, line_total[x[0]]))
                       if line_total[ln] > 0 and v / line_total[ln] >= 0.3][:12]

    half = CELL_M / 2
    corners = [_to4326.transform(cells.x.values + dx, cells.y.values + dy) for dx, dy in ((-half, -half), (half, half))]
    grid = [[round(float(corners[0][1][i]), 5), round(float(corners[0][0][i]), 5),
             round(float(corners[1][1][i]), 5), round(float(corners[1][0][i]), 5),
             int(r["pop"]), round(float(r["index"]), 2), r["class"], int(r["bus"]), int(r["rail"]), bool(r["rail_covered"])]
            for i, r in enumerate(cells.to_dict("records")) if r["class"] != "empty"]
    return {
        "title": "Supply vs. demand",
        "question": "Where are places offered out of proportion to the residents who live there?",
        "source": "VGN timetable Mon 28.09.2026 · residents: Zensus 2022 (100 m grid)",
        "cell_m": CELL_M,
        "columns": ["lat0", "lon0", "lat1", "lon1", "residents", "index", "class", "bus_places", "rail_places", "rail_covered"],
        "grid": grid,
        "summary": summary,
        "unserved_clusters": cluster(cells[cells["class"].isin(["unserved", "under"])]),
        "redundant_lines": redundant_lines,
        "assumptions": "Places/departure: bus 70, tram 160, U-/S-Bahn 600. Walking reach: bus/tram 400 m, U/S 600 m, linear decay. "
                       "Demand = residents only (no jobs/schools/shops) → centre and business parks show as destination areas.",
    }


def _num(s: str):
    digits = "".join(c for c in s if c.isdigit())
    return (int(digits) if digits else 9999, s)


if __name__ == "__main__":
    import time

    t0 = time.time()
    r = supply_demand()
    print(f"{len(r['grid'])} cells in {time.time() - t0:.1f}s", r["summary"])
    print(pd.Series([g[6] for g in r["grid"]]).value_counts().to_dict())
    print("under-served clusters:")
    for c in r["unserved_clusters"]:
        print("  ", c)
    print("bus lines mostly running where rail covers:")
    for x in r["redundant_lines"]:
        print("  ", x)
