"""Schritt 7: Haltestellen und Soll-Abfahrten für den Umgriff der Gemeinde aus den GTFS-Daten Baden-Württembergs.

Eingabe:  data/raw/bwgesamt.zip (MobiData BW / NVBW, "Gebündelte Soll-Fahrplandaten Baden-Württemberg ohne Linienverlauf",
          GTFS, Lizenz dl-de/by-2-0), data/gemeinde.geojson, data/kacheln.json
Ausgabe:  web/data/transit.json: Haltestellen im Umgriff (mit Höhe aus dem dargestellten Gelände), Linien, Abfahrten je
          Haltestelle für einen begrenzten Zeitraum (Soll-Fahrplan, keine Echtzeit).

Aufruf:  python3 -I scripts/07_transit.py [--tage 42]
"""
from __future__ import annotations

import argparse
import csv
import datetime as dt
import hashlib
import io
import json
import sys
import zipfile
from collections import defaultdict
from pathlib import Path

import numpy as np
from pyproj import Transformer
from shapely.geometry import Point, shape
from shapely.prepared import prep

sys.path.insert(0, str(Path(__file__).resolve().parent))
import common  # noqa: E402

ZIP = common.RAW / "bwgesamt.zip"
URL = "https://www.nvbw.de/fileadmin/user_upload/service/open_data/fahrplandaten_ohne_liniennetz/bwgesamt.zip"
DATASET = "https://mobidata-bw.de/dataset/soll-fahrplandaten-baden-wurttemberg"
SHAPES_ZIP = common.RAW / "gtfs_shapes" / "bwgesamt_mit_linienverlauf.zip"
SHAPES_URL = "https://www.nvbw.de/fileadmin/user_upload/service/open_data/fahrplandaten_mit_liniennetz/bwgesamt.zip"
SHAPES_DATASET = "https://mobidata-bw.de/dataset/soll-fahrplandaten-baden-wurttemberg-mit-linienverlauf"


def build_trips(zpath, trip_stops, trips, routes, out_stops, trip_masks, area, tr, box):
    """Linienverläufe (shapes) aus dem Feed mit Linienverlauf den Fahrten des Feeds ohne Linienverlauf zuordnen.

    Zuordnung über Linie und Folge der Haltestellen im Umgriff (gleiche stop_ids in beiden Feeds).
    Der Verlauf wird auf den Abschnitt zwischen erstem und letztem Halt im Umgriff gekürzt und vereinfacht (1,5 m).
    """
    from shapely.geometry import LineString, Point as SPoint
    from shapely.ops import substring

    z = zipfile.ZipFile(zpath)
    name_of = {rid: r["name"] for rid, r in routes.items()}
    want_names = set(name_of.values())
    stop_ids = {s["id"] for s in out_stops}
    s_routes = {}
    for row in read_csv(z, "routes.txt"):
        if row.get("route_short_name") in want_names:
            s_routes[row["route_id"]] = row["route_short_name"]
    s_trips = {}
    for row in read_csv(z, "trips.txt"):
        if row["route_id"] in s_routes and row.get("shape_id"):
            s_trips[row["trip_id"]] = (s_routes[row["route_id"]], row["shape_id"])
    seqs = defaultdict(list)
    for row in read_csv(z, "stop_times.txt"):
        if row["trip_id"] in s_trips and row["stop_id"] in stop_ids:
            seqs[row["trip_id"]].append((int(row["stop_sequence"]), row["stop_id"]))
    key_to_shape = {}
    for tid, lst in seqs.items():
        name, shp = s_trips[tid]
        key_to_shape.setdefault((name, tuple(s for _, s in sorted(lst))), shp)
    need = set(key_to_shape.values())
    pts = defaultdict(list)
    for row in read_csv(z, "shapes.txt"):
        if row["shape_id"] in need:
            pts[row["shape_id"]].append((int(row["shape_pt_sequence"]), float(row["shape_pt_lon"]), float(row["shape_pt_lat"])))
    feed = next(iter(read_csv(z, "feed_info.txt")), {}) if "feed_info.txt" in z.namelist() else {}

    stop_idx = {s["id"]: i for i, s in enumerate(out_stops)}
    lines = {}
    for shp, lst in pts.items():
        lst.sort()
        xs, ys = tr.transform([p[1] for p in lst], [p[2] for p in lst])
        lines[shp] = LineString([(x - box["e0"], -(y - box["n0"])) for x, y in zip(xs, ys)])

    fahrten, verlaeufe = [], {}
    for trip_id, halts in trip_stops.items():
        t = trips.get(trip_id)
        if not t or len(halts) < 2 or trip_id not in trip_masks:
            continue
        halts = sorted(halts, key=lambda h: h[2])
        key = (name_of.get(t["route"]), tuple(h[0] for h in halts))
        shp = key_to_shape.get(key)
        if not shp or shp not in lines:
            continue
        line = lines[shp]
        # Projektion der Halte auf den Verlauf, monoton steigend
        proj, last = [], -1.0
        for sid, dep, _ in halts:
            st = out_stops[stop_idx[sid]]
            d = line.project(SPoint(st["x"], st["zz"]))
            if d < last:
                d = last
            proj.append(d); last = d
        a, b = proj[0], proj[-1]
        if b - a < 20:
            continue
        vkey = f"{shp}|{a:.0f}|{b:.0f}"
        if vkey not in verlaeufe:
            seg = substring(line, a, b).simplify(1.5)
            verlaeufe[vkey] = [[round(x, 1), round(y, 1)] for x, y in seg.coords]
        h_out = []
        for (sid, dep, _), d in zip(halts, proj):
            if not dep:
                continue
            hh, mm, ss = (int(x) for x in dep.split(":"))
            h_out.append([stop_idx[sid], hh * 3600 + mm * 60 + ss, round(d - a, 1)])
        if len(h_out) >= 2:
            fahrten.append({"route": t["route"], "ziel": t["headsign"], "tage": trip_masks[trip_id], "verlauf": vkey, "halte": h_out})
    info = {"titel": "Gebündelte Soll-Fahrplandaten Baden-Württemberg mit Linienverlauf (GTFS), NVBW über MobiData BW", "datensatz": SHAPES_DATASET, "download": SHAPES_URL,
            "lizenz": {"name": "Open Data Commons Open Database License (ODbL)", "url": "https://opendatacommons.org/licenses/odbl/1-0/"},
            "feed_info": {k: v for k, v in feed.items() if k in ("feed_version", "feed_start_date", "feed_end_date")},
            "hinweis": "Nur die Linienverläufe stammen aus diesem Datensatz; Fahrzeiten aus dem Datensatz ohne Linienverlauf. Die Verläufe in transit.json stehen damit unter ODbL."}
    return fahrten, verlaeufe, info


