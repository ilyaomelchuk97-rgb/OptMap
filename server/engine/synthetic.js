// Генератор демонстрационного дорожного графа — синтетический «Минск».
//
// Используется, когда реальный граф OSM ещё не загружен (см. scripts/ingest.js):
// приложение сразу полностью работоспособно на демо-данных.
// Сеть строится как настоящая дорожная сеть: кольцевая магистраль (МКАД),
// радиальные магистрали, среднее кольцо, центральная сетка улиц, внешняя сетка.
// Топология — честная планарная сеть с перекрёстками; классы дорог и скорости
// соответствуют городским нормам СНГ. Река/парки — декоративные объекты карты
// (на маршрутизацию не влияют).

import { Graph } from './graph.js';
import { haversineM } from '../util/geo.js';

const CX = 53.9045; // центр — Минск
const CY = 27.5615;
const KM_LAT = 1 / 111.32;
const KM_LON = 1 / (111.32 * Math.cos((CX * Math.PI) / 180));

// детерминированный ГПСЧ, чтобы демо-город был одинаковым при каждом запуске
function mulberry32(seed) {
  let a = seed;
  return function () {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const toXY = (lat, lon) => [((lon - CY) / KM_LON), ((lat - CX) / KM_LAT)];
const toLL = (x, y) => [CX + y * KM_LAT, CY + x * KM_LON];

export function generateSyntheticCity() {
  const rnd = mulberry32(20260924);
  const lines = []; // { pts: [[x,y]...], cls, kmh, name }

  const addLine = (pts, cls, kmh, name) => lines.push({ pts, cls, kmh, name });

  // --- МКАД: эллипс ~10 x 8.8 км ---
  const ringPts = [];
  const N_RING = 44;
  for (let i = 0; i < N_RING; i++) {
    const a = (2 * Math.PI * i) / N_RING;
    const j = 1 + (rnd() - 0.5) * 0.04;
    ringPts.push([Math.cos(a) * 5.0 * j, Math.sin(a) * 4.4 * j]);
  }
  ringPts.push(ringPts[0]);
  addLine(ringPts, 'motorway', 90, 'МКАД');

  // --- радиальные магистрали ---
  const radials = [
    { ang: 90, cls: 'trunk', kmh: 70, name: 'пр. Независимости' },
    { ang: 45, cls: 'primary', kmh: 60, name: 'ул. Некрасова' },
    { ang: 0, cls: 'trunk', kmh: 70, name: 'ул. Притыцкого' },
    { ang: 315, cls: 'primary', kmh: 60, name: 'ул. Тимирязева' },
    { ang: 270, cls: 'trunk', kmh: 70, name: 'пр. Дзержинского' },
    { ang: 225, cls: 'primary', kmh: 60, name: 'ул. Щорса' },
    { ang: 180, cls: 'trunk', kmh: 70, name: 'Партизанский пр.' },
    { ang: 135, cls: 'primary', kmh: 60, name: 'ул. Ванеева' },
  ];
  for (const r of radials) {
    const a = (r.ang * Math.PI) / 180;
    // продлеваем за МКАД — пересечение найдёт разбивка, хвост срежется
    const end = [Math.cos(a) * 5.4, Math.sin(a) * 4.75];
    addLine([[0, 0], end], r.cls, r.kmh, r.name);
  }

  // --- среднее кольцо ---
  const midPts = [];
  for (let i = 0; i < 36; i++) {
    const a = (2 * Math.PI * i) / 36;
    midPts.push([Math.cos(a) * 2.1, Math.sin(a) * 1.8]);
  }
  midPts.push(midPts[0]);
  addLine(midPts, 'secondary', 60, 'Среднее кольцо');

  // --- центральная сетка (шаг 350 м, внутри среднего кольца) ---
  const ewNames = ['ул. Максима Богдановича', 'ул. Куйбышева', 'ул. Козлова', 'ул. Платонова', 'ул. Комсомольская', 'ул. Интернациональная', 'ул. Ленина', 'ул. Кирова', 'ул. Карла Маркса', 'ул. Энгельса', 'ул. Октябрьская', 'ул. Свердлова', 'ул. Володарского'];
  const nsNames = ['ул. Якуба Коласа', 'ул. Первомайская', 'ул. Калинина', 'ул. Киселёва', 'ул. Красная', 'ул. Румянцевская', 'ул. Городской Вал', 'ул. Немига', 'ул. Романовская', 'ул. Короля', 'ул. Кальварийская', 'ул. Димитрова', 'ул. Раковская'];
  let ewI = 0, nsI = 0;
  for (let y = -1.75; y <= 1.751; y += 0.28) {
    const half = Math.sqrt(Math.max(0, 1 - (y / 1.8) ** 2)) * 2.1 * 1.35; // продлеваем за кольцо
    if (half < 0.2) continue;
    const kmh = Math.abs(y) <= 0.55 ? 40 : 50;
    addLine([[-half, y], [half, y]], 'tertiary', kmh, ewNames[ewI++ % ewNames.length]);
  }
  for (let x = -1.925; x <= 1.926; x += 0.28) {
    const half = Math.sqrt(Math.max(0, 1 - (x / 2.1) ** 2)) * 1.8 * 1.35;
    if (half < 0.2) continue;
    const kmh = Math.abs(x) <= 0.55 ? 40 : 50;
    addLine([[x, -half], [x, half]], 'tertiary', kmh, nsNames[nsI++ % nsNames.length]);
  }

  // --- внешняя сетка (шаг ~850 м, до МКАД) ---
  const outerNames = ['ул. Космонавтов', 'ул. Плеханова', 'ул. Академическая', 'ул. Сурганова', 'ул. Калиновского', 'ул. Руссиянова', 'ул. Кольцова', 'ул. Шишкина', 'ул. Гинтовта', 'ул. Нарочанская', 'ул. Ольшевского', 'ул. Ташкентская', 'ул. Уборевича', 'ул. Гурского', 'ул. Есенина'];
  let oI = 0;
  for (let x = -4.2; x <= 4.21; x += 0.7) {
    if (Math.abs(x) < 2.0) continue; // в центре уже есть сетка
    const half = Math.sqrt(Math.max(0, 1 - (x / 5.0) ** 2)) * 4.4 * 1.15;
    if (half < 0.3) continue;
    addLine([[x, -half], [x, half]], 'secondary', 50, outerNames[oI++ % outerNames.length]);
  }
  for (let y = -3.7; y <= 3.71; y += 0.7) {
    if (Math.abs(y) < 1.9) continue;
    const half = Math.sqrt(Math.max(0, 1 - (y / 4.4) ** 2)) * 5.0 * 1.15;
    if (half < 0.3) continue;
    addLine([[-half, y], [half, y]], 'secondary', 50, outerNames[oI++ % outerNames.length]);
  }

  // --- планарная разбивка: пересечения отрезков -> перекрёстки ---
  const graph = pruneDeadEnds(buildFromLines(lines), 3);

  // --- декоративные объекты карты ---
  graph.mapData = {
    water: [
      { kind: 'line', coords: [[1.25, -5.2], [1.05, -3.2], [1.45, -1.2], [0.95, 0.3], [1.25, 1.9], [0.85, 3.6], [1.1, 4.8]].map(([x, y]) => toLL(x, y)), name: 'р. Свислочь' },
      { kind: 'poly', center: toLL(-3.1, 0.6), rxKm: 0.95, ryKm: 0.6, name: 'Дрозды' },
      { kind: 'poly', center: toLL(-0.7, 1.35), rxKm: 0.42, ryKm: 0.3, name: 'Комсомольское озеро' },
    ],
    parks: [
      { center: toLL(0.7, -0.75), rxKm: 0.5, ryKm: 0.42, name: 'Парк Горького' },
      { center: toLL(-1.55, -1.15), rxKm: 0.55, ryKm: 0.45, name: 'сквер' },
      { center: toLL(2.3, 1.7), rxKm: 0.85, ryKm: 0.65, name: 'Лошицкий парк' },
      { center: toLL(-2.6, -2.2), rxKm: 0.7, ryKm: 0.5, name: 'парк' },
      { center: toLL(3.1, -1.9), rxKm: 0.6, ryKm: 0.45, name: 'парк' },
    ],
    labels: [
      { name: 'Центр', at: toLL(0, 0), size: 'big' },
      { name: 'МКАД', at: toLL(4.4, 2.0), size: 'road' },
      { name: 'пр. Независимости', at: toLL(2.2, 2.2), size: 'road' },
      { name: 'пр. Дзержинского', at: toLL(-2.2, -2.1), size: 'road' },
      { name: 'Партизанский пр.', at: toLL(-2.4, 2.0), size: 'road' },
      { name: 'ул. Притыцкого', at: toLL(2.6, 0), size: 'road' },
    ],
  };

  graph.meta.source = 'synthetic';
  graph.meta.sourceName = 'Демо-город (синтетическая сеть, координаты Минска)';
  graph.meta.builtAt = new Date().toISOString();
  return graph;
}

/** Строит граф из списка линий: находит пересечения, ставит перекрёстки, режет рёбра. */
function buildFromLines(lines) {
  const segs = [];
  for (let li = 0; li < lines.length; li++) {
    const pts = lines[li].pts;
    for (let i = 0; i + 1 < pts.length; i++) {
      segs.push({ li, x1: pts[i][0], y1: pts[i][1], x2: pts[i + 1][0], y2: pts[i + 1][1], cuts: new Set([0, 1]) });
    }
  }

  // пересечения отрезков (параметрически)
  for (let i = 0; i < segs.length; i++) {
    const a = segs[i];
    for (let j = i + 1; j < segs.length; j++) {
      const b = segs[j];
      if (a.li === b.li) continue;
      const x = intersect(a, b);
      if (x) {
        a.cuts.add(x.t);
        b.cuts.add(x.u);
      }
    }
  }

  const g = new Graph();
  const nodeIds = new Map();
  const nodeId = (x, y) => {
    const key = Math.round(x * 1e6) + ':' + Math.round(y * 1e6);
    let id = nodeIds.get(key);
    if (id === undefined) {
      const [lat, lon] = toLL(x, y);
      id = g.addNode(lat, lon);
      nodeIds.set(key, id);
    }
    return id;
  };

  for (const s of segs) {
    const cuts = [...s.cuts].sort((p, q) => p - q);
    const line = lines[s.li];
    for (let i = 0; i + 1 < cuts.length; i++) {
      const t0 = cuts[i], t1 = cuts[i + 1];
      if (t1 - t0 < 1e-9) continue;
      const x0 = s.x1 + (s.x2 - s.x1) * t0, y0 = s.y1 + (s.y2 - s.y1) * t0;
      const x1 = s.x1 + (s.x2 - s.x1) * t1, y1 = s.y1 + (s.y2 - s.y1) * t1;
      const u = nodeId(x0, y0), v = nodeId(x1, y1);
      if (u === v) continue;
      const [la0, lo0] = toLL(x0, y0);
      const [la1, lo1] = toLL(x1, y1);
      const len = haversineM(la0, lo0, la1, lo1);
      if (len < 1) continue;
      g.addEdge(u, v, {
        lenM: len,
        kmh: line.kmh,
        cls: line.cls,
        name: line.name,
        shape: [la0, lo0, la1, lo1],
      });
    }
  }
  return g;
}

function intersect(a, b) {
  const dx1 = a.x2 - a.x1, dy1 = a.y2 - a.y1;
  const dx2 = b.x2 - b.x1, dy2 = b.y2 - b.y1;
  const den = dx1 * dy2 - dy1 * dx2;
  if (Math.abs(den) < 1e-12) return null;
  const t = ((b.x1 - a.x1) * dy2 - (b.y1 - a.y1) * dx2) / den;
  const u = ((b.x1 - a.x1) * dy1 - (b.y1 - a.y1) * dx1) / den;
  if (t > 1e-9 && t < 1 - 1e-9 && u > 1e-9 && u < 1 - 1e-9) return { t, u };
  return null;
}

/**
 * Удаление висячих отростков (узлов степени 1) — артефактов разрезания линий.
 * Возвращает новый граф только со связанными рёбрами.
 */
function pruneDeadEnds(g, rounds = 3) {
  let alive = new Uint8Array(g.edgeCount).fill(1);
  for (let round = 0; round < rounds; round++) {
    // неориентированная степень: пара u–v считается один раз (eu<ev),
    // иначе двухсторонние отростки имеют степень 2 и не находятся
    const deg = new Uint32Array(g.nodeCount);
    for (let e = 0; e < g.edgeCount; e++) {
      if (!alive[e]) continue;
      if (g.eu[e] < g.ev[e]) {
        deg[g.eu[e]]++;
        deg[g.ev[e]]++;
      }
    }
    let changed = false;
    for (let e = 0; e < g.edgeCount; e++) {
      if (!alive[e]) continue;
      if (deg[g.eu[e]] === 1 || deg[g.ev[e]] === 1) {
        alive[e] = 0;
        changed = true;
      }
    }
    if (!changed) break;
  }
  const ng = new Graph();
  const remap = new Int32Array(g.nodeCount).fill(-1);
  for (let e = 0; e < g.edgeCount; e++) {
    if (!alive[e]) continue;
    const u = g.eu[e], v = g.ev[e];
    if (remap[u] === -1) remap[u] = ng.addNode(g.lat[u], g.lon[u]);
    if (remap[v] === -1) remap[v] = ng.addNode(g.lat[v], g.lon[v]);
    ng.addEdge(remap[u], remap[v], {
      lenM: g.lenM[e],
      kmh: g.kmh[e],
      cls: g.classes[g.clsI[e]],
      name: g.nameI[e] >= 0 ? g.names[g.nameI[e]] : null,
      oneway: true, // обе стороны уже существуют как отдельные рёбра
      shape: g.shapeOf(e),
    });
  }
  ng.mapData = g.mapData;
  ng.meta = g.meta;
  ng.build();
  return ng;
}
