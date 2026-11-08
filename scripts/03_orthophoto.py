"""Schritt 3: Luftbild (DOP20 RGB des LGL) je Geländekachel zuschneiden und verkleinern.

Eingabe:  data/raw/dop20rgb_32_<tile>_2_bw.zip (1-km-Teilkacheln, TIFF 5000x5000 px, TFW), web/data/terrain/index.json
Ausgabe:  web/data/terrain/o_<id>.jpg je Geländekachel (Norden oben), Einträge in index.json

Auflösung: 0,5 m in Kacheln mit vielen Gebäuden, 1 m in übrigen Siedlungskacheln, 2 m sonst.

Aufruf:  python3 -I scripts/03_orthophoto.py [--quality 82]
"""
from __future__ import annotations

import argparse
import csv
import io
import json
import re
import sys
import zipfile
from collections import OrderedDict
from pathlib import Path

import numpy as np
import tifffile
from PIL import Image

sys.path.insert(0, str(Path(__file__).resolve().parent))
import common  # noqa: E402

SUBTILE_RE = re.compile(r"dop20rgb_32_(\d{3})_(\d{4})_1_bw_(\d{4})\.tif$", re.I)
PIXEL = 0.2


class Dop:
    def __init__(self, zips: list[Path], cache_size: int = 10):
        self.index: dict[tuple[int, int], tuple[Path, str]] = {}
        self.meta: dict[tuple[int, int], dict] = {}
        for zpath in zips:
            with zipfile.ZipFile(zpath) as z:
                names = z.namelist()
                for name in names:
                    m = SUBTILE_RE.search(name)
                    if not m:
                        continue
                    key = (int(m.group(1)) * 1000, int(m.group(2)) * 1000)
                    self.index[key] = (zpath, name)
                    csv_name = name[:-4] + ".csv"
                    if csv_name in names:
                        for row in csv.DictReader(io.StringIO(z.read(csv_name).decode("utf-8", "replace")), delimiter=";"):
                            self.meta[key] = {k: v for k, v in row.items() if k}
        self.cache: OrderedDict[tuple[int, int], np.ndarray] = OrderedDict()
        self.cache_size = cache_size
        self.used: set[tuple[int, int]] = set()

    def subtile(self, e_km: int, n_km: int) -> np.ndarray | None:
        key = (e_km, n_km)
        if key in self.cache:
            self.cache.move_to_end(key)
            return self.cache[key]
        if key not in self.index:
            return None
        zpath, name = self.index[key]
        with zipfile.ZipFile(zpath) as z:
            tfw = [float(v) for v in z.read(name[:-4] + ".tfw").decode("ascii").split()]
            assert abs(tfw[0] - PIXEL) < 1e-6 and abs(tfw[3] + PIXEL) < 1e-6, tfw
            assert abs((tfw[4] - PIXEL / 2) - e_km) < 1e-3 and abs((tfw[5] + PIXEL / 2) - (n_km + 1000)) < 1e-3, (tfw, key)
            img = tifffile.imread(io.BytesIO(z.read(name)))
        if img.ndim == 3 and img.shape[2] > 3:
            img = img[:, :, :3]
        self.cache[key] = img
        self.used.add(key)
        if len(self.cache) > self.cache_size:
            self.cache.popitem(last=False)
        return img

    def region(self, e_min: float, n_min: float, e_max: float, n_max: float) -> tuple[np.ndarray, int]:
        """Ausschnitt in Metern (Vielfache von 0,2 m) -> Bild (Zeile 0 = Nordrand), Anzahl fehlender Pixel."""
        w, h = int(round((e_max - e_min) / PIXEL)), int(round((n_max - n_min) / PIXEL))
        out = np.full((h, w, 3), 128, dtype=np.uint8)
        covered = np.zeros((h, w), dtype=bool)
        for e_km in range(int(e_min // 1000) * 1000, int(np.ceil(e_max)), 1000):
            for n_km in range(int(n_min // 1000) * 1000, int(np.ceil(n_max)), 1000):
                sub = self.subtile(e_km, n_km)
                if sub is None:
                    continue
                ce0, ce1 = max(e_min, e_km), min(e_max, e_km + 1000)
                cn0, cn1 = max(n_min, n_km), min(n_max, n_km + 1000)
                if ce1 <= ce0 or cn1 <= cn0:
                    continue
                sc0, sc1 = int(round((ce0 - e_km) / PIXEL)), int(round((ce1 - e_km) / PIXEL))
                sr0, sr1 = int(round((n_km + 1000 - cn1) / PIXEL)), int(round((n_km + 1000 - cn0) / PIXEL))
                dc0, dr0 = int(round((ce0 - e_min) / PIXEL)), int(round((n_max - cn1) / PIXEL))
                part = sub[sr0:sr1, sc0:sc1]
                out[dr0:dr0 + part.shape[0], dc0:dc0 + part.shape[1]] = part
                covered[dr0:dr0 + part.shape[0], dc0:dc0 + part.shape[1]] = True
        return out, int((~covered).sum())


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--quality", type=int, default=82)
    ap.add_argument("--viele-gebaeude", type=int, default=10, help="ab so vielen Gebäuden je Kachel 0,5 m statt 1 m")
    args = ap.parse_args()

    idx_path = common.WEB_DATA / "terrain" / "index.json"
    index = json.loads(idx_path.read_text(encoding="utf-8"))
    bld = json.loads((common.WEB_DATA / "buildings.json").read_text(encoding="utf-8"))
    be = np.array([g["e"] for g in bld["gebaeude"]]); bn = np.array([g["n"] for g in bld["gebaeude"]])

    doc = common.load_sources()
    zips = [common.RAW / name for name, d in doc["downloads"].items() if d["produkt"] == "dop20rgb"]
    if not zips:
        sys.exit("Kein DOP20-Download protokolliert. Erst scripts/01_download.py ausführen.")
    dop = Dop(zips)

    total_bytes = 0
    missing_px = 0
    # Kacheln spaltenweise sortieren, damit der Teilkachel-Cache greift
    for t in sorted(index["kacheln"], key=lambda t: (t["e_min"], t["n_min"])):
        e, n, T = t["e_min"], t["n_min"], t["size"]
        count = int(np.sum((be >= e) & (be < e + T) & (bn >= n) & (bn < n + T)))
        px_m = 0.5 if count >= args.viele_gebaeude else (1.0 if t["siedlung"] else 2.0)
        px = int(round(T / px_m))
        region, miss = dop.region(e, n, e + T, n + T)
        missing_px += miss
        img = Image.fromarray(region, "RGB").resize((px, px), Image.BOX)
        name = f"o_{t['id']}.jpg"
        out = common.WEB_DATA / "terrain" / name
        img.save(out, "JPEG", quality=args.quality, optimize=True)
        t["ortho"] = name; t["ortho_px"] = px; t["ortho_m"] = px_m; t["gebaeude"] = count; t["ortho_fehlend_px"] = miss
        total_bytes += out.stat().st_size
        print(f"{name}: {px}px ({px_m} m), {count} Gebäude, {out.stat().st_size//1024} KB")

    used_meta = [dop.meta[k] | {"teilkachel": f"{k[0]//1000}_{k[1]//1000}"} for k in sorted(dop.used) if k in dop.meta]
    bildflug = sorted({m["Aktualitaet"] for m in used_meta if m.get("Aktualitaet")})
    index["luftbild"] = {
        "ebene": "Luftbild",
        "aufloesungen_m": sorted({t["ortho_m"] for t in index["kacheln"]}),
        "jpeg_bytes": total_bytes, "pixel_ohne_inhalt": missing_px,
        "quelle": {
            "titel": "Digitales Orthophoto DOP20 RGB (TrueDOP), Landesamt für Geoinformation und Landentwicklung Baden-Württemberg (LGL)",
            "portal": common.LICENSE["portal"], "teilkacheln": [m["teilkachel"] for m in used_meta],
            "bildflugdatum": bildflug, "kamera": sorted({m.get("Kamera_Sensor", "") for m in used_meta} - {""}),
            "bodenpixel_original_m": PIXEL, "metadaten_csv": used_meta, "lizenz": common.LICENSE, "verarbeitet_am": common.now_iso(),
        },
    }
    idx_path.write_text(json.dumps(index, ensure_ascii=False, separators=(",", ":")) + "\n", encoding="utf-8")
    doc["ebenen"]["luftbild"] = {"ebene": "Luftbild", "bildflugdatum": bildflug, "aufloesungen_m": index["luftbild"]["aufloesungen_m"],
                                 "kacheln": len(index["kacheln"]), "jpeg_bytes": total_bytes, "teilkacheln": len(used_meta), "pixel_ohne_inhalt": missing_px}
    common.save_sources(doc)
    print(f"Luftbild: {len(index['kacheln'])} Kacheln, {total_bytes/1e6:.1f} MB JPEG, Bildflug {bildflug}, {missing_px} Pixel ohne Inhalt")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
