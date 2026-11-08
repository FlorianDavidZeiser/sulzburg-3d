"""Schritt 4: LoD2-Gebäude (CityGML des LGL) für den Ausschnitt in glTF (GLB) umwandeln.

Eingabe:  data/raw/LoD2_32_<tile>_2_bw.zip (CityGML 1.0, 1-km-Teilkacheln)
          data/codelisten/*.xml (amtliche AdV-Codelisten für Dachform und Gebäudefunktion)
Ausgabe:  web/data/buildings.glb  (ein Mesh, flache Normalen, Vertexfarben, Attribut _BUILDING = Index)
          web/data/buildings.json (Attribute je Gebäude, Auswahl, Quelle, Datenstand)

Koordinaten im GLB: lokal zum Ausschnittsmittelpunkt, x nach Osten, y = Höhe NHN, z nach Süden.

Aufruf:  python3 -I scripts/04_buildings.py [--count 50 | --all]
"""
from __future__ import annotations

import argparse
import json
import math
import struct
import sys
import zipfile
from pathlib import Path

import mapbox_earcut
import numpy as np
from lxml import etree

sys.path.insert(0, str(Path(__file__).resolve().parent))
import common  # noqa: E402

NS = {
    "bldg": "http://www.opengis.net/citygml/building/1.0",
    "gml": "http://www.opengis.net/gml",
    "core": "http://www.opengis.net/citygml/1.0",
    "gen": "http://www.opengis.net/citygml/generics/1.0",
    "xal": "urn:oasis:names:tc:ciq:xsdschema:xAL:2.0",
}

# Farben (sRGB) je Flächentyp; werden für glTF nach linear umgerechnet
COLORS = {
    "RoofSurface": (0.71, 0.36, 0.28),
    "WallSurface": (0.90, 0.88, 0.84),
    "GroundSurface": (0.55, 0.55, 0.55),
    "ClosureSurface": (0.85, 0.83, 0.80),
    "OuterCeilingSurface": (0.80, 0.78, 0.75),
    "OuterFloorSurface": (0.70, 0.68, 0.65),
}


def srgb_to_linear(c: float) -> float:
    return c / 12.92 if c <= 0.04045 else ((c + 0.055) / 1.055) ** 2.4


def load_codelist(path: Path) -> dict[str, str]:
    """AdV-Codeliste (GML Dictionary): Code (gml:name mit codeSpace) -> Bezeichnung."""
    out: dict[str, str] = {}
    if not path.exists():
        return out
    root = etree.parse(str(path)).getroot()
    for d in root.iterfind(".//gml:Definition", NS):
        names = d.findall("gml:name", NS)
        code = next((n.text for n in names if n.get("codeSpace")), None)
        label = next((n.text for n in names if not n.get("codeSpace")), None)
        if code and label:
            out[code.strip()] = label.strip()
    return out


def ring_points(ring) -> list[tuple[float, float, float]]:
    pl = ring.find("gml:posList", NS)
    if pl is not None and pl.text:
        v = [float(t) for t in pl.text.split()]
        pts = [(v[i], v[i + 1], v[i + 2]) for i in range(0, len(v) - 2, 3)]
    else:
        pts = []
        for pos in ring.iterfind("gml:pos", NS):
            v = [float(t) for t in pos.text.split()]
            pts.append((v[0], v[1], v[2]))
    if len(pts) > 1 and pts[0] == pts[-1]:
        pts = pts[:-1]
    # doppelte Folgepunkte entfernen
    clean = []
    for p in pts:
        if not clean or clean[-1] != p:
            clean.append(p)
    return clean


def newell_normal(pts) -> np.ndarray:
    n = np.zeros(3)
    for i in range(len(pts)):
        x1, y1, z1 = pts[i]
        x2, y2, z2 = pts[(i + 1) % len(pts)]
        n[0] += (y1 - y2) * (z1 + z2)
        n[1] += (z1 - z2) * (x1 + x2)
        n[2] += (x1 - x2) * (y1 + y2)
    length = np.linalg.norm(n)
    return n / length if length > 0 else n


