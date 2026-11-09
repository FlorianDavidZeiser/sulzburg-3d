// Parkende Autos als 3D-Modelle an den Stellen, an denen sie beim Bildflug am 25.08.2025 standen.
// Erkannt aus nDOM1 und DOP20 (scripts/13_cars.py). Momentaufnahme, kein aktueller Zustand; Fahrzeugform ist Darstellung.
export async function setupCars(ctx) {
  const { THREE, scene, $, terrainHeightAt, pickHooks } = ctx;
  let data;
  try { const r = await fetch("data/cars.json"); if (!r.ok) throw new Error(r.status); data = await r.json(); } catch (e) { $("carsWrap").hidden = true; return; }
  ctx.meta.cars = data;
  const n = data.autos.length;
  // Einfaches Auto, Länge entlang z: Unterbau (dunkel), Karosserie (Fahrzeugfarbe), Kabine (abgedunkelt wie Glas)
  const parts = [
    { geo: new THREE.BoxGeometry(1.62, 0.32, 3.7).translate(0, 0.16, 0), tint: () => new THREE.Color(0x1b1d22) },
    { geo: new THREE.BoxGeometry(1.8, 0.62, 4.5).translate(0, 0.62, 0), tint: (c) => c },
    { geo: new THREE.BoxGeometry(1.62, 0.5, 2.3).translate(0, 1.18, -0.25), tint: (c) => c.clone().multiplyScalar(0.38) },
  ];
  const group = new THREE.Group(); group.name = "cars";
  const m4 = new THREE.Matrix4(), q = new THREE.Quaternion(), pos = new THREE.Vector3(), scl = new THREE.Vector3(), up = new THREE.Vector3(0, 1, 0), col = new THREE.Color();
  const meshes = parts.map((p) => {
    const mesh = new THREE.InstancedMesh(p.geo, new THREE.MeshStandardMaterial({ roughness: 0.45, metalness: 0.15 }), n);
    mesh.castShadow = true; mesh.receiveShadow = true;
    group.add(mesh); return mesh;
  });
  data.autos.forEach(([x, z, yaw, h, r, g, b], i) => {
    const y = terrainHeightAt(x, z) ?? ctx.centerY;
    pos.set(x, y, z);
    q.setFromAxisAngle(up, Math.PI - yaw);                 // Richtung im Luftbild auf die z-Achse des Modells
    const hs = Math.min(1.6, Math.max(0.85, h / 1.55));    // höhere Erhebung: Transporter oder Wohnmobil
    scl.set(1, hs, h > 2.1 ? 1.25 : 1);
    m4.compose(pos, q, scl);
    col.setRGB(r / 255, g / 255, b / 255).convertSRGBToLinear();
    meshes.forEach((mesh, k) => { mesh.setMatrixAt(i, m4); mesh.setColorAt(i, parts[k].tint(col.clone())); });
  });
  meshes.forEach((m) => { m.instanceMatrix.needsUpdate = true; m.instanceColor.needsUpdate = true; m.computeBoundingSphere(); });
  // Kontaktschatten: weicher dunkler Fleck unter jedem Auto, geneigt wie das Gelände (Darstellung)
  const blob = new THREE.InstancedMesh(new THREE.PlaneGeometry(2.5, 5.2).rotateX(-Math.PI / 2),
    new THREE.MeshBasicMaterial({ map: ctx.blobTexture?.(), color: 0x000000, transparent: true, opacity: 0.5, depthWrite: false, polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -4 }), n);
  const nrm = new THREE.Vector3(), qa = new THREE.Quaternion();
  data.autos.forEach(([x, z, yaw, h], i) => {
    const y = terrainHeightAt(x, z) ?? ctx.centerY;
    const hx = (terrainHeightAt(x + 1, z) ?? y) - (terrainHeightAt(x - 1, z) ?? y), hz = (terrainHeightAt(x, z + 1) ?? y) - (terrainHeightAt(x, z - 1) ?? y);
    nrm.set(-hx / 2, 1, -hz / 2).normalize();
    qa.setFromUnitVectors(up, nrm).multiply(q.setFromAxisAngle(up, Math.PI - yaw));
    pos.set(x, y, z); scl.set(1, 1, h > 2.1 ? 1.25 : 1);
    blob.setMatrixAt(i, m4.compose(pos, qa, scl));
  });
  blob.instanceMatrix.needsUpdate = true; blob.computeBoundingSphere(); blob.renderOrder = 1;
  group.add(blob);
  scene.add(group);
  ctx.carsLayer = { meshes, group, all: [...meshes, blob] };   // für den Fahrmodus (Höhe auf feinem Gelände)
  $("cars").addEventListener("change", (e) => { group.visible = e.target.checked; });
  $("carsInfo").textContent = `${n} Autos, automatisch erkannt aus Luftbild und Oberflächenmodell vom 25.08.2025. Momentaufnahme; etwa 8 von 10 Treffern stimmen, viele Autos fehlen.`;
  pickHooks.push((ray) => {
    if (!group.visible) return false;
    const hit = ray.intersectObjects(meshes, false)[0];
    if (!hit) return false;
    const info = $("info"); info.hidden = false;
    info.innerHTML = `<h2>Parkendes Auto</h2><div class="small">Stand beim Bildflug am 25.08.2025, nicht heute. Lage, Ausrichtung und Farbe aus dem Luftbild, Höhe aus dem Oberflächenmodell nDOM1. Die Form ist eine Darstellung.</div>` +
      `<div class="hint">Automatische Erkennung mit Fehlern: Etwa 8 von 10 Treffern sind Autos, viele Autos fehlen (unter Bäumen, dicht an Gebäuden, in engen Reihen). Daten: LGL, dl-de/by-2-0; Straßen: © OpenStreetMap-Mitwirkende, ODbL.</div>`;
    return true;
  });
}
