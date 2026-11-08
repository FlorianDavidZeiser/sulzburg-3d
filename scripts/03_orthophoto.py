"""Schritt 3: Luftbild (DOP20 RGB des LGL) auf den Ausschnitt zuschneiden.

Eingabe:  data/raw/dop20rgb_32_<tile>_2_bw.zip (1-km-Teilkacheln, TIFF 5000x5000 px + TFW-Weltdatei)
Ausgabe:  web/data/ortho.jpg  (Ausschnitt in voller Auflösung 20 cm, Norden oben)
          web/data/ortho.json (Georeferenz, Bildflugdatum, Quelle)

Aufruf:  python3 -I scripts/03_orthophoto.py [--quality 88]
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
from PIL import Image

sys.path.insert(0, str(Path(__file__).resolve().parent))
import common  # noqa: E402

SUBTILE_RE = re.compile(r"dop20rgb_32_(\d{3})_(\d{4})_1_bw_(\d{4})\.tif$", re.I)
PIXEL = 0.2


def read_tfw(text: str) -> tuple[float, float, float, float]:
    vals = [float(v) for v in text.split()]
    px_x, _, _, px_y, x_center, y_center = vals
    return px_x, px_y, x_center, y_center


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--quality", type=int, default=88)
    args = ap.parse_args()

    box = common.aoi()
    width = int(round((box["e_max"] - box["e_min"]) / PIXEL))
    height = int(round((box["n_max"] - box["n_min"]) / PIXEL))
    canvas = np.zeros((height, width, 3), dtype=np.uint8)
    covered = np.zeros((height, width), dtype=bool)
    meta_rows, used = [], []

    doc = common.load_sources()
    zips = [common.RAW / name for name, d in doc["downloads"].items() if d["produkt"] == "dop20rgb"]
    if not zips:
        sys.exit("Kein DOP20-Download protokolliert. Erst scripts/01_download.py ausführen.")

    for zpath in zips:
        with zipfile.ZipFile(zpath) as z:
            names = z.namelist()
            for name in names:
                m = SUBTILE_RE.search(name)
                if not m:
                    continue
                e_km, n_km = int(m.group(1)) * 1000, int(m.group(2)) * 1000
                if e_km + 1000 <= box["e_min"] or e_km >= box["e_max"] or n_km + 1000 <= box["n_min"] or n_km >= box["n_max"]:
                    continue
                tfw = read_tfw(z.read(name[:-4] + ".tfw").decode("ascii"))
                px_x, px_y, x_c, y_c = tfw
                assert abs(px_x - PIXEL) < 1e-6 and abs(px_y + PIXEL) < 1e-6, tfw
                # Obere linke Ecke des Bildes (TFW gibt die Pixelmitte an)
                x_ul = x_c - px_x / 2
                y_ul = y_c - px_y / 2
                print(f"lese {name}")
                img = tifffile.imread(io.BytesIO(z.read(name)))
                if img.ndim == 3 and img.shape[2] > 3:
                    img = img[:, :, :3]
                h, w = img.shape[:2]
                # Ziel-Pixelfenster des Ausschnitts in diesem Bild
                col0 = int(round((box["e_min"] - x_ul) / PIXEL))
                row0 = int(round((y_ul - box["n_max"]) / PIXEL))
                src_c0, src_r0 = max(col0, 0), max(row0, 0)
                src_c1, src_r1 = min(col0 + width, w), min(row0 + height, h)
                if src_c1 <= src_c0 or src_r1 <= src_r0:
                    continue
                dst_c0, dst_r0 = src_c0 - col0, src_r0 - row0
                part = img[src_r0:src_r1, src_c0:src_c1]
                canvas[dst_r0:dst_r0 + part.shape[0], dst_c0:dst_c0 + part.shape[1]] = part
                covered[dst_r0:dst_r0 + part.shape[0], dst_c0:dst_c0 + part.shape[1]] = True
                used.append(name)
                csv_name = name[:-4] + ".csv"
                if csv_name in names:
                    for row in csv.DictReader(io.StringIO(z.read(csv_name).decode("utf-8", "replace")), delimiter=";"):
                        meta_rows.append({k: v for k, v in row.items() if k})

    n_missing = int((~covered).sum())
    if n_missing:
        print(f"WARNUNG: {n_missing} Pixel ohne Bildinhalt", file=sys.stderr)

    common.WEB_DATA.mkdir(parents=True, exist_ok=True)
    out = common.WEB_DATA / "ortho.jpg"
    Image.fromarray(canvas, "RGB").save(out, "JPEG", quality=args.quality, optimize=True, progressive=True)

    bildflug = sorted({m["Aktualitaet"] for m in meta_rows if m.get("Aktualitaet")})
    kamera = sorted({m.get("Kamera_Sensor", "") for m in meta_rows} - {""})
    ortho = {
        "ebene": "Luftbild",
        "datei": "ortho.jpg",
        "epsg": box["epsg"],
        "e_min": box["e_min"], "e_max": box["e_max"], "n_min": box["n_min"], "n_max": box["n_max"],
        "pixel_m": PIXEL, "width_px": width, "height_px": height,
        "pixel_ohne_inhalt": n_missing,
        "quelle": {
            "titel": "Digitales Orthophoto DOP20 RGB (TrueDOP), Landesamt für Geoinformation und Landentwicklung Baden-Württemberg (LGL)",
            "portal": common.LICENSE["portal"],
            "dateien": used,
            "bildflugdatum": bildflug,
            "kamera": kamera,
            "metadaten_csv": meta_rows,
            "lizenz": common.LICENSE,
            "verarbeitet_am": common.now_iso(),
        },
    }
    (common.WEB_DATA / "ortho.json").write_text(json.dumps(ortho, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    doc["ebenen"]["luftbild"] = {"ebene": "Luftbild", "bildflugdatum": bildflug, "kamera": kamera, "pixel_m": PIXEL,
                                 "width_px": width, "height_px": height, "dateien": used, "jpeg_bytes": out.stat().st_size}
    common.save_sources(doc)
    print(f"Luftbild: {width}x{height} px, Bildflug {bildflug}, {out.stat().st_size:,} B -> {out}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
