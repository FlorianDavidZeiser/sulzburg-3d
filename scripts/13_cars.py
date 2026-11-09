"""Schritt 13: Parkende Autos aus Oberflächenmodell und Luftbild erkennen (Momentaufnahme des Bildflugs).

Idee: Ein parkendes Auto ist im normalisierten Oberflächenmodell nDOM1 (Höhe über Grund, 1 m Raster, aus dem Bildflug
vom 25.08.2025) eine kleine Erhebung von etwa 1 bis 2,5 m, im Luftbild DOP20 (gleicher Bildflug) ein kompakter Fleck.

Regeln:
  1. Kandidaten: nDOM zwischen --hmin und --hmax, außerhalb der LoD2-Grundrisse (Puffer 1 m), nicht grün im Luftbild
     (Vegetationsindex), und nur auf oder an Straßen und Parkplätzen aus OpenStreetMap (Puffer, siehe STRASSEN_PUFFER).
  2. Zusammenhängende Flecken; Hauptachse per Hauptkomponentenanalyse. Ein Fleck in Autogröße ergibt ein Auto.
     Längere Flecken sind Reihen: entlang der Achse (Längsparken, ca. 5 m je Auto) oder quer (Querparken, ca. 2,6 m je Auto).
  3. Höhe aus dem nDOM (90. Perzentil), Farbe aus dem Luftbild (Median der hellsten 70 % der Pixel, um Schatten zu meiden).

Das Ergebnis ist eine automatische Erkennung mit Fehlern (verdeckte, zu dicht stehende oder fehlende Autos, gelegentlich
Anhänger oder Container). Die Stichprobe in docs/autos_stichprobe.jpg dokumentiert die Güte.

Ausgabe: web/data/cars.json
Aufruf:  python3 -I scripts/13_cars.py
"""
from __future__ import annotations

import argparse
import importlib.util
import io
import json
import math
import random
import re
import sys
import zipfile
from pathlib import Path

import numpy as np
import tifffile
from PIL import Image, ImageDraw
from pyproj import Transformer
from scipy import ndimage
from shapely.geometry import LineString, Polygon, shape
from shapely.ops import unary_union
from shapely.prepared import prep

sys.path.insert(0, str(Path(__file__).resolve().parent))
import common  # noqa: E402

_spec = importlib.util.spec_from_file_location("ortho03", Path(__file__).resolve().parent / "03_orthophoto.py")
ortho03 = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(ortho03)

SUB_RE = re.compile(r"ndom1_32_(\d{3})_(\d{4})_1_bw\.tif$", re.I)
OSM_STRASSEN = common.RAW / "osm" / "strassen_overpass.json"
# Puffer um die Straßenachse in Metern, je nach Straßenart (Fahrbahn plus Parkstreifen und Einfahrten)
STRASSEN_PUFFER = {"secondary": 9, "tertiary": 9, "tertiary_link": 7, "unclassified": 8, "residential": 9, "living_street": 8,
                   "service": 7, "pedestrian": 6}
AUTO_LAENGE, AUTO_BREITE = 4.6, 1.85


def road_mask_geom(tr, area):
    d = json.loads(OSM_STRASSEN.read_text(encoding="utf-8"))
    parts = []
    for e in d["elements"]:
        t = e.get("tags", {})
        geom = e.get("geometry") or []
        if len(geom) < 2:
            continue
        xs, ys = tr.transform([p["lon"] for p in geom], [p["lat"] for p in geom])
        pts = list(zip(xs, ys))
        if t.get("amenity") == "parking" or "parking" in t:
            if len(pts) >= 4 and pts[0] == pts[-1]:
                parts.append(Polygon(pts).buffer(3))
            else:
                parts.append(LineString(pts).buffer(6))
        elif t.get("highway") in STRASSEN_PUFFER:
            parts.append(LineString(pts).buffer(STRASSEN_PUFFER[t["highway"]]))
    u = unary_union(parts).intersection(area)
    return u, d.get("osm3s", {}).get("timestamp_osm_base")


def rasterize(geoms, ek, nk, size=1000, res=1.0):
    img = Image.new("L", (int(size / res), int(size / res)), 0)
    dr = ImageDraw.Draw(img)
    for g in geoms:
        polys = [g] if g.geom_type == "Polygon" else list(getattr(g, "geoms", []))
        for p in polys:
            if p.is_empty:
                continue
            dr.polygon([((x - ek) / res, (nk + size - y) / res) for x, y in p.exterior.coords], fill=255)
            for hole in p.interiors:
                dr.polygon([((x - ek) / res, (nk + size - y) / res) for x, y in hole.coords], fill=0)
    return np.array(img) > 0


