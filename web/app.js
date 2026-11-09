// Sulzburg 3D, Phase 1: gekacheltes Gelände (DGM1) + Luftbild (DOP20) + alle LoD2-Gebäude + Sonnenstand + Wetter (DWD).
// Datenquelle aller Geodaten: LGL Baden-Württemberg, www.lgl-bw.de, dl-de/by-2-0 (siehe quellen.html und web/data/*.json).
import * as THREE from "three";
import { OrbitControls } from "three/addons/controls/OrbitControls.js";
import { GLTFLoader } from "three/addons/loaders/GLTFLoader.js";
import { mergeGeometries } from "three/addons/utils/BufferGeometryUtils.js";
import { sunPosition, sunTimes, zonedToUtc, formatLocal, tzOffsetMs } from "./sun.js";
import { setupPlaces } from "./places.js";
import { setupScenario } from "./scenario.js";
import { setupExtras } from "./extras.js";
import { setupBusiness } from "./business.js";

const TZ = "Europe/Berlin";
const params = new URLSearchParams(location.search);
const smallDevice = innerWidth < 900 || (navigator.hardwareConcurrency || 8) <= 4;
let LOD = parseInt(params.get("lod") || (smallDevice ? "2" : "1"), 10); // 2 = halbe Auflösung in Siedlungskacheln
const SHADOW_MAP = parseInt(params.get("shadow") || "2048", 10);
const SHADOW_RADIUS = 700; // Meter um den Blickpunkt, in denen Schatten berechnet werden

const $ = (id) => document.getElementById(id);
const canvas = $("c");
const renderer = new THREE.WebGLRenderer({ canvas, antialias: true, powerPreference: "high-performance" });
renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
renderer.shadowMap.enabled = true;
renderer.shadowMap.type = THREE.PCFShadowMap;
renderer.outputColorSpace = THREE.SRGBColorSpace;
renderer.toneMapping = THREE.ACESFilmicToneMapping;

const scene = new THREE.Scene();
const camera = new THREE.PerspectiveCamera(50, 1, 2, 30000);
const controls = new OrbitControls(camera, canvas);
controls.enableDamping = true;
controls.dampingFactor = 0.08;
controls.maxPolarAngle = Math.PI / 2 - 0.02;
controls.minDistance = 20;
controls.maxDistance = 9000;
controls.screenSpacePanning = false;   // Verschieben parallel zum Boden
controls.zoomToCursor = true;          // Rad zoomt zur Mausposition
controls.listenToKeyEvents(window);    // Pfeiltasten verschieben
controls.keyPanSpeed = 40;
controls.autoRotateSpeed = 0.4;
const keys = new Set();
window.addEventListener("keydown", (e) => { if (e.target.tagName !== "INPUT" && e.target.tagName !== "SELECT") keys.add(e.key.toLowerCase()); });
window.addEventListener("keyup", (e) => keys.delete(e.key.toLowerCase()));
window.addEventListener("blur", () => keys.clear());
let targetGoal = null; // Zielpunkt für sanftes Umsetzen des Blickpunkts (Doppelklick, Sprungknöpfe)
let flight = null;     // laufender Kameraflug { p0, t0, p1, t1, start, dur }
const frameHooks = []; // Funktionen (now, dt), die jedes Bild aufgerufen werden
const pickHooks = [];  // Funktionen (raycaster) -> true, wenn der Klick behandelt wurde
const infoHooks = [];  // Funktionen (index, gebaeude) -> HTML, wird an die Gebäude-Info angehängt
// Sanfter Kameraflug zu einem Blickpunkt: Abstand und Blickrichtung frei wählbar
function flyTo(goal, dist = 450, dir = new THREE.Vector3(-0.45, 0.55, 0.7), dur = 1600) {
  const d = dir.clone().normalize();
  flight = { p0: camera.position.clone(), t0: controls.target.clone(), p1: goal.clone().addScaledVector(d, dist), t1: goal.clone(), start: performance.now(), dur };
  targetGoal = null;
  if (controls.autoRotate) { controls.autoRotate = false; $("autorotate").checked = false; }
}

const hemi = new THREE.HemisphereLight(0xcfe3ff, 0x6b5a46, 1.0);
scene.add(hemi);
const sun = new THREE.DirectionalLight(0xffffff, 2.2);
sun.castShadow = true;
sun.shadow.mapSize.set(SHADOW_MAP, SHADOW_MAP);
sun.shadow.bias = -0.0004;
sun.shadow.normalBias = 0.8;
sun.shadow.camera.left = -SHADOW_RADIUS; sun.shadow.camera.right = SHADOW_RADIUS;
sun.shadow.camera.top = SHADOW_RADIUS; sun.shadow.camera.bottom = -SHADOW_RADIUS;
sun.shadow.camera.near = 100; sun.shadow.camera.far = 5000;
scene.add(sun); scene.add(sun.target);

const meta = {};             // index, buildings, gemeinde
const tiles = new Map();     // id -> { t, heights, mesh }
const terrainGroup = new THREE.Group();
scene.add(terrainGroup);
let buildingsMesh, boundaryLine, latLon, centerY = 0, sunDir = new THREE.Vector3(0, 1, 0), cloudCover = null;
let buildingMeshes = [], roofMeshes = [];

async function loadJson(url) {
  const r = await fetch(url);
  if (!r.ok) throw new Error(`${url}: ${r.status}`);
  return r.json();
}

