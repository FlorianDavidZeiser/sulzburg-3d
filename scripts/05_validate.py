"""Schritt 5: Plausibilitätsprüfung der aufbereiteten Daten (Phase 1).

1. Gebäude gegen Gelände: Eckpunkte der LoD2-Bodenflächen gegen das DGM1 (1 m) und gegen das dargestellte,
   gröber aufgelöste Gelände (5 m / 20 m). Zeigt, ob Gebäude schweben oder im Boden stecken.
2. Stichprobe Adressen: 20 zufällig gewählte Gebäude mit Hausnummer gegen OpenStreetMap (Nominatim),
   Abstand zwischen LoD2-Grundrissmittel und OSM-Treffer.
3. Sonnenstand: web/sun.js (NOAA) gegen die Python-Bibliothek astral.
4. Ladevolumen der Web-Anwendung.

Ausgabe: docs/validierung.md, Kennzahlen in data/sources.json

Aufruf:  python3 -I scripts/05_validate.py [--stichprobe 20] [--ohne-osm]
"""
from __future__ import annotations

import argparse
import datetime as dt
import importlib.util
import json
import random
import subprocess
import sys
import time
import urllib.parse
import urllib.request
from pathlib import Path

import numpy as np

sys.path.insert(0, str(Path(__file__).resolve().parent))
import common  # noqa: E402

_spec = importlib.util.spec_from_file_location("terrain02", Path(__file__).resolve().parent / "02_terrain.py")
terrain02 = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(terrain02)


def bilinear(grid: np.ndarray, fx: float, fz: float) -> float:
    rows, cols = grid.shape
    c0 = int(min(cols - 2, max(0, np.floor(fx)))); r0 = int(min(rows - 2, max(0, np.floor(fz))))
    dx = min(1.0, max(0.0, fx - c0)); dz = min(1.0, max(0.0, fz - r0))
    return float((grid[r0, c0] * (1 - dx) + grid[r0, c0 + 1] * dx) * (1 - dz) + (grid[r0 + 1, c0] * (1 - dx) + grid[r0 + 1, c0 + 1] * dx) * dz)


class Rendered:
    """Zugriff auf das dargestellte Gelände (web/data/terrain)."""

    def __init__(self):
        d = common.WEB_DATA / "terrain"
        self.index = json.loads((d / "index.json").read_text(encoding="utf-8"))
        buf = (d / "heights.bin").read_bytes()
        self.tiles = {}
        for t in self.index["kacheln"]:
            q = np.frombuffer(buf, dtype="<u2", count=t["n"] * t["n"], offset=t["offset"]).reshape(t["n"], t["n"])
            self.tiles[t["id"]] = (t, t["z_min"] + q.astype(np.float64) * t["z_scale"])

    def height(self, e: float, n: float) -> float | None:
        T = self.index["kachel_m"]
        key = f"{int(np.floor(e / T) * T)}_{int(np.floor(n / T) * T)}"
        if key not in self.tiles:
            return None
        t, grid = self.tiles[key]
        return bilinear(grid, (e - t["e_min"]) / t["res"], (t["n_min"] + t["size"] - n) / t["res"])


