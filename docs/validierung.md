# Validierung Phase 0 (automatisch erzeugt)

Erzeugt am 2026-11-08T19:46:59+00:00 durch `scripts/05_validate.py`.

## 1. Gebäude gegen Gelände

Verglichen wird die Höhe jedes Eckpunkts der LoD2-Bodenflächen (GroundSurface) mit der bilinear interpolierten DGM1-Höhe an derselben Lage. Positive Werte: Gebäudeboden liegt über dem Gelände.

- Bodenpunkte geprüft: **369** an 50 Gebäuden
- Mittlere Abweichung: **-0.41 m**, Median -0.34 m, mittlerer Betrag 0.69 m
- Innerhalb ±0,5 m: **58 %**, innerhalb ±1,0 m: **83 %**, größter Betrag 13.26 m
- Gebäude mit Median über 1 m oder weniger als der Hälfte der Punkte innerhalb ±0,5 m: **13**

Auffällige Gebäude:

- Nr. 0, Hauptstraße 56, Sulzburg (Museum): Median -1.31 m, Spanne -1.43 bis +13.26 m, 13 % innerhalb ±0,5 m, Bauteile: 2
- Nr. 2, Hauptstraße 62, Sulzburg (Geschäftsgebäude): Median -1.47 m, Spanne -2.38 bis +0.01 m, 8 % innerhalb ±0,5 m, Bauteile: 9
- Nr. 4, Hauptstraße 60, Sulzburg (Rathaus): Median -0.63 m, Spanne -0.84 bis -0.01 m, 20 % innerhalb ±0,5 m, Bauteile: 0
- Nr. 8, Hauptstraße 57, Sulzburg (Wohn- und Geschäftsgebäude): Median -0.56 m, Spanne -0.67 bis +0.02 m, 38 % innerhalb ±0,5 m, Bauteile: 0
- Nr. 9, Alte Postgasse 2, Sulzburg (Wohnhaus): Median -0.90 m, Spanne -1.52 bis +0.01 m, 33 % innerhalb ±0,5 m, Bauteile: 0
- Nr. 15, Hauptstraße 52, 54, Sulzburg (Wohn- und Betriebsgebäude): Median -0.95 m, Spanne -1.79 bis +0.04 m, 25 % innerhalb ±0,5 m, Bauteile: 2
- Nr. 18, Hauptstraße 58, Sulzburg (Wohnhaus): Median -1.27 m, Spanne -2.14 bis -0.04 m, 12 % innerhalb ±0,5 m, Bauteile: 0
- Nr. 22, Hauptstraße, Sulzburg (Schuppen): Median -0.88 m, Spanne -1.61 bis -0.01 m, 40 % innerhalb ±0,5 m, Bauteile: 0
- Nr. 27, Hauptstraße, Sulzburg (Schuppen): Median -2.23 m, Spanne -3.03 bis +0.02 m, 14 % innerhalb ±0,5 m, Bauteile: 0
- Nr. 32, Hauptstraße, Sulzburg (Schuppen): Median -0.66 m, Spanne -0.71 bis +0.01 m, 40 % innerhalb ±0,5 m, Bauteile: 0
- Nr. 39, Hauptstraße 48, Sulzburg (Wohn- und Geschäftsgebäude): Median -0.98 m, Spanne -1.56 bis +0.00 m, 33 % innerhalb ±0,5 m, Bauteile: 0
- Nr. 42, Hauptstraße, Sulzburg (Betriebsgebäude): Median -0.74 m, Spanne -0.83 bis -0.06 m, 10 % innerhalb ±0,5 m, Bauteile: 2
- Nr. 47, Hauptstraße, Sulzburg (Betriebsgebäude): Median -0.52 m, Spanne -0.88 bis +0.00 m, 44 % innerhalb ±0,5 m, Bauteile: 0

Einordnung: Das LoD2-Modell wurde vom LGL aus Grundrissen, Laserscan und dem jeweils aktuellen DGM1 abgeleitet. Das hier genutzte DGM1 stammt vom Laserscan 2019; bei Bauteilen, die auf anderen Bauteilen sitzen (z. B. Türme, Dachaufbauten), liegt die Bodenfläche des Bauteils bewusst über dem Gelände. Große Spannen innerhalb eines Gebäudes sind daher nicht automatisch Fehler.

