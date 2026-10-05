"""Network-level proposals: regions, new express lines, lines to cut, and a balanced package.

Regions   adjacent under-/unserved 300 m cells (gaps of one cell allowed) form one region,
          named after the OSM suburb at its centre (Nominatim, cached).
Express   candidates are generated from the largest under-served regions: feeders to the
          nearest U-/S-Bahn hub and cross-town links between two regions (via a hub near the
          midpoint if that is on the way). Each candidate is costed with the driver model and
          its benefit measured with the journey planner (PT time before vs. after).
Cuts      VAG bus lines ranked by drivers freed vs. residents who would lose their only
          service, plus how much of the line runs where rail already serves.
Package   cuts are added until they free the drivers the best express lines need.
"""

from __future__ import annotations

import json
import math
import time
from collections import defaultdict
from datetime import date
from functools import lru_cache
from pathlib import Path

import httpx
import numpy as np
import pandas as pd

from expressbus.data.vag import ROOT
from expressbus.eval import demand, engine
from expressbus.eval.cartimes import street_route
from expressbus.eval.coverage import CELL_M, MIN_RESIDENTS, _to4326, cells_frame
from expressbus.eval.scenario import apply_scenario
from expressbus.eval.timetable import load_day

DAY = date(2026, 9, 28)
NAMES_CACHE = ROOT / "data" / "processed" / "region_names.json"
MIN_REGION_RESIDENTS = 1500
# VAG territory: Nürnberg, Fürth (city) and Landkreis Fürth (Zirndorf, Stein, Oberasbach)
VAG_AREA = ("de:09564:", "de:09563:", "de:09573:")
EXPRESS = {"headway_min": 15, "from_h": 6, "to_h": 20, "days": "weekday"}
PROBE_TIMES = (int(7.5 * 3600), int(16.5 * 3600))


# ---------- regions ----------
def _components(cells: pd.DataFrame, reach: int = 2) -> list[list[int]]:
    """Connected groups of cells; cells up to `reach` grid steps apart count as neighbours."""
    pos = {(cx, cy): i for i, (cx, cy) in enumerate(zip(cells.cx, cells.cy))}
    parent = list(range(len(cells)))

    def find(i):
        while parent[i] != i:
            parent[i] = parent[parent[i]]
            i = parent[i]
        return i

    for (cx, cy), i in pos.items():
        for dx in range(-reach, reach + 1):
            for dy in range(-reach, reach + 1):
                j = pos.get((cx + dx, cy + dy))
                if j is not None:
                    parent[find(i)] = find(j)
    groups = defaultdict(list)
    for i in range(len(cells)):
        groups[find(i)].append(i)
    return list(groups.values())


def _place_name(lat: float, lon: float, cache: dict) -> str | None:
    key = f"{lat:.3f},{lon:.3f}"
    if key not in cache:
        try:
            r = httpx.get("https://nominatim.openstreetmap.org/reverse",
                          params={"lat": lat, "lon": lon, "format": "json", "zoom": 15, "accept-language": "de"},
                          headers={"User-Agent": "nuremberg-express-bus hackathon prototype"}, timeout=10)
            a = r.json().get("address", {})
            cache[key] = a.get("suburb") or a.get("quarter") or a.get("neighbourhood") or a.get("village") or a.get("town") or a.get("city_district")
            time.sleep(1.1)  # Nominatim usage policy: max 1 request/s
        except (httpx.HTTPError, ValueError):
            return None
    return cache[key]


@lru_cache(maxsize=1)
def _stations() -> pd.DataFrame:
    """Stations with departures per product (for anchors and hubs)."""
    tt = load_day(DAY)
    st = tt.stop_times.merge(tt.trips[["trip_id", "product"]], on="trip_id")
    dep = st.groupby(["station", "product"]).size().unstack(fill_value=0)
    out = tt.stations.set_index("station").join(dep, how="inner").fillna(0)
    for p in ("Bus", "Tram", "UBahn", "SBahn"):
        if p not in out:
            out[p] = 0
    return out


def _nearest(df: pd.DataFrame, lat: float, lon: float) -> tuple[str, float]:
    d = np.hypot((df.lat.values - lat) * 111.3, (df.lon.values - lon) * 72.4)
    i = int(d.argmin())
    return df.index[i], float(d[i])


