"""Access to VAG Nürnberg data.

Two sources:
- PULS API (official VAG open data, https://start.vag.de/dm/api/v1): stops, live trips
  with planned (Soll) and real-time (Ist) times per stop.
- livemap.vag.de static files: line geometries for U-Bahn, tram and bus lines.

Run ``python -m expressbus.data.vag`` to download the static network into data/raw/vag/.
"""

from __future__ import annotations

import json
import math
from pathlib import Path

import httpx

PULS_BASE = "https://start.vag.de/dm/api/v1"
LIVEMAP_BASE = "https://livemap.vag.de"
PRODUCTS = ("Bus", "Tram", "UBahn")

ROOT = Path(__file__).resolve().parents[3]
NETWORK_DIR = ROOT / "data" / "raw" / "vag"
NETWORK_FILE = NETWORK_DIR / "network.geojson"
STOPS_FILE = NETWORK_DIR / "stops.json"

_R = 6378137.0


def mercator_to_wgs84(x: float, y: float) -> tuple[float, float]:
    """EPSG:3857 metres -> (lon, lat)."""
    lon = math.degrees(x / _R)
    lat = math.degrees(2 * math.atan(math.exp(y / _R)) - math.pi / 2)
    return round(lon, 6), round(lat, 6)


def fetch_stops(client: httpx.Client) -> list[dict]:
    r = client.get(f"{PULS_BASE}/haltestellen/VAG")
    r.raise_for_status()
    return [
        {
            "name": h["Haltestellenname"],
            "vag_id": h["VAGKennung"],
            "vgn_id": h["VGNKennung"],
            "lat": h["Latitude"],
            "lon": h["Longitude"],
            "products": [p for p in (h.get("Produkte") or "").split(",") if p],
        }
        for h in r.json()["Haltestellen"]
        if h.get("Latitude") and h.get("Longitude")
    ]


def fetch_network(client: httpx.Client) -> dict:
    """Merge rail lines (lines.xhr) and bus lines (buslines.geojson) into one FeatureCollection."""
    features = []

    rail = client.get(f"{LIVEMAP_BASE}/lines.xhr").json()
    for line_id, line in rail.items():
        geom = line["geojson"]["geometry"]
        props = line["geojson"]["properties"]
        coords = [mercator_to_wgs84(x, y) for x, y in geom["coordinates"]]
        features.append(
            {
                "type": "Feature",
                "geometry": {"type": "LineString", "coordinates": coords},
                "properties": {
                    "line": line_id,
                    "product": "UBahn" if line["type"] == "subway" else "Tram",
                    "operator": "vag",
                    "color": props.get("stroke"),
                },
            }
        )

    bus = client.get(f"{LIVEMAP_BASE}/static/buslines/buslines.geojson").json()
    for f in bus["features"]:
        features.append(
            {
                "type": "Feature",
                "geometry": f["geometry"],
                "properties": {
                    "line": f["properties"]["name"],
                    "product": "Bus",
                    "operator": f["properties"]["type"],  # "vag" (city) or "vgn" (regional)
                    "color": None,
                },
            }
        )

    return {"type": "FeatureCollection", "features": features}


def ensure_network(force: bool = False) -> None:
    """Download static network + stops once and cache them on disk."""
    if NETWORK_FILE.exists() and STOPS_FILE.exists() and not force:
        return
    NETWORK_DIR.mkdir(parents=True, exist_ok=True)
    with httpx.Client(timeout=60) as client:
        NETWORK_FILE.write_text(json.dumps(fetch_network(client)))
        STOPS_FILE.write_text(json.dumps(fetch_stops(client), ensure_ascii=False), encoding="utf-8")


if __name__ == "__main__":
    ensure_network(force=True)
    net = json.loads(NETWORK_FILE.read_text())
    stops = json.loads(STOPS_FILE.read_text())
    print(f"{len(net['features'])} line features, {len(stops)} stops -> {NETWORK_DIR}")
