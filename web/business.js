// Ebene „Arbeiten und Wirtschaft“ (Variante A): alle Betriebe gleich, Angaben aus OpenStreetMap, ergänzt um belegte Fakten.
// Keine Umsätze, keine Eigentümer, keine Telefonnummern. Daten: web/data/business.json (scripts/12_business.py, ODbL).
const esc = (s) => String(s ?? "").replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
const nf = (v, d = 0) => Number(v).toLocaleString("de-DE", { minimumFractionDigits: d, maximumFractionDigits: d });
const safeUrl = (u) => { try { const x = new URL(u.startsWith("http") ? u : `https://${u}`); return /^https?:$/.test(x.protocol) ? x.href : null; } catch { return null; } };

function labelTexture(THREE, title, sub, color) {
  const s = 2, c = document.createElement("canvas"), g = c.getContext("2d");
  const f1 = `600 ${13 * s}px system-ui, -apple-system, Segoe UI, Roboto, sans-serif`, f2 = `400 ${10 * s}px system-ui, -apple-system, Segoe UI, Roboto, sans-serif`;
  g.font = f1; const w1 = g.measureText(title).width; g.font = f2; const w2 = g.measureText(sub).width;
  const pad = 8 * s, dot = 8 * s, w = Math.ceil(Math.max(w1, w2) + 2 * pad + dot + 6 * s), h = 38 * s, tip = 7 * s;
  c.width = w; c.height = h + tip;
  g.fillStyle = "rgba(18,22,28,0.88)";
  const r = 6 * s;
  g.beginPath(); g.moveTo(r, 0); g.lineTo(w - r, 0); g.quadraticCurveTo(w, 0, w, r); g.lineTo(w, h - r); g.quadraticCurveTo(w, h, w - r, h);
  g.lineTo(w / 2 + tip, h); g.lineTo(w / 2, h + tip); g.lineTo(w / 2 - tip, h); g.lineTo(r, h); g.quadraticCurveTo(0, h, 0, h - r);
  g.lineTo(0, r); g.quadraticCurveTo(0, 0, r, 0); g.closePath(); g.fill();
  g.fillStyle = color; g.beginPath(); g.arc(pad + dot / 2, 13 * s, dot / 2, 0, Math.PI * 2); g.fill();   // Gruppe als Punkt
  g.textBaseline = "top"; g.fillStyle = "#e8e6e1"; g.font = f1; g.fillText(title, pad + dot + 6 * s, 6 * s);
  g.fillStyle = "#a9b0ba"; g.font = f2; g.fillText(sub, pad + dot + 6 * s, 22 * s);
  const tex = new THREE.CanvasTexture(c); tex.colorSpace = THREE.SRGBColorSpace;
  return { tex, w: c.width / s, h: c.height / s };
}