@lru_cache(maxsize=1)
def regions() -> dict:
    cells, median = cells_frame()
    stations = _stations()
    vag_stops = stations[(stations.Bus + stations.Tram + stations.UBahn) > 0]
    names = json.loads(NAMES_CACHE.read_text()) if NAMES_CACHE.exists() else {}
    out = {"under": []}
    # over-supplied cells merge into one huge inner-city blob, so only under-served regions are
    # built; where buses are redundant is covered line by line in cut_candidates()
    for kind, classes in (("under", ("under", "unserved")),):
        sub = cells[cells["class"].isin(classes) & (cells["pop"] >= MIN_RESIDENTS)].reset_index(drop=True)
        for idx in _components(sub):
            g = sub.iloc[idx]
            res = int(g["pop"].sum())
            if res < MIN_REGION_RESIDENTS:
                continue
            w = g["pop"] / res
            lat, lon = float((g.lat * w).sum()), float((g.lon * w).sum())
            line_weight = defaultdict(int)
            for lines, p in zip(g.bus_lines, g["pop"]):
                for ln in lines:
                    line_weight[ln] += int(p)
            anchor, anchor_km = _nearest(vag_stops, lat, lon)
            if not anchor.startswith(VAG_AREA):
                continue
            half = CELL_M / 2
            lo = _to4326.transform(g.x.values - half, g.y.values - half)
            hi = _to4326.transform(g.x.values + half, g.y.values + half)
            out[kind].append({
                "kind": kind, "residents": res, "cells": len(g), "lat": lat, "lon": lon,
                "places_per_resident": round(float(g.total.sum() / res), 1),
                "deficit_places": int(np.clip(median * g["pop"] - g.total, 0, None).sum()),
                "unserved_residents": int(g.loc[g["class"] == "unserved", "pop"].sum()),
                "bus_places": int(g.bus.sum()), "rail_covered_share": round(float((g.rail_covered * g["pop"]).sum() / res), 2),
                "lines": [f"Bus {ln}" for ln, _ in sorted(line_weight.items(), key=lambda x: -x[1])],
                "anchor": {"id": anchor, "name": stations.name[anchor], "km": round(anchor_km, 2)},
                "boxes": [[round(a, 5), round(b, 5), round(c, 5), round(d, 5)] for a, b, c, d in zip(lo[1], lo[0], hi[1], hi[0])],
            })
        out[kind].sort(key=lambda r: -(r["deficit_places"] if kind == "under" else r["bus_places"]))
        out[kind] = out[kind][:15]
        for i, r in enumerate(out[kind]):
            r["id"] = f"{kind}-{i + 1}"
            r["name"] = _place_name(r["lat"], r["lon"], names) or _short(r["anchor"]["name"])
    NAMES_CACHE.parent.mkdir(parents=True, exist_ok=True)
    NAMES_CACHE.write_text(json.dumps(names, ensure_ascii=False))
    return out


# ---------- impact on the full demand matrix ----------
DAILY_TRIPS = 450_000  # assumption: ~VAG weekday ridership, only used to express minutes as hours/day


@lru_cache(maxsize=1)
def _base_pt() -> np.ndarray:
    return demand.pt_minutes(load_day(DAY))


def _impact(features: list[dict]) -> dict:
    """Demand-weighted effect of a scenario on all zone-to-zone trips (weekday peaks)."""
    m = demand.matrix()
    T, base = m["T"], _base_pt()
    scen = demand.pt_minutes(apply_scenario(load_day(DAY), features)) if features else base
    diff = base - scen  # minutes saved per trip (negative = slower)
    faster, slower = (diff > 0.5) & (T > 0), (diff < -0.5) & (T > 0)
    return {
        "avg_minutes_saved": float((T * diff).sum()),
        "hours_saved_per_day": float((T * diff).sum() * DAILY_TRIPS / 60),
        "share_faster": float(T[faster].sum()), "avg_saving_min": float((T * diff)[faster].sum() / max(T[faster].sum(), 1e-12)),
        "share_slower": float(T[slower].sum()), "avg_loss_min": float(-(T * diff)[slower].sum() / max(T[slower].sum(), 1e-12)),
        "pt_minutes": float((T * scen).sum()), "share_competitive": float(T[(scen <= 1.5 * m["car"]) & (T > 0)].sum()),
    }


