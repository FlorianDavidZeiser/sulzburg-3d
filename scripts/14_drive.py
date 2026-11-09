"""Schritt 14: Daten für den Fahrmodus (Spielmodus, kein echter Verkehr).

Der Fahrmodus lädt diese Dateien erst, wenn jemand ein Auto absetzt. Die normale Ansicht bleibt unverändert.

1. Fahrnetz aus OpenStreetMap (data/raw/osm/strassen_overpass.json, Abfrage im Kopf von scripts/13_cars.py).
   Befahrbar sind Straßen und Wege, die laut OSM für Autos offen sind oder keine Angabe haben:
     secondary, tertiary, tertiary_link, unclassified, residential, living_street, service, track
   Ausgeschlossen:
     - access, vehicle oder motor_vehicle = private oder no  (privat oder gesperrt)
     - dieselben Schlüssel = agricultural oder forestry       (nur Land- und Forstwirtschaft)
     - service = driveway                                     (Grundstückszufahrt)
     - service-Wege überwiegend auf Gewerbe- und Industrieflächen laut OSM (landuse industrial oder commercial,
       data/raw/osm/gewerbeflaechen_overpass.json). Damit sind Betriebsgelände nicht befahrbar.
     - Durchfahrten durch Gebäude (tunnel = building_passage)
   Parkplätze (amenity = parking als Fläche) sind befahrbar, außer privat oder auf Gewerbe- und Industrieflächen.
   Breite aus dem OSM-Tag width, sonst ein Standardwert je Straßenart (Annahme, siehe BREITE).
   Ausgabe: web/data/fahrnetz.json (ODbL, © OpenStreetMap-Mitwirkende)

2. Gebäudegrundrisse für die Kollision aus den Bodenflächen (GroundSurface) des LoD2-Modells, je Gebäude vereinigt
   und um 0,1 m vereinfacht. Reihenfolge und Index wie web/data/buildings.json.
   Ausgabe: web/data/grundrisse.json (LGL, dl-de/by-2-0)

Abfrage der Gewerbeflächen (Overpass, gespeichert als data/raw/osm/gewerbeflaechen_overpass.json):
  [out:json][timeout:60];(way(47.80,7.66,47.86,7.78)["landuse"~"^(industrial|commercial)$"];
  relation(47.80,7.66,47.86,7.78)["landuse"~"^(industrial|commercial)$"];);out tags geom;

Koordinaten lokal wie im Viewer: x = E - e0, z = -(N - n0), auf 0,1 m gerundet.
Aufruf:  python3 -I scripts/14_drive.py
"""
from __future__ import annotations

import importlib.util
import json
import math
import sys
import zipfile
from collections import defaultdict
from pathlib import Path

from lxml import etree
from pyproj import Transformer
from shapely.geometry import LineString, Polygon, box as sbox
from shapely.ops import unary_union
from shapely.prepared import prep

sys.path.insert(0, str(Path(__file__).resolve().parent))
import common  # noqa: E402

_spec = importlib.util.spec_from_file_location("bld04", Path(__file__).resolve().parent / "04_buildings.py")
bld04 = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(bld04)

OSM_STRASSEN = common.RAW / "osm" / "strassen_overpass.json"
OSM_GEWERBE = common.RAW / "osm" / "gewerbeflaechen_overpass.json"
FAHRBAR = ["secondary", "tertiary", "tertiary_link", "unclassified", "residential", "living_street", "service", "track"]
# Fahrbahnbreite in Metern, wenn OSM keine Breite nennt. Annahme nach üblichen Querschnitten (RASt 06 grob gerundet).
BREITE = {"secondary": 7.0, "tertiary": 6.5, "tertiary_link": 5.0, "unclassified": 5.0, "residential": 5.5,
          "living_street": 4.5, "service": 3.5, "track": 3.0}
GESPERRT = {"private", "no"}
LANDFORST = {"agricultural", "forestry", "agricultural;forestry", "forestry;agricultural"}
RUND = 1  # Nachkommastellen (0,1 m)


def width_of(t: dict) -> tuple[float, bool]:
    w = t.get("width", "").replace(",", ".").replace(" m", "").strip()
    try:
        v = float(w)
        if 2.5 <= v <= 15:
            return v, True
    except ValueError:
        pass
    return BREITE[t["highway"]], False


def maxspeed_of(t: dict):
    v = t.get("maxspeed", "")
    return int(v) if v.isdigit() else None


