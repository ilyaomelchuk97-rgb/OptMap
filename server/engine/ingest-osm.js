// Загрузка дорожного графа из данных OpenStreetMap.
//
// Поддерживаются три источника:
//  1. .osm.pbf  — файлы с download.geofabrik.de (рекомендуется: город/область);
//  2. .osm / .osm.xml / .osm.gz — XML-выгрузки (Overpass, JOSM);
//  3. Overpass JSON — ответ API overpass-api.de (скрипт сам скачает по bbox).
//
// Фильтр: только автомобильные дороги (highway=…), с односторонним движением,
// ограничениями скорости (maxspeed, иначе — типовые значения для городов СНГ).

import { createReadStream } from 'node:fs';
import { createGunzip } from 'node:zlib';
import { StringDecoder } from 'node:string_decoder';
import { Graph } from './graph.js';
import { haversineM } from '../util/geo.js';

// Классы дорог, которые включаем в граф
export const DRIVABLE = new Set([
  'motorway', 'motorway_link',
  'trunk', 'trunk_link',
  'primary', 'primary_link',
  'secondary', 'secondary_link',
  'tertiary', 'tertiary_link',
  'unclassified',
  'residential',
  'living_street',
  'service',
  'road',
]);

// Типовые ограничения скорости (км/ч), если тег maxspeed отсутствует.
// Ориентированы на города России/СНГ; переопределяются тегом maxspeed из OSM.
export const DEFAULT_SPEEDS = {
  motorway: 110,
  motorway_link: 60,
  trunk: 90,
  trunk_link: 50,
  primary: 70,
  primary_link: 45,
  secondary: 60,
  secondary_link: 40,
  tertiary: 50,
  tertiary_link: 35,
  unclassified: 60,
  residential: 50,
  living_street: 20,
  service: 30,
  road: 50,
};

// Разбор значений maxspeed вида "60", "60 knots", "RU:urban", "walk"
const ZONE_SPEEDS = {
  urban: 60, 'RU:urban': 60, 'BY:urban': 60, 'UA:urban': 60, 'KZ:urban': 60,
  rural: 90, 'RU:rural': 90, 'BY:rural': 90, 'UA:rural': 90, 'KZ:rural': 90,
  living_street: 20, 'RU:living_street': 20,
  motorway: 110, 'RU:motorway': 110,
  'nsl_restricted': 30, walk: 10,
};

export function parseMaxspeed(v, fallback) {
  if (!v) return fallback;
  const n = parseInt(v, 10);
  if (!Number.isNaN(n) && n > 0 && n <= 200) return n;
  if (ZONE_SPEEDS[v] !== undefined) return ZONE_SPEEDS[v];
  // "60; 70" — берём первое
  const m = String(v).match(/^(\d+)/);
  if (m) return parseInt(m[1], 10);
  return fallback;
}

function isOneway(tags, cls) {
  const ow = tags.oneway;
  if (ow === '-1') return 'reverse';
  if (ow === 'yes' || ow === '1' || ow === 'true') return 'yes';
  if (cls === 'motorway' || cls === 'motorway_link' || cls === 'trunk_link') return 'yes';
  if (tags.junction === 'roundabout') return 'yes';
  return 'no';
}

function wayPassable(tags) {
  if (!DRIVABLE.has(tags.highway)) return false;
  if (tags.access === 'no' || tags.motor_vehicle === 'no') return false;
  if (tags.area === 'yes') return false;
  return true;
}