def _benefit(features: list[dict]) -> float:
    return _impact(features)["hours_saved_per_day"]


# ---------- express candidates ----------
@lru_cache(maxsize=1)
def express_candidates() -> list[dict]:
    """Corridors with the most demand-weighted time lost against the car -> express lines."""
    m = demand.matrix()
    T, car, dist, stn = m["T"], m["car"], m["dist"], m["stations"]
    z = demand.zones()
    excess = T * np.clip(_base_pt() - 1.3 * car, 0, None)
    excess[dist < 4] = 0  # express lines are for longer trips
    cell = np.array([f"{int(a / 0.018)}:{int(b / 0.028)}" for a, b in zip(z.lat, z.lon)])  # ~2 km grid
    stations = _stations()
    hubs = stations[(stations.UBahn + stations.SBahn + stations.Tram) >= 60]
    corridors = defaultdict(float)
    ii, jj = np.nonzero(excess)
    for i, j in zip(ii, jj):
        corridors[tuple(sorted((cell[i], cell[j])))] += excess[i, j]
    cands = []
    for (ca, cb), _ in sorted(corridors.items(), key=lambda kv: -kv[1])[:16]:
        ends = []
        for c in (ca, cb):  # the stop in each end cell that carries most of the corridor's excess
            rows = np.nonzero(cell == c)[0]
            other = np.nonzero(cell == (cb if c == ca else ca))[0]
            w = excess[np.ix_(rows, other)].sum(axis=1) + excess[np.ix_(other, rows)].sum(axis=0)
            ends.append(stn[rows[int(w.argmax())]])
        a, b = ends
        if a == b or not (a.startswith(VAG_AREA) and b.startswith(VAG_AREA)):
            continue
        la, oa, lb, ob = stations.lat[a], stations.lon[a], stations.lat[b], stations.lon[b]
        dx, dy = (ob - oa) * 72.4, (lb - la) * 111.3
        length = math.hypot(dx, dy)
        via = []
        for h, r in hubs.iterrows():  # up to two transfer hubs close to the straight line
            px, py = (r.lon - oa) * 72.4, (r.lat - la) * 111.3
            u = (px * dx + py * dy) / length ** 2
            if 0.15 < u < 0.85 and abs(px * dy - py * dx) / length < 0.7 and h not in (a, b):
                via.append((u, r.UBahn + r.SBahn + r.Tram, h))
        cands.append([a, *(h for _, _, h in sorted(sorted(via, key=lambda x: -x[1])[:2])), b])

    out, seen = [], set()
    for route in cands:
        key = frozenset((route[0], route[-1]))
        if key in seen:
            continue
        seen.add(key)
        feat = {"type": "add_express", "name": "X", "stations": route, **EXPRESS}
        imp = _impact([feat])
        if imp["hours_saved_per_day"] <= 0:
            continue
        inv = engine.inventory(DAY, [feat])["steps"][0]["Bus"]
        drivers = max(1, -inv["peak"])
        street = street_route([(stations.lat[s], stations.lon[s]) for s in route])
        out.append({
            "feature": feat, "stations": route, "drivers": drivers, "driver_hours": round(-inv["hours"], 1),
            "hours_saved_per_day": round(imp["hours_saved_per_day"]), "share_faster": round(imp["share_faster"], 4),
            "avg_saving_min": round(imp["avg_saving_min"], 1),
            "path": street["path"] if street else None, "km": street["km"] if street else None,
            "run_minutes": round(sum(street["legs_s"]) * 1.3 / 60 + 0.5 * (len(route) - 2)) if street else None,
            "stop_names": [_short(stations.name[s]) for s in route],
            "coords": [[round(float(stations.lat[s]), 5), round(float(stations.lon[s]), 5)] for s in route],
            "score": round(imp["hours_saved_per_day"] / drivers, 1),
        })
    out.sort(key=lambda c: -c["score"])
    for i, c in enumerate(out[:6]):
        c["name"] = c["feature"]["name"] = f"X{i + 1}"
        c["title"] = f"X{i + 1} {' – '.join(c['stop_names'])}"
    return out[:6]