def build_network(tr, extent, e0, n0):
    d = json.loads(OSM_STRASSEN.read_text(encoding="utf-8"))
    g = json.loads(OSM_GEWERBE.read_text(encoding="utf-8"))
    gewerbe = []
    for el in g["elements"]:
        geom = el.get("geometry")
        if el["type"] == "way" and geom and len(geom) >= 4:
            xs, ys = tr.transform([p["lon"] for p in geom], [p["lat"] for p in geom])
            gewerbe.append(Polygon(list(zip(xs, ys))).buffer(0))
        elif el["type"] == "relation":
            for m in el.get("members", []):
                if m.get("role") == "outer" and m.get("geometry") and len(m["geometry"]) >= 4:
                    xs, ys = tr.transform([p["lon"] for p in m["geometry"]], [p["lat"] for p in m["geometry"]])
                    gewerbe.append(Polygon(list(zip(xs, ys))).buffer(0))
    gew = unary_union(gewerbe) if gewerbe else Polygon()
    ext_prep = prep(extent)

    names, name_idx = [], {}
    def nid(name):
        if not name:
            return -1
        if name not in name_idx:
            name_idx[name] = len(names); names.append(name)
        return name_idx[name]

    wege, flaechen = [], []
    laenge = defaultdict(float)
    ausgeschlossen = defaultdict(float)
    breite_aus_osm = 0
    for el in d["elements"]:
        t = el.get("tags", {})
        geom = el.get("geometry") or []
        if len(geom) < 2:
            continue
        xs, ys = tr.transform([p["lon"] for p in geom], [p["lat"] for p in geom])
        pts = list(zip(xs, ys))
        sperre = {t.get(k) for k in ("access", "vehicle", "motor_vehicle")}
        if t.get("amenity") == "parking" and len(pts) >= 4 and pts[0] == pts[-1]:
            poly = Polygon(pts).buffer(0)
            if poly.is_empty or not ext_prep.contains(poly.centroid):
                continue
            if sperre & GESPERRT:
                ausgeschlossen["parkplatz_privat"] += poly.area
                continue
            if poly.intersection(gew).area > 0.5 * poly.area:
                ausgeschlossen["parkplatz_gewerbeflaeche"] += poly.area
                continue
            ring = list(poly.exterior.coords)[:-1]
            flaechen.append([round(c, RUND) for e, n in ring for c in (e - e0, -(n - n0))])
            laenge["parkplatz_m2"] += poly.area
            continue
        hw = t.get("highway")
        if hw not in FAHRBAR:
            continue
        line = LineString(pts)
        if not ext_prep.intersects(line):
            continue
        line = line.intersection(extent)
        if line.is_empty:
            continue
        L = line.length
        if sperre & GESPERRT:
            ausgeschlossen["privat_oder_gesperrt"] += L; continue
        if sperre & LANDFORST:
            ausgeschlossen["nur_land_und_forstwirtschaft"] += L; continue
        if t.get("service") == "driveway":
            ausgeschlossen["grundstueckszufahrt"] += L; continue
        if t.get("tunnel") == "building_passage":
            ausgeschlossen["durchfahrt_durch_gebaeude"] += L; continue
        if hw == "service" and line.intersection(gew).length > 0.5 * L:
            ausgeschlossen["gewerbe_oder_industrieflaeche"] += L; continue
        w, from_osm = width_of(t)
        breite_aus_osm += from_osm
        parts = list(line.geoms) if line.geom_type == "MultiLineString" else [line]
        for part in parts:
            coords = list(part.coords)
            if len(coords) < 2:
                continue
            flat = [round(c, RUND) for e, n in coords for c in (e - e0, -(n - n0))]
            wege.append([FAHRBAR.index(hw), nid(t.get("name")), round(w * 10), maxspeed_of(t) or 0] + flat)
        laenge[hw] += L
    stand = d.get("osm3s", {}).get("timestamp_osm_base")
    stand_gew = g.get("osm3s", {}).get("timestamp_osm_base")
    return wege, flaechen, names, laenge, ausgeschlossen, breite_aus_osm, stand, stand_gew


def build_footprints(e0, n0):
    bj = json.loads((common.WEB_DATA / "buildings.json").read_text(encoding="utf-8"))
    index = {g["id"]: g["i"] for g in bj["gebaeude"]}
    doc = common.load_sources()
    zips = [common.RAW / name for name, dd in doc["downloads"].items() if dd["produkt"] == "lod2"]
    NS = bld04.NS
    rings_by_building = defaultdict(list)
    for zpath in sorted(zips):
        with zipfile.ZipFile(zpath) as z:
            for name in z.namelist():
                if not name.lower().endswith(".gml"):
                    continue
                root = etree.fromstring(z.read(name))
                for b in root.iterfind(".//core:cityObjectMember/bldg:Building", NS):
                    gid = b.get("{http://www.opengis.net/gml}id")
                    if gid not in index:
                        continue
                    for gs in b.iterfind(".//bldg:GroundSurface", NS):
                        for poly in gs.iterfind(".//gml:Polygon", NS):
                            ext = poly.find("gml:exterior/gml:LinearRing", NS)
                            if ext is None:
                                continue
                            r = bld04.ring_points(ext)
                            if len(r) >= 3:
                                rings_by_building[index[gid]].append([(p[0], p[1]) for p in r])
    out, missing = [], 0
    for i in range(len(bj["gebaeude"])):
        polys = [Polygon(r).buffer(0) for r in rings_by_building.get(i, [])]
        polys = [p for p in polys if not p.is_empty and p.area > 0.5]
        if not polys:
            missing += 1
            continue
        u = unary_union(polys).simplify(0.1, preserve_topology=True)
        geoms = list(u.geoms) if u.geom_type == "MultiPolygon" else [u]
        for p in geoms:
            for ring in [p.exterior, *p.interiors]:
                c = list(ring.coords)[:-1]
                if len(c) >= 3:
                    out.append([i] + [round(v, RUND) for e, n in c for v in (e - e0, -(n - n0))])
    return out, missing, bj