// ---------- Gelände ----------
function tileGeometry(t, heights, lod) {
  const n = t.n;
  const step = lod > 1 && (n - 1) % lod === 0 ? lod : 1;
  const m = (n - 1) / step + 1;
  const res = t.res * step;
  const skirt = Math.max(3, res * 1.5);
  const M = m + 2; // Rasterpunkte plus Schürze ringsum (verdeckt Spalten zwischen Kacheln)
  const { e0, n0 } = meta.index;
  const pos = new Float32Array(M * M * 3), uv = new Float32Array(M * M * 2), nrm = new Float32Array(M * M * 3);
  const h = (i, j) => t.z_min + heights[j * step * n + i * step] * t.z_scale;
  const clamp = (v) => Math.min(m - 1, Math.max(0, v));
  let k = 0, u = 0;
  for (let J = 0; J < M; J++) {
    for (let I = 0; I < M; I++) {
      const i = clamp(I - 1), j = clamp(J - 1);
      const onSkirt = I === 0 || J === 0 || I === M - 1 || J === M - 1;
      pos[k] = t.e_min + i * res - e0;
      pos[k + 1] = h(i, j) - (onSkirt ? skirt : 0);
      pos[k + 2] = -((t.n_min + t.size - j * res) - n0);
      const il = clamp(i - 1), ir = clamp(i + 1), ju = clamp(j - 1), jd = clamp(j + 1);
      const dx = (h(ir, j) - h(il, j)) / ((ir - il) * res);
      const dz = (h(i, jd) - h(i, ju)) / ((jd - ju) * res);
      const len = Math.hypot(dx, 1, dz);
      nrm[k] = -dx / len; nrm[k + 1] = 1 / len; nrm[k + 2] = -dz / len;
      uv[u++] = i / (m - 1); uv[u++] = 1 - j / (m - 1);
      k += 3;
    }
  }
  const idx = new Uint32Array((M - 1) * (M - 1) * 6);
  let q = 0;
  for (let J = 0; J < M - 1; J++) {
    for (let I = 0; I < M - 1; I++) {
      const a = J * M + I, b = a + 1, c = a + M, d = c + 1;
      idx[q++] = a; idx[q++] = c; idx[q++] = b;
      idx[q++] = b; idx[q++] = c; idx[q++] = d;
    }
  }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute("position", new THREE.BufferAttribute(pos, 3));
  geo.setAttribute("normal", new THREE.BufferAttribute(nrm, 3));
  geo.setAttribute("uv", new THREE.BufferAttribute(uv, 2));
  geo.setIndex(new THREE.BufferAttribute(idx, 1));
  geo.computeBoundingSphere();
  return geo;
}

function buildTerrain(heightsBuf) {
  const index = meta.index;
  let count = 0;
  for (const t of index.kacheln) {
    const heights = new Uint16Array(heightsBuf, t.offset, t.bytes / 2);
    const mat = new THREE.MeshLambertMaterial({ color: 0x7f8c6e });
    const mesh = new THREE.Mesh(tileGeometry(t, heights, LOD), mat);
    mesh.receiveShadow = true;
    mesh.castShadow = true;
    mesh.userData.tile = t;
    terrainGroup.add(mesh);
    tiles.set(t.id, { t, heights, mesh });
    count++;
  }
  return count;
}

function rebuildTerrain() {
  for (const { t, heights, mesh } of tiles.values()) {
    const old = mesh.geometry;
    mesh.geometry = tileGeometry(t, heights, LOD);
    old.dispose();
  }
}

let texturesLoaded = 0;
function loadOrthos() {
  const loader = new THREE.TextureLoader();
  const aniso = renderer.capabilities.getMaxAnisotropy();
  const list = [...tiles.values()].filter((x) => x.t.ortho);
  // Siedlungskacheln zuerst
  list.sort((a, b) => (b.t.siedlung ? 1 : 0) - (a.t.siedlung ? 1 : 0));
  for (const { t, mesh } of list) {
    loader.load(`data/terrain/${t.ortho}`, (tex) => {
      tex.colorSpace = THREE.SRGBColorSpace;
      tex.anisotropy = aniso;
      mesh.userData.ortho = tex;
      if ($("ortho").checked) { mesh.material.map = tex; mesh.material.color.set(0xffffff); mesh.material.needsUpdate = true; }
      texturesLoaded++;
      updateProgress();
    });
  }
  return list.length;
}

// Geländehöhe (bilinear) an lokaler Position x/z, über alle Kacheln
function terrainHeightAt(x, z) {
  const { e0, n0, kachel_m: T } = meta.index;
  const e = x + e0, nn = n0 - z;
  const id = `${Math.floor(e / T) * T}_${Math.floor(nn / T) * T}`;
  const tile = tiles.get(id);
  if (!tile) return null;
  const { t, heights } = tile;
  const fx = (e - t.e_min) / t.res, fz = (t.n_min + t.size - nn) / t.res;
  const i0 = Math.min(t.n - 2, Math.max(0, Math.floor(fx))), j0 = Math.min(t.n - 2, Math.max(0, Math.floor(fz)));
  const dx = Math.min(1, Math.max(0, fx - i0)), dz = Math.min(1, Math.max(0, fz - j0));
  const h = (i, j) => t.z_min + heights[j * t.n + i] * t.z_scale;
  return (h(i0, j0) * (1 - dx) + h(i0 + 1, j0) * dx) * (1 - dz) + (h(i0, j0 + 1) * (1 - dx) + h(i0 + 1, j0 + 1) * dx) * dz;
}

// ---------- Gemeindegrenze ----------
function buildBoundary(geojson) {
  const { e0, n0 } = meta.index;
  const ring = geojson.features[0].geometry.coordinates[0];
  const pts = [];
  for (let i = 0; i < ring.length - 1; i++) {
    const [ax, ay] = ring[i], [bx, by] = ring[i + 1];
    const len = Math.hypot(bx - ax, by - ay), steps = Math.max(1, Math.ceil(len / 15));
    for (let s = 0; s < steps; s++) {
      const e = ax + ((bx - ax) * s) / steps, nn = ay + ((by - ay) * s) / steps;
      const x = e - e0, z = -(nn - n0);
      const y = terrainHeightAt(x, z);
      if (y != null) pts.push(new THREE.Vector3(x, y + 2.5, z));
    }
  }
  const geo = new THREE.BufferGeometry().setFromPoints(pts);
  boundaryLine = new THREE.LineLoop(geo, new THREE.LineBasicMaterial({ color: 0xf2b544, transparent: true, opacity: 0.85 }));
  scene.add(boundaryLine);
}

