"""Problem diagnosis of the current network, as weighted points for heatmaps.

Each layer answers one question and points to the planner lever that addresses it:

  delay_buildup   Where do vehicles lose time?            (observed)  -> speed up / bus priority
  bunching        Where do vehicles of a line arrive in pulks?  (observed)  -> interleave, buffers
  service_gaps    Where is the wait for the next departure long? (timetable) -> more trips / express
  pt_vs_car       Where is PT much slower than the car?   (timetable + OSRM) -> express lines
  parallel_rail   Where do buses duplicate U-Bahn/tram?   (timetable) -> shorten / remove, frees drivers

Observed layers use the recorded live trips (data/raw/live). Timetable layers use the VGN GTFS
of a reference weekday.
"""

from __future__ import annotations

import itertools
import json
import math
import random
import time
from collections import defaultdict
from datetime import date
from functools import lru_cache

import numpy as np

from expressbus.eval.cartimes import car_time, free_flow_matrix
from expressbus.eval.kpis import RECORD_DIR, WINDOW, edge_departures
from expressbus.eval.planner import Planner
from expressbus.eval.timetable import EDITABLE, load_day

REFERENCE_DAY = date(2026, 9, 28)
CITY_PREFIXES = ("de:09564:", "de:09563:")  # Nürnberg, Fürth (regional buses are not modelled outside)
LIVE_TTL_S = 600  # observed layers are recomputed at most every 10 min

LAYERS = {
    "delay_buildup": {
        "title": "Delay build-up",
        "question": "Where do vehicles lose time against the timetable?",
        "unit": "min lost (recorded period)", "source": "observed",
        "lever": "Speed up line (bus lanes, signal priority) on the worst sections",
    },
    "bunching": {
        "title": "Bunching",
        "question": "Where do two vehicles of the same line arrive less than 2 min apart (planned ≥ 5 min)?",
        "unit": "bunching events", "source": "observed",
        "lever": "Interleave lines, add recovery time, headway-based dispatching",
    },
    "service_gaps": {
        "title": "Service gaps",
        "question": "How long does a passenger arriving at a random time wait (Mon, 06–21 h)?",
        "unit": "min expected wait", "source": "timetable",
        "lever": "More trips at the worst stops, or an express line serving them",
    },
    "pt_vs_car": {
        "title": "PT slower than car",
        "question": "How much longer does PT take than the car from this stop (median of 12 trips, 07:30 & 16:30)?",
        "unit": "× car time", "source": "timetable + OSRM",
        "lever": "Express lines / direct cross-town links from these areas",
    },
    "parallel_rail": {
        "title": "Buses parallel to rail",
        "question": "Where do bus departures run between two stops that a U-Bahn/tram line also connects?",
        "unit": "bus departures / day", "source": "timetable",
        "lever": "Shorten or thin these bus sections → frees drivers for new service",
    },
}


# ---------- observed data ----------
def _recorded_trips(products: tuple[str, ...] | None = None) -> list[dict]:
    trips: dict[tuple, dict] = {}
    for f in sorted(RECORD_DIR.glob("trips_*.jsonl")):
        for line in f.read_text().splitlines():
            t = json.loads(line)
            if t.get("realtime") and len(t["stops"]) >= 2 and (not products or t["product"] in products):
                trips[(t["service_day"], t["id"])] = t  # keep the last (most complete) record
    return list(trips.values())


def _period(trips: list[dict]) -> str:
    if not trips:
        return "no recorded live data yet"
    t0 = min(t["stops"][0]["dep"] or t["stops"][0]["arr"] for t in trips)
    t1 = max(t["stops"][-1]["arr"] or t["stops"][-1]["dep"] for t in trips)
    fmt = lambda ts: time.strftime("%d.%m. %H:%M", time.localtime(ts))
    return f"{len(trips)} recorded trips, {fmt(t0)} – {fmt(t1)}"


def delay_buildup(products=None) -> dict:
    trips = _recorded_trips(products)
    seg: dict[tuple, dict] = {}
    for t in trips:
        s = t["stops"]
        for a, b in itertools.pairwise(s):
            k = (a["name"], b["name"])
            e = seg.setdefault(k, {"lat": (a["lat"] + b["lat"]) / 2, "lon": (a["lon"] + b["lon"]) / 2,
                                   "gain": [], "lines": set()})
            e["gain"].append(b["delay"] - a["delay"])
            e["lines"].add(f"{t['product']} {t['line']}")
    items = []
    for (a, b), e in seg.items():
        g = np.array(e["gain"], dtype=float)
        lost = float(np.clip(g, 0, None).sum()) / 60  # minutes lost over all trips
        if len(g) >= 3 and lost > 0:
            items.append({"lat": e["lat"], "lon": e["lon"], "value": lost,
                          "label": f"{_short(a)} → {_short(b)}",
                          "detail": f"avg {g.mean():+.0f} s per trip over {len(g)} trips",
                          "lines": sorted(e["lines"])})
    return _result("delay_buildup", items, _period(trips), by_line=_line_ranking(items))


