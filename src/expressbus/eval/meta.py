"""Line/station metadata and preset features for the scenario planner UI."""

from __future__ import annotations

from datetime import date
from functools import lru_cache

import numpy as np

from expressbus.eval.resources import DRIVERLESS, build_blocks
from expressbus.eval.timetable import EDITABLE, load_day

PRESETS = [  # express lines themselves come from the express check (proposals.py)
    {"type": "thin_line", "line": "Bus:*", "from_h": 20, "to_h": 27, "keep_every": 2, "days": "all",
     "title": "Evening buses every 2nd trip (after 20:00)"},
    {"type": "remove_line", "line": "Bus:84", "title": "Remove bus 84 (99 % next to rail)"},
    {"type": "interline", "line_a": "Bus:35", "line_b": "Bus:65",
     "title": "Merge bus 35 + 65 (share both termini, ride through)"},
    {"type": "speedup", "line": "Bus:35", "pct": 10, "title": "Bus 35 priority lanes (-10 % running time)"},
]


@lru_cache(maxsize=4)
def planner_meta(day: date) -> dict:
    tt = load_day(day)
    st = tt.stop_times.merge(tt.trips[["trip_id", "product", "line", "headsign"]], on="trip_id")
    stations = tt.stations.set_index("station")
    rail = stations.loc[st[st["product"].isin(["UBahn", "Tram", "SBahn", "Rail"])].station.unique()]
    blocks = build_blocks(tt)
    grid = np.arange(4 * 3600, 26 * 3600, 300)

    lines = []
    for (product, line), g in st[st["product"].isin(EDITABLE)].groupby(["product", "line"]):
        trip_len = g.groupby("trip_id").size()
        longest = g[g.trip_id == trip_len.idxmax()].sort_values("seq")
        firsts = g[g.seq == 0].station.value_counts()
        lasts = g.sort_values("seq").groupby("trip_id").station.last().value_counts()
        termini = list(dict.fromkeys(list(firsts.index[:2]) + list(lasts.index[:2])))[:4]
        ss = stations.loc[g.station.unique()]
        d = np.sqrt(((ss.lat.values[:, None] - rail.lat.values[None]) * 111300) ** 2
                    + ((ss.lon.values[:, None] - rail.lon.values[None]) * 72400) ** 2).min(axis=1) if product == "Bus" else np.zeros(1)
        b = blocks[(blocks["product"] == product) & (blocks["line"] == line)].groupby("block").agg(s=("start", "min"), e=("end", "max"))
        peak = int(((b.s.values[:, None] <= grid) & (b.e.values[:, None] > grid)).sum(axis=0).max()) if len(b) else 0
        lines.append({
            "id": f"{product}:{line}", "product": product, "line": line,
            "headsigns": g.headsign.value_counts().index[:2].tolist(),
            "trips": int(g.trip_id.nunique()),
            "drivers_peak": 0 if (product, line) in DRIVERLESS else peak,
            "parallel_rail": round(float((d < 300).mean()), 2) if product == "Bus" else None,
            "termini": [{"id": t, "name": stations.name[t]} for t in termini],
            "stations": [{"id": s, "name": stations.name[s]} for s in longest.station],
        })
    order = {"UBahn": 0, "Tram": 1, "Bus": 2}
    lines.sort(key=lambda x: (order[x["product"]], len(x["line"]), x["line"]))
    served = set(tt.stop_times.station)
    return {
        "day": day.isoformat(),
        "lines": lines,
        "stations": [{"id": s, "name": r["name"], "lat": r["lat"], "lon": r["lon"]}
                     for s, r in stations.loc[sorted(served)].iterrows()],
        "presets": PRESETS,
    }