// ---------- Sonne ----------
function setSun(date) {
  const [lat, lon] = latLon;
  const p = sunPosition(date, lat, lon);
  const el = THREE.MathUtils.degToRad(p.elevation), az = THREE.MathUtils.degToRad(p.azimuth);
  sunDir.set(Math.sin(az) * Math.cos(el), Math.sin(el), -Math.cos(az) * Math.cos(el));
  const up = p.elevation > 0;
  const day = THREE.MathUtils.clamp(p.elevation / 15, 0, 1);
  const clouds = $("clouds").checked && cloudCover != null ? cloudCover / 100 : 0;
  sun.visible = up;
  sun.intensity = 2.4 * Math.pow(day, 0.6) * (1 - 0.75 * clouds);
  sun.color.setHSL(0.1, 0.6 * (1 - clouds), THREE.MathUtils.lerp(0.72, 0.98, day));
  // Nachts bleibt eine aufgehellte Grunddarstellung, damit Gelände und Gebäude erkennbar sind (kein echtes Mondlicht)
  hemi.intensity = THREE.MathUtils.lerp(0.55, 1.0, THREE.MathUtils.clamp((p.elevation + 8) / 20, 0, 1)) * (1 + 0.3 * clouds);
  hemi.color.set(up ? 0xcfe3ff : 0x7f93b8);
  const sky = new THREE.Color();
  if (p.elevation > 8) sky.set(0xb9d4ee).lerp(new THREE.Color(0x9aa5b1), clouds);
  else if (p.elevation > -6) sky.lerpColors(new THREE.Color(0x1b2436), new THREE.Color(0xe7a86a), (p.elevation + 6) / 14);
  else sky.set(0x141b2c);
  scene.background = sky;
  scene.fog = new THREE.Fog(sky, 7000, 22000);
  const day0 = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()));
  const times = sunTimes(day0, lat, lon);
  $("suninfo").innerHTML =
    `Azimut <b>${p.azimuth.toFixed(1)}°</b> · Höhe <b>${p.elevation.toFixed(1)}°</b>` +
    (up ? "" : ' <span class="warn">(Sonne unter dem Horizont)</span>') +
    `<br>Aufgang ${formatLocal(times.sunrise, TZ)} · Untergang ${formatLocal(times.sunset, TZ)} · Marktplatz ${lat.toFixed(4)}° N, ${lon.toFixed(4)}° O` +
    (clouds ? `<br><span class="warn">Licht um Bewölkung ${cloudCover} % gedämpft (DWD)</span>` : "");
}

function updateSunPosition() {
  sun.target.position.copy(controls.target);
  sun.position.copy(controls.target).addScaledVector(sunDir, 2500);
}

function currentDate() {
  const [y, m, day] = $("date").value.split("-").map(Number);
  const minutes = parseInt($("time").value, 10);
  $("timeLabel").textContent = `${String(Math.floor(minutes / 60)).padStart(2, "0")}:${String(minutes % 60).padStart(2, "0")}`;
  return zonedToUtc(y, m, day, Math.floor(minutes / 60), minutes % 60, TZ);
}

