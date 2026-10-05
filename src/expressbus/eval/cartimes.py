"""Car travel times between stations (OSRM table service, cached on disk).

OSRM returns free-flow driving times. We add time-of-day congestion and a fixed access
time (walk to the car, find parking) so that the comparison with public transport is
door-to-door-ish. These factors are assumptions; swap in real traffic data if available.
"""

from __future__ import annotations

import json

import httpx

from expressbus.data.vag import ROOT

OSRM_TABLE = "https://router.project-osrm.org/table/v1/driving/{coords}?sources={src}&destinations={dst}&annotations=duration"
CACHE_FILE = ROOT / "data" / "processed" / "car_times.json"
CAR_ACCESS_S = 5 * 60  # walking to the car + parking at the destination

# congestion multiplier on free-flow time by hour of day (Nürnberg, weekday)
CONGESTION = {h: 1.0 for h in range(24)} | {6: 1.15, 7: 1.45, 8: 1.4, 9: 1.2, 10: 1.15, 11: 1.15, 12: 1.2,
                                            13: 1.2, 14: 1.2, 15: 1.35, 16: 1.5, 17: 1.5, 18: 1.3, 19: 1.15}
WEEKEND_CONGESTION = {h: 1.0 for h in range(24)} | {h: 1.15 for h in range(10, 19)}


def car_time(free_flow_s: float, hour: int, weekend: bool) -> float:
    f = (WEEKEND_CONGESTION if weekend else CONGESTION)[hour % 24]
    return free_flow_s * f + CAR_ACCESS_S


def free_flow_matrix(points: dict[str, tuple[float, float]], pairs: list[tuple[str, str]]) -> dict[tuple[str, str], float]:
    """Free-flow seconds for (origin, destination) station pairs. points: station -> (lat, lon)."""
    cache = json.loads(CACHE_FILE.read_text()) if CACHE_FILE.exists() else {}
    key = lambda o, d: f"{o}|{d}"
    todo: dict[str, set[str]] = {}
    for o, d in pairs:
        if key(o, d) not in cache:
            todo.setdefault(o, set()).add(d)
    origins = list(todo)
    for i in range(0, len(origins), 10):
        src = origins[i:i + 10]
        dst = sorted(set().union(*(todo[o] for o in src)))
        for j in range(0, len(dst), 80):
            dchunk = dst[j:j + 80]
            coords = ";".join(f"{points[s][1]:.6f},{points[s][0]:.6f}" for s in src + dchunk)
            url = OSRM_TABLE.format(coords=coords, src=";".join(map(str, range(len(src)))),
                                    dst=";".join(map(str, range(len(src), len(src) + len(dchunk)))))
            r = httpx.get(url, timeout=60)
            r.raise_for_status()
            for a, row in zip(src, r.json()["durations"]):
                for b, v in zip(dchunk, row):
                    if v is not None:
                        cache[key(a, b)] = v
    CACHE_FILE.parent.mkdir(parents=True, exist_ok=True)
    CACHE_FILE.write_text(json.dumps(cache))
    return {(o, d): cache[key(o, d)] for o, d in pairs if key(o, d) in cache}
