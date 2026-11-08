"""Schritt 6: Wann kommt die Sonne auf welches Dach? Horizont je Gebäude aus dem DGM1, Sonnenbahn je Monat.

Für jedes Gebäude wird vom höchsten Punkt (First, Grundrissmittel) aus der Geländehorizont in 2°-Schritten
bestimmt (Ray-Marching über ein 5-m-Raster aus dem DGM1, bis 6 km oder bis zum Rand der geladenen Kacheln).
Für den 21. jedes Monats wird die Sonnenbahn minutenweise berechnet (NOAA-Algorithmus wie web/sun.js) und
gezählt, wann die Sonne über dem Geländehorizont steht.

Nicht berücksichtigt: Nachbargebäude, Bäume, Gelände außerhalb der geladenen Kacheln (Berge weiter als rund
4 bis 8 km). Die Werte gelten für den First, nicht für einzelne Dachflächen.

Ausgabe: web/data/sunlight.json

Aufruf:  python3 -I scripts/06_sunlight.py [--raster 5] [--reichweite 6000]
"""
from __future__ import annotations

import argparse
import datetime as dt
import importlib.util
import json
import sys
from pathlib import Path

import numpy as np

sys.path.insert(0, str(Path(__file__).resolve().parent))
import common  # noqa: E402

_spec = importlib.util.spec_from_file_location("terrain02", Path(__file__).resolve().parent / "02_terrain.py")
terrain02 = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(terrain02)


