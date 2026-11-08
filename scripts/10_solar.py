"""Schritt 10: Szenario "PV auf allen geeigneten Dächern" und heutiger Bestand laut Marktstammdatenregister.

Rechenweg:
  1. Typisches Wetterjahr (TMY, stündlich) von PVGIS (EU-Kommission, JRC) für den Marktplatz, ohne PVGIS-Horizont.
  2. Je geeigneter LoD2-Dachfläche (Kennwerte aus scripts/04_buildings.py, Regeln in common.PV_ANNAHMEN):
     Einstrahlung auf die geneigte Fläche (Direktanteil mit Einfallswinkel, isotroper Himmel, Bodenreflexion),
     Direktanteil abgeschattet, wenn die Sonne unter dem Geländehorizont des Gebäudes steht (scripts/06_sunlight.py),
     Einfallswinkelverluste, Temperaturverluste, Systemverluste 14 Prozent.
  3. Kalibrierung: Das Modell wird ohne Horizont für 35 Grad Süd gegen den PVGIS-Rechner (PVcalc) abgeglichen;
     zwei weitere Ausrichtungen dienen als Prüfung.
  4. Bestand: Photovoltaik-Einheiten der Gemeinde aus dem öffentlichen Marktstammdatenregister, nur Summen.

Ausgabe: web/data/solar.json
Aufruf:  python3 -I scripts/10_solar.py [--neu-laden]
"""
from __future__ import annotations

import argparse
import datetime as dt
import json
import re
import sys
import time
import urllib.parse
import urllib.request
from collections import defaultdict
from pathlib import Path

import numpy as np

sys.path.insert(0, str(Path(__file__).resolve().parent))
import common  # noqa: E402

PVGIS = "https://re.jrc.ec.europa.eu/api/v5_2"
MASTR = "https://www.marktstammdatenregister.de/MaStR/Einheit/EinheitJson/GetErweiterteOeffentlicheEinheitStromerzeugung"
MASTR_MAX = 5000  # Schutz: Liefert der Dienst mehr Einheiten, wurde der Filter ignoriert -> Abbruch statt das ganze Register zu laden
UA = {"User-Agent": "sulzburg-3d (privates Projekt; github.com/FlorianDavidZeiser/sulzburg-3d)"}
EINWOHNER = {"wert": 2766, "stichtag": "2025-12-31", "quelle": "Wikipedia: Sulzburg (Infobox), https://de.wikipedia.org/wiki/Sulzburg"}


def get_json(url: str) -> dict:
    req = urllib.request.Request(url, headers=UA)
    with urllib.request.urlopen(req, timeout=180) as r:
        return json.loads(r.read().decode("utf-8"))


def sun_az_el(t_utc: np.ndarray, lat: float, lon: float) -> tuple[np.ndarray, np.ndarray]:
    """NOAA-Algorithmus vektorisiert; t_utc als Unix-Sekunden. Azimut 0 = Nord, im Uhrzeigersinn. Höhe ohne Refraktion."""
    jd = t_utc / 86400 + 2440587.5
    t = (jd - 2451545) / 36525
    l0 = (280.46646 + t * (36000.76983 + 0.0003032 * t)) % 360
    m = 357.52911 + t * (35999.05029 - 0.0001537 * t)
    e = 0.016708634 - t * (0.000042037 + 0.0000001267 * t)
    c = (np.sin(np.radians(m)) * (1.914602 - t * (0.004817 + 0.000014 * t)) + np.sin(np.radians(2 * m)) * (0.019993 - 0.000101 * t)
         + np.sin(np.radians(3 * m)) * 0.000289)
    omega = 125.04 - 1934.136 * t
    lam = l0 + c - 0.00569 - 0.00478 * np.sin(np.radians(omega))
    eps = 23 + (26 + (21.448 - t * (46.815 + t * (0.00059 - t * 0.001813))) / 60) / 60 + 0.00256 * np.cos(np.radians(omega))
    decl = np.arcsin(np.sin(np.radians(eps)) * np.sin(np.radians(lam)))
    y = np.tan(np.radians(eps / 2)) ** 2
    eot = 4 * np.degrees(y * np.sin(2 * np.radians(l0)) - 2 * e * np.sin(np.radians(m)) + 4 * e * y * np.sin(np.radians(m)) * np.cos(2 * np.radians(l0))
                         - 0.5 * y * y * np.sin(4 * np.radians(l0)) - 1.25 * e * e * np.sin(2 * np.radians(m)))
    minutes = (t_utc % 86400) / 60
    tst = (minutes + eot + 4 * lon) % 1440
    ha = np.radians(tst / 4 - 180)
    phi = np.radians(lat)
    sin_el = np.sin(phi) * np.sin(decl) + np.cos(phi) * np.cos(decl) * np.cos(ha)
    el = np.arcsin(np.clip(sin_el, -1, 1))
    az = np.degrees(np.arctan2(np.sin(ha), np.cos(ha) * np.sin(phi) - np.tan(decl) * np.cos(phi))) + 180
    return az % 360, np.degrees(el)


