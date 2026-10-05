"""Earliest-arrival journey planner (Connection Scan Algorithm) over a Timetable.

One scan answers "leaving station O at time t, when can I be at every other station?".
Includes walking transfers between nearby stations and a minimum change time.
"""

from __future__ import annotations

import bisect
import math

import numpy as np

from expressbus.eval.timetable import Timetable

MIN_CHANGE_S = 120  # minimum time to change vehicles at a station
WALK_RADIUS_M = 400  # max walking transfer between stations
WALK_SPEED = 1.2  # m/s, with a 1.3 detour factor applied on straight-line distance
MAX_JOURNEY_S = 3 * 3600


class Planner:
    def __init__(self, tt: Timetable, aliases: dict[str, str] | None = None):
        """aliases: trip -> trip it continues (interlining: passengers stay seated)."""
        aliases = aliases or {}
        st = tt.stop_times.sort_values(["trip_id", "seq"])
        nxt = st.shift(-1)
        same = (st.trip_id.values == nxt.trip_id.values)
        conns = st[same].assign(to=nxt.station[same].values, arr_to=nxt.arr[same].values.astype(int))
        conns = conns[conns.arr_to >= conns.dep].sort_values(["dep", "arr_to"])

        stations = sorted(set(tt.stop_times.station))
        self.idx = {s: i for i, s in enumerate(stations)}
        self.n = len(stations)
        trip_key = conns.trip_id.map(lambda t: aliases.get(t, t))
        trip_ids = {t: i for i, t in enumerate(trip_key.unique())}
        self.c_dep = conns.dep.astype(int).tolist()
        self.c_arr = conns.arr_to.astype(int).tolist()
        self.c_from = [self.idx[s] for s in conns.station]
        self.c_to = [self.idx[s] for s in conns.to]
        self.c_trip = [trip_ids[t] for t in trip_key]
        self.n_trips = len(trip_ids)
        self.footpaths = self._footpaths(tt, stations)

    def _footpaths(self, tt: Timetable, stations: list[str]) -> list[list[tuple[int, int]]]:
        pos = tt.stations.set_index("station").reindex(stations)
        lat, lon = np.radians(pos.lat.values), np.radians(pos.lon.values)
        out: list[list[tuple[int, int]]] = [[] for _ in stations]
        kx = math.cos(math.radians(49.45))
        for i in range(len(stations)):
            d = 6371000 * np.hypot((lon - lon[i]) * kx, lat - lat[i])
            for j in np.nonzero((d < WALK_RADIUS_M) & (d > 0))[0]:
                out[i].append((int(j), int(d[j] * 1.3 / WALK_SPEED) + 60))
        return out

    def scan(self, origin: str, t0: int) -> tuple[list[float], list[int]]:
        """Earliest arrival time and number of boardings at every station."""
        inf = math.inf
        arrival = [inf] * self.n  # actual arrival time
        ready = [inf] * self.n  # time from which one can board here (arrival + change / walk)
        boards = [0] * self.n
        trip_on = [False] * self.n_trips
        trip_boards = [0] * self.n_trips
        o = self.idx.get(origin)
        if o is None:
            return arrival, boards
        arrival[o] = ready[o] = t0
        for j, w in self.footpaths[o]:
            arrival[j] = ready[j] = t0 + w
        c_dep, c_arr, c_from, c_to, c_trip, fps = self.c_dep, self.c_arr, self.c_from, self.c_to, self.c_trip, self.footpaths
        end = t0 + MAX_JOURNEY_S
        for k in range(bisect.bisect_left(c_dep, t0), len(c_dep)):
            dep = c_dep[k]
            if dep > end:
                break
            trip = c_trip[k]
            if not trip_on[trip]:
                f = c_from[k]
                if ready[f] > dep:
                    continue
                trip_on[trip] = True
                trip_boards[trip] = boards[f] + 1
            to, arr = c_to[k], c_arr[k]
            if arr < arrival[to]:
                arrival[to] = arr
                boards[to] = trip_boards[trip]
                ready[to] = min(ready[to], arr + MIN_CHANGE_S)
                for j, w in fps[to]:
                    if arr + w < ready[j]:
                        ready[j] = arr + w
                        if arr + w < arrival[j]:
                            arrival[j] = arr + w
                            boards[j] = trip_boards[trip]
        return arrival, boards
