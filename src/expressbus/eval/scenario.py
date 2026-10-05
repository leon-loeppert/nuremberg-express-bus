"""Scenario features: edits applied to a day's timetable.

A scenario is a list of {"type": ..., **params}. Lines are referenced as "Product:Line"
(e.g. "Bus:36"); "Bus:*" means all bus lines. Every feature is applied to every day of
the evaluation period unless it has "days": "weekday" | "weekend".
"""

from __future__ import annotations

import itertools
import math

import numpy as np
import pandas as pd

from expressbus.eval.cartimes import CONGESTION, free_flow_matrix, street_route
from expressbus.eval.timetable import Timetable

FEATURES = {
    "remove_line": {"label": "Remove line", "help": "Delete every trip of a line."},
    "thin_line": {"label": "Thin out trips", "help": "Keep only every n-th trip of a line in a time window (e.g. evenings)."},
    "densify_line": {"label": "More trips", "help": "Double the frequency of a line in a time window (an extra trip halfway between two)."},
    "shorten_line": {"label": "Shorten line", "help": "Cut a line at a station and drop the part towards one terminus (e.g. where it runs parallel to rail)."},
    "speedup": {"label": "Speed up line", "help": "Bus lanes / signal priority: running times x (1 - pct). Fewer vehicles needed, less delay."},
    "interline": {"label": "Merge lines (interlining)", "help": "Two lines share vehicles at a common terminus; passengers ride through without changing."},
    "debunch": {"label": "Interleave parallel lines", "help": "Shift one line's timetable so it fills gaps of another line on their shared section instead of running right behind it."},
    "add_express": {"label": "Add express line", "help": "New express bus serving only the given stations."},
}


def _line_mask(tt: Timetable, ref: str) -> pd.Series:
    product, line = ref.split(":", 1)
    m = tt.trips["product"] == product
    return m if line == "*" else m & (tt.trips["line"] == line)


def _applies(f: dict, tt: Timetable) -> bool:
    days = f.get("days", "all")
    weekend = tt.day.weekday() >= 5
    return days == "all" or (days == "weekend") == weekend


def _drop_trips(tt: Timetable, trip_ids) -> None:
    trip_ids = set(trip_ids)
    tt.trips = tt.trips[~tt.trips.trip_id.isin(trip_ids)]
    tt.stop_times = tt.stop_times[~tt.stop_times.trip_id.isin(trip_ids)]


def _first_dep(tt: Timetable) -> pd.Series:
    return tt.stop_times.groupby("trip_id").dep.min()


# ---------- features ----------
def remove_line(tt: Timetable, line: str, **_) -> None:
    _drop_trips(tt, tt.trips.trip_id[_line_mask(tt, line)])


def thin_line(tt: Timetable, line: str, from_h: float = 20, to_h: float = 24, keep_every: int = 2, **_) -> None:
    trips = tt.trips[_line_mask(tt, line)].copy()
    trips["start"] = trips.trip_id.map(_first_dep(tt))
    win = trips[(trips.start >= from_h * 3600) & (trips.start < to_h * 3600)].sort_values("start")
    drop = []
    for _, g in win.groupby(["product", "line", "direction"]):
        drop += [t for i, t in enumerate(g.trip_id) if i % int(keep_every) != 0]
    _drop_trips(tt, drop)