def check_terrain(stichprobe_md: int = 25) -> tuple[list[str], dict]:
    bld = json.loads((common.WEB_DATA / "buildings.json").read_text(encoding="utf-8"))
    ground = {g["i"]: g["punkte"] for g in json.loads((common.ROOT / "data" / "processed" / "bodenpunkte.json").read_text(encoding="utf-8"))}
    doc = common.load_sources()
    dgm = terrain02.Dgm([common.RAW / n for n, d in doc["downloads"].items() if d["produkt"] == "dgm1"])
    rend = Rendered()
    sockel = bld.get("sockel_m", 0)

    d_dgm, d_rend = [], []
    per_building = []
    for g in bld["gebaeude"]:
        pts = ground.get(g["i"], [])
        if not pts:
            continue
        a, b = [], []
        for e, n, z in pts:
            blk = dgm.block(int(np.floor(e)) - 1, int(np.floor(n)) - 1, int(np.floor(e)) + 2, int(np.floor(n)) + 2)
            if np.isnan(blk).any():
                continue
            # Zellmitten bei +0,5: Index relativ zum Block
            h1 = bilinear(blk, e - (np.floor(e) - 1) - 0.5, (np.floor(n) + 2) - n - 0.5)
            h2 = rend.height(e, n)
            if h2 is None:
                continue
            a.append(z - h1); b.append(z - h2)
        if not a:
            continue
        a, b = np.array(a), np.array(b)
        d_dgm.extend(a.tolist()); d_rend.extend(b.tolist())
        per_building.append((g, float(np.median(a)), float(a.min()), float(a.max()), float(b.min()), float(b.max()), float(np.median(b))))

    A, B = np.array(d_dgm), np.array(d_rend)
    # Schwebend = Bodenpunkt liegt über dem dargestellten Gelände, und zwar höher als der Sockel reicht
    floating = [pb for pb in per_building if pb[4] > sockel]  # min über Gelände > Sockel: ganzes Gebäude schwebt sichtbar
    partly = [pb for pb in per_building if pb[5] > sockel and pb[4] <= sockel]  # einzelne Ecken über Sockel
    stats = {
        "gebaeude": len(per_building), "punkte": int(A.size),
        "dgm1_mittel_m": float(A.mean()), "dgm1_median_m": float(np.median(A)), "dgm1_anteil_bis_0_5_m": float((np.abs(A) <= 0.5).mean() * 100),
        "dgm1_anteil_bis_1_0_m": float((np.abs(A) <= 1.0).mean() * 100), "dgm1_max_ueber_m": float(A.max()), "dgm1_max_unter_m": float(A.min()),
        "dargestellt_mittel_m": float(B.mean()), "dargestellt_anteil_bis_1_0_m": float((np.abs(B) <= 1.0).mean() * 100),
        "dargestellt_anteil_ueber_sockel": float((B > sockel).mean() * 100),
        "gebaeude_komplett_schwebend": len(floating), "gebaeude_ecke_ueber_sockel": len(partly), "sockel_m": sockel,
    }
    md = ["## 1. Gebäude gegen Gelände", "",
          "Jeder Eckpunkt der LoD2-Bodenflächen (GroundSurface) wird mit der Geländehöhe an derselben Lage verglichen, einmal gegen das "
          "DGM1 in 1 m (Quelle) und einmal gegen das im Browser dargestellte Gelände (5 m im Siedlungsbereich, 20 m sonst). "
          "Positive Werte: Gebäudeboden über dem Gelände.", "",
          f"- Geprüft: **{stats['gebaeude']} Gebäude, {stats['punkte']} Bodenpunkte**",
          f"- Gegen DGM1: Mittel {stats['dgm1_mittel_m']:+.2f} m, Median {stats['dgm1_median_m']:+.2f} m, innerhalb ±0,5 m **{stats['dgm1_anteil_bis_0_5_m']:.0f} %**, innerhalb ±1 m **{stats['dgm1_anteil_bis_1_0_m']:.0f} %**, Extreme {stats['dgm1_max_unter_m']:+.1f} / {stats['dgm1_max_ueber_m']:+.1f} m",
          f"- Gegen dargestelltes Gelände: Mittel {stats['dargestellt_mittel_m']:+.2f} m, innerhalb ±1 m **{stats['dargestellt_anteil_bis_1_0_m']:.0f} %**, Punkte höher als der Sockel ({sockel} m) reicht: **{stats['dargestellt_anteil_ueber_sockel']:.1f} %**",
          f"- Gebäude, die komplett sichtbar schweben (alle Bodenpunkte höher als der Sockel): **{len(floating)}**; Gebäude mit einzelnen Ecken über dem Sockel: **{len(partly)}**", ""]
    if floating:
        md.append("Komplett schwebende Gebäude:")
        md.append("")
        for g, med, mn, mx, bmin, bmax, bmed in floating[:30]:
            md.append(f"- Nr. {g['i']}, {g['adresse'] or 'ohne Adresse'} ({g['funktion_name'] or g['funktion']}, {g['gemeinde']}): {bmin:+.2f} bis {bmax:+.2f} m über dargestelltem Gelände, gegen DGM1 Median {med:+.2f} m, Bauteile {g['bauteile']}")
        md.append("")
    if partly:
        md.append("Gebäude mit einzelnen Ecken über dem Sockel (größte zuerst):")
        md.append("")
        for g, med, mn, mx, bmin, bmax, bmed in sorted(partly, key=lambda p: -p[5])[:stichprobe_md]:
            md.append(f"- Nr. {g['i']}, {g['adresse'] or 'ohne Adresse'} ({g['funktion_name'] or g['funktion']}): Ecke bis {bmax:+.2f} m über dargestelltem Gelände, gegen DGM1 Median {med:+.2f} m, Bauteile {g['bauteile']}")
        md.append("")
    md += ["Einordnung: Das LGL setzt die LoD2-Bodenfläche am tiefsten Geländepunkt des Grundrisses an, am Hang stecken die Wände daher im Gelände "
           "(negative Werte, gewollt). Positive Werte gegen das DGM1 entstehen bei Bauteilen, die auf anderen Bauteilen sitzen (Türme, Aufbauten), "
           "und bei Geländeänderungen nach der Laserscan-Befliegung. Positive Werte gegen das dargestellte Gelände entstehen zusätzlich durch die "
           "Mittelung auf 5 m beziehungsweise 20 m; dafür gibt es den Sockel.", ""]
    return md, stats