| Nr. | Adresse | Punkte | Median | Min | Max | ±0,5 m | Bauteile |
|---|---|---|---|---|---|---|---|
| 0 | Hauptstraße 56, Sulzburg | 15 | -1.31 | -1.43 | +13.26 | 13 % | 2 |
| 1 | Hauptstraße 61, Sulzburg | 4 | -0.49 | -0.78 | -0.02 | 50 % | 0 |
| 2 | Hauptstraße 62, Sulzburg | 49 | -1.47 | -2.38 | +0.01 | 8 % | 9 |
| 3 | Hauptstraße 65, Sulzburg | 5 | -0.22 | -0.37 | +0.01 | 100 % | 0 |
| 4 | Hauptstraße 60, Sulzburg | 10 | -0.63 | -0.84 | -0.01 | 20 % | 0 |
| 5 | Hauptstraße 59, Sulzburg | 9 | -0.22 | -0.33 | -0.02 | 100 % | 0 |
| 6 | Hauptstraße 63, Sulzburg | 6 | -0.45 | -0.49 | -0.02 | 100 % | 0 |
| 7 | Sulzburg | 4 | -0.02 | -0.04 | -0.00 | 100 % | 0 |
| 8 | Hauptstraße 57, Sulzburg | 8 | -0.56 | -0.67 | +0.02 | 38 % | 0 |
| 9 | Alte Postgasse 2, Sulzburg | 9 | -0.90 | -1.52 | +0.01 | 33 % | 0 |
| 10 | Hauptstraße 67, Sulzburg | 6 | -0.21 | -0.50 | -0.00 | 83 % | 0 |
| 11 | Hauptstraße 64, Sulzburg | 5 | -0.39 | -0.99 | -0.00 | 60 % | 0 |
| 12 | Hauptstraße, Sulzburg | 4 | -0.14 | -0.18 | +0.04 | 100 % | 0 |
| 13 | Hauptstraße, Sulzburg | 4 | -0.31 | -0.36 | +0.34 | 100 % | 0 |
| 14 | Hauptstraße, Sulzburg | 4 | -0.04 | -0.09 | -0.03 | 100 % | 0 |
| 15 | Hauptstraße 52, 54, Sulzburg | 12 | -0.95 | -1.79 | +0.04 | 25 % | 2 |
| 16 | Hauptstraße, Sulzburg | 9 | -0.14 | -0.47 | +0.17 | 100 % | 0 |
| 17 | Hauptstraße 55, Sulzburg | 4 | -0.25 | -0.68 | -0.05 | 75 % | 0 |
| 18 | Hauptstraße 58, Sulzburg | 8 | -1.27 | -2.14 | -0.04 | 12 % | 0 |
| 19 | Hauptstraße, Sulzburg | 5 | -0.29 | -0.47 | -0.01 | 100 % | 0 |
| 20 | Hauptstraße, Sulzburg | 4 | -0.41 | -0.76 | +0.11 | 50 % | 0 |
| 21 | Hauptstraße 50, Sulzburg | 4 | -0.47 | -1.07 | -0.02 | 50 % | 0 |
| 22 | Hauptstraße, Sulzburg | 5 | -0.88 | -1.61 | -0.01 | 40 % | 0 |
| 23 | Hauptstraße, Sulzburg | 4 | -0.12 | -0.24 | -0.01 | 100 % | 0 |
| 24 | Hauptstraße, Sulzburg | 13 | -0.20 | -0.72 | -0.02 | 69 % | 0 |
| 25 | Hauptstraße 69, Sulzburg | 7 | -0.30 | -0.76 | +0.04 | 57 % | 0 |
| 26 | Hauptstraße, Sulzburg | 6 | -0.49 | -0.60 | +0.01 | 67 % | 0 |
| 27 | Hauptstraße, Sulzburg | 7 | -2.23 | -3.03 | +0.02 | 14 % | 0 |
| 28 | Hauptstraße, Sulzburg | 6 | -0.24 | -0.37 | -0.03 | 100 % | 0 |
| 29 | Hauptstraße, Sulzburg | 4 | -0.05 | -0.15 | +0.02 | 100 % | 0 |
| 30 | Ernst-Bark-Gasse 2, Sulzburg | 8 | -0.42 | -0.66 | -0.00 | 62 % | 0 |
| 31 | Sulzburg | 6 | -0.12 | -0.18 | +0.01 | 100 % | 0 |
| 32 | Hauptstraße, Sulzburg | 5 | -0.66 | -0.71 | +0.01 | 40 % | 0 |
| 33 | Hauptstraße, Sulzburg | 4 | -0.08 | -0.22 | -0.01 | 100 % | 0 |
| 34 | Hauptstraße, Sulzburg | 5 | -0.04 | -0.19 | +0.03 | 100 % | 0 |
| 35 | Alte Postgasse, Sulzburg | 5 | -0.09 | -0.37 | -0.01 | 100 % | 0 |
| 36 | Sulzburg | 6 | -0.21 | -0.36 | +0.00 | 100 % | 0 |
| 37 | Hauptstraße, Sulzburg | 4 | -0.23 | -1.01 | +0.01 | 75 % | 0 |
| 38 | Hauptstraße 66, Sulzburg | 13 | -0.16 | -0.57 | -0.00 | 69 % | 0 |
| 39 | Hauptstraße 48, Sulzburg | 6 | -0.98 | -1.56 | +0.00 | 33 % | 0 |
| 40 | Alte Postgasse, Sulzburg | 5 | -0.13 | -0.20 | -0.08 | 100 % | 0 |
| 41 | Hauptstraße, Sulzburg | 4 | -0.13 | -0.22 | +0.00 | 100 % | 0 |
| 42 | Hauptstraße, Sulzburg | 10 | -0.74 | -0.83 | -0.06 | 10 % | 2 |
| 43 | Hauptstraße 71, Sulzburg | 6 | -0.18 | -0.34 | -0.06 | 100 % | 0 |
| 44 | Alte Postgasse 4, Sulzburg | 5 | -0.13 | -0.39 | -0.01 | 100 % | 0 |
| 45 | Hauptstraße, Sulzburg | 8 | -0.23 | -0.73 | -0.01 | 75 % | 0 |
| 46 | Hauptstraße, Sulzburg | 6 | -0.36 | -1.34 | +0.01 | 67 % | 0 |
| 47 | Hauptstraße, Sulzburg | 9 | -0.52 | -0.88 | +0.00 | 44 % | 0 |
| 48 | Ernst-Bark-Gasse, Sulzburg | 8 | -0.20 | -0.37 | +0.00 | 100 % | 0 |
| 49 | Ernst-Bark-Gasse, Sulzburg | 6 | -0.31 | -0.36 | -0.01 | 100 % | 0 |

