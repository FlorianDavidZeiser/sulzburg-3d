// Sulzburg 3D, Spike Phase 0: Gelände (DGM1) + Luftbild (DOP20) + LoD2-Gebäude + Sonnenstand mit Schatten.
// Datenquelle aller Geodaten: LGL Baden-Württemberg, www.lgl-bw.de, dl-de/by-2-0 (siehe web/data/*.json).
import * as THREE from "three";
import { OrbitControls } from "three/addons/controls/OrbitControls.js";
import { GLTFLoader } from "three/addons/loaders/GLTFLoader.js";
import { sunPosition, sunTimes, zonedToUtc, formatLocal } from "./sun.js";

const TZ = "Europe/Berlin";
const params = new URLSearchParams(location.search);
let TERRAIN_STEP = Math.max(1, parseInt(params.get("step") || "1", 10)); // 2 = halbe Geländeauflösung
const SHADOW_MAP = parseInt(params.get("shadow") || "2048", 10);

const $ = (id) => document.getElementById(id);
const canvas = $("c");
const renderer = new THREE.WebGLRenderer({ canvas, antialias: true, powerPreference: "high-performance" });
renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
renderer.shadowMap.enabled = true;
renderer.shadowMap.type = THREE.PCFShadowMap;
renderer.outputColorSpace = THREE.SRGBColorSpace;
renderer.toneMapping = THREE.ACESFilmicToneMapping;
renderer.toneMappingExposure = 1.0;

const scene = new THREE.Scene();
const camera = new THREE.PerspectiveCamera(50, 1, 1, 6000);
const controls = new OrbitControls(camera, canvas);
controls.enableDamping = true;
controls.dampingFactor = 0.08;
controls.maxPolarAngle = Math.PI / 2 - 0.03;
controls.minDistance = 25;
controls.maxDistance = 2500;

const hemi = new THREE.HemisphereLight(0xcfe3ff, 0x6b5a46, 1.0);
scene.add(hemi);
const sun = new THREE.DirectionalLight(0xffffff, 2.2);
sun.castShadow = true;
sun.shadow.mapSize.set(SHADOW_MAP, SHADOW_MAP);
sun.shadow.bias = -0.0003;
sun.shadow.normalBias = 0.6;
scene.add(sun);
scene.add(sun.target);

let terrainMesh, buildingsMesh, meta = {}, latLon = null, centerY = 0;

async function loadJson(url) {
  const r = await fetch(url);
  if (!r.ok) throw new Error(`${url}: ${r.status}`);
  return r.json();
}

function buildTerrain(info, heights) {
  const { cols, rows, e_min, n_max, e0, n0, cellsize_m: cs } = info;
  const step = TERRAIN_STEP;
  const nx = Math.floor((cols - 1) / step) + 1;
  const ny = Math.floor((rows - 1) / step) + 1;
  const pos = new Float32Array(nx * ny * 3);
  const uv = new Float32Array(nx * ny * 2);
  let k = 0, u = 0;
  for (let j = 0; j < ny; j++) {
    const r = j * step;
    for (let i = 0; i < nx; i++) {
      const c = i * step;
      const h = heights[r * cols + c];
      pos[k++] = e_min + c + 0.5 * cs - e0;           // x nach Osten
      pos[k++] = h;                                    // y = Höhe NHN
      pos[k++] = -(n_max - r - 0.5 * cs - n0);          // z nach Süden
      uv[u++] = (c + 0.5) / cols;
      uv[u++] = 1 - (r + 0.5) / rows;
    }
  }
  const idx = new Uint32Array((nx - 1) * (ny - 1) * 6);
  let t = 0;
  for (let j = 0; j < ny - 1; j++) {
    for (let i = 0; i < nx - 1; i++) {
      const a = j * nx + i, b = a + 1, c = a + nx, d = c + 1;
      idx[t++] = a; idx[t++] = c; idx[t++] = b;
      idx[t++] = b; idx[t++] = c; idx[t++] = d;
    }
  }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute("position", new THREE.BufferAttribute(pos, 3));
  geo.setAttribute("uv", new THREE.BufferAttribute(uv, 2));
  geo.setIndex(new THREE.BufferAttribute(idx, 1));
  geo.computeVertexNormals();
  geo.computeBoundingSphere();
  return geo;
}

// Geländehöhe (bilinear) an lokaler Position x/z
function terrainHeightAt(x, z) {
  const t = meta.terrain;
  if (!t) return 0;
  const fx = x + t.e0 - t.e_min - 0.5, fz = t.n_max - (t.n0 - z) - 0.5;
  const c0 = Math.min(t.cols - 2, Math.max(0, Math.floor(fx)));
  const r0 = Math.min(t.rows - 2, Math.max(0, Math.floor(fz)));
  const dx = Math.min(1, Math.max(0, fx - c0)), dz = Math.min(1, Math.max(0, fz - r0));
  const H = meta.heights;
  const h00 = H[r0 * t.cols + c0], h01 = H[r0 * t.cols + c0 + 1];
  const h10 = H[(r0 + 1) * t.cols + c0], h11 = H[(r0 + 1) * t.cols + c0 + 1];
  return (h00 * (1 - dx) + h01 * dx) * (1 - dz) + (h10 * (1 - dx) + h11 * dx) * dz;
}

