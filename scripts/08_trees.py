"""Schritt 8: Bäume aus dem normalisierten Oberflächenmodell nDOM1 des LGL.

Das nDOM1 gibt je 1-m-Zelle die Höhe über Grund an (bildbasiertes Oberflächenmodell minus DGM). Alles, was
außerhalb von Gebäudegrundrissen höher als eine Schwelle ist, gilt als Vegetation. Je Block von --block Metern
wird die höchste Zelle als Baum übernommen (Lage der Zelle, Höhe aus dem nDOM). Betrachtet wird der Bereich bis
--umkreis Meter um Gebäude; der geschlossene Wald darüber hinaus bleibt dem Luftbild überlassen.

Die Baumform im Browser ist generisch (Stamm und Krone), nur Lage und Höhe stammen aus den Daten.

Eingabe:  data/raw/ndom1_32_<tile>_2_bw.zip (GeoTIFF float32, 1 km x 1 km), data/processed/bodenpunkte.json (Grundrisse)
Ausgabe:  web/data/trees.bin (Float32 LE: x, z lokal, Höhe je Baum), web/data/trees.json (Metadaten)

Aufruf:  python3 -I scripts/08_trees.py [--block 6] [--min-hoehe 3] [--umkreis 300]
"""
from __future__ import annotations

import argparse
import csv
import io
import json
import re
import sys
import zipfile
from pathlib import Path

import numpy as np
import tifffile
from PIL import Image, ImageDraw, ImageFilter
from shapely.geometry import shape
from shapely.prepared import prep

sys.path.insert(0, str(Path(__file__).resolve().parent))
import common  # noqa: E402