def sun_path(day: dt.date, lat: float, lon: float) -> tuple[np.ndarray, np.ndarray]:
    """Azimut und Höhe (Grad, mit Refraktion) für jede Minute des Tages (UTC), NOAA-Algorithmus."""
    minutes = np.arange(1440, dtype=np.float64)
    jd = (dt.datetime(day.year, day.month, day.day, tzinfo=dt.timezone.utc).timestamp() / 86400 + 2440587.5) + minutes / 1440
    t = (jd - 2451545) / 36525
    l0 = (280.46646 + t * (36000.76983 + 0.0003032 * t)) % 360
    m = 357.52911 + t * (35999.05029 - 0.0001537 * t)
    e = 0.016708634 - t * (0.000042037 + 0.0000001267 * t)
    c = (np.sin(np.radians(m)) * (1.914602 - t * (0.004817 + 0.000014 * t)) + np.sin(np.radians(2 * m)) * (0.019993 - 0.000101 * t)
         + np.sin(np.radians(3 * m)) * 0.000289)
    true_long = l0 + c
    omega = 125.04 - 1934.136 * t
    lam = true_long - 0.00569 - 0.00478 * np.sin(np.radians(omega))
    eps0 = 23 + (26 + (21.448 - t * (46.815 + t * (0.00059 - t * 0.001813))) / 60) / 60
    eps = eps0 + 0.00256 * np.cos(np.radians(omega))
    decl = np.degrees(np.arcsin(np.sin(np.radians(eps)) * np.sin(np.radians(lam))))
    y = np.tan(np.radians(eps / 2)) ** 2
    eot = 4 * np.degrees(y * np.sin(2 * np.radians(l0)) - 2 * e * np.sin(np.radians(m)) + 4 * e * y * np.sin(np.radians(m)) * np.cos(2 * np.radians(l0))
                         - 0.5 * y * y * np.sin(4 * np.radians(l0)) - 1.25 * e * e * np.sin(2 * np.radians(m)))
    tst = (minutes + eot + 4 * lon + 1440) % 1440
    ha = np.where(tst / 4 < 0, tst / 4 + 180, tst / 4 - 180)
    phi, delta = np.radians(lat), np.radians(decl)
    cosz = np.sin(phi) * np.sin(delta) + np.cos(phi) * np.cos(delta) * np.cos(np.radians(ha))
    zenith = np.degrees(np.arccos(np.clip(cosz, -1, 1)))
    denom = np.cos(phi) * np.sin(np.radians(zenith))
    cosaz = np.clip((np.sin(phi) * np.cos(np.radians(zenith)) - np.sin(delta)) / np.where(np.abs(denom) < 1e-9, 1e-9, denom), -1, 1)
    az = np.where(ha > 0, (np.degrees(np.arccos(cosaz)) + 180) % 360, (540 - np.degrees(np.arccos(cosaz))) % 360)
    el = 90 - zenith
    te = np.tan(np.radians(np.clip(el, -5, 85)))
    refr = np.where(el > 5, 58.1 / te - 0.07 / te ** 3 + 0.000086 / te ** 5,
                    np.where(el > -0.575, 1735 + el * (-518.2 + el * (103.4 + el * (-12.79 + el * 0.711))), -20.772 / te)) / 3600
    refr = np.where(el <= 85, refr, 0)
    return az, el + refr


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--raster", type=int, default=5)
    ap.add_argument("--reichweite", type=int, default=6000)
    ap.add_argument("--schritt-grad", type=int, default=2)
    args = ap.parse_args()
    R = args.raster

    doc = common.load_sources()
    dgm = terrain02.Dgm([common.RAW / n for n, d in doc["downloads"].items() if d["produkt"] == "dgm1"])
    keys = sorted(dgm.index)
    e_min = min(k[0] for k in keys); e_max = max(k[0] for k in keys) + 1000
    n_min = min(k[1] for k in keys); n_max = max(k[1] for k in keys) + 1000
    print(f"DGM-Bereich E {e_min}-{e_max}, N {n_min}-{n_max}, {len(keys)} Teilkacheln -> {R}-m-Raster")
    cols, rows = (e_max - e_min) // R, (n_max - n_min) // R
    grid = np.full((rows, cols), np.nan, dtype=np.float32)
    for (ek, nk) in keys:
        sub = dgm.subtile(ek, nk)
        if sub is None:
            continue
        blk = sub.reshape(1000 // R, R, 1000 // R, R).mean(axis=(1, 3))
        r0 = (n_max - (nk + 1000)) // R; c0 = (ek - e_min) // R
        grid[r0:r0 + blk.shape[0], c0:c0 + blk.shape[1]] = blk
        dgm.cache.clear()
    print("Raster fertig, NaN-Anteil %.1f %%" % (np.isnan(grid).mean() * 100))

    bld = json.loads((common.WEB_DATA / "buildings.json").read_text(encoding="utf-8"))
    G = bld["gebaeude"]
    azs = np.arange(0, 360, args.schritt_grad, dtype=np.float64)
    # Abstände entlang des Strahls: fein in der Nähe, gröber in der Ferne
    dists = np.concatenate([np.arange(R, 600, R), np.arange(600, 2000, 4 * R), np.arange(2000, args.reichweite + 1, 8 * R)]).astype(np.float64)
    dx = np.sin(np.radians(azs))[:, None] * dists[None, :]
    dn = np.cos(np.radians(azs))[:, None] * dists[None, :]
    horizons = np.zeros((len(G), len(azs)), dtype=np.float32)
    reach = np.zeros(len(G), dtype=np.float32)
    for i, g in enumerate(G):
        z0 = g["z_first"] + 0.5
        xe = g["e"] + dx; yn = g["n"] + dn
        c = ((xe - e_min) // R).astype(np.int64); r = ((n_max - yn) // R).astype(np.int64)
        ok = (c >= 0) & (c < cols) & (r >= 0) & (r < rows)
        h = np.full(xe.shape, np.nan, dtype=np.float32)
        h[ok] = grid[r[ok], c[ok]]
        ang = np.degrees(np.arctan2(h - z0, dists[None, :]))
        horizons[i] = np.nanmax(np.where(np.isnan(ang), -90, ang), axis=1)
        valid = ok & ~np.isnan(h)
        reach[i] = float(np.where(valid, dists[None, :], 0).max())
        if i % 500 == 0:
            print(f"  Horizont {i}/{len(G)}")

    proc = common.ROOT / "data" / "processed"
    proc.mkdir(parents=True, exist_ok=True)
    np.save(proc / "horizonte.npy", horizons.astype(np.float32))  # (Gebäude, Azimutschritte), für scripts/10_solar.py
    (proc / "horizonte.json").write_text(json.dumps({"schritt_grad": args.schritt_grad, "azimut_0": "Nord, im Uhrzeigersinn", "bezug": "z_first + 0,5 m je Gebäude"}), encoding="utf-8")

    lat, lon = common.CENTER_LATLON
    days = [dt.date(2026, mth, 21) for mth in range(1, 13)]
    result = []
    possible = []
    for day in days:
        az, el = sun_path(day, lat, lon)
        up = el > 0
        possible.append(int(up.sum()))
        # Horizontwinkel in Sonnenrichtung je Gebäude und Minute (lineare Interpolation über Azimut)
        pos = az / args.schritt_grad
        i0 = np.floor(pos).astype(int) % len(azs); i1 = (i0 + 1) % len(azs); f = (pos - np.floor(pos)).astype(np.float32)
        hz = horizons[:, i0] * (1 - f) + horizons[:, i1] * f           # (Gebäude, 1440)
        lit = (el[None, :] > hz) & up[None, :]
        minutes = lit.sum(axis=1)
        first = np.where(lit.any(axis=1), lit.argmax(axis=1), -1)
        last = np.where(lit.any(axis=1), 1439 - lit[:, ::-1].argmax(axis=1), -1)
        result.append(np.stack([first, last, minutes], axis=1))
    per_building = np.stack(result, axis=1).astype(np.int32)  # (Gebäude, 12, 3)

    out = {
        "ebene": "Sonne auf dem Dach",
        "beschreibung": "Je Gebäude und Referenztag (21. jedes Monats): erste und letzte Minute (UTC) mit direkter Sonne am First sowie Anzahl Minuten. -1 = keine direkte Sonne.",
        "tage": [d.isoformat() for d in days],
        "moegliche_minuten": possible,
        "methode": {
            "horizont": f"Geländehorizont vom First (Grundrissmittel, z_first + 0,5 m) in {args.schritt_grad}°-Schritten aus dem DGM1, auf {R} m gemittelt, Reichweite bis {args.reichweite} m oder Rand der geladenen Kacheln",
            "sonnenbahn": "NOAA-Algorithmus (wie web/sun.js), Minutenauflösung, Marktplatz als Bezugspunkt, mit Refraktion",
            "nicht_beruecksichtigt": ["Nachbargebäude", "Bäume", "Gelände außerhalb der geladenen Kacheln", "Dachneigung und einzelne Dachflächen"],
            "reichweite_min_m": float(reach.min()), "reichweite_median_m": float(np.median(reach)),
        },
        "quelle": {"gelaende": "LGL DGM1 (siehe terrain/index.json)", "lizenz": common.LICENSE, "berechnet_am": common.now_iso()},
        "werte": per_building.reshape(len(G), -1).tolist(),
    }
    (common.WEB_DATA / "sunlight.json").write_text(json.dumps(out, separators=(",", ":")) + "\n", encoding="utf-8")
    dec = per_building[:, 11, 2]; jun = per_building[:, 5, 2]
    doc["ebenen"]["sonne_dach"] = {"ebene": out["ebene"], "gebaeude": len(G), "dezember_minuten_median": int(np.median(dec)), "dezember_ohne_sonne": int((dec == 0).sum()),
                                   "juni_minuten_median": int(np.median(jun)), "moegliche_minuten_dez": possible[11], "moegliche_minuten_jun": possible[5]}
    common.save_sources(doc)
    print(f"Sonne auf dem Dach: {len(G)} Gebäude. 21. Dez.: Median {np.median(dec):.0f} von {possible[11]} möglichen Minuten, {int((dec==0).sum())} Gebäude ohne direkte Sonne. "
          f"21. Juni: Median {np.median(jun):.0f} von {possible[5]}. Datei {(common.WEB_DATA / 'sunlight.json').stat().st_size:,} B")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
