"""Polls the VAG PULS API and keeps the current set of running trips in memory.

Every LIST_INTERVAL seconds the trip lists for Bus/Tram/UBahn are fetched. Trip details
(stop sequence with planned + real-time times and coordinates) are fetched for every
trip in the current time window and refreshed every DETAIL_REFRESH seconds while it runs.
Completed trips are optionally appended to data/raw/live/trips_<date>.jsonl so delay
data accumulates for later analysis.
"""

from __future__ import annotations

import asyncio
import itertools
import json
import logging
import time
from datetime import datetime, timedelta

import httpx

from expressbus.data.vag import PRODUCTS, PULS_BASE, ROOT
from expressbus.live.routing import Router

log = logging.getLogger(__name__)

LIST_INTERVAL = 30  # s between trip-list polls
DETAIL_REFRESH = 90  # s between detail refreshes of a running trip
MAX_REFRESHES_PER_CYCLE = 150  # new trips are always fetched; this caps refreshes
CONCURRENCY = 6
PRE_START = timedelta(minutes=5)  # show a trip this long before its scheduled start
POST_END = timedelta(minutes=15)  # keep it this long after scheduled end (delays)

RECORD_DIR = ROOT / "data" / "raw" / "live"


def _ts(s: str | None) -> float | None:
    return datetime.fromisoformat(s).timestamp() if s else None


def compact_trip(product: str, d: dict) -> dict:
    """Reduce a PULS trip detail to what the map needs. Times are epoch seconds."""
    stops = []
    for s in d.get("Fahrtverlauf", []):
        arr_soll, dep_soll = _ts(s.get("AnkunftszeitSoll")), _ts(s.get("AbfahrtszeitSoll"))
        arr = _ts(s.get("AnkunftszeitIst")) or arr_soll or _ts(s.get("AbfahrtszeitIst")) or dep_soll
        dep = _ts(s.get("AbfahrtszeitIst")) or dep_soll or arr
        planned = dep_soll or arr_soll
        stops.append(
            {
                "name": s["Haltestellenname"],
                "lat": s["Latitude"],
                "lon": s["Longitude"],
                "arr": arr,
                "dep": dep,
                "delay": round((dep or arr) - planned) if planned and (dep or arr) else 0,
            }
        )
    return {
        "id": f"{product}:{d['Fahrtnummer']}",
        "product": product,
        "line": d["Linienname"],
        "direction": d.get("Richtungstext", ""),
        "vehicle": d.get("Fahrzeugnummer"),
        "realtime": bool(d.get("Prognose")),
        "occupancy": d.get("Besetztgrad"),
        "service_day": d.get("Betriebstag"),
        "stops": stops,
    }


class LiveTracker:
    def __init__(self, router: Router | None = None, record: bool = True):
        self.router = router
        self.record = record
        self.trips: dict[str, dict] = {}  # id -> compact trip
        self._fetched_at: dict[str, float] = {}
        self._window: dict[str, tuple[float, float]] = {}  # id -> (start, end) scheduled
        self.last_update: float | None = None
        self._client: httpx.AsyncClient | None = None
        self._sem = asyncio.Semaphore(CONCURRENCY)

    async def run(self) -> None:
        async with httpx.AsyncClient(timeout=20) as client:
            self._client = client
            while True:
                try:
                    await self._cycle()
                except Exception:
                    log.exception("tracker cycle failed")
                await asyncio.sleep(LIST_INTERVAL)

    async def _cycle(self) -> None:
        now = datetime.now().astimezone()
        listed: dict[str, tuple[str, dict]] = {}
        for product in PRODUCTS:
            r = await self._client.get(f"{PULS_BASE}/fahrten/{product}")
            r.raise_for_status()
            for f in r.json().get("Fahrten", []):
                start, end = datetime.fromisoformat(f["Startzeit"]), datetime.fromisoformat(f["Endzeit"])
                if start - PRE_START <= now <= end + POST_END:
                    tid = f"{product}:{f['Fahrtnummer']}"
                    listed[tid] = (product, f)
                    self._window[tid] = (start.timestamp(), end.timestamp())

        # Drop trips that left the window; record them as completed.
        for tid in [t for t in self.trips if t not in listed]:
            self._finish(tid)

        # Fetch missing details first, then refresh the stalest running ones.
        t_now = time.time()
        todo = [t for t in listed if t not in self.trips]
        stale = sorted(
            (t for t in listed if t in self.trips and self._window[t][0] <= t_now
             and t_now - self._fetched_at[t] > DETAIL_REFRESH),
            key=lambda t: self._fetched_at[t],
        )
        todo += stale[:MAX_REFRESHES_PER_CYCLE]
        await asyncio.gather(*(self._fetch_detail(t, *listed[t]) for t in todo))
        self.last_update = time.time()
        log.info("tracking %d trips (%d detail requests)", len(self.trips), len(todo))

    async def _fetch_detail(self, tid: str, product: str, f: dict) -> None:
        url = f"{PULS_BASE}/fahrten/{product}/{f['Betriebstag']}/{f['Fahrtnummer']}"
        async with self._sem:
            try:
                r = await self._client.get(url)
                r.raise_for_status()
                trip = compact_trip(product, r.json())
                if self.router:
                    await asyncio.to_thread(self._attach_segments, trip)
                self.trips[tid] = trip
                self._fetched_at[tid] = time.time()
            except (httpx.HTTPError, ValueError, KeyError) as e:  # keep the stale copy
                log.debug("detail %s failed: %s", tid, e)

    def _attach_segments(self, trip: dict) -> None:
        """stops[i]["seg"] = id of the routed path from stop i-1 to stop i."""
        s = trip["stops"]
        for a, b in itertools.pairwise(s):
            b["seg"] = self.router.segment(trip["product"], trip["line"], (a["lat"], a["lon"]), (b["lat"], b["lon"]))

    def _finish(self, tid: str) -> None:
        trip = self.trips.pop(tid, None)
        self._fetched_at.pop(tid, None)
        self._window.pop(tid, None)
        if trip and self.record:
            RECORD_DIR.mkdir(parents=True, exist_ok=True)
            path = RECORD_DIR / f"trips_{trip['service_day']}.jsonl"
            with path.open("a") as fh:
                fh.write(json.dumps(trip, ensure_ascii=False) + "\n")

    def snapshot(self) -> dict:
        return {"updated": self.last_update, "trips": list(self.trips.values())}