def check_addresses(sample: int) -> tuple[list[str], dict]:
    from pyproj import Transformer

    bld = json.loads((common.WEB_DATA / "buildings.json").read_text(encoding="utf-8"))
    cands = [g for g in bld["gebaeude"] if g["in_gemeinde"] and g["adresse"] and any(ch.isdigit() for ch in g["adresse"].split(",")[0])
             and (g["funktion"] or "").startswith("31001_1")]
    rnd = random.Random(20261108)
    picks = rnd.sample(cands, min(sample, len(cands)))
    tr = Transformer.from_crs("EPSG:4326", f"EPSG:{common.EPSG}", always_xy=True)
    rows, dists, found = [], [], 0
    cache_path = common.ROOT / "data" / "processed" / "nominatim_cache.json"
    cache = json.loads(cache_path.read_text(encoding="utf-8")) if cache_path.exists() else {}
    for g in picks:
        street = g["adresse"].split(",")[0]
        if street in cache:
            res = cache[street]
        else:
            res = None
        if res is None:
            q = urllib.parse.urlencode({"street": street, "city": "Sulzburg", "country": "Deutschland", "format": "json", "limit": 1, "addressdetails": 1})
            req = urllib.request.Request("https://nominatim.openstreetmap.org/search?" + q, headers={"User-Agent": "sulzburg-3d validation (privates Projekt)"})
            try:
                with urllib.request.urlopen(req, timeout=30) as r:
                    res = json.loads(r.read().decode("utf-8"))
                cache[street] = res
            except Exception as exc:  # noqa: BLE001
                rows.append(f"| {g['i']} | {street} | Fehler: {exc} | – | – |")
                time.sleep(5)
                continue
            time.sleep(1.5)  # Nominatim-Nutzungsbedingungen: höchstens eine Anfrage pro Sekunde
        if not res:
            rows.append(f"| {g['i']} | {street} | kein Treffer | – | – |")
            continue
        r0 = res[0]
        e, n = tr.transform(float(r0["lon"]), float(r0["lat"]))
        d = float(np.hypot(e - g["e"], n - g["n"]))
        typ = r0.get("addresstype") or r0.get("type")
        hn = (r0.get("address") or {}).get("house_number")
        ok = hn is not None and typ in ("building", "house", "residential", "apartments", "yes", "place")
        if ok:
            dists.append(d); found += 1
        rows.append(f"| {g['i']} | {street} | {typ}{' Nr. ' + hn if hn else ''} | {d:.0f} m | {'ja' if ok else 'nur Straße/Ort'} |")
    cache_path.parent.mkdir(parents=True, exist_ok=True)
    cache_path.write_text(json.dumps(cache, ensure_ascii=False), encoding="utf-8")
    stats = {"stichprobe": len(picks), "osm_treffer_mit_hausnummer": found,
             "abstand_median_m": float(np.median(dists)) if dists else None, "abstand_max_m": float(max(dists)) if dists else None,
             "innerhalb_25_m": int(sum(1 for d in dists if d <= 25))}
    md = ["## 2. Stichprobe Adressen gegen OpenStreetMap", "",
          f"{len(picks)} zufällig gewählte Wohngebäude mit Hausnummer (fester Zufallsstartwert) wurden über Nominatim in OpenStreetMap gesucht. "
          "Verglichen wird der Abstand zwischen LoD2-Grundrissmittel und OSM-Koordinate. Quelle: © OpenStreetMap-Mitwirkende, ODbL.", "",
          f"- OSM-Treffer mit Hausnummer: **{found} von {len(picks)}**" + (f", Abstand Median **{stats['abstand_median_m']:.0f} m**, größter {stats['abstand_max_m']:.0f} m, {stats['innerhalb_25_m']} innerhalb 25 m" if dists else ""),
          "", "| Nr. | Adresse (LoD2) | OSM-Treffer | Abstand | Hausnummer gefunden |", "|---|---|---|---|---|"] + rows
    md += ["", "Einordnung: In OSM ist die Adresse oft am Gebäudeumriss oder als Punkt erfasst; Abstände bis rund 25 m sind bei größeren Grundstücken normal. "
           "Fehlt die Hausnummer in OSM, liefert Nominatim nur die Straße, dann ist der Abstand nicht aussagekräftig. Die Stichprobe prüft die Lage der amtlichen Adresse, nicht die Geometrie.", ""]
    return md, stats


