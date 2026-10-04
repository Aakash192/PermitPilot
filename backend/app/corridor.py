"""Distance from each permit to Calgary's Transportation Utility Corridor (TUC).

The TUC is provincial land reserved for the ring road (Stoney Trail) and major utilities.
Housing next to it may need extra checks (provincial referral, noise, utility setbacks),
so we measure how far every permit is from the corridor edge. 0 means inside it.
"""
import json
from pathlib import Path

import numpy as np

# Calgary is small enough that a flat projection around its latitude is accurate to a few metres.
_LAT0 = 51.05
_KX = 111_320 * np.cos(np.radians(_LAT0))  # metres per degree of longitude
_KY = 110_540                               # metres per degree of latitude


def load_polygons(path: Path) -> list[list[np.ndarray]]:
    """Each polygon is [exterior ring, hole rings...] as arrays of (lon, lat)."""
    if not path.exists():
        return []
    geo = json.loads(path.read_text(encoding="utf-8"))
    polygons = []
    for feature in geo.get("features", []):
        geom = feature.get("geometry") or {}
        parts = geom.get("coordinates", [])
        if geom.get("type") == "Polygon":
            parts = [parts]
        for poly in parts:
            polygons.append([np.asarray(ring, dtype=float)[:, :2] for ring in poly])
    return polygons


def _inside_ring(x: np.ndarray, y: np.ndarray, ring: np.ndarray) -> np.ndarray:
    """Ray casting for many points against one ring."""
    inside = np.zeros(len(x), dtype=bool)
    x1, y1 = ring[:-1, 0], ring[:-1, 1]
    x2, y2 = ring[1:, 0], ring[1:, 1]
    for ax, ay, bx, by in zip(x1, y1, x2, y2):
        crosses = (ay > y) != (by > y)
        if not crosses.any():
            continue
        x_at = (bx - ax) * (y - ay) / (by - ay + 1e-300) + ax
        inside ^= crosses & (x < x_at)
    return inside


def distances_m(lon: np.ndarray, lat: np.ndarray, polygons: list[list[np.ndarray]]) -> np.ndarray:
    """Metres from each point to the nearest corridor edge (0 if inside). NaN if no corridor data."""
    lon = np.asarray(lon, dtype=float)
    lat = np.asarray(lat, dtype=float)
    if not polygons:
        return np.full(len(lon), np.nan)

    inside = np.zeros(len(lon), dtype=bool)
    for poly in polygons:
        in_poly = _inside_ring(lon, lat, poly[0])
        for hole in poly[1:]:
            in_poly &= ~_inside_ring(lon, lat, hole)
        inside |= in_poly

    # All ring edges as segments, in metres.
    segs = np.concatenate([np.hstack([ring[:-1], ring[1:]]) for poly in polygons for ring in poly])
    ax, ay = segs[:, 0] * _KX, segs[:, 1] * _KY
    bx, by = segs[:, 2] * _KX, segs[:, 3] * _KY
    dx, dy = bx - ax, by - ay
    seg_len2 = np.maximum(dx * dx + dy * dy, 1e-12)

    px, py = lon * _KX, lat * _KY
    best = np.full(len(lon), np.inf)
    for start in range(0, len(lon), 200):  # chunk to keep memory small
        cx = px[start:start + 200, None]
        cy = py[start:start + 200, None]
        t = np.clip(((cx - ax) * dx + (cy - ay) * dy) / seg_len2, 0, 1)
        d = np.hypot(cx - (ax + t * dx), cy - (ay + t * dy))
        best[start:start + 200] = d.min(axis=1)

    best[inside] = 0.0
    return best
