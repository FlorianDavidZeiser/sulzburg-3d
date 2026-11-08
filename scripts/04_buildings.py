"""Schritt 4: LoD2-Gebäude (CityGML des LGL) in glTF (GLB) umwandeln.

Phase 1: alle Gebäude im Umgriff der Gemeinde (amtliche Grenze plus Rand aus data/kacheln.json).
Eingabe:  data/raw/LoD2_32_<tile>_2_bw.zip (CityGML 1.0, 1-km-Teilkacheln), data/gemeinde.geojson,
          data/codelisten/*.xml (amtliche AdV-Codelisten für Dachform und Gebäudefunktion)
Ausgabe:  web/data/buildings.glb   indiziertes Mesh, Vertexfarben (COLOR_0), Attribut _BUILDING = Index,
                                    keine Normalen (Flat Shading im Browser)
          web/data/buildings.json  Attribute je Gebäude, Quelle, Datenstand
          data/processed/bodenpunkte.json  Eckpunkte der Bodenflächen (nur für die Validierung)

Darstellungshilfe: Unter jede Bodenfläche wird ein Sockel von --sockel Metern gezogen (Standard 2 m),
damit am Hang zwischen gröber aufgelöstem Gelände und Gebäude kein Spalt entsteht. Der Sockel ist
kein Datum des LGL und wird in buildings.json als solcher ausgewiesen.

Koordinaten im GLB: lokal zum Ausschnittsmittelpunkt, x nach Osten, y = Höhe NHN, z nach Süden.

Aufruf:  python3 -I scripts/04_buildings.py [--count 50] [--sockel 2.0]
"""
from __future__ import annotations

import argparse
import json
import math
import struct
import sys
import zipfile
from pathlib import Path

import importlib.util

import mapbox_earcut
import numpy as np
from lxml import etree
from PIL import Image
from shapely.geometry import Point, shape
from shapely.prepared import prep

sys.path.insert(0, str(Path(__file__).resolve().parent))
import common  # noqa: E402

_spec = importlib.util.spec_from_file_location("ortho03", Path(__file__).resolve().parent / "03_orthophoto.py")
ortho03 = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(ortho03)

ATLAS_PX = 4096      # Kantenlänge eines Dachtextur-Atlas in Pixeln
ATLAS_RES = 0.2      # Bodenauflösung des Luftbilds in Metern
ATLAS_PAD = 2        # Rand in Pixeln je Gebäude

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
    "Sockel": (0.78, 0.76, 0.72),
}


def srgb_to_linear(c: float) -> float:
    return c / 12.92 if c <= 0.04045 else ((c + 0.055) / 1.055) ** 2.4


