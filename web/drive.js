// Fahrmodus „Fahren“ (Spielmodus, kein echter Verkehr), Stufe 2.
// Wird erst beim ersten Absetzen geladen (dynamischer Import in app.js). Die normale Ansicht bleibt unverändert:
// beim Einsteigen wird die Ansicht gespeichert, beim Aussteigen fliegt die Kamera exakt dorthin zurück und alle
// Einstellungen (Schatten, Gelände, Bäume, parkende Autos) werden zurückgesetzt.
// Daten (scripts/14_drive.py, 15_drive_tiles.py): Fahrnetz aus OpenStreetMap (ODbL), Grundrisse aus LoD2,
// Fahrkacheln aus DGM1 und DOP20 des LGL (dl-de/by-2-0). Automodell: Kenney Car Kit (CC0).
import { GLTFLoader } from "three/addons/loaders/GLTFLoader.js";
import { createFineTerrain } from "./drive_tiles.js";

const CELL = 16;                  // Rasterweite des Suchgitters (m)
const SPUR_ZUGABE = 1.5;          // befahrbare Spur je Seite breiter als die Fahrbahn: OSM-Achsen liegen 1 bis 3 m neben dem Luftbild
const R_AUTO = 0.97;              // Radius der Kollisionskreise des Autos (m)
const KREISE = [1.2, 0, -1.2];    // Kreismittelpunkte entlang der Fahrzeugachse, vorn positiv
const R_PARK = 0.95;              // Kollisionskreise der parkenden Autos
const RADSTAND = 2.7, SPUR = 1.64, RAD_R = 0.33;
const VMAX = 27.8;                // 100 km/h, überall gleich (keine Drosselung auf Wegen oder im Gelände)
const VMAX_RUECK = 5.5;
const QUER_MAX = 9;               // höchste Querbeschleunigung beim Lenken (m/s²), begrenzt den Lenkeinschlag bei Tempo
const FLUG_MS = 1500;
// Qualitätsstufen im Fahrmodus: Radius der Fahrkacheln (m), halbe Kantenlänge der Schattenbox (m); Stufe 0 wie Erkunden
const QUALI = [{ name: "niedrig", fein: 0, schatten: 0 }, { name: "mittel", fein: 80, schatten: 220 }, { name: "hoch", fein: 130, schatten: 150 }];
const ART_NAME = { secondary: "Landstraße", tertiary: "Kreisstraße", tertiary_link: "Zufahrt", unclassified: "Verbindungsstraße", residential: "Wohnstraße",
  living_street: "Verkehrsberuhigter Bereich", service: "Erschließungsweg", track: "Feld- oder Waldweg" };
const BAUM_MIN_H = 6;             // Bäume ab dieser Höhe sind abseits der Straße Hindernisse

const EMPTY = [];
class Grid {
  constructor() { this.cells = new Map(); }
  static key(i, j) { return (i + 4096) * 8192 + (j + 4096); }
  add(x0, z0, x1, z1, id) {
    const i0 = Math.floor(x0 / CELL), i1 = Math.floor(x1 / CELL), j0 = Math.floor(z0 / CELL), j1 = Math.floor(z1 / CELL);
    for (let i = i0; i <= i1; i++) for (let j = j0; j <= j1; j++) {
      const k = Grid.key(i, j); let a = this.cells.get(k);
      if (!a) this.cells.set(k, (a = []));
      a.push(id);
    }
  }
  at(x, z) { return this.cells.get(Grid.key(Math.floor(x / CELL), Math.floor(z / CELL))) || EMPTY; }
}

async function fetchJson(url) { const r = await fetch(url); if (!r.ok) throw new Error(`${url}: ${r.status}`); return r.json(); }

function buildWorld(net, fp, ctx) {
  // Straßen als Kapseln (Segment plus halbe Breite)
  const ax = [], az = [], bx = [], bz = [], half = [], way = [];
  const roads = new Grid();
  net.wege.forEach((w, wi) => {
    const h = w[2] / 20 + SPUR_ZUGABE;
    for (let k = 4; k + 3 < w.length; k += 2) {
      const id = ax.length;
      ax.push(w[k]); az.push(w[k + 1]); bx.push(w[k + 2]); bz.push(w[k + 3]); half.push(h); way.push(wi);
      const m = h + 4;
      roads.add(Math.min(w[k], w[k + 2]) - m, Math.min(w[k + 1], w[k + 3]) - m, Math.max(w[k], w[k + 2]) + m, Math.max(w[k + 1], w[k + 3]) + m, id);
    }
  });
  const seg = { ax: Float32Array.from(ax), az: Float32Array.from(az), bx: Float32Array.from(bx), bz: Float32Array.from(bz), half: Float32Array.from(half), way: Int32Array.from(way) };
  // Parkplätze als Flächen
  const parks = net.parkplaetze.map((f) => {
    const xs = [], zs = [];
    for (let k = 0; k + 1 < f.length; k += 2) { xs.push(f[k]); zs.push(f[k + 1]); }
    return { xs, zs };
  });
  const parkGrid = new Grid();
  parks.forEach((p, i) => parkGrid.add(Math.min(...p.xs) - 4, Math.min(...p.zs) - 4, Math.max(...p.xs) + 4, Math.max(...p.zs) + 4, i));
  // Gebäudekanten aus den LoD2-Bodenflächen. Brücken (LoD2-Funktion 53001_1800) sind keine Wand, sondern Fahrbahn auf Höhe der Oberkante.
  const geb = ctx.meta.buildings.gebaeude;
  const isBridge = (b) => geb[b] && geb[b].funktion === "53001_1800";
  const decks = [], deckGrid = new Grid();
  for (const r of fp.ringe) {
    if (!isBridge(r[0])) continue;
    const xs = [], zs = []; for (let k = 1; k + 1 < r.length; k += 2) { xs.push(r[k]); zs.push(r[k + 1]); }
    deckGrid.add(Math.min(...xs), Math.min(...zs), Math.max(...xs), Math.max(...zs), decks.length);
    decks.push({ xs, zs, top: geb[r[0]].z_first });
  }
  const ex = [], ez = [], fx = [], fz = [], eb = [];
  const edges = new Grid();
  for (const r of fp.ringe) {
    if (isBridge(r[0])) continue;
    const b = r[0], n = (r.length - 1) / 2;
    for (let k = 0; k < n; k++) {
      const x0 = r[1 + k * 2], z0 = r[2 + k * 2], x1 = r[1 + ((k + 1) % n) * 2], z1 = r[2 + ((k + 1) % n) * 2];
      const id = ex.length;
      ex.push(x0); ez.push(z0); fx.push(x1); fz.push(z1); eb.push(b);
      edges.add(Math.min(x0, x1) - 3, Math.min(z0, z1) - 3, Math.max(x0, x1) + 3, Math.max(z0, z1) + 3, id);
    }
  }
  const edge = { ax: Float32Array.from(ex), az: Float32Array.from(ez), bx: Float32Array.from(fx), bz: Float32Array.from(fz), b: Int32Array.from(eb) };
  // Ringe je Gebäude für den Innen-Test (gerade-ungerade über alle Ringe eines Gebäudes, Innenhöfe zählen als außen)
  const rings = fp.ringe.filter((r) => !isBridge(r[0])).map((r) => { const xs = [], zs = []; for (let k = 1; k + 1 < r.length; k += 2) { xs.push(r[k]); zs.push(r[k + 1]); } return { b: r[0], xs, zs }; });
  const ringGrid = new Grid();
  rings.forEach((r, i) => ringGrid.add(Math.min(...r.xs), Math.min(...r.zs), Math.max(...r.xs), Math.max(...r.zs), i));
  const tops = Float32Array.from(ctx.meta.buildings.gebaeude.map((g) => g.z_first ?? (g.z_boden_max + (g.hoehe_m || 8))));
  // Parkende Autos (Momentaufnahme Luftbild) als zwei Kreise je Auto
  const pc = [], pcGrid = new Grid();
  for (const [x, z, yaw] of ctx.meta.cars?.autos || []) {
    const dx = Math.sin(yaw), dz = -Math.cos(yaw);
    for (const o of [-1.2, 1.2]) { const id = pc.length / 2; pc.push(x + dx * o, z + dz * o); pcGrid.add(x + dx * o - 3, z + dz * o - 3, x + dx * o + 3, z + dz * o + 3, id); }
  }
  return { net, seg, roads, parks, parkGrid, edge, edges, tops, rings, ringGrid, decks, deckGrid, pc: Float32Array.from(pc), pcGrid };
}

function pointInPoly(xs, zs, x, z) {
  let inside = false;
  for (let i = 0, j = xs.length - 1; i < xs.length; j = i++) {
    if ((zs[i] > z) !== (zs[j] > z) && x < ((xs[j] - xs[i]) * (z - zs[i])) / (zs[j] - zs[i]) + xs[i]) inside = !inside;
  }
  return inside;
}