def triangulate(rings: list[list[tuple[float, float, float]]]) -> tuple[np.ndarray, np.ndarray] | None:
    """Polygon (Außenring + Löcher, 3D, planar) -> (Dreieckspunkte Nx3, Normale)."""
    outer = rings[0]
    if len(outer) < 3:
        return None
    normal = newell_normal(outer)
    if not np.any(normal):
        return None
    # Basis in der Polygonebene
    helper = np.array([1.0, 0, 0]) if abs(normal[0]) < 0.9 else np.array([0, 1.0, 0])
    u = np.cross(normal, helper); u /= np.linalg.norm(u)
    v = np.cross(normal, u)
    pts3 = np.array([p for ring in rings for p in ring], dtype=np.float64)
    pts2 = np.column_stack([pts3 @ u, pts3 @ v])
    ends = np.cumsum([len(r) for r in rings]).astype(np.uint32)
    idx = mapbox_earcut.triangulate_float64(pts2, ends)
    if len(idx) == 0:
        return None
    tri = pts3[idx].reshape(-1, 3, 3)
    # Umlaufsinn an die Außennormale angleichen (glTF: gegen den Uhrzeigersinn = Vorderseite)
    cross = np.cross(tri[:, 1] - tri[:, 0], tri[:, 2] - tri[:, 0])
    flip = (cross @ normal) < 0
    tri[flip] = tri[flip][:, [0, 2, 1]]
    return tri.reshape(-1, 3), normal


def text(el, path: str):
    f = el.find(path, NS)
    return f.text.strip() if f is not None and f.text else None


def gen_attr(el, name: str):
    for a in el.iterfind("gen:stringAttribute", NS):
        if a.get("name") == name:
            return text(a, "gen:value")
    return None


def address(el):
    ad = el.find("bldg:address", NS)
    if ad is None:
        return None
    street = text(ad, ".//xal:ThoroughfareName")
    number = text(ad, ".//xal:ThoroughfareNumber")
    locality = text(ad, ".//xal:LocalityName")
    plz = text(ad, ".//xal:PostalCodeNumber")
    parts = [" ".join(p for p in (street, number) if p)]
    if plz or locality:
        parts.append(" ".join(p for p in (plz, locality) if p))
    s = ", ".join(p for p in parts if p)
    return s or None


def parse_building(b) -> dict:
    """Ein bldg:Building inkl. BuildingParts -> Attribute und Flächen (Typ, Ringe)."""
    surfaces = []  # (typ, [ring, ring...])
    ground_pts = []
    all_pts = []
    containers = [b] + b.findall(".//bldg:BuildingPart", NS)
    for c in containers:
        for bby in c.findall("bldg:boundedBy", NS):
            for surf in bby:
                typ = etree.QName(surf).localname
                for poly in surf.iterfind(".//gml:Polygon", NS):
                    rings = []
                    ext = poly.find("gml:exterior/gml:LinearRing", NS)
                    if ext is None:
                        continue
                    rings.append(ring_points(ext))
                    for inner in poly.iterfind("gml:interior/gml:LinearRing", NS):
                        r = ring_points(inner)
                        if len(r) >= 3:
                            rings.append(r)
                    if len(rings[0]) < 3:
                        continue
                    surfaces.append((typ, rings))
                    all_pts.extend(rings[0])
                    if typ == "GroundSurface":
                        ground_pts.extend(rings[0])
    if not all_pts:
        return {}
    arr = np.array(all_pts)
    g = np.array(ground_pts) if ground_pts else arr
    heights = [float(h.text) for h in b.iterfind(".//bldg:measuredHeight", NS) if h.text]
    roof_types = [r.text for r in b.iterfind(".//bldg:roofType", NS) if r.text]
    return {
        "id": b.get("{http://www.opengis.net/gml}id"),
        "alkis_id": text(b, "core:externalReference/core:externalObject/core:name"),
        "gemeindeschluessel": gen_attr(b, "Gemeindeschluessel"),
        "funktion": text(b, "bldg:function"),
        "dachform": text(b, "bldg:roofType") or (roof_types[0] if roof_types else None),
        "dachformen_teile": sorted(set(roof_types)) if len(set(roof_types)) > 1 else None,
        "hoehe_m": float(text(b, "bldg:measuredHeight")) if text(b, "bldg:measuredHeight") else (max(heights) if heights else None),
        "erstellt": text(b, "core:creationDate"),
        "grundriss_aktualitaet": gen_attr(b, "Grundrissaktualitaet"),
        "datenquelle_bodenhoehe": gen_attr(b, "DatenquelleBodenhoehe"),
        "datenquelle_dachhoehe": gen_attr(b, "DatenquelleDachhoehe"),
        "adresse": address(b),
        "bauteile": len(containers) - 1,
        "e": float(g[:, 0].mean()),
        "n": float(g[:, 1].mean()),
        "z_boden_min": float(g[:, 2].min()),
        "z_boden_max": float(g[:, 2].max()),
        "z_first": float(arr[:, 2].max()),
        "_surfaces": surfaces,
        "_ground": [tuple(map(float, p)) for p in ground_pts],
    }