function localToday() {
  const parts = new Intl.DateTimeFormat("en-CA", { timeZone: TZ, year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).formatToParts(new Date());
  const get = (t) => parts.find((p) => p.type === t).value;
  return { date: `${get("year")}-${get("month")}-${get("day")}`, minutes: Number(get("hour")) * 60 + Number(get("minute")) };
}

function initTimeControls() {
  const now = localToday();
  $("date").value = now.date;
  $("time").value = String(now.minutes);
  if (params.get("t")) {
    const [d, hm] = params.get("t").split("T");
    $("date").value = d;
    const [h, mi] = hm.split(":").map(Number);
    $("time").value = String(h * 60 + mi);
  }
  const update = () => setSun(currentDate());
  // Bei Nacht mit einer Mittagsansicht starten, damit die Szene nicht schwarz ist; "Jetzt" springt zur echten Zeit
  if (!params.get("t")) {
    const el = sunPosition(currentDate(), latLon[0], latLon[1]).elevation;
    if (el < 3) { $("time").value = "780"; $("startHint").hidden = false; }
  }
  $("now").addEventListener("click", () => { const n = localToday(); $("date").value = n.date; $("time").value = String(n.minutes); $("startHint").hidden = true; update(); });
  $("date").addEventListener("input", update);
  $("time").addEventListener("input", () => { $("startHint").hidden = true; update(); });
  $("clouds").addEventListener("change", update);
  document.querySelectorAll(".seasons button[data-d]").forEach((b) => b.addEventListener("click", () => {
    $("date").value = `${$("date").value.slice(0, 4)}-${b.dataset.d}`; update();
  }));
  update();
}

// ---------- Wetter (DWD über Bright Sky) ----------
const CONDITIONS = { dry: "trocken", fog: "Nebel", rain: "Regen", sleet: "Schneeregen", snow: "Schnee", hail: "Hagel", thunderstorm: "Gewitter" };
const ICONS = { "clear-day": "klar", "clear-night": "klar", "partly-cloudy-day": "leicht bewölkt", "partly-cloudy-night": "leicht bewölkt", cloudy: "bedeckt", fog: "Nebel", wind: "windig", rain: "Regen", sleet: "Schneeregen", snow: "Schnee", hail: "Hagel", thunderstorm: "Gewitter" };
const DIRS = ["N", "NO", "O", "SO", "S", "SW", "W", "NW"];
async function loadWeather() {
  const [lat, lon] = latLon;
  const body = $("weatherbody");
  try {
    const q = `lat=${lat.toFixed(4)}&lon=${lon.toFixed(4)}`;
    const cur = await loadJson(`https://api.brightsky.dev/current_weather?${q}`);
    const w = cur.weather, s = cur.sources.find((x) => x.id === w.source_id) || cur.sources[0];
    cloudCover = w.cloud_cover;
    const t = new Date(w.timestamp);
    const dir = w.wind_direction_10 != null ? DIRS[Math.round(w.wind_direction_10 / 45) % 8] : "";
    let html = `<b>${w.temperature != null ? w.temperature.toFixed(1).replace(".", ",") + " °C" : "–"}</b> · ${ICONS[w.icon] || CONDITIONS[w.condition] || w.condition || "–"}` +
      `<br>Wind ${w.wind_speed_10 != null ? Math.round(w.wind_speed_10) + " km/h" : "–"}${dir ? " aus " + dir : ""} · Bewölkung ${w.cloud_cover ?? "–"} % · Luftfeuchte ${w.relative_humidity ?? "–"} %` +
      `<br>Niederschlag letzte Stunde ${w.precipitation_60 != null ? w.precipitation_60.toFixed(1).replace(".", ",") : "–"} mm`;
    try {
      const day = await loadJson(`https://api.brightsky.dev/weather?${q}&date=${localToday().date}&tz=${TZ}`);
      const temps = day.weather.map((h) => h.temperature).filter((v) => v != null);
      const rain = day.weather.reduce((a, h) => a + (h.precipitation || 0), 0);
      const fc = day.sources.some((x) => x.observation_type === "forecast");
      html += `<br>Heute ${Math.min(...temps).toFixed(0)} bis ${Math.max(...temps).toFixed(0)} °C, Niederschlag ${rain.toFixed(1).replace(".", ",")} mm${fc ? " (Messung und Vorhersage)" : ""}`;
    } catch (e) { html += `<br><span class="warn">Tagesverlauf nicht verfügbar</span>`; }
    html += `<div class="src">Station ${s.station_name} (DWD ${s.dwd_station_id}), ${(s.distance / 1000).toFixed(1).replace(".", ",")} km entfernt, ${s.height} m, Stand ${new Intl.DateTimeFormat("de-DE", { timeZone: TZ, hour: "2-digit", minute: "2-digit" }).format(t)} Uhr.` +
      ` Daten: Deutscher Wetterdienst, bereitgestellt über <a href="https://brightsky.dev" target="_blank" rel="noopener">Bright Sky</a>. Kein Wert aus Sulzburg selbst.</div>`;
    body.innerHTML = html;
    if ($("clouds").checked) setSun(currentDate());
  } catch (e) {
    body.innerHTML = `<span class="warn">Wetterdaten nicht erreichbar.</span><div class="src">Quelle wäre: Deutscher Wetterdienst über Bright Sky (api.brightsky.dev).</div>`;
  }
}

// ---------- Quellenzeile ----------
function showSources() {
  const idx = meta.index, b = meta.buildings, lb = idx.luftbild;
  const liz = idx.quelle.lizenz;
  $("sources").innerHTML =
    `<b>Datenquellen und Stand</b> · Gelände: DGM1 1 m, Laserscan <b>${idx.quelle.aktualitaet_laserscan.join(", ")}</b>, hier ${idx.res_siedlung_m}/${idx.res_sonst_m} m · ` +
    (lb ? `Luftbild: DOP20, Bildflug <b>${lb.quelle.bildflugdatum.join(", ")}</b>, hier ${lb.aufloesungen_m.join("/")} m · ` : "Luftbild: noch nicht aufbereitet · ") +
    `Gebäude: LoD2 CityGML, Auslesedatum <b>${b.quelle.lieferinformation["Auslesedatum"] || "–"}</b>, ${b.anzahl} Gebäude (${b.anzahl_in_gemeinde} in Sulzburg) · ` +
    `Gemeindegrenze: ALKIS, Stand ${(idx.quelle.gemeindegrenze.match(/Stand ([\d-]+)/) || [])[1] || "–"}<br>` +
    `${liz.namensnennung} · <a href="${liz.url}" target="_blank" rel="noopener">${liz.name}</a> · Wetter: DWD über Bright Sky · Sonnenstand: NOAA-Algorithmus, eigene Berechnung · ` +
    `<a href="quellen.html"><b>Datenquellen und Grenzen</b></a> · Privates Projekt, kein Angebot der Stadt oder eines Unternehmens.`;
}

// ---------- Klick-Info ----------
// Gebäude-Info im rechten Feld (Klick, Adresssuche)
function showBuilding(idx) {
  const info = $("info");
  const g = meta.buildings.gebaeude[idx];
  if (!g) return;
  const dgm = terrainHeightAt(g.e - meta.buildings.e0, -(g.n - meta.buildings.n0));
  const fmt = (v, d = 1) => (v == null ? "–" : Number(v).toFixed(d).replace(".", ","));
  info.hidden = false;
  info.innerHTML = `<h2>${g.adresse || "Gebäude ohne Adresse"}</h2><dl>` +
    `<dt>Gemeinde</dt><dd>${g.gemeinde || "–"}${g.in_gemeinde ? "" : " (Nachbargemeinde im Randbereich)"}</dd>` +
    `<dt>Funktion</dt><dd>${g.funktion_name || "–"} <span style="color:var(--muted)">(${g.funktion || "–"})</span></dd>` +
    `<dt>Dachform</dt><dd>${g.dachform_name || "–"} <span style="color:var(--muted)">(${g.dachform || "–"}${g.dachformen_teile ? ", Teile: " + g.dachformen_teile.join("/") : ""})</span></dd>` +
    `<dt>Höhe</dt><dd>${fmt(g.hoehe_m)} m (LoD2 measuredHeight)</dd>` +
    `<dt>First</dt><dd>${fmt(g.z_first)} m NHN</dd>` +
    `<dt>Boden LoD2</dt><dd>${fmt(g.z_boden_min)}${g.z_boden_max !== g.z_boden_min ? " bis " + fmt(g.z_boden_max) : ""} m NHN</dd>` +
    `<dt>Gelände hier</dt><dd>${dgm == null ? "–" : fmt(dgm) + " m NHN (DGM1, Darstellung)"}</dd>` +
    `<dt>Grundriss</dt><dd>Stand ${g.grundriss_aktualitaet || "–"}, Modell ${g.erstellt || "–"}</dd>` +
    `<dt>ID</dt><dd style="font-family:monospace;font-size:11px">${g.id}</dd></dl>` +
    sunlightInfo(idx) +
    infoHooks.map((h) => h(idx, g) || "").join("") +
    externalLinks(g) +
    `<div class="hint">LGL LoD2, dl-de/by-2-0. Bauteile: ${g.bauteile}. Klick ins Leere schließt.</div>`;
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
    const info = $("info");
    for (const h of pickHooks) { if (h(ray)) return; }
    if (stopsGroup && stopsGroup.visible) {
      const sh = ray.intersectObjects(stopsGroup.children, false)[0];
      if (sh) { showStop(sh.object.userData.stop); return; }
    }
    const hit = ray.intersectObjects(buildingMeshes, false)[0];
    if (!hit) { info.hidden = true; return; }
    const attr = hit.object.geometry.getAttribute("_building");
    showBuilding(Math.round(attr.getX(hit.face.a)));
  });
}

function setupNavigation() {
  const ray = new THREE.Raycaster();
  const mouse = new THREE.Vector2();
  canvas.addEventListener("dblclick", (e) => {
    mouse.set((e.clientX / innerWidth) * 2 - 1, -(e.clientY / innerHeight) * 2 + 1);
    ray.setFromCamera(mouse, camera);
    const objs = [...terrainGroup.children, ...buildingMeshes];
    const hit = ray.intersectObjects(objs, false)[0];
    if (hit) targetGoal = hit.point.clone();
  });
  $("autorotate").addEventListener("change", (e) => { controls.autoRotate = e.target.checked; });
  canvas.addEventListener("pointerdown", () => { flight = null; if (controls.autoRotate) { controls.autoRotate = false; $("autorotate").checked = false; } });
  canvas.addEventListener("wheel", () => { flight = null; }, { passive: true });
  // Sprungziele: Marktplatz, Gemarkungen (Schwerpunkt der Gebäude je Gemarkung), Überblick
  const { e0, n0 } = meta.index;
  const inRing = (x, y, ring) => { let inside = false; for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const [xi, yi] = ring[i], [xj, yj] = ring[j]; if ((yi > y) !== (yj > y) && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) inside = !inside; } return inside; };
  const jumps = [{ name: "Marktplatz", x: 0, z: 0, dist: 450 }];
  for (const f of meta.gemeinde.features.filter((f) => f.properties.typ === "Gemarkung")) {
    const ring = f.geometry.coordinates[0];
    const pts = meta.buildings.gebaeude.filter((g) => inRing(g.e, g.n, ring));
    if (pts.length < 10) continue;
    const e = pts.reduce((a, g) => a + g.e, 0) / pts.length, n = pts.reduce((a, g) => a + g.n, 0) / pts.length;
    if (Math.hypot(e - e0, n - n0) < 400) continue; // Gemarkung Sulzburg = Marktplatz
    jumps.push({ name: f.properties.name, x: e - e0, z: -(n - n0), dist: 700 });
  }
  jumps.push({ name: "Überblick", x: 0, z: 0, dist: 2600, overview: true });
  const box = $("jumps");
  for (const jmp of jumps) {
    const b = document.createElement("button"); b.textContent = jmp.name;
    b.addEventListener("click", () => {
      const y = terrainHeightAt(jmp.x, jmp.z) ?? centerY;
      const goal = new THREE.Vector3(jmp.x, y, jmp.z);
      const dir = jmp.overview ? new THREE.Vector3(-0.75, 0.55, 0.6) : new THREE.Vector3(-0.45, 0.55, 0.7);
      flyTo(goal, jmp.dist, dir);
    });
    box.appendChild(b);
  }
}

