"""Schritt 11: Klima beobachtet und als Fortschreibung bis 2040 (Szenario).

Eingabe (DWD Climate Data Center, opendata.dwd.de, frei nutzbar mit Quellenangabe "Deutscher Wetterdienst"):
  - 1-km-Raster der 30-jährigen Mittel (multi_annual) für Heiße Tage (Tmax >= 30 °C), Sommertage (Tmax >= 25 °C),
    Frosttage (Tmin < 0 °C), Perioden 1961-1990 und 1991-2020, Gauß-Krüger Zone 3 (EPSG:31467)
  - Gebietsmittel Baden-Württemberg, Jahreswerte Heiße Tage, Sommertage, Tropennächte, Frosttage, Jahresmitteltemperatur
Ausgabe: web/data/climate.json (Rasterzellen im Umgriff als Vierecke in lokalen Koordinaten, Zeitreihen BW, Kennwerte Marktplatz)

Fortschreibung 2040 (Szenario, keine Klimaprojektion): Änderung zwischen den Periodenmitten 1975,5 und 2005,5 linear
bis 2040 weitergeführt, je Rasterzelle. Begrenzt auf Werte >= 0.

Aufruf:  python3 -I scripts/11_climate.py
"""
from __future__ import annotations

import gzip
import json
import sys
from pathlib import Path

import numpy as np
from pyproj import Transformer
from shapely.geometry import Polygon, shape

sys.path.insert(0, str(Path(__file__).resolve().parent))
import common  # noqa: E402

DWD = common.RAW / "dwd"
BASE = "https://opendata.dwd.de/climate_environment/CDC"
VARS = {"hot_days": "Heiße Tage (Tmax ≥ 30 °C)", "summer_days": "Sommertage (Tmax ≥ 25 °C)", "frost_days": "Frosttage (Tmin < 0 °C)"}
PERIODS = ["1961-1990", "1991-2020"]
RA = {"hot_days": "ra_hot_days_regional_averages_txbs_year.txt", "summer_days": "ra_summer_days_regional_averages_txas_year.txt",
      "tropical_nights": "ra_tropical_nights_tminGE20_regional_averages_tnes_year.txt", "frost_days": "ra_frost_days_regional_averages_tnas_year.txt",
      "air_temperature_mean": "ra_air_temperature_mean_regional_averages_tm_year.txt"}


def read_grid(path: Path):
    with gzip.open(path, "rt") as f:
        hdr = {}
        for _ in range(6):
            k, v = f.readline().split()
            hdr[k.upper()] = float(v)
        a = np.loadtxt(f)
    a[a == hdr["NODATA_VALUE"]] = np.nan
    return hdr, a


def read_regional(path: Path, column: str = "Baden-Wuerttemberg") -> list[list]:
    lines = path.read_text(encoding="latin-1").splitlines()
    header = [h.strip() for h in lines[1].split(";")]
    ci = header.index(column)
    out = []
    for ln in lines[2:]:
        parts = [p.strip() for p in ln.split(";")]
        if len(parts) > ci and parts[0].isdigit() and parts[1] == "year":
            out.append([int(parts[0]), float(parts[ci])])
    return out, lines[0].strip()