function setSun(date) {
  const [lat, lon] = latLon;
  const p = sunPosition(date, lat, lon);
  const el = THREE.MathUtils.degToRad(p.elevation);
  const az = THREE.MathUtils.degToRad(p.azimuth);
  const dir = new THREE.Vector3(Math.sin(az) * Math.cos(el), Math.sin(el), -Math.cos(az) * Math.cos(el));
  const dist = 1500;
  sun.target.position.set(0, centerY, 0);
  sun.position.copy(sun.target.position).addScaledVector(dir, dist);
  const up = p.elevation > 0;
  const day = THREE.MathUtils.clamp(p.elevation / 15, 0, 1);
  sun.visible = up;
  sun.intensity = 2.4 * Math.pow(day, 0.6);
  // Wärmere Sonne bei tiefem Stand
  sun.color.setHSL(0.1, 0.6, THREE.MathUtils.lerp(0.72, 0.98, day));
  hemi.intensity = THREE.MathUtils.lerp(0.15, 1.0, THREE.MathUtils.clamp((p.elevation + 8) / 20, 0, 1));
  const sky = new THREE.Color();
  if (p.elevation > 8) sky.set(0xb9d4ee);
  else if (p.elevation > -6) sky.lerpColors(new THREE.Color(0x1b2436), new THREE.Color(0xe7a86a), (p.elevation + 6) / 14);
  else sky.set(0x0e1322);
  scene.background = sky;
  scene.fog = new THREE.Fog(sky, 1500, 5000);

  const day0 = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()));
  const times = sunTimes(day0, lat, lon);
  $("suninfo").innerHTML =
    `Azimut <b>${p.azimuth.toFixed(1)}°</b> · Höhe <b>${p.elevation.toFixed(1)}°</b>` +
    (up ? "" : ' <span class="warn">(Sonne unter dem Horizont)</span>') +
    `<br>Aufgang ${formatLocal(times.sunrise, TZ)} · Untergang ${formatLocal(times.sunset, TZ)} · ` +
    `berechnet für ${lat.toFixed(4)}° N, ${lon.toFixed(4)}° O`;
}

function currentDate() {
  const d = $("date").value; // yyyy-mm-dd
  const minutes = parseInt($("time").value, 10);
  const [y, m, day] = d.split("-").map(Number);
  const date = zonedToUtc(y, m, day, Math.floor(minutes / 60), minutes % 60, TZ);
  $("timeLabel").textContent = `${String(Math.floor(minutes / 60)).padStart(2, "0")}:${String(minutes % 60).padStart(2, "0")}`;
  return date;
}