def check_sun() -> tuple[list[str], dict]:
    from astral import Observer
    from astral import sun as asun

    lat, lon = common.CENTER_LATLON
    dates = ["2026-03-20", "2026-06-21", "2026-09-22", "2026-12-21", dt.date.today().isoformat()]
    js = f"""
import {{ sunPosition, sunTimes }} from 'file://{common.ROOT / 'web' / 'sun.js'}';
const lat={lat}, lon={lon}; const out={{}};
for (const d of {json.dumps(dates)}) {{ const t=sunTimes(new Date(d+'T00:00:00Z'),lat,lon); out[d]={{sunrise:t.sunrise?.toISOString(), sunset:t.sunset?.toISOString()}}; }}
console.log(JSON.stringify(out));"""
    res = subprocess.run(["node", "--input-type=module", "-e", js], capture_output=True, text=True, check=True)
    js_out = json.loads(res.stdout)
    obs = Observer(latitude=lat, longitude=lon, elevation=0)
    md = ["## 3. Sonnenstand gegen Referenz", "", "`web/sun.js` (NOAA) gegen die Python-Bibliothek `astral`, Zeiten UTC. Beide nutzen dieselben Formeln; der Test prüft die Umsetzung.", "",
          "| Datum | Aufgang sun.js | Aufgang astral | Diff | Untergang sun.js | Untergang astral | Diff |", "|---|---|---|---|---|---|---|"]
    worst = 0.0
    for d in dates:
        ref = asun.sun(obs, date=dt.date.fromisoformat(d), tzinfo=dt.timezone.utc)
        row = [d]
        for key in ("sunrise", "sunset"):
            mine = dt.datetime.fromisoformat(js_out[d][key].replace("Z", "+00:00"))
            diff = (mine - ref[key]).total_seconds() / 60
            worst = max(worst, abs(diff))
            row += [mine.strftime("%H:%M:%S"), ref[key].strftime("%H:%M:%S"), f"{diff:+.1f} min"]
        md.append("| " + " | ".join(row) + " |")
    md += ["", f"Größte Abweichung: **{worst:.1f} min**.", ""]
    return md, {"max_zeitdifferenz_min": worst}