# ---------- lines to cut ----------
@lru_cache(maxsize=1)
def cut_candidates() -> list[dict]:
    cells, _ = cells_frame()
    tt = load_day(DAY)
    bus = sorted({ln for ln in tt.trips.loc[tt.trips["product"] == "Bus", "line"] if ln[0] not in "EN"}, key=_num)
    line_total, line_rail, unique_res = defaultdict(float), defaultdict(float), defaultdict(int)
    for r in cells[cells.bus > 0].itertuples(index=False):
        n = max(1, len(r.bus_lines))
        for ln in r.bus_lines:
            line_total[ln] += r.bus / n
            if r.rail_covered:
                line_rail[ln] += r.bus / n
        if len(r.bus_lines) == 1 and r.rail == 0 and r.other_bus == 0:
            unique_res[r.bus_lines[0]] += int(r.pop)
    out = []
    for ln in bus:
        if not line_total.get(ln):
            continue
        share = line_rail[ln] / line_total[ln]
        lose = unique_res.get(ln, 0)
        # removing only when almost all of the line runs next to rail; otherwise keep it, but thinner
        action = "remove" if share >= 0.75 and lose < 100 else "thin" if share >= 0.35 else None
        if not action:
            continue
        # cuts apply Mon-Fri only: that is when the express lines run and need the drivers
        feat = ({"type": "remove_line", "line": f"Bus:{ln}", "days": "weekday"} if action == "remove"
                else {"type": "thin_line", "line": f"Bus:{ln}", "from_h": 6, "to_h": 20, "keep_every": 2, "days": "weekday"})
        inv = engine.inventory(DAY, [feat])["steps"][0]["Bus"]
        if inv["peak"] <= 0:
            continue
        lost = max(0.0, -_benefit([feat]))  # passenger hours lost per weekday
        out.append({
            "line": f"Bus {ln}", "action": action, "feature": feat, "drivers": inv["peak"], "hours": inv["hours"],
            "rail_share": round(share, 2), "residents_losing_only_service": lose, "hours_lost_per_day": round(lost),
            "title": f"{'Remove' if action == 'remove' else 'Thin (every 2nd trip 06–20 h)'} Bus {ln} (Mon–Fri)",
        })
    out.sort(key=lambda c: c["hours_lost_per_day"] / c["drivers"])  # least passenger harm per driver first
    return out[:10]


# ---------- balanced package ----------
@lru_cache(maxsize=1)
def package() -> dict:
    """Add express lines while cuts can pay for them and passengers gain overall."""
    express, cuts = express_candidates(), cut_candidates()
    chosen_x, chosen_c = [], []
    for x in express[:4]:
        trial_c = list(chosen_c)
        for c in [None, *cuts]:
            if c and c not in trial_c:
                trial_c.append(c)
            inv = engine.inventory(DAY, [*(y["feature"] for y in trial_c), *(y["feature"] for y in chosen_x), x["feature"]])
            b, s = inv["baseline"]["pools"]["Bus"], inv["scenario"]["pools"]["Bus"]
            if s["peak"] <= b["peak"] and s["hours"] <= b["hours"]:
                break
        else:
            continue  # cannot be funded
        feats = [*(y["feature"] for y in trial_c), *(y["feature"] for y in chosen_x), x["feature"]]
        current = _benefit([*(y["feature"] for y in chosen_c), *(y["feature"] for y in chosen_x)]) if (chosen_x or chosen_c) else 0
        if _benefit(feats) > current:
            chosen_x.append(x)
            chosen_c = trial_c
    feats = [*(c["feature"] for c in chosen_c), *(x["feature"] for x in chosen_x)]
    inv = engine.inventory(DAY, feats)
    b, s = inv["baseline"]["pools"]["Bus"], inv["scenario"]["pools"]["Bus"]
    return {
        "express": [{"title": x["title"], "feature": x["feature"], "drivers": x["drivers"], "hours_saved_per_day": x["hours_saved_per_day"]} for x in chosen_x],
        "cuts": [{"title": c["title"], "feature": c["feature"], "drivers": c["drivers"], "hours_lost_per_day": c["hours_lost_per_day"]} for c in chosen_c],
        "drivers_before": b["peak"], "drivers_after": s["peak"],
        "hours_before": b["hours"], "hours_after": s["hours"],
        "balanced": s["peak"] <= b["peak"] and s["hours"] <= b["hours"],
    }