class Model:
    def __init__(self, tmy: dict, lat: float, lon: float):
        rows = tmy["outputs"]["tmy_hourly"]
        off = float(tmy["inputs"]["location"].get("irradiance_time_offset", 0)) * 3600
        ts = np.array([dt.datetime.strptime(r["time(UTC)"], "%Y%m%d:%H%M").replace(tzinfo=dt.timezone.utc).timestamp() for r in rows]) + off
        self.gbn = np.array([r["Gb(n)"] for r in rows], dtype=np.float64)
        self.gdh = np.array([r["Gd(h)"] for r in rows], dtype=np.float64)
        self.gh = np.array([r["G(h)"] for r in rows], dtype=np.float64)
        self.t2m = np.array([r["T2m"] for r in rows], dtype=np.float64)
        self.az, self.el = sun_az_el(ts, lat, lon)
        a, e = np.radians(self.az), np.radians(self.el)
        self.s = np.stack([np.sin(a) * np.cos(e), np.cos(a) * np.cos(e), np.sin(e)], axis=1)  # Ost, Nord, oben
        self.k = 1.0

    def yield_kwh_per_kwp(self, tilt: float, aspect: float, shaded: np.ndarray | None = None) -> float:
        """Jahresertrag in kWh je kWp. aspect: 0 = Süd, 90 = West, -90 = Ost. shaded: bool je Stunde (Direktanteil fällt weg)."""
        A = common.PV_ANNAHMEN
        b = np.radians(tilt); na = np.radians(aspect + 180)  # Azimut der Flächennormalen, 0 = Nord
        n = np.array([np.sin(b) * np.sin(na), np.sin(b) * np.cos(na), np.cos(b)])
        cos_aoi = np.clip(self.s @ n, 0, 1)
        up = self.el > 0
        beam = np.where(up, self.gbn * cos_aoi, 0.0)
        if shaded is not None:
            beam = np.where(shaded, 0.0, beam)
        iam = np.clip(1 - 0.05 * (1 / np.maximum(cos_aoi, 1e-3) - 1), 0, 1)  # ASHRAE-Ansatz, b0 = 0,05
        diffuse = self.gdh * (1 + np.cos(b)) / 2
        ground = self.gh * A["albedo"]["wert"] * (1 - np.cos(b)) / 2
        poa = beam * iam + diffuse + ground
        tc = self.t2m + poa / 800 * (45 - 20)                 # Zelltemperatur, NOCT 45 °C
        p = poa / 1000 * (1 - 0.004 * (tc - 25)) * (1 - A["systemverluste"]["wert"])
        return float(p.sum() * self.k)