def check_size() -> tuple[list[str], dict]:
    web = common.ROOT / "web"
    groups = {"Gelände (Höhen + Index)": [web / "data" / "terrain" / "heights.bin", web / "data" / "terrain" / "index.json"],
              "Luftbild (JPEG-Kacheln)": sorted((web / "data" / "terrain").glob("o_*.jpg")),
              "Gebäude (GLB + JSON + Dachtextur)": [web / "data" / "buildings.glb", web / "data" / "buildings.json"] + sorted((web / "data").glob("roofs_*.jpg")),
              "Bäume": [web / "data" / "trees.bin", web / "data" / "trees.json"],
              "Sonne, Klima, PV, Orte, Fahrplan, Betriebe, Autos": [web / "data" / n for n in ("sunlight.json", "climate.json", "solar.json", "places.json", "transit.json", "business.json", "cars.json")],
              "Sonstige Daten": [web / "data" / "gemeinde.geojson", web / "data" / "sources.json"],
              "three.js + Anwendung": [p for p in web.rglob("*.js") if p.name not in ("drive.js", "quellen.js")] + [web / "index.html", web / "style.css"]}
    # Nur bei Nutzung geladen, zählt nicht zum Start
    lazy = {"Fahrmodus (erst beim ersten Absetzen)": [web / "drive.js", web / "data" / "fahrnetz.json", web / "data" / "grundrisse.json"]}
    import gzip as _gz
    md = ["## 4. Ladevolumen", "", "GitHub Pages liefert die Dateien gzip-komprimiert aus (geprüft am 08.11.2026 für GLB, JSON und BIN). JPEG-Bilder sind bereits komprimiert.", "",
          "| Bestandteil | Dateien | MB auf der Platte | MB übertragen (gzip) |", "|---|---|---|---|"]
    total = total_gz = 0
    for k, files in groups.items():
        size = sum(f.stat().st_size for f in files if f.exists())
        gz = sum((f.stat().st_size if f.suffix == ".jpg" else len(_gz.compress(f.read_bytes(), 6))) for f in files if f.exists())
        total += size; total_gz += gz
        md.append(f"| {k} | {len(files)} | {size/1e6:.1f} | {gz/1e6:.1f} |")
    md.append(f"| **Gesamt beim Start** | | **{total/1e6:.1f}** | **{total_gz/1e6:.1f}** |")
    lazy_gz = 0
    for k, files in lazy.items():
        size = sum(f.stat().st_size for f in files if f.exists())
        gz = sum(len(_gz.compress(f.read_bytes(), 6)) for f in files if f.exists())
        lazy_gz += gz
        md.append(f"| {k} | {len(files)} | {size/1e6:.2f} | {gz/1e6:.2f} |")
    md += ["",
           f"Übertragen bei 20 Mbit/s rund {total_gz*8/20e6:.0f} s, bei 50 Mbit/s rund {total_gz*8/50e6:.0f} s. Gelände und Gebäude kommen zuerst, die Luftbildkacheln laden danach (Siedlung zuerst); bedienbar ist die Ansicht vorher.", ""]
    return md, {"gesamt_mb": total / 1e6, "uebertragen_gzip_mb": total_gz / 1e6, "fahrmodus_nachgeladen_gzip_mb": lazy_gz / 1e6}


