"""Schritt 1: Rohdaten des LGL Baden-Württemberg herunterladen und protokollieren.

Quelle: Open GeoData Portal des LGL, https://opengeodata.lgl-bw.de/
Die Kachel-Dateinamen stammen aus dem 2x2-km-Gitter des Portals
(Vector-Tiles unter /tiles/vts/2x2Gitter/{z}/{x}/{y}.pbf, Attribut "metadata").
Lizenz aller Datensätze: dl-de/by-2-0, Namensnennung "Datenquelle: LGL, www.lgl-bw.de, dl-de/by-2-0".

Aufruf:  python3 -I scripts/01_download.py [--tiles 403_5298 ...] [--products dgm1 lod2 dop20rgb]
Vorhandene Dateien mit passender Größe werden nicht erneut geladen, aber neu protokolliert.
"""
from __future__ import annotations

import argparse
import hashlib
import subprocess
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
import common  # noqa: E402

BASE = "https://opengeodata.lgl-bw.de/data"

PRODUCTS = {
    "dgm1": {
        "pfad": "dgm",
        "datei": "dgm1_32_{tile}_2_bw.zip",
        "titel": "Digitales Geländemodell DGM1 (Rasterweite 1 m, Format XYZ)",
    },
    "lod2": {
        "pfad": "lod2",
        "datei": "LoD2_32_{tile}_2_bw.zip",
        "titel": "3D-Gebäudemodell LoD2 (CityGML 1.0)",
    },
    "dop20rgb": {
        "pfad": "dop20",
        "datei": "dop20rgb_32_{tile}_2_bw.zip",
        "titel": "Digitales Orthophoto DOP20 RGB (Bodenauflösung 20 cm, TIFF + TFW)",
    },
}


def sha256(path: Path) -> str:
    h = hashlib.sha256()
    with path.open("rb") as fh:
        for chunk in iter(lambda: fh.read(1 << 20), b""):
            h.update(chunk)
    return h.hexdigest()


def parse_headers(path: Path) -> dict:
    out = {}
    if not path.exists():
        return out
    for line in path.read_text(encoding="utf-8", errors="replace").splitlines():
        if ":" in line:
            k, v = line.split(":", 1)
            out[k.strip().lower()] = v.strip()
    return out


def head(url: str) -> dict:
    res = subprocess.run(["curl", "-sSI", "--max-time", "60", url], capture_output=True, text=True, check=False)
    hdr = {}
    for line in res.stdout.splitlines():
        if ":" in line:
            k, v = line.split(":", 1)
            hdr[k.strip().lower()] = v.strip()
    return hdr


def download(url: str, target: Path, headers_file: Path) -> None:
    tmp = target.with_suffix(target.suffix + ".part")
    cmd = ["curl", "-sS", "-L", "--fail", "--max-time", "3600", "-o", str(tmp), "-D", str(headers_file), url]
    subprocess.run(cmd, check=True)
    tmp.replace(target)


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--tiles", nargs="+", default=common.TILES)
    ap.add_argument("--products", nargs="+", default=list(PRODUCTS), choices=list(PRODUCTS))
    args = ap.parse_args()

    common.RAW.mkdir(parents=True, exist_ok=True)
    doc = common.load_sources()
    for tile in args.tiles:
        for prod in args.products:
            spec = PRODUCTS[prod]
            fname = spec["datei"].format(tile=tile)
            url = f"{BASE}/{spec['pfad']}/{fname}"
            target = common.RAW / fname
            headers_file = common.RAW / (Path(fname).stem + ".headers")

            remote = head(url)
            remote_len = int(remote.get("content-length", "0") or 0)
            if target.exists() and remote_len and target.stat().st_size == remote_len:
                print(f"vorhanden  {fname}  ({remote_len:,} B)")
            else:
                print(f"lade       {url}")
                download(url, target, headers_file)
                print(f"fertig     {fname}  ({target.stat().st_size:,} B)")

            local_hdr = parse_headers(headers_file)
            doc["downloads"][fname] = {
                "produkt": prod,
                "titel": spec["titel"],
                "kachel": tile,
                "url": url,
                "bytes": target.stat().st_size,
                "sha256": sha256(target),
                "server_last_modified": local_hdr.get("last-modified") or remote.get("last-modified"),
                "heruntergeladen_am": common.now_iso(),
                "lizenz": common.LICENSE["url"],
            }
    common.save_sources(doc)
    print(f"Protokoll: {common.SOURCES}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
