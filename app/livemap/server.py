"""Live map of the Nuremberg public transport network.

    uvicorn app.livemap.server:app --reload --reload-dir app --reload-dir src
    -> http://localhost:8000
"""

from __future__ import annotations

import asyncio
import logging
import os
from contextlib import asynccontextmanager
from datetime import date
from pathlib import Path

import httpx
from fastapi import FastAPI, HTTPException
from fastapi.responses import FileResponse
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel

from expressbus.data.vag import NETWORK_FILE, PULS_BASE, ROOT, STOPS_FILE, ensure_network
from expressbus.live.routing import Router
from expressbus.live.tracker import LiveTracker

logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(name)s: %(message)s")
logging.getLogger("httpx").setLevel(logging.WARNING)

STATIC = Path(__file__).parent / "static"
tracker = LiveTracker(record=os.getenv("RECORD_TRIPS", "1") == "1")
OSRM_CACHE = ROOT / "data" / "processed" / "osrm_cache.json"


@asynccontextmanager
async def lifespan(app: FastAPI):
    await asyncio.to_thread(ensure_network)
    tracker.router = Router(NETWORK_FILE, OSRM_CACHE)
    task = asyncio.create_task(tracker.run())
    warm = asyncio.create_task(asyncio.to_thread(_warm_planner))
    yield
    task.cancel()
    warm.cancel()


app = FastAPI(title="Nuremberg live map", lifespan=lifespan)


@app.get("/")
def index():
    return FileResponse(STATIC / "index.html")


@app.get("/api/network")
def network():
    return FileResponse(NETWORK_FILE, media_type="application/geo+json")


@app.get("/api/stops")
def stops():
    return FileResponse(STOPS_FILE, media_type="application/json")


@app.get("/api/vehicles")
def vehicles():
    return tracker.snapshot()


@app.post("/api/segments")
def segments(ids: list[int]):
    """Routed stop-to-stop paths ([[lat, lon], ...]) by segment id."""
    segs = tracker.router.segments
    return {i: segs[i] for i in ids if 0 <= i < len(segs)}


@app.get("/api/departures/{vgn_id}")
async def departures(vgn_id: int, limit: int = 10):
    async with httpx.AsyncClient(timeout=10) as client:
        r = await client.get(f"{PULS_BASE}/abfahrten/VGN/{vgn_id}", params={"limit": limit})
    if r.status_code != 200:
        raise HTTPException(r.status_code, "departures unavailable")
    return [
        {
            "line": a["Linienname"],
            "product": a["Produkt"],
            "direction": a["Richtungstext"],
            "planned": a["AbfahrtszeitSoll"],
            "actual": a.get("AbfahrtszeitIst"),
            "realtime": a.get("Prognose", False),
        }
        for a in r.json().get("Abfahrten", [])
    ]


# ---------- scenario planner ----------
DEFAULT_DAY = date(2026, 9, 28)  # Monday of the reference week
_eval_lock = asyncio.Lock()


def _warm_planner():
    """Prepare GTFS + baseline of the reference week in the background."""
    from expressbus.eval import engine
    from expressbus.eval.meta import planner_meta
    from expressbus.eval.timetable import preprocess

    preprocess()
    planner_meta(DEFAULT_DAY)
    engine.inventory(DEFAULT_DAY, [])
    engine.evaluate(DEFAULT_DAY, 7, [])
    from expressbus.eval import diagnose
    from expressbus.eval.coverage import supply_demand

    supply_demand()
    for key in ("service_gaps", "parallel_rail", "pt_vs_car"):
        diagnose.layer(key)
    logging.getLogger(__name__).info("planner baseline ready")


class InventoryRequest(BaseModel):
    day: date = DEFAULT_DAY
    features: list[dict] = []


class EvaluateRequest(BaseModel):
    start: date = DEFAULT_DAY
    days: int = 7
    features: list[dict] = []


@app.get("/planner")
def planner_page():
    return FileResponse(STATIC / "planner.html")


@app.get("/api/planner/meta")
async def planner_meta_api(day: date = DEFAULT_DAY):
    from expressbus.eval.meta import planner_meta

    return await asyncio.to_thread(planner_meta, day)


@app.post("/api/planner/inventory")
async def planner_inventory(req: InventoryRequest):
    from expressbus.eval import engine

    return await asyncio.to_thread(engine.inventory, req.day, req.features)


@app.post("/api/planner/evaluate")
async def planner_evaluate(req: EvaluateRequest):
    from expressbus.eval import engine

    if not 1 <= req.days <= 14:
        raise HTTPException(400, "days must be 1-14")
    async with _eval_lock:
        return await asyncio.to_thread(engine.evaluate, req.start, req.days, req.features)


# ---------- diagnosis ----------
@app.get("/diagnose")
def diagnose_page():
    return FileResponse(STATIC / "diagnose.html")


@app.get("/api/diagnose")
def diagnose_layers():
    from expressbus.eval.diagnose import LAYERS

    return LAYERS


@app.get("/api/diagnose/supply_demand")
async def diagnose_supply_demand():
    from expressbus.eval.coverage import supply_demand

    return await asyncio.to_thread(supply_demand)


@app.get("/api/diagnose/{key}")
async def diagnose_layer(key: str, bus_only: bool = True):
    from expressbus.eval.diagnose import LAYERS, layer

    if key not in LAYERS:
        raise HTTPException(404, "unknown layer")
    return await asyncio.to_thread(layer, key, bus_only)


app.mount("/static", StaticFiles(directory=STATIC), name="static")