def split_component(cells_e, cells_n):
    """Hauptachse, Länge, Breite und daraus Autos (Mittelpunkt, Richtung) für einen Fleck."""
    pts = np.column_stack([cells_e, cells_n]).astype(np.float64)
    c = pts.mean(axis=0)
    if len(pts) < 3:
        return []
    cov = np.cov((pts - c).T)
    w, v = np.linalg.eigh(cov)
    major = v[:, 1]
    minor = v[:, 0]
    pa = (pts - c) @ major
    pb = (pts - c) @ minor
    L = pa.max() - pa.min() + 1.0
    W = pb.max() - pb.min() + 1.0
    yaw_major = math.atan2(major[0], major[1])   # Winkel gegen Nord, im Uhrzeigersinn
    mid = (pa.max() + pa.min()) / 2
    cars = []
    if W < 1.2 or L > 40 or W > 7.5:
        return []
    if L <= 6.2 and W <= 3.4:                      # ein Auto, längs zur Hauptachse
        if L < 2.8:
            return []
        return [(c + major * mid, yaw_major)]
    if W <= 3.4:                                    # Reihe längs (Längsparken)
        n = max(1, round(L / 5.2))
        step = L / n
        for k in range(n):
            off = pa.min() - 0.5 + step * (k + 0.5)
            cars.append((c + major * off, yaw_major))
        return cars
    # breite Reihe: Querparken, Autos quer zur Hauptachse
    n = max(1, round(L / 2.6))
    step = L / n
    yaw_minor = math.atan2(minor[0], minor[1])
    for k in range(n):
        off = pa.min() - 0.5 + step * (k + 0.5)
        cars.append((c + major * off, yaw_minor))
    return cars


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--hmin", type=float, default=0.7)
    ap.add_argument("--hmax", type=float, default=2.8)
    ap.add_argument("--stichprobe", type=int, default=48)
    ap.add_argument("--ring-anteil", type=float, default=0.25, help="max. Anteil erhöhter Zellen im Ring um den Fleck")
    ap.add_argument("--min-helligkeit", type=float, default=55.0, help="min. mittlere Helligkeit (0-255) im Luftbild")
    ap.add_argument("--ring-gruen", type=float, default=0.4, help="max. Anteil grüner Zellen im Ring")
    ap.add_argument("--ring-gebaeude", type=float, default=0.45, help="max. Anteil Gebäudezellen im Ring")
    args = ap.parse_args()

    box = common.aoi()
    doc = common.load_sources()
    zips = sorted(common.RAW / n for n, d in doc["downloads"].items() if d["produkt"] == "ndom1")
    dop = ortho03.Dop([common.RAW / n for n, d in doc["downloads"].items() if d["produkt"] == "dop20rgb"], cache_size=4)
    gem = shape(json.loads((common.ROOT / "data" / "gemeinde.geojson").read_text(encoding="utf-8"))["features"][0]["geometry"])
    kach = json.loads((common.ROOT / "data" / "kacheln.json").read_text(encoding="utf-8"))
    area = gem.buffer(kach["rand_m"])
    tr = Transformer.from_crs("EPSG:4326", f"EPSG:{common.EPSG}", always_xy=True)
    roads, osm_stand = road_mask_geom(tr, area)
    roads_prep = prep(roads)
    ground = json.loads((common.ROOT / "data" / "processed" / "bodenpunkte.json").read_text(encoding="utf-8"))
    footprints = [Polygon(np.array(g["punkte"])[:, :2]) for g in ground if len(g["punkte"]) >= 3]
    footprints = [f.buffer(0) for f in footprints]
    fp_bounds = np.array([f.bounds for f in footprints])

    cars = []
    n_cand = 0
    for zpath in zips:
        with zipfile.ZipFile(zpath) as z:
            for name in z.namelist():
                m = SUB_RE.search(name)
                if not m:
                    continue
                ek, nk = int(m.group(1)) * 1000, int(m.group(2)) * 1000
                cell = Polygon([(ek, nk), (ek + 1000, nk), (ek + 1000, nk + 1000), (ek, nk + 1000)])
                if not cell.intersects(roads):
                    continue
                nd = tifffile.imread(io.BytesIO(z.read(name))).astype(np.float32)
                nd[nd < -1000] = np.nan
                road = rasterize([roads.intersection(cell)], ek, nk)
                if not road.any():
                    continue
                sel = np.where((fp_bounds[:, 2] >= ek - 2) & (fp_bounds[:, 0] <= ek + 1002) & (fp_bounds[:, 3] >= nk - 2) & (fp_bounds[:, 1] <= nk + 1002))[0]
                bmask = rasterize([footprints[i].buffer(1.0) for i in sel], ek, nk)
                # Luftbild auf 1 m für den Vegetationsindex, 0,2 m später für Farbe und Prüfung
                rgb = dop.region(ek, nk, ek + 1000, nk + 1000)[0].astype(np.float32)
                rgb1 = rgb.reshape(1000, 5, 1000, 5, 3).mean(axis=(1, 3))
                s = rgb1.sum(axis=2) + 1e-6
                exg = (2 * rgb1[:, :, 1] - rgb1[:, :, 0] - rgb1[:, :, 2]) / s
                veg = exg > 0.06
                cand = road & ~bmask & ~veg & (nd >= args.hmin) & (nd <= args.hmax)
                cand = ndimage.binary_opening(cand, structure=np.ones((2, 2)))
                lab, nlab = ndimage.label(cand, structure=np.ones((3, 3)))
                n_cand += nlab
                objs = ndimage.find_objects(lab)
                for li, sl in enumerate(objs, start=1):
                    rr, cc = np.where(lab[sl] == li)
                    rr = rr + sl[0].start; cc = cc + sl[1].start
                    if len(rr) < 3 or len(rr) > 220:
                        continue
                    # Freistehend: Ring von 2 m um den Fleck muss überwiegend Boden sein (keine Bäume, Hecken, Wände)
                    r0, r1 = max(0, sl[0].start - 3), min(1000, sl[0].stop + 3)
                    c0, c1 = max(0, sl[1].start - 3), min(1000, sl[1].stop + 3)
                    comp = lab[r0:r1, c0:c1] == li
                    ring = ndimage.binary_dilation(comp, iterations=2) & ~comp
                    rv = nd[r0:r1, c0:c1][ring]
                    gv = veg[r0:r1, c0:c1][ring]
                    ok = ~np.isnan(rv)
                    rv, gv = rv[ok], gv[ok]
                    # Störend sind Hohes (Bäume, Wände über 3 m) und grüne Erhebungen (Hecken); Nachbarautos zählen nicht
                    bad = (rv > 3.0) | (gv & (rv > 0.5))
                    if rv.size == 0 or bad.mean() > args.ring_anteil or (rv > 4.0).mean() > 0.05:
                        continue
                    # Umgebung: Autos stehen auf befestigter Fläche, nicht mitten im Grünen und nicht zwischen Dächern
                    if gv.mean() > args.ring_gruen or bmask[r0:r1, c0:c1][ring].mean() > args.ring_gebaeude:
                        continue
                    # Tiefer Schatten (unter Bäumen, neben Gebäuden): zu dunkel für eine verlässliche Erkennung
                    lum = rgb1[rr, cc].mean(axis=1)
                    if float(np.median(lum)) < args.min_helligkeit:
                        continue
                    e_cells = ek + cc + 0.5; n_cells = nk + 1000 - rr - 0.5
                    hgt = float(np.nanpercentile(nd[rr, cc], 90))
                    for (cxy, yaw) in split_component(e_cells, n_cells):
                        e, n = float(cxy[0]), float(cxy[1])
                        if not roads_prep.contains(Polygon.from_bounds(e - 0.1, n - 0.1, e + 0.1, n + 0.1)):
                            continue
                        # Farbe aus dem Luftbild: Fenster 1,4 x 3 m entlang der Fahrzeugachse
                        px = (e - ek) / 0.2; py = (nk + 1000 - n) / 0.2
                        sx, sy = math.sin(yaw), -math.cos(yaw)   # Achse im Bild (x nach Osten, y nach Süden)
                        samples = []
                        for a in np.linspace(-6, 6, 9):
                            for b in np.linspace(-2.5, 2.5, 5):
                                x = int(round(px + sx * a - sy * b)); y = int(round(py + sy * a + sx * b))
                                if 0 <= x < 5000 and 0 <= y < 5000:
                                    samples.append(rgb[y, x])
                        if not samples:
                            continue
                        samp = np.array(samples)
                        lum = samp.mean(axis=1)
                        keep = samp[lum >= np.percentile(lum, 30)]
                        col = np.median(keep, axis=0)
                        cars.append({"e": round(e, 2), "n": round(n, 2), "yaw": round(yaw, 3), "h": round(min(2.6, max(1.3, hgt)), 2),
                                     "rgb": [int(v) for v in col]})
                print(f"{name}: {nlab} Flecken, Autos bisher {len(cars)}")

    # Doppelte an Kachelgrenzen entfernen (näher als 1,5 m)
    cars.sort(key=lambda c: (c["e"], c["n"]))
    kept = []
    for c in cars:
        if any(abs(k["e"] - c["e"]) < 1.5 and abs(k["n"] - c["n"]) < 1.5 for k in kept[-30:]):
            continue
        kept.append(c)
    cars = kept

    # Stichprobe als Kontaktabzug für die Sichtprüfung
    rnd = random.Random(20251109)
    sample = rnd.sample(cars, min(args.stichprobe, len(cars)))
    tiles = []
    for c in sample:
        size = 12.0
        img = dop.region(round((c["e"] - size / 2) / 0.2) * 0.2, round((c["n"] - size / 2) / 0.2) * 0.2,
                         round((c["e"] + size / 2) / 0.2) * 0.2, round((c["n"] + size / 2) / 0.2) * 0.2)[0]
        im = Image.fromarray(img).convert("RGB")
        d = ImageDraw.Draw(im)
        cx, cy = im.width / 2, im.height / 2
        sx, sy = math.sin(c["yaw"]), -math.cos(c["yaw"])
        hl, hw = AUTO_LAENGE / 2 / 0.2, AUTO_BREITE / 2 / 0.2
        corners = [(cx + sx * a - sy * b, cy + sy * a + sx * b) for a, b in ((hl, hw), (hl, -hw), (-hl, -hw), (-hl, hw))]
        d.polygon(corners, outline=(255, 210, 0), width=2)
        tiles.append(im.resize((150, 150)))
    if tiles:
        cols = 8
        rows = math.ceil(len(tiles) / cols)
        sheet = Image.new("RGB", (cols * 152, rows * 152), (20, 20, 20))
        for i, t in enumerate(tiles):
            sheet.paste(t, ((i % cols) * 152, (i // cols) * 152))
        (common.ROOT / "docs").mkdir(exist_ok=True)
        sheet.save(common.ROOT / "docs" / "autos_stichprobe.jpg", quality=85)

    out = {
        "ebene": "Parkende Autos (Momentaufnahme)",
        "art": "automatisch erkannt",
        "anzahl": len(cars),
        "spalten": ["x", "z", "richtung_rad", "hoehe_m", "r", "g", "b"],
        "autos": [[round(c["e"] - box["e0"], 2), round(-(c["n"] - box["n0"]), 2), c["yaw"], c["h"], *c["rgb"]] for c in cars],
        "methode": {
            "hoehe_m": [args.hmin, args.hmax], "vegetationsindex_max": 0.06, "ring_anteil_max": args.ring_anteil, "min_helligkeit": args.min_helligkeit, "ring_gruen_max": args.ring_gruen, "ring_gebaeude_max": args.ring_gebaeude, "gebaeudepuffer_m": 1.0, "strassenpuffer_m": STRASSEN_PUFFER,
            "beschreibung": "Erhebungen im nDOM1 auf und an Straßen und Parkplätzen, ohne Gebäude und Vegetation; Reihen nach Länge in einzelne Autos geteilt; Farbe aus dem Luftbild.",
            "grenzen": "Momentaufnahme vom Bildflug, kein aktueller Zustand. Unter Bäumen und dicht an Gebäuden fehlen Autos; dicht stehende Autos werden geschätzt geteilt; Anhänger, Container oder Boote können als Auto erscheinen. Fahrzeugform ist Darstellung.",
        },
        "quelle": {
            "ndom": "LGL, nDOM1 (Oberfläche Bildflug 25.08.2025), dl-de/by-2-0",
            "luftbild": "LGL, DOP20 RGB (Bildflug 25.08.2025), dl-de/by-2-0",
            "strassen": f"OpenStreetMap über Overpass, Stand {osm_stand}, ODbL",
            "verarbeitet_am": common.now_iso(),
        },
    }
    (common.WEB_DATA / "cars.json").write_text(json.dumps(out, ensure_ascii=False, separators=(",", ":")) + "\n", encoding="utf-8")
    src = common.load_sources()
    src["ebenen"]["autos"] = {"ebene": out["ebene"], "anzahl": len(cars), "kandidaten_flecken": n_cand, "osm_strassen_stand": osm_stand}
    common.save_sources(src)
    print(f"Autos: {len(cars)} aus {n_cand} Flecken; Stichprobe docs/autos_stichprobe.jpg; cars.json {(common.WEB_DATA / 'cars.json').stat().st_size:,} B")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