def main() -> int:
    box = common.aoi()
    gem = json.loads((common.ROOT / "data" / "gemeinde.geojson").read_text(encoding="utf-8"))
    kacheln = json.loads((common.ROOT / "data" / "kacheln.json").read_text(encoding="utf-8"))
    area = shape(gem["features"][0]["geometry"]).buffer(kacheln["rand_m"])
    gemeinde = shape(gem["features"][0]["geometry"])
    to_gk = Transformer.from_crs(f"EPSG:{common.EPSG}", "EPSG:31467", always_xy=True)
    to_utm = Transformer.from_crs("EPSG:31467", f"EPSG:{common.EPSG}", always_xy=True)

    grids = {v: {p: read_grid(DWD / f"grids_germany_multi_annual_{v}_{p}_17.asc.gz") for p in PERIODS} for v in VARS}
    hdr = grids["hot_days"]["1991-2020"][0]
    # Rasterzellen, die den Umgriff schneiden
    minx, miny, maxx, maxy = area.bounds
    xs, ys = to_gk.transform([minx, maxx, minx, maxx], [miny, miny, maxy, maxy])
    c0 = int((min(xs) - hdr["XLLCORNER"]) // 1000) - 1; c1 = int((max(xs) - hdr["XLLCORNER"]) // 1000) + 1
    r_of = lambda y: int(hdr["NROWS"] - 1 - (y - hdr["YLLCORNER"]) // 1000)  # noqa: E731
    r0 = r_of(max(ys)) - 1; r1 = r_of(min(ys)) + 1
    cells = []
    for r in range(r0, r1 + 1):
        for c in range(c0, c1 + 1):
            x0 = hdr["XLLCORNER"] + c * 1000; y0 = hdr["YLLCORNER"] + (hdr["NROWS"] - 1 - r) * 1000
            corners_gk = [(x0, y0), (x0 + 1000, y0), (x0 + 1000, y0 + 1000), (x0, y0 + 1000)]
            ce, cn = to_utm.transform([p[0] for p in corners_gk], [p[1] for p in corners_gk])
            poly = Polygon(list(zip(ce, cn)))
            if not poly.intersects(area):
                continue
            vals = {}
            for v in VARS:
                a = [float(grids[v][p][1][r, c]) for p in PERIODS]
                if any(np.isnan(a)):
                    vals = None
                    break
                trend = (a[1] - a[0]) / 30.0
                vals[v] = [round(a[0], 1), round(a[1], 1), round(max(0.0, a[1] + trend * (2040 - 2005.5)), 1)]
            if not vals:
                continue
            cells.append({"ecken": [[round(e - box["e0"], 1), round(-(n - box["n0"]), 1)] for e, n in zip(ce, cn)],
                          "anteil_gemeinde": round(poly.intersection(gemeinde).area / poly.area, 2), **vals})

    # Kennwerte am Marktplatz und für die Gemeinde (Zellen mit Anteil an der Gemeinde, flächengewichtet)
    gx, gy = to_gk.transform(box["e0"], box["n0"])
    rm, cm = r_of(gy), int((gx - hdr["XLLCORNER"]) // 1000)
    markt = {v: [float(grids[v][p][1][rm, cm]) for p in PERIODS] for v in VARS}
    for v in markt:
        a = markt[v]
        markt[v] = [a[0], a[1], round(max(0.0, a[1] + (a[1] - a[0]) / 30 * (2040 - 2005.5)), 1)]
    w = np.array([c["anteil_gemeinde"] for c in cells])
    gemeinde_mittel = {v: [round(float(np.average([c[v][k] for c in cells], weights=w)), 1) for k in range(3)] for v in VARS} if w.sum() else {}

    reihen = {}
    erstellt = None
    for key, fn in RA.items():
        series, erstellt = read_regional(DWD / fn)
        reihen[key] = series
    hd = dict(reihen["hot_days"])
    mittel = {p: round(float(np.mean([hd[y] for y in range(int(p[:4]), int(p[5:]) + 1) if y in hd])), 1) for p in ["1961-1990", "1991-2020"]}

    out = {
        "ebene": "Klima: beobachtet und Fortschreibung 2040",
        "variablen": VARS,
        "perioden": PERIODS + ["2040 (Fortschreibung)"],
        "zellen": cells,
        "marktplatz": markt,
        "gemeinde_mittel": gemeinde_mittel,
        "bw_reihen": reihen,
        "bw_periodenmittel_heisse_tage": mittel,
        "fortschreibung": "Szenario, keine Klimaprojektion: Änderung zwischen 1961-1990 und 1991-2020 (Periodenmitten 1975,5 und 2005,5) linear bis 2040 weitergeführt, je 1-km-Zelle.",
        "projektion_hinweis": {
            "text": "Klimamodelle zeigen für Baden-Württemberg ohne wirksamen Klimaschutz bis zum Ende des Jahrhunderts im Extremfall landesweit durchschnittlich 38 statt bisher etwa 5 Heiße Tage pro Jahr. Je nach Szenario steigt die Temperatur um 1,5 bis 4,5 °C gegenüber 1971 bis 2000.",
            "quellen": [
                {"titel": "LUBW, Pressemitteilung 27.04.2021 zum Bericht „Klimazukunft Baden-Württemberg – was uns ohne effektiven Klimaschutz erwartet“", "url": "https://www.lubw.baden-wuerttemberg.de/en/-/klimawandel-in-baden-wurttemberg-schreitet-schneller-voran"},
                {"titel": "LUBW-Blog 23.01.2025: Der neue Klimaatlas der LUBW", "url": "https://www.lubw.baden-wuerttemberg.de/blog/-/blogs/klima-in-baden-wurttemberg-auf-einen-blick-der-neue-klimaatlas-der-lubw"},
                {"titel": "Klimaatlas Baden-Württemberg (Projektionen je Region, interaktiv)", "url": "https://www.klimaatlas-bw.de/"},
            ],
        },
        "quelle": {
            "titel": "Deutscher Wetterdienst, Climate Data Center (CDC): multi_annual 1-km-Raster (Version v1.0) und Gebietsmittel Bundesländer",
            "urls": [f"{BASE}/grids_germany/multi_annual/", f"{BASE}/regional_averages_DE/annual/"],
            "nutzung": "DWD-Daten frei nutzbar mit Quellenangabe (Quelle: Deutscher Wetterdienst)",
            "gebietsmittel_erstellt": erstellt, "verarbeitet_am": common.now_iso(),
        },
    }
    (common.WEB_DATA / "climate.json").write_text(json.dumps(out, ensure_ascii=False, separators=(",", ":")) + "\n", encoding="utf-8")
    doc = common.load_sources()
    doc["ebenen"]["klima"] = {"ebene": out["ebene"], "zellen": len(cells), "marktplatz_heisse_tage": markt["hot_days"], "gemeinde_mittel_heisse_tage": gemeinde_mittel.get("hot_days"),
                             "bw_heisse_tage_periodenmittel": mittel, "gebietsmittel_erstellt": erstellt}
    common.save_sources(doc)
    print(f"Klima: {len(cells)} Zellen, Marktplatz Heiße Tage {markt['hot_days']}, Sommertage {markt['summer_days']}, Frosttage {markt['frost_days']}; "
          f"Gemeinde-Mittel {gemeinde_mittel.get('hot_days')}; BW Heiße Tage {mittel}; Reihe {reihen['hot_days'][0][0]}-{reihen['hot_days'][-1][0]}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