def main() -> int:
    idx = json.loads((common.WEB_DATA / "terrain" / "index.json").read_text(encoding="utf-8"))
    e0, n0, T = idx["e0"], idx["n0"], idx["kachel_m"]
    tiles = [sbox(t["e_min"], t["n_min"], t["e_min"] + T, t["n_min"] + T) for t in idx["kacheln"]]
    extent = unary_union(tiles).buffer(-20)
    tr = Transformer.from_crs("EPSG:4326", f"EPSG:{common.EPSG}", always_xy=True)

    wege, flaechen, names, laenge, ausgeschlossen, breite_osm, stand, stand_gew = build_network(tr, extent, e0, n0)
    fahrnetz = {
        "ebene": "Fahrnetz für den Spielmodus „Fahren“",
        "spalten_wege": ["art", "name", "breite_dm", "tempo_kmh_osm", "x0", "z0", "x1", "z1", "…"],
        "arten": FAHRBAR, "namen": names, "wege": wege, "parkplaetze": flaechen,
        "regeln": {
            "befahrbar": FAHRBAR,
            "ausgeschlossen": ["access, vehicle oder motor_vehicle = private oder no",
                               "nur Land- und Forstwirtschaft (agricultural, forestry)",
                               "service = driveway (Grundstückszufahrt)",
                               "service-Wege überwiegend auf Gewerbe- und Industrieflächen (landuse industrial, commercial)",
                               "tunnel = building_passage",
                               "Parkplätze privat oder auf Gewerbe- und Industrieflächen"],
            "breite_standard_m": BREITE, "breite_hinweis": "Standardbreiten sind Annahmen. Die Spur im Spiel ist etwas breiter, weil OSM-Achsen 1 bis 3 m vom Luftbild abweichen.",
        },
        "kennzahlen": {
            "wege": len(wege), "namen": len(names), "parkplaetze": len(flaechen),
            "laenge_km": {k: round(v / 1000, 1) for k, v in laenge.items() if not k.endswith("m2")},
            "parkplatz_flaeche_m2": round(laenge.get("parkplatz_m2", 0)),
            "ausgeschlossen_km": {k: round(v / 1000, 2) for k, v in ausgeschlossen.items() if not k.startswith("parkplatz")},
            "ausgeschlossen_parkplatz_m2": {k: round(v) for k, v in ausgeschlossen.items() if k.startswith("parkplatz")},
            "breite_aus_osm": breite_osm,
        },
        "quelle": {
            "titel": "OpenStreetMap, Straßen und Wege (highway), Parkplätze (amenity=parking), Gewerbe- und Industrieflächen (landuse)",
            "stand_strassen": stand, "stand_gewerbeflaechen": stand_gew,
            "lizenz": "ODbL 1.0, © OpenStreetMap-Mitwirkende", "url": "https://www.openstreetmap.org/copyright",
            "verarbeitet_am": common.now_iso(),
        },
    }
    (common.WEB_DATA / "fahrnetz.json").write_text(json.dumps(fahrnetz, ensure_ascii=False, separators=(",", ":")) + "\n", encoding="utf-8")
    km = fahrnetz["kennzahlen"]
    print("Fahrnetz:", km["wege"], "Wege,", km["namen"], "Namen,", km["parkplaetze"], "Parkplätze;", km["laenge_km"], "ausgeschlossen", km["ausgeschlossen_km"])

    ringe, missing, bj = build_footprints(e0, n0)
    grund = {
        "ebene": "Gebäudegrundrisse für die Kollision im Fahrmodus",
        "format": "ringe: [gebaeude_index, x0, z0, x1, z1, …], Index wie buildings.json; mehrere Ringe je Gebäude möglich (Innenhöfe)",
        "anzahl_gebaeude": len(bj["gebaeude"]) - missing, "ohne_bodenflaeche": missing, "ringe": ringe,
        "vereinfachung_m": 0.1,
        "quelle": {"titel": bj["quelle"]["titel"] + ", Bodenflächen (GroundSurface)", "lizenz": common.LICENSE, "verarbeitet_am": common.now_iso()},
    }
    (common.WEB_DATA / "grundrisse.json").write_text(json.dumps(grund, ensure_ascii=False, separators=(",", ":")) + "\n", encoding="utf-8")
    print("Grundrisse:", len(ringe), "Ringe für", grund["anzahl_gebaeude"], "Gebäude, ohne Bodenfläche:", missing)

    doc = common.load_sources()
    doc["ebenen"]["fahrmodus"] = {"ebene": fahrnetz["ebene"], "kennzahlen": km, "osm_stand": stand, "gewerbeflaechen_stand": stand_gew,
                                  "grundrisse": {"ringe": len(ringe), "gebaeude": grund["anzahl_gebaeude"]}}
    common.save_sources(doc)
    return 0


if __name__ == "__main__":
    sys.exit(main())