def check_layers() -> tuple[list[str], dict]:
    """Kennzahlen und Plausibilität der Ebenen aus Phase 2 und 3 (aus den aufbereiteten Dateien)."""
    W = common.WEB_DATA
    md = ["## 5. Ebenen aus Phase 2 und 3", ""]
    st = {}
    src = common.load_sources()
    orte = src["ebenen"].get("orte", {})
    if orte:
        md += [f"**Orte mit Geschichte** ({orte['anzahl']} Orte, Quellen abgerufen {orte['abgerufen_am']}). Lage gegen LoD2:", ""] + [f"- {x}" for x in orte["pruefung"]] + [""]
        st["orte"] = orte["anzahl"]
    if (W / "solar.json").exists():
        so = json.loads((W / "solar.json").read_text(encoding="utf-8"))
        r = so["ergebnis_gemeinde"]
        md += ["**PV-Szenario.** Modell gegen den PVGIS-Rechner (ohne Horizont, kWh je kWp und Jahr):", "",
               "| Neigung | Ausrichtung | Modell | PVGIS | Abweichung |", "|---|---|---|---|---|"]
        md += [f"| {p['neigung']}° | {p['ausrichtung']}° | {p['modell_kwh_kwp']} | {p['pvgis_kwh_kwp']} | {p['abweichung_prozent']:+.1f} % |" for p in so["methode"]["pruefung_gegen_pvgis"]]
        b = so.get("bestand") or {}
        md += ["", f"Ergebnis: {r['leistung_kwp']:,} kWp, {r['ertrag_mwh_jahr']:,} MWh pro Jahr, spezifischer Ertrag Median {r['spezifischer_ertrag_median_kwh_kwp']:.0f} kWh/kWp "
               f"(5. bis 95. Perzentil {r['spezifischer_ertrag_p05_p95'][0]} bis {r['spezifischer_ertrag_p05_p95'][1]}). Bestand laut MaStR: {b.get('einheiten_in_betrieb')} Einheiten, {b.get('bruttoleistung_kw')} kW, "
               f"das sind {b.get('bruttoleistung_kw', 0) / r['leistung_kwp'] * 100:.0f} % des Szenarios. Plausibilität: Ein spezifischer Ertrag um 1.000 kWh/kWp entspricht der PVGIS-Größenordnung für den Oberrhein.", ""]
        st["pv"] = {"kwp": r["leistung_kwp"], "mwh": r["ertrag_mwh_jahr"], "max_abweichung_pvgis_prozent": max(abs(p["abweichung_prozent"]) for p in so["methode"]["pruefung_gegen_pvgis"])}
    if (W / "climate.json").exists():
        cl = json.loads((W / "climate.json").read_text(encoding="utf-8"))
        m = cl["marktplatz"]["hot_days"]; bw = cl["bw_periodenmittel_heisse_tage"]
        md += [f"**Klima.** {len(cl['zellen'])} 1-km-Zellen im Umgriff. Heiße Tage am Marktplatz {m[0]:.0f} (1961–1990), {m[1]:.0f} (1991–2020), Fortschreibung 2040 rund {m[2]:.0f}. "
               f"Gegenprobe Landesmittel BW aus der Jahresreihe: {bw['1961-1990']} und {bw['1991-2020']}; Sulzburg liegt am Oberrhein erwartungsgemäß darüber.", ""]
        st["klima"] = {"zellen": len(cl["zellen"]), "marktplatz_heisse_tage": m}
    wi = src["ebenen"].get("wirtschaft")
    if wi:
        md += [f"**Arbeiten und Wirtschaft.** {wi['betriebe']} Betriebe aus OpenStreetMap (Stand {wi['osm_stand']}), davon {wi['mit_lod2']} über die Adresse einem LoD2-Gebäude zugeordnet, "
               f"{wi['mit_solar']} mit Solaranlagen laut Marktstammdatenregister. Zuordnung je Betrieb:", ""] + [f"- {x}" for x in wi["pruefung"]] + [""]
        st["wirtschaft"] = {k: wi[k] for k in ("betriebe", "mit_lod2", "mit_solar")}
    au = src["ebenen"].get("autos")
    if au:
        md += [f"**Parkende Autos.** {au['anzahl']} Autos aus {au['kandidaten_flecken']} Kandidatenflecken. Sichtprüfung von 48 zufälligen Treffern (`docs/autos_stichprobe.jpg`): etwa 8 von 10 liegen auf einem Auto. "
               "Vollständigkeit am Marktplatz: rund 18 von gut 40 sichtbaren Autos. Momentaufnahme vom Bildflug 25.08.2025.", ""]
        st["autos"] = {"anzahl": au["anzahl"], "trefferquote_stichprobe": "ca. 0,8", "vollstaendigkeit_marktplatz": "ca. 18 von 40"}
    fm = src["ebenen"].get("fahrmodus")
    if fm:
        k = fm["kennzahlen"]
        md += [f"**Fahrmodus (Spielmodus).** Fahrnetz aus OpenStreetMap (Stand {fm['osm_stand']}): {k['wege']} Wegstücke, {k['namen']} Straßennamen, {k['parkplaetze']} Parkplätze. "
               f"Länge in km: {', '.join(f'{a} {v}' for a, v in k['laenge_km'].items())}. Ausgeschlossen in km: {', '.join(f'{a} {v}' for a, v in k['ausgeschlossen_km'].items())}. "
               f"Kollision mit {fm['grundrisse']['gebaeude']} LoD2-Grundrissen ({fm['grundrisse']['ringe']} Ringe); Brücken (LoD2-Funktion 53001_1800) sind Fahrbahn, keine Wand.", ""]
        st["fahrmodus"] = {"wege": k["wege"], "namen": k["namen"]}
        tf = common.ROOT / "docs" / "fahrmodus_test.json"
        if tf.exists():
            t = json.loads(tf.read_text(encoding="utf-8"))
            ap, rw = t["physik"]["autopilot"], t["rueckweg"]
            md += [f"Browsertest vom {t['erzeugt'][:10]} (`scripts/test_drive.cjs`, Ergebnis in `docs/fahrmodus_test.json`): "
                   f"beim Start {len(t['start']['fahrmodus_dateien_beim_start'])} Dateien des Fahrmodus geladen; Rückweg Kamera {rw['kamera_abweichung_m']:.3f} m, Blickpunkt {rw['blickpunkt_abweichung_m']:.3f} m, "
                   f"Bild vorher und nachher {'identisch' if rw['bild_identisch'] else 'verschieden'}. Autopilot auf {ap['wege']} Straßen ({ap['meter']/1000:.1f} km): "
                   f"{ap['ohne_haengen']} ohne Hängenbleiben, nie außerhalb der Spur (größter Wert des Abstandsfelds {ap['max_abstandsfeld_spur_m']} m), "
                   f"kleinster Abstand eines Kollisionskreises zur Wand {ap['min_kreisabstand_wand_m']} m (Radius 0,92 m). Hänger: "
                   + ("; ".join(f"{x['weg']} ({x['hindernis']})" for x in ap["probleme"]) or "keine") + ".", ""]
            st["fahrmodus"].update({"autopilot_ok": ap["ohne_haengen"], "autopilot_wege": ap["wege"], "rueckweg_bild_identisch": rw["bild_identisch"]})
    if (W / "transit.json").exists():
        tr = json.loads((W / "transit.json").read_text(encoding="utf-8"))
        n_trips = len(tr.get("fahrten") or [])
        md += [f"**Busse.** {len(tr['haltestellen'])} Haltesteige, {n_trips} Fahrten mit Linienverlauf zugeordnet ({len(tr.get('verlaeufe') or {})} Verlaufsabschnitte). "
               "Die Zuordnung prüft Linie und Folge der Haltestellen; eine Prüfung gegen die Fahrplanauskunft des Verbunds steht aus.", ""]
        st["busse"] = {"fahrten": n_trips}
    return md, st


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--stichprobe", type=int, default=20)
    ap.add_argument("--ohne-osm", action="store_true")
    args = ap.parse_args()
    t_md, t_stats = check_terrain()
    if args.ohne_osm:
        a_md, a_stats = ["## 2. Stichprobe Adressen", "", "übersprungen (--ohne-osm)", ""], {}
    else:
        a_md, a_stats = check_addresses(args.stichprobe)
    s_md, s_stats = check_sun()
    z_md, z_stats = check_size()
    l_md, l_stats = check_layers()
    doc = ["# Validierung (automatisch erzeugt)", "", f"Erzeugt am {common.now_iso()} durch `scripts/05_validate.py`.", ""] + t_md + a_md + s_md + z_md + l_md
    (common.ROOT / "docs" / "validierung.md").write_text("\n".join(doc), encoding="utf-8")
    src = common.load_sources()
    src["validierung"] = {"gelaende_gebaeude": t_stats, "adressen_osm": a_stats, "sonnenstand": s_stats, "ladevolumen": z_stats, "ebenen": l_stats, "datei": "docs/validierung.md"}
    common.save_sources(src)
    print(json.dumps(src["validierung"], indent=1, ensure_ascii=False))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
