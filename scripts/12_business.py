"""Schritt 12: Ebene „Arbeiten und Wirtschaft“ (Variante A laut Konzept).

Quellen:
  - Betriebe aus OpenStreetMap (Overpass), gefiltert auf die amtliche Gemeindegrenze. © OpenStreetMap-Mitwirkende, ODbL.
  - Ergänzungen mit Quelle und Regeln aus data/betriebe_kuratiert.json (z. B. Wikipedia, CC BY-SA 4.0).
  - Solaranlagen von Organisationen aus dem Marktstammdatenregister (dl-de/by-2-0), nur über eine ausdrückliche
    Zuordnung Betrieb -> Betreibername; Betriebe mit "mastr_ausblenden" bekommen keine Anlagenangaben.

Regeln (Variante A): Alle Betriebe gleich. Name, Branche, Adresse, Öffnungszeiten, Website, Barrierefreiheit.
Keine Telefonnummern, keine Betreiber- oder Personennamen aus OSM, keine Umsätze, keine Eigentümer.

Ausgabe: web/data/business.json (steht wegen der OSM-Herkunft unter ODbL)
Aufruf:  python3 -I scripts/12_business.py [--neu-laden]
"""
from __future__ import annotations

import argparse
import json
import math
import re
import sys
import time
import urllib.parse
import urllib.request
from collections import Counter, defaultdict
from pathlib import Path

from pyproj import Transformer
from shapely.geometry import Point, shape

sys.path.insert(0, str(Path(__file__).resolve().parent))
import common  # noqa: E402

OSM_CACHE = common.RAW / "osm" / "betriebe_overpass.json"
MASTR_CACHE = common.RAW / "mastr_sulzburg.json"
OVERPASS = ["https://maps.mail.ru/osm/tools/overpass/api/interpreter", "https://overpass-api.de/api/interpreter",
            "https://overpass.kumi.systems/api/interpreter"]
MASTR = "https://www.marktstammdatenregister.de/MaStR/Einheit/EinheitJson/GetErweiterteOeffentlicheEinheitStromerzeugung"
UA = {"User-Agent": "sulzburg-3d (privates Projekt; github.com/FlorianDavidZeiser/sulzburg-3d)"}
BBOX = "47.80,7.66,47.86,7.78"   # großzügig um die Gemeinde, gefiltert wird danach über die amtliche Grenze

GRUPPEN = {
    "gewerbe": {"name": "Gewerbe, Handel, Dienste", "farbe": "#3987e5"},
    "gast": {"name": "Gastronomie und Übernachten", "farbe": "#d95926"},
    "wein": {"name": "Wein und Gartenbau", "farbe": "#199e70"},
}

# OSM-Tag -> (Gruppe, Branche auf Deutsch)
AMENITY = {"restaurant": ("gast", "Restaurant"), "cafe": ("gast", "Café"), "pub": ("gast", "Gaststätte"), "bar": ("gast", "Bar"),
           "fast_food": ("gast", "Imbiss"), "ice_cream": ("gast", "Eiscafé"), "pharmacy": ("gewerbe", "Apotheke"),
           "doctors": ("gewerbe", "Arztpraxis"), "dentist": ("gewerbe", "Zahnarztpraxis"), "bank": ("gewerbe", "Bank"),
           "fuel": ("gewerbe", "Tankstelle")}
TOURISM = {"hotel": "Hotel", "guest_house": "Gästehaus", "apartment": "Ferienwohnung", "camp_site": "Campingplatz",
           "chalet": "Ferienhaus", "hostel": "Herberge", "caravan_site": "Wohnmobilstellplatz"}
SHOP = {"bakery": "Bäckerei", "bicycle": "Fahrradgeschäft", "deli": "Feinkost", "furniture": "Möbel", "optician": "Optiker",
        "wine": "Weinverkauf", "butcher": "Metzgerei", "supermarket": "Supermarkt", "convenience": "Lebensmittel", "kiosk": "Kiosk",
        "car_repair": "Autowerkstatt", "hairdresser": "Friseur", "clothes": "Bekleidung", "florist": "Blumen"}
