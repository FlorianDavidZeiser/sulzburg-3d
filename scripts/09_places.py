"""Schritt 9: Orte mit Geschichte aus data/orte.json prüfen und für den Browser aufbereiten.

Für jeden Ort: Koordinate aus der Quelle nach EPSG:25832, nächstes LoD2-Gebäude bestimmen und gegen die
erwartete Funktion oder Adresse prüfen, Geländehöhe am Marker aus dem dargestellten Gelände.
Orte ohne Koordinate, aber mit erwarteter Adresse, werden auf das passende LoD2-Gebäude gesetzt.

Ausgabe: web/data/places.json, Prüfprotokoll auf der Konsole und in data/sources.json

Aufruf:  python3 -I scripts/09_places.py
"""
from __future__ import annotations

import importlib.util
import json
import math
import sys
from pathlib import Path

from pyproj import Transformer

sys.path.insert(0, str(Path(__file__).resolve().parent))
import common  # noqa: E402

_spec = importlib.util.spec_from_file_location("validate05", Path(__file__).resolve().parent / "05_validate.py")
validate05 = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(validate05)


def main() -> int:
    src = json.loads((common.ROOT / "data" / "orte.json").read_text(encoding="utf-8"))
    bld = json.loads((common.WEB_DATA / "buildings.json").read_text(encoding="utf-8"))
    G = bld["gebaeude"]
    tr = Transformer.from_crs("EPSG:4326", f"EPSG:{common.EPSG}", always_xy=True)
    rend = validate05.Rendered()
    box = common.aoi()
    out, log = [], []
    for o in src["orte"]:
        linked = None
        if o.get("lat") is not None:
            e, n = tr.transform(o["lon"], o["lat"])
            near = min(G, key=lambda g: math.hypot(g["e"] - e, g["n"] - n))
            dist = math.hypot(near["e"] - e, near["n"] - n)
            ok_func = o.get("lod2_funktion_erwartet") and near["funktion_name"] == o["lod2_funktion_erwartet"] and dist < 30
            ok_addr = o.get("adresse_erwartet") and near["adresse"] and near["adresse"].startswith(o["adresse_erwartet"] + ",") and dist < 30
            if ok_func or ok_addr:
                linked = near
            status = f"nächstes Gebäude {dist:.0f} m: {near['funktion_name']}, {near['adresse']}" + (" -> verknüpft" if linked else "")
        else:
            cand = [g for g in G if g["adresse"] and g["adresse"].startswith(o["adresse_erwartet"] + ",")]
            if not cand:
                log.append(f"{o['id']}: keine Koordinate und Adresse {o.get('adresse_erwartet')} nicht im LoD2 gefunden, übersprungen")
                continue
            linked = cand[0]
            e, n = linked["e"], linked["n"]
            status = f"aus LoD2-Adresse {linked['adresse']} ({linked['funktion_name']})"
        z = rend.height(e, n)
        if linked:
            z_marker = linked["z_first"] + 6
        else:
            z_marker = (z or 0) + 12
        out.append({
            "id": o["id"], "name": o["name"], "kurz": o["kurz"], "fakten": o["fakten"], "quellen": o["quellen"],
            "koordinatenquelle": o["koordinatenquelle"],
            "e": round(e, 1), "n": round(n, 1), "x": round(e - box["e0"], 1), "zz": round(-(n - box["n0"]), 1),
            "gelaende": round(z, 1) if z is not None else None, "marker_y": round(z_marker, 1),
            "gebaeude": linked["i"] if linked else None,
            "gebaeude_hinweis": (f"LoD2-Gebäude {linked['adresse'] or ''}, im Kataster als „{linked['funktion_name']}“ geführt" if linked else None),
        })
        log.append(f"{o['id']}: {status}")
    doc = {"ebene": "Orte mit Geschichte", "hinweis": src["hinweis"], "abgerufen_am": src["abgerufen_am"], "orte": out}
    (common.WEB_DATA / "places.json").write_text(json.dumps(doc, ensure_ascii=False, indent=1) + "\n", encoding="utf-8")
    s = common.load_sources()
    s["ebenen"]["orte"] = {"ebene": doc["ebene"], "anzahl": len(out), "pruefung": log, "abgerufen_am": src["abgerufen_am"]}
    common.save_sources(s)
    print("\n".join(log))
    print(f"Orte: {len(out)} -> web/data/places.json")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
