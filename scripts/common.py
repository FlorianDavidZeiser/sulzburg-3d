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

# Kacheln des LGL Open GeoData Portals (2 km x 2 km, Benennung "E_N" in km; Ost ungerade, Nord gerade Kilometer).
# Phase 0: nur die Kachel des Ortskerns. Ab Phase 1 liefert scripts/00_gemeinde.py die Liste in data/kacheln.json.
TILES = ["403_5298"]
_KACHELN = ROOT / "data" / "kacheln.json"
if _KACHELN.exists():
    TILES = [k["kachel"] for k in json.loads(_KACHELN.read_text(encoding="utf-8"))["kacheln"]]

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
    payload = json.dumps(doc, ensure_ascii=False, indent=2) + "\n"
    SOURCES.write_text(payload, encoding="utf-8")
    WEB_DATA.mkdir(parents=True, exist_ok=True)
    (WEB_DATA / "sources.json").write_text(payload, encoding="utf-8")  # Kopie für die Quellenseite


def local_xyz(e: float, n: float, z: float, box: dict) -> tuple[float, float, float]:
    """UTM -> lokales three.js-System (x nach Osten, y nach oben = Höhe NHN, z nach Süden)."""
    return e - box["e0"], z, -(n - box["n0"])


# Annahmen des Szenarios "PV auf allen geeigneten Dächern" (scripts/04_buildings.py, scripts/10_solar.py).
# Jede Annahme mit Begründung; sie erscheinen so auf der Seite "Datenquellen und Grenzen".
PV_ANNAHMEN = {
    "min_flaeche_m2": {"wert": 10.0, "grund": "Kleinere Dachflächen (Gauben, Erker) gelten als nicht sinnvoll belegbar. Annahme."},
    "max_neigung_grad": {"wert": 60.0, "grund": "Steilere Flächen gelten als Fassade. Annahme."},
    "flach_bis_grad": {"wert": 10.0, "grund": "Bis 10 Grad Neigung gilt eine Fläche als Flachdach mit aufgeständerten Modulen. Annahme."},
    "max_abweichung_sued_grad": {"wert": 100.0, "grund": "Geneigte Flächen zählen von Ost über Süd bis West (plus 10 Grad); nach Norden geneigte Flächen nicht. Annahme."},
    "belegung_geneigt": {"wert": 0.6, "grund": "60 Prozent der geeigneten geneigten Fläche mit Modulen, wegen Randabständen, Dachfenstern und Kaminen. Annahme."},
    "belegung_flach": {"wert": 0.4, "grund": "40 Prozent der Flachdachfläche, wegen Reihenabständen der aufgeständerten Module. Annahme."},
    "aufstaenderung_flach_grad": {"wert": 15.0, "grund": "Module auf Flachdächern 15 Grad nach Süden aufgeständert. Annahme."},
    "kwp_je_m2": {"wert": 0.2, "grund": "Modulwirkungsgrad rund 20 Prozent bei 1000 W/m² Normbestrahlung (STC) ergibt 0,2 kWp je m² Modulfläche."},
    "systemverluste": {"wert": 0.14, "grund": "Standardwert für Systemverluste im PVGIS-Rechner der EU-Kommission (14 Prozent)."},
    "albedo": {"wert": 0.2, "grund": "Übliche Bodenreflexion für Gras und Dächer. Annahme."},
}


def pv_eignung(flaeche_m2: float, neigung_grad: float, ausrichtung_grad: float) -> int:
    """0 = nicht geeignet, 1 = geneigte Fläche geeignet, 2 = Flachdach geeignet. Ausrichtung: 0 = Süd, 90 = West, -90 = Ost."""
    a = PV_ANNAHMEN
    if flaeche_m2 < a["min_flaeche_m2"]["wert"] or neigung_grad > a["max_neigung_grad"]["wert"]:
        return 0
    if neigung_grad <= a["flach_bis_grad"]["wert"]:
        return 2
    return 1 if abs(ausrichtung_grad) <= a["max_abweichung_sued_grad"]["wert"] else 0