CRAFT = {"winery": ("wein", "Weingut"), "distillery": ("wein", "Brennerei"), "gardener": ("wein", "Gärtnerei"),
         "agricultural_engines": ("gewerbe", "Metallbau und Landtechnik"), "beekeeper": ("wein", "Imkerei"),
         "carpenter": ("gewerbe", "Schreinerei"), "electrician": ("gewerbe", "Elektrobetrieb"), "plumber": ("gewerbe", "Sanitär")}
WEIN_NAMEN = re.compile(r"weingut|winzer|weinbau|sekt", re.I)
ROLLSTUHL = {"yes": "ja", "limited": "eingeschränkt", "no": "nein"}


def overpass_query() -> str:
    parts = [f'nwr({BBOX})["name"]["{k}"];' for k in ("office", "craft", "shop")]
    parts += [f'nwr({BBOX})["name"]["tourism"];',
              f'nwr({BBOX})["name"]["amenity"~"restaurant|cafe|pub|bar|fast_food|ice_cream|pharmacy|doctors|dentist|bank|fuel"];',
              f'nwr({BBOX})["name"]["healthcare"];']
    return "[out:json][timeout:50];(" + "".join(parts) + ");out tags center;"


def fetch_osm() -> dict:
    data = urllib.parse.urlencode({"data": overpass_query()}).encode()
    for attempt in range(5):
        for url in OVERPASS:
            try:
                req = urllib.request.Request(url, data=data, headers=UA)
                with urllib.request.urlopen(req, timeout=90) as r:
                    d = json.loads(r.read().decode("utf-8"))
                if "elements" in d:
                    return d
            except Exception as exc:  # noqa: BLE001
                print(f"Overpass {url}: {exc}", file=sys.stderr)
        time.sleep(15)
    raise RuntimeError("Overpass nicht erreichbar")


def fetch_mastr() -> dict:
    flt = urllib.parse.quote("Gemeindeschlüssel~eq~'08315111'", safe="")
    req = urllib.request.Request(f"{MASTR}?sort=&page=1&pageSize=2000&group=&filter={flt}", headers=UA)
    with urllib.request.urlopen(req, timeout=180) as r:
        d = json.loads(r.read().decode("utf-8"))
    if (d.get("Total") or 0) > 5000:
        raise RuntimeError("MaStR-Filter offenbar ignoriert, Abbruch")
    return d


def classify(t: dict) -> tuple[str, str] | None:
    name = t.get("name", "")
    if "amenity" in t and t["amenity"] in AMENITY:
        grp, br = AMENITY[t["amenity"]]
        if t.get("tourism") in TOURISM:      # z. B. Hotel mit Restaurant in einem Objekt
            return "gast", f"{TOURISM[t['tourism']]} und {br}"
        return grp, br
    if "tourism" in t:
        if t["tourism"] in TOURISM:
            return "gast", TOURISM[t["tourism"]]
        if WEIN_NAMEN.search(name):          # z. B. Winzergenossenschaft, in OSM als Sehenswürdigkeit erfasst
            return "wein", "Weinbau"
        return None                          # Museen, Sehenswürdigkeiten, Infotafeln gehören nicht in diese Ebene
    if "craft" in t:
        return CRAFT.get(t["craft"], ("gewerbe", "Handwerk"))
    if "shop" in t:
        if t["shop"] == "wine" or WEIN_NAMEN.search(name):
            return "wein", "Weingut" if re.search(r"weingut", name, re.I) else SHOP.get(t["shop"], "Weinverkauf")
        return "gewerbe", SHOP.get(t["shop"], "Einzelhandel")
    if "office" in t:
        return "gewerbe", {"company": "Unternehmen", "insurance": "Versicherung"}.get(t["office"], "Büro")
    if "healthcare" in t:
        return "gewerbe", "Gesundheit"
    return None


