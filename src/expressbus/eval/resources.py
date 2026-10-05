"""Vehicles and drivers needed to run a timetable.

GTFS has no vehicle rotations (block_id is empty), so we rebuild them: trips of the same
line (or interlined line group) are chained when one ends at the station where the next
starts, with at least MIN_LAYOVER_S in between. One block = one vehicle out = one driver
on duty (U2/U3 are driverless and don't count towards drivers).

Two budgets matter: drivers needed at the same time (peak) and paid driver hours per day.
"""

from __future__ import annotations

import heapq
from collections import defaultdict

import numpy as np
import pandas as pd

from expressbus.eval.timetable import EDITABLE, Timetable

MIN_LAYOVER_S = 5 * 60
MAX_IDLE_S = 45 * 60  # longer breaks: vehicle goes back to the depot, driver is released
SIGN_ON_OFF_S = 15 * 60  # paid time per block for sign-on, pull-out, pull-in
DRIVERLESS = {("UBahn", "U2"), ("UBahn", "U3")}
POOLS = ("Bus", "Tram", "UBahn")


def trip_table(tt: Timetable) -> pd.DataFrame:
    st = tt.stop_times
    g = st.groupby("trip_id", sort=False)
    ends = pd.DataFrame({
        "start": g.dep.min(), "end": g.arr.max(),
        "from": g.station.first(), "to": g.station.last(),
    })
    return tt.trips.set_index("trip_id")[["line", "product"]].join(ends, how="inner").reset_index()


def build_blocks(tt: Timetable) -> pd.DataFrame:
    """Assign every editable trip to a vehicle block. Returns trips with a 'block' column."""
    trips = trip_table(tt)
    trips = trips[trips["product"].isin(EDITABLE)].sort_values("start")
    group_of = {}
    for i, grp in enumerate(tt.interline_groups):
        for key in grp:
            group_of[key] = f"g{i}"
    trips["group"] = [group_of.get((p, ln), f"{p}:{ln}") for p, ln in zip(trips["product"], trips["line"])]

    block_ids = np.empty(len(trips), dtype=object)
    prev_trip = {}
    next_id = 0
    for grp, sub in trips.groupby("group", sort=False):
        idle: dict[str, list] = defaultdict(list)  # station -> heap of (ready_time, block, last_trip)
        for pos, (tid, start, end, frm, to) in zip(sub.index, sub[["trip_id", "start", "end", "from", "to"]].itertuples(index=False, name=None)):
            heap = idle[frm]
            while heap and start - heap[0][0] > MAX_IDLE_S - MIN_LAYOVER_S:
                heapq.heappop(heap)  # waited too long: went to depot
            if heap and heap[0][0] <= start:
                _, block, last = heapq.heappop(heap)
                prev_trip[tid] = last
            else:
                block, next_id = f"{grp}#{next_id}", next_id + 1
            block_ids[trips.index.get_loc(pos)] = block
            heapq.heappush(idle[to], (end + MIN_LAYOVER_S, block, tid))
    trips["block"] = block_ids
    trips["prev_trip"] = trips.trip_id.map(prev_trip)
    return trips


def budget(tt: Timetable, blocks: pd.DataFrame | None = None) -> dict:
    """Drivers on duty per pool over the day (5-min resolution), peak and paid hours."""
    blocks = build_blocks(tt) if blocks is None else blocks
    b = blocks.groupby("block").agg(product=("product", "first"), line=("line", "first"),
                                    start=("start", "min"), end=("end", "max"))
    b["driver"] = [(p, ln) not in DRIVERLESS for p, ln in zip(b["product"], b["line"])]
    grid = np.arange(3 * 3600, 27 * 3600, 300)  # 03:00 .. 03:00 next day
    out = {"grid": (grid / 3600).round(3).tolist(), "pools": {}}
    for pool in POOLS:
        sub = b[(b["product"] == pool) & b["driver"]]
        on_duty = ((sub.start.values[:, None] <= grid) & (sub.end.values[:, None] > grid)).sum(axis=0) if len(sub) else np.zeros_like(grid)
        hours = float(((sub.end - sub.start).sum() + len(sub) * SIGN_ON_OFF_S) / 3600)
        out["pools"][pool] = {
            "on_duty": on_duty.astype(int).tolist(),
            "peak": int(on_duty.max()) if len(on_duty) else 0,
            "hours": round(hours, 1),
            "blocks": len(sub),
        }
    out["vehicle_km"] = round(_vehicle_km(tt), 0)
    out["trips"] = int(tt.trips["product"].isin(EDITABLE).sum())
    return out


def _vehicle_km(tt: Timetable) -> float:
    st = tt.stop_times.merge(tt.stations[["station", "lat", "lon"]], on="station", how="left")
    st = st.sort_values(["trip_id", "seq"])
    st = st[st.trip_id.isin(tt.trips.trip_id[tt.trips["product"].isin(EDITABLE)])]
    same = st.trip_id.values[1:] == st.trip_id.values[:-1]
    dy = np.diff(st.lat.values) * 111.32
    dx = np.diff(st.lon.values) * 111.32 * 0.65
    return float(np.hypot(dx, dy)[same].sum() * 1.25)  # 1.25: street detour vs. straight line
