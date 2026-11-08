// Seite "Datenquellen und Grenzen": liest die Metadaten der aufbereiteten Ebenen und ergänzt sie um bekannte Lücken.
async function j(url) { const r = await fetch(url); if (!r.ok) throw new Error(url); return r.json(); }
const esc = (s) => String(s ?? "–").replace(/[&<>]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;" }[c]));
const de = (iso) => (iso && /^\d{4}-\d{2}-\d{2}/.test(iso) ? iso.slice(8, 10) + "." + iso.slice(5, 7) + "." + iso.slice(0, 4) : esc(iso));
function block(rows) {
  return `<dl class="src">${rows.map(([k, v]) => `<dt>${esc(k)}</dt><dd>${v}</dd>`).join("")}</dl>`;
}
(async () => {
  const [idx, b, g] = await Promise.all([j("data/terrain/index.json"), j("data/buildings.json"), j("data/gemeinde.geojson")]);
  const liz = idx.quelle.lizenz;
  const lb = idx.luftbild;
  const out = [];
  out.push(`<h2>Lizenz der Geobasisdaten</h2><p>Alle Geobasisdaten stammen vom Landesamt für Geoinformation und Landentwicklung Baden-Württemberg (LGL) über das <a href="${liz.portal}" target="_blank" rel="noopener">Open GeoData Portal</a>. Lizenz: <a href="${liz.url}" target="_blank" rel="noopener">${esc(liz.name)}</a>. Namensnennung: <b>${esc(liz.namensnennung)}</b>. Koordinaten ETRS89/UTM 32N, Höhen NHN (DHHN2016).</p>`);

  out.push(`<h2>Gelände</h2>` + block([
    ["Herkunft", esc(idx.quelle.titel)],
    ["Datenstand", `Laserscan-Befliegung ${idx.quelle.aktualitaet_laserscan.map(de).join(", ")} (je nach Teilkachel)`],
    ["Genauigkeit", `Höhe ±${idx.quelle.hoehengenauigkeit_m.join("/")} m laut LGL, Original 1 m Raster`],
    ["Darstellung", `${idx.anzahl_kacheln} Kacheln à ${idx.kachel_m} m, ${idx.res_siedlung_m} m Raster im Siedlungsbereich (${idx.anzahl_siedlung} Kacheln), ${idx.res_sonst_m} m sonst, Höhen als Mittel der 1-m-Zellen`],
    ["Bekannte Lücken", "Das Höhenmodell ist bis zu sechs Jahre älter als Gebäude und Luftbild. Neubaugebiete, Baugruben und Aufschüttungen nach 2019/2020 fehlen. Zwischen Kacheln unterschiedlicher Auflösung verdecken Schürzen die Übergänge."],
  ]));

  out.push(`<h2>Luftbild</h2>` + (lb ? block([
    ["Herkunft", esc(lb.quelle.titel)],
    ["Datenstand", `Bildflug ${lb.quelle.bildflugdatum.map(de).join(", ")}, Kamera ${esc(lb.quelle.kamera.join(", "))}`],
    ["Auflösung", `Original 20 cm, hier ${lb.aufloesungen_m.join(" / ")} m je nach Kachel, JPEG-komprimiert (${(lb.jpeg_bytes / 1e6).toFixed(1)} MB gesamt)`],
    ["Bekannte Lücken", "Das Luftbild zeigt den Zustand eines Sommertags 2025 mit Belaubung. Dächer im Luftbild und LoD2-Dächer stammen aus unterschiedlichen Verfahren und können leicht versetzt wirken. Schatten im Luftbild sind eingebrannt und ändern sich nicht mit der Uhrzeit."],
  ]) : "<p class='muted'>noch nicht aufbereitet</p>"));

  const li = b.quelle.lieferinformation || {};
  out.push(`<h2>Gebäude</h2>` + block([
    ["Herkunft", esc(b.quelle.titel)],
    ["Datenstand", `Auslesedatum ${esc(li["Auslesedatum"])}; Aktualität ${esc(li["Aktualität"])}; Grundrisse Stand ${b.grundriss_aktualitaet_von_bis ? b.grundriss_aktualitaet_von_bis.map(de).join(" bis ") : "–"}; Modelle erstellt ${b.erstellt_von_bis ? b.erstellt_von_bis.map(de).join(" bis ") : "–"}`],
    ["Umfang", `${b.anzahl} Gebäude, davon ${b.anzahl_in_gemeinde} in der Gemeinde Sulzburg, Rest im Randbereich von Nachbargemeinden`],
    ["Attribute", `Adresse, Gebäudefunktion und Dachform aus dem LoD2-Datensatz; Bezeichnungen aus den amtlichen AdV-Codelisten (${esc(b.quelle.codelisten.dachform.split(" (")[0])}, ${esc(b.quelle.codelisten.gebaeudefunktion.split(" (")[0])})`],
    ["Darstellung", `Standardisierte Dachformen (LoD2), keine Fenster. ${b.dachtextur && b.dachtextur.aktiv ? esc(b.dachtextur.hinweis) + ` Textur-Atlas mit ${b.dachtextur.aufloesung_m} m Bodenauflösung für ${b.dachtextur.gebaeude_mit_textur} Gebäude.` : "Dächer einfarbig."} Unter jeder Bodenfläche ein Sockel von ${b.sockel_m} m als Darstellungshilfe, damit am Hang kein Spalt zum gröberen Gelände entsteht. ${esc(b.sockel_hinweis)}`],
    ["Bekannte Lücken", "LoD2 enthält keine Gebäudenutzung jenseits der ALKIS-Funktion, keine Baujahre, keine Eigentümer. Dachaufbauten, Gauben und Anbauten unter der Erfassungsgrenze fehlen. Gebäude mit Höhe unter 1 m wurden laut LGL mit einem noch nicht aktualisierten DGM modelliert."],
  ]));

  const gq = g.quelle;
  out.push(`<h2>Gemeindegrenze</h2>` + block([
    ["Herkunft", esc(gq.titel)],
    ["Datenstand", esc(gq.aktualitaet)],
    ["Darstellung", `Gelbe Linie, 2,5 m über dem Gelände. Fläche ${g.features[0].properties.flaeche_km2} km². Das Modell zeigt die Gemeinde plus einen Rand von rund 250 m; außerhalb endet das Gelände.`],
  ]));

  out.push(`<h2>Wetter</h2>` + block([
    ["Herkunft", `Deutscher Wetterdienst (DWD), Open Data. Abruf im Browser über die freie Schnittstelle <a href="https://brightsky.dev" target="_blank" rel="noopener">Bright Sky</a>.`],
    ["Datenstand", "Live beim Laden der Seite; Stationsname, Entfernung und Zeitstempel stehen im Wetterfeld."],
    ["Bekannte Lücken", "Es gibt keine DWD-Station in Sulzburg. Angezeigt wird die nächstgelegene Station (meist Müllheim, rund 6 km westlich, 275 m Höhe). Im Tal und am Hang kann das Wetter abweichen. Der Tagesverlauf mischt Messung und Vorhersage. Fällt die Schnittstelle aus, zeigt die Seite das an und rechnet nichts hinzu."],
  ]));

  try {
    const sl = await j("data/sunlight.json");
    const dec = sl.tage.indexOf("2026-12-21");
    out.push(`<h2>Sonne auf dem Dach</h2>` + block([
      ["Herkunft", "Eigene Berechnung aus dem DGM1 (Geländehorizont) und der Sonnenbahn, vorberechnet für den 21. jedes Monats (<code>scripts/06_sunlight.py</code>)."],
      ["Methode", esc(sl.methode.horizont) + ". " + esc(sl.methode.sonnenbahn) + "."],
      ["Darstellung", `Klick-Info je Gebäude (erste und letzte Minute direkter Sonne am First, Dauer gegenüber dem möglichen Maximum) und Einfärbung der Dächer für den gewählten Monat. Am 21. Dezember sind ${sl.moegliche_minuten[dec]} Minuten möglich.`],
      ["Bekannte Lücken", `Nicht berücksichtigt: ${sl.methode.nicht_beruecksichtigt.join(", ")}. Der Horizont reicht im Median ${Math.round(sl.methode.reichweite_median_m)} m weit, am Rand des Modells weniger (mindestens ${Math.round(sl.methode.reichweite_min_m)} m); weiter entfernte Berge fehlen. Der Wert gilt für den First, nicht für einzelne Dachflächen.`],
    ]));
  } catch (e) { /* ohne sunlight.json keine Angabe */ }

  try {
    const tb = await j("data/trees.json");
    out.push(`<h2>Bäume</h2>` + block([
      ["Herkunft", `${esc(tb.quelle.titel)}, Oberfläche vom Bildflug ${tb.quelle.oberflaeche_aktualitaet.map(de).join(", ")}, Geländebezug DGM ${tb.quelle.dgm_aktualitaet.map(de).join(", ")}.`],
      ["Methode", `Je Block von ${tb.methode.block_m} m die höchste Zelle außerhalb der Gebäude (Puffer ${tb.methode.gebaeudepuffer_m} m) mit ${tb.methode.min_hoehe_m} bis ${tb.methode.max_hoehe_m} m Höhe über Grund, nur im Umkreis von ${tb.methode.umkreis_um_gebaeude_m} m um Gebäude. ${tb.anzahl.toLocaleString("de-DE")} Bäume, Höhe im Median ${tb.hoehe_median_m.toFixed(1)} m.`],
      ["Darstellung", esc(tb.methode.hinweis)],
      ["Bekannte Lücken", "Hecken und Sträucher ab 3 m erscheinen als kleine Bäume. Im geschlossenen Wald steht je Block nur ein Baum, die Dichte ist dort untertrieben. Außerhalb des Umkreises um Gebäude gibt es keine Bäume, dort zeigt nur das Luftbild den Wald. Baumarten sind nicht bekannt."],
    ]));
  } catch (e) { /* ohne trees.json keine Angabe */ }

  try {
    const tr = await j("data/transit.json");
    const routes = Object.values(tr.linien).map((r) => r.name).sort().join(", ");
    out.push(`<h2>Bus und Bahn</h2>` + block([
      ["Herkunft", `${esc(tr.quelle.titel)}. <a href="${tr.quelle.datensatz}" target="_blank" rel="noopener">Datensatz</a>, Lizenz <a href="${tr.quelle.lizenz.url}" target="_blank" rel="noopener">${esc(tr.quelle.lizenz.name)}</a>, Namensnennung „${esc(tr.quelle.lizenz.namensnennung)}“.`],
      ["Datenstand", `Fahrplanversion ${esc(tr.quelle.feed_info.feed_version)} (gültig ${de(String(tr.quelle.feed_info.feed_start_date).replace(/(\d{4})(\d{2})(\d{2})/, "$1-$2-$3"))} bis ${de(String(tr.quelle.feed_info.feed_end_date).replace(/(\d{4})(\d{2})(\d{2})/, "$1-$2-$3"))}); exportiert für ${tr.zeitraum.von} bis ${tr.zeitraum.bis}.`],
      ["Umfang", `${tr.haltestellen.length} Haltesteige im Umgriff, Linien ${esc(routes)}.`],
      ["Busse auf der Karte", tr.verlauf_quelle ? `Fahrzeuge bewegen sich nach Soll-Fahrplan gleichmäßig zwischen den Halten entlang des Linienverlaufs. Linienverläufe aus: ${esc(tr.verlauf_quelle.titel)}, Lizenz <a href="${tr.verlauf_quelle.lizenz.url}" target="_blank" rel="noopener">${esc(tr.verlauf_quelle.lizenz.name)}</a>, Stand ${esc(tr.verlauf_quelle.feed_info.feed_version || "–")}. ${esc(tr.verlauf_quelle.hinweis)} Fahrzeugform ist Darstellung.` : "keine"],
      ["Bekannte Lücken", "Nur Soll-Fahrplan, keine Echtzeit, keine Ausfälle oder Verspätungen. Der Datensatz wird vom Land zweimal im Monat aktualisiert, die Kopie hier nur, wenn die Pipeline neu läuft. Bahnhalte außerhalb des Umgriffs (Heitersheim, Müllheim) sind nicht enthalten."],
    ]));
  } catch (e) { /* ohne transit.json keine Angabe */ }

  try {
    const pl = await j("data/places.json");
    out.push(`<h2>Orte mit Geschichte</h2>` + block([
      ["Herkunft", `Kuratierte Auswahl von ${pl.orte.length} Orten. Fakten sinngemäß aus den verlinkten Quellen, abgerufen am ${de(pl.abgerufen_am)}; Wikipedia-Inhalte stehen unter CC BY-SA 4.0. Quellen je Ort in der Info-Karte.`],
      ["Lage", "Koordinaten aus den Wikipedia-Artikeln, mit dem LoD2-Datensatz abgeglichen (<code>scripts/09_places.py</code>): St. Cyriak liegt 13 m neben dem LoD2-Gebäude mit Funktion Kirche, die Synagoge 8 m neben Gustav-Weil-Straße 18 (Adresse laut bpb)."],
      ["Bekannte Lücken", "Die Auswahl ist ein Vorschlag und unvollständig. Der Stand des Landesbergbaumuseums nach 2023 ist nicht geprüft. Das LoD2 führt die ehemalige Synagoge als Wohnhaus. Für die Burg gibt es kein 3D-Modell, nur die Lage."],
    ]));
  } catch (e) { /* ohne places.json keine Angabe */ }

  try {
    const cl = await j("data/climate.json");
    out.push(`<h2>Klima und Fortschreibung 2040</h2>` + block([
      ["Herkunft", `${esc(cl.quelle.titel)}. ${cl.quelle.urls.map((u) => `<a href="${u}" target="_blank" rel="noopener">${esc(u.replace("https://", ""))}</a>`).join(", ")}. ${esc(cl.quelle.nutzung)}.`],
      ["Datenstand", `30-jährige Mittel 1961–1990 und 1991–2020 (1 km); Gebietsmittel Baden-Württemberg ${cl.bw_reihen.hot_days[0][0]} bis ${cl.bw_reihen.hot_days[cl.bw_reihen.hot_days.length - 1][0]}, ${esc(cl.quelle.gebietsmittel_erstellt)}.`],
      ["Szenario", `<span class="ph">Szenario</span> ${esc(cl.fortschreibung)} Am Marktplatz ergibt das rund ${Math.round(cl.marktplatz.hot_days[2])} Heiße Tage im Jahr 2040, nach ${cl.marktplatz.hot_days[0]} (1961–1990) und ${cl.marktplatz.hot_days[1]} (1991–2020).`],
      ["Projektionen", `${esc(cl.projektion_hinweis.text)} ${cl.projektion_hinweis.quellen.map((x) => `<a href="${esc(x.url)}" target="_blank" rel="noopener">${esc(x.titel)}</a>`).join(" · ")}. Ortsgenaue Projektionsdaten für Sulzburg wurden nicht als offener Download gefunden.`],
      ["Bekannte Lücken", "Das 1-km-Raster glättet das Tal: Ortskern und Hänge teilen sich Zellen. Frosttage zeigen im Raster am Marktplatz kaum Veränderung, im Landesmittel sinken sie. Die Fortschreibung unterstellt einen linearen Trend und ist keine Vorhersage."],
    ]));
  } catch (e) { /* ohne climate.json keine Angabe */ }

  try {
    const so = await j("data/solar.json");
    const r = so.ergebnis_gemeinde, b = so.bestand;
    out.push(`<h2>PV auf allen geeigneten Dächern (Szenario)</h2>` + block([
      ["Ergebnis", `<span class="ph">Szenario</span> ${r.leistung_kwp.toLocaleString("de-DE")} kWp auf ${r.geeignete_dachflaeche_m2.toLocaleString("de-DE")} m² geeigneter Dachfläche, rund ${r.ertrag_mwh_jahr.toLocaleString("de-DE")} MWh pro Jahr; Geländehorizont kostet ${r.verlust_durch_gelaendehorizont_prozent} %.`],
      ["Annahmen", `<ul>${Object.values(so.annahmen).map((a) => `<li>${esc(a.grund)}</li>`).join("")}</ul>`],
      ["Rechenweg", `${esc(so.methode.wetter)}. ${esc(so.methode.modell)}. ${esc(so.methode.verschattung)} Kalibriert gegen den PVGIS-Rechner (Faktor ${so.methode.kalibrierfaktor}); Abweichung bei anderen Ausrichtungen ${so.methode.pruefung_gegen_pvgis.map((p) => `${p.neigung}°/${p.ausrichtung}°: ${p.abweichung_prozent > 0 ? "+" : ""}${p.abweichung_prozent} %`).join(", ")}. Quelle: ${esc(so.quelle.pvgis)}.`],
      ["Bestand heute", b ? `${b.einheiten_in_betrieb} Photovoltaik-Einheiten in Betrieb mit ${b.bruttoleistung_kw.toLocaleString("de-DE")} kW Bruttoleistung. Quelle: ${esc(so.bestand_quelle.titel)}, abgerufen ${de(so.bestand_quelle.abgerufen_am)}, ${esc(so.bestand_quelle.lizenz ? so.bestand_quelle.lizenz.namensnennung : "Bundesnetzagentur")}. ${esc(so.bestand_quelle.hinweis)}` : "nicht abrufbar"],
      ["Bekannte Lücken", "Keine Prüfung von Statik, Denkmalschutz, Dachzustand oder Netzanschluss. Nachbargebäude und Bäume verschatten im Modell nicht. Der Horizont gilt für den First, nicht für jede Dachfläche. Ost- und Westdächer liegen im Modell einige Prozent über PVGIS, das Ergebnis ist eher eine obere Grenze. Der Energieatlas BW wurde nicht verwendet."],
    ]));
  } catch (e) { /* ohne solar.json keine Angabe */ }

  out.push(`<h2>Wetterwarnungen</h2>` + block([
    ["Herkunft", "Amtliche Warnungen des Deutschen Wetterdienstes für die Warnzelle der Stadt Sulzburg, live über Bright Sky."],
    ["Darstellung", "Banner mit Überschrift, Stufe, Gültigkeit und aufklappbarer Beschreibung. Ohne Warnung bleibt das Feld unsichtbar."],
    ["Bekannte Lücken", "Nur Warnungen, keine Vorwarninformationen. Fällt die Schnittstelle aus, wird das angezeigt."],
  ]));

  out.push(`<h2>Sonnenstand</h2>` + block([
    ["Herkunft", "Eigene Berechnung nach dem NOAA-Algorithmus (Jean Meeus) in <code>sun.js</code>, für den Marktplatz. Zeitzone Europe/Berlin mit Sommerzeit."],
    ["Prüfung", "Gegen die Python-Bibliothek astral: Auf- und Untergang weichen unter einer Minute ab. Beide nutzen dieselben Formeln, der Test prüft die Umsetzung, nicht die Methode."],
    ["Bekannte Lücken", "Schatten werden nur in einem Umkreis von 700 m um den Blickpunkt berechnet (Schattenkarte 2048 px). Weiter entfernte Berge werfen im Modell keinen Schatten ins Tal. Horizontabschattung durch Gelände außerhalb des Modells fehlt."],
  ]));

  out.push(`<h2>Was diese Seite nicht ist</h2><ul>
    <li>Keine amtliche Karte und kein Ersatz für Liegenschaftskataster, Bebauungspläne oder Flurkarten.</li>
    <li>Keine Aussage über Zustand, Sicherheit, Wert oder Nutzung einzelner Gebäude.</li>
    <li>Keine personenbezogenen Daten: Adressen stammen aus dem offenen LoD2-Datensatz, Eigentümer oder Bewohner sind nicht enthalten.</li>
    <li>Kein offizielles Angebot der Stadt Sulzburg oder eines Unternehmens; kein Wappen, kein Logo.</li>
  </ul>`);
  out.push(`<h2>Weitere Bausteine</h2>` + block([
    ["Bäume", "Normalisiertes Oberflächenmodell nDOM1 des LGL (dl-de/by-2-0); Lage und Höhe echt, Form generisch."],
    ["Dächer aus Luftbild", "DOP20 des LGL senkrecht auf die LoD2-Dachflächen projiziert; im Luftbild eingebrannte Schatten bleiben sichtbar."],
    ["Adresssuche", "Durchsucht die Adressen im LoD2-Datensatz, keine externe Abfrage."],
    ["Einstiegsfahrt", "Reine Kameraführung; bei der Systemeinstellung „Bewegung reduzieren“ entfällt sie."],
  ]));
  out.push(`<p class="muted">Technik: three.js (MIT), statische Dateien ohne Server-Logik, keine Cookies, keine Zähler. Quellcode und Datenpipeline: <a href="https://github.com/FlorianDavidZeiser/sulzburg-3d" target="_blank" rel="noopener">github.com/FlorianDavidZeiser/sulzburg-3d</a>. Stand der Aufbereitung: ${de(idx.quelle.verarbeitet_am)}.</p>`);
  document.getElementById("content").innerHTML = out.join("\n");
})().catch((e) => { document.getElementById("content").textContent = "Fehler beim Laden der Metadaten: " + e.message; });