SUB_RE = re.compile(r"ndom1_32_(\d{3})_(\d{4})_1_bw\.tif$", re.I)


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--block", type=int, default=8, help="Blockgröße in Metern, ein Baum je Block")
    ap.add_argument("--min-hoehe", type=float, default=3.0)
    ap.add_argument("--max-hoehe", type=float, default=45.0, help="höhere Werte gelten als Artefakte (Masten, Fehlzuordnung)")
    ap.add_argument("--umkreis", type=float, default=250.0, help="Umkreis um Gebäude in Metern")
    ap.add_argument("--rand", type=float, default=1.5, help="Puffer um Gebäudegrundrisse in Metern")
    args = ap.parse_args()
    B = args.block

    box = common.aoi()
    doc = common.load_sources()
    zips = [common.RAW / n for n, d in doc["downloads"].items() if d["produkt"] == "ndom1"]
    if not zips:
        sys.exit("Kein nDOM1-Download protokolliert. Erst scripts/01_download.py --products ndom1 ausführen.")
    bld = json.loads((common.WEB_DATA / "buildings.json").read_text(encoding="utf-8"))
    ground = json.loads((common.ROOT / "data" / "processed" / "bodenpunkte.json").read_text(encoding="utf-8"))
    be = np.array([g["e"] for g in bld["gebaeude"]]); bn = np.array([g["n"] for g in bld["gebaeude"]])
    gemeinde = json.loads((common.ROOT / "data" / "gemeinde.geojson").read_text(encoding="utf-8"))
    kacheln = json.loads((common.ROOT / "data" / "kacheln.json").read_text(encoding="utf-8"))
    area = prep(shape(gemeinde["features"][0]["geometry"]).buffer(kacheln["rand_m"]))

    # Gebäudegrundrisse je 1-km-Teilkachel rastern (Maske, 1 = Gebäude inkl. Rand)
    footprints = [np.array(g["punkte"])[:, :2] for g in ground if g["punkte"]]
    fp_bbox = np.array([[f[:, 0].min(), f[:, 1].min(), f[:, 0].max(), f[:, 1].max()] for f in footprints])

    trees = []
    meta_rows = []
    n_cells_veg = 0
    for zpath in sorted(zips):
        with zipfile.ZipFile(zpath) as z:
            names = z.namelist()
            for name in names:
                m = SUB_RE.search(name)
                if not m:
                    continue
                ek, nk = int(m.group(1)) * 1000, int(m.group(2)) * 1000
                # Teilkachel nur, wenn Gebäude im Umkreis liegen
                near = np.any((be >= ek - args.umkreis) & (be <= ek + 1000 + args.umkreis) & (bn >= nk - args.umkreis) & (bn <= nk + 1000 + args.umkreis))
                if not near:
                    continue
                arr = tifffile.imread(io.BytesIO(z.read(name))).astype(np.float32)
                arr[arr < -1000] = np.nan
                arr[arr < 0] = 0
                csv_name = name[:-4] + ".csv"
                if csv_name in names:
                    for row in csv.DictReader(io.StringIO(z.read(csv_name).decode("utf-8", "replace")), delimiter=";"):
                        meta_rows.append({k.strip(): (v or "").strip() for k, v in row.items() if k})
                # Gebäudemaske
                mask_img = Image.new("L", (1000, 1000), 0)
                draw = ImageDraw.Draw(mask_img)
                sel = np.where((fp_bbox[:, 2] >= ek) & (fp_bbox[:, 0] <= ek + 1000) & (fp_bbox[:, 3] >= nk) & (fp_bbox[:, 1] <= nk + 1000))[0]
                for i in sel:
                    pts = [(float(x - ek), float(nk + 1000 - y)) for x, y in footprints[i]]
                    if len(pts) >= 3:
                        draw.polygon(pts, fill=255)
                mask = np.array(mask_img.filter(ImageFilter.MaxFilter(2 * int(np.ceil(args.rand)) + 1))) > 0
                # Umkreis um Gebäude (Abstandsmaske über eine grobe Rasterung der Gebäudepunkte)
                sub_b = (be >= ek - args.umkreis) & (be <= ek + 1000 + args.umkreis) & (bn >= nk - args.umkreis) & (bn <= nk + 1000 + args.umkreis)
                near_img = Image.new("L", (1000, 1000), 0)
                nd = ImageDraw.Draw(near_img)
                r = args.umkreis
                for x, y in zip(be[sub_b], bn[sub_b]):
                    cx, cy = x - ek, nk + 1000 - y
                    nd.ellipse([cx - r, cy - r, cx + r, cy + r], fill=255)
                near_mask = np.array(near_img) > 0
                veg = (~mask) & near_mask & (arr >= args.min_hoehe) & (arr <= args.max_hoehe)
                n_cells_veg += int(np.nansum(veg))
                # Blockweise die höchste Vegetationszelle
                h = np.where(veg, arr, -1.0)
                nb = 1000 // B
                hb = h[: nb * B, : nb * B].reshape(nb, B, nb, B).transpose(0, 2, 1, 3).reshape(nb, nb, B * B)
                idx = hb.argmax(axis=2)
                hmax = np.take_along_axis(hb, idx[:, :, None], axis=2)[:, :, 0]
                rows_b, cols_b = np.where(hmax >= args.min_hoehe)
                for rb, cb in zip(rows_b, cols_b):
                    k = idx[rb, cb]
                    rr, cc = rb * B + k // B, cb * B + k % B
                    e, n = ek + cc + 0.5, nk + 1000 - rr - 0.5
                    if not area.contains(shape({"type": "Point", "coordinates": (e, n)})):
                        continue
                    trees.append((e - box["e0"], -(n - box["n0"]), float(hmax[rb, cb])))
                print(f"{name}: {len(rows_b)} Bäume (Blöcke), gesamt {len(trees)}")

    arr = np.array(trees, dtype=np.float32)
    (common.WEB_DATA / "trees.bin").write_bytes(arr.astype("<f4").tobytes())
    bdom_dates = sorted({m.get("bDOM20_Aktualitaet", "") for m in meta_rows} - {""})
    dgm_dates = sorted({m.get("DGM_Aktualitaet", "") for m in meta_rows} - {""})
    info = {
        "ebene": "Bäume",
        "datei": "trees.bin", "format": "Float32 LE je Baum: x, z (lokal wie buildings.json), Höhe über Grund in m",
        "anzahl": int(len(arr)), "hoehe_min_m": float(arr[:, 2].min()) if len(arr) else None, "hoehe_max_m": float(arr[:, 2].max()) if len(arr) else None,
        "hoehe_median_m": float(np.median(arr[:, 2])) if len(arr) else None,
        "methode": {"block_m": B, "min_hoehe_m": args.min_hoehe, "max_hoehe_m": args.max_hoehe, "umkreis_um_gebaeude_m": args.umkreis, "gebaeudepuffer_m": args.rand,
                    "vegetationszellen_1m": n_cells_veg,
                    "hinweis": "Lage und Höhe aus dem nDOM1 (höchste Zelle je Block). Baumform, Kronenbreite und Farbe sind generische Darstellung, keine Daten. Außerhalb des Umkreises um Gebäude werden keine Bäume gesetzt."},
        "quelle": {"titel": "Normalisiertes Digitales Oberflächenmodell nDOM1, Landesamt für Geoinformation und Landentwicklung Baden-Württemberg (LGL)",
                   "portal": common.LICENSE["portal"], "oberflaeche_aktualitaet": bdom_dates, "dgm_aktualitaet": dgm_dates, "lizenz": common.LICENSE, "verarbeitet_am": common.now_iso()},
    }
    (common.WEB_DATA / "trees.json").write_text(json.dumps(info, ensure_ascii=False, indent=1) + "\n", encoding="utf-8")
    doc["ebenen"]["baeume"] = {k: info[k] for k in ("ebene", "anzahl", "hoehe_median_m", "hoehe_max_m")} | {"oberflaeche_aktualitaet": bdom_dates, "block_m": B}
    common.save_sources(doc)
    print(f"Bäume: {len(arr)} aus {n_cells_veg:,} Vegetationszellen, Höhe Median {np.median(arr[:,2]):.1f} m, max {arr[:,2].max():.1f} m, "
          f"Oberfläche Stand {bdom_dates}, trees.bin {len(arr)*12:,} B")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
