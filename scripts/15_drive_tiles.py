"""Schritt 15: Fahrkacheln für den Fahrmodus, Stufe 2 (nur im Fahrmodus geladen, jeweils rund um das Auto).

Je Kachel von 50 x 50 m entlang der befahrbaren Straßen und Parkplätze (ohne Feld- und Waldwege):
  - Gelände im 1-m-Raster aus dem DGM1 (51 x 51 Punkte an ganzzahligen UTM-Koordinaten, Mittel der vier
    umliegenden DGM-Punkte, die bei x,5 liegen)
  - Luftbild in Originalauflösung 0,2 m aus dem DOP20 (250 x 250 Pixel, JPEG)
Kachelauswahl: Straßenpuffer halbe Fahrbahnbreite plus 15 m, Parkplätze plus 10 m (Fahrnetz aus scripts/14_drive.py).
Ausgenommen sind Kacheln, die Gewerbe- oder Industrieflächen laut OSM berühren (Puffer 5 m): Betriebsgelände bleiben beim
normalen Luftbild der Karte (0,5 m), auch der Hekatron-Standort.

Ausgabe: web/data/fahrkacheln/index.json        Kachelliste je 500-m-Block (wie die Geländekacheln)
         web/data/fahrkacheln/h_<E>_<N>.bin     Höhen eines Blocks: je Kachel 51 x 51 Int16, Zentimeter,
                                                zeilenweise Differenzen (erste Spalte zur Vorzeile), Zeile 0 = Nordrand
         web/data/fahrkacheln/f_<e>_<n>.jpg     Luftbild je Kachel, Zeile 0 = Nordrand
Quelle: LGL BW, DGM1 und DOP20, dl-de/by-2-0.
Aufruf:  python3 -I scripts/15_drive_tiles.py [--quality 72]
"""
from __future__ import annotations

import argparse
import importlib.util
import io
import json
import sys
from collections import defaultdict
from pathlib import Path

import numpy as np
from PIL import Image
from shapely.geometry import LineString, Polygon, box
from shapely.ops import unary_union
from shapely.prepared import prep

sys.path.insert(0, str(Path(__file__).resolve().parent))
import common  # noqa: E402


def load_module(name: str, file: str):
    spec = importlib.util.spec_from_file_location(name, Path(__file__).resolve().parent / file)
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    return mod