export async function setupBusiness(ctx) {
  const { THREE, scene, $, flyTo, pickHooks, frameHooks, infoHooks, terrainHeightAt, camera } = ctx;
  let data;
  try { const r = await fetch("data/business.json"); if (!r.ok) throw new Error(r.status); data = await r.json(); } catch (e) { $("businessSec").hidden = true; return; }
  ctx.meta.business = data;
  const groups = data.gruppen;
  const root = new THREE.Group(); root.name = "business"; root.visible = false; scene.add(root);

  // Mehrere Betriebe im selben Gebäude: Marker im Kreis versetzen
  const perBuilding = {};
  for (const b of data.betriebe) if (b.gebaeude != null) (perBuilding[b.gebaeude] ||= []).push(b);

  const headGeo = new THREE.SphereGeometry(2.2, 14, 10);
  const mats = Object.fromEntries(Object.entries(groups).map(([k, gr]) => [k, new THREE.MeshBasicMaterial({ color: new THREE.Color(gr.farbe), toneMapped: false })]));
  const poleMat = new THREE.LineBasicMaterial({ color: 0xe8e6e1, transparent: true, opacity: 0.7 });
  const items = [];
  for (const b of data.betriebe) {
    let x = b.x, z = b.zz;
    const mates = b.gebaeude != null ? perBuilding[b.gebaeude] : null;
    if (mates && mates.length > 1) { const k = mates.indexOf(b), a = (k / mates.length) * Math.PI * 2; x += Math.cos(a) * 6; z += Math.sin(a) * 6; }
    const ground = terrainHeightAt(x, z) ?? ctx.centerY;
    const base = b.dach_m != null ? b.dach_m : ground;
    const top = base + (b.dach_m != null ? 9 : 14);
    const group = new THREE.Group();
    group.add(new THREE.Line(new THREE.BufferGeometry().setFromPoints([new THREE.Vector3(x, base, z), new THREE.Vector3(x, top, z)]), poleMat));
    const head = new THREE.Mesh(headGeo, mats[b.gruppe]);
    head.position.set(x, top, z); head.userData.business = b;
    group.add(head);
    const { tex, w, h } = labelTexture(THREE, b.name, b.branche, groups[b.gruppe].farbe);
    const sprite = new THREE.Sprite(new THREE.SpriteMaterial({ map: tex, depthTest: false, sizeAttenuation: false, transparent: true }));
    sprite.scale.set(w * 0.001, h * 0.001, 1); sprite.center.set(0.5, -0.25); sprite.position.set(x, top, z);
    sprite.renderOrder = 9; sprite.userData.business = b; sprite.visible = false;
    group.add(sprite);
    group.userData = { b, head, sprite };
    root.add(group);
    items.push(group);
    b._pos = new THREE.Vector3(x, top, z);
  }

  // Filter nach Gruppe
  const active = new Set(Object.keys(groups));
  const box = $("businessFilter");
  for (const [k, gr] of Object.entries(groups)) {
    const lab = document.createElement("label"); lab.className = "inline chip";
    lab.innerHTML = `<input type="checkbox" data-g="${k}" checked><span class="dot" style="background:${gr.farbe}"></span>${esc(gr.name)} <span class="muted">${gr.anzahl}</span>`;
    box.appendChild(lab);
  }
  const apply = () => { for (const it of items) it.visible = active.has(it.userData.b.gruppe); };
  box.addEventListener("change", (e) => { const g = e.target.dataset.g; if (!g) return; if (e.target.checked) active.add(g); else active.delete(g); apply(); });
  $("business").addEventListener("change", (e) => { root.visible = e.target.checked; });
  $("businessCount").textContent = `${data.betriebe.length} Betriebe aus OpenStreetMap (Stand ${(data.quelle.osm.stand || "").slice(0, 10).split("-").reverse().join(".")})`;

  // Beschriftungen nur in der Nähe, überlappende ausblenden (nähere zuerst)
  const v = new THREE.Vector3();
  let last = 0;
  frameHooks.push((now) => {
    if (!root.visible || now - last < 200) return;
    last = now;
    const W = innerWidth, H = innerHeight, placed = [];
    const vis = items.filter((it) => it.visible).map((it) => ({ it, d: camera.position.distanceTo(it.userData.head.position) })).sort((a, b) => a.d - b.d);
    for (const { it, d } of vis) {
      const s = it.userData.sprite;
      if (d > 650) { s.visible = false; continue; }
      v.copy(s.position).project(camera);
      const x = (v.x + 1) / 2 * W, y = (1 - v.y) / 2 * H, w = s.scale.x / 0.001 * (H / 900), h = s.scale.y / 0.001 * (H / 900);
      const r = { x0: x - w / 2, x1: x + w / 2, y0: y - h * 1.25, y1: y - h * 0.25 };
      const hit = v.z > 1 || placed.some((p) => r.x0 < p.x1 && r.x1 > p.x0 && r.y0 < p.y1 && r.y1 > p.y0);
      s.visible = !hit;
      if (!hit) placed.push(r);
    }
  });

  // Info-Karte
  const show = (b) => {
    const info = $("info"); info.hidden = false;
    const web = b.website && safeUrl(b.website);
    const rows = [
      ["Branche", esc(b.branche)],
      ["Adresse", b.adresse ? `${esc(b.adresse)}, Sulzburg` : '<span class="muted">nicht in OpenStreetMap</span>'],
      b.oeffnungszeiten ? ["Öffnungszeiten", `<span class="mono">${esc(b.oeffnungszeiten)}</span> <span class="muted">(laut OSM)</span>`] : null,
      b.rollstuhl ? ["Rollstuhlgerecht", esc(b.rollstuhl)] : null,
      web ? ["Website", `<a href="${esc(web)}" target="_blank" rel="noopener nofollow">${esc(web.replace(/^https?:\/\/(www\.)?/, "").replace(/\/$/, ""))}</a>`] : null,
      b.solar ? ["Solaranlagen", `${nf(b.solar.kw, 1)} kW${b.solar.speicher_kw ? `, Speicher ${nf(b.solar.speicher_kw, 1)} kW` : ""} <span class="muted">(Marktstammdatenregister)</span>`] : null,
    ].filter(Boolean);
    const facts = b.fakten.length ? `<ul class="facts">${b.fakten.map((f) => `<li>${esc(f)}</li>`).join("")}</ul>` : "";
    const src = [`OpenStreetMap (© OpenStreetMap-Mitwirkende, ODbL)`, ...b.quellen.map((q) => `<a href="${esc(q.url)}" target="_blank" rel="noopener">${esc(q.titel)}</a> (${esc(q.lizenz)})`)];
    if (b.solar) src.push("Marktstammdatenregister – © Bundesnetzagentur | dl-de/by-2-0");
    info.innerHTML = `<h2>${esc(b.name)}</h2><div class="muted small"><span class="dot" style="background:${groups[b.gruppe].farbe}"></span> ${esc(groups[b.gruppe].name)}</div>` +
      `<dl>${rows.map(([k, v2]) => `<dt>${k}</dt><dd>${v2}</dd>`).join("")}</dl>${facts}` +
      `<div class="hint">Quellen: ${src.join(" · ")}. Angaben aus OpenStreetMap können veraltet sein.` +
      `${b.gebaeude != null ? ' <a href="#" class="bldlink">Gebäudedaten anzeigen</a>' : ""}</div>`;
    const l = info.querySelector(".bldlink");
    if (l) l.addEventListener("click", (e) => { e.preventDefault(); ctx.showBuilding(b.gebaeude); });
  };
  ctx.showBusiness = show;
  ctx.flyToBusiness = (b) => { if (!$("business").checked) { $("business").checked = true; root.visible = true; } flyTo(new THREE.Vector3(b._pos.x, terrainHeightAt(b._pos.x, b._pos.z) ?? ctx.centerY, b._pos.z), 170); show(b); };

  // Klick auf Marker oder Beschriftung
  pickHooks.unshift((ray) => {
    if (!root.visible) return false;
    const vis = items.filter((it) => it.visible);
    // Erst die Marker selbst, dann die Beschriftungen (die können andere Marker überdecken)
    const hit = ray.intersectObjects(vis.map((it) => it.userData.head), false)[0] ||
      ray.intersectObjects(vis.filter((it) => it.userData.sprite.visible).map((it) => it.userData.sprite), false)[0];
    if (!hit) return false;
    show(hit.object.userData.business);
    return true;
  });

  // Hover: Name und Branche als Tooltip
  const tip = $("tooltip"), ray = new THREE.Raycaster(), mouse = new THREE.Vector2();
  let pending = null, shown = false;
  ctx.renderer.domElement.addEventListener("pointermove", (e) => {
    if (!root.visible || e.buttons) { if (shown) { tip.hidden = true; shown = false; } return; }
    pending = e;
    requestAnimationFrame(() => {
      if (!pending) return;
      const ev = pending; pending = null;
      mouse.set((ev.clientX / innerWidth) * 2 - 1, -(ev.clientY / innerHeight) * 2 + 1);
      ray.setFromCamera(mouse, camera);
      const hit = ray.intersectObjects(items.filter((it) => it.visible).map((it) => it.userData.head), false)[0];
      if (!hit) { if (shown) { tip.hidden = true; shown = false; } return; }
      const b = hit.object.userData.business;
      tip.hidden = false; shown = true;
      tip.innerHTML = `<b>${esc(b.name)}</b><br><span class="dot" style="background:${groups[b.gruppe].farbe}"></span> ${esc(b.branche)}`;
      tip.style.left = `${ev.clientX + 14}px`; tip.style.top = `${ev.clientY + 12}px`;
    });
  });

  // Gebäude-Info: Betriebe in diesem Gebäude
  infoHooks.push((idx) => {
    const list = data.betriebe.filter((b) => b.gebaeude === idx);
    if (!list.length) return "";
    return `<h3>Betriebe in diesem Gebäude</h3><div class="small">${list.map((b) => `<a href="#" data-biz="${b.id}">${esc(b.name)}</a> <span class="muted">(${esc(b.branche)})</span>`).join("<br>")}</div>`;
  });
  $("info").addEventListener("click", (e) => {
    const a = e.target.closest("[data-biz]"); if (!a) return;
    e.preventDefault(); show(data.betriebe.find((b) => b.id === Number(a.dataset.biz)));
  });

  // Liste im Panel (Tastatur und Bildschirmleser, zugleich Tabellenansicht)
  const list = $("businessList");
  list.innerHTML = Object.entries(groups).map(([k, gr]) => `<div class="small"><b><span class="dot" style="background:${gr.farbe}"></span> ${esc(gr.name)}</b><br>` +
    data.betriebe.filter((b) => b.gruppe === k).map((b) => `<a href="#" data-bizfly="${b.id}">${esc(b.name)}</a>`).join(" · ") + "</div>").join("");
  list.addEventListener("click", (e) => { const a = e.target.closest("[data-bizfly]"); if (!a) return; e.preventDefault(); ctx.flyToBusiness(data.betriebe.find((b) => b.id === Number(a.dataset.bizfly))); });
}