def bunching(products=None) -> dict:
    trips = _recorded_trips(products)
    groups = defaultdict(list)
    for t in trips:
        for s in t["stops"][:-1]:
            if s["dep"]:
                groups[(t["product"], t["line"], t["direction"], s["name"])].append(
                    (s["dep"] - s["delay"], s["dep"], s["lat"], s["lon"]))
    per_stop: dict[str, dict] = {}
    for (product, line, _d, stop), ev in groups.items():
        ev.sort()
        for (p0, a0, lat, lon), (p1, a1, _, _) in itertools.pairwise(ev):
            if p1 - p0 >= 300 and a1 - a0 < 120:
                e = per_stop.setdefault(stop, {"lat": lat, "lon": lon, "n": 0, "lines": set()})
                e["n"] += 1
                e["lines"].add(f"{product} {line}")
    items = [{"lat": e["lat"], "lon": e["lon"], "value": e["n"], "label": _short(s),
              "detail": f"{e['n']} bunching events", "lines": sorted(e["lines"])} for s, e in per_stop.items()]
    return _result("bunching", items, _period(trips), by_line=_line_ranking(items))


# ---------- timetable data ----------
def _station_lines(tt) -> dict[str, list[str]]:
    """station -> ["Bus 36", "Tram 4", "UBahn U1", ...] (VAG lines only)."""
    st = tt.stop_times.merge(tt.trips[tt.trips["product"].isin(EDITABLE)][["trip_id", "product", "line"]], on="trip_id")
    lab = st["product"] + " " + st["line"]
    return {k: sorted(set(v), key=_num) for k, v in lab.groupby(st.station)}



@lru_cache(maxsize=1)
def service_gaps() -> dict:
    tt = load_day(REFERENCE_DAY)
    e = edge_departures(tt)
    span = WINDOW[1] - WINDOW[0]
    pos = tt.stations.set_index("station")
    waits = defaultdict(list)
    lines = _station_lines(tt)
    e = e[e.station.str.startswith(CITY_PREFIXES)]
    for (a, _b), g in e.groupby(["station", "to"]):
        times = np.sort(g.dep.values)
        h = np.diff(np.concatenate([[WINDOW[0]], times, [WINDOW[1]]])).astype(float)
        waits[a].append(min((h ** 2).sum() / (2 * span), 3600) / 60)
    items = []
    for s, w in waits.items():
        v = float(np.mean(w))
        items.append({"lat": float(pos.lat[s]), "lon": float(pos.lon[s]), "value": v, "label": _short(pos.name[s]),
                      "detail": f"{v:.1f} min expected wait", "lines": lines.get(s, []), "station": s})
    return _result("service_gaps", items, f"VGN timetable, Mon {REFERENCE_DAY:%d.%m.%Y}", floor=5)


