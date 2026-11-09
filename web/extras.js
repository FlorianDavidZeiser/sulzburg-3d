// Extras: Adresssuche mit Kameraflug, Tagesablauf zum Abspielen, Busse nach Soll-Fahrplan.
export async function setupExtras(ctx) {
  setupSearch(ctx);
  setupDayPlay(ctx);
  await setupBuses(ctx);
}

// ---------- Adresssuche ----------
function setupSearch(ctx) {
  const { THREE, $, meta, flyTo, terrainHeightAt, scene, frameHooks } = ctx;
  const G = meta.buildings.gebaeude;
  const norm = (s) => s.toLowerCase().replace(/str\.?\b/g, "straße").replace(/ss/g, "ß").replace(/\s+/g, " ").trim();
  const index = new Map();  // "hauptstraße 60" -> [Gebäude-Indizes]
  for (const g of G) {
    if (!g.adresse) continue;
    const street = g.adresse.split(",")[0].trim();
    if (!/\d/.test(street)) continue;
    // "Hauptstraße 52, 54" -> mehrere Hausnummern
    const m = street.match(/^(.*?)\s+(\d.*)$/);
    const nums = m ? m[2].split(/\s*,\s*/) : [];
    const keys = m ? nums.map((n) => `${m[1]} ${n}`) : [street];
    for (const k of keys) { const key = norm(k); if (!index.has(key)) index.set(key, { label: k, ids: [] }); index.get(key).ids.push(g.i); }
  }
  const list = $("searchList");
  [...index.values()].sort((a, b) => a.label.localeCompare(b.label, "de", { numeric: true })).forEach((v) => { const o = document.createElement("option"); o.value = v.label; list.appendChild(o); });
  for (const p of meta.places?.orte || []) { const o = document.createElement("option"); o.value = p.name; list.appendChild(o); }
  for (const b of meta.business?.betriebe || []) { const o = document.createElement("option"); o.value = b.name; o.label = b.branche; list.appendChild(o); }

  // Markierung: senkrechter Lichtstrahl über dem gefundenen Gebäude, verblasst nach einigen Sekunden
  const beam = new THREE.Mesh(new THREE.CylinderGeometry(1.2, 1.2, 60, 12, 1, true), new THREE.MeshBasicMaterial({ color: 0xf2b544, transparent: true, opacity: 0, depthWrite: false, toneMapped: false }));
  beam.visible = false; scene.add(beam);
  let beamUntil = 0;
  frameHooks.push((now) => {
    if (!beam.visible) return;
    const left = beamUntil - now;
    beam.material.opacity = Math.max(0, Math.min(0.55, left / 1500 * 0.55));
    if (left <= 0) beam.visible = false;
  });

  const go = () => {
    const q = norm($("search").value);
    if (!q) return;
    const place = (meta.places?.orte || []).find((p) => norm(p.name) === q);
    if (place) { flyTo(new THREE.Vector3(place.x, terrainHeightAt(place.x, place.zz) ?? ctx.centerY, place.zz), 260); ctx.showPlace?.(place); return; }
    const biz = (meta.business?.betriebe || []).find((b) => norm(b.name) === q) || (meta.business?.betriebe || []).find((b) => q.length >= 4 && norm(b.name).includes(q));
    if (biz && !index.has(q)) { ctx.flyToBusiness?.(biz); return; }
    let hit = index.get(q);
    if (!hit) { const k = [...index.keys()].find((k) => k.startsWith(q)); hit = k && index.get(k); }
    if (!hit) { $("search").setCustomValidity("Adresse nicht im LoD2-Datensatz gefunden"); $("search").reportValidity(); return; }
    $("search").setCustomValidity("");
    const g = G[hit.ids[0]];
    const x = g.e - meta.buildings.e0, z = -(g.n - meta.buildings.n0);
    const y = terrainHeightAt(x, z) ?? g.z_boden_min;
    flyTo(new THREE.Vector3(x, y, z), 160);
    ctx.showBuilding(g.i);
    beam.position.set(x, g.z_first + 30, z); beam.visible = true; beamUntil = performance.now() + 6000;
  };
  $("search").addEventListener("change", go);
  $("search").addEventListener("keydown", (e) => { if (e.key === "Enter") go(); e.stopPropagation(); });
  $("search").addEventListener("input", () => $("search").setCustomValidity(""));
}

