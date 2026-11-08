"""Gemeinsame Einstellungen der Phase-0-Pipeline (Sulzburg, Ortskern).

Alle Skripte laufen von der Projektwurzel aus:  python3 -I scripts/0X_....py
"""
from __future__ import annotations

import datetime as _dt
import json
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
RAW = ROOT / "data" / "raw"            # Rohdaten des LGL (nicht im Git, siehe .gitignore)
WEB_DATA = ROOT / "web" / "data"       # Aufbereitete Daten für den Browser
SOURCES = ROOT / "data" / "sources.json"

# Koordinatenreferenzsystem der LGL-Daten: ETRS89 / UTM Zone 32N, Höhen NHN (DHHN2016)
EPSG = 25832

# Mittelpunkt des Ausschnitts: Marktplatz Sulzburg.
# Quelle der Koordinate: OpenStreetMap (Nominatim-Abfrage "Marktplatz, Sulzburg", 2026-11-08),
# © OpenStreetMap-Mitwirkende, ODbL. Dient nur zur Wahl des Ausschnitts, nicht als Datenebene.
CENTER_LATLON = (47.8405182, 7.7081700)

AOI_SIZE_M = 600          # Kantenlänge des quadratischen Ausschnitts in Metern
BUILDING_COUNT = 50       # Anzahl Gebäude im Spike (die dem Marktplatz nächsten)

# Kacheln des LGL Open GeoData Portals (2 km x 2 km, Benennung "E_N" in km, ungerade Kilometer)
TILES = ["403_5298"]

LICENSE = {
    "name": "Datenlizenz Deutschland – Namensnennung – Version 2.0",
    "url": "https://www.govdata.de/dl-de/by-2-0",
    "namensnennung": "Datenquelle: LGL, www.lgl-bw.de, dl-de/by-2-0",
    "herausgeber": "Landesamt für Geoinformation und Landentwicklung Baden-Württemberg (LGL)",
    "portal": "https://opengeodata.lgl-bw.de/",
}


def center_utm() -> tuple[float, float]:
    """Mittelpunkt in EPSG:25832 (E, N)."""
    from pyproj import Transformer

    tr = Transformer.from_crs("EPSG:4326", f"EPSG:{EPSG}", always_xy=True)
    lat, lon = CENTER_LATLON
    e, n = tr.transform(lon, lat)
    return e, n


def aoi() -> dict:
    """Ausschnitt als ganzzahlige UTM-Box (Meter)."""
    e, n = center_utm()
    half = AOI_SIZE_M // 2
    e0 = round(e)
    n0 = round(n)
    return {
        "epsg": EPSG,
        "e0": e0,
        "n0": n0,
        "e_min": e0 - half,
        "e_max": e0 + half,
        "n_min": n0 - half,
        "n_max": n0 + half,
        "size_m": AOI_SIZE_M,
    }


def now_iso() -> str:
    return _dt.datetime.now(_dt.timezone.utc).replace(microsecond=0).isoformat()


def load_sources() -> dict:
    if SOURCES.exists():
        return json.loads(SOURCES.read_text(encoding="utf-8"))
    return {"lizenz": LICENSE, "downloads": {}, "ebenen": {}}


def save_sources(doc: dict) -> None:
    doc["lizenz"] = LICENSE
    doc["aktualisiert"] = now_iso()
    SOURCES.parent.mkdir(parents=True, exist_ok=True)
    SOURCES.write_text(json.dumps(doc, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")


def local_xyz(e: float, n: float, z: float, box: dict) -> tuple[float, float, float]:
    """UTM -> lokales three.js-System (x nach Osten, y nach oben = Höhe NHN, z nach Süden)."""
    return e - box["e0"], z, -(n - box["n0"])