COLORS_U8 = {k: np.array([round(srgb_to_linear(c) * 255) for c in v] + [255], dtype=np.uint8) for k, v in COLORS.items()}


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
    clean: list[tuple[float, float, float]] = []
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
    """Planares Polygon (Außenring + Löcher) -> (Punkte Nx3, Dreiecksindizes Mx3 mit Umlauf gegen die Außennormale)."""
    outer = rings[0]
    if len(outer) < 3:
        return None
    normal = newell_normal(outer)
    if not np.any(normal):
        return None
    helper = np.array([1.0, 0, 0]) if abs(normal[0]) < 0.9 else np.array([0, 1.0, 0])
    u = np.cross(normal, helper); u /= np.linalg.norm(u)
    v = np.cross(normal, u)
    pts3 = np.array([p for ring in rings for p in ring], dtype=np.float64)
    pts2 = np.column_stack([pts3 @ u, pts3 @ v])
    ends = np.cumsum([len(r) for r in rings]).astype(np.uint32)
    idx = mapbox_earcut.triangulate_float64(pts2, ends)
    if len(idx) == 0:
        return None
    tri = np.asarray(idx, dtype=np.int64).reshape(-1, 3)
    a, b, c = pts3[tri[:, 0]], pts3[tri[:, 1]], pts3[tri[:, 2]]
    flip = (np.cross(b - a, c - a) @ normal) < 0
    tri[flip] = tri[flip][:, [0, 2, 1]]
    return pts3, tri


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
    surfaces = []
    ground_rings = []
    all_pts = []
    containers = [b] + b.findall(".//bldg:BuildingPart", NS)
    for c in containers:
        for bby in c.findall("bldg:boundedBy", NS):
            for surf in bby:
                typ = etree.QName(surf).localname
                for poly in surf.iterfind(".//gml:Polygon", NS):
                    ext = poly.find("gml:exterior/gml:LinearRing", NS)
                    if ext is None:
                        continue
                    rings = [ring_points(ext)]
                    for inner in poly.iterfind("gml:interior/gml:LinearRing", NS):
                        r = ring_points(inner)
                        if len(r) >= 3:
                            rings.append(r)
                    if len(rings[0]) < 3:
                        continue
                    surfaces.append((typ, rings))
                    all_pts.extend(rings[0])
                    if typ == "GroundSurface":
                        ground_rings.append(rings[0])
    if not all_pts:
        return {}
    arr = np.array(all_pts)
    ground_pts = [p for r in ground_rings for p in r]
    g = np.array(ground_pts) if ground_pts else arr
    heights = [float(h.text) for h in b.iterfind(".//bldg:measuredHeight", NS) if h.text]
    roof_types = [r.text for r in b.iterfind(".//bldg:roofType", NS) if r.text]
    mh = text(b, "bldg:measuredHeight")
    return {
        "id": b.get("{http://www.opengis.net/gml}id"),
        "alkis_id": text(b, "core:externalReference/core:externalObject/core:name"),
        "gemeindeschluessel": gen_attr(b, "Gemeindeschluessel"),
        "funktion": text(b, "bldg:function"),
        "dachform": text(b, "bldg:roofType") or (roof_types[0] if roof_types else None),
        "dachformen_teile": sorted(set(roof_types)) if len(set(roof_types)) > 1 else None,
        "hoehe_m": float(mh) if mh else (max(heights) if heights else None),
        "erstellt": text(b, "core:creationDate"),
        "grundriss_aktualitaet": gen_attr(b, "Grundrissaktualitaet"),
        "adresse": address(b),
        "bauteile": len(containers) - 1,
        "e": float(g[:, 0].mean()),
        "n": float(g[:, 1].mean()),
        "z_boden_min": float(g[:, 2].min()),
        "z_boden_max": float(g[:, 2].max()),
        "z_first": float(arr[:, 2].max()),
        "_surfaces": surfaces,
        "_ground_rings": ground_rings,
    }


class MeshBuilder:
    def __init__(self, box: dict, with_uv: bool = False):
        self.box = box
        self.with_uv = with_uv
        self.pos: list[np.ndarray] = []
        self.col: list[np.ndarray] = []
        self.bid: list[np.ndarray] = []
        self.uv: list[np.ndarray] = []
        self.idx: list[np.ndarray] = []
        self.count = 0

    def add(self, pts3: np.ndarray, tri: np.ndarray, color: np.ndarray, building: int, uv: np.ndarray | None = None) -> None:
        local = np.column_stack([pts3[:, 0] - self.box["e0"], pts3[:, 2], -(pts3[:, 1] - self.box["n0"])]).astype(np.float32)
        self.pos.append(local)
        self.col.append(np.tile(color, (len(local), 1)))
        self.bid.append(np.full(len(local), building, dtype=np.float32))
        if self.with_uv:
            self.uv.append(uv.astype(np.float32) if uv is not None else np.zeros((len(local), 2), dtype=np.float32))
        self.idx.append((tri + self.count).astype(np.uint32).ravel())
        self.count += len(local)

    def add_socket(self, ring: list[tuple[float, float, float]], depth: float, building: int) -> int:
        """Senkrechte Flächen von der Bodenkante um `depth` nach unten (Darstellungshilfe)."""
        if len(ring) < 3 or depth <= 0:
            return 0
        r = np.array(ring, dtype=np.float64)
        centroid = r[:, :2].mean(axis=0)
        n = len(r)
        quads = 0
        for i in range(n):
            p0, p1 = r[i], r[(i + 1) % n]
            q0, q1 = p0.copy(), p1.copy()
            q0[2] -= depth; q1[2] -= depth
            pts = np.array([p0, p1, q1, q0])
            tri = np.array([[0, 1, 2], [0, 2, 3]])
            normal = np.cross(pts[1] - pts[0], pts[3] - pts[0])
            mid = (p0[:2] + p1[:2]) / 2
            if np.dot(normal[:2], mid - centroid) < 0:
                tri = tri[:, [0, 2, 1]]
            self.add(pts, tri, COLORS_U8["Sockel"], building)
            quads += 1
        return quads

    def arrays(self):
        uv = np.vstack(self.uv) if self.with_uv and self.uv else None
        return np.vstack(self.pos), np.vstack(self.col), np.concatenate(self.bid), np.concatenate(self.idx), uv

    @property
    def empty(self) -> bool:
        return self.count == 0