// ---------- Sonne auf dem Dach (vorberechnet in scripts/06_sunlight.py) ----------
function monthIndex() { return parseInt($("date").value.slice(5, 7), 10) - 1; }
function utcMinutesToLocal(dayIso, minutes) {
  if (minutes < 0) return "–";
  const d = new Date(`${dayIso}T00:00:00Z`);
  const local = (minutes + tzOffsetMs(d, TZ) / 60000 + 1440) % 1440;
  return `${String(Math.floor(local / 60)).padStart(2, "0")}:${String(Math.round(local % 60)).padStart(2, "0")}`;
}
function hm(min) { return `${Math.floor(min / 60)} h ${String(min % 60).padStart(2, "0")} min`; }
function sunlightInfo(idx) {
  const sl = meta.sunlight;
  if (!sl) return "";
  const vals = sl.werte[idx];
  const row = (m) => {
    const [first, last, minutes] = vals.slice(m * 3, m * 3 + 3);
    const day = sl.tage[m];
    const label = new Intl.DateTimeFormat("de-DE", { day: "numeric", month: "short" }).format(new Date(day + "T12:00:00Z"));
    return `<dt>${label}</dt><dd>${minutes > 0 ? `${utcMinutesToLocal(day, first)} bis ${utcMinutesToLocal(day, last)} Uhr, ${hm(minutes)} von ${hm(sl.moegliche_minuten[m])}` : "keine direkte Sonne am First"}</dd>`;
  };
  const m = monthIndex();
  const months = m === 11 ? [11, 5] : m === 5 ? [5, 11] : [m, 11, 5];
  return `<h3>Sonne auf dem First</h3><dl>${months.map(row).join("")}</dl>` +
    `<div class="hint">Geländehorizont aus dem DGM1, ohne Nachbargebäude und Bäume. Referenztag ist der 21. des Monats.</div>`;
}
// Verweise auf Straßenansichten Dritter (nur Links, es werden keine Bilder übernommen)
function externalLinks(g) {
  const [lat, lon] = utmToLatLon(g.e, g.n);
  const sv = `https://www.google.com/maps/@?api=1&map_action=pano&viewpoint=${lat.toFixed(6)},${lon.toFixed(6)}`;
  const mp = `https://www.mapillary.com/app/?lat=${lat.toFixed(6)}&lng=${lon.toFixed(6)}&z=18`;
  return `<div class="links small"><a href="${sv}" target="_blank" rel="noopener">In Google Street View ansehen</a> · <a href="${mp}" target="_blank" rel="noopener">Mapillary</a> <span class="muted">(externe Dienste, Verfügbarkeit vor Ort nicht garantiert)</span></div>`;
}

function setupSunlightLayer() {
  const sl = meta.sunlight;
  if (!sl || !roofMeshes.length) { $("sunlayerWrap").hidden = true; return; }
  // Farbskala mit klaren Stufen (angelehnt an Viridis): wenig Sonne violett, viel Sonne gelb
  const stops = [0x440154, 0x3b528b, 0x21918c, 0x5ec962, 0xfde725].map((c) => new THREE.Color(c));
  const tmp = new THREE.Color();
  const ramp = (f) => { const x = Math.min(0.9999, Math.max(0, f)) * (stops.length - 1); const i = Math.floor(x); return tmp.copy(stops[i]).lerp(stops[i + 1], x - i); };
  // Spannweite je Monat (5. bis 95. Perzentil), damit Unterschiede sichtbar werden
  const range = sl.tage.map((_, m) => { const xs = sl.werte.map((v) => v[m * 3 + 2]).sort((a, b) => a - b); return [xs[Math.floor(xs.length * 0.05)], xs[Math.floor(xs.length * 0.95)]]; });
  const apply = () => {
    const on = $("sunlayer").checked;
    const m = monthIndex();
    const possible = sl.moegliche_minuten[m];
    const [lo, hi] = range[m];
    for (const mesh of roofMeshes) {
      const attr = mesh.geometry.getAttribute("color"), bid = mesh.geometry.getAttribute("_building"), orig = mesh.userData.originalColors;
      for (let i = 0; i < attr.count; i++) {
        if (!on) { attr.setXYZ(i, orig[i * 3], orig[i * 3 + 1], orig[i * 3 + 2]); continue; }
        const minutes = sl.werte[Math.round(bid.getX(i))][m * 3 + 2];
        const f = hi > lo ? Math.min(1, Math.max(0, (minutes - lo) / (hi - lo))) : 1;
        ramp(f).convertSRGBToLinear();
        attr.setXYZ(i, tmp.r, tmp.g, tmp.b);
      }
      attr.needsUpdate = true;
      mesh.material.map = on || !$("rooftex").checked ? null : mesh.userData.roofMap;
      mesh.material.needsUpdate = true;
    }
    const label = new Intl.DateTimeFormat("de-DE", { day: "numeric", month: "long" }).format(new Date(sl.tage[m] + "T12:00:00Z"));
    $("sunlegend").hidden = !on;
    const ticks = [0, 0.25, 0.5, 0.75, 1].map((f) => `<span class="swatch" style="background:#${ramp(f).getHexString()}"></span>`).join("");
    $("sunlegend").innerHTML = `Direkte Sonne am First am ${label}: ${hm(lo)} ${ticks} ${hm(hi)}<br><span class="muted">Skala zwischen den 5 % sonnenärmsten und 5 % sonnenreichsten Gebäuden; möglich wären ${hm(possible)}.</span>`;
  };
  $("sunlayer").addEventListener("change", apply);
  $("date").addEventListener("input", () => { if ($("sunlayer").checked) apply(); });
  document.querySelectorAll(".seasons button[data-d]").forEach((b) => b.addEventListener("click", () => { if ($("sunlayer").checked) setTimeout(apply, 0); }));
}

