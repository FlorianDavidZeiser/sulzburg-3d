"""Schritt 2: Gelände aus dem DGM1 des LGL als gekachelte Höhenraster für die ganze Gemeinde.

Eingabe:  data/raw/dgm1_32_<tile>_2_bw.zip (1-km-Teilkacheln als XYZ, Zellmitten bei +0,5 m)
          data/gemeinde.geojson, data/kacheln.json, web/data/buildings.json (für die Siedlungsmaske)
Ausgabe:  web/data/terrain/heights.bin  alle Kacheln hintereinander, uint16 little-endian in Dezimetern über z_min der Kachel
          web/data/terrain/index.json   Kachelliste mit Lage, Auflösung, Offsets, Quelle, Datenstand

Kacheln: 500 m x 500 m im UTM-Raster. Auflösung 5 m, wo Gebäude in der Nähe sind, sonst 20 m.
Die Höhe eines Rasterpunkts ist das Mittel der DGM1-Zellen im Umkreis der Auflösung (Boxfilter).
Rasterpunkte liegen auf den Kachelkanten, Nachbarkacheln gleicher Auflösung teilen sich die Kante.

Aufruf:  python3 -I scripts/02_terrain.py [--res-siedlung 5] [--res-sonst 20] [--kachel 500]
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
from shapely.geometry import box as sbox, shape

sys.path.insert(0, str(Path(__file__).resolve().parent))
import common  # noqa: E402

SUBTILE_RE = re.compile(r"dgm1_32_(\d{3})_(\d{4})_1_bw_(\d{4})\.xyz$", re.I)


class Dgm:
    """Zugriff auf das DGM1 über alle heruntergeladenen Kacheln, 1-km-Teilkacheln werden bei Bedarf geladen."""

    def __init__(self, zips: list[Path]):
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
        self.cache: dict[tuple[int, int], np.ndarray] = {}
        self.used: set[tuple[int, int]] = set()

    def subtile(self, e_km: int, n_km: int) -> np.ndarray | None:
        key = (e_km, n_km)
        if key in self.cache:
            return self.cache[key]
        if key not in self.index:
            return None
        zpath, name = self.index[key]
        with zipfile.ZipFile(zpath) as z:
            data = np.fromstring(z.read(name).decode("ascii"), sep=" ", dtype=np.float64).reshape(-1, 3)
        grid = np.full((1000, 1000), np.nan, dtype=np.float32)
        c = np.floor(data[:, 0] - e_km).astype(np.int64)
        r = np.floor((n_km + 1000) - data[:, 1]).astype(np.int64)
        ok = (c >= 0) & (c < 1000) & (r >= 0) & (r < 1000)
        grid[r[ok], c[ok]] = data[ok, 2]
        self.cache[key] = grid
        self.used.add(key)
        return grid

    def block(self, e_min: int, n_min: int, e_max: int, n_max: int) -> np.ndarray:
        """Ausschnitt [e_min,e_max) x [n_min,n_max) in 1-m-Zellen, Zeile 0 = Nordrand. Fehlende Teile = NaN."""
        out = np.full((n_max - n_min, e_max - e_min), np.nan, dtype=np.float32)
        for e_km in range((e_min // 1000) * 1000, e_max, 1000):
            for n_km in range((n_min // 1000) * 1000, n_max, 1000):
                sub = self.subtile(e_km, n_km)
                if sub is None:
                    continue
                ce0, ce1 = max(e_min, e_km), min(e_max, e_km + 1000)
                cn0, cn1 = max(n_min, n_km), min(n_max, n_km + 1000)
                if ce1 <= ce0 or cn1 <= cn0:
                    continue
                src = sub[(n_km + 1000 - cn1):(n_km + 1000 - cn0), (ce0 - e_km):(ce1 - e_km)]
                out[(n_max - cn1):(n_max - cn0), (ce0 - e_min):(ce1 - e_min)] = src
        return out


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--kachel", type=int, default=500)
    ap.add_argument("--res-siedlung", type=int, default=5)
    ap.add_argument("--res-sonst", type=int, default=20)
    ap.add_argument("--siedlung-puffer", type=float, default=120.0, help="Abstand zu Gebäuden in m, innerhalb dessen fein aufgelöst wird")
    args = ap.parse_args()
    T = args.kachel
    for r in (args.res_siedlung, args.res_sonst):
        if T % r:
            sys.exit(f"Kachelgröße {T} muss durch Auflösung {r} teilbar sein")

    box = common.aoi()
    gemeinde = json.loads((common.ROOT / "data" / "gemeinde.geojson").read_text(encoding="utf-8"))
    kacheln = json.loads((common.ROOT / "data" / "kacheln.json").read_text(encoding="utf-8"))
    area = shape(gemeinde["features"][0]["geometry"]).buffer(kacheln["rand_m"])
    bld = json.loads((common.WEB_DATA / "buildings.json").read_text(encoding="utf-8"))
    be = np.array([g["e"] for g in bld["gebaeude"]])
    bn = np.array([g["n"] for g in bld["gebaeude"]])

    doc = common.load_sources()
    zips = [common.RAW / name for name, d in doc["downloads"].items() if d["produkt"] == "dgm1"]
    if not zips:
        sys.exit("Kein DGM1-Download protokolliert. Erst scripts/01_download.py ausführen.")
    dgm = Dgm(zips)

    minx, miny, maxx, maxy = area.bounds
    e_start, n_start = int(minx // T) * T, int(miny // T) * T
    tiles, blobs = [], []
    offset = 0
    n_fill_total = 0
    z_all_min, z_all_max = np.inf, -np.inf
    for e in range(e_start, int(maxx) + T, T):
        for n in range(n_start, int(maxy) + T, T):
            cell = sbox(e, n, e + T, n + T)
            if not cell.intersects(area):
                continue
            p = args.siedlung_puffer
            near = np.any((be >= e - p) & (be <= e + T + p) & (bn >= n - p) & (bn <= n + T + p))
            res = args.res_siedlung if near else args.res_sonst
            nv = T // res + 1
            half = res // 2
            # Block mit halber Auflösung Rand, damit Randpunkte dasselbe Fenster bekommen wie Nachbarn
            blk = dgm.block(e - half, n - half, e + T + half + (res - 2 * half), n + T + half + (res - 2 * half))
            blk = blk[: nv * res, : nv * res]
            with np.errstate(invalid="ignore"):
                h = np.nanmean(blk.reshape(nv, res, nv, res), axis=(1, 3))
            n_nan = int(np.isnan(h).sum())
            if n_nan:
                # Lücken (außerhalb der geladenen Kacheln) mit dem nächsten gültigen Wert füllen
                valid = ~np.isnan(h)
                if not valid.any():
                    continue
                idx_r, idx_c = np.indices(h.shape)
                vr, vc = idx_r[valid], idx_c[valid]
                for r_, c_ in zip(idx_r[~valid], idx_c[~valid]):
                    k = np.argmin((vr - r_) ** 2 + (vc - c_) ** 2)
                    h[r_, c_] = h[vr[k], vc[k]]
                n_fill_total += n_nan
            z_min = float(np.floor(h.min() * 10) / 10)
            q = np.round((h - z_min) * 10).astype(np.uint16)
            blob = q.astype("<u2").tobytes()
            tiles.append({
                "id": f"{e}_{n}", "e_min": e, "n_min": n, "size": T, "res": res, "n": nv,
                "offset": offset, "bytes": len(blob), "z_min": z_min, "z_scale": 0.1,
                "z_max": round(float(h.max()), 1), "siedlung": bool(near), "gefuellt": n_nan,
                "anteil_umgriff": round(cell.intersection(area).area / cell.area, 3),
            })
            blobs.append(blob)
            offset += len(blob)
            z_all_min, z_all_max = min(z_all_min, h.min()), max(z_all_max, h.max())
    out_dir = common.WEB_DATA / "terrain"
    out_dir.mkdir(parents=True, exist_ok=True)
    (out_dir / "heights.bin").write_bytes(b"".join(blobs))

    used_meta = [dgm.meta[k] | {"teilkachel": f"{k[0]//1000}_{k[1]//1000}"} for k in sorted(dgm.used) if k in dgm.meta]
    aktualitaet = sorted({m["Aktualitaet"] for m in used_meta if m.get("Aktualitaet")})
    tri = sum(2 * (t["n"] - 1) ** 2 for t in tiles)
    index = {
        "ebene": "Gelände", "format": "uint16 LE je Kachel, Zeile 0 = Nordrand, Spalte 0 = Westrand, Höhe = z_min + wert * z_scale (m NHN), Rasterpunkte auf den Kachelkanten",
        "epsg": box["epsg"], "e0": box["e0"], "n0": box["n0"],
        "kachel_m": T, "res_siedlung_m": args.res_siedlung, "res_sonst_m": args.res_sonst, "siedlung_puffer_m": args.siedlung_puffer,
        "anzahl_kacheln": len(tiles), "anzahl_siedlung": sum(1 for t in tiles if t["siedlung"]),
        "dreiecke": tri, "z_min": round(float(z_all_min), 1), "z_max": round(float(z_all_max), 1),
        "punkte_gefuellt": n_fill_total,
        "quelle": {
            "titel": "Digitales Geländemodell DGM1, Landesamt für Geoinformation und Landentwicklung Baden-Württemberg (LGL)",
            "portal": common.LICENSE["portal"],
            "teilkacheln": [m["teilkachel"] for m in used_meta],
            "aktualitaet_laserscan": aktualitaet,
            "hoehengenauigkeit_m": sorted({m["Genauigkeit"] for m in used_meta if m.get("Genauigkeit")}),
            "hoehensystem": sorted({m.get("Koordinatenreferenzsystem_Hoehe", "") for m in used_meta} - {""}),
            "metadaten_csv": used_meta,
            "gemeindegrenze": gemeinde["quelle"]["titel"] + f", Stand {gemeinde['quelle']['aktualitaet']}, Rand {kacheln['rand_m']:.0f} m",
            "lizenz": common.LICENSE, "verarbeitet_am": common.now_iso(),
        },
        "kacheln": tiles,
    }
    (out_dir / "index.json").write_text(json.dumps(index, ensure_ascii=False, separators=(",", ":")) + "\n", encoding="utf-8")
    doc["ebenen"]["gelaende"] = {k: index[k] for k in ("ebene", "kachel_m", "res_siedlung_m", "res_sonst_m", "anzahl_kacheln", "anzahl_siedlung", "dreiecke", "z_min", "z_max", "punkte_gefuellt")}
    doc["ebenen"]["gelaende"]["aktualitaet_laserscan"] = aktualitaet
    doc["ebenen"]["gelaende"]["teilkacheln"] = len(used_meta)
    common.save_sources(doc)
    print(f"Gelände: {len(tiles)} Kacheln ({index['anzahl_siedlung']} fein), {tri:,} Dreiecke, Höhe {z_all_min:.0f} bis {z_all_max:.0f} m, "
          f"heights.bin {offset:,} B, Laserscan {aktualitaet}, {n_fill_total} Punkte gefüllt")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
