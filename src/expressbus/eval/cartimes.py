"""Car travel times between stations (OSRM table service, cached on disk).

OSRM returns free-flow driving times. We add time-of-day congestion and a fixed access
time (walk to the car, find parking) so that the comparison with public transport is
door-to-door-ish. These factors are assumptions; swap in real traffic data if available.
"""

from __future__ import annotations

import json
import os
import threading

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


_lock = threading.Lock()
_mem: dict | None = None


def _load() -> dict:
    global _mem
    if _mem is None:
        try:
            _mem = json.loads(CACHE_FILE.read_text()) if CACHE_FILE.exists() else {}
        except ValueError:  # truncated file from an interrupted write
            _mem = {}
    return _mem


def _save(cache: dict) -> None:
    CACHE_FILE.parent.mkdir(parents=True, exist_ok=True)
    tmp = CACHE_FILE.with_suffix(".tmp")
    tmp.write_text(json.dumps(cache))
    os.replace(tmp, CACHE_FILE)  # atomic: readers never see a half-written file


def free_flow_matrix(points: dict[str, tuple[float, float]], pairs: list[tuple[str, str]]) -> dict[tuple[str, str], float]:
    """Free-flow seconds for (origin, destination) station pairs. points: station -> (lat, lon)."""
    with _lock:
        return _free_flow_matrix(points, pairs, _load())


def _free_flow_matrix(points, pairs, cache) -> dict[tuple[str, str], float]:
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
    if todo:
        _save(cache)
    return {(o, d): cache[key(o, d)] for o, d in pairs if key(o, d) in cache}


# ---------- street routes for express lines ----------
OSRM_ROUTE = "https://router.project-osrm.org/route/v1/driving/{coords}?overview=full&geometries=geojson"
ROUTE_CACHE = ROOT / "data" / "processed" / "express_routes.json"
_route_lock = threading.Lock()
_routes: dict | None = None


def street_route(points: list[tuple[float, float]]) -> dict | None:
    """Driving route through the stops in order: {"path": [[lat, lon], ...], "legs_s": [...], "km": ...}.

    The same route is used to draw an express line and to time it (free-flow seconds per leg),
    so the map and the timetable always agree.
    """
    global _routes
    key = ";".join(f"{lon:.5f},{lat:.5f}" for lat, lon in points)
    with _route_lock:
        if _routes is None:
            try:
                _routes = json.loads(ROUTE_CACHE.read_text()) if ROUTE_CACHE.exists() else {}
            except ValueError:
                _routes = {}
        if key not in _routes:
            try:
                r = httpx.get(OSRM_ROUTE.format(coords=key), timeout=30)
                r.raise_for_status()
                route = r.json()["routes"][0]
            except (httpx.HTTPError, KeyError, IndexError, ValueError):
                return None
            coords = route["geometry"]["coordinates"]
            step = max(1, len(coords) // 400)  # keep the payload small
            path = [[round(lat, 5), round(lon, 5)] for lon, lat in coords[::step]]
            if path[-1] != [round(coords[-1][1], 5), round(coords[-1][0], 5)]:
                path.append([round(coords[-1][1], 5), round(coords[-1][0], 5)])
            _routes[key] = {"path": path, "legs_s": [leg["duration"] for leg in route["legs"]],
                            "km": round(route["distance"] / 1000, 2)}
            ROUTE_CACHE.parent.mkdir(parents=True, exist_ok=True)
            tmp = ROUTE_CACHE.with_suffix(".tmp")
            tmp.write_text(json.dumps(_routes))
            os.replace(tmp, ROUTE_CACHE)
        return _routes[key]