// ---------- Bäume (nDOM1: Lage und Höhe echt, Form generisch) ----------
let treeMesh = null;
function setupTrees() {
  const info = meta.trees, buf = meta.treesBuf;
  if (!info || !buf) { $("treesWrap").hidden = true; return; }
  const data = new Float32Array(buf);
  const n = data.length / 3;
  // Generische Baumform (Einheitshöhe 1): kurzer Stamm, runde Krone. Artunabhängig, bewusst schlicht (28 Dreiecke je Baum).
  const trunk = new THREE.CylinderGeometry(0.035, 0.045, 0.45, 4, 1, true).toNonIndexed(); trunk.translate(0, 0.22, 0);
  const crown = new THREE.IcosahedronGeometry(0.33, 0); crown.scale(1, 1.15, 1); crown.translate(0, 0.66, 0);
  const geo = mergeGeometries([trunk, crown]);
  const mat = new THREE.MeshLambertMaterial({ color: 0xffffff });
  const build = (step) => {
    const count = Math.ceil(n / step);
    const mesh = new THREE.InstancedMesh(geo, mat, count);
    const m4 = new THREE.Matrix4(), q = new THREE.Quaternion(), pos = new THREE.Vector3(), scl = new THREE.Vector3(), col = new THREE.Color();
    let k = 0;
    for (let i = 0; i < n; i += step) {
      const x = data[i * 3], z = data[i * 3 + 1], h = data[i * 3 + 2];
      const y = terrainHeightAt(x, z);
      if (y == null) continue;
      const w = h * 0.45; // Kronenbreite: Darstellung, kein Datum
      pos.set(x, y, z); scl.set(w, h, w);
      q.setFromAxisAngle(new THREE.Vector3(0, 1, 0), ((i * 7919) % 360) * Math.PI / 180);
      mesh.setMatrixAt(k, m4.compose(pos, q, scl));
      // Farbe nach Höhe: niedrig hellgrün (Gärten, Hecken), hoch dunkelgrün (Wald)
      col.setHSL(0.27 + ((i * 31) % 7) * 0.004, 0.45, THREE.MathUtils.lerp(0.42, 0.22, Math.min(1, h / 30)));
      mesh.setColorAt(k, col);
      k++;
    }
    mesh.count = k;
    mesh.instanceMatrix.needsUpdate = true;
    mesh.instanceColor.needsUpdate = true;
    mesh.castShadow = true; mesh.receiveShadow = true;
    mesh.frustumCulled = false;
    return mesh;
  };
  const rebuild = () => {
    if (treeMesh) { scene.remove(treeMesh); treeMesh.dispose(); }
    treeMesh = build(LOD > 1 ? 3 : 1);
    treeMesh.visible = $("trees").checked;
    scene.add(treeMesh);
    $("treesInfo").textContent = `${treeMesh.count.toLocaleString("de-DE")} von ${n.toLocaleString("de-DE")} Bäumen (nDOM1, Stand ${(info.quelle.oberflaeche_aktualitaet || []).join(", ")}), Höhe echt, Form generisch`;
  };
  rebuild();
  $("trees").addEventListener("change", (e) => { if (treeMesh) treeMesh.visible = e.target.checked; });
  $("lod").addEventListener("change", rebuild);
}

// ---------- Bus und Bahn (Soll-Fahrplan, MobiData BW / NVBW) ----------
let stopsGroup = null;
function setupTransit() {
  const tr = meta.transit;
  if (!tr) { $("transitWrap").hidden = true; return; }
  stopsGroup = new THREE.Group();
  const geo = new THREE.CylinderGeometry(1.6, 1.6, 0.6, 16);
  const pole = new THREE.CylinderGeometry(0.15, 0.15, 4, 6);
  const mat = new THREE.MeshStandardMaterial({ color: 0x2f7fd6, roughness: 0.6 });
  const poleMat = new THREE.MeshStandardMaterial({ color: 0xe8e6e1 });
  for (const st of tr.haltestellen) {
    if (!st.abfahrten.length) continue;
    const y = terrainHeightAt(st.x, st.zz) ?? st.z ?? centerY;
    const disc = new THREE.Mesh(geo, mat);
    disc.position.set(st.x, y + 4, st.zz);
    disc.userData.stop = st;
    disc.castShadow = true;
    const p = new THREE.Mesh(pole, poleMat);
    p.position.set(st.x, y + 2, st.zz);
    p.userData.stop = st;
    stopsGroup.add(disc, p);
  }
  scene.add(stopsGroup);
  $("transit").addEventListener("change", (e) => { stopsGroup.visible = e.target.checked; });
  const routes = Object.values(tr.linien).map((r) => r.name).sort();
  $("transitInfo").textContent = `${tr.haltestellen.length} Haltesteige, Linien ${routes.join(", ")} (${[...new Set(Object.values(tr.linien).map((r) => r.agency))].join(", ")}), Soll-Fahrplan Stand ${tr.quelle.feed_info.feed_version || "–"}`;
}
function showStop(st) {
  const tr = meta.transit;
  const info = $("info");
  // Betriebstag und Uhrzeit aus den Reglern (Datum/Zeit der Anwendung), Abfahrten ab dieser Zeit
  const dayIso = $("date").value;
  const minutesNow = parseInt($("time").value, 10);
  const di = tr.zeitraum.tage.indexOf(dayIso);
  const fmt = (sec) => `${String(Math.floor(sec / 3600) % 24).padStart(2, "0")}:${String(Math.floor(sec / 60) % 60).padStart(2, "0")}`;
  let rows = "";
  if (di < 0) {
    rows = `<div class="muted small">Für ${dayIso} liegen keine Fahrplandaten vor (Zeitraum ${tr.zeitraum.von} bis ${tr.zeitraum.bis}).</div>`;
  } else {
    const deps = st.abfahrten.filter((a) => (a[3][Math.floor(di / 30)] >> (di % 30)) & 1 && !a[4] && a[0] >= minutesNow * 60);
    const all = st.abfahrten.filter((a) => (a[3][Math.floor(di / 30)] >> (di % 30)) & 1 && !a[4]);
    rows = deps.length ? `<table class="deps">${deps.slice(0, 8).map((a) => `<tr><td>${fmt(a[0])}</td><td><b>${tr.linien[a[1]]?.name || "?"}</b></td><td>${a[2]}</td></tr>`).join("")}</table>` +
      `<div class="muted small">${all.length} Abfahrten an diesem Tag, ab ${$("timeLabel").textContent} Uhr gezeigt.</div>` :
      `<div class="muted small">Keine weiteren Abfahrten an diesem Tag ab ${$("timeLabel").textContent} Uhr (${all.length} insgesamt).</div>`;
  }
  info.hidden = false;
  info.innerHTML = `<h2>${st.name}</h2><div class="muted small">Haltestelle${st.platform ? ", Steig " + st.platform : ""} · ${st.lat.toFixed(5)}° N, ${st.lon.toFixed(5)}° O</div>` +
    `<h3>Nächste Abfahrten laut Soll-Fahrplan</h3>${rows}` +
    `<div class="hint">Soll-Fahrplandaten (GTFS) der NVBW über MobiData BW, dl-de/by-2-0, Stand ${tr.quelle.feed_info.feed_version || "–"}. Keine Echtzeit, keine Verspätungen. Richtung = Fahrtziel.</div>`;
}

