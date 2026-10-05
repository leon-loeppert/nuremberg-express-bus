"""KPIs for one service day of a (scenario) timetable.

Travel time   PT vs. car for a fixed, seeded sample of trips (origin, destination,
              departure time). PT time includes the initial wait, so frequency matters.
Headways      per directed stop-to-stop edge, 06-21h: expected wait for a passenger
              arriving at random, overlaps (departures < 2 min apart, i.e. two vehicles
              doing the same job) and gaps (> 20 min without a departure).
Delay         observed average delay per line from the recorded live data, weighted by
              the scenario's trips per line (a proxy: we have no history before recording).
"""

from __future__ import annotations

import json
import math
import random
from datetime import date
from functools import lru_cache

import numpy as np
import pandas as pd

from expressbus.data.vag import ROOT
from expressbus.eval.timetable import EDITABLE, Timetable, load_day

WINDOW = (6 * 3600, 21 * 3600)
OVERLAP_S = 120
GAP_S = 20 * 60
UNREACHABLE_CAP_S = 120 * 60
RECORD_DIR = ROOT / "data" / "raw" / "live"
REFERENCE_DAY = date(2026, 9, 28)  # weekday used to draw the OD sample

N_ORIGINS, N_DEST, N_TIMES = 40, 10, 6
# share of trips starting in each hour (typical weekday / weekend profile)
PROFILE_WD = {6: 4, 7: 9, 8: 8, 9: 5, 10: 4, 11: 4, 12: 5, 13: 5, 14: 5, 15: 6, 16: 8, 17: 8, 18: 6, 19: 4, 20: 3}
PROFILE_WE = {8: 3, 9: 4, 10: 6, 11: 7, 12: 7, 13: 7, 14: 7, 15: 7, 16: 6, 17: 6, 18: 5, 19: 4, 20: 3}


# ---------- OD sample ----------
@lru_cache(maxsize=1)
def od_sample() -> tuple[list[tuple[str, list[str]]], dict]:
    """[(origin, [destinations])] drawn once, weighted by sqrt(departures) as a demand proxy."""
    tt = load_day(REFERENCE_DAY)
    vag = tt.trips.trip_id[tt.trips["product"].isin(EDITABLE)]
    deps = tt.stop_times[tt.stop_times.trip_id.isin(vag)].groupby("station").size()
    st = tt.stations.set_index("station").loc[deps.index]
    rng = random.Random(42)
    names, weights = list(deps.index), list(np.sqrt(deps.values))
    origins = []
    while len(origins) < N_ORIGINS:
        o = rng.choices(names, weights)[0]
        if o not in origins:
            origins.append(o)
    lat, lon = st.lat, st.lon
    sample = []
    for o in origins:
        dist = np.hypot((lon - lon[o]) * 72.4, (lat - lat[o]) * 111.3)
        cand = [s for s in names if 1.5 <= dist[s] <= 12]
        w = [math.sqrt(deps[s]) for s in cand]
        dests = set()
        while len(dests) < min(N_DEST, len(cand)):
            dests.add(rng.choices(cand, w)[0])
        sample.append((o, sorted(dests)))
    points = {s: (lat[s], lon[s]) for s in names}
    return sample, points


def departure_times(day: date) -> list[int]:
    weekend = day.weekday() >= 5 or _is_holiday_schedule(day)
    prof = PROFILE_WE if weekend else PROFILE_WD
    rng = random.Random(day.toordinal())
    hours = rng.choices(list(prof), list(prof.values()), k=N_TIMES)
    return sorted(h * 3600 + rng.randrange(3600) for h in hours)


def _is_holiday_schedule(day: date) -> bool:
    return day.weekday() < 5 and len(load_day(day).trips) < 0.7 * len(load_day(REFERENCE_DAY).trips)


# ---------- KPIs ----------
def travel_kpis(tt: Timetable, aliases: dict[str, str] | None = None) -> dict:
    """PT vs. car on the demand matrix (see demand.py): every zone-to-zone trip, weighted by demand,
    door to door (walk + wait + ride) at the day's sampled departure times."""
    from expressbus.eval import demand

    m = demand.matrix()
    T, car = m["T"], m["car"]
    pt = demand.pt_minutes(tt, times=tuple(departure_times(tt.day)))
    on = T > 0
    ratio = np.where(on, pt / np.where(car > 0, car, 1), 0)
    order = np.argsort(ratio[on])
    w = T[on][order] / T[on].sum()
    median = float(ratio[on][order][np.searchsorted(np.cumsum(w), 0.5)])
    return {
        "pt_car_ratio_median": round(median, 3),
        "pt_car_ratio_mean": round(float((T * ratio).sum()), 3),
        "share_competitive": round(float(T[on & (pt <= 1.5 * car)].sum()), 4),
        "pt_minutes_mean": round(float((T * pt).sum()), 2),
        "car_minutes_mean": round(float((T * car).sum()), 2),
        "transfers_mean": None,
        "unreachable_share": round(float(T[on & (pt >= 120)].sum()), 4),
        "od_trips": int(on.sum()),
    }