// ---------- Tagesablauf abspielen ----------
function setupDayPlay(ctx) {
  const { $, frameHooks, sunTimes, latLon, TZ } = ctx;
  let playing = false, minute = 0, end = 0;
  const btn = $("play");
  const localMinutes = (d) => { const p = new Intl.DateTimeFormat("en-GB", { timeZone: TZ, hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).formatToParts(d); return +p.find((x) => x.type === "hour").value * 60 + +p.find((x) => x.type === "minute").value; };
  const start = () => {
    const [y, m, d] = $("date").value.split("-").map(Number);
    const t = sunTimes(new Date(Date.UTC(y, m - 1, d)), latLon[0], latLon[1]);
    const rise = t.sunrise ? localMinutes(t.sunrise) : 360, set = t.sunset ? localMinutes(t.sunset) : 1080;
    minute = Math.max(0, rise - 30); end = Math.min(1439, set + 30);
    const cur = parseInt($("time").value, 10);
    if (cur > minute && cur < end - 30) minute = cur;  // ab der eingestellten Zeit weiter
    playing = true; btn.textContent = "❚❚ Pause";
  };
  const stop = () => { playing = false; btn.textContent = "▶ Tag"; };
  btn.addEventListener("click", () => (playing ? stop() : start()));
  $("time").addEventListener("pointerdown", stop);
  frameHooks.push((now, dt) => {
    if (!playing) return;
    minute += dt * 40;   // 40 Minuten pro Sekunde: ein Sommertag in rund 25 Sekunden
    if (minute >= end) { minute = end; stop(); }
    $("time").value = String(Math.round(minute / 5) * 5);
    $("time").dispatchEvent(new Event("input"));
  });
}

// ---------- Busse nach Soll-Fahrplan ----------
async function setupBuses(ctx) {
  const { THREE, $, meta, scene, frameHooks, terrainHeightAt, TZ } = ctx;
  const tr = meta.transit;
  if (!tr || !tr.fahrten || !tr.fahrten.length) { $("buses").closest("label").hidden = true; return; }
  // Fahrzeugform: schlichter Quader mit Dach, 12 m lang (Darstellung, kein Datum)
  const body = new THREE.BoxGeometry(2.5, 3.0, 12); body.translate(0, 1.7, 0);
  const mat = new THREE.MeshStandardMaterial({ color: 0xf2b544, roughness: 0.6 });
  const pool = [];
  const group = new THREE.Group(); scene.add(group);
  const getBus = (k) => { while (pool.length <= k) { const m = new THREE.Mesh(body, mat); m.castShadow = true; group.add(m); pool.push(m); } return pool[k]; };
  const shapes = tr.verlaeufe || {};
  // Polylinie mit kumulierter Länge
  const lines = {};
  for (const [id, pts] of Object.entries(shapes)) {
    const cum = [0];
    for (let i = 1; i < pts.length; i++) cum.push(cum[i - 1] + Math.hypot(pts[i][0] - pts[i - 1][0], pts[i][1] - pts[i - 1][1]));
    lines[id] = { pts, cum };
  }
  const at = (line, s) => {
    const { pts, cum } = line;
    if (s <= 0) return [pts[0], pts[1]];
    if (s >= cum[cum.length - 1]) return [pts[pts.length - 1], pts[pts.length - 2], true];
    let lo = 0, hi = cum.length - 1;
    while (hi - lo > 1) { const mid = (lo + hi) >> 1; if (cum[mid] <= s) lo = mid; else hi = mid; }
    const f = (s - cum[lo]) / (cum[hi] - cum[lo] || 1);
    return [[pts[lo][0] + (pts[hi][0] - pts[lo][0]) * f, pts[lo][1] + (pts[hi][1] - pts[lo][1]) * f], pts[hi]];
  };
  const dayIndex = () => tr.zeitraum.tage.indexOf($("date").value);
  const secNow = () => parseInt($("time").value, 10) * 60;
  let shown = 0, last = 0;
  frameHooks.push((now) => {
    if (now - last < 100) return; last = now;
    const on = $("buses").checked;
    const di = dayIndex(), t = secNow();
    let k = 0;
    if (on && di >= 0) {
      for (const f of tr.fahrten) {
        if (!((f.tage[Math.floor(di / 30)] >> (di % 30)) & 1)) continue;
        const h = f.halte;
        if (t < h[0][1] || t > h[h.length - 1][1]) continue;
        let j = 0; while (j < h.length - 2 && t > h[j + 1][1]) j++;
        const [s0, t0] = [h[j][2], h[j][1]], [s1, t1] = [h[j + 1][2], h[j + 1][1]];
        const s = s0 + (s1 - s0) * (t1 > t0 ? (t - t0) / (t1 - t0) : 0);
        const line = lines[f.verlauf];
        if (!line) continue;
        const [p, q, rev] = at(line, s);
        const y = terrainHeightAt(p[0], p[1]);
        if (y == null) continue;
        const bus = getBus(k++);
        bus.visible = true;
        bus.position.set(p[0], y, p[1]);
        const dx = (rev ? p[0] - q[0] : q[0] - p[0]), dz = (rev ? p[1] - q[1] : q[1] - p[1]);
        bus.rotation.y = Math.atan2(dx, dz);
        bus.userData.fahrt = f;
      }
    }
    for (let i = k; i < pool.length; i++) pool[i].visible = false;
    if (k !== shown) { shown = k; $("transitInfo").dataset.busse = k; }
  });
  // Klick auf einen Bus: Linie und Ziel
  ctx.pickHooks.push((ray) => {
    if (!$("buses").checked) return false;
    const hit = ray.intersectObjects(pool.filter((b) => b.visible), false)[0];
    if (!hit) return false;
    const f = hit.object.userData.fahrt, info = $("info");
    const fmt = (sec) => `${String(Math.floor(sec / 3600) % 24).padStart(2, "0")}:${String(Math.floor(sec / 60) % 60).padStart(2, "0")}`;
    info.hidden = false;
    info.innerHTML = `<h2>Bus ${tr.linien[f.route]?.name || ""} nach ${f.ziel}</h2><div class="muted small">Position laut Soll-Fahrplan, keine Echtzeit</div>` +
      `<table class="deps">${f.halte.map((h) => `<tr><td>${fmt(h[1])}</td><td>${tr.haltestellen[h[0]]?.name || "?"}</td></tr>`).join("")}</table>` +
      `<div class="hint">Zwischen den Halten gleichmäßig entlang des Linienverlaufs bewegt. Fahrplan: NVBW über MobiData BW (dl-de/by-2-0), Linienverlauf: NVBW über MobiData BW (ODbL). Nur der Abschnitt im Modellgebiet.</div>`;
    return true;
  });
}
