// Sulzburg 3D, Phase 1: gekacheltes Gelände (DGM1) + Luftbild (DOP20) + alle LoD2-Gebäude + Sonnenstand + Wetter (DWD).
// Datenquelle aller Geodaten: LGL Baden-Württemberg, www.lgl-bw.de, dl-de/by-2-0 (siehe quellen.html und web/data/*.json).
import * as THREE from "three";
import { OrbitControls } from "three/addons/controls/OrbitControls.js";
import { GLTFLoader } from "three/addons/loaders/GLTFLoader.js";
import { sunPosition, sunTimes, zonedToUtc, formatLocal } from "./sun.js";

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
  hemi.intensity = THREE.MathUtils.lerp(0.15, 1.0, THREE.MathUtils.clamp((p.elevation + 8) / 20, 0, 1)) * (1 + 0.3 * clouds);
  const sky = new THREE.Color();
  if (p.elevation > 8) sky.set(0xb9d4ee).lerp(new THREE.Color(0x9aa5b1), clouds);
  else if (p.elevation > -6) sky.lerpColors(new THREE.Color(0x1b2436), new THREE.Color(0xe7a86a), (p.elevation + 6) / 14);
  else sky.set(0x0e1322);
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
  $("date").addEventListener("input", update);
  $("time").addEventListener("input", update);
  $("clouds").addEventListener("change", update);
  document.querySelectorAll(".seasons button").forEach((b) => b.addEventListener("click", () => {
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
      `<div class="hint">LGL LoD2, dl-de/by-2-0. Bauteile: ${g.bauteile}. Klick ins Leere schließt.</div>`;
  });
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
  const [index, buildings, gemeinde, heightsBuf] = await Promise.all([
    loadJson("data/terrain/index.json"), loadJson("data/buildings.json"), loadJson("data/gemeinde.geojson"),
    fetch("data/terrain/heights.bin").then((r) => r.arrayBuffer()),
  ]);
  Object.assign(meta, { index, buildings, gemeinde });
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
  setupToggles();
  loadWeather();

  const gltf = await new GLTFLoader().loadAsync("data/buildings.glb");
  buildingsMesh = gltf.scene.getObjectByProperty("type", "Mesh");
  buildingsMesh.material = new THREE.MeshStandardMaterial({ vertexColors: true, flatShading: true, roughness: 0.9, metalness: 0 });
  buildingsMesh.castShadow = true;
  buildingsMesh.receiveShadow = true;
  scene.add(buildingsMesh);
  showSources();
  updateProgress();
  window.__loadMs = Math.round(performance.now() - t0);

  let frames = 0, last = performance.now();
  renderer.setAnimationLoop((now) => {
    controls.update();
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
