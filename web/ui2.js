// Oberfläche (index.html): Themen, kleine Fenster, Chips für Wetter und Warnung, Startkarte, freiwillige Tour.
// Nutzt nur die bestehenden Bedienelemente; app.js und die Module bleiben unverändert zuständig.
const $ = (id) => document.getElementById(id);
const params = new URLSearchParams(location.search);
if (params.has("debug")) document.body.classList.add("debug");
const store = { get: (k) => { try { return localStorage.getItem(k); } catch (e) { return null; } }, set: (k, v) => { try { localStorage.setItem(k, v); } catch (e) { /* privat */ } } };
const nf = (v, d = 0) => Number(v).toLocaleString("de-DE", { minimumFractionDigits: d, maximumFractionDigits: d });

// ---------- Themen ----------
const OFF = { sunlayer: false, climLayer: false, pvLayer: false, radar: false };
const THEMES = {
  umsehen: { title: "Umsehen", intro: (m) => `Gelände, ${nf(m.buildings?.anzahl || 2366)} Gebäude und gut ${nf(Math.floor((m.trees?.anzahl || 66580) / 1000))}.000 Bäume, so wie Vermessung und Luftbild sie zeigen.`, on: { ...OFF, places: true, business: false } },
  geschichte: { title: "Geschichte", intro: () => "Orte mit Geschichte, jede Angabe mit Quelle. Ein Klick auf einen Namen fliegt hin.", on: { ...OFF, places: true, business: false } },
  arbeiten: { title: "Arbeiten und Leben", intro: () => "Betriebe aus OpenStreetMap und die Busse nach Soll-Fahrplan. Alle Betriebe werden gleich behandelt.", on: { ...OFF, places: false, business: true, transit: true, buses: true } },
  klima: { title: "Sonne und Klima", intro: () => "Wie viel Sonne jedes Dach bekommt, was Photovoltaik bringen könnte und wie heiß es wird. Szenarien sind gekennzeichnet.", on: { ...OFF, places: false, business: false, sunlayer: true } },
  wetter: { title: "Wetter jetzt", intro: () => "Live vom Deutschen Wetterdienst: Licht, Nebel und Regen in der Ansicht, dazu das Regenradar mit Vorhersage.", on: { ...OFF, places: false, business: false, radar: true }, now: true },
  fahren: { title: "Fahren", intro: () => "Ein Auto auf eine Straße ziehen und selbst durch Sulzburg fahren.", on: { ...OFF, places: false, business: false } },
  daten: { title: "Über die Daten", intro: () => "Woher jede Ebene kommt, wie aktuell sie ist und wo ihre Grenzen liegen.", on: {} },
};
let theme = null;
const ctx = () => window.__ctx;
function setCheck(id, v) {
  const el = $(id);
  if (!el || el.checked === v) return;
  el.checked = v;
  el.dispatchEvent(new Event("change", { bubbles: true }));
}
function setTheme(key, { expand = true } = {}) {
  const t = THEMES[key]; if (!t) return;
  theme = key;
  for (const b of document.querySelectorAll("#themes [data-theme]")) b.setAttribute("aria-current", b.dataset.theme === key ? "true" : "false");
  $("themeTitle").textContent = t.title;
  $("themeIntro").textContent = t.intro(ctx()?.meta || {});
  for (const s of document.querySelectorAll("#sunpanel .theme")) s.hidden = s.dataset.for !== key;
  if (window.__ready) {
    for (const [id, v] of Object.entries(t.on)) setCheck(id, v);
    if (t.now && ctx()?.weather && !ctx().weather.isLive()) $("now").click();
  }
  if (expand && $("sunpanel").classList.contains("collapsed")) $("menuToggle").click();
  closePops();
  const u = new URL(location.href); if (key === "umsehen") u.searchParams.delete("thema"); else u.searchParams.set("thema", key);
  history.replaceState(null, "", u);
  document.querySelector(`#themes [data-theme="${key}"]`)?.scrollIntoView({ block: "nearest", inline: "nearest" });
}
for (const b of document.querySelectorAll("#themes [data-theme]")) b.addEventListener("click", () => setTheme(b.dataset.theme));
document.addEventListener("click", (e) => {
  const c = e.target.closest("[data-click]"); if (c) $(c.dataset.click)?.click();
  const o = e.target.closest("[data-open]"); if (o && o.dataset.open === "start") { closePops(); openStart(); }
});