// ---------- DWD-Warnungen (über Bright Sky) ----------
const SEVERITY = { minor: "Wetterwarnung", moderate: "Markante Wetterwarnung", severe: "Unwetterwarnung", extreme: "Extreme Unwetterwarnung" };
async function loadAlerts() {
  const [lat, lon] = latLon;
  const box = $("alerts");
  try {
    const d = await loadJson(`https://api.brightsky.dev/alerts?lat=${lat.toFixed(4)}&lon=${lon.toFixed(4)}`);
    const fmt = (iso) => new Intl.DateTimeFormat("de-DE", { timeZone: TZ, weekday: "short", hour: "2-digit", minute: "2-digit" }).format(new Date(iso));
    if (!d.alerts || !d.alerts.length) { box.hidden = true; return; }
    box.hidden = false;
    box.innerHTML = d.alerts.map((a) => `<div class="alert ${a.severity}"><b>${a.headline_de || a.event_de}</b> <span class="muted">(${SEVERITY[a.severity] || a.severity}, ${fmt(a.onset)} bis ${fmt(a.expires)} Uhr)</span>` +
      `<details><summary>Details</summary>${a.description_de || ""}${a.instruction_de ? "<br>" + a.instruction_de : ""}</details></div>`).join("") +
      `<div class="muted small">Amtliche Warnungen des Deutschen Wetterdienstes für ${d.location?.name || "Sulzburg"}, abgerufen über Bright Sky.</div>`;
  } catch (e) {
    box.hidden = false;
    box.innerHTML = `<span class="muted small">DWD-Warnungen derzeit nicht abrufbar.</span>`;
  }
}

// Schließen-Knopf für das Info-Feld (vor allem auf Touch-Geräten)
function setupInfoClose() {
  const info = $("info");
  new MutationObserver(() => {
    if (info.hidden || info.querySelector(".close")) return;
    const b = document.createElement("button");
    b.className = "close"; b.setAttribute("aria-label", "Schließen"); b.textContent = "×";
    b.addEventListener("click", () => { info.hidden = true; });
    info.prepend(b);
  }).observe(info, { childList: true, attributes: true, attributeFilter: ["hidden"] });
}

function setupMenu() {
  const panel = $("sunpanel"), btn = $("menuToggle");
  const set = (collapsed) => { panel.classList.toggle("collapsed", collapsed); btn.textContent = collapsed ? "Menü ▾" : "Menü ▴"; btn.setAttribute("aria-expanded", String(!collapsed)); };
  btn.addEventListener("click", () => set(!panel.classList.contains("collapsed")));
  if (innerWidth < 900) set(true);   // auf dem Handy startet das Menü eingeklappt
}

function setupToggles() {
  $("shadows").addEventListener("change", (e) => { renderer.shadowMap.enabled = e.target.checked; sun.castShadow = e.target.checked;
    scene.traverse((o) => { if (o.material) o.material.needsUpdate = true; }); });
  $("ortho").addEventListener("change", (e) => {
    for (const { mesh } of tiles.values()) {
      mesh.material.map = e.target.checked ? mesh.userData.ortho || null : null;
      mesh.material.color.set(e.target.checked && mesh.userData.ortho ? 0xffffff : 0x7f8c6e);
      mesh.material.needsUpdate = true;
    }
  });
  $("grenze").addEventListener("change", (e) => { if (boundaryLine) boundaryLine.visible = e.target.checked; });
  $("lod").value = String(LOD);
  $("lod").addEventListener("change", (e) => { LOD = parseInt(e.target.value, 10); rebuildTerrain(); });
}

let totalTextures = 0;
function updateProgress() {
  $("progress").textContent = `Gelände ${tiles.size} Kacheln · Luftbild ${texturesLoaded}/${totalTextures} · Gebäude ${buildingsMesh ? meta.buildings.anzahl : "…"}`;
  if (buildingsMesh && texturesLoaded >= totalTextures) $("loading").classList.add("done");
}

function resize() {
  renderer.setSize(innerWidth, innerHeight, false);
  camera.aspect = innerWidth / innerHeight;
  camera.updateProjectionMatrix();
}

