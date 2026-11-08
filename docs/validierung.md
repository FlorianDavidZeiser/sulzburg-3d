# Validierung Phase 1 (automatisch erzeugt)

Erzeugt am 2026-11-08T20:27:03+00:00 durch `scripts/05_validate.py`.

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
| 2026-11-08 | 06:24:31 | 06:24:29 | +0.0 min | 16:01:11 | 16:00:39 | +0.5 min |

Größte Abweichung: **0.8 min**.

## 4. Ladevolumen

| Bestandteil | Dateien | MB |
|---|---|---|
| Gelände (Höhen + Index) | 2 | 1.2 |
| Luftbild (JPEG-Kacheln) | 147 | 9.0 |
| Gebäude (GLB + JSON) | 2 | 6.6 |
| Sonstige Daten | 2 | 0.0 |
| three.js + Anwendung | 11 | 2.4 |
| **Gesamt** | | **19.3** |

Bei 20 Mbit/s entspricht das rund 8 s, bei 50 Mbit/s rund 3 s. Gelände und Gebäude kommen zuerst, Luftbildkacheln laden nach (Siedlung zuerst).
