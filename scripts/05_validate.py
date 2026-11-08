"""Schritt 5: Plausibilitätsprüfung der aufbereiteten Daten.

1. Gebäude gegen Gelände: Höhe der LoD2-Bodenflächen (GroundSurface) verglichen mit dem DGM1 an denselben Punkten.
2. Sonnenstand: web/sun.js (NOAA) gegen die Python-Bibliothek "astral" (unabhängige Implementierung).

Ausgabe: docs/validierung.md

Aufruf:  python3 -I scripts/05_validate.py
"""
from __future__ import annotations

import datetime as dt
import json
import subprocess
import sys
from pathlib import Path

import numpy as np

sys.path.insert(0, str(Path(__file__).resolve().parent))
import common  # noqa: E402


def sample(grid: np.ndarray, t: dict, e: float, n: float) -> float:
    """Bilineare Interpolation im DGM1-Raster (Zellmitten bei +0,5 m)."""
    fx = e - t["e_min"] - 0.5
    fz = t["n_max"] - n - 0.5
    c0 = int(min(t["cols"] - 2, max(0, np.floor(fx))))
    r0 = int(min(t["rows"] - 2, max(0, np.floor(fz))))
    dx = min(1.0, max(0.0, fx - c0))
    dz = min(1.0, max(0.0, fz - r0))
    h00, h01 = grid[r0, c0], grid[r0, c0 + 1]
    h10, h11 = grid[r0 + 1, c0], grid[r0 + 1, c0 + 1]
    return float((h00 * (1 - dx) + h01 * dx) * (1 - dz) + (h10 * (1 - dx) + h11 * dx) * dz)


def check_terrain() -> tuple[list[str], dict]:
    t = json.loads((common.WEB_DATA / "terrain.json").read_text(encoding="utf-8"))
    grid = np.frombuffer((common.WEB_DATA / "terrain.bin").read_bytes(), dtype="<f4").reshape(t["rows"], t["cols"])
    b = json.loads((common.WEB_DATA / "buildings.json").read_text(encoding="utf-8"))
    rows_md = []
    all_diffs = []
    outliers = []
    for g in b["gebaeude"]:
        pts = g["bodenpunkte"]
        if not pts:
            continue
        diffs = np.array([p[2] - sample(grid, t, p[0], p[1]) for p in pts])
        all_diffs.extend(diffs.tolist())
        med = float(np.median(diffs))
        within = float((np.abs(diffs) <= 0.5).mean() * 100)
        if abs(med) > 1.0 or within < 50:
            outliers.append((g, med, float(diffs.min()), float(diffs.max()), within))
        rows_md.append(f"| {g['i']} | {g['adresse'] or '–'} | {len(pts)} | {med:+.2f} | {diffs.min():+.2f} | {diffs.max():+.2f} | {within:.0f} % | {g['bauteile']} |")
    arr = np.array(all_diffs)
    stats = {
        "punkte": int(arr.size),
        "mittel_m": float(arr.mean()),
        "median_m": float(np.median(arr)),
        "mittlerer_betrag_m": float(np.abs(arr).mean()),
        "anteil_bis_0_5_m": float((np.abs(arr) <= 0.5).mean() * 100),
        "anteil_bis_1_0_m": float((np.abs(arr) <= 1.0).mean() * 100),
        "max_betrag_m": float(np.abs(arr).max()),
        "ausreisser": len(outliers),
    }
    md = ["## 1. Gebäude gegen Gelände", "",
          "Verglichen wird die Höhe jedes Eckpunkts der LoD2-Bodenflächen (GroundSurface) mit der bilinear interpolierten "
          "DGM1-Höhe an derselben Lage. Positive Werte: Gebäudeboden liegt über dem Gelände.", "",
          f"- Bodenpunkte geprüft: **{stats['punkte']}** an {len(rows_md)} Gebäuden",
          f"- Mittlere Abweichung: **{stats['mittel_m']:+.2f} m**, Median {stats['median_m']:+.2f} m, mittlerer Betrag {stats['mittlerer_betrag_m']:.2f} m",
          f"- Innerhalb ±0,5 m: **{stats['anteil_bis_0_5_m']:.0f} %**, innerhalb ±1,0 m: **{stats['anteil_bis_1_0_m']:.0f} %**, größter Betrag {stats['max_betrag_m']:.2f} m",
          f"- Gebäude mit Median über 1 m oder weniger als der Hälfte der Punkte innerhalb ±0,5 m: **{len(outliers)}**", ""]
    if outliers:
        md.append("Auffällige Gebäude:")
        md.append("")
        for g, med, mn, mx, within in outliers:
            md.append(f"- Nr. {g['i']}, {g['adresse'] or 'ohne Adresse'} ({g['funktion_name'] or g['funktion']}): Median {med:+.2f} m, "
                      f"Spanne {mn:+.2f} bis {mx:+.2f} m, {within:.0f} % innerhalb ±0,5 m, Bauteile: {g['bauteile']}")
        md.append("")
    md += ["Einordnung: Das LoD2-Modell wurde vom LGL aus Grundrissen, Laserscan und dem jeweils aktuellen DGM1 abgeleitet. "
           "Das hier genutzte DGM1 stammt vom Laserscan 2019; bei Bauteilen, die auf anderen Bauteilen sitzen (z. B. Türme, "
           "Dachaufbauten), liegt die Bodenfläche des Bauteils bewusst über dem Gelände. Große Spannen innerhalb eines Gebäudes "
           "sind daher nicht automatisch Fehler.", "",
           "| Nr. | Adresse | Punkte | Median | Min | Max | ±0,5 m | Bauteile |", "|---|---|---|---|---|---|---|---|"]
    md += rows_md
    return md, stats


