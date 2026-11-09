// Live-Wetter in der 3D-Ansicht. Quellen: Deutscher Wetterdienst über Bright Sky (api.brightsky.dev):
//  - Station Müllheim (aktuelles Wetter, alle 10 min): Bewölkung, Sichtweite, Temperatur, Wetterlage
//  - Regenradar RADOLAN RV (alle 5 min, 1-km-Raster, mit Vorhersage bis 2 h)
// Gezeigt wird nur, wenn die eingestellte Uhrzeit „jetzt“ ist (höchstens 30 min Abstand). Für andere Zeiten liegt
// keine Messung vor, dann bleibt der Himmel klar wie bisher. Regen, Schnee, Nebel und nasse Straßen sind Darstellung
// auf Grundlage dieser Messungen; Tropfen und Flocken selbst sind kein Datum.

const RADAR_KM = 8;            // halbe Kantenlänge des Radarausschnitts um Sulzburg
const RADAR_REFRESH = 5 * 60e3, STATION_REFRESH = 10 * 60e3;
const RAMP = [[0.1, [158, 202, 225]], [0.5, [107, 174, 214]], [2, [49, 130, 189]], [5, [8, 81, 156]], [15, [84, 39, 143]]];  // mm/h

export function setupWeather(ctx) {
  const { THREE, scene, camera, controls, $ } = ctx;
  const { e0, n0 } = ctx.meta.index;
  let radar = null, radarAt = 0, radarIdx = -1, liveIdx = -1, overlay = null, rain = null, lastLive = null, lastOwner = null;

  // ---------- Zeit und Zustand ----------
  const isLive = () => {
    const now = ctx.localToday();
    return $("date").value === now.date && Math.abs(parseInt($("time").value, 10) - now.minutes) <= 30;
  };
  const on = () => $("clouds").checked && isLive();

  // ---------- Lage: Breite/Länge -> lokale Koordinaten (Umkehrung von utmToLatLon per Newton-Schritten) ----------
  function toLocal(lat, lon) {
    const [la0, lo0] = ctx.latLon;
    let x = (lon - lo0) * 111320 * Math.cos((la0 * Math.PI) / 180), z = -(lat - la0) * 110574;
    for (let k = 0; k < 4; k++) {
      const [la, lo] = ctx.utmToLatLon(e0 + x, n0 - z);
      x += (lon - lo) * 111320 * Math.cos((lat * Math.PI) / 180);
      z -= (lat - la) * 110574;
    }
    return [x, z];
  }

  // ---------- Radar laden ----------
  async function loadRadar() {
    const [lat, lon] = ctx.latLon;
    const t = new Date(), iso = (d) => d.toISOString().slice(0, 16);
    const url = `https://api.brightsky.dev/radar?lat=${lat.toFixed(4)}&lon=${lon.toFixed(4)}&distance=${RADAR_KM * 1000}&format=plain` +
      `&date=${iso(new Date(t - 65 * 60e3))}&last_date=${iso(new Date(+t + 125 * 60e3))}`;
    try {
      const r = await fetch(url);
      if (!r.ok) throw new Error(r.status);
      const d = await r.json();
      const g = d.geometry.coordinates;   // Ecken NW, SW, SO, NO (Außenkanten des Ausschnitts)
      const [nw, sw, se, ne] = g.map(([lo, la]) => toLocal(la, lo));
      const H = d.radar[0].precipitation_5.length, W = d.radar[0].precipitation_5[0].length;
      radar = { frames: d.radar.map((f) => ({ t: new Date(f.timestamp), p: f.precipitation_5 })), nw, sw, se, ne, W, H };
      radarAt = Date.now();
      const now = Date.now();
      liveIdx = radar.frames.reduce((best, f, i) => (+f.t <= now ? i : best), 0);   // letzte Messung
      if (radarIdx < 0 || radarIdx >= radar.frames.length) radarIdx = liveIdx;
      setupTimeline();
      if (overlay) drawOverlay();
      ctx.requestRender?.();
    } catch (e) { radar = null; }
    status();
  }
  // Wert an einer lokalen Stelle (mm/h), über die Lage im Viereck des Ausschnitts
  function rateAt(x, z, idx = liveIdx) {
    if (!radar || idx < 0) return null;
    const { nw, ne, sw, W, H } = radar;
    const ax = ne[0] - nw[0], az = ne[1] - nw[1], bx = sw[0] - nw[0], bz = sw[1] - nw[1], px = x - nw[0], pz = z - nw[1];
    const det = ax * bz - az * bx, u = (px * bz - pz * bx) / det, v = (ax * pz - az * px) / det;
    if (u < 0 || u >= 1 || v < 0 || v >= 1) return null;
    return radar.frames[idx].p[Math.floor(v * H)][Math.floor(u * W)] * 0.12;   // 0,01 mm je 5 min -> mm/h
  }
  function sumLastHour(x, z) {
    if (!radar) return 0;
    let s = 0;
    for (let i = Math.max(0, liveIdx - 11); i <= liveIdx; i++) s += (rateAt(x, z, i) || 0) / 12;
    return s;   // mm
  }

  // ---------- Radarkarte über dem Gelände ----------
  function rampColor(mmh) {
    if (mmh < RAMP[0][0]) return null;
    let c = RAMP[0][1];
    for (const [v, col] of RAMP) if (mmh >= v) c = col;
    return c;
  }
  function drawOverlay() {
    if (!radar) return;
    const { W, H } = radar, f = radar.frames[radarIdx];
    if (!overlay) {
      const tex = new THREE.DataTexture(new Uint8Array(W * H * 4), W, H, THREE.RGBAFormat);
      tex.magFilter = tex.minFilter = THREE.NearestFilter; tex.flipY = false;
      // Gitter über dem Viereck, Höhe 60 m über dem Gelände (Karte schwebt über Dächern und Bäumen)
      const n = 90, pos = new Float32Array((n + 1) * (n + 1) * 3), uv = new Float32Array((n + 1) * (n + 1) * 2), inside = new Uint8Array((n + 1) * (n + 1));
      const { nw, ne, sw, se } = radar;
      for (let j = 0; j <= n; j++) for (let i = 0; i <= n; i++) {
        const u = i / n, v = j / n, k = j * (n + 1) + i;
        const x = (1 - v) * ((1 - u) * nw[0] + u * ne[0]) + v * ((1 - u) * sw[0] + u * se[0]);
        const z = (1 - v) * ((1 - u) * nw[1] + u * ne[1]) + v * ((1 - u) * sw[1] + u * se[1]);
        const h = ctx.terrainHeightAt(x, z); inside[k] = h != null ? 1 : 0;
        pos[k * 3] = x; pos[k * 3 + 1] = (h ?? ctx.centerY) + 60; pos[k * 3 + 2] = z;
        uv[k * 2] = u; uv[k * 2 + 1] = v;
      }
      const idx = [];
      // nur über dem Modellgebiet (außerhalb gibt es kein Gelände)
      for (let j = 0; j < n; j++) for (let i = 0; i < n; i++) { const a = j * (n + 1) + i; if (inside[a] && inside[a + 1] && inside[a + n + 1] && inside[a + n + 2]) idx.push(a, a + n + 1, a + 1, a + 1, a + n + 1, a + n + 2); }
      const geo = new THREE.BufferGeometry();
      geo.setAttribute("position", new THREE.BufferAttribute(pos, 3)); geo.setAttribute("uv", new THREE.BufferAttribute(uv, 2)); geo.setIndex(idx);
      overlay = new THREE.Mesh(geo, new THREE.MeshBasicMaterial({ map: tex, transparent: true, depthWrite: false, side: THREE.DoubleSide, toneMapped: false, fog: false }));
      overlay.renderOrder = 5; overlay.name = "regenradar";
      scene.add(overlay);
    }
    const data = overlay.material.map.image.data;
    for (let r = 0; r < H; r++) for (let c = 0; c < W; c++) {
      const k = (r * W + c) * 4, col = rampColor(f.p[r][c] * 0.12);
      data[k] = col ? col[0] : 0; data[k + 1] = col ? col[1] : 0; data[k + 2] = col ? col[2] : 0; data[k + 3] = col ? 150 : 0;
    }
    overlay.material.map.needsUpdate = true;
    const t = f.t, fmt = new Intl.DateTimeFormat("de-DE", { timeZone: ctx.TZ, hour: "2-digit", minute: "2-digit" }).format(t);
    $("radarLabel").textContent = `${fmt} Uhr · ${+t <= Date.now() ? "gemessen" : "Vorhersage"}`;
    ctx.requestRender?.();
  }
  function setupTimeline() {
    const s = $("radarTime");
    s.max = String(radar.frames.length - 1);
    s.value = String(radarIdx);
  }
  $("radar").addEventListener("change", (e) => {
    $("radarBox").hidden = !e.target.checked;
    if (e.target.checked) { if (!radar) loadRadar().then(drawOverlay); else drawOverlay(); if (overlay) overlay.visible = true; }
    else if (overlay) overlay.visible = false;
    ctx.requestRender?.();
  });
  $("radarTime").addEventListener("input", (e) => { radarIdx = parseInt(e.target.value, 10); drawOverlay(); });
  let playing = false, playT = 0;
  $("radarPlay").addEventListener("click", () => { playing = !playing; $("radarPlay").textContent = playing ? "❚❚" : "▶"; });
  $("radarNow").addEventListener("click", () => { radarIdx = liveIdx; $("radarTime").value = String(radarIdx); drawOverlay(); });

  // ---------- Regen und Schnee (Teilchen um die Kamera, Bewegung im Shader) ----------
  function makeRain() {
    const N = 6000, seed = new Float32Array(N * 2 * 4), tip = new Float32Array(N * 2);
    for (let i = 0; i < N; i++) {
      const s = [Math.random(), Math.random(), Math.random(), Math.random()];
      for (let k = 0; k < 2; k++) { seed.set(s, (i * 2 + k) * 4); tip[i * 2 + k] = k; }
    }
    const geo = new THREE.BufferGeometry();
    geo.setAttribute("position", new THREE.BufferAttribute(new Float32Array(N * 2 * 3), 3));
    geo.setAttribute("seed", new THREE.BufferAttribute(seed, 4)); geo.setAttribute("tip", new THREE.BufferAttribute(tip, 1));
    const mat = new THREE.ShaderMaterial({
      transparent: true, depthWrite: false,
      uniforms: { uCenter: { value: new THREE.Vector3() }, uSize: { value: 100 }, uTime: { value: 0 }, uSpeed: { value: 9 }, uWind: { value: new THREE.Vector2() },
        uDensity: { value: 0 }, uLen: { value: 0.06 }, uSnow: { value: 0 }, uColor: { value: new THREE.Color(0xc8d2e0) } },
      vertexShader: `attribute vec4 seed; attribute float tip;
        uniform vec3 uCenter; uniform float uSize, uTime, uSpeed, uDensity, uLen, uSnow; uniform vec2 uWind; varying float vA;
        void main() {
          if (seed.w > uDensity) { gl_Position = vec4(2.0, 2.0, 2.0, 1.0); vA = 0.0; return; }
          float h = uSize * 0.7;
          float y = h - mod(seed.y * h + uTime * uSpeed, h);
          vec3 p = vec3(seed.x * uSize, y, seed.z * uSize);
          float sway = uSnow * sin(uTime * 1.3 + seed.x * 40.0) * 0.6;
          p.xz += uWind * ((h - y) / uSpeed) + vec2(sway, 0.0);
          p.x = uCenter.x + mod(p.x - uCenter.x, uSize) - uSize * 0.5;
          p.z = uCenter.z + mod(p.z - uCenter.z, uSize) - uSize * 0.5;
          p.y += uCenter.y - h * 0.5;
          p += vec3(uWind.x, -uSpeed, uWind.y) * (tip * uLen);
          vA = 1.0 - tip * 0.6;
          gl_Position = projectionMatrix * viewMatrix * vec4(p, 1.0);
        }`,
      fragmentShader: `uniform vec3 uColor; varying float vA; void main() { gl_FragColor = vec4(uColor, 0.55 * vA); }`,
    });
    const lines = new THREE.LineSegments(geo, mat);
    lines.frustumCulled = false; lines.renderOrder = 6; lines.visible = false; lines.name = "niederschlag";
    scene.add(lines);
    return lines;
  }

  // ---------- Anwendung auf Licht, Nebel, Boden ----------
  const wx = () => ctx.meta.weatherNow || null;
  let hazeFog = null;
  // wird von app.js am Ende von setSun aufgerufen (Licht, Himmel, Nebel sind dann für die Uhrzeit gesetzt)
  ctx.setAfterSun((sky) => {
    const w = wx(), live = on();
    if (!live || !w) return;
    const rate = currentRate();
    if (rate > 0.1) { ctx.sun.intensity *= 0.6; sky.lerp(new THREE.Color(0x7d858f), 0.35); }
    // Nebel: im Fahrmodus mit gemessener Sichtweite, von oben als Dunst (sonst wäre aus 600 m Höhe nichts zu sehen)
    const V = w.visibility;
    if (V != null && V < 20000) {
      if (ctx.cameraOwner()) scene.fog = new THREE.Fog(sky, Math.max(20, V * 0.1), Math.max(80, V * 1.1));
      else if (V < 8000) { scene.fog = new THREE.Fog(sky, 1800, 7000); hazeFog = scene.fog; }   // Abstand je Bild nach Kameraabstand
    }
  });
  ctx.setLiveCheck(on);
  const testRate = parseFloat(new URLSearchParams(location.search).get("wxtest"));   // nur für Tests: feste Regenstärke in mm/h
  function currentRate() {
    if (!Number.isNaN(testRate)) return testRate;
    const p = controls.target;   // Erkunden: Blickpunkt; Fahrmodus: Punkt vor dem Auto
    return rateAt(p.x, p.z) ?? 0;
  }
  function applyGround() {
    const live = on();
    const wet = live && radar && (currentRate() > 0.1 || sumLastHour(controls.target.x, controls.target.z) > 0.3);
    ctx.wetFactor = wet ? 0.8 : 1;
    for (const m of ctx.terrainGroup.children) {
      const mat = m.material; if (!mat.map) continue;
      const want = wet ? 0xcbd0d6 : 0xffffff;
      if (mat.color.getHex() !== want) { mat.color.set(want); }
    }
  }
  $("ortho").addEventListener("change", () => setTimeout(applyGround, 0));

  // ---------- Anzeige im Wetter-Feld ----------
  function status() {
    const el = $("wxLive"); if (!el) return;
    if (!$("clouds").checked) { el.textContent = ""; return; }
    if (!isLive()) { el.innerHTML = `<span class="muted">Live-Wetter nur bei „Jetzt“, eingestellt ist ${$("timeLabel").textContent} Uhr.</span>`; return; }
    const w = wx(), rate = currentRate(), parts = [];
    if (w) parts.push(`Bewölkung ${w.cloud_cover ?? "–"} %`, w.visibility != null ? `Sicht ${w.visibility >= 1000 ? (w.visibility / 1000).toFixed(0) + " km" : w.visibility + " m"} (Station Müllheim)` : "");
    parts.push(radar ? (rate >= 0.1 ? `${w && w.temperature != null && w.temperature <= 1 ? "Schnee" : "Regen"} ${rate.toFixed(1).replace(".", ",")} mm/h am Blickpunkt (Radar)` : "kein Niederschlag am Blickpunkt (Radar)") : "Radar nicht erreichbar");
    el.innerHTML = `<b class="badge">LIVE</b> ${parts.filter(Boolean).join(" · ")}`;
  }

  // ---------- Takt ----------
  let lastStatus = 0, lastGround = 0;
  ctx.frameHooks.push((now, dt) => {
    const live = on(), owner = !!ctx.cameraOwner();
    if (live !== lastLive || owner !== lastOwner) { lastLive = live; lastOwner = owner; ctx.setSun(); applyGround(); status(); if (live && !radar) loadRadar(); }
    if (live && Date.now() - radarAt > RADAR_REFRESH && document.visibilityState === "visible") { radarAt = Date.now(); loadRadar(); }
    if (live && ctx.reloadWeather && Date.now() - (ctx.meta.weatherAt || 0) > STATION_REFRESH && document.visibilityState === "visible") { ctx.meta.weatherAt = Date.now(); ctx.reloadWeather(); }
    if (now - lastStatus > 2000) { lastStatus = now; status(); }
    // Dunst von oben: der Blickpunkt bleibt klar, dahinter wird es dunstig
    if (hazeFog && scene.fog === hazeFog && !owner) {
      const d = camera.position.distanceTo(controls.target);
      hazeFog.near = Math.max(1500, d * 1.4); hazeFog.far = hazeFog.near + 7000;
    }
    if (now - lastGround > 5000) { lastGround = now; applyGround(); }
    // Radar-Zeitleiste abspielen
    if (playing && radar && now - playT > 450) { playT = now; radarIdx = (radarIdx + 1) % radar.frames.length; $("radarTime").value = String(radarIdx); drawOverlay(); ctx.requestRender?.(); }
    // Niederschlag
    const rate = live && radar ? currentRate() : 0;
    if (rate >= 0.1) {
      rain ||= makeRain();
      const w = wx(), snow = (w && w.temperature != null && w.temperature <= 1) || (w && /snow|sleet/.test(w.condition || ""));
      const u = rain.material.uniforms, dist = owner ? 40 : camera.position.distanceTo(controls.target);
      const size = Math.min(500, Math.max(70, dist * 0.6));
      u.uCenter.value.copy(camera.position); u.uSize.value = size;
      u.uTime.value = now / 1000;
      u.uSnow.value = snow ? 1 : 0;
      u.uSpeed.value = (snow ? 1.2 : 9) * Math.max(1, size / 90);
      u.uLen.value = snow ? 0.02 : 0.06;
      u.uDensity.value = Math.min(1, 0.12 + Math.log10(1 + rate) * 0.55);
      u.uColor.value.set(snow ? 0xf2f4f7 : 0xc8d2e0);
      const wd = ((w?.wind_direction_10 ?? 270) * Math.PI) / 180, ws = Math.min(8, (w?.wind_speed_10 ?? 0) / 3.6);
      u.uWind.value.set(-Math.sin(wd) * ws, Math.cos(wd) * ws);   // Wind weht aus der angegebenen Richtung
      rain.visible = true;
      ctx.requestRender?.();
    } else if (rain) rain.visible = false;
  });
  window.addEventListener("wetter", () => { ctx.setSun(); applyGround(); status(); });
  $("clouds").addEventListener("change", () => { ctx.setSun(); applyGround(); status(); });
  if (on()) loadRadar();
  status();
  ctx.weather = { isLive, rateAt, loadRadar, radar: () => radar, currentRate };
}
