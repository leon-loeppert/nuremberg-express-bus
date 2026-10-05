"""Live map of the Nuremberg public transport network.

    uvicorn app.livemap.server:app --reload --reload-dir app --reload-dir src
    -> http://localhost:8000
"""

from __future__ import annotations

import asyncio
import logging
import os
from contextlib import asynccontextmanager
from pathlib import Path

import httpx
from fastapi import FastAPI, HTTPException
from fastapi.responses import FileResponse
from fastapi.staticfiles import StaticFiles

from expressbus.data.vag import NETWORK_FILE, PULS_BASE, STOPS_FILE, ensure_network
from expressbus.live.tracker import LiveTracker

logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(name)s: %(message)s")
logging.getLogger("httpx").setLevel(logging.WARNING)

STATIC = Path(__file__).parent / "static"
tracker = LiveTracker(record=os.getenv("RECORD_TRIPS", "1") == "1")


@asynccontextmanager
async def lifespan(app: FastAPI):
    await asyncio.to_thread(ensure_network)
    task = asyncio.create_task(tracker.run())
    yield
    task.cancel()


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


app.mount("/static", StaticFiles(directory=STATIC), name="static")
