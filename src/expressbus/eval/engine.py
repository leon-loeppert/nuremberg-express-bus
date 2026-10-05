"""Historical evaluation: run baseline and scenario over a period and compare KPIs.

    python -m expressbus.eval.engine 2026-09-28 7 scenario.json
"""

from __future__ import annotations

import json
import sys
from datetime import date, timedelta
from pathlib import Path

import numpy as np

from expressbus.eval import kpis
from expressbus.eval.resources import budget, build_blocks
from expressbus.eval.scenario import apply_scenario
from expressbus.eval.timetable import load_day

_baseline_cache: dict[date, dict] = {}


def _through_running(tt, blocks) -> dict[str, str]:
    """Interlined A->B vehicle continuations become one passenger trip (no change needed)."""
    if not tt.interline_groups:
        return {}
    b = blocks.set_index("trip_id")
    alias = {}
    for tid, prev in b.prev_trip.dropna().items():
        if b.line[tid] != b.line[prev] and b.start[tid] - b.end[prev] <= 10 * 60:
            alias[tid] = alias.get(prev, prev)
    return alias


def evaluate_day(day: date, features: list[dict], reference_edges=None) -> dict:
    tt = apply_scenario(load_day(day), features) if features else load_day(day)
    blocks = build_blocks(tt)
    res = budget(tt, blocks)
    travel = kpis.travel_kpis(tt, _through_running(tt, blocks))
    out = {
        "day": day.isoformat(),
        "resources": res,
        "travel": travel,
        "headways": kpis.headway_kpis(tt, reference_edges),
        "delay": kpis.delay_kpis(tt),
        "notes": tt.notes,
    }
    if not features:
        out["_edges"] = {(a, b) for a, b in kpis.edge_departures(tt)[["station", "to"]].itertuples(index=False, name=None)}
    return out


def baseline_day(day: date) -> dict:
    if day not in _baseline_cache:
        _baseline_cache[day] = evaluate_day(day, [])
    return _baseline_cache[day]


def _summary(days: list[dict]) -> dict:
    """Aggregate per-day KPIs over the period."""
    def mean(group, key):
        vals = [d[group][key] for d in days if d[group].get(key) is not None]
        return round(float(np.mean(vals)), 4) if vals else None

    pools = days[0]["resources"]["pools"].keys()
    return {
        "drivers_peak": {p: max(d["resources"]["pools"][p]["peak"] for d in days) for p in pools},
        "driver_hours_week": {p: round(sum(d["resources"]["pools"][p]["hours"] for d in days), 0) for p in pools},
        "vehicle_km": round(sum(d["resources"]["vehicle_km"] for d in days), 0),
        "trips": sum(d["resources"]["trips"] for d in days),
        **{k: mean("travel", k) for k in ("pt_car_ratio_median", "pt_car_ratio_mean", "share_competitive",
                                          "pt_minutes_mean", "transfers_mean", "unreachable_share")},
        **{k: mean("headways", k) for k in ("expected_wait_min", "overlap_share", "gap_share")},
        "gaps_over_20min": sum(d["headways"]["gaps_over_20min"] for d in days),
        "delay_mean_min": mean("delay", "delay_mean_min"),
        "punctuality": mean("delay", "punctuality"),
        "delay_source": days[0]["delay"]["delay_source"],
    }


def evaluate(start: date, n_days: int, features: list[dict]) -> dict:
    days = [start + timedelta(days=i) for i in range(n_days)]
    base = [baseline_day(d) for d in days]
    scen = [evaluate_day(d, features, b["_edges"]) for d, b in zip(days, base)] if features else base
    strip = lambda d: {k: v for k, v in d.items() if k != "_edges"}
    return {
        "period": [days[0].isoformat(), days[-1].isoformat()],
        "baseline": _summary(base),
        "scenario": _summary(scen),
        "days": [{"baseline": strip(b), "scenario": strip(s)} for b, s in zip(base, scen)],
    }


_budget_cache: dict[date, dict] = {}


def inventory(day: date, features: list[dict]) -> dict:
    """Fast driver budget only (no journey planning) for the interactive inventory.

    Also returns what each enabled feature frees (+) or consumes (-), applied cumulatively
    in list order, so the UI can show a "+8 drivers" chip per feature.
    """
    if day not in _budget_cache:
        _budget_cache[day] = budget(load_day(day))
    base = _budget_cache[day]
    prev, steps, applied = base, [], []
    for f in features:
        if not f.get("enabled", True):
            steps.append(None)
            continue
        applied.append(f)
        cur = budget(apply_scenario(load_day(day), applied))
        steps.append({p: {"peak": prev["pools"][p]["peak"] - cur["pools"][p]["peak"],
                          "hours": round(prev["pools"][p]["hours"] - cur["pools"][p]["hours"], 1)}
                      for p in cur["pools"]})
        prev = cur
    return {"day": day.isoformat(), "baseline": base, "scenario": prev, "steps": steps}


if __name__ == "__main__":
    start = date.fromisoformat(sys.argv[1]) if len(sys.argv) > 1 else date(2026, 9, 28)
    n = int(sys.argv[2]) if len(sys.argv) > 2 else 7
    feats = json.loads(Path(sys.argv[3]).read_text()) if len(sys.argv) > 3 else []
    r = evaluate(start, n, feats)
    print(json.dumps({"period": r["period"], "baseline": r["baseline"], "scenario": r["scenario"]}, indent=2))