def densify_line(tt: Timetable, line: str, from_h: float = 6, to_h: float = 20, **_) -> None:
    """Insert a copy of each trip halfway to the next one of the same direction."""
    trips = tt.trips[_line_mask(tt, line)].copy()
    trips["start"] = trips.trip_id.map(_first_dep(tt))
    win = trips[(trips.start >= from_h * 3600) & (trips.start < to_h * 3600)].sort_values("start")
    st = tt.stop_times.set_index("trip_id")
    new_trips, new_st = [], []
    for _, g in win.groupby(["product", "line", "direction"]):
        rows = g.to_dict("records")
        for a, b in itertools.pairwise(rows):
            gap = b["start"] - a["start"]
            if gap < 6 * 60:
                continue
            tid = f"{a['trip_id']}.d"
            shift = int(gap // 2)
            src = st.loc[[a["trip_id"]]].reset_index()
            src["trip_id"] = tid
            src[["arr", "dep"]] += shift
            new_st.append(src)
            new_trips.append({**{k: a[k] for k in tt.trips.columns}, "trip_id": tid})
    if new_trips:
        tt.trips = pd.concat([tt.trips, pd.DataFrame(new_trips)], ignore_index=True)
        tt.stop_times = pd.concat([tt.stop_times, *new_st], ignore_index=True)


def shorten_line(tt: Timetable, line: str, at_station: str, drop_towards: str, **_) -> None:
    ids = set(tt.trips.trip_id[_line_mask(tt, line)])
    st = tt.stop_times
    keep_rows = np.ones(len(st), dtype=bool)
    sub = st[st.trip_id.isin(ids)]
    for tid, g in sub.groupby("trip_id"):
        stations = g.station.tolist()
        if at_station not in stations or drop_towards not in stations:
            continue
        i, j = stations.index(at_station), stations.index(drop_towards)
        drop_idx = g.index[i + 1:] if j > i else g.index[:i]
        keep_rows[st.index.get_indexer(drop_idx)] = False
    tt.stop_times = st[keep_rows]
    counts = tt.stop_times.groupby("trip_id").size()
    _drop_trips(tt, counts[counts < 2].index)


def speedup(tt: Timetable, line: str, pct: float = 10, **_) -> None:
    ids = tt.trips.trip_id[_line_mask(tt, line)]
    st = tt.stop_times
    m = st.trip_id.isin(ids)
    start = st[m].groupby("trip_id").dep.transform("min")
    f = 1 - pct / 100
    st.loc[m, "arr"] = (start + (st.loc[m, "arr"] - start) * f).astype("int32")
    st.loc[m, "dep"] = (start + (st.loc[m, "dep"] - start) * f).astype("int32")
    _product, _ln = line.split(":", 1)
    keys = tt.trips[_line_mask(tt, line)][["product", "line"]].drop_duplicates().itertuples(index=False, name=None)
    tt.delay_factor = getattr(tt, "delay_factor", {}) | {k: f for k in keys}


def interline(tt: Timetable, line_a: str, line_b: str, **_) -> None:
    a, b = tuple(line_a.split(":", 1)), tuple(line_b.split(":", 1))
    tt.interline_groups.append({a, b})


def best_offset(tt: Timetable, line_a: str, line_b: str) -> int:
    """Shift (s) of line_b that maximises the smallest headway on shared edges, 6-20h."""
    st = tt.stop_times.sort_values(["trip_id", "seq"])
    nxt = st.station.shift(-1)
    same = st.trip_id.values == st.trip_id.shift(-1).values
    e = st[same].assign(to=nxt[same])
    e = e[(e.dep >= 6 * 3600) & (e.dep < 20 * 3600)]
    ea = e[e.trip_id.isin(tt.trips.trip_id[_line_mask(tt, line_a)])]
    eb = e[e.trip_id.isin(tt.trips.trip_id[_line_mask(tt, line_b)])]
    shared = set(zip(ea.station, ea.to)) & set(zip(eb.station, eb.to))
    if not shared:
        return 0
    ea = ea[[k in shared for k in zip(ea.station, ea.to)]]
    eb = eb[[k in shared for k in zip(eb.station, eb.to)]]
    best, best_score = 0, -math.inf
    for off in range(-600, 601, 30):
        score = 0.0
        for k, ga in ea.groupby(["station", "to"]):
            gb = eb[(eb.station == k[0]) & (eb.to == k[1])]
            times = np.sort(np.concatenate([ga.dep.values, gb.dep.values + off]))
            h = np.diff(times)
            score += -float((h.astype(float) ** 2).sum())  # minimise expected wait
        if score > best_score:
            best, best_score = off, score
    return best


def debunch(tt: Timetable, line_a: str, line_b: str, offset_s: int | None = None, **_) -> None:
    off = best_offset(tt, line_a, line_b) if offset_s is None else offset_s
    ids = tt.trips.trip_id[_line_mask(tt, line_b)]
    m = tt.stop_times.trip_id.isin(ids)
    tt.stop_times.loc[m, ["arr", "dep"]] += off
    tt.notes.append(f"{line_b} shifted by {off / 60:+.1f} min")


def add_express(tt: Timetable, name: str, stations: list[str], headway_min: float = 10,
                from_h: float = 6, to_h: float = 20, dwell_s: int = 30, both_directions: bool = True, **_) -> None:
    pos = tt.stations.set_index("station")
    stations = [s for s in stations if s in pos.index]
    if len(stations) < 2:
        return
    # running time per leg from the street route through all stops (one per direction)
    free = {}
    for pattern in (stations, stations[::-1]):
        route = street_route([(pos.lat[s], pos.lon[s]) for s in pattern])
        if route:
            free.update(dict(zip(itertools.pairwise(pattern), route["legs_s"])))
    missing = [leg for leg in itertools.pairwise(stations) if leg not in free]
    missing += [leg for leg in itertools.pairwise(stations[::-1]) if leg not in free]
    if missing:  # fall back to the OSRM table if the route service fails
        free.update(free_flow_matrix({s: (pos.lat[s], pos.lon[s]) for s in stations}, missing))
    rows, trips = [], []
    patterns = [stations, stations[::-1]] if both_directions else [stations]
    for d, pattern in enumerate(patterns):
        t = from_h * 3600 + d * headway_min * 30  # stagger directions by half a headway
        n = 0
        while t < to_h * 3600:
            tid = f"X.{name}.{d}.{n}"
            clock = t
            for seq, s in enumerate(pattern):
                if seq:
                    leg = free.get((pattern[seq - 1], s), 300)
                    clock += leg * CONGESTION[int(clock // 3600) % 24] * 1.1  # bus slower than car
                rows.append((tid, seq, s, int(clock), int(clock + (dwell_s if 0 < seq < len(pattern) - 1 else 0))))
                if 0 < seq < len(pattern) - 1:
                    clock += dwell_s
            trips.append({"route_id": f"X-{name}", "trip_id": tid, "headsign": pos.name[pattern[-1]],
                          "direction": str(d), "line": name, "product": "Bus"})
            t += headway_min * 60
            n += 1
    tt.trips = pd.concat([tt.trips, pd.DataFrame(trips)], ignore_index=True)
    st = pd.DataFrame(rows, columns=["trip_id", "seq", "station", "arr", "dep"]).astype(
        {"seq": "int16", "arr": "int32", "dep": "int32"})
    tt.stop_times = pd.concat([tt.stop_times, st], ignore_index=True)


APPLY = {
    "remove_line": remove_line, "thin_line": thin_line, "densify_line": densify_line, "shorten_line": shorten_line,
    "speedup": speedup, "interline": interline, "debunch": debunch, "add_express": add_express,
}


def apply_scenario(tt: Timetable, features: list[dict]) -> Timetable:
    tt = tt.copy()
    for f in features:
        if f.get("enabled", True) and _applies(f, tt):
            APPLY[f["type"]](tt, **{k: v for k, v in f.items() if k not in ("type", "enabled", "days", "id")})
    return tt
