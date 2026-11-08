"""Schritt 0: Amtliche Gemeindegrenze Sulzburg und daraus die benötigten LGL-Kacheln bestimmen.

Eingabe:  data/raw/Verw-Grenzen_ALKIS.zip (LGL, Verwaltungsgrenzen ALKIS, Shape)
Ausgabe:  data/gemeinde.geojson  (Gemeindegrenze, EPSG:25832, mit Quelle und Stand)
          data/kacheln.json      (2-km-Kacheln des Open GeoData Portals, die die Gemeinde plus Rand schneiden)

Aufruf:  python3 -I scripts/00_gemeinde.py [--rand 250]
"""
from __future__ import annotations

import argparse
import io
import json
import sys
import zipfile
from pathlib import Path

import shapefile
from shapely.geometry import box, mapping, shape

sys.path.insert(0, str(Path(__file__).resolve().parent))
import common  # noqa: E402

ZIP = common.RAW / "Verw-Grenzen_ALKIS.zip"
URL = "https://opengeodata.lgl-bw.de/data/vg/Verw-Grenzen_ALKIS.zip"
GEMEINDESCHLUESSEL = 8315111  # Sulzburg, Landkreis Breisgau-Hochschwarzwald


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--rand", type=float, default=250.0, help="Pufferbreite um die Gemeindegrenze in Metern")
    args = ap.parse_args()
    if not ZIP.exists():
        sys.exit(f"{ZIP} fehlt. Download: {URL}")

    z = zipfile.ZipFile(ZIP)
    aktualitaet = z.read("Aktualitaet-Verw-Grenzen_ALKIS.txt").decode("utf-8", "replace").split(":")[-1].strip()
    base = next(n for n in z.namelist() if n.endswith("v_al_gemeinde.shp"))[:-4]
    r = shapefile.Reader(shp=io.BytesIO(z.read(base + ".shp")), dbf=io.BytesIO(z.read(base + ".dbf")), shx=io.BytesIO(z.read(base + ".shx")))
    records = list(r.iterShapeRecords())
    rec = next(sr for sr in records if sr.record["gemeinde_i"] == GEMEINDESCHLUESSEL)
    geom = shape(rec.shape.__geo_interface__)
    props = rec.record.as_dict()
    # Nachbargemeinden im Umgriff (für die Zuordnung von Gebäuden am Rand)
    umgriff = geom.buffer(args.rand + 2000)
    gemeinden = {f"0{sr.record['gemeinde_i']}": sr.record["gemeinde_n"] for sr in records
                 if shape(sr.shape.__geo_interface__).intersects(umgriff)}

    gemeinde = {
        "type": "FeatureCollection",
        "crs": {"type": "name", "properties": {"name": "urn:ogc:def:crs:EPSG::25832"}},
        "quelle": {
            "titel": "Verwaltungsgrenzen aus ALKIS, Gemeinde, Landesamt für Geoinformation und Landentwicklung Baden-Württemberg (LGL)",
            "url": URL, "aktualitaet": aktualitaet, "shape": base.split("/")[0], "lizenz": common.LICENSE,
        },
        "features": [{"type": "Feature", "properties": {k: v for k, v in props.items() if k in ("gml_id", "gemeinde_i", "gemeinde_n", "kreis_name", "region_nam", "beginn")}
                      | {"flaeche_km2": round(geom.area / 1e6, 2)}, "geometry": mapping(geom)}],
    }
    payload = json.dumps(gemeinde, ensure_ascii=False, separators=(",", ":")) + "\n"
    (common.ROOT / "data" / "gemeinde.geojson").write_text(payload, encoding="utf-8")
    common.WEB_DATA.mkdir(parents=True, exist_ok=True)
    (common.WEB_DATA / "gemeinde.geojson").write_text(payload, encoding="utf-8")  # Kopie für den Browser

    # 2-km-Kacheln des Portals: Ost-Koordinate beginnt bei ungeraden, Nord bei geraden Kilometern
    buffered = geom.buffer(args.rand)
    minx, miny, maxx, maxy = buffered.bounds
    tiles = []
    e = int(minx // 1000)
    e = e if e % 2 == 1 else e - 1
    while e * 1000 < maxx:
        n = int(miny // 1000)
        n = n if n % 2 == 0 else n - 1
        while n * 1000 < maxy:
            cell = box(e * 1000, n * 1000, (e + 2) * 1000, (n + 2) * 1000)
            if cell.intersects(buffered):
                tiles.append({"kachel": f"{e}_{n}", "e_min": e * 1000, "n_min": n * 1000, "e_max": (e + 2) * 1000, "n_max": (n + 2) * 1000,
                              "anteil_gemeinde": round(cell.intersection(geom).area / cell.area, 3)})
            n += 2
        e += 2
    kacheln = {"gemeinde": props["gemeinde_n"], "gemeindeschluessel": f"0{GEMEINDESCHLUESSEL}", "rand_m": args.rand,
               "bbox": [round(v) for v in geom.bounds], "bbox_mit_rand": [round(v) for v in buffered.bounds],
               "flaeche_km2": round(geom.area / 1e6, 2), "gemeinden_im_umgriff": gemeinden, "kacheln": tiles}
    (common.ROOT / "data" / "kacheln.json").write_text(json.dumps(kacheln, ensure_ascii=False, indent=1) + "\n", encoding="utf-8")
    print(f"Gemeinde {props['gemeinde_n']}: {geom.area/1e6:.2f} km², bbox {[round(v) for v in geom.bounds]}, Stand {aktualitaet}")
    print(f"{len(tiles)} Kacheln:", " ".join(t["kachel"] for t in tiles))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
