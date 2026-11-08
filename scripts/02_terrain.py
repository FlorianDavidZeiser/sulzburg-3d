"""Schritt 2: Gelände aus dem DGM1 des LGL für den Ausschnitt aufbereiten.

Eingabe:  data/raw/dgm1_32_<tile>_2_bw.zip (1-km-Teilkacheln als XYZ, Zellmitten bei +0,5 m)
Ausgabe:  web/data/terrain.bin  (Float32 little-endian, zeilenweise, Zeile 0 = Nordrand)
          web/data/terrain.json (Georeferenz, Statistik, Quelle, Datenstand)

Aufruf:  python3 -I scripts/02_terrain.py
"""
from __future__ import annotations

import csv
import io
import json
import re
import sys
import zipfile
from pathlib import Path

import numpy as np

sys.path.insert(0, str(Path(__file__).resolve().parent))
import common  # noqa: E402

SUBTILE_RE = re.compile(r"dgm1_32_(\d{3})_(\d{4})_1_bw_(\d{4})\.xyz$", re.I)


def main() -> int:
    box = common.aoi()
    cols = box["e_max"] - box["e_min"]
    rows = box["n_max"] - box["n_min"]
    grid = np.full((rows, cols), np.nan, dtype=np.float32)
    filled = np.zeros((rows, cols), dtype=bool)
    meta_rows = []
    used_files = []

    doc = common.load_sources()
    zips = [common.RAW / name for name, d in doc["downloads"].items() if d["produkt"] == "dgm1"]
    if not zips:
        sys.exit("Kein DGM1-Download protokolliert. Erst scripts/01_download.py ausführen.")

    for zpath in zips:
        with zipfile.ZipFile(zpath) as z:
            names = z.namelist()
            for name in names:
                m = SUBTILE_RE.search(name)
                if not m:
                    continue
                e_km, n_km = int(m.group(1)) * 1000, int(m.group(2)) * 1000
                # Überlappung der 1-km-Teilkachel mit dem Ausschnitt prüfen
                if e_km + 1000 <= box["e_min"] or e_km >= box["e_max"] or n_km + 1000 <= box["n_min"] or n_km >= box["n_max"]:
                    continue
                print(f"lese {name}")
                data = np.fromstring(z.read(name).decode("ascii"), sep=" ", dtype=np.float64).reshape(-1, 3)
                x, y, zval = data[:, 0], data[:, 1], data[:, 2]
                c = np.floor(x - box["e_min"]).astype(np.int64)
                r = np.floor(box["n_max"] - y).astype(np.int64)
                ok = (c >= 0) & (c < cols) & (r >= 0) & (r < rows)
                grid[r[ok], c[ok]] = zval[ok].astype(np.float32)
                filled[r[ok], c[ok]] = True
                used_files.append(name)
                # Metadaten-CSV der Teilkachel (Aktualität, Genauigkeit)
                csv_name = name[:-4] + ".csv"
                if csv_name in names:
                    text = z.read(csv_name).decode("utf-8", "replace")
                    for row in csv.DictReader(io.StringIO(text), delimiter=";"):
                        meta_rows.append({k: v for k, v in row.items() if k})

    n_missing = int((~filled).sum())
    if n_missing:
        print(f"WARNUNG: {n_missing} Zellen ohne Höhe (Rand außerhalb der Kacheln?)", file=sys.stderr)
    z_min, z_max = float(np.nanmin(grid)), float(np.nanmax(grid))

    common.WEB_DATA.mkdir(parents=True, exist_ok=True)
    (common.WEB_DATA / "terrain.bin").write_bytes(grid.astype("<f4").tobytes())

    aktualitaet = sorted({m["Aktualitaet"] for m in meta_rows if m.get("Aktualitaet")})
    genauigkeit = sorted({m["Genauigkeit"] for m in meta_rows if m.get("Genauigkeit")})
    terrain = {
        "ebene": "Gelände",
        "format": "Float32 LE, zeilenweise, Zeile 0 = Nordrand, Spalte 0 = Westrand, Werte = Höhe NHN (DHHN2016) an der Zellmitte",
        "epsg": box["epsg"],
        "e_min": box["e_min"], "e_max": box["e_max"], "n_min": box["n_min"], "n_max": box["n_max"],
        "e0": box["e0"], "n0": box["n0"],
        "cellsize_m": 1.0, "cols": cols, "rows": rows,
        "z_min": round(z_min, 2), "z_max": round(z_max, 2),
        "zellen_ohne_wert": n_missing,
        "quelle": {
            "titel": "Digitales Geländemodell DGM1, Landesamt für Geoinformation und Landentwicklung Baden-Württemberg (LGL)",
            "portal": common.LICENSE["portal"],
            "dateien": used_files,
            "aktualitaet_laserscan": aktualitaet,
            "hoehengenauigkeit_m": genauigkeit,
            "hoehensystem": sorted({m.get("Koordinatenreferenzsystem_Hoehe", "") for m in meta_rows} - {""}),
            "metadaten_csv": meta_rows,
            "lizenz": common.LICENSE,
            "verarbeitet_am": common.now_iso(),
        },
    }
    (common.WEB_DATA / "terrain.json").write_text(json.dumps(terrain, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")

    doc["ebenen"]["gelaende"] = {k: terrain[k] for k in ("ebene", "e_min", "e_max", "n_min", "n_max", "z_min", "z_max", "cols", "rows")}
    doc["ebenen"]["gelaende"]["aktualitaet_laserscan"] = aktualitaet
    doc["ebenen"]["gelaende"]["hoehengenauigkeit_m"] = genauigkeit
    doc["ebenen"]["gelaende"]["dateien"] = used_files
    common.save_sources(doc)
    print(f"Gelände: {cols}x{rows} Zellen, Höhe {z_min:.1f} bis {z_max:.1f} m NHN, Aktualität {aktualitaet}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