def read_csv(z: zipfile.ZipFile, name: str):
    with z.open(name) as fh:
        text = io.TextIOWrapper(fh, encoding="utf-8-sig", newline="")
        yield from csv.DictReader(text)


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--tage", type=int, default=42, help="Zeitraum ab heute, für den Abfahrten exportiert werden")
    args = ap.parse_args()
    if not ZIP.exists():
        sys.exit(f"{ZIP} fehlt. Download: {URL}")

    gemeinde = json.loads((common.ROOT / "data" / "gemeinde.geojson").read_text(encoding="utf-8"))
    kacheln = json.loads((common.ROOT / "data" / "kacheln.json").read_text(encoding="utf-8"))
    area = prep(shape(gemeinde["features"][0]["geometry"]).buffer(kacheln["rand_m"]))
    tr = Transformer.from_crs("EPSG:4326", f"EPSG:{common.EPSG}", always_xy=True)
    box = common.aoi()

    z = zipfile.ZipFile(ZIP)
    names = set(z.namelist())
    print("GTFS-Dateien:", sorted(names))

    # 1. Haltestellen im Umgriff
    stops = {}
    parents = {}
    for row in read_csv(z, "stops.txt"):
        try:
            lon, lat = float(row["stop_lon"]), float(row["stop_lat"])
        except (KeyError, ValueError):
            continue
        e, n = tr.transform(lon, lat)
        if area.contains(Point(e, n)):
            stops[row["stop_id"]] = {"id": row["stop_id"], "name": row["stop_name"], "lat": lat, "lon": lon, "e": round(e, 1), "n": round(n, 1),
                                     "parent": row.get("parent_station") or None, "location_type": row.get("location_type") or "0", "platform": row.get("platform_code") or None}
    print(f"Haltestellen/Steige im Umgriff: {len(stops)}")
    stop_ids = set(stops)

    # 2. stop_times nur für diese Haltestellen (große Datei, zeilenweise)
    trip_stops = defaultdict(list)   # trip_id -> [(stop_id, dep, seq)]
    n_rows = 0
    for row in read_csv(z, "stop_times.txt"):
        n_rows += 1
        sid = row["stop_id"]
        if sid in stop_ids:
            trip_stops[row["trip_id"]].append((sid, row.get("departure_time") or row.get("arrival_time"), int(row["stop_sequence"])))
    print(f"stop_times gelesen: {n_rows:,}, Fahrten mit Halt im Umgriff: {len(trip_stops)}")

    # 3. Fahrten, Linien, Kalender
    trips = {}
    for row in read_csv(z, "trips.txt"):
        if row["trip_id"] in trip_stops:
            trips[row["trip_id"]] = {"route": row["route_id"], "service": row["service_id"], "headsign": row.get("trip_headsign") or "", "direction": row.get("direction_id") or ""}
    route_ids = {t["route"] for t in trips.values()}
    routes = {}
    agencies = {}
    for row in read_csv(z, "agency.txt"):
        agencies[row.get("agency_id") or ""] = row.get("agency_name", "")
    for row in read_csv(z, "routes.txt"):
        if row["route_id"] in route_ids:
            routes[row["route_id"]] = {"id": row["route_id"], "name": row.get("route_short_name") or row.get("route_long_name") or "", "long": row.get("route_long_name") or "",
                                       "type": row.get("route_type") or "", "agency": agencies.get(row.get("agency_id") or "", ""), "color": row.get("route_color") or None}
    service_ids = {t["service"] for t in trips.values()}
    today = dt.date.today()
    until = today + dt.timedelta(days=args.tage)
    service_days = defaultdict(set)  # service_id -> set(date iso)
    if "calendar.txt" in names:
        wd = ["monday", "tuesday", "wednesday", "thursday", "friday", "saturday", "sunday"]
        for row in read_csv(z, "calendar.txt"):
            if row["service_id"] not in service_ids:
                continue
            start = dt.datetime.strptime(row["start_date"], "%Y%m%d").date(); end = dt.datetime.strptime(row["end_date"], "%Y%m%d").date()
            d = max(start, today)
            while d <= min(end, until):
                if row[wd[d.weekday()]] == "1":
                    service_days[row["service_id"]].add(d.isoformat())
                d += dt.timedelta(days=1)
    if "calendar_dates.txt" in names:
        for row in read_csv(z, "calendar_dates.txt"):
            if row["service_id"] not in service_ids:
                continue
            d = dt.datetime.strptime(row["date"], "%Y%m%d").date()
            if today <= d <= until:
                if row["exception_type"] == "1":
                    service_days[row["service_id"]].add(d.isoformat())
                else:
                    service_days[row["service_id"]].discard(d.isoformat())
    feed_info = {}
    if "feed_info.txt" in names:
        feed_info = next(iter(read_csv(z, "feed_info.txt")), {})

    # 4. Abfahrten je Haltestelle und Tag: [stop_id][date] -> [(dep_seconds, route_id, headsign)]
    # Kompakt: pro Haltestelle eine Liste von Fahrten mit Tagen (Bitfolge über den Zeitraum)
    day_list = [(today + dt.timedelta(days=i)).isoformat() for i in range(args.tage + 1)]
    day_index = {d: i for i, d in enumerate(day_list)}
    departures = defaultdict(list)
    trip_masks = {}
    for trip_id, halts in trip_stops.items():
        t = trips.get(trip_id)
        if not t:
            continue
        days = service_days.get(t["service"], set())
        if not days:
            continue
        mask = [0] * ((len(day_list) + 29) // 30)   # Blöcke à 30 Tage, weil JavaScript-Bitoperationen 32 Bit haben
        for d in days:
            k = day_index[d]
            mask[k // 30] |= 1 << (k % 30)
        last_seq = max(h[2] for h in halts)
        trip_masks[trip_id] = mask
        for sid, dep, seq in halts:
            if not dep:
                continue
            hh, mm, ss = (int(x) for x in dep.split(":"))
            departures[sid].append([hh * 3600 + mm * 60 + ss, t["route"], t["headsign"], mask, 1 if seq == last_seq else 0])
    for lst in departures.values():
        lst.sort()

    # 5. Höhe aus dem dargestellten Gelände für die Darstellung
    idx = json.loads((common.WEB_DATA / "terrain" / "index.json").read_text(encoding="utf-8"))
    buf = (common.WEB_DATA / "terrain" / "heights.bin").read_bytes()
    tiles = {t["id"]: t for t in idx["kacheln"]}

    def height(e, n):
        T = idx["kachel_m"]
        t = tiles.get(f"{int(np.floor(e / T) * T)}_{int(np.floor(n / T) * T)}")
        if not t:
            return None
        q = np.frombuffer(buf, dtype="<u2", count=t["n"] * t["n"], offset=t["offset"]).reshape(t["n"], t["n"])
        fx, fz = (e - t["e_min"]) / t["res"], (t["n_min"] + t["size"] - n) / t["res"]
        c0 = int(min(t["n"] - 2, max(0, np.floor(fx)))); r0 = int(min(t["n"] - 2, max(0, np.floor(fz))))
        dx, dz = min(1, max(0, fx - c0)), min(1, max(0, fz - r0))
        g = lambda r, c: t["z_min"] + float(q[r, c]) * t["z_scale"]  # noqa: E731
        return round((g(r0, c0) * (1 - dx) + g(r0, c0 + 1) * dx) * (1 - dz) + (g(r0 + 1, c0) * (1 - dx) + g(r0 + 1, c0 + 1) * dx) * dz, 1)

    # Nur Haltestellen mit Abfahrten oder Elternstationen davon
    used = {sid for sid, lst in departures.items() if lst}
    for sid in list(used):
        p = stops[sid]["parent"]
        if p and p in stops:
            used.add(p)
    out_stops = []
    for sid in sorted(used):
        s = stops[sid]
        s["z"] = height(s["e"], s["n"])
        s["x"], s["zz"] = round(s["e"] - box["e0"], 1), round(-(s["n"] - box["n0"]), 1)
        s["abfahrten"] = departures.get(sid, [])
        out_stops.append(s)

    # 6. Fahrten mit Linienverlauf für die Bus-Animation (optional, Feed "mit Linienverlauf", ODbL)
    fahrten, verlaeufe, shape_info = [], {}, None
    if SHAPES_ZIP.exists():
        fahrten, verlaeufe, shape_info = build_trips(SHAPES_ZIP, trip_stops, trips, routes, out_stops, trip_masks, area, tr, box)
        print(f"Fahrten mit Verlauf: {len(fahrten)}, Verläufe: {len(verlaeufe)}")

    out = {
        "ebene": "Bus und Bahn (Soll-Fahrplan)",
        "hinweis": "Soll-Fahrplandaten, keine Echtzeit. Abfahrtszeiten in Sekunden ab Betriebstag-Mitternacht (Ortszeit), Tage als Bitmaske über den Zeitraum.",
        "zeitraum": {"von": day_list[0], "bis": day_list[-1], "tage": day_list},
        "koordinaten": "x/zz lokal wie buildings.json, z = Höhe aus dem dargestellten Gelände",
        "linien": routes,
        "haltestellen": out_stops,
        "fahrten": fahrten,
        "verlaeufe": verlaeufe,
        "verlauf_quelle": shape_info,
        "quelle": {
            "titel": "Gebündelte Soll-Fahrplandaten Baden-Württemberg ohne Linienverlauf (GTFS), NVBW Nahverkehrsgesellschaft Baden-Württemberg mbH über MobiData BW",
            "datensatz": DATASET, "download": URL,
            "lizenz": {"name": "Datenlizenz Deutschland – Namensnennung – Version 2.0", "url": "https://www.govdata.de/dl-de/by-2-0",
                       "namensnennung": "Datenquelle: MobiData BW / NVBW, dl-de/by-2-0"},
            "feed_info": {k: v for k, v in feed_info.items() if k in ("feed_publisher_name", "feed_version", "feed_start_date", "feed_end_date")},
            "datei_sha256": hashlib.sha256(ZIP.read_bytes()).hexdigest(), "datei_bytes": ZIP.stat().st_size,
            "verarbeitet_am": common.now_iso(),
        },
    }
    (common.WEB_DATA / "transit.json").write_text(json.dumps(out, ensure_ascii=False, separators=(",", ":")) + "\n", encoding="utf-8")
    doc = common.load_sources()
    doc["downloads"]["bwgesamt.zip"] = {"produkt": "gtfs", "titel": out["quelle"]["titel"], "url": URL, "bytes": ZIP.stat().st_size, "sha256": out["quelle"]["datei_sha256"],
                                        "heruntergeladen_am": common.now_iso(), "lizenz": "https://www.govdata.de/dl-de/by-2-0"}
    doc["ebenen"]["bus_bahn"] = {"ebene": out["ebene"], "haltestellen": len(out_stops), "linien": len(routes), "zeitraum": [day_list[0], day_list[-1]],
                                 "feed_version": feed_info.get("feed_version"), "abfahrten_gesamt": sum(len(s["abfahrten"]) for s in out_stops)}
    common.save_sources(doc)
    print(f"Bus und Bahn: {len(out_stops)} Haltestellen, {len(routes)} Linien ({', '.join(sorted({r['name'] for r in routes.values()}))}), "
          f"{sum(len(s['abfahrten']) for s in out_stops)} Abfahrtsmuster, Feed {feed_info.get('feed_version')}, JSON {(common.WEB_DATA / 'transit.json').stat().st_size:,} B")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
