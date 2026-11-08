// Zeitachse und Szenario 2040: Klima (DWD, beobachtet und Fortschreibung) und PV auf allen geeigneten Dächern.
// Alles, was nicht beobachtet ist, trägt die Kennzeichnung "Szenario" (Banner, Badge, Quellenangabe der Annahmen).
const nf = (v, d = 0) => (v == null ? "–" : Number(v).toLocaleString("de-DE", { minimumFractionDigits: d, maximumFractionDigits: d }));
const esc = (s) => String(s ?? "").replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
// Sequentielle Skala, ein Farbton (Orange), hell = wenig, dunkel = viel
const RAMP = ["#fff1e6", "#fcc9a8", "#f59a6a", "#e2683a", "#b9471d"];
const DOMAIN = { hot_days: [0, 30], summer_days: [0, 80], frost_days: [40, 130] };
const PERIOD_LABEL = ["1961–1990", "1991–2020", "2040 Fortschreibung"];

function rampColor(THREE, f) {
  const x = Math.min(0.9999, Math.max(0, f)) * (RAMP.length - 1), i = Math.floor(x);
  return new THREE.Color(RAMP[i]).lerp(new THREE.Color(RAMP[i + 1]), x - i);
}

function chartSVG(series, means) {
  const W = 290, H = 108, ml = 20, mr = 14, mb = 14, mt = 10, n = series.length;
  const maxV = Math.max(30, Math.ceil(Math.max(...series.map((s) => s[1])) / 5) * 5);
  const bw = (W - ml - mr) / n, y = (v) => mt + (H - mb - mt) * (1 - v / maxV);
  let out = `<svg viewBox="0 0 ${W} ${H}" width="100%" role="img" aria-label="Heiße Tage pro Jahr, Gebietsmittel Baden-Württemberg ${series[0][0]} bis ${series[n - 1][0]}">`;
  for (const t of [0, 10, 20, 30].filter((t) => t <= maxV)) {
    out += `<line x1="${ml}" x2="${W - mr}" y1="${y(t)}" y2="${y(t)}" stroke="rgba(255,255,255,0.08)"/><text x="${ml - 3}" y="${y(t) + 3}" text-anchor="end">${t}</text>`;
  }
  series.forEach(([yr, v], i) => {
    const x = ml + i * bw, top = y(v), h = Math.max(0.5, H - mb - top);
    out += `<rect x="${(x + 0.5).toFixed(2)}" y="${top.toFixed(2)}" width="${Math.max(1, bw - 1).toFixed(2)}" height="${h.toFixed(2)}" rx="${Math.min(2, (bw - 1) / 2).toFixed(2)}" fill="${RAMP[2]}" data-tip="${yr}: ${nf(v, 1)} Heiße Tage"/>`;
  });
  // Periodenmittel als Referenzlinien
  for (const [p, v] of Object.entries(means)) {
    const a = parseInt(p.slice(0, 4), 10), b = parseInt(p.slice(5), 10);
    const i0 = series.findIndex((s) => s[0] === a), i1 = series.findIndex((s) => s[0] === b);
    if (i0 < 0) continue;
    const x0 = ml + i0 * bw, x1 = ml + ((i1 < 0 ? n - 1 : i1) + 1) * bw;
    out += `<line x1="${x0}" x2="${x1}" y1="${y(v)}" y2="${y(v)}" stroke="#e8e6e1" stroke-width="1.5" stroke-dasharray="3 2"/><text x="${x0 + 2}" y="${y(v) - 3}" style="fill:#e8e6e1">Ø ${nf(v, 1)}</text>`;
  }
  for (const yr of [series[0][0], 1990, series[n - 1][0]]) {
    const i = series.findIndex((s) => s[0] === yr);
    if (i >= 0) out += `<text x="${ml + i * bw + bw / 2}" y="${H - 2}" text-anchor="middle">${yr}</text>`;
  }
  // Große Trefferflächen für den Tooltip
  series.forEach(([yr, v], i) => { out += `<rect x="${ml + i * bw}" y="0" width="${bw}" height="${H - mb}" fill="transparent" data-tip="${yr}: ${nf(v, 1)} Heiße Tage (Mittel Baden-Württemberg)"/>`; });
  return out + "</svg>";
}

