// Orte mit Geschichte: Marker mit Beschriftung, Info-Karte mit Fakten und Quellen (web/data/places.json, scripts/09_places.py).
const esc = (s) => String(s ?? "").replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));

function labelTexture(THREE, title, sub) {
  const scale = 2;
  const c = document.createElement("canvas");
  const ctx = c.getContext("2d");
  const f1 = `600 ${15 * scale}px system-ui, -apple-system, Segoe UI, Roboto, sans-serif`;
  const f2 = `400 ${11 * scale}px system-ui, -apple-system, Segoe UI, Roboto, sans-serif`;
  ctx.font = f1; const w1 = ctx.measureText(title).width;
  ctx.font = f2; const w2 = ctx.measureText(sub).width;
  const pad = 10 * scale, w = Math.ceil(Math.max(w1, w2) + 2 * pad), h = Math.ceil(46 * scale), tip = 10 * scale;
  c.width = w; c.height = h + tip;
  ctx.fillStyle = "rgba(18,22,28,0.88)";
  const r = 8 * scale;
  ctx.beginPath();
  ctx.moveTo(r, 0); ctx.lineTo(w - r, 0); ctx.quadraticCurveTo(w, 0, w, r); ctx.lineTo(w, h - r); ctx.quadraticCurveTo(w, h, w - r, h);
  ctx.lineTo(w / 2 + tip, h); ctx.lineTo(w / 2, h + tip); ctx.lineTo(w / 2 - tip, h); ctx.lineTo(r, h); ctx.quadraticCurveTo(0, h, 0, h - r);
  ctx.lineTo(0, r); ctx.quadraticCurveTo(0, 0, r, 0); ctx.closePath(); ctx.fill();
  ctx.fillStyle = "#f2b544"; ctx.fillRect(0, r, 3 * scale, h - 2 * r);
  ctx.fillStyle = "#e8e6e1"; ctx.font = f1; ctx.textBaseline = "top"; ctx.fillText(title, pad, 8 * scale);
  ctx.fillStyle = "#a9b0ba"; ctx.font = f2; ctx.fillText(sub, pad, 28 * scale);
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  return { tex, w: c.width / scale, h: c.height / scale };
}

export async function setupPlaces(ctx) {
  const { THREE, scene, $, flyTo, pickHooks } = ctx;
  let data;
  try { const r = await fetch("data/places.json"); if (!r.ok) throw new Error(r.status); data = await r.json(); } catch (e) { $("placesWrap").hidden = true; return; }
  ctx.meta.places = data;
  const group = new THREE.Group();
  group.name = "places";
  const poleMat = new THREE.LineBasicMaterial({ color: 0xf2b544, transparent: true, opacity: 0.8 });
  for (const o of data.orte) {
    const ground = ctx.terrainHeightAt(o.x, o.zz) ?? o.gelaende ?? ctx.centerY;
    const top = Math.max(o.marker_y, ground + 12);
    // Stange vom Boden (oder First) bis zur Beschriftung
    const base = o.gebaeude != null ? top - 6 : ground;
    const pole = new THREE.Line(new THREE.BufferGeometry().setFromPoints([new THREE.Vector3(o.x, base, o.zz), new THREE.Vector3(o.x, top, o.zz)]), poleMat);
    group.add(pole);
    const { tex, w, h } = labelTexture(THREE, o.name, o.kurz);
    const sprite = new THREE.Sprite(new THREE.SpriteMaterial({ map: tex, depthTest: false, sizeAttenuation: false, transparent: true }));
    const px = 0.0011; // Bildschirmgröße unabhängig von der Entfernung
    sprite.scale.set(w * px, h * px, 1);
    sprite.center.set(0.5, 0);
    sprite.position.set(o.x, top, o.zz);
    sprite.renderOrder = 10;
    sprite.userData.place = o;
    group.add(sprite);
    o._sprite = sprite;
  }
  scene.add(group);

  // Überlappende Beschriftungen ausblenden: nähere Orte haben Vorrang, Prüfung fünfmal pro Sekunde
  const sprites = group.children.filter((c) => c.isSprite);
  let lastCheck = 0;
  const v = new THREE.Vector3();
  ctx.frameHooks.push((now) => {
    if (now - lastCheck < 200 || !group.visible) return;
    lastCheck = now;
    const W = innerWidth, H = innerHeight, placed = [];
    const items = sprites.map((s) => ({ s, d: ctx.camera.position.distanceTo(s.position) })).sort((a, b) => a.d - b.d);
    for (const { s } of items) {
      v.copy(s.position).project(ctx.camera);
      const x = (v.x + 1) / 2 * W, y = (1 - v.y) / 2 * H;
      const w = s.scale.x / 0.0011 * (H / 900) * 0.9, h = s.scale.y / 0.0011 * (H / 900) * 0.9;
      const r = { x0: x - w / 2, x1: x + w / 2, y0: y - h, y1: y };
      const hit = v.z > 1 || placed.some((p) => r.x0 < p.x1 && r.x1 > p.x0 && r.y0 < p.y1 && r.y1 > p.y0);
      s.visible = !hit;
      if (!hit) placed.push(r);
    }
  });

  const show = (o) => {
    const info = $("info");
    info.hidden = false;
    const src = o.quellen.map((q) => `<li><a href="${esc(q.url)}" target="_blank" rel="noopener">${esc(q.titel)}</a> <span class="muted">(${esc(q.lizenz)})</span></li>`).join("");
    info.innerHTML = `<h2>${esc(o.name)}</h2><div class="muted small">${esc(o.kurz)}</div>` +
      `<ul class="facts">${o.fakten.map((f) => `<li>${esc(f)}</li>`).join("")}</ul>` +
      `<h3>Quellen</h3><ul class="src small">${src}</ul>` +
      `<div class="hint">Texte sinngemäß aus den Quellen, abgerufen am ${esc(data.abgerufen_am.split("-").reverse().join("."))}. Lage: ${esc(o.koordinatenquelle)}.` +
      `${o.gebaeude_hinweis ? " " + esc(o.gebaeude_hinweis) + "." : ""}</div>`;
  };
  ctx.showPlace = show;

  pickHooks.unshift((ray) => {
    if (!group.visible) return false;
    const hit = ray.intersectObjects(group.children.filter((c) => c.isSprite), false)[0];
    if (!hit) return false;
    show(hit.object.userData.place);
    return true;
  });

  const list = $("placesList");
  for (const o of data.orte) {
    const b = document.createElement("button");
    b.textContent = o.name;
    b.addEventListener("click", () => {
      const y = ctx.terrainHeightAt(o.x, o.zz) ?? ctx.centerY;
      flyTo(new THREE.Vector3(o.x, y, o.zz), o.id === "stadt" || o.id === "laufen" ? 420 : 220);
      show(o);
    });
    list.appendChild(b);
  }
  $("places").addEventListener("change", (e) => { group.visible = e.target.checked; });
}
