# Validierung (automatisch erzeugt)

Erzeugt am 2026-11-09T07:17:59+00:00 durch `scripts/05_validate.py`.

## 1. Gebäude gegen Gelände

Jeder Eckpunkt der LoD2-Bodenflächen (GroundSurface) wird mit der Geländehöhe an derselben Lage verglichen, einmal gegen das DGM1 in 1 m (Quelle) und einmal gegen das im Browser dargestellte Gelände (5 m im Siedlungsbereich, 20 m sonst). Positive Werte: Gebäudeboden über dem Gelände.

- Geprüft: **2366 Gebäude, 18786 Bodenpunkte**
- Gegen DGM1: Mittel -0.67 m, Median -0.39 m, innerhalb ±0,5 m **54 %**, innerhalb ±1 m **72 %**, Extreme -7.1 / +13.5 m
- Gegen dargestelltes Gelände: Mittel -0.67 m, innerhalb ±1 m **73 %**, Punkte höher als der Sockel (2.0 m) reicht: **0.7 %**
- Gebäude, die komplett sichtbar schweben (alle Bodenpunkte höher als der Sockel): **0**; Gebäude mit einzelnen Ecken über dem Sockel: **8**

Gebäude mit einzelnen Ecken über dem Sockel (größte zuerst):

- Nr. 548, Ernst-Leitz-Weg 1, Sulzburg (Kirche): Ecke bis +13.47 m über dargestelltem Gelände, gegen DGM1 Median -0.51 m, Bauteile 4
- Nr. 1777, Weinstraße 4, Sulzburg (Kirche): Ecke bis +13.35 m über dargestelltem Gelände, gegen DGM1 Median -0.41 m, Bauteile 3
- Nr. 0, Hauptstraße 56, Sulzburg (Museum): Ecke bis +13.29 m über dargestelltem Gelände, gegen DGM1 Median -1.31 m, Bauteile 2
- Nr. 1515, ohne Adresse (Brücke): Ecke bis +8.35 m über dargestelltem Gelände, gegen DGM1 Median +5.04 m, Bauteile 0
- Nr. 1510, ohne Adresse (Brücke): Ecke bis +5.28 m über dargestelltem Gelände, gegen DGM1 Median +2.04 m, Bauteile 0
- Nr. 1487, ohne Adresse (Brücke): Ecke bis +3.44 m über dargestelltem Gelände, gegen DGM1 Median +1.12 m, Bauteile 0
- Nr. 184, ohne Adresse (Brücke): Ecke bis +2.38 m über dargestelltem Gelände, gegen DGM1 Median +2.72 m, Bauteile 0
- Nr. 580, ohne Adresse (Brücke): Ecke bis +2.28 m über dargestelltem Gelände, gegen DGM1 Median +2.45 m, Bauteile 0

Einordnung: Das LGL setzt die LoD2-Bodenfläche am tiefsten Geländepunkt des Grundrisses an, am Hang stecken die Wände daher im Gelände (negative Werte, gewollt). Positive Werte gegen das DGM1 entstehen bei Bauteilen, die auf anderen Bauteilen sitzen (Türme, Aufbauten), und bei Geländeänderungen nach der Laserscan-Befliegung. Positive Werte gegen das dargestellte Gelände entstehen zusätzlich durch die Mittelung auf 5 m beziehungsweise 20 m; dafür gibt es den Sockel.

## 2. Stichprobe Adressen gegen OpenStreetMap

20 zufällig gewählte Wohngebäude mit Hausnummer (fester Zufallsstartwert) wurden über Nominatim in OpenStreetMap gesucht. Verglichen wird der Abstand zwischen LoD2-Grundrissmittel und OSM-Koordinate. Quelle: © OpenStreetMap-Mitwirkende, ODbL.

- OSM-Treffer mit Hausnummer: **18 von 20**, Abstand Median **2 m**, größter 7 m, 18 innerhalb 25 m

| Nr. | Adresse (LoD2) | OSM-Treffer | Abstand | Hausnummer gefunden |
|---|---|---|---|---|
| 894 | Bleigrubenweg 5 | building Nr. 5 | 3 m | ja |
| 1224 | Neubergweg 31 | building Nr. 31 | 1 m | ja |
| 628 | Bannholzweg 5 | building Nr. 5 | 3 m | ja |
| 819 | Ernst-Leitz-Weg 4 a | building Nr. 4a | 0 m | ja |
| 1043 | Am Schlittenbuck 10 | building Nr. 10 | 1 m | ja |
| 1553 | Wüstgasse 1 | building Nr. 1 | 2 m | ja |
| 43 | Hauptstraße 71 | place Nr. 71 | 7 m | ja |
| 1537 | Wüstgasse 6 | building Nr. 6 | 3 m | ja |
| 2183 | Hohlenmatt 1 | building Nr. 1 | 2 m | ja |
| 1952 | Hohlenbergstraße 3 | building Nr. 3 | 1 m | ja |
| 1148 | Neubergweg 23 | place Nr. 23 | 2 m | ja |
| 237 | Im Brühl 18 | building Nr. 18 | 3 m | ja |
| 1146 | Salzmatten 5 | building Nr. 5 | 4 m | ja |
| 2033 | In den Bachteln 2 | building Nr. 2 | 0 m | ja |
| 306 | Kirchbachweg 8 | building Nr. 8 | 1 m | ja |
| 1 | Hauptstraße 61 | building Nr. 61 | 1 m | ja |
| 1021 | Im Eichhölzle 7 | building Nr. 7 | 6 m | ja |
| 815 | Käppelematten 12 | residential | 88 m | nur Straße/Ort |
| 1948 | Am Rebberg 5 | building Nr. 5 | 3 m | ja |
| 1092 | Im Wachental 1 a | residential | 13 m | nur Straße/Ort |