export async function setupScenario(ctx) {
  const { THREE, scene, $, terrainHeightAt, infoHooks, roofMeshes, camera } = ctx;
  const get = (u) => fetch(u).then((r) => (r.ok ? r.json() : null)).catch(() => null);
  const [climate, solar] = await Promise.all([get("data/climate.json"), get("data/solar.json")]);
  const box = $("scenario");
  if (!climate && !solar) { $("scenarioSec").hidden = true; return; }
  const tip = $("tooltip");
  const showTip = (e, html) => { tip.hidden = false; tip.innerHTML = html; tip.style.left = `${e.clientX + 14}px`; tip.style.top = `${e.clientY + 12}px`; };
  const hideTip = () => { tip.hidden = true; };
  let html = "";

  // ---------- Klima ----------
  if (climate) {
    const m = climate.marktplatz, gm = climate.gemeinde_mittel;
    html += `<h4>Heiße Tage pro Jahr am Marktplatz</h4>
      <div class="kpi"><div><b>${nf(m.hot_days[0])}</b><span>1961–1990</span></div><div><b>${nf(m.hot_days[1])}</b><span>1991–2020</span></div>
      <div class="scen"><b>≈ ${nf(m.hot_days[2])}</b><span>2040 <span class="badge">Szenario</span></span></div></div>
      <div class="small muted">30-jährige Mittel aus dem 1-km-Raster des DWD (Tmax ≥ 30 °C). Gemeindemittel ${nf(gm.hot_days[0])} → ${nf(gm.hot_days[1])}; Sommertage am Marktplatz ${nf(m.summer_days[0])} → ${nf(m.summer_days[1])}; Frosttage nahezu unverändert (${nf(m.frost_days[0])} → ${nf(m.frost_days[1])}). Der Wert 2040 ist eine Fortschreibung des beobachteten Trends, keine Klimaprojektion.</div>
      <label class="inline"><input type="checkbox" id="climLayer"> Klimaraster auf der Karte</label>
      <div class="toggles"><select id="climVar"><option value="hot_days">Heiße Tage</option><option value="summer_days">Sommertage</option><option value="frost_days">Frosttage</option></select>
        <select id="climPer"><option value="0">1961–1990</option><option value="1" selected>1991–2020</option><option value="2">2040 Fortschreibung (Szenario)</option></select></div>
      <div class="legend" id="climLegend"></div>
      <h4>Heiße Tage pro Jahr, Mittel Baden-Württemberg</h4>
      <div id="climChart">${chartSVG(climate.bw_reihen.hot_days, climate.bw_periodenmittel_heisse_tage)}</div>
      <details class="small"><summary>Werte als Tabelle</summary><table>${climate.bw_reihen.hot_days.map(([y, v]) => `<tr><td>${y}</td><td>${nf(v, 1)}</td></tr>`).join("")}</table></details>
      <div class="small" style="margin-top:6px"><b>Projektionen:</b> ${esc(climate.projektion_hinweis.text)} ${climate.projektion_hinweis.quellen.map((q) => `<a href="${esc(q.url)}" target="_blank" rel="noopener">${esc(q.titel)}</a>`).join(" · ")}</div>
      <div class="hint small muted">Quelle: Deutscher Wetterdienst, Climate Data Center (1-km-Raster multi_annual, Gebietsmittel Bundesländer, erstellt ${esc((climate.quelle.gebietsmittel_erstellt.match(/\d{8}/) || [""])[0].replace(/(\d{4})(\d{2})(\d{2})/, "$3.$2.$1"))}).</div>`;
  }

  // ---------- PV ----------
  if (solar) {
    const r = solar.ergebnis_gemeinde, b = solar.bestand;
    const share = b ? (b.bruttoleistung_kw / r.leistung_kwp) * 100 : null;
    const arten = b ? Object.entries(b.nach_art).map(([k, v]) => `<tr><td>${esc(k)}</td><td>${nf(v[0])}</td><td>${nf(v[1], 1)} kW</td></tr>`).join("") : "";
    const ann = Object.values(solar.annahmen).map((a) => `<li>${esc(a.grund)}</li>`).join("");
    const pr = solar.methode.pruefung_gegen_pvgis.map((p) => `<tr><td>${p.neigung}° / ${p.ausrichtung === 0 ? "Süd" : p.ausrichtung < 0 ? "Ost" : "West"}</td><td>${nf(p.modell_kwh_kwp)}</td><td>${nf(p.pvgis_kwh_kwp)}</td><td>${p.abweichung_prozent > 0 ? "+" : ""}${nf(p.abweichung_prozent, 1)} %</td></tr>`).join("");
    html += `<h4 style="margin-top:14px">PV auf allen geeigneten Dächern <span class="badge">Szenario</span></h4>
      <label class="inline"><input type="checkbox" id="pvLayer"> Auf den Dächern zeigen</label>
      <div class="kpi"><div><b>${b ? nf(b.bruttoleistung_kw / 1000, 1) + " MW" : "–"}</b><span>heute in Betrieb</span></div>
        <div class="scen"><b>${nf(r.leistung_kwp / 1000, 1)} MWp</b><span>möglich</span></div>
        <div class="scen"><b>${nf(r.ertrag_mwh_jahr / 1000, 1)} GWh</b><span>pro Jahr</span></div></div>
      <div class="small muted">${b ? `Heute sind ${nf(b.einheiten_in_betrieb)} Anlagen mit zusammen ${nf(b.bruttoleistung_kw)} kW gemeldet, rund ${nf(share)} % des Szenarios (Marktstammdatenregister, Gemeinde Sulzburg). ` : ""}Das Szenario ergäbe rund ${nf(r.je_einwohner_kwh)} kWh je Einwohnerin und Einwohner und Jahr (${nf(r.einwohner.wert)} Einwohner, Stand ${r.einwohner.stichtag.split("-").reverse().join(".")}). Der Geländehorizont kostet im Mittel ${nf(r.verlust_durch_gelaendehorizont_prozent, 1)} % des Ertrags.</div>
      <details class="small"><summary>Annahmen, Rechenweg und Prüfung</summary>
        <ul>${ann}</ul>
        <div>${esc(solar.methode.wetter)}. ${esc(solar.methode.modell)}. ${esc(solar.methode.verschattung)}</div>
        <table style="margin-top:4px"><tr><td>Neigung/Richtung</td><td>Modell</td><td>PVGIS</td><td>Abw.</td></tr>${pr}</table>
        <div class="muted">kWh je kWp und Jahr, ohne Horizont. Kalibriert auf 35° Süd; Ost und West liegen bis ${nf(Math.max(...solar.methode.pruefung_gegen_pvgis.map((p) => p.abweichung_prozent)), 1)} % über PVGIS, das Szenario ist also eher obere Grenze.</div>
        ${b ? `<div style="margin-top:4px">Bestand nach Art der Anlage:</div><table>${arten}</table><div class="muted">${esc(solar.bestand_quelle.hinweis)}</div>` : ""}
      </details>
      <div class="hint small muted">Quellen: Dachflächen LGL LoD2; Wetterjahr und Prüfwerte PVGIS 5.2 (EU-Kommission, JRC); Bestand <a href="${esc(solar.bestand_quelle.url || "#")}" target="_blank" rel="noopener">Marktstammdatenregister</a> der Bundesnetzagentur.</div>`;
  }
  box.innerHTML = html;

  // Tooltip für das Diagramm
  const chart = $("climChart");
  if (chart) {
    chart.addEventListener("pointermove", (e) => { const t = e.target.closest("[data-tip]"); if (t) showTip(e, t.dataset.tip); else hideTip(); });
    chart.addEventListener("pointerleave", hideTip);
  }

  // ---------- Szenario-Banner ----------
  const banner = () => {
    const parts = [];
    if ($("pvLayer")?.checked) parts.push("PV auf allen geeigneten Dächern");
    if ($("climLayer")?.checked && $("climPer")?.value === "2") parts.push("Klima 2040 als Fortschreibung");
    $("scenarioBanner").hidden = parts.length === 0;
    $("scenarioBannerText").textContent = parts.join(" + ");
  };

  // ---------- Klimaraster als Fläche auf dem Gelände ----------
  let overlay = null;
  const N = 12;
  const buildOverlay = () => {
    const cells = climate.zellen;
    const pos = [], cellAttr = [], idx = [];
    cells.forEach((c, ci) => {
      const [c0, c1, c2, c3] = c.ecken;
      const base = pos.length / 3;
      for (let j = 0; j <= N; j++) for (let i = 0; i <= N; i++) {
        const u = i / N, v = j / N;
        const x = (1 - u) * (1 - v) * c0[0] + u * (1 - v) * c1[0] + u * v * c2[0] + (1 - u) * v * c3[0];
        const z = (1 - u) * (1 - v) * c0[1] + u * (1 - v) * c1[1] + u * v * c2[1] + (1 - u) * v * c3[1];
        const y = terrainHeightAt(x, z);
        pos.push(x, (y ?? ctx.centerY) + 4, z); cellAttr.push(ci);
      }
      for (let j = 0; j < N; j++) for (let i = 0; i < N; i++) {
        const a = base + j * (N + 1) + i, b2 = a + 1, c = a + N + 1, d = c + 1;
        idx.push(a, b2, c, b2, d, c);
      }
    });
    const geo = new THREE.BufferGeometry();
    geo.setAttribute("position", new THREE.Float32BufferAttribute(pos, 3));
    geo.setAttribute("color", new THREE.Float32BufferAttribute(new Float32Array(pos.length), 3));
    geo.setAttribute("cell", new THREE.Float32BufferAttribute(cellAttr, 1));
    geo.setIndex(idx);
    const mat = new THREE.MeshBasicMaterial({ vertexColors: true, transparent: true, opacity: 0.72, depthWrite: false, side: THREE.DoubleSide, polygonOffset: true, polygonOffsetFactor: -4, toneMapped: false });
    overlay = new THREE.Mesh(geo, mat);
    overlay.renderOrder = 2;
    const lp = [];
    cells.forEach((c) => {
      for (let k = 0; k < 4; k++) {
        const a = c.ecken[k], b = c.ecken[(k + 1) % 4];
        for (let t = 0; t < N; t++) {
          const p0 = [a[0] + (b[0] - a[0]) * t / N, a[1] + (b[1] - a[1]) * t / N], p1 = [a[0] + (b[0] - a[0]) * (t + 1) / N, a[1] + (b[1] - a[1]) * (t + 1) / N];
          lp.push(p0[0], (terrainHeightAt(p0[0], p0[1]) ?? ctx.centerY) + 4.5, p0[1], p1[0], (terrainHeightAt(p1[0], p1[1]) ?? ctx.centerY) + 4.5, p1[1]);
        }
      }
    });
    const lines = new THREE.LineSegments(new THREE.BufferGeometry().setAttribute("position", new THREE.Float32BufferAttribute(lp, 3)),
      new THREE.LineBasicMaterial({ color: 0x1a1a19, transparent: true, opacity: 0.35, depthWrite: false }));
    lines.renderOrder = 3;
    overlay.add(lines);
    scene.add(overlay);
  };
  const colorOverlay = () => {
    const v = $("climVar").value, p = parseInt($("climPer").value, 10);
    const [lo, hi] = DOMAIN[v];
    const col = overlay.geometry.getAttribute("color"), cell = overlay.geometry.getAttribute("cell");
    for (let i = 0; i < col.count; i++) {
      const c = rampColor(THREE, (climate.zellen[cell.getX(i)][v][p] - lo) / (hi - lo)).convertSRGBToLinear();
      col.setXYZ(i, c.r, c.g, c.b);
    }
    col.needsUpdate = true;
    $("climLegend").innerHTML = `<span>${lo}</span><span class="bar" style="background:linear-gradient(90deg,${RAMP.join(",")})"></span><span>${hi} Tage</span><span>${PERIOD_LABEL[p]}${p === 2 ? ' <span class="badge">Szenario</span>' : ""}</span>`;
  };
  if (climate) {
    const update = () => {
      const on = $("climLayer").checked;
      if (on && !overlay) buildOverlay();
      if (overlay) { overlay.visible = on; if (on) colorOverlay(); }
      $("climLegend").hidden = !on;
      banner();
    };
    $("climLayer").addEventListener("change", update);
    $("climVar").addEventListener("change", update);
    $("climPer").addEventListener("change", update);
    $("climLegend").hidden = true;
    // Hover-Tooltip über dem Raster
    const ray = new THREE.Raycaster(), mouse = new THREE.Vector2();
    let pending = null;
    ctx.renderer.domElement.addEventListener("pointermove", (e) => {
      if (!overlay || !overlay.visible || e.buttons) { if (!tip.hidden && !chart?.matches(":hover")) hideTip(); return; }
      pending = e;
      requestAnimationFrame(() => {
        if (!pending) return;
        const ev = pending; pending = null;
        mouse.set((ev.clientX / innerWidth) * 2 - 1, -(ev.clientY / innerHeight) * 2 + 1);
        ray.setFromCamera(mouse, camera);
        const hit = ray.intersectObject(overlay, false)[0];
        if (!hit) { hideTip(); return; }
        const c = climate.zellen[overlay.geometry.getAttribute("cell").getX(hit.face.a)];
        const v = $("climVar").value, labels = { hot_days: "Heiße Tage", summer_days: "Sommertage", frost_days: "Frosttage" };
        showTip(ev, `<b>${labels[v]} pro Jahr</b><br>1961–1990: ${nf(c[v][0])} · 1991–2020: ${nf(c[v][1])}<br>2040 Fortschreibung: ≈ ${nf(c[v][2])} <span class="badge">Szenario</span><br><span class="muted">1-km-Zelle, DWD</span>`);
      });
    });
  }

  // ---------- PV-Szenario auf den Dächern ----------
  if (solar) {
    const roofBase = new THREE.Color().setRGB(0.71, 0.36, 0.28).convertSRGBToLinear();
    const modPitched = new THREE.Color(0x2f5d8c).convertSRGBToLinear(), modFlat = new THREE.Color(0x4a7bb0).convertSRGBToLinear();
    const applyPV = () => {
      const on = $("pvLayer").checked;
      if (on && $("sunlayer").checked) { $("sunlayer").checked = false; $("sunlayer").dispatchEvent(new Event("change")); }
      for (const mesh of roofMeshes) {
        const col = mesh.geometry.getAttribute("color"), pv = mesh.geometry.getAttribute("_pv"), orig = mesh.userData.originalColors;
        for (let i = 0; i < col.count; i++) {
          if (!on) { col.setXYZ(i, orig[i * 3], orig[i * 3 + 1], orig[i * 3 + 2]); continue; }
          const k = pv ? pv.getX(i) : 0;
          const c = k === 1 ? modPitched : k === 2 ? modFlat : roofBase;
          col.setXYZ(i, c.r, c.g, c.b);
        }
        col.needsUpdate = true;
        mesh.material.map = on ? null : ($("rooftex").checked ? mesh.userData.roofMap : null);
        mesh.material.roughness = on ? 0.45 : 0.9;
        mesh.material.needsUpdate = true;
      }
      banner();
    };
    $("pvLayer").addEventListener("change", applyPV);
    $("sunlayer").addEventListener("change", () => { if ($("sunlayer").checked && $("pvLayer").checked) { $("pvLayer").checked = false; applyPV(); $("sunlayer").dispatchEvent(new Event("change")); } });
    infoHooks.push((idx) => {
      const v = solar.werte[idx];
      if (!v || !v[0]) return `<h3>PV-Szenario <span class="badge">Szenario</span></h3><div class="small muted">Nach den Annahmen keine geeignete Dachfläche (zu klein, zu steil oder nach Norden).</div>`;
      return `<h3>PV-Szenario <span class="badge">Szenario</span></h3><dl><dt>Geeignete Dachfläche</dt><dd>${nf(v[2])} m²</dd><dt>Leistung</dt><dd>${nf(v[0], 1)} kWp</dd>` +
        `<dt>Ertrag</dt><dd>${nf(v[1])} kWh pro Jahr (${nf(v[1] / v[0])} kWh/kWp)</dd></dl><div class="hint">Abschätzung aus LoD2-Dachflächen, PVGIS-Wetterjahr und Geländehorizont; Annahmen im Abschnitt „Klima und Szenario 2040“.</div>`;
    });
  }
}