// Abstand eines Punkts zur Strecke a-b; schreibt den nächsten Punkt nach out
function closest(px, pz, ax, az, bx, bz, out) {
  const dx = bx - ax, dz = bz - az, L2 = dx * dx + dz * dz;
  let t = L2 > 0 ? ((px - ax) * dx + (pz - az) * dz) / L2 : 0;
  t = t < 0 ? 0 : t > 1 ? 1 : t;
  out.x = ax + dx * t; out.z = az + dz * t; out.t = t;
  return Math.hypot(px - out.x, pz - out.z);
}

function buildCarModel(THREE, color, ghost = false) {
  const g = new THREE.Group();
  const mat = (o) => {
    const m = new THREE.MeshStandardMaterial(o);
    if (ghost) { m.transparent = true; m.opacity = 0.55; m.depthWrite = false; }
    return m;
  };
  const paint = mat({ color, roughness: 0.35, metalness: 0.25 });
  const glass = mat({ color: 0x2b3b4e, roughness: 0.18, metalness: 0.05 });
  const dark = mat({ color: 0x16181c, roughness: 0.85 });
  const rimM = mat({ color: 0xb9bdc4, roughness: 0.35, metalness: 0.7 });
  const head = mat({ color: 0xfff6dd, emissive: 0xfff0c8, emissiveIntensity: 0.5 });
  const tail = mat({ color: 0x7a0d10, emissive: 0xff1a1a, emissiveIntensity: 0.35 });
  // Seitenprofil in (Länge, Höhe), vorn bei negativem z, über die Breite extrudiert; Radläufe als Bögen
  // bevel: Rundung der Seitenkanten (über die Breite), size: Rundung im Profil
  const extrude = (shape, width, bevel, size) => {
    const geo = new THREE.ExtrudeGeometry(shape, { depth: width - 2 * bevel, bevelEnabled: true, bevelThickness: bevel, bevelSize: size, bevelSegments: 3, curveSegments: 10 });
    geo.rotateY(-Math.PI / 2); geo.translate((width - 2 * bevel) / 2, 0, 0);
    geo.computeVertexNormals();
    return geo;
  };
  const a0 = Math.asin(0.03 / 0.42);
  const body = new THREE.Shape();
  body.moveTo(-2.2, 0.36); body.lineTo(-2.25, 0.58); body.lineTo(-2.12, 0.8); body.lineTo(-0.95, 0.94); body.lineTo(1.6, 0.98);
  body.lineTo(2.2, 0.93); body.lineTo(2.26, 0.62); body.lineTo(2.2, 0.36); body.lineTo(1.77, 0.36);
  body.absarc(1.35, 0.33, 0.42, a0, Math.PI - a0, false); body.lineTo(-0.93, 0.36);
  body.absarc(-1.35, 0.33, 0.42, a0, Math.PI - a0, false); body.closePath();
  const bodyMesh = new THREE.Mesh(extrude(body, 1.76, 0.13, 0.05), paint);
  const cabin = new THREE.Shape();
  cabin.moveTo(-0.98, 0.92); cabin.lineTo(-0.3, 1.38); cabin.lineTo(0.95, 1.4); cabin.lineTo(1.64, 0.96); cabin.lineTo(1.64, 0.92); cabin.closePath();
  const cabinMesh = new THREE.Mesh(extrude(cabin, 1.54, 0.1, 0.03), glass);
  const roof = new THREE.Mesh(new THREE.BoxGeometry(1.4, 0.05, 1.16), paint); roof.position.set(0, 1.425, 0.33);
  const grill = new THREE.Mesh(new THREE.BoxGeometry(0.72, 0.13, 0.04), dark); grill.position.set(0, 0.52, -2.3);
  // Säulen zwischen den Scheiben, damit die Kabine nicht wie ein dunkler Block wirkt
  for (const sx of [-1, 1]) for (const [z, y, rx, len] of [[-0.64, 1.15, 0.976, 0.82], [0.25, 1.17, 0, 0.46], [1.295, 1.18, -1.0, 0.82]]) {
    const pil = new THREE.Mesh(new THREE.BoxGeometry(0.06, len, 0.09), paint); pil.position.set(sx * 0.775, y, z); pil.rotation.x = rx; g.add(pil);
  }
  const lights = [];
  for (const s of [-1, 1]) {
    const hl = new THREE.Mesh(new THREE.BoxGeometry(0.34, 0.1, 0.04), head); hl.position.set(s * 0.56, 0.68, -2.285);
    const tl = new THREE.Mesh(new THREE.BoxGeometry(0.34, 0.11, 0.04), tail); tl.position.set(s * 0.56, 0.8, 2.3);
    lights.push(hl, tl);
  }
  g.add(bodyMesh, cabinMesh, roof, grill, ...lights);
  // Räder: Reifen, Felge mit Speichen (sichtbare Drehung), vordere Räder in einem Lenkgelenk
  const tireGeo = new THREE.CylinderGeometry(RAD_R, RAD_R, 0.24, 20).rotateZ(Math.PI / 2);
  const rimGeo = new THREE.CylinderGeometry(0.2, 0.2, 0.25, 12).rotateZ(Math.PI / 2);
  const spokeGeo = new THREE.BoxGeometry(0.255, 0.36, 0.05);
  const wheels = [], pivots = [];
  for (const [sx, sz] of [[-1, -1], [1, -1], [-1, 1], [1, 1]]) {
    const pivot = new THREE.Group(); pivot.position.set(sx * SPUR / 2, RAD_R, sz * RADSTAND / 2);
    const spin = new THREE.Group();
    spin.add(new THREE.Mesh(tireGeo, dark), new THREE.Mesh(rimGeo, rimM));
    const s1 = new THREE.Mesh(spokeGeo, dark), s2 = s1.clone(); s2.rotation.x = Math.PI / 2;
    spin.add(s1, s2);
    pivot.add(spin); g.add(pivot);
    wheels.push(spin); if (sz < 0) pivots.push(pivot);
  }
  g.traverse((o) => { if (o.isMesh) { o.castShadow = !ghost; o.receiveShadow = !ghost; } });
  g.userData = { wheels, steer: pivots, spinSign: -1, radius: RAD_R, tail, head };
  return g;
}

// Kenney Car Kit (CC0): hatchback-sports, gleichmäßig auf 1,5 skaliert (rund 4,3 m lang). Modell schaut nach +z, wird gedreht.
function makeKenney(THREE, root, ghost = false) {
  const g = new THREE.Group();
  root.scale.setScalar(1.5); root.rotation.y = Math.PI; g.add(root);
  root.traverse((o) => {
    if (!o.isMesh) return;
    if (o.material.map) o.material.map.colorSpace = THREE.SRGBColorSpace;
    if (ghost) { o.material = o.material.clone(); o.material.transparent = true; o.material.opacity = 0.55; o.material.depthWrite = false; }
    o.castShadow = !ghost; o.receiveShadow = !ghost;
  });
  const wheels = [], steer = [];
  for (const name of ["wheel-front-left", "wheel-front-right", "wheel-back-left", "wheel-back-right"]) {
    const w = root.getObjectByName(name); if (!w) continue;
    w.rotation.order = "YXZ"; wheels.push(w); if (name.includes("front")) steer.push(w);
  }
  const mat = (o) => new THREE.MeshStandardMaterial(o);
  const head = mat({ color: 0xfff6dd, emissive: 0xfff0c8, emissiveIntensity: 0.4 });
  const tail = mat({ color: 0x7a0d10, emissive: 0xff1a1a, emissiveIntensity: 0.35 });
  if (!ghost) for (const sx of [-1, 1]) {
    const hl = new THREE.Mesh(new THREE.BoxGeometry(0.3, 0.1, 0.04), head); hl.position.set(sx * 0.6, 0.72, -2.14); g.add(hl);
    const tl = new THREE.Mesh(new THREE.BoxGeometry(0.3, 0.1, 0.04), tail); tl.position.set(sx * 0.6, 0.86, 2.14); g.add(tl);
  }
  g.userData = { wheels, steer, spinSign: 1, radius: 0.45, head, tail, kenney: true };
  return g;
}