// ---------- Kleine Fenster: Uhrzeit, Ebenen, Hilfe ----------
const POPS = { timeBtn: "timePop", layersBtn: "layersPop", helpBtn: "helpPop" };
function closePops() { for (const [b, p] of Object.entries(POPS)) { $(p).hidden = true; $(b).setAttribute("aria-expanded", "false"); } }
for (const [b, p] of Object.entries(POPS)) {
  $(b).addEventListener("click", (e) => {
    e.stopPropagation();
    const open = $(p).hidden;
    closePops();
    if (!open) return;
    const pop = $(p), r = $(b).getBoundingClientRect(), w = Math.min(340, innerWidth - 20);
    pop.style.width = `${w}px`;
    pop.style.left = `${Math.max(10, Math.min(innerWidth - w - 10, r.right - w))}px`;
    pop.style.top = `${r.bottom + 8}px`;
    pop.hidden = false; $(b).setAttribute("aria-expanded", "true");
  });
}
document.addEventListener("pointerdown", (e) => { if (!e.target.closest(".pop, #topbar .tools")) closePops(); });
document.addEventListener("keydown", (e) => { if (e.key === "Escape") { closePops(); closeStart(); } });

// ---------- Chips: Uhrzeit, Wetter, Warnung ----------
const ICON = { "clear-day": "klar", "clear-night": "klar", "partly-cloudy-day": "leicht bewölkt", "partly-cloudy-night": "leicht bewölkt", cloudy: "bedeckt", fog: "Nebel", wind: "windig", rain: "Regen", sleet: "Schneeregen", snow: "Schnee", hail: "Hagel", thunderstorm: "Gewitter" };
function updateChips() {
  const c = ctx(), d = $("date").value;
  const live = !!(c?.weather && c.weather.isLive());
  $("timeChip").textContent = d ? `${d.slice(8, 10)}.${d.slice(5, 7)}. ${$("timeLabel").textContent}${live ? " · jetzt" : ""}` : "–";
  $("timeBtn").classList.toggle("hinted", !$("startHint").hidden);
  const w = c?.meta?.weatherNow;
  if (w) {
    $("wxChip").hidden = false;
    // ohne „jetzt“ eingestellt: Hinweis, dass der Chip das Wetter von heute zeigt, nicht das der eingestellten Zeit
    $("wxChip").innerHTML = `${live ? "" : "Heute "}${w.temperature != null ? nf(w.temperature, 1) + " °C" : ""} · ${ICON[w.icon] || w.condition || ""}${live && $("clouds").checked ? ' <b class="live">LIVE</b>' : ""}`;
  }
  const alerts = [...document.querySelectorAll("#alerts .alert b")].map((b) => b.textContent);
  $("alertChip").hidden = !alerts.length;
  if (alerts.length) {
    const m = alerts[0].match(/vor ([^(]+)/i), word = m ? m[1].trim().toLowerCase().replace(/^./, (x) => x.toUpperCase()) : "Warnung";
    $("alertChip").textContent = `⚠ ${word}${alerts.length > 1 ? ` +${alerts.length - 1}` : ""}`;
    $("alertChip").title = alerts.join(" · ");
  }
}
$("wxChip").addEventListener("click", () => setTheme("wetter"));
$("alertChip").addEventListener("click", () => setTheme("wetter"));
for (const ev of ["input", "change"]) { $("time").addEventListener(ev, updateChips); $("date").addEventListener(ev, updateChips); }
window.addEventListener("wetter", updateChips);
new MutationObserver(updateChips).observe($("alerts"), { childList: true, subtree: true, attributes: true });
setInterval(updateChips, 1000);   // „Jetzt“, Tagesablauf und Jahreszeiten ändern die Zeit ohne Ereignis

// ---------- Startkarte ----------
function openStart() { $("startCard").hidden = false; $("startGo").focus(); }
function closeStart() { if ($("startCard").hidden) return; $("startCard").hidden = true; store.set("sz3d_start", "1"); }
$("brand").addEventListener("click", openStart);
$("startGo").addEventListener("click", () => { closeStart(); setTheme("umsehen"); });
$("startTour").addEventListener("click", () => { closeStart(); startTour(); });
$("startCard").addEventListener("pointerdown", (e) => { if (e.target === $("startCard")) closeStart(); });
for (const b of document.querySelectorAll("#startCard [data-theme]")) b.addEventListener("click", () => { closeStart(); setTheme(b.dataset.theme); });

// ---------- Tour: freiwillig, nur auf Klick weiter ----------
let stops = [], stop = -1;
function buildStops() {
  const c = ctx(), orte = c.meta.places?.orte || [], by = Object.fromEntries(orte.map((o) => [o.id, o]));
  const list = [];
  for (const id of ["stadt", "cyriak", "synagoge", "stadtkirche", "burg", "laufen"]) {
    const o = by[id]; if (!o) continue;
    list.push({ title: o.name, sub: o.kurz, text: o.fakten[0], theme: "geschichte", go: () => { const y = c.terrainHeightAt(o.x, o.zz) ?? c.centerY; c.flyTo(new c.THREE.Vector3(o.x, y, o.zz), id === "stadt" || id === "laufen" ? 420 : 230, undefined, 2200); } });
  }
  list.push({ title: "Sonne auf den Dächern", text: "Die Farbe zeigt, wie lange die Sonne am 21. des eingestellten Monats auf den First scheint: Gelb viel, Violett wenig. Gerechnet mit dem Geländehorizont aus dem Höhenmodell, ohne Nachbarhäuser und Bäume.", theme: "klima",
    go: () => c.flyTo(new c.THREE.Vector3(0, c.centerY, 0), 520, new c.THREE.Vector3(-0.3, 0.75, 0.6), 2200) });
  list.push({ title: "Selbst entdecken", text: "Oben über die Themen geht es weiter: Arbeiten und Leben, Wetter jetzt mit Regenradar oder selbst fahren. Ein Klick auf ein Haus zeigt seine Daten.", theme: "umsehen", go: () => {} });
  return list;
}
function showStop(i) {
  stop = Math.max(0, Math.min(stops.length - 1, i));
  const s = stops[stop];
  setTheme(s.theme, { expand: false });
  s.go();
  $("tourStep").textContent = `Tour · ${stop + 1} von ${stops.length}`;
  $("tourTitle").textContent = s.title; $("tourSub").textContent = s.sub || ""; $("tourText").textContent = s.text;
  $("tourPrev").disabled = stop === 0;
  $("tourNext").textContent = stop === stops.length - 1 ? "Fertig" : "Weiter ›";
  $("tourDots").innerHTML = stops.map((_, k) => `<i class="${k === stop ? "on" : ""}"></i>`).join("");
}
function startTour() { if (!window.__ready) return; stops = buildStops(); $("tourCard").hidden = false; if (!$("sunpanel").classList.contains("collapsed") && innerWidth < 900) $("menuToggle").click(); showStop(0); }
function endTour() { $("tourCard").hidden = true; stop = -1; }
$("tourPrev").addEventListener("click", () => showStop(stop - 1));
$("tourNext").addEventListener("click", () => (stop >= stops.length - 1 ? endTour() : showStop(stop + 1)));
$("tourEnd").addEventListener("click", endTour);

// ---------- Fahrmodus: alles andere ausblenden (drive.js setzt body.driving) ----------
// ---------- Lage der Leiste (auf dem Handy zweizeilig) und Suche auf dem Handy ----------
function layout() { document.documentElement.style.setProperty("--top", `${Math.round($("topbar").getBoundingClientRect().bottom)}px`); }
window.addEventListener("resize", layout);
new ResizeObserver(layout).observe($("topbar"));
$("searchBtn").addEventListener("click", (e) => {
  e.stopPropagation();
  const on = !$("topbar").classList.contains("searching");
  $("topbar").classList.toggle("searching", on);
  if (on) $("search").focus();
});
$("search").addEventListener("blur", () => setTimeout(() => $("topbar").classList.remove("searching"), 150));

// ---------- Start ----------
setTheme(THEMES[params.get("thema")] ? params.get("thema") : "umsehen", { expand: innerWidth >= 900 });
const waitReady = setInterval(() => {
  if (!window.__ready || !ctx()) return;
  clearInterval(waitReady);
  // Wer per Link in ein Thema springt (?thema=…), sieht die Themenkarte offen, auch am Handy
  setTheme(theme, { expand: (innerWidth >= 900 && !$("sunpanel").classList.contains("collapsed")) || !!THEMES[params.get("thema")] });
  updateChips();
  const skip = params.get("intro") === "0" || params.get("start") === "0" || params.has("thema") || store.get("sz3d_start");
  if (!skip) openStart();
  window.__ui2 = { setTheme, startTour, endTour, openStart, closeStart };
}, 200);