def write_glb(path: Path, positions: np.ndarray, normals: np.ndarray, colors: np.ndarray, ids: np.ndarray) -> None:
    def pad(b: bytes, n: int = 4, fill: bytes = b"\x00") -> bytes:
        return b + fill * ((n - len(b) % n) % n)

    blobs = [positions.astype("<f4").tobytes(), normals.astype("<f4").tobytes(),
             colors.astype("<f4").tobytes(), ids.astype("<f4").tobytes()]
    views, accessors, offset = [], [], 0
    count = len(positions)
    specs = [("VEC3", True), ("VEC3", False), ("VEC3", False), ("SCALAR", False)]
    for blob, (typ, with_minmax) in zip(blobs, specs):
        views.append({"buffer": 0, "byteOffset": offset, "byteLength": len(blob), "target": 34962})
        acc = {"bufferView": len(views) - 1, "componentType": 5126, "count": count, "type": typ}
        if with_minmax:
            acc["min"] = [float(v) for v in positions.min(axis=0)]
            acc["max"] = [float(v) for v in positions.max(axis=0)]
        accessors.append(acc)
        offset += len(pad(blob))
    bin_chunk = b"".join(pad(b) for b in blobs)
    gltf = {
        "asset": {"version": "2.0", "generator": "sulzburg-3d scripts/04_buildings.py",
                  "copyright": common.LICENSE["namensnennung"]},
        "scene": 0,
        "scenes": [{"nodes": [0]}],
        "nodes": [{"mesh": 0, "name": "LoD2 Gebaeude"}],
        "meshes": [{"name": "buildings", "primitives": [{
            "attributes": {"POSITION": 0, "NORMAL": 1, "COLOR_0": 2, "_BUILDING": 3},
            "material": 0, "mode": 4}]}],
        "materials": [{"name": "lod2", "doubleSided": False,
                       "pbrMetallicRoughness": {"baseColorFactor": [1, 1, 1, 1], "metallicFactor": 0.0, "roughnessFactor": 0.9}}],
        "buffers": [{"byteLength": len(bin_chunk)}],
        "bufferViews": views,
        "accessors": accessors,
    }
    json_chunk = pad(json.dumps(gltf, separators=(",", ":")).encode("utf-8"), 4, b" ")
    total = 12 + 8 + len(json_chunk) + 8 + len(bin_chunk)
    with path.open("wb") as fh:
        fh.write(struct.pack("<III", 0x46546C67, 2, total))
        fh.write(struct.pack("<II", len(json_chunk), 0x4E4F534A)); fh.write(json_chunk)
        fh.write(struct.pack("<II", len(bin_chunk), 0x004E4942)); fh.write(bin_chunk)


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--count", type=int, default=common.BUILDING_COUNT, help="Anzahl der dem Mittelpunkt nächsten Gebäude")
    ap.add_argument("--all", action="store_true", help="alle Gebäude im Ausschnitt")
    args = ap.parse_args()

    box = common.aoi()
    roof_names = load_codelist(common.ROOT / "data" / "codelisten" / "RoofTypeTypeAdV.xml")
    func_names = load_codelist(common.ROOT / "data" / "codelisten" / "BuildingFunctionTypeAdV.xml")

    doc = common.load_sources()
    zips = [common.RAW / name for name, d in doc["downloads"].items() if d["produkt"] == "lod2"]
    if not zips:
        sys.exit("Kein LoD2-Download protokolliert. Erst scripts/01_download.py ausführen.")

    buildings, used_files, info_text = [], [], None
    gemeinden = set()
    for zpath in zips:
        with zipfile.ZipFile(zpath) as z:
            for name in z.namelist():
                if name.lower().endswith("info_opendata_lod2_2026.txt") or ("INFO_OpenData" in name):
                    info_text = z.read(name).decode("cp1252", "replace")
                if not name.lower().endswith(".gml"):
                    continue
                root = etree.fromstring(z.read(name))
                env = root.find("gml:boundedBy/gml:Envelope", NS)
                if env is not None:
                    lo = [float(v) for v in env.find("gml:lowerCorner", NS).text.split()]
                    hi = [float(v) for v in env.find("gml:upperCorner", NS).text.split()]
                    if hi[0] <= box["e_min"] or lo[0] >= box["e_max"] or hi[1] <= box["n_min"] or lo[1] >= box["n_max"]:
                        continue
                print(f"lese {name}")
                used_files.append(name)
                for b in root.iterfind(".//core:cityObjectMember/bldg:Building", NS):
                    rec = parse_building(b)
                    if not rec:
                        continue
                    if rec["gemeindeschluessel"]:
                        gemeinden.add(rec["gemeindeschluessel"])
                    if box["e_min"] <= rec["e"] <= box["e_max"] and box["n_min"] <= rec["n"] <= box["n_max"]:
                        rec["abstand_m"] = math.hypot(rec["e"] - box["e0"], rec["n"] - box["n0"])
                        buildings.append(rec)

    n_in_aoi = len(buildings)
    buildings.sort(key=lambda r: r["abstand_m"])
    if not args.all:
        buildings = buildings[: args.count]
    radius = max(r["abstand_m"] for r in buildings) if buildings else 0

    pos, nrm, col, ids = [], [], [], []
    n_poly, n_skipped = 0, 0
    for i, rec in enumerate(buildings):
        for typ, rings in rec["_surfaces"]:
            res = triangulate(rings)
            n_poly += 1
            if res is None:
                n_skipped += 1
                continue
            tri, normal = res
            local = np.column_stack([tri[:, 0] - box["e0"], tri[:, 2], -(tri[:, 1] - box["n0"])])
            # Normale ins lokale System (x=E, y=Z, z=-N)
            ln = np.array([normal[0], normal[2], -normal[1]])
            c = np.array([srgb_to_linear(v) for v in COLORS.get(typ, COLORS["WallSurface"])])
            pos.append(local)
            nrm.append(np.tile(ln, (len(local), 1)))
            col.append(np.tile(c, (len(local), 1)))
            ids.append(np.full(len(local), i, dtype=np.float32))
    positions = np.vstack(pos); normals = np.vstack(nrm); colors = np.vstack(col); bid = np.concatenate(ids)

    common.WEB_DATA.mkdir(parents=True, exist_ok=True)
    glb = common.WEB_DATA / "buildings.glb"
    write_glb(glb, positions, normals, colors, bid)

    out_list = []
    for i, rec in enumerate(buildings):
        out_list.append({
            "i": i,
            "id": rec["id"],
            "alkis_id": rec["alkis_id"],
            "adresse": rec["adresse"],
            "funktion": rec["funktion"],
            "funktion_name": func_names.get(rec["funktion"] or "", None),
            "dachform": rec["dachform"],
            "dachform_name": roof_names.get(rec["dachform"] or "", None),
            "dachformen_teile": rec["dachformen_teile"],
            "hoehe_m": rec["hoehe_m"],
            "bauteile": rec["bauteile"],
            "erstellt": rec["erstellt"],
            "grundriss_aktualitaet": rec["grundriss_aktualitaet"],
            "e": round(rec["e"], 2), "n": round(rec["n"], 2),
            "z_boden_min": round(rec["z_boden_min"], 2), "z_boden_max": round(rec["z_boden_max"], 2),
            "z_first": round(rec["z_first"], 2),
            "abstand_m": round(rec["abstand_m"], 1),
            "bodenpunkte": [[round(p[0], 2), round(p[1], 2), round(p[2], 2)] for p in rec["_ground"]],
        })

    info_lines = {}
    if info_text:
        for line in info_text.splitlines():
            line = line.replace("�", "").replace("\t", " ").strip(" •-")
            if ":" in line and any(k in line for k in ("Auslesedatum", "Aktualit", "Anzahl der 3D")):
                k, v = line.split(":", 1)
                info_lines[k.strip()] = v.strip()

    buildings_json = {
        "ebene": "Gebäude (LoD2)",
        "datei": "buildings.glb",
        "koordinaten": "lokal: x = E - e0, y = Höhe NHN, z = -(N - n0)",
        "e0": box["e0"], "n0": box["n0"], "epsg": box["epsg"],
        "anzahl": len(buildings),
        "anzahl_im_ausschnitt": n_in_aoi,
        "auswahl": ("alle Gebäude im Ausschnitt" if args.all else
                    f"die {len(buildings)} dem Marktplatz nächsten Gebäude (Radius {radius:.0f} m) von {n_in_aoi} im Ausschnitt"),
        "polygone": n_poly, "polygone_uebersprungen": n_skipped, "dreiecke": len(positions) // 3,
        "gemeindeschluessel": sorted(gemeinden),
        "quelle": {
            "titel": "3D-Gebäudemodell LoD2 (CityGML), Landesamt für Geoinformation und Landentwicklung Baden-Württemberg (LGL)",
            "portal": common.LICENSE["portal"],
            "dateien": used_files,
            "lieferinformation": info_lines,
            "codelisten": {
                "dachform": "AdV RoofTypeTypeAdV.xml (repository.gdi-de.org/schemas/adv/citygml/Codelisten/)",
                "gebaeudefunktion": "AdV BuildingFunctionTypeAdV.xml (repository.gdi-de.org/schemas/adv/citygml/Codelisten/)",
            },
            "lizenz": common.LICENSE,
            "verarbeitet_am": common.now_iso(),
        },
        "gebaeude": out_list,
    }
    (common.WEB_DATA / "buildings.json").write_text(json.dumps(buildings_json, ensure_ascii=False, indent=1) + "\n", encoding="utf-8")

    doc["ebenen"]["gebaeude"] = {k: buildings_json[k] for k in ("ebene", "anzahl", "anzahl_im_ausschnitt", "auswahl", "dreiecke", "polygone_uebersprungen")}
    doc["ebenen"]["gebaeude"]["dateien"] = used_files
    doc["ebenen"]["gebaeude"]["lieferinformation"] = info_lines
    common.save_sources(doc)
    print(f"Gebäude: {len(buildings)} von {n_in_aoi} im Ausschnitt, Radius {radius:.0f} m, "
          f"{n_poly} Polygone ({n_skipped} übersprungen), {len(positions)//3} Dreiecke, GLB {glb.stat().st_size:,} B")
    print("Lieferinformation:", info_lines)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