const CSS = `
#driveHud { position: fixed; left: 50%; transform: translateX(-50%); bottom: var(--dh-bottom, 90px); z-index: 7; pointer-events: auto;
  background: rgba(18,22,28,.84); backdrop-filter: blur(8px); border-radius: 12px; padding: 8px 14px 9px; color: #e8e6e1;
  font: 13px/1.35 system-ui, -apple-system, "Segoe UI", Roboto, sans-serif; text-align: center; min-width: 320px; max-width: calc(100vw - 24px); box-shadow: 0 6px 24px rgba(0,0,0,.35); }
#driveHud .dh-top { display: flex; align-items: baseline; justify-content: center; gap: 14px; }
#driveHud .dh-speed b { font-size: 30px; font-weight: 700; font-variant-numeric: tabular-nums; }
#driveHud .dh-road { font-size: 14px; font-weight: 600; }
#driveHud .dh-road span { font-weight: 400; color: #a9b0ba; font-size: 12px; }
#driveHud .dh-fps { font-size: 11px; color: #a9b0ba; font-variant-numeric: tabular-nums; white-space: nowrap; }
#driveHud .dh-note, #driveHud .dh-keys { font-size: 11px; color: #a9b0ba; margin-top: 2px; }
#driveHud .dh-note b { color: #1a1408; background: #f2b544; border-radius: 4px; padding: 0 5px; font-size: 10px; }
#driveHud .dh-btns { display: flex; gap: 6px; justify-content: center; margin-top: 6px; }
#driveHud button, #driveTouch button { font: inherit; font-size: 12px; color: #e8e6e1; background: #1b2028; border: 1px solid #333a45; border-radius: 6px; padding: 3px 9px; cursor: pointer; }
#driveHud button:hover { border-color: #f2b544; }
#driveToast { position: fixed; left: 50%; top: 18%; transform: translateX(-50%); z-index: 8; pointer-events: none; background: rgba(12,15,20,.92);
  color: #e8e6e1; font: 13px system-ui, sans-serif; padding: 6px 12px; border-radius: 8px; opacity: 0; transition: opacity .25s; }
#driveToast.on { opacity: 1; }
#driveDrag { position: fixed; z-index: 9; pointer-events: none; background: rgba(12,15,20,.92); color: #e8e6e1; font: 12px system-ui, sans-serif;
  padding: 4px 8px; border-radius: 6px; transform: translate(14px, 14px); white-space: nowrap; }
#driveDrag.no { color: #f2b544; }
#driveHud[hidden], #driveTouch[hidden], #driveDrag[hidden] { display: none !important; }
#driveTouch { position: fixed; inset: auto 0 var(--dh-touch, 180px) 0; z-index: 7; pointer-events: none; display: flex; justify-content: space-between; padding: 0 14px; }
#driveTouch div { display: flex; gap: 12px; pointer-events: auto; }
#driveTouch button { width: 66px; height: 66px; border-radius: 50%; font-size: 20px; touch-action: none; user-select: none; -webkit-user-select: none; background: rgba(27,32,40,.85); }
#driveTouch button.on { border-color: #f2b544; background: rgba(60,52,30,.9); }
#driveTouch .joy { position: relative; width: 132px; height: 66px; border-radius: 33px; background: rgba(27,32,40,.85); border: 1px solid #333a45; touch-action: none; }
#driveTouch .joy .knob { position: absolute; left: 41px; top: 8px; width: 50px; height: 50px; border-radius: 50%; background: #e8e6e1; opacity: .85; pointer-events: none; }
#driveHud .dh-btns button.off { color: #a9b0ba; }
@media (max-width: 900px) {
  #driveHud { min-width: 0; width: calc(100vw - 24px); padding: 6px 10px; }
  #driveHud .dh-keys, #driveHud .dh-road span, #driveHud .long { display: none; }
  #driveHud .dh-speed b { font-size: 22px; } #driveHud .dh-note { font-size: 10px; } #driveHud .dh-btns { margin-top: 4px; }
  #driveTouch button { width: 60px; height: 60px; }
}
`;