/** Собрать граф из узлов и путей (общий шаг для всех форматов). */
export function buildGraph(nodesById, ways, { source = 'osm', sourceName = 'OpenStreetMap', onProgress = null } = {}) {
  const g = new Graph();
  const nodeIds = new Map(); // ключ "lat1e7:lon1e7" -> nodeId (дедупликация узлов)

  const graphNode = (lat, lon) => {
    const key = Math.round(lat * 1e7) + ':' + Math.round(lon * 1e7);
    let id = nodeIds.get(key);
    if (id === undefined) {
      id = g.addNode(lat, lon);
      nodeIds.set(key, id);
    }
    return id;
  };

  let done = 0;
  for (const way of ways) {
    done++;
    if (onProgress && done % 20000 === 0) onProgress(done, ways.length);
    const refs = way.refs.filter((id) => nodesById.has(id));
    if (refs.length < 2) continue;
    const tags = way.tags;
    const cls = tags.highway;
    const kmh = parseMaxspeed(tags.maxspeed, DEFAULT_SPEEDS[cls] || 50);
    const oneway = isOneway(tags, cls);
    const name = tags.name || null;

    // координаты полилинии
    const pts = refs.map((id) => nodesById.get(id));

    let u = graphNode(pts[0][0], pts[0][1]);
    for (let i = 1; i < pts.length; i++) {
      const v = graphNode(pts[i][0], pts[i][1]);
      if (u === v) { u = v; continue; }
      const segLen = haversineM(pts[i - 1][0], pts[i - 1][1], pts[i][0], pts[i][1]);
      const segShape = [pts[i - 1][0], pts[i - 1][1], pts[i][0], pts[i][1]];
      if (oneway === 'reverse') {
        g.addEdge(v, u, { lenM: segLen, kmh, cls, name, oneway: true, shape: [segShape[2], segShape[3], segShape[0], segShape[1]] });
      } else if (oneway === 'yes') {
        g.addEdge(u, v, { lenM: segLen, kmh, cls, name, oneway: true, shape: segShape });
      } else {
        g.addEdge(u, v, { lenM: segLen, kmh, cls, name, shape: segShape });
      }
      u = v;
    }
  }
  g.meta.source = source;
  g.meta.sourceName = sourceName;
  g.meta.builtAt = new Date().toISOString();
  g.build();
  return g;
}

/* ------------------------- PBF ------------------------- */

async function parsePbfStream(path, onItems) {
  const { default: parseOSM } = await import('osm-pbf-parser');
  return new Promise((resolve, reject) => {
    const parser = parseOSM();
    createReadStream(path)
      .pipe(parser)
      .on('data', (items) => { try { onItems(items); } catch (e) { reject(e); } })
      .on('end', resolve)
      .on('error', reject);
  });
}

/** Инжест .osm.pbf (два прохода: сначала пути, затем нужные узлы — экономия памяти). */
export async function ingestPbf(path, { onProgress = null, sourceName = null } = {}) {
  // проход 1: отбираем проезжаемые пути и собираем нужные id узлов
  const ways = [];
  const need = new Set();
  let lastReport = Date.now();
  await parsePbfStream(path, (items) => {
    for (const it of items) {
      if (it.type !== 'way') continue;
      const tags = it.tags || {};
      if (!wayPassable(tags)) continue;
      ways.push({ refs: it.refs, tags });
      for (const r of it.refs) need.add(r);
    }
    if (onProgress && Date.now() - lastReport > 2000) {
      lastReport = Date.now();
      onProgress({ phase: 'pbf-ways', ways: ways.length });
    }
  });

  // проход 2: координаты нужных узлов
  const nodesById = new Map();
  await parsePbfStream(path, (items) => {
    for (const it of items) {
      if (it.type !== 'node') continue;
      if (need.has(it.id)) nodesById.set(it.id, [it.lat, it.lon]);
    }
    if (onProgress && Date.now() - lastReport > 2000) {
      lastReport = Date.now();
      onProgress({ phase: 'pbf-nodes', nodes: nodesById.size });
    }
  });

  return buildGraph(nodesById, ways, { onProgress: (d, t) => onProgress && onProgress({ phase: 'build', done: d, total: t }) });
}

/* ------------------------- XML ------------------------- */