def norm_addr(s: str) -> str:
    return re.sub(r"\s+", " ", s.lower().replace("str.", "straße")).strip()


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--neu-laden", action="store_true")
    args = ap.parse_args()
    box = common.aoi()
    kur = json.loads((common.ROOT / "data" / "betriebe_kuratiert.json").read_text(encoding="utf-8"))
    gem = shape(json.loads((common.ROOT / "data" / "gemeinde.geojson").read_text(encoding="utf-8"))["features"][0]["geometry"])
    tr = Transformer.from_crs("EPSG:4326", f"EPSG:{common.EPSG}", always_xy=True)

    OSM_CACHE.parent.mkdir(parents=True, exist_ok=True)
    if args.neu_laden or not OSM_CACHE.exists():
        OSM_CACHE.write_text(json.dumps(fetch_osm(), ensure_ascii=False), encoding="utf-8")
    osm = json.loads(OSM_CACHE.read_text(encoding="utf-8"))
    if args.neu_laden or not MASTR_CACHE.exists():
        MASTR_CACHE.write_text(json.dumps(fetch_mastr(), ensure_ascii=False), encoding="utf-8")
    mastr = json.loads(MASTR_CACHE.read_text(encoding="utf-8"))

    # LoD2-Gebäude nach Adresse (für Lage auf dem Dach und Verknüpfung mit der Gebäude-Info)
    bld = json.loads((common.WEB_DATA / "buildings.json").read_text(encoding="utf-8"))
    by_addr = defaultdict(list)
    for g in bld["gebaeude"]:
        if g["adresse"]:
            street = g["adresse"].split(",")[0]
            m = re.match(r"^(.*?)\s+(\d.*)$", street)
            if m:
                for num in re.split(r"\s*,\s*", m.group(2)):
                    by_addr[norm_addr(f"{m.group(1)} {num}")].append(g)

    # 1. Betriebe aus OSM in der Gemeinde
    raw = []
    for e in osm["elements"]:
        t = e.get("tags", {})
        lat = e.get("lat") or (e.get("center") or {}).get("lat")
        lon = e.get("lon") or (e.get("center") or {}).get("lon")
        if lat is None or not t.get("name"):
            continue
        x, y = tr.transform(lon, lat)
        if not gem.contains(Point(x, y)):
            continue
        cls = classify(t)
        if not cls:
            continue
        addr = " ".join(p for p in (t.get("addr:street"), t.get("addr:housenumber")) if p)
        raw.append({"osm": f"{e['type']}/{e['id']}", "name": t["name"], "gruppe": cls[0], "branche": cls[1], "e": x, "n": y,
                    "adresse": addr or None, "website": t.get("website") or t.get("contact:website"),
                    "oeffnungszeiten": t.get("opening_hours"), "rollstuhl": ROLLSTUHL.get(t.get("wheelchair", ""))})

    # 2. Zusammenfassen: kuratierte Gruppen und gleiche Namen in weniger als 80 m Abstand
    merged = []
    rules = {n: r["name"] for r in kur["zusammenfassen"] for n in r["namen"]}
    for r in sorted(raw, key=lambda r: (r["adresse"] is None, r["name"])):
        key = rules.get(r["name"], r["name"])
        hit = next((m for m in merged if m["name"] == key and math.hypot(m["e"] - r["e"], m["n"] - r["n"]) < 80), None)
        if hit:
            hit["osm_ids"].append(r["osm"])
            for k in ("adresse", "website", "oeffnungszeiten", "rollstuhl"):
                hit[k] = hit[k] or r[k]
            if r["branche"] not in hit["branchen"]:
                hit["branchen"].append(r["branche"])
            continue
        merged.append({**r, "name": key, "osm_ids": [r["osm"]], "branchen": [r["branche"]]})

    # 3. Solaranlagen laut MaStR über die ausdrückliche Zuordnung
    pv = defaultdict(lambda: {"kw": 0.0, "speicher_kw": 0.0, "einheiten": 0})
    for u in mastr.get("Data") or []:
        if u.get("Gemeindeschluessel") != "08315111" or u.get("BetriebsStatusName") != "In Betrieb" or u.get("AnlagenbetreiberPersonenArt") != 517:
            continue
        name = u.get("AnlagenbetreiberName") or ""
        if u.get("EnergietraegerName") == "Solare Strahlungsenergie":
            pv[name]["kw"] += float(u.get("Bruttoleistung") or 0); pv[name]["einheiten"] += 1
        elif u.get("EnergietraegerName") == "Speicher":
            pv[name]["speicher_kw"] += float(u.get("Bruttoleistung") or 0)

    out, log = [], []
    for i, m in enumerate(sorted(merged, key=lambda m: (m["gruppe"], m["name"]))):
        erg = kur["ergaenzungen"].get(m["name"], {})
        branche = erg.get("branche") or " und ".join(m["branchen"])
        gruppe = erg.get("gruppe") or m["gruppe"]
        linked = by_addr.get(norm_addr(m["adresse"])) if m["adresse"] else None
        g = min(linked, key=lambda g: math.hypot(g["e"] - m["e"], g["n"] - m["n"])) if linked else None
        dist = math.hypot(g["e"] - m["e"], g["n"] - m["n"]) if g else None
        if g and dist > 150:   # Adresse passt, aber Lage weit weg: lieber nicht verknüpfen
            log.append(f"{m['name']}: Adresse {m['adresse']} im LoD2 {dist:.0f} m entfernt, nicht verknüpft")
            g, dist = None, None
        e, n = (g["e"], g["n"]) if g else (m["e"], m["n"])
        rec = {
            "id": i, "name": m["name"], "gruppe": gruppe, "branche": branche, "adresse": m["adresse"],
            "website": m["website"], "oeffnungszeiten": m["oeffnungszeiten"], "rollstuhl": m["rollstuhl"],
            "x": round(e - box["e0"], 1), "zz": round(-(n - box["n0"]), 1),
            "gebaeude": g["i"] if g else None, "dach_m": round(g["z_first"], 1) if g else None,
            "osm": m["osm_ids"], "fakten": erg.get("fakten", []), "quellen": erg.get("quellen", []),
        }
        for feld in erg.get("felder_ausblenden", []):   # z. B. Hekatron: keine Angaben zu Zugängen am Standort
            rec[feld] = None
        if not erg.get("mastr_ausblenden"):
            betreiber = kur["mastr_zuordnung"].get(m["name"])
            if betreiber and betreiber in pv and pv[betreiber]["kw"] > 0:
                p = pv[betreiber]
                rec["solar"] = {"kw": round(p["kw"], 1), "einheiten": p["einheiten"], "speicher_kw": round(p["speicher_kw"], 1), "betreiber": betreiber}
        out.append(rec)
        log.append(f"{m['name']}: {gruppe}/{branche}, " + (f"LoD2 {g['adresse']} ({dist:.0f} m)" if g else "Lage aus OSM") +
                   (f", Solar {rec['solar']['kw']} kW" if rec.get("solar") else ""))

    stamp = (osm.get("osm3s") or {}).get("timestamp_osm_base")
    counts = Counter(r["gruppe"] for r in out)
    doc = {
        "ebene": "Arbeiten und Wirtschaft",
        "regeln": kur["hinweis"],
        "gruppen": {k: {**v, "anzahl": counts.get(k, 0)} for k, v in GRUPPEN.items()},
        "betriebe": out,
        "nur_im_mastr": kur["nur_im_mastr"],
        "quelle": {
            "osm": {"titel": "OpenStreetMap über Overpass", "lizenz": "ODbL", "url": "https://www.openstreetmap.org/copyright",
                    "namensnennung": "© OpenStreetMap-Mitwirkende", "stand": stamp},
            "mastr": {"titel": "Marktstammdatenregister der Bundesnetzagentur, öffentliche Einheitenübersicht", "lizenz": "dl-de/by-2-0",
                      "namensnennung": "Marktstammdatenregister – © Bundesnetzagentur | dl-de/by-2-0", "abgerufen": kur["abgerufen_am"]},
            "ergaenzungen": "Wikipedia (CC BY-SA 4.0), Quellen je Betrieb",
            "lizenz_datei": "Diese Datei enthält Daten aus OpenStreetMap und steht unter ODbL.",
            "verarbeitet_am": common.now_iso(),
        },
    }
    (common.WEB_DATA / "business.json").write_text(json.dumps(doc, ensure_ascii=False, separators=(",", ":")) + "\n", encoding="utf-8")
    src = common.load_sources()
    src["ebenen"]["wirtschaft"] = {"ebene": doc["ebene"], "betriebe": len(out), "gruppen": dict(counts), "osm_stand": stamp,
                                   "mit_lod2": sum(1 for r in out if r["gebaeude"] is not None), "mit_solar": sum(1 for r in out if r.get("solar")),
                                   "pruefung": log}
    common.save_sources(src)
    print("\n".join(log))
    print(f"Betriebe: {len(out)} ({dict(counts)}), mit LoD2-Gebäude {src['ebenen']['wirtschaft']['mit_lod2']}, mit Solar {src['ebenen']['wirtschaft']['mit_solar']}, OSM-Stand {stamp}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