def write_glb(path: Path, primitives: list[dict], images: list[str]) -> None:
    """primitives: [{name, positions, colors, ids, indices, uv (optional), texture (Index in images oder None)}]."""
    def pad(b: bytes, n: int = 4, fill: bytes = b"\x00") -> bytes:
        return b + fill * ((n - len(b) % n) % n)

    blobs, views, accessors, prims, materials = [], [], [], [], []
    offset = 0

    def add_accessor(arr: np.ndarray, dtype: str, comp: int, typ: str, target: int, normalized=False, minmax=False) -> int:
        nonlocal offset
        blob = arr.astype(dtype).tobytes()
        views.append({"buffer": 0, "byteOffset": offset, "byteLength": len(blob), "target": target})
        acc = {"bufferView": len(views) - 1, "componentType": comp, "type": typ, "count": len(arr)}
        if normalized:
            acc["normalized"] = True
        if minmax:
            acc["min"] = arr.min(axis=0).tolist(); acc["max"] = arr.max(axis=0).tolist()
        accessors.append(acc)
        blobs.append(blob)
        offset += len(pad(blob))
        return len(accessors) - 1

    for pr in primitives:
        attrs = {
            "POSITION": add_accessor(pr["positions"], "<f4", 5126, "VEC3", 34962, minmax=True),
            "COLOR_0": add_accessor(pr["colors"], np.uint8, 5121, "VEC4", 34962, normalized=True),
            "_BUILDING": add_accessor(pr["ids"], "<f4", 5126, "SCALAR", 34962),
        }
        if pr.get("uv") is not None:
            attrs["TEXCOORD_0"] = add_accessor(pr["uv"], "<f4", 5126, "VEC2", 34962)
        idx_acc = add_accessor(pr["indices"], "<u4", 5125, "SCALAR", 34963)
        mat = {"name": pr["name"], "doubleSided": False, "pbrMetallicRoughness": {"baseColorFactor": [1, 1, 1, 1], "metallicFactor": 0.0, "roughnessFactor": 0.9}}
        if pr.get("texture") is not None:
            mat["pbrMetallicRoughness"]["baseColorTexture"] = {"index": pr["texture"]}
        materials.append(mat)
        prims.append({"attributes": attrs, "indices": idx_acc, "material": len(materials) - 1, "mode": 4, "extras": {"name": pr["name"]}})
    bin_chunk = b"".join(pad(b) for b in blobs)
    gltf = {
        "asset": {"version": "2.0", "generator": "sulzburg-3d scripts/04_buildings.py", "copyright": common.LICENSE["namensnennung"]},
        "scene": 0, "scenes": [{"nodes": [0]}], "nodes": [{"mesh": 0, "name": "LoD2 Gebaeude"}],
        "meshes": [{"name": "buildings", "primitives": prims}],
        "materials": materials,
        "buffers": [{"byteLength": len(bin_chunk)}], "bufferViews": views, "accessors": accessors,
    }
    if images:
        gltf["images"] = [{"uri": name} for name in images]
        gltf["samplers"] = [{"magFilter": 9729, "minFilter": 9987, "wrapS": 33071, "wrapT": 33071}]
        gltf["textures"] = [{"source": i, "sampler": 0} for i in range(len(images))]
    json_chunk = pad(json.dumps(gltf, separators=(",", ":")).encode("utf-8"), 4, b" ")
    total = 12 + 8 + len(json_chunk) + 8 + len(bin_chunk)
    with path.open("wb") as fh:
        fh.write(struct.pack("<III", 0x46546C67, 2, total))
        fh.write(struct.pack("<II", len(json_chunk), 0x4E4F534A)); fh.write(json_chunk)
        fh.write(struct.pack("<II", len(bin_chunk), 0x004E4942)); fh.write(bin_chunk)


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--count", type=int, default=0, help="nur die N dem Marktplatz nächsten Gebäude (0 = alle im Umgriff)")
    ap.add_argument("--sockel", type=float, default=2.0, help="Sockeltiefe unter der Bodenfläche in Metern (0 = kein Sockel)")
    ap.add_argument("--ohne-dachtextur", action="store_true", help="Dächer einfarbig statt mit Luftbild")
    ap.add_argument("--quality", type=int, default=85, help="JPEG-Qualität der Dachtextur-Atlanten")
    args = ap.parse_args()

    box = common.aoi()
    roof_names = load_codelist(common.ROOT / "data" / "codelisten" / "RoofTypeTypeAdV.xml")
    func_names = load_codelist(common.ROOT / "data" / "codelisten" / "BuildingFunctionTypeAdV.xml")

    gemeinde = json.loads((common.ROOT / "data" / "gemeinde.geojson").read_text(encoding="utf-8"))
    kacheln = json.loads((common.ROOT / "data" / "kacheln.json").read_text(encoding="utf-8"))
    gemeinde_geom = shape(gemeinde["features"][0]["geometry"])
    area = gemeinde_geom.buffer(kacheln["rand_m"])
    area_prep = prep(area)
    gemeinde_prep = prep(gemeinde_geom)
    bounds = area.bounds
    gemeinde_namen = kacheln.get("gemeinden_im_umgriff", {})

    doc = common.load_sources()
    zips = [common.RAW / name for name, d in doc["downloads"].items() if d["produkt"] == "lod2"]
    if not zips:
        sys.exit("Kein LoD2-Download protokolliert. Erst scripts/01_download.py ausführen.")

    buildings, used_files, info_text = [], [], None
    for zpath in sorted(zips):
        with zipfile.ZipFile(zpath) as z:
            for name in z.namelist():
                if "INFO_OpenData" in name and info_text is None:
                    info_text = z.read(name).decode("cp1252", "replace")
                if not name.lower().endswith(".gml"):
                    continue
                root = etree.fromstring(z.read(name))
                env = root.find("gml:boundedBy/gml:Envelope", NS)
                if env is not None:
                    lo = [float(v) for v in env.find("gml:lowerCorner", NS).text.split()]
                    hi = [float(v) for v in env.find("gml:upperCorner", NS).text.split()]
                    if hi[0] <= bounds[0] or lo[0] >= bounds[2] or hi[1] <= bounds[1] or lo[1] >= bounds[3]:
                        continue
                used_files.append(name)
                for b in root.iterfind(".//core:cityObjectMember/bldg:Building", NS):
                    rec = parse_building(b)
                    if not rec:
                        continue
                    p = Point(rec["e"], rec["n"])
                    if not area_prep.contains(p):
                        continue
                    rec["in_gemeinde"] = bool(gemeinde_prep.contains(p))
                    rec["gemeinde"] = gemeinde_namen.get(rec["gemeindeschluessel"] or "", None)
                    rec["abstand_m"] = math.hypot(rec["e"] - box["e0"], rec["n"] - box["n0"])
                    buildings.append(rec)
                print(f"gelesen {name}: {len(buildings)} Gebäude bisher")

    n_area = len(buildings)
    buildings.sort(key=lambda r: r["abstand_m"])
    if args.count:
        buildings = buildings[: args.count]

    # --- Dachtextur-Atlas: je Gebäude der Luftbildausschnitt über dem Dach (Regalpackung) ---
    use_tex = not args.ohne_dachtextur
    dop = None
    placements: dict[int, tuple[int, int, int, float, float]] = {}  # i -> (atlas, px_x, px_y, e_min, n_max)
    atlases: list[np.ndarray] = []
    if use_tex:
        dop_zips = [common.RAW / n for n, d in doc["downloads"].items() if d["produkt"] == "dop20rgb"]
        if not dop_zips:
            print("WARNUNG: kein DOP20 protokolliert, Dächer bleiben einfarbig", file=sys.stderr)
            use_tex = False
        else:
            dop = ortho03.Dop(dop_zips, cache_size=12)
            rects = []
            for i, rec in enumerate(buildings):
                roof = [p for typ, rings in rec["_surfaces"] if typ == "RoofSurface" for p in rings[0]]
                if not roof:
                    continue
                r = np.array(roof)
                e0, e1 = float(np.floor(r[:, 0].min() / ATLAS_RES) * ATLAS_RES), float(np.ceil(r[:, 0].max() / ATLAS_RES) * ATLAS_RES)
                n0, n1 = float(np.floor(r[:, 1].min() / ATLAS_RES) * ATLAS_RES), float(np.ceil(r[:, 1].max() / ATLAS_RES) * ATLAS_RES)
                w = int(round((e1 - e0) / ATLAS_RES)) + 2 * ATLAS_PAD; h = int(round((n1 - n0) / ATLAS_RES)) + 2 * ATLAS_PAD
                if w > ATLAS_PX or h > ATLAS_PX:
                    continue
                rects.append((h, w, i, e0 - ATLAS_PAD * ATLAS_RES, n1 + ATLAS_PAD * ATLAS_RES))
            rects.sort(key=lambda r: (-r[0], -r[1]))
            # Regalpackung
            a, x, y, shelf_h = 0, 0, 0, 0
            atlases.append(np.zeros((ATLAS_PX, ATLAS_PX, 3), dtype=np.uint8))
            for h, w, i, e_min_i, n_max_i in rects:
                if x + w > ATLAS_PX:
                    x = 0; y += shelf_h; shelf_h = 0
                if y + h > ATLAS_PX:
                    atlases.append(np.zeros((ATLAS_PX, ATLAS_PX, 3), dtype=np.uint8)); a += 1; x = y = shelf_h = 0
                placements[i] = (a, x, y, e_min_i, n_max_i)
                x += w; shelf_h = max(shelf_h, h)
            # Luftbild in der Reihenfolge der Lage lesen, damit der Teilkachel-Cache greift
            for i in sorted(placements, key=lambda i: (buildings[i]["e"] // 1000, buildings[i]["n"] // 1000, buildings[i]["e"])):
                a, px, py, e_min_i, n_max_i = placements[i]
                h, w = next((hh, ww) for hh, ww, ii, *_ in rects if ii == i)
                region, _ = dop.region(e_min_i, n_max_i - h * ATLAS_RES, e_min_i + w * ATLAS_RES, n_max_i)
                atlases[a][py:py + region.shape[0], px:px + region.shape[1]] = region[:h, :w]
            print(f"Dachtexturen: {len(placements)} Gebäude in {len(atlases)} Atlas-Bild(ern) à {ATLAS_PX} px, Luftbild {ATLAS_RES} m")

    walls = MeshBuilder(box)
    roofs = [MeshBuilder(box, with_uv=True) for _ in atlases]
    roofs_plain = MeshBuilder(box)
    n_poly = n_skipped = n_sockel = 0
    for i, rec in enumerate(buildings):
        for typ, rings in rec["_surfaces"]:
            n_poly += 1
            res = triangulate(rings)
            if res is None:
                n_skipped += 1
                continue
            pts3, tri = res
            if typ == "RoofSurface" and i in placements:
                a, px, py, e_min_i, n_max_i = placements[i]
                uv = np.column_stack([(px + (pts3[:, 0] - e_min_i) / ATLAS_RES) / ATLAS_PX, (py + (n_max_i - pts3[:, 1]) / ATLAS_RES) / ATLAS_PX])
                roofs[a].add(pts3, tri, np.array([255, 255, 255, 255], dtype=np.uint8), i, uv)
            elif typ == "RoofSurface":
                roofs_plain.add(pts3, tri, COLORS_U8["RoofSurface"], i)
            else:
                walls.add(pts3, tri, COLORS_U8.get(typ, COLORS_U8["WallSurface"]), i)
        if args.sockel > 0:
            for ring in rec["_ground_rings"]:
                n_sockel += walls.add_socket(ring, args.sockel, i)

    common.WEB_DATA.mkdir(parents=True, exist_ok=True)
    for old in common.WEB_DATA.glob("roofs_*.jpg"):
        old.unlink()
    images = []
    for a, img in enumerate(atlases):
        name = f"roofs_{a}.jpg"
        Image.fromarray(img, "RGB").save(common.WEB_DATA / name, "JPEG", quality=args.quality, optimize=True)
        images.append(name)
    primitives = []
    wp, wc, wb, wi, _ = walls.arrays()
    primitives.append({"name": "walls", "positions": wp, "colors": wc, "ids": wb, "indices": wi})
    for a, rb in enumerate(roofs):
        if rb.empty:
            continue
        rp, rc, rbid, ri, ruv = rb.arrays()
        primitives.append({"name": f"roofs_{a}", "positions": rp, "colors": rc, "ids": rbid, "indices": ri, "uv": ruv, "texture": a})
    if not roofs_plain.empty:
        pp, pc, pb, pi, _ = roofs_plain.arrays()
        primitives.append({"name": "roofs_plain", "positions": pp, "colors": pc, "ids": pb, "indices": pi})
    glb = common.WEB_DATA / "buildings.glb"
    write_glb(glb, primitives, images)
    n_tri = sum(len(p["indices"]) // 3 for p in primitives)
    n_vert = sum(len(p["positions"]) for p in primitives)
    indices = np.zeros(n_tri * 3); positions = np.zeros((n_vert, 3))  # nur für die Kennzahlen unten

    out_list, ground_out = [], []
    for i, rec in enumerate(buildings):
        out_list.append({
            "i": i, "id": rec["id"], "alkis_id": rec["alkis_id"], "adresse": rec["adresse"],
            "gemeinde": rec["gemeinde"], "in_gemeinde": rec["in_gemeinde"],
            "funktion": rec["funktion"], "funktion_name": func_names.get(rec["funktion"] or "", None),
            "dachform": rec["dachform"], "dachform_name": roof_names.get(rec["dachform"] or "", None),
            "dachformen_teile": rec["dachformen_teile"], "hoehe_m": rec["hoehe_m"], "bauteile": rec["bauteile"],
            "erstellt": rec["erstellt"], "grundriss_aktualitaet": rec["grundriss_aktualitaet"],
            "e": round(rec["e"], 2), "n": round(rec["n"], 2),
            "z_boden_min": round(rec["z_boden_min"], 2), "z_boden_max": round(rec["z_boden_max"], 2), "z_first": round(rec["z_first"], 2),
        })
        ground_out.append({"i": i, "punkte": [[round(p[0], 2), round(p[1], 2), round(p[2], 2)] for r in rec["_ground_rings"] for p in r]})

    info_lines = {}
    if info_text:
        for line in info_text.splitlines():
            line = line.replace("�", "").replace("\t", " ").strip(" •-")
            if ":" in line and any(k in line for k in ("Auslesedatum", "Aktualit", "Anzahl der 3D")):
                k, v = line.split(":", 1)
                info_lines[k.strip()] = v.strip()

    n_in = sum(1 for r in buildings if r["in_gemeinde"])
    erstellt = sorted({r["erstellt"] for r in buildings if r["erstellt"]})
    grundriss = sorted({r["grundriss_aktualitaet"] for r in buildings if r["grundriss_aktualitaet"]})
    buildings_json = {
        "ebene": "Gebäude (LoD2)", "datei": "buildings.glb",
        "koordinaten": "lokal: x = E - e0, y = Höhe NHN, z = -(N - n0)", "e0": box["e0"], "n0": box["n0"], "epsg": box["epsg"],
        "anzahl": len(buildings), "anzahl_in_gemeinde": n_in, "anzahl_im_umgriff": n_area,
        "auswahl": (f"die {len(buildings)} dem Marktplatz nächsten Gebäude" if args.count else
                    f"alle {len(buildings)} Gebäude innerhalb der Gemeindegrenze plus {kacheln['rand_m']:.0f} m Rand, davon {n_in} in der Gemeinde Sulzburg"),
        "dachtextur": {"aktiv": use_tex, "atlanten": images, "aufloesung_m": ATLAS_RES, "gebaeude_mit_textur": len(placements),
                       "hinweis": "Luftbild (DOP20) senkrecht auf die LoD2-Dachflächen projiziert. Zeigt echte Dachfarben, Gauben, Solaranlagen und die im Luftbild eingebrannten Schatten des Bildflugs. Fassaden bleiben einfarbig."},
        "sockel_m": args.sockel,
        "sockel_hinweis": "Darstellungshilfe: senkrechte Flächen unter der LoD2-Bodenfläche, damit am Hang kein Spalt zum gröber aufgelösten Gelände entsteht. Kein Datum des LGL.",
        "polygone": n_poly, "polygone_uebersprungen": n_skipped, "sockel_flaechen": n_sockel,
        "dreiecke": len(indices) // 3, "vertices": len(positions),
        "erstellt_von_bis": [erstellt[0], erstellt[-1]] if erstellt else None,
        "grundriss_aktualitaet_von_bis": [grundriss[0], grundriss[-1]] if grundriss else None,
        "quelle": {
            "titel": "3D-Gebäudemodell LoD2 (CityGML), Landesamt für Geoinformation und Landentwicklung Baden-Württemberg (LGL)",
            "portal": common.LICENSE["portal"], "dateien": used_files, "lieferinformation": info_lines,
            "codelisten": {
                "dachform": "AdV RoofTypeTypeAdV.xml (repository.gdi-de.org/schemas/adv/citygml/Codelisten/)",
                "gebaeudefunktion": "AdV BuildingFunctionTypeAdV.xml (repository.gdi-de.org/schemas/adv/citygml/Codelisten/)",
            },
            "gemeindegrenze": gemeinde["quelle"]["titel"] + f", Stand {gemeinde['quelle']['aktualitaet']}",
            "lizenz": common.LICENSE, "verarbeitet_am": common.now_iso(),
        },
        "gebaeude": out_list,
    }
    (common.WEB_DATA / "buildings.json").write_text(json.dumps(buildings_json, ensure_ascii=False, separators=(",", ":")) + "\n", encoding="utf-8")
    proc = common.ROOT / "data" / "processed"
    proc.mkdir(parents=True, exist_ok=True)
    (proc / "bodenpunkte.json").write_text(json.dumps(ground_out, separators=(",", ":")), encoding="utf-8")

    doc["ebenen"]["gebaeude"] = {k: buildings_json[k] for k in ("ebene", "anzahl", "anzahl_in_gemeinde", "anzahl_im_umgriff", "auswahl", "sockel_m", "dreiecke", "polygone_uebersprungen", "erstellt_von_bis", "grundriss_aktualitaet_von_bis")}
    doc["ebenen"]["gebaeude"]["dateien"] = used_files
    doc["ebenen"]["gebaeude"]["lieferinformation"] = info_lines
    common.save_sources(doc)
    tex_bytes = sum((common.WEB_DATA / n).stat().st_size for n in images)
    print(f"Gebäude: {len(buildings)} ({n_in} in Sulzburg), {n_poly} Polygone ({n_skipped} übersprungen), {n_sockel} Sockelflächen, "
          f"{len(indices)//3} Dreiecke, {len(positions)} Vertices, GLB {glb.stat().st_size:,} B, Dachtexturen {tex_bytes:,} B, JSON {(common.WEB_DATA / 'buildings.json').stat().st_size:,} B")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