async function main() {
  const t0 = performance.now();
  const [index, buildings, gemeinde, heightsBuf, sunlight, transit, trees, treesBuf] = await Promise.all([
    loadJson("data/terrain/index.json"), loadJson("data/buildings.json"), loadJson("data/gemeinde.geojson"),
    fetch("data/terrain/heights.bin").then((r) => r.arrayBuffer()),
    loadJson("data/sunlight.json").catch(() => null),
    loadJson("data/transit.json").catch(() => null),
    loadJson("data/trees.json").catch(() => null),
    fetch("data/trees.bin").then((r) => (r.ok ? r.arrayBuffer() : null)).catch(() => null),
  ]);
  Object.assign(meta, { index, buildings, gemeinde, sunlight, transit, trees, treesBuf });
  latLon = utmToLatLon(index.e0, index.n0);
  buildTerrain(heightsBuf);
  centerY = terrainHeightAt(0, 0) ?? 340;
  buildBoundary(gemeinde);
  totalTextures = loadOrthos();
  updateProgress();

  controls.target.set(0, centerY, 0);
  camera.position.set(-1100, centerY + 650, 850);
  if (params.get("cam")) { const v = params.get("cam").split(",").map(Number); camera.position.set(v[0], centerY + v[1], v[2]); }
  if (params.get("target")) { const v = params.get("target").split(",").map(Number); controls.target.set(v[0], (terrainHeightAt(v[0], v[1]) ?? centerY), v[1]); }
  controls.update();
  initTimeControls();
  setupPicking();
  setupMenu();
  setupInfoClose();
  setupToggles();
  loadWeather();

  const gltf = await new GLTFLoader().loadAsync("data/buildings.glb");
  gltf.scene.traverse((o) => {
    if (!o.isMesh) return;
    const name = o.userData?.name || o.material?.name || "";
    const map = o.material.map || null;
    if (map) { map.colorSpace = THREE.SRGBColorSpace; map.anisotropy = renderer.capabilities.getMaxAnisotropy(); }
    o.material = new THREE.MeshStandardMaterial({ vertexColors: true, flatShading: true, roughness: 0.9, metalness: 0, map });
    o.userData.roofMap = map;
    o.castShadow = true; o.receiveShadow = true;
    buildingMeshes.push(o);
    if (name.startsWith("roofs")) roofMeshes.push(o);
    // Originalfarben als normalisierte Werte sichern (COLOR_0 liegt als normalisiertes Uint8 vor)
    const ca = o.geometry.getAttribute("color");
    const orig = new Float32Array(ca.count * 3);
    for (let i = 0; i < ca.count; i++) { orig[i * 3] = ca.getX(i); orig[i * 3 + 1] = ca.getY(i); orig[i * 3 + 2] = ca.getZ(i); }
    o.userData.originalColors = orig;
  });
  buildingsMesh = buildingMeshes[0];
  scene.add(gltf.scene);
  $("rooftex").addEventListener("change", (e) => { for (const r of roofMeshes) { r.material.map = e.target.checked && !$("sunlayer").checked ? r.userData.roofMap : null; r.material.needsUpdate = true; } });
  setupNavigation();
  setupSunlightLayer();
  setupTransit();
  setupTrees();
  const ctx = { THREE, scene, camera, controls, renderer, meta, $, terrainHeightAt, flyTo, frameHooks, pickHooks, infoHooks, buildingMeshes, roofMeshes, utmToLatLon, TZ, centerY,
    setSun: () => setSun(currentDate()), localToday, showBuilding, sunTimes, latLon };
  window.__ctx = ctx;
  await setupPlaces(ctx);
  await setupScenario(ctx);
  await setupBusiness(ctx);
  await setupExtras(ctx);
  showSources();
  loadAlerts();
  updateProgress();
  window.__loadMs = Math.round(performance.now() - t0);
  const reduced = window.matchMedia && window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  if (!params.get("cam") && params.get("intro") !== "0" && !reduced) {
    // Einstieg: Blick aus der Rheinebene im Westen, dann Flug ins Tal zum Marktplatz
    camera.position.set(-3800, centerY + 1400, 1600);
    controls.target.set(-600, centerY, 0);
    controls.update();
    flyTo(new THREE.Vector3(0, centerY, 0), innerWidth < innerHeight ? 1150 : 650, new THREE.Vector3(-0.62, 0.5, 0.6), 7000);
  }

  let frames = 0, last = performance.now(), prev = performance.now();
  const fwd = new THREE.Vector3(), right = new THREE.Vector3(), delta = new THREE.Vector3();
  renderer.setAnimationLoop((now) => {
    const dt = Math.min(0.1, (now - prev) / 1000); prev = now;
    for (const h of frameHooks) h(now, dt);
    if (flight) {
      const f = Math.min(1, (now - flight.start) / flight.dur);
      const k = f < 0.5 ? 4 * f * f * f : 1 - Math.pow(-2 * f + 2, 3) / 2; // ease in-out
      // Bogen: in der Mitte des Flugs etwas höher, damit die Kamera nicht durch Hänge fliegt
      const lift = Math.sin(Math.PI * f) * Math.min(400, flight.p0.distanceTo(flight.p1) * 0.25);
      camera.position.lerpVectors(flight.p0, flight.p1, k).y += lift;
      controls.target.lerpVectors(flight.t0, flight.t1, k);
      if (f >= 1) flight = null;
    }
    // WASD / QE: über das Gelände fahren, Geschwindigkeit abhängig vom Abstand zum Blickpunkt
    if (keys.size) {
      const dist = camera.position.distanceTo(controls.target);
      const speed = Math.max(0.5, dist * 0.012);
      camera.getWorldDirection(fwd); fwd.y = 0; fwd.normalize();
      right.crossVectors(fwd, camera.up).normalize();
      delta.set(0, 0, 0);
      if (keys.has("w")) delta.addScaledVector(fwd, speed);
      if (keys.has("s")) delta.addScaledVector(fwd, -speed);
      if (keys.has("d")) delta.addScaledVector(right, speed);
      if (keys.has("a")) delta.addScaledVector(right, -speed);
      if (keys.has("q")) delta.y -= speed * 0.5;
      if (keys.has("e")) delta.y += speed * 0.5;
      if (delta.lengthSq()) { camera.position.add(delta); controls.target.add(delta); }
    }
    // Blickpunkt sanft zum Ziel ziehen (Doppelklick, Sprungknöpfe)
    if (targetGoal) {
      delta.copy(targetGoal).sub(controls.target);
      if (delta.length() < 0.5) { targetGoal = null; } else { delta.multiplyScalar(0.12); camera.position.add(delta); controls.target.add(delta); }
    }
    controls.update();
    // Blickpunkt auf dem Boden halten, Kamera nicht unter das Gelände lassen
    const th = terrainHeightAt(controls.target.x, controls.target.z);
    if (th != null && !targetGoal && !flight) { const dy = th - controls.target.y; if (Math.abs(dy) > 0.05) { controls.target.y += dy; camera.position.y += dy; } }
    const ch = terrainHeightAt(camera.position.x, camera.position.z);
    if (ch != null && camera.position.y < ch + 4) camera.position.y = ch + 4;
    updateSunPosition();
    renderer.render(scene, camera);
    frames++;
    if (now - last >= 1000) {
      const fps = Math.round((frames * 1000) / (now - last));
      $("fps").textContent = `${fps} Bilder/s · Gelände ${(index.dreiecke / (LOD * LOD) / 1000).toFixed(0)}k Dreiecke (${LOD > 1 ? "grob" : "fein"}) · Gebäude ${(buildings.dreiecke / 1000).toFixed(0)}k · Schatten ${SHADOW_MAP}px im Umkreis ${SHADOW_RADIUS} m`;
      frames = 0; last = now; window.__fps = fps;
    }
  });
  window.__ready = true;
}

// UTM 32N (ETRS89/GRS80) -> Breite/Länge, für den Sonnenstand
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