Einordnung: In OSM ist die Adresse oft am Gebäudeumriss oder als Punkt erfasst; Abstände bis rund 25 m sind bei größeren Grundstücken normal. Fehlt die Hausnummer in OSM, liefert Nominatim nur die Straße, dann ist der Abstand nicht aussagekräftig. Die Stichprobe prüft die Lage der amtlichen Adresse, nicht die Geometrie.

## 3. Sonnenstand gegen Referenz

`web/sun.js` (NOAA) gegen die Python-Bibliothek `astral`, Zeiten UTC. Beide nutzen dieselben Formeln; der Test prüft die Umsetzung.

| Datum | Aufgang sun.js | Aufgang astral | Diff | Untergang sun.js | Untergang astral | Diff |
|---|---|---|---|---|---|---|
| 2026-03-20 | 05:31:52 | 05:32:38 | -0.8 min | 17:41:20 | 17:41:27 | -0.1 min |
| 2026-06-21 | 03:30:21 | 03:30:36 | -0.3 min | 19:31:37 | 19:31:21 | +0.3 min |
| 2026-09-22 | 05:16:02 | 05:15:56 | +0.1 min | 17:27:47 | 17:27:00 | +0.8 min |
| 2026-12-21 | 07:15:32 | 07:15:45 | -0.2 min | 15:38:55 | 15:38:41 | +0.2 min |
| 2026-11-09 | 06:26:02 | 06:26:00 | +0.0 min | 15:59:49 | 15:59:17 | +0.5 min |

Größte Abweichung: **0.8 min**.

## 4. Ladevolumen

GitHub Pages liefert die Dateien gzip-komprimiert aus (geprüft am 08.11.2026 für GLB, JSON und BIN). JPEG-Bilder sind bereits komprimiert.

| Bestandteil | Dateien | MB auf der Platte | MB übertragen (gzip) |
|---|---|---|---|
| Gelände (Höhen + Index) | 2 | 1.2 | 0.7 |
| Luftbild (JPEG-Kacheln) | 147 | 9.0 | 9.0 |
| Gebäude (GLB + JSON + Dachtextur) | 3 | 10.6 | 5.0 |
| Bäume | 2 | 0.8 | 0.5 |
| Sonne, Klima, PV, Orte, Fahrplan, Betriebe, Autos | 7 | 0.5 | 0.1 |
| Sonstige Daten | 2 | 0.1 | 0.0 |
| three.js + Anwendung | 16 | 2.5 | 0.5 |
| **Gesamt** | | **24.7** | **15.8** |

Übertragen bei 20 Mbit/s rund 6 s, bei 50 Mbit/s rund 3 s. Gelände und Gebäude kommen zuerst, die Luftbildkacheln laden danach (Siedlung zuerst); bedienbar ist die Ansicht vorher.

## 5. Ebenen aus Phase 2 und 3

**Orte mit Geschichte** (6 Orte, Quellen abgerufen 2026-11-08). Lage gegen LoD2:

- stadt: nächstes Gebäude 30 m: Museum, Hauptstraße 56, Sulzburg
- cyriak: nächstes Gebäude 13 m: Kirche, Klosterplatz, Sulzburg -> verknüpft
- synagoge: nächstes Gebäude 8 m: Wohnhaus, Gustav-Weil-Straße 18, Sulzburg -> verknüpft
- stadtkirche: aus LoD2-Adresse Hauptstraße 56, Sulzburg (Museum)
- burg: nächstes Gebäude 85 m: Wochenendhaus, Im Rammerspach, Sulzburg
- laufen: nächstes Gebäude 13 m: Wohnhaus, Weinstraße 12, Sulzburg

**PV-Szenario.** Modell gegen den PVGIS-Rechner (ohne Horizont, kWh je kWp und Jahr):

| Neigung | Ausrichtung | Modell | PVGIS | Abweichung |
|---|---|---|---|---|
| 35° | 0° | 1088.1 | 1088.14 | +0.0 % |
| 15° | 0° | 1060.7 | 1024.02 | +3.6 % |
| 35° | -90° | 930.0 | 875.25 | +6.3 % |
| 35° | 90° | 899.3 | 856.94 | +4.9 % |

