// Fahrkacheln (Fahrmodus, Stufe 2): Gelände im 1-m-Raster und Luftbild in 0,2 m, nur rund um das Auto.
// Daten aus scripts/15_drive_tiles.py (LGL DGM1 und DOP20, dl-de/by-2-0). Wird nur im Fahrmodus geladen.
// Prinzip: Wo eine Fahrkachel geladen ist, verwirft das grobe Gelände seine Pixel (Maske im Shader). Am Rand der
// geladenen Fläche gehen die feinen Höhen weich in die grobe Geländefläche über, so entstehen keine Spalten.
// Bäume und parkende Autos in geladenen Kacheln werden auf die feine Höhe gesetzt und beim Entladen zurückgestellt.

const T = 50, N = 51, BLEND = 6, TEX_BLEND = 12;   // Kachelkante (m), Punkte je Kante, Übergang Höhe und Luftbild zum groben Gelände (m)

export async function createFineTerrain(ctx) {
  const { THREE, scene, meta } = ctx;
  const r = await fetch("data/fahrkacheln/index.json");
  if (!r.ok) throw new Error("fahrkacheln: " + r.status);
  const info = await r.json();
  const { e0, n0 } = meta.index;
  const mod = (a, m) => ((a % m) + m) % m;
  const X0 = mod(-e0, T), Z0 = mod(n0, T);           // Raster der Kachelecken in lokalen Koordinaten
  const keyOf = (x, z) => `${x}_${z}`;
  const all = new Map();
  let minX = Infinity, minZ = Infinity, maxX = -Infinity, maxZ = -Infinity;
  for (const [block, list] of Object.entries(info.bloecke)) {
    list.forEach(([x, z, zmin], idx) => {
      all.set(keyOf(x, z), { x, z, zmin, block, idx, state: "none" });
      minX = Math.min(minX, x); minZ = Math.min(minZ, z); maxX = Math.max(maxX, x + T); maxZ = Math.max(maxZ, z + T);
    });
  }
  const cols = Math.round((maxX - minX) / T), rows = Math.round((maxZ - minZ) / T);
  const tileAt = (x, z) => all.get(keyOf(X0 + T * Math.floor((x - X0) / T), Z0 + T * Math.floor((z - Z0) / T)));

  // ---------- Maske für das grobe Gelände ----------
  const maskData = new Uint8Array(cols * rows);
  const mask = new THREE.DataTexture(maskData, cols, rows, THREE.RedFormat, THREE.UnsignedByteType);
  mask.magFilter = mask.minFilter = THREE.NearestFilter; mask.generateMipmaps = false; mask.needsUpdate = true;
  const U = { uFineMask: { value: mask }, uFineOrigin: { value: new THREE.Vector2(minX, minZ) }, uFineDim: { value: new THREE.Vector2(cols, rows) }, uFineOn: { value: 0 } };
  const setMask = (t, v) => { maskData[Math.round((t.z - minZ) / T) * cols + Math.round((t.x - minX) / T)] = v; mask.needsUpdate = true; };
  // Eigene Kopie des Geländematerials mit Maske; beim Aussteigen kommt das Original zurück (Erkunden bleibt ohne discard)
  const patch = (mat) => {
    const c = mat.clone();
    c.onBeforeCompile = (shader) => {
      Object.assign(shader.uniforms, U);
      shader.vertexShader = shader.vertexShader.replace("#include <common>", "#include <common>\nvarying vec2 vFineXZ;")
        .replace("#include <project_vertex>", "#include <project_vertex>\nvFineXZ = (modelMatrix * vec4(transformed, 1.0)).xz;");
      shader.fragmentShader = shader.fragmentShader.replace("#include <common>",
        "#include <common>\nvarying vec2 vFineXZ;\nuniform sampler2D uFineMask;\nuniform vec2 uFineOrigin;\nuniform vec2 uFineDim;\nuniform float uFineOn;")
        .replace("void main() {", `void main() {
  if (uFineOn > 0.5) {
    vec2 tt = floor((vFineXZ - uFineOrigin) / ${T}.0);
    if (tt.x >= 0.0 && tt.y >= 0.0 && tt.x < uFineDim.x && tt.y < uFineDim.y && texture2D(uFineMask, (tt + 0.5) / uFineDim).r > 0.5) discard;
  }`);
    };
    c.customProgramCacheKey = () => "feinmaske";
    return c;
  };
  function swapTerrain(on) {
    for (const m of ctx.terrainGroup.children) {
      const ud = m.userData;
      if (on) {
        if (!ud.fineMat || ud.fineMatSrc !== m.material) { ud.fineMat = patch(m.material); ud.fineMatSrc = m.material; }
        const o = m.material, f = ud.fineMat;
        if (f.map !== o.map || !f.color.equals(o.color)) { f.map = o.map; f.color.copy(o.color); f.needsUpdate = true; }
        ud.origMat = o; m.material = f;
      } else if (ud.origMat) {
        const o = ud.origMat, f = m.material;    // Änderungen während der Fahrt (Luftbild an/aus, nachgeladene Textur) übernehmen
        if (o.map !== f.map || !o.color.equals(f.color)) { o.map = f.map; o.color.copy(f.color); o.needsUpdate = true; }
        m.material = o; ud.origMat = null;
      }
    }
  }

  // ---------- Laden ----------
  const blocks = new Map();     // Block -> Promise<Int16Array>
  const loader = new THREE.TextureLoader();
  const aniso = ctx.renderer.capabilities.getMaxAnisotropy();
  const ready = new Set();      // Kacheln mit Mesh in der Szene
  let loading = 0, active = false, radius = 130, lastPlan = 0, bytes = 0;
  const loadBlock = (b) => {
    if (!blocks.has(b)) blocks.set(b, fetch(`data/fahrkacheln/h_${b}.bin`).then((res) => { if (!res.ok) throw new Error(res.status); return res.arrayBuffer(); })
      .then((buf) => { bytes += buf.byteLength; return new Int16Array(buf); }));
    return blocks.get(b);
  };
  function decode(t, arr) {
    const h = new Float32Array(N * N), off = t.idx * N * N;
    let row0 = 0;
    for (let j = 0; j < N; j++) {
      let v = j === 0 ? arr[off] : row0 + arr[off + j * N];
      row0 = v; h[j * N] = (t.zmin + v) / 100;
      for (let i = 1; i < N; i++) { v += arr[off + j * N + i]; h[j * N + i] = (t.zmin + v) / 100; }
    }
    return h;
  }
  async function load(t) {
    t.state = "loading"; loading++;
    try {
      const e = t.x + e0, n = n0 - t.z - T;
      const [arr, tex] = await Promise.all([loadBlock(t.block), loader.loadAsync(`data/fahrkacheln/f_${e}_${n}.jpg`)]);
      if (t.state !== "loading") { tex.dispose(); return; }        // inzwischen nicht mehr gebraucht
      tex.colorSpace = THREE.SRGBColorSpace; tex.anisotropy = aniso; tex.wrapS = tex.wrapT = THREE.ClampToEdgeWrapping;
      t.fine = decode(t, arr);
      t.tex = tex;
      bytes += 18000;   // grobe Schätzung je Luftbild für die Anzeige
      build(t);
      t.state = "ready"; ready.add(t); setMask(t, 255);
      markNeighbours(t);
    } catch (err) {
      t.state = "failed";
    } finally { loading--; }
  }
  function unload(t) {
    if (t.state === "loading") { t.state = "none"; return; }
    if (t.state !== "ready") return;
    scene.remove(t.mesh); t.mesh.geometry.dispose(); t.mesh.material.dispose(); t.tex.dispose();
    restoreObjects(t);
    t.mesh = t.tex = t.fine = t.final = null; t.state = "none"; ready.delete(t); setMask(t, 0);
    markNeighbours(t);
  }

  // ---------- Geometrie mit weichem Übergang ----------
  const isReady = (x, z) => { const t = all.get(keyOf(x, z)); return !!t && t.state === "ready"; };
  function computeFinal(t) {
    const L = (dx, dz) => isReady(t.x + dx * T, t.z + dz * T);
    const W = !L(-1, 0), E = !L(1, 0), Nn = !L(0, -1), S = !L(0, 1), NW = !L(-1, -1), NE = !L(1, -1), SW = !L(-1, 1), SE = !L(1, 1);
    const f = t.final || (t.final = new Float32Array(N * N));
    const tw = t.texW || (t.texW = new Float32Array(N * N));
    for (let j = 0; j < N; j++) for (let i = 0; i < N; i++) {
      let d = Infinity;
      if (W) d = Math.min(d, i); if (E) d = Math.min(d, T - i); if (Nn) d = Math.min(d, j); if (S) d = Math.min(d, T - j);
      if (NW) d = Math.min(d, Math.hypot(i, j)); if (NE) d = Math.min(d, Math.hypot(T - i, j));
      if (SW) d = Math.min(d, Math.hypot(i, T - j)); if (SE) d = Math.min(d, Math.hypot(T - i, T - j));
      const k = j * N + i, hf = t.fine[k];
      const st = Math.min(1, d / TEX_BLEND); tw[k] = st * st * (3 - 2 * st);
      if (d >= BLEND) { f[k] = hf; continue; }
      const s = d / BLEND, w = s * s * (3 - 2 * s);
      const hc = ctx.terrainSurfaceAt(t.x + i, t.z + j) ?? hf;
      f[k] = hc + (hf - hc) * w;
    }
  }
  function build(t) {
    computeFinal(t);
    const pos = new Float32Array(N * N * 3), nrm = new Float32Array(N * N * 3), uv = new Float32Array(N * N * 2), uvc = new Float32Array(N * N * 2);
    const coarse = coarseFor(t);
    for (let j = 0; j < N; j++) for (let i = 0; i < N; i++) {
      const k = j * N + i;
      pos[k * 3] = t.x + i; pos[k * 3 + 2] = t.z + j;
      uv[k * 2] = i / T; uv[k * 2 + 1] = 1 - j / T;
      if (coarse) { uvc[k * 2] = (t.x + i + e0 - coarse.e) / coarse.size; uvc[k * 2 + 1] = (n0 - (t.z + j) - coarse.n) / coarse.size; }
    }
    const idx = new Uint16Array(T * T * 6);
    let q = 0;
    for (let j = 0; j < T; j++) for (let i = 0; i < T; i++) {
      const a = j * N + i, b = a + 1, c = a + N, d = c + 1;
      idx[q++] = a; idx[q++] = c; idx[q++] = b; idx[q++] = b; idx[q++] = c; idx[q++] = d;
    }
    const geo = new THREE.BufferGeometry();
    geo.setAttribute("position", new THREE.BufferAttribute(pos, 3));
    geo.setAttribute("normal", new THREE.BufferAttribute(nrm, 3));
    geo.setAttribute("uv", new THREE.BufferAttribute(uv, 2));
    geo.setAttribute("uvc", new THREE.BufferAttribute(uvc, 2));
    geo.setAttribute("edgew", new THREE.BufferAttribute(new Float32Array(N * N), 1));
    geo.setIndex(new THREE.BufferAttribute(idx, 1));
    const ortho = !document.getElementById("ortho") || document.getElementById("ortho").checked;
    const mat = new THREE.MeshLambertMaterial({ map: ortho ? t.tex : null, color: ortho ? 0xffffff : 0x7f8c6e });
    blendWithCoarse(mat, coarse);
    t.mesh = new THREE.Mesh(geo, mat);
    t.mesh.receiveShadow = true; t.mesh.castShadow = true;
    t.mesh.name = "fahrkachel";
    writeHeights(t);
    scene.add(t.mesh);
    adjustObjects(t);
  }
  function writeHeights(t) {
    const geo = t.mesh.geometry, pos = geo.attributes.position.array, nrm = geo.attributes.normal.array, f = t.final;
    for (let j = 0; j < N; j++) for (let i = 0; i < N; i++) {
      const k = j * N + i;
      pos[k * 3 + 1] = f[k];
      const il = Math.max(0, i - 1), ir = Math.min(T, i + 1), ju = Math.max(0, j - 1), jd = Math.min(T, j + 1);
      const dx = (f[j * N + ir] - f[j * N + il]) / (ir - il), dz = (f[jd * N + i] - f[ju * N + i]) / (jd - ju);
      const len = Math.hypot(dx, 1, dz);
      nrm[k * 3] = -dx / len; nrm[k * 3 + 1] = 1 / len; nrm[k * 3 + 2] = -dz / len;
    }
    geo.attributes.edgew.array.set(t.texW); geo.attributes.edgew.needsUpdate = true;
    geo.attributes.position.needsUpdate = true; geo.attributes.normal.needsUpdate = true;
    geo.computeBoundingSphere();
  }
  // Grobe Geländekachel (500 m) mit ihrem Luftbild, in der die Fahrkachel liegt
  function coarseFor(t) {
    const e = t.x + e0, n = n0 - t.z - T;
    for (const m of ctx.terrainGroup.children) {
      const c = m.userData.tile;
      if (c && e >= c.e_min && e < c.e_min + c.size && n >= c.n_min && n < c.n_min + c.size) return { e: c.e_min, n: c.n_min, size: c.size, mesh: m };
    }
    return null;
  }
  // Weiche Kante: am Rand der geladenen Fläche geht das 0,2-m-Luftbild auf 12 m in das gröbere der Karte über
  function blendWithCoarse(mat, coarse) {
    const tex = coarse?.mesh.userData.ortho || null;
    mat.onBeforeCompile = (shader) => {
      shader.uniforms.uCoarse = { value: tex }; shader.uniforms.uHasCoarse = { value: tex ? 1 : 0 };
      shader.vertexShader = shader.vertexShader
        .replace("#include <common>", "#include <common>\nattribute vec2 uvc;\nattribute float edgew;\nvarying vec2 vUvc;\nvarying float vEdgeW;")
        .replace("#include <uv_vertex>", "#include <uv_vertex>\n  vUvc = uvc; vEdgeW = edgew;");
      shader.fragmentShader = shader.fragmentShader
        .replace("#include <common>", "#include <common>\nuniform sampler2D uCoarse;\nuniform float uHasCoarse;\nvarying vec2 vUvc;\nvarying float vEdgeW;")
        .replace("#include <map_fragment>", `#ifdef USE_MAP
  vec4 fineC = texture2D( map, vMapUv );
  vec4 sampledDiffuseColor = uHasCoarse > 0.5 ? mix( texture2D( uCoarse, vUvc ), fineC, vEdgeW ) : fineC;
  diffuseColor *= sampledDiffuseColor;
#endif`);
    };
    mat.customProgramCacheKey = () => "fahrkachel-rand";
  }

  const dirty = new Set();
  function markNeighbours(t) {
    for (let dz = -1; dz <= 1; dz++) for (let dx = -1; dx <= 1; dx++) {
      if (!dx && !dz) continue;
      const n = all.get(keyOf(t.x + dx * T, t.z + dz * T));
      if (n && n.state === "ready") dirty.add(n);
    }
  }

  // Höhe der feinen Fläche (gleiche Dreiecke wie das Mesh), null außerhalb geladener Kacheln
  function heightAt(x, z) {
    const t = tileAt(x, z);
    if (!t || t.state !== "ready") return null;
    const fx = x - t.x, fz = z - t.z;
    const i0 = Math.min(T - 1, Math.max(0, Math.floor(fx))), j0 = Math.min(T - 1, Math.max(0, Math.floor(fz)));
    const dx = fx - i0, dz = fz - j0, f = t.final, k = j0 * N + i0;
    if (dx + dz <= 1) return f[k] + (f[k + 1] - f[k]) * dx + (f[k + N] - f[k]) * dz;
    const hd = f[k + N + 1];
    return hd + (f[k + N] - hd) * (1 - dx) + (f[k + 1] - hd) * (1 - dz);
  }

  // ---------- Bäume und parkende Autos auf die feine Höhe setzen ----------
  const groups = [];   // { meshes, byTile: Map, baseY: Float32Array }
  function attach(meshes) {
    if (!meshes || !meshes.length || !meshes[0]) return;
    const m = meshes[0], a = m.instanceMatrix.array, byTile = new Map(), baseY = new Float32Array(m.count);
    for (let i = 0; i < m.count; i++) {
      baseY[i] = a[i * 16 + 13];
      const t = tileAt(a[i * 16 + 12], a[i * 16 + 14]);
      if (!t) continue;
      let l = byTile.get(t); if (!l) byTile.set(t, (l = [])); l.push(i);
    }
    groups.push({ meshes, byTile, baseY });
  }
  function adjustObjects(t, restore = false) {
    for (const g of groups) {
      const l = g.byTile.get(t); if (!l) continue;
      const a0 = g.meshes[0].instanceMatrix.array;
      for (const i of l) {
        const y = restore ? g.baseY[i] : (heightAt(a0[i * 16 + 12], a0[i * 16 + 14]) ?? g.baseY[i]);
        for (const m of g.meshes) m.instanceMatrix.array[i * 16 + 13] = y;
      }
      for (const m of g.meshes) m.instanceMatrix.needsUpdate = true;
    }
  }
  const restoreObjects = (t) => adjustObjects(t, true);

  // ---------- Steuerung von außen ----------
  function update(cx, cz, vx, vz) {
    if (!active) return;
    const now = performance.now();
    // dirty Kacheln neu rechnen (Nachbar geladen oder entladen), höchstens zwölf je Bild (je rund 0,3 ms)
    let n = 0;
    for (const t of dirty) { dirty.delete(t); if (t.state === "ready") { computeFinal(t); writeHeights(t); adjustObjects(t); } if (++n >= 12) break; }
    if (now - lastPlan < 200) return;
    lastPlan = now;
    const ax = cx + vx * 1.5, az = cz + vz * 1.5;   // etwas vorausschauen
    const want = [];
    for (let z = Z0 + T * Math.floor((Math.min(cz, az) - radius - Z0) / T); z <= Math.max(cz, az) + radius; z += T) {
      for (let x = X0 + T * Math.floor((Math.min(cx, ax) - radius - X0) / T); x <= Math.max(cx, ax) + radius; x += T) {
        const t = all.get(keyOf(x, z)); if (!t) continue;
        const d = Math.min(Math.hypot(x + T / 2 - cx, z + T / 2 - cz), Math.hypot(x + T / 2 - ax, z + T / 2 - az));
        if (d <= radius) want.push([d, t]);
      }
    }
    want.sort((a, b) => a[0] - b[0]);
    for (const [, t] of want) { if (loading >= 6) break; if (t.state === "none") load(t); }
    for (const t of [...ready]) if (Math.hypot(t.x + T / 2 - cx, t.z + T / 2 - cz) > radius + 70) unload(t);
  }
  function setActive(on) {
    if (on !== active) swapTerrain(on);
    active = on; U.uFineOn.value = on ? 1 : 0;
    if (!on) { for (const t of [...ready]) unload(t); for (const t of all.values()) if (t.state === "loading") t.state = "none"; dirty.clear(); }
  }
  function setRadius(r) { radius = r; }
  function rebuildAll() { for (const t of ready) dirty.add(t); }
  function setOrtho(on) { for (const t of ready) { t.mesh.material.map = on ? t.tex : null; t.mesh.material.color.set(on ? 0xffffff : 0x7f8c6e); t.mesh.material.needsUpdate = true; } }
  function resetGroups() { for (const t of ready) restoreObjects(t); groups.length = 0; }
  const stats = () => ({ geladen: ready.size, laden: loading, offen: dirty.size, kacheln: all.size, kb: Math.round(bytes / 1024) });
  return { update, heightAt, setActive, setRadius, attach, resetGroups, rebuildAll, setOrtho, stats, tileAt, info };
}
