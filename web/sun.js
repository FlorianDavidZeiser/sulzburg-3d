// Sonnenstand nach dem NOAA-Algorithmus (Solar Calculator, Jean Meeus, "Astronomical Algorithms").
// Reine Funktionen ohne DOM, damit scripts/05_validate.py sie mit Node gegen eine Referenz prüfen kann.

const rad = (d) => (d * Math.PI) / 180;
const deg = (r) => (r * 180) / Math.PI;

function julianCentury(date) {
  const jd = date.getTime() / 86400000 + 2440587.5;
  return (jd - 2451545) / 36525;
}

// Deklination (Grad) und Zeitgleichung (Minuten) für einen Zeitpunkt
export function solarParams(date) {
  const t = julianCentury(date);
  const l0 = (280.46646 + t * (36000.76983 + 0.0003032 * t)) % 360;
  const m = 357.52911 + t * (35999.05029 - 0.0001537 * t);
  const e = 0.016708634 - t * (0.000042037 + 0.0000001267 * t);
  const c =
    Math.sin(rad(m)) * (1.914602 - t * (0.004817 + 0.000014 * t)) +
    Math.sin(rad(2 * m)) * (0.019993 - 0.000101 * t) +
    Math.sin(rad(3 * m)) * 0.000289;
  const trueLong = l0 + c;
  const omega = 125.04 - 1934.136 * t;
  const lambda = trueLong - 0.00569 - 0.00478 * Math.sin(rad(omega));
  const eps0 = 23 + (26 + (21.448 - t * (46.815 + t * (0.00059 - t * 0.001813))) / 60) / 60;
  const eps = eps0 + 0.00256 * Math.cos(rad(omega));
  const declination = deg(Math.asin(Math.sin(rad(eps)) * Math.sin(rad(lambda))));
  const y = Math.tan(rad(eps / 2)) ** 2;
  const eot =
    4 *
    deg(
      y * Math.sin(2 * rad(l0)) -
        2 * e * Math.sin(rad(m)) +
        4 * e * y * Math.sin(rad(m)) * Math.cos(2 * rad(l0)) -
        0.5 * y * y * Math.sin(4 * rad(l0)) -
        1.25 * e * e * Math.sin(2 * rad(m))
    );
  return { declination, eot };
}

// Azimut (Grad, 0 = Nord, 90 = Ost) und Höhe (Grad, mit Refraktionskorrektur) der Sonne
export function sunPosition(date, lat, lon) {
  const { declination, eot } = solarParams(date);
  const minutesUtc = date.getUTCHours() * 60 + date.getUTCMinutes() + date.getUTCSeconds() / 60;
  const tst = (minutesUtc + eot + 4 * lon + 1440) % 1440;
  const ha = tst / 4 < 0 ? tst / 4 + 180 : tst / 4 - 180;
  const phi = rad(lat);
  const delta = rad(declination);
  const cosZenith = Math.sin(phi) * Math.sin(delta) + Math.cos(phi) * Math.cos(delta) * Math.cos(rad(ha));
  const zenith = deg(Math.acos(Math.min(1, Math.max(-1, cosZenith))));
  let azimuth;
  const denom = Math.cos(phi) * Math.sin(rad(zenith));
  if (Math.abs(denom) < 1e-9) {
    azimuth = 180;
  } else {
    const cosAz = Math.min(1, Math.max(-1, (Math.sin(phi) * Math.cos(rad(zenith)) - Math.sin(delta)) / denom));
    azimuth = ha > 0 ? (deg(Math.acos(cosAz)) + 180) % 360 : (540 - deg(Math.acos(cosAz))) % 360;
  }
  const elevation = 90 - zenith;
  // Atmosphärische Refraktion (NOAA)
  let refraction = 0;
  if (elevation <= 85) {
    const te = Math.tan(rad(elevation));
    if (elevation > 5) refraction = 58.1 / te - 0.07 / te ** 3 + 0.000086 / te ** 5;
    else if (elevation > -0.575)
      refraction = 1735 + elevation * (-518.2 + elevation * (103.4 + elevation * (-12.79 + elevation * 0.711)));
    else refraction = -20.772 / te;
    refraction /= 3600;
  }
  return { azimuth, elevation: elevation + refraction, elevationGeometric: elevation, declination, eot };
}

// Sonnenaufgang und -untergang (UTC) für den Kalendertag von `dateUtcMidnight` (Date auf 00:00 UTC)
export function sunTimes(dateUtcMidnight, lat, lon) {
  const noonGuess = new Date(dateUtcMidnight.getTime() + (720 - 4 * lon) * 60000);
  const { declination, eot } = solarParams(noonGuess);
  const phi = rad(lat);
  const delta = rad(declination);
  const cosHa = Math.cos(rad(90.833)) / (Math.cos(phi) * Math.cos(delta)) - Math.tan(phi) * Math.tan(delta);
  if (cosHa > 1 || cosHa < -1) return { sunrise: null, sunset: null, noon: null };
  const ha = deg(Math.acos(cosHa));
  const noon = 720 - 4 * lon - eot;
  const toDate = (min) => new Date(dateUtcMidnight.getTime() + min * 60000);
  return { sunrise: toDate(noon - 4 * ha), sunset: toDate(noon + 4 * ha), noon: toDate(noon) };
}

// Lokale Zeit einer Zeitzone -> UTC-Date (berücksichtigt Sommerzeit über Intl)
export function zonedToUtc(year, month, day, hour, minute, timeZone) {
  let utc = Date.UTC(year, month - 1, day, hour, minute);
  for (let i = 0; i < 2; i++) {
    utc = Date.UTC(year, month - 1, day, hour, minute) - tzOffsetMs(new Date(utc), timeZone);
  }
  return new Date(utc);
}

export function tzOffsetMs(date, timeZone) {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone,
    hourCycle: "h23",
    year: "numeric", month: "2-digit", day: "2-digit",
    hour: "2-digit", minute: "2-digit", second: "2-digit",
  }).formatToParts(date);
  const get = (type) => Number(parts.find((p) => p.type === type).value);
  const asUtc = Date.UTC(get("year"), get("month") - 1, get("day"), get("hour"), get("minute"), get("second"));
  return asUtc - Math.floor(date.getTime() / 1000) * 1000;
}

export function formatLocal(date, timeZone) {
  if (!date) return "–";
  return new Intl.DateTimeFormat("de-DE", { timeZone, hour: "2-digit", minute: "2-digit" }).format(date);
}