export async function createDrive(ctx) {
  const { THREE, scene, camera, controls, $ } = ctx;
  const [net, fp] = await Promise.all([fetchJson("data/fahrnetz.json"), fetchJson("data/grundrisse.json")]);
  const W = buildWorld(net, fp, ctx);
  const canvas = ctx.renderer.domElement;
  // Fahrbahnhöhe: dargestellte Geländefläche, auf Brücken deren Oberkante (das DGM enthält keine Brücken).
  // Auf die Brücke kommt das Auto nur, wenn es etwa auf ihrer Höhe ankommt (ref = bisherige Höhe); darunter fährt es durch.
  let fine = null;
  try { fine = await createFineTerrain(ctx); } catch (e) { console.warn("Fahrkacheln nicht verfügbar:", e.message); }
  const surface = (x, z, ref = null) => {
    const g = (fine && fine.heightAt(x, z)) ?? ctx.terrainSurfaceAt(x, z) ?? ctx.terrainHeightAt(x, z) ?? ctx.centerY;
    let h = g;
    for (const di of W.deckGrid.at(x, z)) {
      const D = W.decks[di];
      if (D.top > h && D.top - (ref ?? g) < (ref == null ? 3 : 1.5) && pointInPoly(D.xs, D.zs, x, z)) h = D.top;
    }
    return h;
  };

  // ---------- Anzeige ----------
  const style = document.createElement("style"); style.textContent = CSS; document.head.appendChild(style);
  const hud = document.createElement("div"); hud.id = "driveHud"; hud.hidden = true;
  hud.innerHTML = `<div class="dh-top"><div class="dh-speed"><b id="dhSpeed">0</b> km/h</div><div class="dh-road" id="dhRoad">–</div><div class="dh-fps" id="dhFps"></div></div>` +
    `<div class="dh-note"><b>SPIELMODUS</b> <span class="long">kein echter Verkehr · </span>Straßen © OpenStreetMap-Mitwirkende<span class="long"> (ODbL) · Gebäude LGL</span></div>` +
    `<div class="dh-btns"><button id="dhView">Sicht: Verfolger</button><button id="dhAssist">Spurhilfe: an<span class="long"> (L)</span></button><button id="dhRoads" class="off">Nur Straßen: aus<span class="long"> (F)</span></button><button id="dhExit">Zurück zur Karte<span class="long"> (Esc)</span></button></div>` +
    `<div class="dh-keys">W A S D oder Pfeiltasten · Leertaste Handbremse · R zurück auf die Straße · F nur Straßen · Mausrad Abstand · <span id="dhQ"></span></div>`;
  const toast = document.createElement("div"); toast.id = "driveToast";
  const dragLabel = document.createElement("div"); dragLabel.id = "driveDrag"; dragLabel.hidden = true;
  const touch = document.createElement("div"); touch.id = "driveTouch"; touch.hidden = true;
  touch.innerHTML = `<div><div class="joy" id="dJoy" aria-label="Lenken"><div class="knob"></div></div></div>` +
    `<div><button data-k="down" aria-label="Bremse">■</button><button data-k="up" aria-label="Gas">▲</button></div>`;
  document.body.append(hud, toast, dragLabel, touch);
  let toastTimer = 0;
  const say = (msg, ms = 2600) => { toast.textContent = msg; toast.classList.add("on"); clearTimeout(toastTimer); toastTimer = setTimeout(() => toast.classList.remove("on"), ms); };
  const coarse = "ontouchstart" in window && window.matchMedia && matchMedia("(pointer: coarse)").matches;
  // Anzeige über der Quellenzeile platzieren (die Namensnennung bleibt sichtbar), Touch-Knöpfe darüber
  const placeHud = () => {
    let b = 16;
    for (const el of [$("sources"), $("attrib")]) {
      if (!el || !el.getClientRects().length) continue;
      const r = el.getBoundingClientRect(); if (r.height) b = Math.max(b, innerHeight - r.top + 10);
    }
    document.documentElement.style.setProperty("--dh-bottom", `${Math.round(b)}px`);
    placeTouch();
  };
  let touchB = 0;
  const placeTouch = () => {
    if (hud.hidden) return;
    const b = Math.round(innerHeight - hud.getBoundingClientRect().top + 10);
    if (b !== touchB) { touchB = b; document.documentElement.style.setProperty("--dh-touch", `${b}px`); }
  };

  // ---------- Auto ----------
  let model, ghost;
  try {
    const gltf = await new GLTFLoader().loadAsync("vendor/kenney-car-kit/hatchback-sports.glb");
    model = makeKenney(THREE, gltf.scene.clone(true)); ghost = makeKenney(THREE, gltf.scene.clone(true), true);
  }
  catch (e) { console.warn("Automodell nicht geladen, einfaches Modell:", e.message); model = buildCarModel(THREE, 0xe3b53c); ghost = buildCarModel(THREE, 0xe3b53c, true); }
  ghost.visible = false; scene.add(ghost);
  const car = { x: 0, z: 0, y: 0, yaw: 0, v: 0, steer: 0, spin: 0, n: new THREE.Vector3(0, 1, 0), slope: 0, seg: -1, park: false, off: false, offDist: 0 };
  const input = { up: 0, down: 0, left: 0, right: 0, hand: 0 };
  let state = "off";   // off, enter, drive, leave
  let saved = null, trans = null, view = "chase", chaseDist = 9, hintedEdge = false, hintedOff = false, lastBump = 0, assist = true, onlyRoads = false;
  let trees = null;   // Bäume ab BAUM_MIN_H abseits der Straßen als Hindernisse, beim Einsteigen aus der aktuellen Baumebene
  const params = new URLSearchParams(location.search);
  const fixedQ = params.has("fq") ? Math.max(0, Math.min(2, parseInt(params.get("fq"), 10) || 0)) : null;
  let quality = fixedQ ?? (innerWidth < 900 || (navigator.hardwareConcurrency || 8) <= 4 ? 1 : 2);
  const fpsWin = { t0: 0, n: 0, low: 0 };
  let headlight = null;
  const cam = { pos: new THREE.Vector3(), look: new THREE.Vector3(), yawS: 0 };
  const tmp = { x: 0, z: 0, t: 0 }, field = { d: 0, nx: 0, nz: 0, seg: -1, park: false };
  const v3 = new THREE.Vector3(), v3b = new THREE.Vector3(), lookTmp = new THREE.Vector3();
  const basis = new THREE.Matrix4(), X = new THREE.Vector3(), Y = new THREE.Vector3(), Z = new THREE.Vector3(), F = new THREE.Vector3();

  // Abstandsfeld der befahrbaren Fläche: d < 0 innen, Normale zeigt nach außen
  function roadField(x, z, out) {
    let best = Infinity, nx = 0, nz = 0, bs = -1, park = false;
    const S = W.seg;
    for (const id of W.roads.at(x, z)) {
      const dist = closest(x, z, S.ax[id], S.az[id], S.bx[id], S.bz[id], tmp);
      const d = dist - S.half[id];
      if (d < best) { best = d; bs = id; park = false; if (dist > 1e-6) { nx = (x - tmp.x) / dist; nz = (z - tmp.z) / dist; } }
    }
    for (const pi of W.parkGrid.at(x, z)) {
      const P = W.parks[pi], n = P.xs.length, inside = pointInPoly(P.xs, P.zs, x, z);
      let md = Infinity, cx = 0, cz = 0;
      for (let i = 0, j = n - 1; i < n; j = i++) {
        const dd = closest(x, z, P.xs[j], P.zs[j], P.xs[i], P.zs[i], tmp);
        if (dd < md) { md = dd; cx = tmp.x; cz = tmp.z; }
      }
      const d = inside ? -md : md;
      if (d < best) { best = d; park = true; if (md > 1e-6) { nx = ((x - cx) / md) * (inside ? -1 : 1); nz = ((z - cz) / md) * (inside ? -1 : 1); } }
    }
    out.d = best; out.nx = nx; out.nz = nz; out.seg = bs; out.park = park;
    return out;
  }

  // Nächster Punkt auf dem Fahrnetz (für das Absetzen), mit Fahrtrichtung entlang der Straße
  function nearestRoad(x, z) {
    const S = W.seg; let best = Infinity, r = null;
    for (let id = 0; id < S.ax.length; id++) {
      const d = closest(x, z, S.ax[id], S.az[id], S.bx[id], S.bz[id], tmp);
      if (d < best) { best = d; const L = Math.hypot(S.bx[id] - S.ax[id], S.bz[id] - S.az[id]) || 1; r = { x: tmp.x, z: tmp.z, dx: (S.bx[id] - S.ax[id]) / L, dz: (S.bz[id] - S.az[id]) / L, seg: id, dist: d }; }
    }
    for (const P of W.parks) if (pointInPoly(P.xs, P.zs, x, z)) return { x, z, dx: 1, dz: 0, seg: -1, dist: 0, park: true };
    return r;
  }

  // Liegt ein Punkt in einem Gebäudegrundriss?
  function inBuilding(x, z) {
    const count = new Map();
    for (const ri of W.ringGrid.at(x, z)) { const r = W.rings[ri]; if (pointInPoly(r.xs, r.zs, x, z)) count.set(r.b, (count.get(r.b) || 0) + 1); }
    for (const v of count.values()) if (v % 2) return true;
    return false;
  }
  function anyInBuilding(x, z, yaw) {
    const fx = Math.sin(yaw), fz = -Math.cos(yaw);
    return KREISE.some((o) => inBuilding(x + fx * o, z + fz * o));
  }

  // Kollision der drei Fahrzeugkreise mit Hauswänden und parkenden Autos; liefert die Verschiebung
  const push = { x: 0, z: 0, hit: 0 };
  function bodyPush(x, z, yaw, out) {
    const fx = Math.sin(yaw), fz = -Math.cos(yaw);
    out.x = 0; out.z = 0; out.hit = 0; out.kind = "";
    const E = W.edge, carsOn = $("cars") ? $("cars").checked : true, treesOn = !onlyRoads && trees && (!$("trees") || $("trees").checked);
    for (const o of KREISE) {
      const cx = x + fx * o + out.x, cz = z + fz * o + out.z;
      // je Kreis die tiefste Eindringung (an Ecken folgt die zweite Wand im nächsten Teilschritt)
      let px = 0, pz = 0, pm = 0, kind = "";
      for (const id of W.edges.at(cx, cz)) {
        const d = closest(cx, cz, E.ax[id], E.az[id], E.bx[id], E.bz[id], tmp);
        if (d < R_AUTO && d > 1e-6 && R_AUTO - d > pm) { pm = R_AUTO - d; px = ((cx - tmp.x) / d) * pm; pz = ((cz - tmp.z) / d) * pm; kind = "wand"; }
      }
      if (carsOn) for (const id of W.pcGrid.at(cx, cz)) {
        const dx = cx - W.pc[id * 2], dz = cz - W.pc[id * 2 + 1], d = Math.hypot(dx, dz), R = R_AUTO + R_PARK;
        if (d < R && d > 1e-6 && R - d > pm) { pm = R - d; px = (dx / d) * pm; pz = (dz / d) * pm; kind = "auto"; }
      }
      if (treesOn) for (const id of trees.grid.at(cx, cz)) {
        const dx = cx - trees.x[id], dz = cz - trees.z[id], d = Math.hypot(dx, dz), R = R_AUTO + trees.r[id];
        if (d < R && d > 1e-6 && R - d > pm) { pm = R - d; px = (dx / d) * pm; pz = (dz / d) * pm; kind = "baum"; }
      }
      if (px || pz) { out.kind = out.kind || kind; out.x += px; out.z += pz; out.hit = Math.max(out.hit, Math.abs(fx * px + fz * pz) / (Math.hypot(px, pz) || 1)); }
    }
    return out;
  }

  // Kamera nicht hinter Hauswände: Sichtlinie Auto -> Kamera gegen Grundrisse höherer Gebäude
  function occlusion(ex, ey, ez, cx, cy, cz) {
    const E = W.edge; let tMin = 1;
    const seen = new Set();
    const x0 = Math.min(ex, cx), x1 = Math.max(ex, cx), z0 = Math.min(ez, cz), z1 = Math.max(ez, cz);
    for (let i = Math.floor(x0 / CELL); i <= Math.floor(x1 / CELL); i++) for (let j = Math.floor(z0 / CELL); j <= Math.floor(z1 / CELL); j++) {
      for (const id of W.edges.cells.get(Grid.key(i, j)) || EMPTY) {
        if (seen.has(id)) continue; seen.add(id);
        const rx = cx - ex, rz = cz - ez, sx = E.bx[id] - E.ax[id], sz = E.bz[id] - E.az[id];
        const den = rx * sz - rz * sx; if (Math.abs(den) < 1e-9) continue;
        const qx = E.ax[id] - ex, qz = E.az[id] - ez;
        const t = (qx * sz - qz * sx) / den, u = (qx * rz - qz * rx) / den;
        if (t > 0 && t < tMin && u >= 0 && u <= 1 && W.tops[E.b[id]] > ey + (cy - ey) * t - 0.5) tMin = t;
      }
    }
    return tMin;
  }

  function roadLabel() {
    if (car.off) {
      if (car.seg < 0 || car.offDist > 25) return "Abseits der Straße";
      const w = W.net.wege[W.seg.way[car.seg]];
      return `Abseits der Straße <span>nahe ${w[1] >= 0 ? W.net.namen[w[1]] : ART_NAME[W.net.arten[w[0]]]}</span>`;
    }
    if (car.park) return `Parkplatz <span>öffentlich laut OSM</span>`;
    if (car.seg < 0) return "–";
    const w = W.net.wege[W.seg.way[car.seg]], art = W.net.arten[w[0]];
    const name = w[1] >= 0 ? W.net.namen[w[1]] : ART_NAME[art] || art;
    const extra = [w[1] >= 0 ? ART_NAME[art] : null, w[3] ? `Tempo ${w[3]} laut OSM` : null].filter(Boolean).join(" · ");
    return `${name}${extra ? ` <span>${extra}</span>` : ""}`;
  }

  // Abgleiten an Wand oder Spurrand: n zeigt von der Wand weg. Schräg: Auto dreht sich an der Wand entlang und verliert
  // nur den Anteil des Tempos, der in die Wand ging. Frontal: Auto bleibt stehen.
  function slide(nx, nz) {
    const dir = car.v >= 0 ? 1 : -1;
    const mx = Math.sin(car.yaw) * dir, mz = -Math.cos(car.yaw) * dir;
    const into = mx * nx + mz * nz;
    if (into >= -0.02 || Math.abs(car.v) < 0.05) return 0;
    const cos = -into;
    if (cos > 0.8) { car.v *= 0.5; return cos; }
    let tx = mx - into * nx, tz = mz - into * nz; const L = Math.hypot(tx, tz) || 1; tx /= L; tz /= L;
    const want = Math.atan2(tx * dir, -tz * dir);
    car.yaw += Math.atan2(Math.sin(want - car.yaw), Math.cos(want - car.yaw)) * 0.5;
    car.v *= 1 - 0.22 * cos;
    return cos;
  }

  // Spurhilfe: folgt der Straßenachse laut OSM mit Vorausblick (Pure Pursuit), auf breiten Straßen rechts der Mitte.
  // Lenkt man selbst, ist sie aus; an Kreuzungen gewinnt der Ast, der zur Fahrtrichtung passt.
  const at = { x: 0, z: 0 };
  function assistSteer() {
    const S = W.seg, hx = Math.sin(car.yaw), hz = -Math.cos(car.yaw);
    let best = -1, score = -Infinity, dir = 1;
    for (const id of W.roads.at(car.x, car.z)) {
      const d = closest(car.x, car.z, S.ax[id], S.az[id], S.bx[id], S.bz[id], tmp);
      if (d > S.half[id]) continue;
      const L = Math.hypot(S.bx[id] - S.ax[id], S.bz[id] - S.az[id]) || 1;
      const dot = ((S.bx[id] - S.ax[id]) * hx + (S.bz[id] - S.az[id]) * hz) / L;
      const sc = Math.abs(dot) - d * 0.04;
      if (sc > score) { score = sc; best = id; dir = dot >= 0 ? 1 : -1; }
    }
    if (best < 0 || score < 0.55) return null;            // quer zur Straße (Wenden, Einparken): keine Hilfe
    closest(car.x, car.z, S.ax[best], S.az[best], S.bx[best], S.bz[best], tmp);
    let px = tmp.x, pz = tmp.z, id = best, rest = Math.max(6, Math.abs(car.v) * 1.1), ux = 0, uz = 0;
    for (let k = 0; k < 30; k++) {
      const ex = dir > 0 ? S.bx[id] : S.ax[id], ez = dir > 0 ? S.bz[id] : S.az[id];
      const L = Math.hypot(S.bx[id] - S.ax[id], S.bz[id] - S.az[id]) || 1;
      ux = ((S.bx[id] - S.ax[id]) / L) * dir; uz = ((S.bz[id] - S.az[id]) / L) * dir;
      const dd = Math.hypot(ex - px, ez - pz);
      const nxt = id + dir;
      if (rest <= dd || nxt < 0 || nxt >= S.way.length || S.way[nxt] !== S.way[id]) { at.x = px + ux * rest; at.z = pz + uz * rest; break; }   // Wegende: geradeaus weiter
      rest -= dd; px = ex; pz = ez; id = nxt;
    }
    const width = (S.half[best] - SPUR_ZUGABE) * 2, off = width >= 5 ? Math.min(1.5, width / 4) : 0;
    at.x += -uz * off; at.z += ux * off;                  // rechts der Mitte (Rechtsverkehr)
    const dx = at.x - car.x, dz = at.z - car.z, L2 = dx * dx + dz * dz;
    const lat = dx * -hz + dz * hx;                        // positiv: Ziel liegt rechts
    return Math.atan((2 * lat / Math.max(L2, 1)) * RADSTAND);
  }

  // ---------- Fahrphysik (Arcade: kein Physikmodell, nur glaubwürdiges Verhalten) ----------
  function step(h) {
    const vmax = VMAX;
    let a = 0;
    const gas = input.up, brake = input.down;
    if (gas && car.v >= -0.5) a += 4.6 * (1 - Math.sign(car.v) * (car.v / vmax) ** 2);
    else if (gas) a += 9;
    if (brake && car.v > 0.5) a -= 9;
    else if (brake && car.v > -VMAX_RUECK) a -= 3.2;
    if (Math.abs(car.v) > 0.02) a -= Math.sign(car.v) * (0.35 + 0.0011 * car.v * car.v + (input.hand ? 6 : 0));
    a -= 9.81 * car.slope * 0.7;
    car.v += a * h;
    if (!gas && !brake && Math.abs(car.v) < 0.3) car.v = 0;   // steht das Auto, hält es (auch am Hang)
    // Lenkung: Einschlag begrenzt durch die Querbeschleunigung
    const vv = Math.max(1, car.v * car.v);
    const maxSteer = Math.min(0.6, Math.atan((QUER_MAX * RADSTAND) / vv));
    const steerIn = input.right - input.left;
    let target = steerIn * maxSteer;
    if (assist && Math.abs(steerIn) < 0.25 && car.v > 1.5 && !car.park) {
      const a = assistSteer();
      if (a != null) target = Math.max(-maxSteer, Math.min(maxSteer, a));
    }
    const rate = target === 0 ? 4 : 2.4;
    car.steer += Math.max(-rate * h, Math.min(rate * h, target - car.steer));
    let yawRate = (car.v * Math.tan(car.steer)) / RADSTAND;
    if (input.hand && Math.abs(car.v) > 3) yawRate *= 1.35;
    const ox = car.x, oz = car.z, oyaw = car.yaw;
    car.yaw += yawRate * h;
    car.x += Math.sin(car.yaw) * car.v * h;
    car.z += -Math.cos(car.yaw) * car.v * h;
    // 1. Nur Straßen: auf der befahrbaren Fläche bleiben. Freie Fahrt: nur am Rand des Modells halten.
    roadField(car.x, car.z, field);
    if (onlyRoads) {
      if (field.d === Infinity) { resetToRoad(false); return; }
      if (field.d > 0) {
        car.x -= field.nx * field.d; car.z -= field.nz * field.d;
        slide(-field.nx, -field.nz);
        if (!hintedEdge && Math.abs(car.v) > 1) { hintedEdge = true; say("Nur Straßen: öffentliche Straßen und Wege laut OpenStreetMap. Taste F für freie Fahrt."); }
      }
    } else if (ctx.terrainSurfaceAt(car.x, car.z) == null) {
      car.x = ox; car.z = oz; car.v *= 0.3;
      if (!hintedEdge) { hintedEdge = true; say("Hier endet das Modell."); }
    }
    car.seg = field.seg; car.park = field.park;
    car.off = !onlyRoads && field.d > 0.5; car.offDist = field.d;
    if (car.off && !hintedOff && Math.abs(car.v) > 1) { hintedOff = true; say("Abseits der Straße: Gebäude, große Bäume und parkende Autos bleiben Hindernisse."); }
    // 2. Hauswände und parkende Autos haben Vorrang
    bodyPush(car.x, car.z, car.yaw, push);
    if (push.x || push.z) {
      car.x += push.x; car.z += push.z;
      const L = Math.hypot(push.x, push.z);
      car.lastHit = push.kind;
      const v0 = Math.abs(car.v), cos = slide(push.x / L, push.z / L);
      if (cos > 0.8 && v0 > 4 && performance.now() - lastBump > 600) { lastBump = performance.now(); say({ wand: "Rums. Hauswand.", auto: "Rums. Parkendes Auto.", baum: "Rums. Baum." }[push.kind] || "Rums.", 1400); }
    }
    // Sicherung: rutscht ein Kreismittelpunkt doch in einen Grundriss, gilt der Schritt nicht
    if (anyInBuilding(car.x, car.z, car.yaw) && !anyInBuilding(ox, oz, oyaw)) { car.x = ox; car.z = oz; car.yaw = oyaw; car.v *= 0.3; }
  }

  function placeModel(dt) {
    const fx = Math.sin(car.yaw), fz = -Math.cos(car.yaw), rx = -fz, rz = fx;
    const L = RADSTAND / 2, S2 = SPUR / 2;
    const ref = dt > 0 ? car.y : null;
    const hFL = surface(car.x + fx * L - rx * S2, car.z + fz * L - rz * S2, ref), hFR = surface(car.x + fx * L + rx * S2, car.z + fz * L + rz * S2, ref);
    const hRL = surface(car.x - fx * L - rx * S2, car.z - fz * L - rz * S2, ref), hRR = surface(car.x - fx * L + rx * S2, car.z - fz * L + rz * S2, ref);
    const y = (hFL + hFR + hRL + hRR) / 4;
    car.y = dt > 0 && Math.abs(y - car.y) < 3 ? car.y + (y - car.y) * Math.min(1, dt * 20) : y;
    car.slope = ((hFL + hFR) - (hRL + hRR)) / 2 / RADSTAND;
    // Normale aus den Diagonalen der vier Radaufstandspunkte
    const a = v3.set(fx * L - rx * S2 - (-fx * L + rx * S2), hFL - hRR, fz * L - rz * S2 - (-fz * L + rz * S2));
    const b = v3b.set(fx * L + rx * S2 - (-fx * L - rx * S2), hFR - hRL, fz * L + rz * S2 - (-fz * L - rz * S2));
    const n = Y.crossVectors(b, a).normalize();
    car.n.lerp(n, dt > 0 ? Math.min(1, dt * 12) : 1).normalize();
    F.set(fx, 0, fz);
    X.crossVectors(F, car.n).normalize();
    F.crossVectors(car.n, X).normalize();
    Z.copy(F).negate();
    basis.makeBasis(X, car.n, Z);
    model.position.set(car.x, car.y, car.z);
    model.quaternion.setFromRotationMatrix(basis);
    const ud = model.userData;
    car.spin += (ud.spinSign * car.v * dt) / ud.radius;
    for (const w of ud.wheels) w.rotation.x = car.spin;
    for (const p of ud.steer) p.rotation.y = -car.steer;
    ud.tail.emissiveIntensity = (input.down && car.v > 0.3) || input.hand ? 2.2 : headlight ? 1.0 : 0.35;
    ud.head.emissiveIntensity = headlight ? 2.5 : 0.4;
  }

  // ---------- Kamera ----------
  function chaseTarget(dt, outPos, outLook) {
    let d = car.yaw - cam.yawS; d = Math.atan2(Math.sin(d), Math.cos(d));
    cam.yawS += dt > 0 ? d * (1 - Math.exp(-dt * 3.2)) : d;
    const sp = Math.min(1, Math.abs(car.v) / VMAX);
    const dist = chaseDist + sp * 3, hgt = 4 + sp * 1.5 + (chaseDist - 9) * 0.35;
    const fx = Math.sin(cam.yawS), fz = -Math.cos(cam.yawS);
    outPos.set(car.x - fx * dist, car.y + hgt, car.z - fz * dist);
    // Hochformat (Handy): Blick näher ans Auto, damit es über Anzeige und Knöpfen im Bild steht
    const ahead = camera.aspect < 0.9 ? 0.5 : 3, up = camera.aspect < 0.9 ? 0.2 : 1.3;
    outLook.set(car.x + Math.sin(car.yaw) * ahead, car.y + up, car.z - Math.cos(car.yaw) * ahead);
  }
  function driverTarget(outPos, outLook) {
    outPos.set(-0.36, 1.25, -0.2).applyMatrix4(model.matrixWorld);
    outLook.set(-0.36, 1.05, -14).applyMatrix4(model.matrixWorld);
  }
  const want = new THREE.Vector3(), wantLook = new THREE.Vector3();
  function updateCamera(dt) {
    model.updateMatrixWorld();
    if (view === "driver") {
      driverTarget(want, wantLook);
      cam.pos.copy(want); cam.look.lerp(wantLook, Math.min(1, dt * 10));
    } else {
      chaseTarget(dt, want, wantLook);
      const k = 1 - Math.exp(-dt * 6);
      cam.pos.x += (want.x - cam.pos.x) * k; cam.pos.z += (want.z - cam.pos.z) * k; cam.pos.y += (want.y - cam.pos.y) * (1 - Math.exp(-dt * 4));
      cam.look.copy(wantLook);
      const ey = car.y + 1.8;
      const t = occlusion(car.x, ey, car.z, cam.pos.x, cam.pos.y, cam.pos.z);
      if (t < 1) { const tt = Math.max(0.12, t - 0.06); cam.pos.set(car.x + (cam.pos.x - car.x) * tt, ey + (cam.pos.y - ey) * tt, car.z + (cam.pos.z - car.z) * tt); }
      const gy = surface(cam.pos.x, cam.pos.z) + 1.2;
      if (cam.pos.y < gy) cam.pos.y = gy;
    }
    camera.position.copy(cam.pos);
    camera.up.set(0, 1, 0);
    camera.lookAt(cam.look);
    const fov = view === "driver" ? 62 : 55 + Math.min(1, Math.abs(car.v) / VMAX) * 7;
    if (Math.abs(camera.fov - fov) > 0.05) { camera.fov += (fov - camera.fov) * Math.min(1, dt * 3); camera.updateProjectionMatrix(); }
  }

  // ---------- Bildschleife (von app.js aufgerufen, solange der Fahrmodus die Kamera hat) ----------
  const ease = (f) => (f < 0.5 ? 4 * f * f * f : 1 - Math.pow(-2 * f + 2, 3) / 2);
  let hudT = 0, lightT = 0, debugCam = null;

  // Qualität: Fahrkacheln und Schatten je Stufe; sinkt die Bildrate länger unter 28 Bilder/s, eine Stufe tiefer
  const sh = ctx.sun.shadow;
  function applyQuality() {
    const q = QUALI[quality];
    if (fine) { fine.setRadius(q.fein); fine.setActive(q.fein > 0 && state !== "off"); }
    for (const m of ctx.terrainGroup.children) m.castShadow = !(fine && q.fein > 0) && saved.terrainCast;
    const R = q.schatten || saved.shadow.r;
    sh.camera.left = -R; sh.camera.right = R; sh.camera.top = R; sh.camera.bottom = -R;
    sh.normalBias = q.schatten ? 0.12 : saved.shadow.normalBias; sh.bias = q.schatten ? -0.0002 : saved.shadow.bias;
    sh.camera.updateProjectionMatrix();
    $("dhQ").textContent = `Qualität ${q.name}${fixedQ == null ? " (automatisch)" : ""}`;
  }
  function autoQuality(now) {
    if (fixedQ != null || quality === 0) return;
    if (!fpsWin.t0) { fpsWin.t0 = now; fpsWin.n = 0; return; }
    fpsWin.n++;
    if (now - fpsWin.t0 < 2000) return;
    const fps = (fpsWin.n * 1000) / (now - fpsWin.t0);
    fpsWin.t0 = now; fpsWin.n = 0;
    fpsWin.low = fps < 28 ? fpsWin.low + 1 : 0;
    if (fpsWin.low >= 2) { quality--; fpsWin.low = 0; applyQuality(); say(`Bildrate niedrig: Qualität ${QUALI[quality].name}`); }
  }
  // Scheinwerfer nur bei Dunkelheit (ein zusätzliches Licht kostet, daher nicht tagsüber)
  function updateHeadlight() {
    const s = ctx.sun, d = v3.copy(s.position).sub(s.target.position).normalize();
    const dark = state !== "off" && (!s.visible || d.y < 0.05);
    if (dark && !headlight) {
      headlight = new THREE.SpotLight(0xfff1d6, 150, 80, 0.45, 0.6, 1.8);
      headlight.position.set(0, 0.85, -2.0); headlight.target.position.set(0, -0.8, -30);
      model.add(headlight, headlight.target);
    } else if (!dark && headlight) {
      model.remove(headlight, headlight.target); headlight.dispose(); headlight = null;
    }
  }
  const owner = {
    frame(now, dt) {
      if (state === "drive") {
        const n = Math.max(1, Math.ceil(dt / (1 / 120)));
        for (let i = 0; i < n; i++) step(dt / n);
        placeModel(dt);
        updateCamera(dt);
      } else if (state === "enter") {
        placeModel(0);
        model.updateMatrixWorld();
        chaseTarget(0, want, wantLook);
        const f = Math.min(1, (now - trans.start) / FLUG_MS), k = ease(f);
        const lift = Math.sin(Math.PI * f) * Math.min(120, trans.p0.distanceTo(want) * 0.15);
        camera.position.lerpVectors(trans.p0, want, k); camera.position.y += lift;
        lookTmp.lerpVectors(trans.l0, wantLook, k);
        camera.up.set(0, 1, 0); camera.lookAt(lookTmp);
        camera.fov = trans.fov0 + (55 - trans.fov0) * k; camera.updateProjectionMatrix();
        if (f >= 1) { state = "drive"; cam.pos.copy(want); cam.look.copy(wantLook); }
      } else if (state === "leave") {
        const f = Math.min(1, (now - trans.start) / FLUG_MS), k = ease(f);
        const lift = Math.sin(Math.PI * f) * Math.min(300, trans.p0.distanceTo(saved.pos) * 0.15);
        camera.position.lerpVectors(trans.p0, saved.pos, k); camera.position.y += lift;
        lookTmp.lerpVectors(trans.l0, saved.target, k);
        camera.up.set(0, 1, 0); camera.lookAt(lookTmp);
        camera.fov = trans.fov0 + (saved.fov - trans.fov0) * k; camera.updateProjectionMatrix();
        if (f >= 1) { camera.position.copy(saved.pos); ctx.releaseCamera(); return; }
      }
      // Schatten und Sonne folgen dem Auto (app.js richtet die Sonne am Blickpunkt aus); die Schattenbox liegt vor dem Auto
      if (state === "drive" || state === "enter") {
        const q = QUALI[quality], ahead = q.schatten ? q.schatten * 0.45 : 0;
        controls.target.set(car.x + Math.sin(car.yaw) * ahead, car.y, car.z - Math.cos(car.yaw) * ahead);
        if (fine) fine.update(car.x, car.z, Math.sin(car.yaw) * car.v, -Math.cos(car.yaw) * car.v);
      } else if (state === "leave") controls.target.copy(lookTmp);
      if (state === "drive") autoQuality(now);
      if (debugCam) { camera.position.copy(debugCam.p); camera.up.set(0, 1, 0); camera.lookAt(debugCam.l); }   // nur für Tests und Bilder
      if (now - hudT > 120) {
        hudT = now;
        $("dhSpeed").textContent = String(Math.round(Math.abs(car.v) * 3.6));
        $("dhRoad").innerHTML = roadLabel();
        $("dhFps").textContent = window.__fps != null ? `${window.__fps} Bilder/s · ${QUALI[quality].name}` : "";   // Bildrate aus app.js, einmal je Sekunde gemessen
        if (!touch.hidden) placeTouch();
      }
      if (now - lightT > 1000) { lightT = now; updateHeadlight(); }
    },
    onRelease() { cleanup(); },
  };

  function cleanup() {
    if (state === "off") return;
    state = "off";
    scene.remove(model); model.traverse((o) => { if (o.isMesh) o.visible = true; });
    if (headlight) { model.remove(headlight, headlight.target); headlight.dispose(); headlight = null; }
    if (fine) { fine.setActive(false); fine.resetGroups(); }
    for (const m of ctx.terrainGroup.children) m.castShadow = saved.terrainCast;
    sh.camera.left = -saved.shadow.r; sh.camera.right = saved.shadow.r; sh.camera.top = saved.shadow.r; sh.camera.bottom = -saved.shadow.r;
    sh.bias = saved.shadow.bias; sh.normalBias = saved.shadow.normalBias; sh.camera.updateProjectionMatrix();
    hud.hidden = true; touch.hidden = true;
    for (const k in input) input[k] = 0;
    camera.near = saved.near; camera.far = saved.far; camera.fov = saved.fov; camera.updateProjectionMatrix();
    controls.target.copy(saved.target);
    if (saved.autoRotate) { controls.autoRotate = true; const ar = $("autorotate"); if (ar) ar.checked = true; }
    if (saved.foldedPanel && $("sunpanel").classList.contains("collapsed")) $("menuToggle").click();
    window.__driveState = "off";
  }

  function enter(spot) {
    if (state === "leave") return;
    const wasOff = state === "off";
    if (wasOff) {
      saved = { pos: camera.position.clone(), target: controls.target.clone(), fov: camera.fov, near: camera.near, far: camera.far, autoRotate: controls.autoRotate,
        shadow: { r: sh.camera.right, bias: sh.bias, normalBias: sh.normalBias }, terrainCast: ctx.terrainGroup.children[0]?.castShadow ?? true };
      ctx.takeCamera(owner);
      if (fine) attachObjects();
      buildTrees();
      // Auf dem Handy das Bedienfeld einklappen, beim Aussteigen wieder öffnen
      const panel = $("sunpanel");
      saved.foldedPanel = innerWidth < 900 && panel && !panel.classList.contains("collapsed");
      if (saved.foldedPanel) $("menuToggle").click();
    }
    // Fahrtrichtung entlang der Straße, möglichst vom Betrachter weg
    camera.getWorldDirection(v3);
    let dx = spot.dx, dz = spot.dz;
    if (dx * v3.x + dz * v3.z < 0) { dx = -dx; dz = -dz; }
    car.x = spot.x; car.z = spot.z; car.yaw = Math.atan2(dx, -dz); car.v = 0; car.steer = 0;
    // freien Platz suchen, falls eine Wand oder ein parkendes Auto im Weg ist
    const ox = car.x, oz = car.z;
    for (const s of [0, 3, -3, 6, -6, 9, -9, 12, -12, 16, -16, 20, -20, 25, -25, 30, -30, 40, -40]) {
      const tx = ox + dx * s, tz = oz + dz * s;
      if (roadField(tx, tz, field).d > 0 || anyInBuilding(tx, tz, car.yaw)) continue;
      bodyPush(tx, tz, car.yaw, push);
      if (!push.x && !push.z) { car.x = tx; car.z = tz; break; }
    }
    roadField(car.x, car.z, field); car.seg = field.seg; car.park = field.park;
    car.y = surface(car.x, car.z); car.n.set(0, 1, 0);
    placeModel(0);
    if (!model.parent) scene.add(model);
    cam.yawS = car.yaw;
    setView("chase");
    camera.far = 20000; camera.updateProjectionMatrix();
    trans = { start: performance.now(), p0: camera.position.clone(), l0: wasOff ? controls.target.clone() : cam.look.clone(), fov0: camera.fov };
    state = "enter";
    if (wasOff) { fpsWin.t0 = 0; fpsWin.low = 0; applyQuality(); }
    hud.hidden = false; touch.hidden = !coarse; placeHud();
    if (document.activeElement && document.activeElement !== document.body) document.activeElement.blur();
    hintedEdge = false;
    window.__driveState = "drive";
  }

  function exit() {
    if (state !== "drive" && state !== "enter") return;
    trans = { start: performance.now(), p0: camera.position.clone(), l0: state === "drive" ? cam.look.clone() : lookTmp.clone(), fov0: camera.fov };
    state = "leave";
    hud.hidden = true; touch.hidden = true;
    for (const k in input) input[k] = 0;
  }

  function resetToRoad(msg = true) {
    const r = nearestRoad(car.x, car.z);
    if (!r) return;
    car.x = r.x; car.z = r.z; car.v = 0; car.steer = 0;
    if (r.seg >= 0) { let dx = r.dx, dz = r.dz; if (dx * Math.sin(car.yaw) - dz * Math.cos(car.yaw) < 0) { dx = -dx; dz = -dz; } car.yaw = Math.atan2(dx, -dz); }
    if (msg) say("Zurück auf die Straße gesetzt.");
  }

  function setView(v) {
    view = v;
    model.traverse((o) => { if (o.isMesh) o.visible = v !== "driver"; });   // Modell nur verstecken, Scheinwerfer bleibt an
    $("dhView").innerHTML = (v === "driver" ? "Sicht: Fahrer" : "Sicht: Verfolger") + '<span class="long"> (C)</span>';
    camera.near = v === "driver" ? 0.12 : 0.3; camera.updateProjectionMatrix();
    if (v === "chase") { chaseTarget(0, want, wantLook); cam.pos.copy(want); }
  }

  // Bäume als Hindernisse: nur abseits der Straßen (über Straßen hängende Kronen sollen nichts blockieren), ab 6 m Höhe,
  // Stammradius aus der dargestellten Baumform. Gebaut aus der gerade sichtbaren Baumebene (grob zeigt jeden dritten Baum).
  function buildTrees() {
    const meshes = ctx.getTreeMeshes?.() || [], version = ctx.treesVersion?.() ?? 0;
    if (!meshes.length) { trees = null; return; }
    if (trees && trees.version === version) return;
    const xs = [], zs = [], rs = [], grid = new Grid();
    for (const m of meshes) {
      const a = m.instanceMatrix.array;
      for (let i = 0; i < m.count; i++) {
        const o = i * 16, h = Math.hypot(a[o + 4], a[o + 5], a[o + 6]);
        if (h < BAUM_MIN_H) continue;
        const x = a[o + 12], z = a[o + 14];
        if (roadField(x, z, field).d < 1) continue;
        const id = xs.length; xs.push(x); zs.push(z); rs.push(Math.max(0.3, 0.022 * h));
        grid.add(x - 3, z - 3, x + 3, z + 3, id);
      }
    }
    trees = { version, x: Float32Array.from(xs), z: Float32Array.from(zs), r: Float32Array.from(rs), grid };
  }
  // Bäume und parkende Autos an die Fahrkacheln hängen (Höhe auf feinem Gelände)
  function attachObjects() {
    fine.resetGroups();
    fine.attach(ctx.carsLayer?.meshes);
    for (const m of ctx.getTreeMeshes?.() || []) fine.attach([m]);
  }

  // ---------- Eingaben ----------
  const KEYMAP = { w: "up", arrowup: "up", s: "down", arrowdown: "down", a: "left", arrowleft: "left", d: "right", arrowright: "right", " ": "hand" };
  const typing = (el) => el && (el.tagName === "TEXTAREA" || el.tagName === "SELECT" || (el.tagName === "INPUT" && !["range", "checkbox", "button", "radio"].includes(el.type)));
  window.addEventListener("keydown", (e) => {
    if (state === "off" || typing(e.target)) return;
    const k = e.key.toLowerCase();
    if (k === "escape") exit();
    else if (k === "c" && !e.repeat) setView(view === "chase" ? "driver" : "chase");
    else if (k === "r" && !e.repeat && state === "drive") resetToRoad();
    else if (k === "l" && !e.repeat) setAssist(!assist);
    else if (k === "f" && !e.repeat) setOnlyRoads(!onlyRoads);
    else if (KEYMAP[k]) input[KEYMAP[k]] = 1;
    else return;
    e.preventDefault(); e.stopPropagation();
  }, true);
  window.addEventListener("keyup", (e) => {
    if (state === "off") return;
    const k = e.key.toLowerCase();
    if (KEYMAP[k]) { input[KEYMAP[k]] = 0; e.preventDefault(); e.stopPropagation(); }
  }, true);
  window.addEventListener("blur", () => { for (const k in input) input[k] = 0; });
  canvas.addEventListener("wheel", (e) => {
    if (state !== "drive" || view !== "chase") return;
    chaseDist = Math.min(20, Math.max(6, chaseDist * (e.deltaY > 0 ? 1.1 : 0.9)));
  }, { passive: true });
  $("dhExit").addEventListener("click", exit);
  function setAssist(on) {
    assist = on;
    $("dhAssist").innerHTML = `Spurhilfe: ${on ? "an" : "aus"}<span class="long"> (L)</span>`;
    $("dhAssist").classList.toggle("off", !on);
  }
  $("dhAssist").addEventListener("click", () => setAssist(!assist));
  function setOnlyRoads(on) {
    onlyRoads = on; hintedEdge = false;
    $("dhRoads").innerHTML = `Nur Straßen: ${on ? "an" : "aus"}<span class="long"> (F)</span>`;
    $("dhRoads").classList.toggle("off", !on);
    if (on && state === "drive" && roadField(car.x, car.z, field).d > 0) resetToRoad();
  }
  $("dhRoads").addEventListener("click", () => setOnlyRoads(!onlyRoads));
  // Joystick (Handy): waagerecht ziehen lenkt stufenlos
  const joy = $("dJoy"), knob = joy.querySelector(".knob");
  let joyId = null, joyX = 0;
  const joyMove = (e) => {
    const r = joy.getBoundingClientRect(), dx = Math.max(-1, Math.min(1, (e.clientX - (r.left + r.width / 2)) / 45));
    input.left = Math.max(0, -dx); input.right = Math.max(0, dx); knob.style.transform = `translateX(${dx * 38}px)`;
  };
  joy.addEventListener("pointerdown", (e) => { e.preventDefault(); joyId = e.pointerId; joy.setPointerCapture(e.pointerId); joyMove(e); });
  joy.addEventListener("pointermove", (e) => { if (e.pointerId === joyId) joyMove(e); });
  const joyEnd = (e) => { if (e.pointerId !== joyId) return; joyId = null; input.left = input.right = 0; knob.style.transform = ""; };
  joy.addEventListener("pointerup", joyEnd); joy.addEventListener("pointercancel", joyEnd);
  // Einstellungen, die während der Fahrt geändert werden
  $("lod").addEventListener("change", () => { if (fine && state !== "off") { attachObjects(); fine.rebuildAll(); } buildTrees(); });
  $("ortho").addEventListener("change", (e) => { if (fine) fine.setOrtho(e.target.checked); });
  $("dhView").addEventListener("click", () => setView(view === "chase" ? "driver" : "chase"));
  for (const b of touch.querySelectorAll("button")) {
    const k = b.dataset.k;
    const on = (e) => { e.preventDefault(); input[k] = 1; b.classList.add("on"); };
    const off = () => { input[k] = 0; b.classList.remove("on"); };
    b.addEventListener("pointerdown", on); b.addEventListener("pointerup", off); b.addEventListener("pointercancel", off); b.addEventListener("pointerleave", off);
  }
  window.addEventListener("resize", () => { if (state !== "off") placeHud(); });

  // ---------- Absetzen per Ziehen ----------
  const ray = new THREE.Raycaster(), ndc = new THREE.Vector2();
  function groundAt(cx, cy) {
    ndc.set((cx / innerWidth) * 2 - 1, -(cy / innerHeight) * 2 + 1);
    ray.setFromCamera(ndc, camera);
    const o = ray.ray.origin, d = ray.ray.direction;
    let t = 0, prev = 0;
    for (let i = 0; i < 3000 && t < 25000; i++) {
      const x = o.x + d.x * t, y = o.y + d.y * t, z = o.z + d.z * t;
      const hgt = ctx.terrainHeightAt(x, z);
      if (hgt != null && y < hgt) {
        let lo = prev, hi = t;
        for (let k = 0; k < 14; k++) { const m = (lo + hi) / 2; const hm = ctx.terrainHeightAt(o.x + d.x * m, o.z + d.z * m); if (hm != null && o.y + d.y * m < hm) hi = m; else lo = m; }
        return { x: o.x + d.x * hi, z: o.z + d.z * hi };
      }
      prev = t;
      t += Math.min(40, Math.max(0.5, hgt != null ? (y - hgt) * 0.5 : 20));
    }
    return null;
  }
  function snapAt(cx, cy) {
    const g = groundAt(cx, cy);
    if (!g) return null;
    const r = nearestRoad(g.x, g.z);
    const maxSnap = Math.max(25, camera.position.distanceTo(controls.target) * 0.06);
    if (!r || r.dist > maxSnap) return { none: true };
    return r;
  }
  function showGhost(r) {
    if (!r || r.none) { ghost.visible = false; return; }
    camera.getWorldDirection(v3);
    let dx = r.dx, dz = r.dz; if (dx * v3.x + dz * v3.z < 0) { dx = -dx; dz = -dz; }
    const yaw = Math.atan2(dx, -dz);
    ghost.position.set(r.x, surface(r.x, r.z), r.z);
    ghost.rotation.set(0, -yaw, 0);
    const s = Math.max(1, camera.position.distanceTo(ghost.position) / 120);   // aus großer Höhe größer zeigen, damit man es sieht
    ghost.scale.setScalar(s);
    ghost.visible = true;
  }
  function labelFor(r) {
    if (!r) return "";
    if (r.none) return "Keine befahrbare Straße in der Nähe";
    if (r.park) return "Parkplatz";
    const w = W.net.wege[W.seg.way[r.seg]], art = W.net.arten[w[0]];
    return w[1] >= 0 ? W.net.namen[w[1]] : ART_NAME[art] || art;
  }
  function startDrag(e) {
    if (state === "leave" || state === "enter") return;
    let last = null;
    const update = (cx, cy) => {
      const overCanvas = document.elementFromPoint(cx, cy) === canvas;
      last = overCanvas ? snapAt(cx, cy) : null;
      showGhost(last);
      dragLabel.hidden = false;
      dragLabel.style.left = `${cx}px`; dragLabel.style.top = `${cy}px`;
      dragLabel.textContent = overCanvas ? labelFor(last) : "Auf eine Straße in der Karte ziehen";
      dragLabel.classList.toggle("no", !overCanvas || !last || !!last.none);
    };
    const move = (ev) => { if (ev.pointerType === "mouse" && ev.buttons === 0) { done(ev, true); return; } update(ev.clientX, ev.clientY); };
    const done = (ev, drop) => {
      window.removeEventListener("pointermove", move); window.removeEventListener("pointerup", up); window.removeEventListener("pointercancel", cancel);
      window.removeEventListener("keydown", esc, true);
      ghost.visible = false; dragLabel.hidden = true; document.body.style.cursor = "";
      if (drop && ev) { update(ev.clientX, ev.clientY); ghost.visible = false; dragLabel.hidden = true; if (last && !last.none) enter(last); }
    };
    const up = (ev) => done(ev, true);
    const cancel = () => done(null, false);
    const esc = (ev) => { if (ev.key === "Escape") { ev.stopPropagation(); cancel(); } };
    window.addEventListener("pointermove", move); window.addEventListener("pointerup", up); window.addEventListener("pointercancel", cancel);
    window.addEventListener("keydown", esc, true);
    document.body.style.cursor = "grabbing";
    update(e.clientX, e.clientY);
  }
  function placeNear(x, z) {
    const r = nearestRoad(x, z);
    if (r) enter(r);
  }

  // Testhilfe: Physik ohne Zeichnen rechnen (Sekunden, Eingaben), liefert die Spur
  function sim(sec, inp = {}, every = 0.25) {
    Object.assign(input, { up: 0, down: 0, left: 0, right: 0, hand: 0 }, inp);
    const trace = []; let t = 0, next = 0;
    while (t < sec) { step(1 / 120); placeModel(1 / 120); t += 1 / 120; if (t >= next) { trace.push([car.x, car.z, car.v, car.y]); next += every; } }
    for (const k in input) input[k] = 0;
    return trace;
  }
  const setQuality = (q) => { quality = q; if (state !== "off") applyQuality(); };
  const api = { setOnlyRoads, onlyRoads: () => onlyRoads, buildTrees, trees: () => trees, debugCam: (p, l) => { debugCam = p ? { p: new THREE.Vector3(...p), l: new THREE.Vector3(...l) } : null; }, fine: () => fine, setQuality, quality: () => quality, assistSteer, setAssist, inBuilding, anyInBuilding, sim, startDrag, placeNear, exit, enter, nearestRoad, roadField, bodyPush, state: () => state, car, input, setView, world: W, saved: () => saved };
  window.__drive = api;
  return api;
}