Ergebnis: 17,115 kWp, 17,189 MWh pro Jahr, spezifischer Ertrag Median 1033 kWh/kWp (5. bis 95. Perzentil 914 bis 1070). Bestand laut MaStR: 315 Einheiten, 3067.0 kW, das sind 18 % des Szenarios. Plausibilität: Ein spezifischer Ertrag um 1.000 kWh/kWp entspricht der PVGIS-Größenordnung für den Oberrhein.

**Klima.** 42 1-km-Zellen im Umgriff. Heiße Tage am Marktplatz 7 (1961–1990), 14 (1991–2020), Fortschreibung 2040 rund 22. Gegenprobe Landesmittel BW aus der Jahresreihe: 4.7 und 10.5; Sulzburg liegt am Oberrhein erwartungsgemäß darüber.

**Arbeiten und Wirtschaft.** 29 Betriebe aus OpenStreetMap (Stand 2026-11-09T05:06:52Z), davon 20 über die Adresse einem LoD2-Gebäude zugeordnet, 3 mit Solaranlagen laut Marktstammdatenregister. Zuordnung je Betrieb:

- Alte Sägemühle: gast/Campingplatz, Lage aus OSM
- Camping Sulzbachtal: gast/Campingplatz, LoD2 Sonnmatt 4, Sulzburg (71 m)
- Dormitorium - Hotel am Klostergarten: gast/Gästehaus, LoD2 Klosterplatz 2, Sulzburg (4 m)
- Ferienwohnung in den Bachteln: gast/Ferienwohnung, Lage aus OSM
- Gaststätte Altes Stadttor: gast/Restaurant, LoD2 Hauptstraße 35, Sulzburg (1 m)
- Gutshof Güntert: gast/Ferienhaus, LoD2 Schlossgasse 4, Sulzburg (22 m)
- Haus Sayer: gast/Ferienwohnung, LoD2 Bad-Krozinger-Straße 2, Sulzburg (6 m)
- Hirschen: gast/Restaurant und Hotel, LoD2 Hauptstraße 69, Sulzburg (4 m)
- La Maison Eric: gast/Restaurant, Lage aus OSM
- Landgasthof Rebstock: gast/Hotel und Restaurant, LoD2 Hauptstraße 77, Sulzburg (6 m)
- Lilien-Café: gast/Café, LoD2 Weinstraße 2, Sulzburg (49 m)
- Rebea: gast/Restaurant, LoD2 Weinstraße 38, Sulzburg (4 m)
- Torstüble: gast/Restaurant, LoD2 Hauptstraße 41, Sulzburg (7 m)
- Waldhotel Bad Sulzburg: gast/Hotel und Restaurant, LoD2 Badstraße 67, Sulzburg (27 m)
- Weinbrunnen Sulzburg: gast/Café, Lage aus OSM
- Zum wilden Mann: gast/Restaurant, Lage aus OSM
- BENZ Metallbau Schlosserei Landtechnik: gewerbe/Metallbau und Landtechnik, Lage aus OSM, Solar 26.1 kW
- Bäckerei Ruf: gewerbe/Bäckerei, Lage aus OSM
- Da Massimiliano: gewerbe/Feinkost, Lage aus OSM
- Die Brillenfabrik: gewerbe/Optiker, LoD2 Hauptstraße 57, Sulzburg (3 m)
- Fahrrad Glaser: gewerbe/Fahrradgeschäft, LoD2 Im Brühl 10, Sulzburg (9 m)
- Hausärztliche Gemeinschaftspraxis: gewerbe/Arztpraxis, LoD2 Hauptstraße 64, Sulzburg (6 m)
- Hekatron: gewerbe/Anlagentechnischer Brandschutz, Hersteller, LoD2 Brühlmatten 9, Sulzburg (78 m)
- Jonny B. GmbH: gewerbe/Möbel, LoD2 Doretmatt 3, Sulzburg (2 m), Solar 91.5 kW
- Katharina-Barbara: gewerbe/Apotheke, LoD2 Hauptstraße 48, Sulzburg (3 m)
- Brennerei Eichin: wein/Brennerei, Lage aus OSM
- Staudengärtnerei Gräfin von Zeppelin OHG: wein/Staudengärtnerei, LoD2 Weinstraße 2, Sulzburg (57 m)
- Weingut Rainer Schlumberger: wein/Weingut, LoD2 Obere Holzgasse 4, Sulzburg (14 m), Solar 24.2 kW
- Winzergenossenschaft Laufen: wein/Winzergenossenschaft, LoD2 Weinstraße 48, Sulzburg (27 m)

**Parkende Autos.** 308 Autos aus 1224 Kandidatenflecken. Sichtprüfung von 48 zufälligen Treffern (`docs/autos_stichprobe.jpg`): etwa 8 von 10 liegen auf einem Auto. Vollständigkeit am Marktplatz: rund 18 von gut 40 sichtbaren Autos. Momentaufnahme vom Bildflug 25.08.2025.

**Busse.** 11 Haltesteige, 154 Fahrten mit Linienverlauf zugeordnet (12 Verlaufsabschnitte). Die Zuordnung prüft Linie und Folge der Haltestellen; eine Prüfung gegen die Fahrplanauskunft des Verbunds steht aus.
