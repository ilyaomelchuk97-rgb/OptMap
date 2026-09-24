// Геодезические утилиты (WGS-84)

export const EARTH_R = 6371008.8; // м, средний радиус Земли

const rad = (d) => (d * Math.PI) / 180;

/** Расстояние по прямой между двумя точками, метры (формула гаверсинусов). */
export function haversineM(lat1, lon1, lat2, lon2) {
  const dLat = rad(lat2 - lat1);
  const dLon = rad(lon2 - lon1);
  const s =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(rad(lat1)) * Math.cos(rad(lat2)) * Math.sin(dLon / 2) ** 2;
  return 2 * EARTH_R * Math.asin(Math.min(1, Math.sqrt(s)));
}

/** Кратчайшее расстояние от точки до отрезка (в «плоских» градусах с поправкой на широту). */
export function projectOnSegment(lat, lon, lat1, lon1, lat2, lon2) {
  const kx = Math.cos(rad((lat1 + lat2) / 2));
  const px = lon * kx, py = lat;
  const ax = lon1 * kx, ay = lat1;
  const bx = lon2 * kx, by = lat2;
  const abx = bx - ax, aby = by - ay;
  const len2 = abx * abx + aby * aby;
  let t = len2 > 0 ? ((px - ax) * abx + (py - ay) * aby) / len2 : 0;
  t = Math.max(0, Math.min(1, t));
  const qx = ax + t * abx, qy = ay + t * aby;
  // переводим «плоские градусы» обратно в метры (грубо, но достаточно для снапа)
  const dy = (qy - py) * 111320;
  const dx = (qx - px) * 111320;
  return { t, distM: Math.hypot(dx, dy), projLat: qy, projLon: qx / kx };
}

/** Округление координат для ключей кэша (~1 м). */
export function coordKey(lat, lon) {
  return Math.round(lat * 1e5) + ':' + Math.round(lon * 1e5);
}
