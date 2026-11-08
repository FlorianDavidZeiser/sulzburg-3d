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
    for trip_id, halts in trip_stops.items():
        t = trips.get(trip_id)
        if not t:
            continue
        days = service_days.get(t["service"], set())
        if not days:
            continue
        mask = 0
        for d in days:
            mask |= 1 << day_index[d]
        last_seq = max(h[2] for h in halts)
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

    out = {
        "ebene": "Bus und Bahn (Soll-Fahrplan)",
        "hinweis": "Soll-Fahrplandaten, keine Echtzeit. Abfahrtszeiten in Sekunden ab Betriebstag-Mitternacht (Ortszeit), Tage als Bitmaske über den Zeitraum.",
        "zeitraum": {"von": day_list[0], "bis": day_list[-1], "tage": day_list},
        "koordinaten": "x/zz lokal wie buildings.json, z = Höhe aus dem dargestellten Gelände",
        "linien": routes,
        "haltestellen": out_stops,
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