def mastr_bestand() -> dict:
    flt = "Gemeindeschlüssel~eq~'08315111'~and~Energieträger~eq~'2495'"
    out = {"einheiten_in_betrieb": 0, "bruttoleistung_kw": 0.0, "nach_jahr": defaultdict(lambda: [0, 0.0]), "status": defaultdict(int), "gesamt_gemeldet": 0,
           "nach_art": defaultdict(lambda: [0, 0.0])}
    page = 1
    while True:
        url = f"{MASTR}?sort=&page={page}&pageSize=500&group=&filter={urllib.parse.quote(flt, safe='')}"
        d = get_json(url)
        if (d.get("Total") or 0) > MASTR_MAX:
            raise RuntimeError(f"MaStR liefert {d.get('Total')} Einheiten, Filter offenbar ignoriert; Abbruch")
        data = d.get("Data") or []
        for u in data:   # nur Summen, keine Namen, Adressen oder Kennungen werden gespeichert
            if u.get("Gemeindeschluessel") != "08315111":
                continue
            out["gesamt_gemeldet"] += 1
            out["status"][u.get("BetriebsStatusName") or "?"] += 1
            if u.get("BetriebsStatusName") != "In Betrieb":
                continue
            kw = float(u.get("Bruttoleistung") or 0)
            out["einheiten_in_betrieb"] += 1
            out["bruttoleistung_kw"] += kw
            art = u.get("ArtDerSolaranlageBezeichnung") or "ohne Angabe"
            out["nach_art"][art][0] += 1
            out["nach_art"][art][1] += kw
            m = re.search(r"\d+", u.get("InbetriebnahmeDatum") or "")
            year = dt.datetime.fromtimestamp(int(m.group()) / 1000, dt.timezone.utc).year if m else None
            if year:
                out["nach_jahr"][year][0] += 1
                out["nach_jahr"][year][1] += kw
        total = d.get("Total") or 0
        if page * 500 >= total or not data:
            break
        page += 1
        time.sleep(1)
    out["nach_jahr"] = {str(k): [v[0], round(v[1], 1)] for k, v in sorted(out["nach_jahr"].items())}
    out["status"] = dict(out["status"])
    out["nach_art"] = {k: [v[0], round(v[1], 1)] for k, v in sorted(out["nach_art"].items(), key=lambda kv: -kv[1][1])}
    out["bruttoleistung_kw"] = round(out["bruttoleistung_kw"], 1)
    return out


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--neu-laden", action="store_true", help="PVGIS und MaStR neu abrufen")
    args = ap.parse_args()
    A = common.PV_ANNAHMEN
    lat, lon = common.CENTER_LATLON
    raw = common.RAW
    tmy_path = raw / "pvgis_tmy.json"
    if args.neu_laden or not tmy_path.exists():
        tmy_path.write_text(json.dumps(get_json(f"{PVGIS}/tmy?lat={lat:.4f}&lon={lon:.4f}&usehorizon=0&outputformat=json")), encoding="utf-8")
    tmy = json.loads(tmy_path.read_text(encoding="utf-8"))
    model = Model(tmy, lat, lon)

    # Kalibrierung und Prüfung gegen den PVGIS-Rechner (ohne Horizont, gleiche Systemverluste)
    refs = [(35, 0), (15, 0), (35, -90), (35, 90)]
    ref_path = raw / "pvgis_referenz.json"
    if args.neu_laden or not ref_path.exists():
        rr = {}
        for tilt, aspect in refs:
            d = get_json(f"{PVGIS}/PVcalc?lat={lat:.4f}&lon={lon:.4f}&peakpower=1&loss={A['systemverluste']['wert']*100:.0f}&angle={tilt}&aspect={aspect}&usehorizon=0&outputformat=json")
            rr[f"{tilt}_{aspect}"] = d["outputs"]["totals"]["fixed"]["E_y"]
            time.sleep(1)
        ref_path.write_text(json.dumps(rr), encoding="utf-8")
    rr = json.loads(ref_path.read_text(encoding="utf-8"))
    raw_35 = model.yield_kwh_per_kwp(35, 0)
    model.k = rr["35_0"] / raw_35
    pruefung = []
    for tilt, aspect in refs:
        mine = model.yield_kwh_per_kwp(tilt, aspect)
        ref = rr[f"{tilt}_{aspect}"]
        pruefung.append({"neigung": tilt, "ausrichtung": aspect, "modell_kwh_kwp": round(mine, 1), "pvgis_kwh_kwp": ref, "abweichung_prozent": round((mine / ref - 1) * 100, 1)})
    print("Kalibrierfaktor %.3f; Prüfung:" % model.k, pruefung)

    # Dachflächen, Horizonte
    roofs = json.loads((common.ROOT / "data" / "processed" / "dachflaechen.json").read_text(encoding="utf-8"))["werte"]
    horizons = np.load(common.ROOT / "data" / "processed" / "horizonte.npy")
    step = json.loads((common.ROOT / "data" / "processed" / "horizonte.json").read_text(encoding="utf-8"))["schritt_grad"]
    bld = json.loads((common.WEB_DATA / "buildings.json").read_text(encoding="utf-8"))
    G = bld["gebaeude"]
    pos = model.az / step
    i0 = np.floor(pos).astype(int) % horizons.shape[1]; i1 = (i0 + 1) % horizons.shape[1]; f = pos - np.floor(pos)

    per_b = defaultdict(lambda: [0.0, 0.0, 0.0, 0.0])  # kWp, kWh, geeignete Fläche, kWh ohne Horizont
    cache: dict[tuple, float] = {}
    for b, area, tilt, aspect, pv in roofs:
        if pv == 0:
            continue
        if pv == 2:
            tilt_m, aspect_m, beleg = A["aufstaenderung_flach_grad"]["wert"], 0.0, A["belegung_flach"]["wert"]
        else:
            tilt_m, aspect_m, beleg = tilt, aspect, A["belegung_geneigt"]["wert"]
        kwp = area * beleg * A["kwp_je_m2"]["wert"]
        hz = horizons[b, i0] * (1 - f) + horizons[b, i1] * f
        shaded = model.el <= hz
        key = (b, round(tilt_m), round(aspect_m / 5) * 5)
        if key not in cache:
            cache[key] = model.yield_kwh_per_kwp(round(tilt_m), round(aspect_m / 5) * 5, shaded)
        key0 = (None, round(tilt_m), round(aspect_m / 5) * 5)
        if key0 not in cache:
            cache[key0] = model.yield_kwh_per_kwp(round(tilt_m), round(aspect_m / 5) * 5)
        r = per_b[b]
        r[0] += kwp; r[1] += kwp * cache[key]; r[2] += area; r[3] += kwp * cache[key0]

    werte = []
    for g in G:
        r = per_b.get(g["i"])
        werte.append([round(r[0], 2), round(r[1]), round(r[2], 1)] if r else [0, 0, 0])
    inside = [per_b[g["i"]] for g in G if g["in_gemeinde"] and g["i"] in per_b]
    kwp = sum(r[0] for r in inside); kwh = sum(r[1] for r in inside); kwh0 = sum(r[3] for r in inside); fl = sum(r[2] for r in inside)
    spez = np.array([v[1] / v[0] for v in werte if v[0] > 0])

    try:
        bestand = mastr_bestand()
        bestand_quelle = {"titel": "Marktstammdatenregister der Bundesnetzagentur, öffentliche Einheitenübersicht (Stromerzeugung, Solare Strahlungsenergie, Gemeindeschlüssel 08315111)",
                          "url": "https://www.marktstammdatenregister.de/MaStR/Einheit/Einheiten/OeffentlicheEinheitenuebersicht", "abgerufen_am": common.now_iso(),
                          "hinweis": "Nur Summen gespeichert, keine Namen oder Kennungen. Enthält auch Steckersolargeräte."}
    except Exception as exc:  # noqa: BLE001
        bestand, bestand_quelle = None, {"fehler": str(exc)}
    print("Bestand:", None if not bestand else {k: bestand[k] for k in ("einheiten_in_betrieb", "bruttoleistung_kw", "gesamt_gemeldet")})

    out = {
        "ebene": "Szenario 2040: PV auf allen geeigneten Dächern",
        "art": "Szenario",
        "annahmen": A,
        "methode": {
            "wetter": f"Typisches Wetterjahr (TMY) von PVGIS, Strahlung {tmy['inputs']['meteo_data']['radiation_db']}, Jahre {tmy['inputs']['meteo_data']['year_min']} bis {tmy['inputs']['meteo_data']['year_max']}, Ort Marktplatz",
            "modell": "Direktanteil mit Einfallswinkel (Verlust nach ASHRAE, b0 0,05), Diffusanteil isotrop, Bodenreflexion; Zelltemperatur mit NOCT 45 °C, Temperaturkoeffizient -0,4 %/K",
            "verschattung": "Direktanteil entfällt, wenn die Sonne unter dem Geländehorizont des Gebäudes (DGM1, vom First aus) steht. Nachbargebäude und Bäume sind nicht berücksichtigt.",
            "kalibrierfaktor": round(model.k, 4),
            "pruefung_gegen_pvgis": pruefung,
        },
        "ergebnis_gemeinde": {
            "geeignete_dachflaeche_m2": round(fl), "leistung_kwp": round(kwp), "ertrag_mwh_jahr": round(kwh / 1000),
            "ertrag_ohne_gelaendehorizont_mwh_jahr": round(kwh0 / 1000), "verlust_durch_gelaendehorizont_prozent": round((1 - kwh / kwh0) * 100, 1) if kwh0 else None,
            "gebaeude_mit_eignung": len(inside), "spezifischer_ertrag_median_kwh_kwp": round(float(np.median(spez)), 0) if len(spez) else None,
            "spezifischer_ertrag_p05_p95": [round(float(np.percentile(spez, 5))), round(float(np.percentile(spez, 95)))] if len(spez) else None,
            "je_einwohner_kwh": round(kwh / EINWOHNER["wert"]), "einwohner": EINWOHNER,
        },
        "bestand": bestand, "bestand_quelle": bestand_quelle,
        "werte_spalten": ["kwp", "kwh_jahr", "geeignete_flaeche_m2"],
        "werte": werte,
        "quelle": {"pvgis": "PVGIS 5.2, Gemeinsame Forschungsstelle der Europäischen Kommission (JRC), https://re.jrc.ec.europa.eu/pvg_tools/", "gebaeude": "LGL LoD2, dl-de/by-2-0",
                   "gelaende": "LGL DGM1, dl-de/by-2-0", "berechnet_am": common.now_iso()},
    }
    (common.WEB_DATA / "solar.json").write_text(json.dumps(out, ensure_ascii=False, separators=(",", ":")) + "\n", encoding="utf-8")
    doc = common.load_sources()
    doc["ebenen"]["szenario_pv"] = {"ebene": out["ebene"], **out["ergebnis_gemeinde"], "kalibrierfaktor": out["methode"]["kalibrierfaktor"],
                                    "bestand_kwp": bestand["bruttoleistung_kw"] if bestand else None}
    common.save_sources(doc)
    print(json.dumps(out["ergebnis_gemeinde"], ensure_ascii=False, indent=1))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