## 2. Sonnenstand gegen unabhängige Referenz

Die eigene Berechnung in `web/sun.js` (NOAA-Algorithmus) wird mit der Python-Bibliothek `astral` verglichen (Standort 47.84052° N, 7.70817° O, Zeiten in UTC).

| Datum | Aufgang sun.js | Aufgang astral | Diff | Untergang sun.js | Untergang astral | Diff |
|---|---|---|---|---|---|---|
| 2026-03-20 | 05:31:52 | 05:32:38 | -0.8 min | 17:41:20 | 17:41:27 | -0.1 min |
| 2026-06-21 | 03:30:21 | 03:30:36 | -0.3 min | 19:31:37 | 19:31:21 | +0.3 min |
| 2026-09-22 | 05:16:02 | 05:15:56 | +0.1 min | 17:27:47 | 17:27:00 | +0.8 min |
| 2026-12-21 | 07:15:32 | 07:15:45 | -0.2 min | 15:38:55 | 15:38:41 | +0.2 min |
| 2026-11-08 | 06:24:31 | 06:24:29 | +0.0 min | 16:01:11 | 16:00:39 | +0.5 min |

| Zeitpunkt (UTC) | Azimut sun.js | Azimut astral | Höhe sun.js | Höhe astral |
|---|---|---|---|---|
| 2026-03-20T06:00 | 94.42° | 94.42° | 4.00° | 4.00° |
| 2026-03-20T09:00 | 132.36° | 132.36° | 31.31° | 31.31° |
| 2026-03-20T12:00 | 187.86° | 187.86° | 41.86° | 41.86° |
| 2026-03-20T15:00 | 238.90° | 238.90° | 25.11° | 25.11° |
| 2026-03-20T18:00 | 274.39° | 274.39° | -3.81° | -3.81° |
| 2026-06-21T06:00 | 78.75° | 78.75° | 21.92° | 21.92° |
| 2026-06-21T09:00 | 115.75° | 115.75° | 51.44° | 51.44° |
| 2026-06-21T12:00 | 195.86° | 195.86° | 64.93° | 64.93° |
| 2026-06-21T15:00 | 258.36° | 258.36° | 42.23° | 42.23° |
| 2026-06-21T18:00 | 291.18° | 291.18° | 12.62° | 12.62° |
| 2026-09-22T06:00 | 96.87° | 96.87° | 6.71° | 6.71° |
| 2026-09-22T09:00 | 135.98° | 135.98° | 33.37° | 33.37° |
| 2026-09-22T12:00 | 192.79° | 192.79° | 41.66° | 41.66° |
| 2026-09-22T15:00 | 242.26° | 242.26° | 23.08° | 23.08° |
| 2026-12-21T09:00 | 145.90° | 145.90° | 11.52° | 11.52° |
| 2026-12-21T12:00 | 187.91° | 187.91° | 18.39° | 18.39° |
| 2026-12-21T15:00 | 227.43° | 227.43° | 4.44° | 4.44° |
| 2026-11-08T06:00 | 109.74° | 109.74° | -4.52° | -4.52° |
| 2026-11-08T09:00 | 146.27° | 146.27° | 19.08° | 19.08° |
| 2026-11-08T12:00 | 192.43° | 192.43° | 24.68° | 24.68° |
| 2026-11-08T15:00 | 234.02° | 234.02° | 8.12° | 8.12° |

Größte Abweichung: Auf-/Untergang **0.8 min**, Azimut **0.00°**, Höhe **0.00°**.