T = 50       # Kachelkante in Metern
N = T + 1    # Gitterpunkte je Kante (1 m)
PX = 250     # Luftbildpixel je Kante (0,2 m)


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--quality", type=int, default=72)
    ap.add_argument("--puffer", type=float, default=15.0, help="Meter über die halbe Fahrbahnbreite hinaus")
    args = ap.parse_args()

    terrain = load_module("t02", "02_terrain.py")
    ortho = load_module("o03", "03_orthophoto.py")
    idx = json.loads((common.WEB_DATA / "terrain" / "index.json").read_text(encoding="utf-8"))
    fn = json.loads((common.WEB_DATA / "fahrnetz.json").read_text(encoding="utf-8"))
    e0, n0, KT = idx["e0"], idx["n0"], idx["kachel_m"]
    extent = unary_union([box(t["e_min"], t["n_min"], t["e_min"] + KT, t["n_min"] + KT) for t in idx["kacheln"]]).buffer(-20)

    parts = []
    for w in fn["wege"]:
        if fn["arten"][w[0]] == "track":
            continue
        pts = [(w[k] + e0, n0 - w[k + 1]) for k in range(4, len(w), 2)]
        parts.append(LineString(pts).buffer(w[2] / 20 + args.puffer))
    for f in fn["parkplaetze"]:
        parts.append(Polygon([(f[k] + e0, n0 - f[k + 1]) for k in range(0, len(f), 2)]).buffer(10))
    corridor = prep(unary_union(parts).intersection(extent))
    from pyproj import Transformer
    tr = Transformer.from_crs("EPSG:4326", f"EPSG:{common.EPSG}", always_xy=True)
    gew = []
    for el in json.loads((common.RAW / "osm" / "gewerbeflaechen_overpass.json").read_text(encoding="utf-8"))["elements"]:
        rings = [el["geometry"]] if el["type"] == "way" else [m["geometry"] for m in el.get("members", []) if m.get("role") == "outer" and m.get("geometry")]
        for g in rings:
            if g and len(g) >= 4:
                xs, ys = tr.transform([q["lon"] for q in g], [q["lat"] for q in g])
                gew.append(Polygon(list(zip(xs, ys))).buffer(0))
    gewerbe = prep(unary_union(gew).buffer(5))
    b = unary_union(parts).bounds
    tiles = [(e, n) for e in range(int(b[0]) // T * T, int(b[2]) + T, T) for n in range(int(b[1]) // T * T, int(b[3]) + T, T)
             if corridor.intersects(box(e, n, e + T, n + T))]
    n_all = len(tiles)
    tiles = [(e, n) for e, n in tiles if not gewerbe.intersects(box(e, n, e + T, n + T))]
    n_gewerbe = n_all - len(tiles)
    print(n_gewerbe, "Kacheln auf Gewerbe- und Industrieflächen ausgelassen")
    tiles.sort(key=lambda t: (t[0] // 1000, t[1] // 1000, t[0], t[1]))   # Reihenfolge nach 1-km-Teilkacheln (Cache)
    print(len(tiles), "Kacheln")

    doc = common.load_sources()
    dgm = terrain.Dgm([common.RAW / n for n, d in doc["downloads"].items() if d["produkt"] == "dgm1"])
    dop = ortho.Dop([common.RAW / n for n, d in doc["downloads"].items() if d["produkt"] == "dop20rgb"], cache_size=6)
    out_dir = common.WEB_DATA / "fahrkacheln"
    out_dir.mkdir(parents=True, exist_ok=True)
    for old in out_dir.glob("*"):
        old.unlink()

    blocks: dict[str, list] = defaultdict(list)
    block_bins: dict[str, list[bytes]] = defaultdict(list)
    skipped, jpeg_bytes = 0, 0
    for k, (e, n) in enumerate(tiles):
        g = dgm.block(e - 1, n - 1, e + T + 1, n + T + 1)        # 52 x 52 DGM-Punkte, Zeile 0 = Nordrand
        if np.isnan(g).any():
            skipped += 1
            continue
        h = 0.25 * (g[:-1, :-1] + g[:-1, 1:] + g[1:, :-1] + g[1:, 1:])   # 51 x 51 an ganzzahligen Koordinaten
        img, missing = dop.region(e, n, e + T, n + T)
        if missing > 0:
            skipped += 1
            continue
        cm = np.round(h * 100).astype(np.int64)
        zmin = int(cm.min())
        rel = cm - zmin
        d = np.empty_like(rel)
        d[:, 1:] = rel[:, 1:] - rel[:, :-1]
        d[0, 0] = rel[0, 0]
        d[1:, 0] = rel[1:, 0] - rel[:-1, 0]
        assert np.abs(d).max() < 32767
        key = f"{e // KT * KT}_{n // KT * KT}"
        blocks[key].append([e - e0, -(n + T - n0), zmin])            # lokale Nordwestecke x, z und Höhenbasis in cm
        block_bins[key].append(d.astype("<i2").tobytes())
        buf = io.BytesIO()
        Image.fromarray(img).save(buf, "JPEG", quality=args.quality, optimize=True)
        (out_dir / f"f_{e}_{n}.jpg").write_bytes(buf.getvalue())
        jpeg_bytes += buf.tell()
        if k % 200 == 0:
            print(f"{k}/{len(tiles)}  JPEG bisher {jpeg_bytes / 1e6:.1f} MB")
    for key, chunks in block_bins.items():
        (out_dir / f"h_{key}.bin").write_bytes(b"".join(chunks))

    n_tiles = sum(len(v) for v in blocks.values())
    meta = {
        "ebene": "Fahrkacheln für den Fahrmodus (Stufe 2)",
        "kachel_m": T, "gitter_m": 1, "punkte_je_kante": N, "luftbild_px": PX, "luftbild_m": 0.2,
        "format_hoehen": "je Block h_<E>_<N>.bin: Kacheln in Listenreihenfolge, je 51 x 51 Int16 (little endian), Zentimeter über zmin, "
                         "zeilenweise Differenzen, erste Spalte Differenz zur Vorzeile; Zeile 0 = Nordrand",
        "spalten": ["x_nordwest", "z_nordwest", "zmin_cm"],
        "bloecke": blocks, "anzahl": n_tiles, "uebersprungen": skipped, "ausgelassen_gewerbe": n_gewerbe,
        "auswahl": f"Straßen ohne Feld- und Waldwege, Puffer halbe Fahrbahnbreite plus {args.puffer:g} m; Parkplätze plus 10 m; "
                   "ohne Kacheln an Gewerbe- und Industrieflächen laut OSM (Puffer 5 m), dort bleibt das Luftbild der Karte",
        "quelle": {"gelaende": "DGM1 des LGL, Laserscan " + ", ".join(idx["quelle"]["aktualitaet_laserscan"]),
                   "luftbild": "DOP20 des LGL, Bildflug " + ", ".join(idx["luftbild"]["quelle"]["bildflugdatum"]),
                   "lizenz": common.LICENSE, "jpeg_qualitaet": args.quality, "verarbeitet_am": common.now_iso()},
    }
    (out_dir / "index.json").write_text(json.dumps(meta, ensure_ascii=False, separators=(",", ":")) + "\n", encoding="utf-8")
    size = sum(p.stat().st_size for p in out_dir.glob("*"))
    print(f"{n_tiles} Kacheln in {len(blocks)} Blöcken, übersprungen {skipped}, zusammen {size / 1e6:.1f} MB (JPEG {jpeg_bytes / 1e6:.1f} MB)")
    doc = common.load_sources()
    doc["ebenen"]["fahrkacheln"] = {"ebene": meta["ebene"], "anzahl": n_tiles, "bloecke": len(blocks), "uebersprungen": skipped, "ausgelassen_gewerbe": n_gewerbe,
                                    "mb": round(size / 1e6, 1), "auswahl": meta["auswahl"]}
    common.save_sources(doc)
    return 0


if __name__ == "__main__":
    sys.exit(main())
