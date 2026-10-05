"""Snap stop-to-stop movements onto the line geometry.

The PULS API only gives stop coordinates, so a straight line between two stops cuts
through buildings. For every (line, stop A, stop B) hop we take the shortest path along
that line's network geometry instead. If the line's own graph can't connect the two stops
(gaps in the geometry), we try the graph of all lines of that product (replacement
buses also try the tram network), then road routing via the public OSRM server (cached
on disk), and only then fall back to a straight line.

Paths are cached as numbered segments so the client can fetch each one once.
"""

from __future__ import annotations

import itertools
import json
import math
import threading
from collections import defaultdict
from pathlib import Path

import httpx
import networkx as nx
import numpy as np
from shapely.geometry import LineString

DENSIFY_M = 25  # max spacing of graph nodes, so stops snap close to the line
SNAP_MAX_M = 150  # a stop further than this from the line can't be snapped
OSRM_URL = "https://router.project-osrm.org/route/v1/driving/{a};{b}?overview=full&geometries=geojson"
_M_PER_DEG_LAT = 111_320.0


def _metres(lat0: float):
    kx = _M_PER_DEG_LAT * math.cos(math.radians(lat0))
    return lambda a, b: math.hypot((a[0] - b[0]) * kx, (a[1] - b[1]) * _M_PER_DEG_LAT)


class _Graph:
    """Undirected graph over (lon, lat) points with metre edge weights."""

    def __init__(self, parts: list[list[list[float]]], dist):
        self.g = nx.Graph()
        index: dict[tuple[float, float], int] = {}
        coords: list[tuple[float, float]] = []

        def node(pt):
            key = (round(pt[0], 5), round(pt[1], 5))  # ~1 m: joins touching parts
            if key not in index:
                index[key] = len(coords)
                coords.append(key)
            return index[key]

        for part in parts:
            for a, b in itertools.pairwise(part):
                d = dist(a, b)
                steps = max(1, math.ceil(d / DENSIFY_M))
                prev = node(a)
                for k in range(1, steps + 1):
                    t = k / steps
                    cur = node((a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t))
                    if cur != prev:
                        self.g.add_edge(prev, cur, w=d / steps)
                    prev = cur
        self.coords = coords
        self.xy = np.array(coords) if coords else np.zeros((0, 2))
        self.kx = math.cos(math.radians(self.xy[:, 1].mean())) if coords else 1.0

    def nearest(self, lon: float, lat: float) -> tuple[int, float] | None:
        if not len(self.xy):
            return None
        d2 = ((self.xy[:, 0] - lon) * self.kx) ** 2 + (self.xy[:, 1] - lat) ** 2
        i = int(d2.argmin())
        return i, math.sqrt(d2[i]) * _M_PER_DEG_LAT

    def path(self, a: tuple[float, float], b: tuple[float, float]) -> list[tuple[float, float]] | None:
        na, nb = self.nearest(*a), self.nearest(*b)
        if not na or not nb or na[1] > SNAP_MAX_M or nb[1] > SNAP_MAX_M:
            return None
        try:
            nodes = nx.shortest_path(self.g, na[0], nb[0], weight="w")
        except (nx.NetworkXNoPath, nx.NodeNotFound):
            return None
        return [self.coords[n] for n in nodes]


class Router:
    def __init__(self, network_file: Path, osrm_cache: Path | None = None):
        net = json.loads(network_file.read_text())
        self._dist = _metres(49.45)
        by_line: dict[tuple[str, str], list] = defaultdict(list)
        by_product: dict[str, list] = defaultdict(list)
        for f in net["features"]:
            p, g = f["properties"], f["geometry"]
            parts = [g["coordinates"]] if g["type"] == "LineString" else g["coordinates"]
            by_line[(p["product"], p["line"])].extend(parts)
            by_product[p["product"]].extend(parts)
        self._line_parts = by_line
        self._product_parts = by_product
        self._graphs: dict[tuple, _Graph] = {}
        self._seg_ids: dict[tuple, int] = {}
        self.segments: list[list[list[float]]] = []  # id -> [[lat, lon], ...]
        self._lock = threading.Lock()
        self._osrm_file = osrm_cache
        self._osrm: dict[str, list | None] = (
            json.loads(osrm_cache.read_text()) if osrm_cache and osrm_cache.exists() else {}
        )

    def _graph(self, key: tuple) -> _Graph | None:
        if key not in self._graphs:
            parts = self._line_parts.get(key[1:]) if key[0] == "line" else self._product_parts.get(key[1])
            self._graphs[key] = _Graph(parts, self._dist) if parts else None
        return self._graphs[key]

    def segment(self, product: str, line: str, a: tuple[float, float], b: tuple[float, float]) -> int:
        """Segment id of the path between stop a and stop b, given as (lat, lon). Thread-safe."""
        key = (product, line, round(a[0], 5), round(a[1], 5), round(b[0], 5), round(b[1], 5))
        with self._lock:
            if key in self._seg_ids:
                return self._seg_ids[key]
            pts = self._route(product, line, a, b)
            self._seg_ids[key] = len(self.segments)
            self.segments.append(pts)
            return self._seg_ids[key]

    def _route(self, product, line, a, b) -> list[list[float]]:
        straight = self._dist((a[1], a[0]), (b[1], b[0]))
        graphs = [("line", product, line), ("product", product)]
        if product == "Bus":
            graphs.append(("product", "Tram"))  # rail replacement buses (E5, E8, ...)
        for gkey in graphs:
            g = self._graph(gkey)
            cand = g.path((a[1], a[0]), (b[1], b[0])) if g else None
            # reject paths that wander off on big detours (wrong branch / gap in geometry)
            if cand and len(cand) > 1 and _length(cand, self._dist) <= 3 * straight + 400:
                simplified = LineString(cand).simplify(0.00001).coords
                return [[round(lat, 6), round(lon, 6)] for lon, lat in simplified]
        road = self._osrm_route(a, b)
        if road and _length([(p[1], p[0]) for p in road], self._dist) <= 3 * straight + 400:
            return road
        return [[a[0], a[1]], [b[0], b[1]]]

    def _osrm_route(self, a, b) -> list[list[float]] | None:
        ck = f"{a[0]:.5f},{a[1]:.5f};{b[0]:.5f},{b[1]:.5f}"
        if ck not in self._osrm:
            try:
                r = httpx.get(OSRM_URL.format(a=f"{a[1]},{a[0]}", b=f"{b[1]},{b[0]}"), timeout=5)
                coords = r.json()["routes"][0]["geometry"]["coordinates"]
                simplified = LineString(coords).simplify(0.00001).coords
                self._osrm[ck] = [[round(lat, 6), round(lon, 6)] for lon, lat in simplified]
            except (httpx.HTTPError, ValueError, KeyError, IndexError):
                return None  # not cached: retry next time
            if self._osrm_file:
                self._osrm_file.parent.mkdir(parents=True, exist_ok=True)
                self._osrm_file.write_text(json.dumps(self._osrm))
        return self._osrm[ck]


def _length(pts, dist) -> float:
    return sum(dist(p, q) for p, q in itertools.pairwise(pts))