def check_sun() -> tuple[list[str], dict]:
    from astral import Observer
    from astral import sun as asun

    e, n = common.center_utm()
    lat, lon = common.CENTER_LATLON
    dates = ["2026-03-20", "2026-06-21", "2026-09-22", "2026-12-21", dt.date.today().isoformat()]
    times = ["06:00", "09:00", "12:00", "15:00", "18:00"]
    js = f"""
import {{ sunPosition, sunTimes }} from 'file://{common.ROOT / 'web' / 'sun.js'}';
const lat={lat}, lon={lon};
const out={{times:{{}},pos:{{}}}};
for (const d of {json.dumps(dates)}) {{
  const day=new Date(d+'T00:00:00Z');
  const t=sunTimes(day,lat,lon);
  out.times[d]={{sunrise:t.sunrise?.toISOString(), sunset:t.sunset?.toISOString()}};
  for (const hm of {json.dumps(times)}) {{
    const when=new Date(d+'T'+hm+':00Z');
    const p=sunPosition(when,lat,lon);
    out.pos[d+'T'+hm]={{az:p.azimuth, el:p.elevation}};
  }}
}}
console.log(JSON.stringify(out));
"""
    res = subprocess.run(["node", "--input-type=module", "-e", js], capture_output=True, text=True, check=True)
    js_out = json.loads(res.stdout)
    obs = Observer(latitude=lat, longitude=lon, elevation=0)
    md = ["## 2. Sonnenstand gegen unabhängige Referenz", "",
          "Die eigene Berechnung in `web/sun.js` (NOAA-Algorithmus) wird mit der Python-Bibliothek `astral` verglichen "
          f"(Standort {lat:.5f}° N, {lon:.5f}° O, Zeiten in UTC).", "",
          "| Datum | Aufgang sun.js | Aufgang astral | Diff | Untergang sun.js | Untergang astral | Diff |", "|---|---|---|---|---|---|---|"]
    max_time_diff = 0.0
    for d in dates:
        day = dt.date.fromisoformat(d)
        ref = asun.sun(obs, date=day, tzinfo=dt.timezone.utc)
        row = [d]
        for key in ("sunrise", "sunset"):
            mine = dt.datetime.fromisoformat(js_out["times"][d][key].replace("Z", "+00:00"))
            diff = (mine - ref[key]).total_seconds() / 60
            max_time_diff = max(max_time_diff, abs(diff))
            row += [mine.strftime("%H:%M:%S"), ref[key].strftime("%H:%M:%S"), f"{diff:+.1f} min"]
        md.append("| " + " | ".join(row) + " |")
    md += ["", "| Zeitpunkt (UTC) | Azimut sun.js | Azimut astral | Höhe sun.js | Höhe astral |", "|---|---|---|---|---|"]
    max_az, max_el = 0.0, 0.0
    for key, p in js_out["pos"].items():
        when = dt.datetime.fromisoformat(key + ":00+00:00")
        az_ref = asun.azimuth(obs, when)
        el_ref = asun.elevation(obs, when)
        if el_ref < -5:
            continue  # Nachtwerte sind nicht sinnvoll vergleichbar
        max_az = max(max_az, abs(((p["az"] - az_ref + 180) % 360) - 180))
        max_el = max(max_el, abs(p["el"] - el_ref))
        md.append(f"| {key} | {p['az']:.2f}° | {az_ref:.2f}° | {p['el']:.2f}° | {el_ref:.2f}° |")
    stats = {"max_zeitdifferenz_min": max_time_diff, "max_azimut_diff_grad": max_az, "max_hoehe_diff_grad": max_el}
    md += ["", f"Größte Abweichung: Auf-/Untergang **{max_time_diff:.1f} min**, Azimut **{max_az:.2f}°**, Höhe **{max_el:.2f}°**."]
    return md, stats


def main() -> int:
    t_md, t_stats = check_terrain()
    s_md, s_stats = check_sun()
    doc = ["# Validierung Phase 0 (automatisch erzeugt)", "",
           f"Erzeugt am {common.now_iso()} durch `scripts/05_validate.py`.", ""] + t_md + [""] + s_md + [""]
    (common.ROOT / "docs" / "validierung.md").write_text("\n".join(doc), encoding="utf-8")
    src = common.load_sources()
    src["validierung"] = {"gelaende_gebaeude": t_stats, "sonnenstand": s_stats, "datei": "docs/validierung.md"}
    common.save_sources(src)
    print(json.dumps({"gelaende_gebaeude": t_stats, "sonnenstand": s_stats}, indent=1, ensure_ascii=False))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
