"""Demand-weighted trip sample (gravity model), used to judge whether a scenario helps.

Without passenger counts we estimate where people travel:
  zones        1 km cells of the VAG service area (Zensus 2022 residents)
  attraction   residents + 3 × stop departures in the zone (proxy for jobs, shops, schools)
  trips i→j    residents_i × attraction_j × exp(-distance / 4 km), for 1.5 km ≤ distance ≤ 15 km
A fixed, seeded sample of trips is drawn proportional to this matrix, so busy relations
appear more often. Each trip starts/ends at the stop nearest to its zone centre; the walk
to/from that stop is added to the PT time.
"""

from __future__ import annotations

import random
from collections import defaultdict
from datetime import date
from functools import lru_cache

import numpy as np
import pandas as pd

from expressbus.eval.coverage import cells_frame
from expressbus.eval.timetable import load_day

ZONE_M = 1000
N_TRIPS = 600
DECAY_KM = 4.0
WALK_MPS = 1.2
REFERENCE_DAY = date(2026, 9, 28)


@lru_cache(maxsize=1)
def zones() -> pd.DataFrame:
    cells, _ = cells_frame()
    cells = cells.assign(zx=(cells.x // ZONE_M).astype(int), zy=(cells.y // ZONE_M).astype(int))
    z = cells.groupby(["zx", "zy"]).apply(lambda g: pd.Series({
        "pop": g["pop"].sum(),
        "lat": np.average(g.lat, weights=g["pop"]) if g["pop"].sum() else g.lat.mean(),
        "lon": np.average(g.lon, weights=g["pop"]) if g["pop"].sum() else g.lon.mean(),
    }), include_groups=False).reset_index()
    tt = load_day(REFERENCE_DAY)
    deps = tt.stop_times.groupby("station").size()
    st = tt.stations.set_index("station").loc[deps.index]
    # nearest stop to each zone centre, and departures within 600 m as attraction
    stop, walk, act = [], [], []
    for r in z.itertuples(index=False):
        d = np.hypot((st.lat.values - r.lat) * 111.3, (st.lon.values - r.lon) * 72.4)
        i = int(d.argmin())
        stop.append(st.index[i])
        walk.append(d[i] * 1000 * 1.3 / WALK_MPS)
        act.append(int(deps.values[d < 0.6].sum()))
    z["station"], z["walk_s"], z["departures"] = stop, walk, act
    z["attraction"] = z["pop"] + 3 * z["departures"]
    return z


@lru_cache(maxsize=1)
def trip_sample() -> list[dict]:
    """[{o, d (stations), walk_s, oz, dz (zone index), lat/lon of both ends}] drawn ∝ gravity."""
    z = zones()
    lat, lon = z.lat.values, z.lon.values
    dist = np.hypot((lat[:, None] - lat[None]) * 111.3, (lon[:, None] - lon[None]) * 72.4)
    t = z["pop"].values[:, None] * z["attraction"].values[None] * np.exp(-dist / DECAY_KM)
    t[(dist < 1.5) | (dist > 15)] = 0
    stn = np.asarray(z.station, dtype=object)
    t[stn[:, None] == stn[None]] = 0
    flat = t.ravel() / t.sum()
    rng = random.Random(42)
    idx = rng.choices(range(len(flat)), weights=flat, k=N_TRIPS)
    out = []
    for k in idx:
        i, j = divmod(k, len(z))
        out.append({"o": z.station[i], "d": z.station[j], "oz": i, "dz": j, "walk_s": float(z.walk_s[i] + z.walk_s[j]),
                    "o_lat": float(lat[i]), "o_lon": float(lon[i]), "d_lat": float(lat[j]), "d_lon": float(lon[j]),
                    "km": float(dist[i, j])})
    return out


def grouped() -> dict[str, list[dict]]:
    """Trips grouped by origin station (one planner scan per origin and departure time)."""
    g = defaultdict(list)
    for t in trip_sample():
        g[t["o"]].append(t)
    return g


def points() -> dict[str, tuple[float, float]]:
    st = load_day(REFERENCE_DAY).stations.set_index("station")
    used = {t["o"] for t in trip_sample()} | {t["d"] for t in trip_sample()}
    return {s: (float(st.lat[s]), float(st.lon[s])) for s in used}


if __name__ == "__main__":
    z = zones()
    print(len(z), "zones", int(z["pop"].sum()), "residents")
    s = trip_sample()
    print(len(s), "trips from", len({t["o"] for t in s}), "origin stops; mean distance", round(float(np.mean([t["km"] for t in s])), 1), "km")
    print("top attraction zones:", z.sort_values("attraction", ascending=False).head(5)[["station", "pop", "departures"]].to_dict("records"))



# ---------- full zone-to-zone matrix (for finding and judging express corridors) ----------
PROBE_TIMES = (int(7.5 * 3600), int(16.5 * 3600))


@lru_cache(maxsize=1)
def matrix() -> dict:
    """Gravity demand T (sums to 1), car minutes and distance for all zone pairs."""
    from expressbus.eval.cartimes import car_time, free_flow_matrix

    z = zones()
    lat, lon = z.lat.values, z.lon.values
    dist = np.hypot((lat[:, None] - lat[None]) * 111.3, (lon[:, None] - lon[None]) * 72.4)
    t = z["pop"].values[:, None] * z["attraction"].values[None] * np.exp(-dist / DECAY_KM)
    stn = np.asarray(z.station, dtype=object)
    t[(dist < 1.5) | (dist > 15) | (stn[:, None] == stn[None])] = 0
    t /= t.sum()
    st = load_day(REFERENCE_DAY).stations.set_index("station")
    pts = {s: (float(st.lat[s]), float(st.lon[s])) for s in set(stn)}
    ii, jj = np.nonzero(t)
    free = free_flow_matrix(pts, sorted({(stn[i], stn[j]) for i, j in zip(ii, jj)}))
    car = np.full(t.shape, np.nan)
    for i, j in zip(ii, jj):
        f = free.get((stn[i], stn[j]))
        if f is not None:
            car[i, j] = np.mean([car_time(f, h // 3600, weekend=False) for h in PROBE_TIMES]) / 60
    t[np.isnan(car)] = 0
    t /= t.sum()
    return {"T": t, "car": np.nan_to_num(car, nan=0.0), "dist": dist, "stations": stn, "walk": z.walk_s.values / 60}


def pt_minutes(tt, rows=None) -> np.ndarray:
    """PT door-to-door minutes (walk + wait + ride) for zone rows -> all zones, mean of PROBE_TIMES."""
    from expressbus.eval.planner import Planner

    m = matrix()
    stn, walk = m["stations"], m["walk"]
    rows = range(len(stn)) if rows is None else rows
    planner = Planner(tt)
    col = np.array([planner.idx.get(s, -1) for s in stn])
    out = np.zeros((len(rows), len(stn)))
    by_station = defaultdict(list)
    for k, i in enumerate(rows):
        by_station[stn[i]].append(k)
    for s, ks in by_station.items():
        acc = np.zeros(len(stn))
        for t0 in PROBE_TIMES:
            arr, _ = planner.scan(s, t0)
            a = np.array([arr[c] if c >= 0 else np.inf for c in col], dtype=float) - t0
            acc += np.minimum(np.nan_to_num(a, posinf=7200), 7200) / 60
        for k in ks:
            out[k] = acc / len(PROBE_TIMES) + walk[rows[k]] + walk
    return out