@lru_cache(maxsize=1)
def pt_vs_car() -> dict:
    tt = load_day(REFERENCE_DAY)
    vag = tt.trips.trip_id[tt.trips["product"].isin(EDITABLE)]
    deps = tt.stop_times[tt.stop_times.trip_id.isin(vag)].groupby("station").size()
    deps = deps[deps.index.str.startswith(CITY_PREFIXES)]
    st = tt.stations.set_index("station").loc[deps.index]
    names = list(deps.index)
    weights = np.sqrt(deps.values)
    rng = random.Random(7)
    pairs = []
    for o in names:
        dist = np.hypot((st.lon - st.lon[o]) * 72.4, (st.lat - st.lat[o]) * 111.3)
        cand = [s for s in names if 2 <= dist[s] <= 10]
        if not cand:
            continue
        w = [weights[names.index(s)] for s in cand]
        pairs += [(o, d) for d in set(rng.choices(cand, w, k=12))]
    points = {s: (st.lat[s], st.lon[s]) for s in names}
    free = free_flow_matrix(points, pairs)
    lines = _station_lines(tt)
    planner = Planner(tt)
    by_origin = defaultdict(list)
    for o in names:
        dests = [d for (oo, d) in pairs if oo == o and (oo, d) in free]
        if not dests:
            continue
        for t0 in (int(7.5 * 3600), int(16.5 * 3600)):
            arrival, _ = planner.scan(o, t0)
            for d in dests:
                k = planner.idx.get(d)
                pt = min(arrival[k] - t0, 7200) if k is not None and arrival[k] < math.inf else 7200
                by_origin[o].append(pt / car_time(free[(o, d)], t0 // 3600, weekend=False))
    items = [{"lat": float(st.lat[o]), "lon": float(st.lon[o]), "value": float(np.median(r)), "label": _short(st.name[o]),
              "detail": f"median {np.median(r):.2f}× car time ({len(r)} trips)", "lines": lines.get(o, []), "station": o}
             for o, r in by_origin.items()]
    return _result("pt_vs_car", items, f"VGN timetable Mon {REFERENCE_DAY:%d.%m.%Y}, car: OSRM + congestion", floor=1.2)


@lru_cache(maxsize=1)
def parallel_rail() -> dict:
    tt = load_day(REFERENCE_DAY)
    pos = tt.stations.set_index("station")
    st = tt.stop_times.merge(tt.trips[["trip_id", "product", "line"]], on="trip_id")
    rail = st[st["product"].isin(["UBahn", "Tram", "SBahn", "Rail"])]
    rail_lines = rail.groupby("station").line.agg(set)
    rpos = pos.loc[rail_lines.index]
    near: dict[str, set] = {}
    for s in pos.index:
        d = np.hypot((rpos.lon.values - pos.lon[s]) * 72400, (rpos.lat.values - pos.lat[s]) * 111300)
        near[s] = set().union(*rail_lines.values[d < 300]) if (d < 300).any() else set()
    bus = st[st["product"] == "Bus"].sort_values(["trip_id", "seq"])
    nxt = bus.station.shift(-1)
    same = bus.trip_id.values == bus.trip_id.shift(-1).values
    e = bus[same].assign(to=nxt[same])
    items = []
    for (a, b), g in e.groupby(["station", "to"]):
        shared = near.get(a, set()) & near.get(b, set())
        if shared:
            items.append({"lat": float((pos.lat[a] + pos.lat[b]) / 2), "lon": float((pos.lon[a] + pos.lon[b]) / 2),
                          "value": float(len(g)), "label": f"{_short(pos.name[a])} → {_short(pos.name[b])}",
                          "detail": f"{len(g)} bus departures/day, parallel to {', '.join(sorted(shared, key=_num))}",
                          "lines": [f"Bus {x}" for x in sorted(g.line.unique(), key=_num)], "station": a,
                          "parallel_to": sorted(shared, key=_num)})
    return _result("parallel_rail", items, f"VGN timetable, Mon {REFERENCE_DAY:%d.%m.%Y}", by_line=_line_ranking(items))


# ---------- helpers ----------
def _short(name: str) -> str:
    for p in ("Nürnberg ", "Fürth "):
        if name.startswith(p):
            return name[len(p):].replace(" (Nürnberg)", "")
    return name.replace(" (Nürnberg)", "")


def _num(s: str):
    digits = "".join(c for c in s if c.isdigit())
    return (int(digits) if digits else 9999, s)


def _line_ranking(items: list[dict]) -> list[dict]:
    agg = defaultdict(float)
    for it in items:
        for ln in it["lines"]:
            agg[ln] += it["value"] / max(1, len(it["lines"]))
    return [{"line": k, "value": round(v, 1)} for k, v in sorted(agg.items(), key=lambda x: -x[1])[:10]]


def _result(key: str, items: list[dict], period: str, floor: float = 0.0, by_line=None) -> dict:
    vals = np.array([it["value"] for it in items]) if items else np.zeros(1)
    hi = float(np.percentile(vals, 95)) if items else 1.0
    lo = floor
    for it in items:  # heat intensity 0..1: floor -> 0, 95th percentile -> 1
        it["w"] = round(min(1.0, max(0.0, (it["value"] - lo) / max(1e-9, hi - lo))), 3)
        it["value"] = round(it["value"], 2)
    items.sort(key=lambda it: -it["value"])
    return {**LAYERS[key], "key": key, "period": period, "scale": [lo, round(hi, 2)],
            "points": [[round(it["lat"], 5), round(it["lon"], 5), it["w"]] for it in items if it["w"] > 0],
            "top": items[:12], "by_line": by_line or [], "count": len(items)}


_live_cache: dict[str, tuple[float, dict]] = {}
COMPUTE = {"delay_buildup": delay_buildup, "bunching": bunching, "service_gaps": service_gaps,
           "pt_vs_car": pt_vs_car, "parallel_rail": parallel_rail}


def layer(key: str, bus_only: bool = False) -> dict:
    if LAYERS[key]["source"] != "observed":
        return COMPUTE[key]()
    ck = f"{key}:{bus_only}"
    hit = _live_cache.get(ck)
    if not hit or time.time() - hit[0] > LIVE_TTL_S:
        _live_cache[ck] = (time.time(), COMPUTE[key](("Bus",) if bus_only else None))
    return _live_cache[ck][1]


if __name__ == "__main__":
    for k in LAYERS:
        t0 = time.time()
        r = layer(k, bus_only=True)
        print(f"{k}: {r['count']} items, {len(r['points'])} heat points, {time.time() - t0:.1f}s · {r['period']}")
        for it in r["top"][:5]:
            print(f"   {it['value']:>8} {it['label']:45} {it['detail']}  {', '.join(it['lines'][:4])}")
        print("   by line:", r["by_line"][:5])