function initTimeControls() {
  const now = new Date();
  const parts = new Intl.DateTimeFormat("en-CA", { timeZone: TZ, year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).formatToParts(now);
  const get = (t) => parts.find((p) => p.type === t).value;
  $("date").value = `${get("year")}-${get("month")}-${get("day")}`;
  $("time").value = String(Number(get("hour")) * 60 + Number(get("minute")));
  if (params.get("t")) { // z.B. ?t=2026-06-21T10:30 (lokale Zeit) für reproduzierbare Screenshots
    const [d, hm] = params.get("t").split("T");
    $("date").value = d;
    const [h, mi] = hm.split(":").map(Number);
    $("time").value = String(h * 60 + mi);
  }
  const update = () => setSun(currentDate());
  $("date").addEventListener("input", update);
  $("time").addEventListener("input", update);
  update();
}

function showSources() {
  const t = meta.terrain, o = meta.ortho, b = meta.buildings;
  const liz = t.quelle.lizenz;
  $("sources").innerHTML =
    `<b>Datenquellen und Stand</b> · ` +
    `Luftbild: DOP20 RGB, Bildflug <b>${o.quelle.bildflugdatum.join(", ")}</b>, 20 cm · ` +
    `Gelände: DGM1, Laserscan <b>${t.quelle.aktualitaet_laserscan.join(", ")}</b>, 1 m, ±${t.quelle.hoehengenauigkeit_m.join("/")} m · ` +
    `Gebäude: LoD2 CityGML, Auslesedatum <b>${b.quelle.lieferinformation["Auslesedatum"] || "–"}</b>, ` +
    `${b.anzahl} von ${b.anzahl_im_ausschnitt} Gebäuden im Ausschnitt (${b.auswahl}).<br>` +
    `${liz.namensnennung} · Lizenz <a href="${liz.url}" target="_blank" rel="noopener" style="color:inherit">${liz.name}</a> · ` +
    `Ausschnitt ${t.cols} × ${t.rows} m um den Marktplatz (ETRS89/UTM 32N, Höhen NHN DHHN2016) · ` +
    `Sonnenstand: NOAA-Algorithmus, eigene Berechnung · Privates Projekt, kein Angebot der Stadt oder eines Unternehmens.`;
}

function setupPicking() {
  const ray = new THREE.Raycaster();
  const mouse = new THREE.Vector2();
  let downAt = null;
  canvas.addEventListener("pointerdown", (e) => { downAt = [e.clientX, e.clientY]; });
  canvas.addEventListener("pointerup", (e) => {
    if (!downAt || Math.hypot(e.clientX - downAt[0], e.clientY - downAt[1]) > 4 || !buildingsMesh) return;
    mouse.set((e.clientX / innerWidth) * 2 - 1, -(e.clientY / innerHeight) * 2 + 1);
    ray.setFromCamera(mouse, camera);
    const hit = ray.intersectObject(buildingsMesh, false)[0];
    const info = $("info");
    if (!hit) { info.hidden = true; return; }
    const attr = buildingsMesh.geometry.getAttribute("_building");
    const idx = Math.round(attr.getX(hit.face.a));
    const g = meta.buildings.gebaeude[idx];
    if (!g) return;
    const dgm = terrainHeightAt(g.e - meta.buildings.e0, -(g.n - meta.buildings.n0));
    const fmt = (v, d = 1) => (v == null ? "–" : Number(v).toFixed(d));
    info.hidden = false;
    info.innerHTML = `<h2>${g.adresse || "Gebäude ohne Adresse"}</h2><dl>` +
      `<dt>Funktion</dt><dd>${g.funktion_name || "–"} <span style="color:var(--muted)">(${g.funktion || "–"})</span></dd>` +
      `<dt>Dachform</dt><dd>${g.dachform_name || "–"} <span style="color:var(--muted)">(${g.dachform || "–"}${g.dachformen_teile ? ", Teile: " + g.dachformen_teile.join("/") : ""})</span></dd>` +
      `<dt>Höhe</dt><dd>${fmt(g.hoehe_m)} m (LoD2 measuredHeight)</dd>` +
      `<dt>Boden LoD2</dt><dd>${fmt(g.z_boden_min)}${g.z_boden_max !== g.z_boden_min ? " bis " + fmt(g.z_boden_max) : ""} m NHN</dd>` +
      `<dt>Gelände DGM1</dt><dd>${fmt(dgm)} m NHN am Grundrissmittel</dd>` +
      `<dt>Grundriss</dt><dd>Stand ${g.grundriss_aktualitaet || "–"}, Modell ${g.erstellt || "–"}</dd>` +
      `<dt>ID</dt><dd style="font-family:monospace">${g.id}</dd></dl>` +
      `<div class="hint">LGL LoD2, dl-de/by-2-0. Bauteile: ${g.bauteile}. Klick ins Leere schließt.</div>`;
  });
}

function setupToggles() {
  $("shadows").addEventListener("change", (e) => { renderer.shadowMap.enabled = e.target.checked; sun.castShadow = e.target.checked;
    scene.traverse((o) => { if (o.material) o.material.needsUpdate = true; }); });
  $("ortho").addEventListener("change", (e) => { if (!terrainMesh) return; terrainMesh.material.map = e.target.checked ? meta.orthoTexture : null;
    terrainMesh.material.color.set(e.target.checked ? 0xffffff : 0x8c9a7a); terrainMesh.material.needsUpdate = true; });
  $("wire").addEventListener("change", (e) => { if (terrainMesh) terrainMesh.material.wireframe = e.target.checked; });
  $("step").value = String(TERRAIN_STEP);
  $("step").addEventListener("change", (e) => {
    TERRAIN_STEP = parseInt(e.target.value, 10);
    const old = terrainMesh.geometry;
    terrainMesh.geometry = buildTerrain(meta.terrain, meta.heights);
    old.dispose();
  });
}

function resize() {
  const w = innerWidth, h = innerHeight;
  renderer.setSize(w, h, false);
  camera.aspect = w / h;
  camera.updateProjectionMatrix();
}

async function main() {
  const [terrain, ortho, buildings, heightsBuf, gltf] = await Promise.all([
    loadJson("data/terrain.json"), loadJson("data/ortho.json"), loadJson("data/buildings.json"),
    fetch("data/terrain.bin").then((r) => r.arrayBuffer()),
    new GLTFLoader().loadAsync("data/buildings.glb"),
  ]);
  meta = { terrain, ortho, buildings, heights: new Float32Array(heightsBuf) };
  // Breite/Länge des Ausschnittsmittelpunkts aus den UTM-Koordinaten (für den Sonnenstand)
  latLon = utmToLatLon(terrain.e0, terrain.n0);
  centerY = terrainHeightAt(0, 0);

  const tex = await new THREE.TextureLoader().loadAsync("data/ortho.jpg");
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.anisotropy = renderer.capabilities.getMaxAnisotropy();
  tex.generateMipmaps = true;
  meta.orthoTexture = tex;

  terrainMesh = new THREE.Mesh(buildTerrain(terrain, meta.heights), new THREE.MeshLambertMaterial({ map: tex }));
  terrainMesh.receiveShadow = true;
  terrainMesh.castShadow = true;
  scene.add(terrainMesh);

  buildingsMesh = gltf.scene.getObjectByProperty("type", "Mesh");
  buildingsMesh.material = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.9, metalness: 0 });
  buildingsMesh.castShadow = true;
  buildingsMesh.receiveShadow = true;
  scene.add(buildingsMesh);

  const half = terrain.cols / 2;
  sun.shadow.camera.left = -half * 1.1; sun.shadow.camera.right = half * 1.1;
  sun.shadow.camera.top = half * 1.1; sun.shadow.camera.bottom = -half * 1.1;
  sun.shadow.camera.near = 600; sun.shadow.camera.far = 2600;
  sun.shadow.camera.updateProjectionMatrix();

  controls.target.set(0, centerY, 0);
  camera.position.set(-170, centerY + 150, 260);
  if (params.get("cam")) { const v = params.get("cam").split(",").map(Number); camera.position.set(v[0], centerY + v[1], v[2]); }
  controls.update();

  initTimeControls();
  showSources();
  setupPicking();
  setupToggles();
  $("loading").classList.add("done");

  let frames = 0, last = performance.now(), fpsVal = 0;
  renderer.setAnimationLoop((now) => {
    controls.update();
    renderer.render(scene, camera);
    frames++;
    if (now - last >= 1000) {
      fpsVal = Math.round((frames * 1000) / (now - last));
      $("fps").textContent = `${fpsVal} Bilder/s · Gelände ${terrainMesh.geometry.index.count / 3 | 0} Dreiecke (Schritt ${TERRAIN_STEP} m) · Gebäude ${buildings.dreiecke} Dreiecke · Schattenkarte ${SHADOW_MAP}px`;
      frames = 0; last = now;
      window.__fps = fpsVal;
    }
  });
  window.__ready = true;
}

