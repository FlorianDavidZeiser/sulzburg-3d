// Abnahmetest Fahrmodus (Stufe 1) im Browser. Schreibt docs/fahrmodus_test.json.
// Voraussetzung: Playwright mit Chromium, lokaler Server auf web/:
//   cd web && python3 -m http.server 8124        (zweites Terminal)
//   node scripts/test_drive.cjs
// Geprüft wird: Erkunden lädt nichts vom Fahrmodus, Absetzen per Ziehen, exakter Rückweg (Bild vorher = nachher),
// sauberes Verlassen bei Suche, Notschalter ?drive=0, Fahrphysik und Kollision ohne Zeichnen (Autopilot auf echten Straßen),
// Stufe 2: Fahrkacheln ohne Nähte, Spurhilfe, Zurücksetzen von Bäumen, Autos, Schatten und Geländematerial.
// Qualität fest auf „hoch“ (fq=2), weil die automatische Stufe im langsamen Software-Rendering sofort herunterschalten würde.
const { chromium } = require('playwright');
const fs = require('fs');
const path = require('path');
const BASE = process.env.BASE || 'http://127.0.0.1:8124/index.html';
const OUT = path.join(__dirname, '..', 'docs', 'fahrmodus_test.json');

(async () => {
  const browser = await chromium.launch({ args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader'] });
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: 1 });
  const logs = [];
  page.on('pageerror', (e) => logs.push('pageerror: ' + e.message));
  page.on('console', (m) => { if (m.type() === 'error') logs.push('console: ' + m.text()); });
  const loaded = [];
  page.on('response', async (r) => { try { loaded.push([r.url().replace(/^https?:\/\/[^/]+\//, ''), (await r.body()).length]); } catch (e) { /* abgebrochen */ } });
  await page.goto(`${BASE}?lod=1&t=2026-08-25T15:00&cam=-160,120,160&target=0,0&intro=0&fq=2`, { waitUntil: 'load', timeout: 180000 });
  await page.waitForFunction(() => window.__ready === true, null, { timeout: 180000 });
  await page.waitForTimeout(5000);
  await page.evaluate(() => { const b = document.getElementById('buses'); if (b.checked) b.click(); });   // bewegte Busse aus, damit Bilder vergleichbar sind
  await page.waitForTimeout(500);
  const out = { erzeugt: new Date().toISOString(), kreisradius_m: 0.97 };
  const objState = () => page.evaluate(() => { const c = window.__ctx, sum = (m) => { let s = 0; const a = m.instanceMatrix.array; for (let i = 13; i < a.length; i += 16) s += a[i]; return s; };
    const mat = c.terrainGroup.children[0].material;
    return { tree: c.getTreeMeshes().reduce((a, m) => a + sum(m), 0), car: sum(c.carsLayer.meshes[0]), cast: c.terrainGroup.children.every((m) => m.castShadow), sh: [c.sun.shadow.camera.right, c.sun.shadow.bias, c.sun.shadow.normalBias],
      maske: !!(mat.onBeforeCompile && String(mat.onBeforeCompile).includes('discard')), kacheln: c.scene.children.filter((o) => o.name === 'fahrkachel').length,
      spots: (() => { let n = 0; c.scene.traverse((o) => { if (o.isSpotLight) n++; }); return n; })() }; });
  const objBefore = await objState();
  out.start = { dateien: loaded.length, bytes: loaded.reduce((a, x) => a + x[1], 0), fahrmodus_dateien_beim_start: loaded.filter((x) => /drive\.js|fahrnetz|grundrisse/.test(x[0])).map((x) => x[0]) };
  const shot = () => page.screenshot({ timeout: 180000 });
  const imgBefore = await shot();
  const camBefore = await page.evaluate(() => { const c = window.__ctx; return { p: c.camera.position.toArray(), t: c.controls.target.toArray(), fov: c.camera.fov, near: c.camera.near, far: c.camera.far }; });

  // Absetzen per Ziehen: Maus auf das Auto (lädt vor), dann auf eine Straße im Bild
  const chip = await page.locator('#driveCar').boundingBox();
  await page.mouse.move(chip.x + 20, chip.y + 10);
  await page.waitForFunction(() => !!window.__drive, null, { timeout: 30000 });
  const tgt = await page.evaluate(() => { const c = window.__ctx, r = window.__drive.nearestRoad(40, 60); const v = new c.THREE.Vector3(r.x, c.terrainHeightAt(r.x, r.z), r.z).project(c.camera); return { x: (v.x + 1) / 2 * innerWidth, y: (1 - v.y) / 2 * innerHeight }; });
  await page.mouse.down();
  for (let i = 1; i <= 10; i++) { await page.mouse.move(chip.x + 20 + (tgt.x - chip.x - 20) * i / 10, chip.y + 10 + (tgt.y - chip.y - 10) * i / 10); await page.waitForTimeout(40); }
  out.ziehen = { beschriftung: await page.evaluate(() => document.getElementById('driveDrag').textContent) };
  await page.mouse.up();
  await page.waitForFunction(() => window.__drive.state() === 'drive', null, { timeout: 120000 });   // Anflug abwarten (Software-Rendering ist langsam)
  out.ziehen.zustand = await page.evaluate(() => window.__drive.state());
  await page.keyboard.down('w'); await page.waitForTimeout(1500); await page.keyboard.up('w');
  await page.keyboard.press('c'); await page.waitForTimeout(400); await page.keyboard.press('c');
  await page.keyboard.press('Escape');
  await page.waitForFunction(() => window.__drive.state() === 'off', null, { timeout: 120000 });   // Rückflug abwarten
  const camAfter = await page.evaluate(() => { const c = window.__ctx; return { p: c.camera.position.toArray(), t: c.controls.target.toArray(), fov: c.camera.fov, near: c.camera.near, far: c.camera.far, enabled: c.controls.enabled, state: window.__drive.state() }; });
  await page.waitForTimeout(1500);
  const imgAfter = await shot();
  const dist = (a, b) => Math.hypot(...a.map((v, i) => v - b[i]));
  out.rueckweg = { kamera_abweichung_m: dist(camAfter.p, camBefore.p), blickpunkt_abweichung_m: dist(camAfter.t, camBefore.t), fov_gleich: camAfter.fov === camBefore.fov,
    near_far_gleich: camAfter.near === camBefore.near && camAfter.far === camBefore.far, steuerung_aktiv: camAfter.enabled, zustand: camAfter.state, bild_identisch: imgBefore.equals(imgAfter) };

  // Suche oder Sprungknopf während der Fahrt: Fahrmodus wird verlassen, Steuerung ist wieder da
  await page.evaluate(() => window.__drive.placeNear(0, 0));
  await page.waitForFunction(() => window.__drive.state() === 'drive', null, { timeout: 120000 });
  out.flug_waehrend_fahrt = await page.evaluate(async () => { const c = window.__ctx; c.flyTo(new c.THREE.Vector3(0, c.centerY, 0), 450); await new Promise((r) => setTimeout(r, 2000));
    return { zustand: window.__drive.state(), steuerung_aktiv: c.controls.enabled, near: c.camera.near, kamera_frei: !c.cameraOwner() }; });

  // Fahrphysik und Kollision ohne Zeichnen
  out.physik = await page.evaluate(() => {
    const d = window.__drive, c = d.car, net = d.world.net, E = d.world.edge, res = {};
    const minWall = () => { let m = 99; const fx = Math.sin(c.yaw), fz = -Math.cos(c.yaw);
      for (const o of [1.2, 0, -1.2]) { const cx = c.x + fx * o, cz = c.z + fz * o;
        for (const i of d.world.edges.at(cx, cz)) { const dx = E.bx[i] - E.ax[i], dz = E.bz[i] - E.az[i], L2 = dx * dx + dz * dz; let t = L2 ? ((cx - E.ax[i]) * dx + (cz - E.az[i]) * dz) / L2 : 0; t = Math.max(0, Math.min(1, t)); m = Math.min(m, Math.hypot(cx - E.ax[i] - dx * t, cz - E.az[i] - dz * t)); } }
      return m; };
    d.placeNear(40, 60);
    d.setAssist(false);   // Autopilot lenkt selbst; die Spurhilfe wird unten getrennt geprüft
    d.setOnlyRoads(true); // Autopilot prüft die Straßenbindung (Modus „Nur Straßen“)
    res.beschleunigung_kmh_je_s = d.sim(4, { up: 1 }, 1).map((p) => +(p[2] * 3.6).toFixed(1));
    res.bremsen_kmh_je_s = d.sim(2, { down: 1 }, 1).map((p) => +(p[2] * 3.6).toFixed(1));
    const t0 = performance.now(); d.sim(10, { up: 1, left: 1 }); res.rechenzeit_ms_je_fahrsekunde = +((performance.now() - t0) / 10).toFixed(2);
    // Autopilot: folgt der OSM-Achse mit 8 m Vorausblick, Tempo je Straßenart, weicht Hindernissen nicht aus
    const lenOf = (w) => { let L = 0; for (let k = 4; k + 3 < w.length; k += 2) L += Math.hypot(w[k + 2] - w[k], w[k + 3] - w[k + 1]); return L; };
    const ok = new Set(['secondary', 'tertiary', 'residential', 'unclassified', 'living_street', 'service', 'track'].map((a) => net.arten.indexOf(a)));
    const pick = [];
    net.wege.forEach((w, i) => { if (ok.has(w[0]) && lenOf(w) > 60 && lenOf(w) < 600 && Math.hypot(w[4], w[5]) < 1500) pick.push(i); });
    pick.splice(80);
    const vt = { secondary: 13, tertiary: 12, unclassified: 11, residential: 8, living_street: 5, service: 6, track: 7 };
    let maxRoad = -99, minW = 99, meter = 0; const probleme = [];
    for (const wi of pick) {
      const w = net.wege[wi], pts = []; for (let k = 4; k + 1 < w.length; k += 2) pts.push([w[k], w[k + 1]]);
      const L0 = Math.hypot(pts[1][0] - pts[0][0], pts[1][1] - pts[0][1]);
      d.enter({ x: pts[0][0], z: pts[0][1], dx: (pts[1][0] - pts[0][0]) / L0, dz: (pts[1][1] - pts[0][1]) / L0, seg: -1 });
      c.v = 0; c.yaw = Math.atan2(pts[1][0] - pts[0][0], -(pts[1][1] - pts[0][1]));
      const cum = [0]; for (let k = 1; k < pts.length; k++) cum.push(cum[k - 1] + Math.hypot(pts[k][0] - pts[k - 1][0], pts[k][1] - pts[k - 1][1]));
      const total = cum[cum.length - 1];
      const at = (s) => { s = Math.min(total, Math.max(0, s)); let k = 1; while (k < pts.length - 1 && cum[k] < s) k++; const f = (s - cum[k - 1]) / ((cum[k] - cum[k - 1]) || 1); return [pts[k - 1][0] + (pts[k][0] - pts[k - 1][0]) * f, pts[k - 1][1] + (pts[k][1] - pts[k - 1][1]) * f]; };
      const proj = () => { let best = 1e9, bs = 0; for (let k = 1; k < pts.length; k++) { const ax = pts[k - 1][0], az = pts[k - 1][1], dx = pts[k][0] - ax, dz = pts[k][1] - az, L2 = dx * dx + dz * dz; let t = L2 ? ((c.x - ax) * dx + (c.z - az) * dz) / L2 : 0; t = Math.max(0, Math.min(1, t)); const dd = Math.hypot(c.x - ax - dx * t, c.z - az - dz * t); if (dd < best) { best = dd; bs = cum[k - 1] + t * Math.sqrt(L2); } } return bs; };
      let t = 0, stand = 0, reached = false;
      const v = vt[net.arten[w[0]]];
      while (t < 120) {
        const s = proj(); if (s > total - 6) { reached = true; break; }
        const [tx, tz] = at(s + 8); const want = Math.atan2(tx - c.x, -(tz - c.z)); const da = Math.atan2(Math.sin(want - c.yaw), Math.cos(want - c.yaw));
        d.sim(0.1, { up: c.v < v ? 1 : 0, down: c.v > v + 3 ? 1 : 0, left: da < -0.04 ? 1 : 0, right: da > 0.04 ? 1 : 0 }, 0.1); t += 0.1;
        const f = { d: 0 }; d.roadField(c.x, c.z, f); maxRoad = Math.max(maxRoad, f.d);
        if (Math.round(t * 10) % 10 === 0) minW = Math.min(minW, minWall());
        if (Math.abs(c.v) < 0.5 && t > 3) stand += 0.1;
      }
      meter += total;
      if (!reached || stand > 3) {
        const fx = Math.sin(c.yaw), fz = -Math.cos(c.yaw), pc = d.world.pc; let pe = 99;
        for (let i = 0; i < pc.length / 2; i++) pe = Math.min(pe, Math.hypot(pc[i * 2] - c.x - fx * 1.2, pc[i * 2 + 1] - c.z - fz * 1.2));
        probleme.push({ weg: w[1] >= 0 ? net.namen[w[1]] : net.arten[w[0]], erreicht: reached, stand_s: +stand.toFixed(1), hindernis: pe < 2.5 ? 'parkendes Auto' : minWall() < 1 ? 'Gebäude' : 'unklar' });
      }
    }
    d.setAssist(true);
    d.setOnlyRoads(false);
    // Freie Fahrt: quer über die Mittelinsel des Kreisverkehrs (Mitte -422/-446)
    const kx = -422, kz = -446; let best = 99;
    for (let k = 0; k < 8; k++) {
      const ang = k * Math.PI / 4, sx = kx + Math.cos(ang) * 14, sz = kz + Math.sin(ang) * 14, f = { d: 0 };
      if (d.roadField(sx, sz, f).d > 0) continue;
      c.x = sx; c.z = sz; c.yaw = Math.atan2(kx - sx, -(kz - sz)); c.v = 0;
      for (const [x, z] of d.sim(4, { up: 1 }, 0.1)) best = Math.min(best, Math.hypot(x - kx, z - kz));
    }
    // Abseits und ohne Drosselung: vom Ortsrand quer zur Straße ins Gelände
    const r3 = d.nearestRoad(250, 250); c.x = r3.x; c.z = r3.z; c.yaw = Math.atan2(-r3.dz, -r3.dx); c.v = 0;
    let vmax = 0; for (const p of d.sim(12, { up: 1 }, 0.25)) vmax = Math.max(vmax, Math.abs(p[2]) * 3.6);
    res.freie_fahrt = { kreisverkehr_naechster_abstand_zur_mitte_m: +best.toFixed(2), abseits_hoechsttempo_kmh: Math.round(vmax), baeume_als_hindernis: d.trees() ? d.trees().x.length : 0 };
    d.exit();
    res.autopilot = { wege: pick.length, meter: Math.round(meter), ohne_haengen: pick.length - probleme.length, probleme, max_abstandsfeld_spur_m: +maxRoad.toFixed(3), min_kreisabstand_wand_m: +minW.toFixed(3) };
    return res;
  });
  await page.waitForTimeout(2000);

  await page.waitForFunction(() => window.__drive.state() === 'off', null, { timeout: 120000 });

  // Stufe 2: Fahrkacheln an der Hauptstraße, Nähte, Spurhilfe, Zurücksetzen
  await page.evaluate(() => {
    const d = window.__drive, net = d.world.net, w = net.wege.find((x) => x[1] === net.namen.indexOf('Hauptstraße'));
    const k = 4 + 2 * Math.floor((w.length - 4) / 4), L = Math.hypot(w[k + 2] - w[k], w[k + 3] - w[k + 1]);
    d.enter({ x: w[k], z: w[k + 1], dx: (w[k + 2] - w[k]) / L, dz: (w[k + 3] - w[k + 1]) / L, seg: -1 });
  });
  await page.waitForFunction(() => window.__drive.state() === 'drive', null, { timeout: 120000 });
  await page.waitForFunction(() => { const s = window.__drive.fine().stats(); return s.geladen >= 8 && s.laden === 0 && s.offen === 0; }, null, { timeout: 180000 });
  const objDuring = await objState();
  out.stufe2 = await page.evaluate(() => {
    const d = window.__drive, f = d.fine(), c = window.__ctx, car = d.car, r = {};
    let naht = 0, rand = 0;
    for (let dx = -120; dx <= 120; dx += 0.37) for (let dz = -120; dz <= 120; dz += 7.3) {
      const x = car.x + dx, z = car.z + dz, a = f.heightAt(x - 1e-4, z), b = f.heightAt(x + 1e-4, z);
      if (a != null && b != null) naht = Math.max(naht, Math.abs(a - b));
      if ((a == null) !== (b == null)) rand = Math.max(rand, Math.abs((a ?? b) - c.terrainSurfaceAt(x, z)));
    }
    const st = f.stats(); Object.assign(r, { kacheln_geladen: st.geladen, kb: st.kb, naht_m: +naht.toFixed(4), rand_m: +rand.toFixed(4), auto_auf_feiner_flaeche_m: +Math.abs(car.y - f.heightAt(car.x, car.z)).toFixed(3) });
    // Spurhilfe: nur Gas, 15 Straßen im Ort; Ziel: bis zum Ende, ohne die Straße zu verlassen
    const net = d.world.net, S = d.world.seg, ok = new Set(['secondary', 'tertiary', 'residential', 'unclassified'].map((a) => net.arten.indexOf(a)));
    const lenOf = (w) => { let L = 0; for (let k = 4; k + 3 < w.length; k += 2) L += Math.hypot(w[k + 2] - w[k], w[k + 3] - w[k + 1]); return L; };
    const pick = []; net.wege.forEach((w, i) => { if (ok.has(w[0]) && lenOf(w) > 150 && lenOf(w) < 600 && Math.hypot(w[4], w[5]) < 1200) pick.push(i); });
    pick.splice(15);
    let wegeOk = 0, maxAbst = 0;
    for (const wi of pick) {
      const w = net.wege[wi], last = [w[w.length - 2], w[w.length - 1]], L0 = Math.hypot(w[6] - w[4], w[7] - w[5]);
      d.enter({ x: w[4], z: w[5], dx: (w[6] - w[4]) / L0, dz: (w[7] - w[5]) / L0, seg: -1 });
      car.yaw = Math.atan2(w[6] - w[4], -(w[7] - w[5])); car.v = 0;
      let reached = false;
      for (let t = 0; t < 90 && !reached; t += 0.5) {
        d.sim(0.5, { up: car.v < 11 ? 1 : 0 }, 0.5);
        let best = 99; for (let k = 4; k + 3 < w.length; k += 2) { const ax = w[k], az = w[k + 1], dx = w[k + 2] - ax, dz = w[k + 3] - az, L2 = dx * dx + dz * dz; let u = L2 ? ((car.x - ax) * dx + (car.z - az) * dz) / L2 : 0; u = Math.max(0, Math.min(1, u)); best = Math.min(best, Math.hypot(car.x - ax - dx * u, car.z - az - dz * u)); }
        if (best < 20) maxAbst = Math.max(maxAbst, best);
        if (Math.hypot(car.x - last[0], car.z - last[1]) < 12) reached = true;
      }
      if (reached) wegeOk++;
    }
    r.spurhilfe = { wege: pick.length, wege_ok: wegeOk, max_abstand_achse_m: +maxAbst.toFixed(2) };
    d.exit();
    return r;
  });
  await page.waitForFunction(() => window.__drive.state() === 'off', null, { timeout: 120000 });
  const objAfter = await objState();
  out.stufe2.waehrend = { kacheln: objDuring.kacheln, maske_aktiv: objDuring.maske, baeume_angepasst: objDuring.tree !== objBefore.tree };
  out.stufe2.zurueck = { objekte: Math.abs(objAfter.tree - objBefore.tree) < 1e-3 && Math.abs(objAfter.car - objBefore.car) < 1e-3,
    schatten_material: objAfter.cast === objBefore.cast && JSON.stringify(objAfter.sh) === JSON.stringify(objBefore.sh) && objAfter.maske === objBefore.maske,
    kacheln_entfernt: objAfter.kacheln === 0, lichter_entfernt: objAfter.spots === 0 };

  fs.writeFileSync(OUT, JSON.stringify(out, null, 1) + '\n');   // Zwischenstand
  // Notschalter, auf einer eigenen Seite
  await page.close();
  const p2 = await browser.newPage({ viewport: { width: 1000, height: 700 } });
  await p2.goto(`${BASE}?lod=2&intro=0&drive=0`, { waitUntil: 'load', timeout: 180000 });
  await p2.waitForFunction(() => window.__ready === true, null, { timeout: 180000 });
  out.notschalter = { abschnitt_vorhanden: await p2.evaluate(() => !!document.getElementById('driveSec')) };
  out.fehler_konsole = logs;
  fs.writeFileSync(OUT, JSON.stringify(out, null, 1) + '\n');
  console.log(JSON.stringify(out, null, 1));
  await browser.close();
})();