@lru_cache(maxsize=1)
def verdict() -> dict:
    """Does the package reach the goal? Judged on the full reference week (same evaluation as the planner)."""
    p = package()
    feats = [c["feature"] for c in p["cuts"]] + [x["feature"] for x in p["express"]]
    peak = _impact(feats)
    r = engine.evaluate(DAY, 7, feats) if feats else None
    if not r:
        return {"achieved": False}
    b, s = r["baseline"], r["scenario"]
    drivers_ok = s["drivers_peak"]["Bus"] <= b["drivers_peak"]["Bus"] and s["driver_hours_week"]["Bus"] <= b["driver_hours_week"]["Bus"]
    return {
        "achieved": bool(p["express"] and drivers_ok and s["pt_minutes_mean"] < b["pt_minutes_mean"]),
        "drivers_ok": drivers_ok, "drivers_before": b["drivers_peak"]["Bus"], "drivers_after": s["drivers_peak"]["Bus"],
        "driver_hours_before": b["driver_hours_week"]["Bus"], "driver_hours_after": s["driver_hours_week"]["Bus"],
        "pt_minutes_before": b["pt_minutes_mean"], "pt_minutes_after": s["pt_minutes_mean"],
        "competitive_before": b["share_competitive"], "competitive_after": s["share_competitive"],
        "wait_before": b["expected_wait_min"], "wait_after": s["expected_wait_min"],
        "period": r["period"],
        # who gains / loses, weekday peaks
        "hours_saved_per_day": round(peak["hours_saved_per_day"]),
        "share_faster": round(peak["share_faster"], 4), "avg_saving_min": round(peak["avg_saving_min"], 1),
        "share_slower": round(peak["share_slower"], 4), "avg_loss_min": round(peak["avg_loss_min"], 1),
    }


CACHE_FILE = ROOT / "data" / "processed" / "proposals.json"


def all_proposals() -> dict:
    """Cached on disk; recomputed when the model code or input data is newer than the cache."""
    inputs = [*Path(__file__).parent.glob("*.py"), ROOT / "data" / "raw" / "gtfs" / "vgn_gtfs.zip"]
    if CACHE_FILE.exists() and CACHE_FILE.stat().st_mtime > max(p.stat().st_mtime for p in inputs if p.exists()):
        return json.loads(CACHE_FILE.read_text())
    out = {"regions": regions(), "express": express_candidates(), "cuts": cut_candidates(),
           "package": package(), "verdict": verdict()}
    CACHE_FILE.parent.mkdir(parents=True, exist_ok=True)
    CACHE_FILE.write_text(json.dumps(out, ensure_ascii=False, default=float))
    return out


def _short(name: str) -> str:
    return name.replace("Nürnberg ", "").replace("Fürth ", "Fürth-")


def _num(s: str):
    digits = "".join(c for c in s if c.isdigit())
    return (int(digits) if digits else 9999, s)


if __name__ == "__main__":
    t0 = time.time()
    for c in express_candidates():
        print(f"  {c['title']:75} {c['hours_saved_per_day']:>5} h/day saved  {c['share_faster']:.2%} faster by {c['avg_saving_min']} min  drivers {c['drivers']}  {c['km']} km")
    print(f"express {time.time() - t0:.0f}s")
    t0 = time.time()
    for c in cut_candidates():
        print(f"  {c['title']:45} frees {c['drivers']} drivers  costs {c['hours_lost_per_day']} h/day  rail {c['rail_share']}")
    print(f"cuts {time.time() - t0:.0f}s")
    p = package()
    print("PACKAGE", [x["title"] for x in p["express"]], [c["title"] for c in p["cuts"]], p["drivers_before"], "->", p["drivers_after"])
    print(json.dumps(verdict(), ensure_ascii=False, indent=1))