// UTM 32N (ETRS89/GRS80) -> Breite/Länge, für den Sonnenstand (Genauigkeit weit unter 1 m)
function utmToLatLon(e, n) {
  const a = 6378137, f = 1 / 298.257222101, k0 = 0.9996, lon0 = 9;
  const e2 = f * (2 - f), ep2 = e2 / (1 - e2);
  const x = e - 500000, y = n;
  const m = y / k0;
  const mu = m / (a * (1 - e2 / 4 - 3 * e2 * e2 / 64 - 5 * e2 ** 3 / 256));
  const e1 = (1 - Math.sqrt(1 - e2)) / (1 + Math.sqrt(1 - e2));
  const phi1 = mu + (3 * e1 / 2 - 27 * e1 ** 3 / 32) * Math.sin(2 * mu) + (21 * e1 * e1 / 16 - 55 * e1 ** 4 / 32) * Math.sin(4 * mu) + (151 * e1 ** 3 / 96) * Math.sin(6 * mu);
  const n1 = a / Math.sqrt(1 - e2 * Math.sin(phi1) ** 2), t1 = Math.tan(phi1) ** 2, c1 = ep2 * Math.cos(phi1) ** 2;
  const r1 = a * (1 - e2) / Math.pow(1 - e2 * Math.sin(phi1) ** 2, 1.5), d = x / (n1 * k0);
  const lat = phi1 - (n1 * Math.tan(phi1) / r1) * (d * d / 2 - (5 + 3 * t1 + 10 * c1 - 4 * c1 * c1 - 9 * ep2) * d ** 4 / 24 + (61 + 90 * t1 + 298 * c1 + 45 * t1 * t1 - 252 * ep2 - 3 * c1 * c1) * d ** 6 / 720);
  const lon = lon0 * Math.PI / 180 + (d - (1 + 2 * t1 + c1) * d ** 3 / 6 + (5 - 2 * c1 + 28 * t1 - 3 * c1 * c1 + 8 * ep2 + 24 * t1 * t1) * d ** 5 / 120) / Math.cos(phi1);
  return [lat * 180 / Math.PI, lon * 180 / Math.PI];
}

window.addEventListener("resize", resize);
resize();
main().catch((err) => { console.error(err); $("loading").textContent = "Fehler beim Laden: " + err.message; });