async function* xmlChunks(path) {
  const gz = path.endsWith('.gz');
  const stream = createReadStream(path);
  const decoder = new StringDecoder('utf8');
  let carry = '';
  for await (const chunk of (gz ? stream.pipe(createGunzip()) : stream)) {
    const text = carry + decoder.write(chunk);
    // хвост — незакрытый тег
    const lastLt = text.lastIndexOf('<');
    const lastGt = text.lastIndexOf('>');
    if (lastLt > lastGt) {
      carry = text.slice(lastLt);
      yield text.slice(0, lastLt);
    } else {
      carry = '';
      yield text;
    }
  }
  yield carry + decoder.end();
}

const TAG_RE = /<node\b[^>]*?\/?>|<\/node>|<way\b[^>]*?\/?>|<\/way>|<nd\b[^>]*?\/>|<tag\b[^>]*?\/>/g;
const ATTR_RE = /([a-zA-Z_]+)="([^"]*)"/g;

function attrsOf(s) {
  const o = {};
  let m;
  ATTR_RE.lastIndex = 0;
  while ((m = ATTR_RE.exec(s))) o[m[1]] = m[2];
  return o;
}

/** Обработка XML-потока с событиями. Вызывается дважды (двухпроходный инжест). */
async function scanXml(path, handlers) {
  let way = null;
  let node = null;
  for await (const text of xmlChunks(path)) {
    let m;
    TAG_RE.lastIndex = 0;
    while ((m = TAG_RE.exec(text))) {
      const t = m[0];
      if (t.startsWith('<node')) {
        const a = attrsOf(t);
        if (t.endsWith('/>')) {
          handlers.node(+a.id, +a.lat, +a.lon);
        } else {
          node = { id: +a.id, lat: +a.lat, lon: +a.lon, tags: {} };
        }
      } else if (t.startsWith('</node>')) {
        if (node) handlers.node(node.id, node.lat, node.lon);
        node = null;
      } else if (t.startsWith('<way')) {
        way = { refs: [], tags: {} };
      } else if (t.startsWith('<nd')) {
        if (way) {
          const a = attrsOf(t);
          way.refs.push(+a.ref);
        }
      } else if (t.startsWith('<tag')) {
        const a = attrsOf(t);
        if (way) way.tags[a.k] = a.v;
        else if (node) node.tags[a.k] = a.v;
      } else if (t.startsWith('</way>')) {
        if (way) handlers.wayEnd(way);
        way = null;
      }
    }
  }
}

/** Инжест .osm / .osm.xml / .osm.gz (XML). */
export async function ingestXml(path, { onProgress = null, sourceName = null } = {}) {
  const ways = [];
  const need = new Set();
  await scanXml(path, {
    node: () => {},
    wayEnd: (w) => {
      if (wayPassable(w.tags)) {
        ways.push(w);
        for (const r of w.refs) need.add(r);
      }
    },
  });
  const nodesById = new Map();
  await scanXml(path, {
    node: (id, lat, lon) => {
      if (need.has(id)) nodesById.set(id, [lat, lon]);
    },
    wayEnd: () => {},
  });
  if (onProgress) onProgress({ phase: 'build', done: ways.length, total: ways.length });
  return buildGraph(nodesById, ways);
}

/* ------------------------- Overpass JSON ------------------------- */

/** Запрос Overpass QL для прямоугольника [s, w, n, e]. */
export function overpassQuery([s, w, n, e]) {
  const hw = [...DRIVABLE].join('|');
  return `[out:json][timeout:300];way["highway"~"^(${hw})$"](${s},${w},${n},${e});(._;>;);out body;`;
}

/** Инжест ответа Overpass JSON (elements). */
export function ingestOverpassJson(data, { sourceName = 'Overpass API' } = {}) {
  const nodesById = new Map();
  const ways = [];
  for (const el of data.elements || []) {
    if (el.type === 'node') nodesById.set(el.id, [el.lat, el.lon]);
    else if (el.type === 'way' && wayPassable(el.tags || {})) {
      ways.push({ refs: el.nodes, tags: el.tags || {} });
    }
  }
  return buildGraph(nodesById, ways, { source: 'overpass', sourceName });
}
e;
  return buildGraph(nodesById, ways);
}