def edge_departures(tt: Timetable) -> pd.DataFrame:
    vag = tt.trips[tt.trips["product"].isin(EDITABLE)]
    st = tt.stop_times[tt.stop_times.trip_id.isin(vag.trip_id)].sort_values(["trip_id", "seq"])
    nxt = st.station.shift(-1)
    same = st.trip_id.values == st.trip_id.shift(-1).values
    e = st[same].assign(to=nxt[same])
    e = e.merge(vag[["trip_id", "line"]], on="trip_id")
    return e[(e.dep >= WINDOW[0]) & (e.dep < WINDOW[1])][["station", "to", "dep", "line"]]


def headway_kpis(tt: Timetable, reference_edges: set[tuple[str, str]] | None = None) -> dict:
    e = edge_departures(tt)
    span = WINDOW[1] - WINDOW[0]
    waits, overlaps, gaps_time, n_headways, n_gaps = [], 0, 0.0, 0, 0
    served = set()
    for (a, b), g in e.groupby(["station", "to"]):
        served.add((a, b))
        times = np.sort(g.dep.values)
        h = np.diff(np.concatenate([[WINDOW[0]], times, [WINDOW[1]]])).astype(float)
        waits.append(min((h ** 2).sum() / (2 * span), 3600))
        inner = np.diff(times)
        if g.line.nunique() > 1:
            overlaps += int((inner < OVERLAP_S).sum())
        n_headways += len(inner)
        gaps_time += float(np.clip(h - GAP_S, 0, None).sum())
        n_gaps += int((h > GAP_S).sum())
    if reference_edges:
        missing = reference_edges - served
        waits += [3600 / 2] * len(missing)  # edge lost its service: assume a 30 min wait
        gaps_time += span * len(missing)
        n_edges = len(reference_edges | served)
    else:
        n_edges = len(served)
    return {
        "expected_wait_min": round(float(np.mean(waits)) / 60, 2),
        "overlap_share": round(overlaps / max(1, n_headways), 4),
        "gap_share": round(gaps_time / (span * n_edges), 4),
        "gaps_over_20min": n_gaps,
        "edges": n_edges,
    }


@lru_cache(maxsize=1)
def observed_delays() -> tuple[dict[tuple[str, str], tuple[float, float, int]], list[str]]:
    """(product, line) -> (mean delay min, punctuality share <= 3 min, n stop events)."""
    rows = []
    days = []
    for f in sorted(RECORD_DIR.glob("trips_*.jsonl")):
        days.append(f.stem.removeprefix("trips_"))
        for line in f.read_text().splitlines():
            t = json.loads(line)
            if not t.get("realtime"):
                continue
            for s in t["stops"]:
                rows.append((t["product"], t["line"], s["delay"]))
    if not rows:
        return {}, []
    df = pd.DataFrame(rows, columns=["product", "line", "delay"])
    df["delay"] = df.delay.clip(lower=0) / 60
    agg = df.groupby(["product", "line"]).delay.agg(["mean", lambda x: (x <= 3).mean(), "size"])
    return {k: (float(v.iloc[0]), float(v.iloc[1]), int(v.iloc[2])) for k, v in agg.iterrows()}, days


def delay_kpis(tt: Timetable) -> dict:
    per_line, days = observed_delays()
    if not per_line:
        return {"delay_mean_min": None, "punctuality": None, "delay_source": "no recorded live data yet"}
    n = sum(v[2] for v in per_line.values())
    net_mean = sum(v[0] * v[2] for v in per_line.values()) / n
    net_punct = sum(v[1] * v[2] for v in per_line.values()) / n
    counts = tt.trips[tt.trips["product"].isin(EDITABLE)].groupby(["product", "line"]).size()
    factor = getattr(tt, "delay_factor", {})
    d = p = w = 0.0
    for key, c in counts.items():
        mean, punct, _ = per_line.get(key, (net_mean, net_punct, 0))
        f = factor.get(key, 1.0)
        d += c * mean * f
        p += c * min(1.0, punct + (1 - punct) * (1 - f))
        w += c
    return {
        "delay_mean_min": round(d / w, 2),
        "punctuality": round(p / w, 3),
        "delay_source": f"observed on {', '.join(days)} ({n} stop events)",
    }
