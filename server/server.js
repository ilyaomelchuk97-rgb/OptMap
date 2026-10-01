#!/usr/bin/env node
/**
 * OptMap — офлайн-сервер карты.
 * Ноль зависимостей: только Node.js (>= 18).
 *
 *   node server/server.js [--port 8080] [--data data]
 *
 * Эндпоинты:
 *   GET /                      веб-приложение (web/)
 *   GET /api/config            метаданные региона
 *   GET /api/tiles/{z}/{x}/{y} векторный тайл (gzip)
 *   GET /api/search?q=         поиск адресов / улиц / POI
 *   GET /api/reverse?lon=&lat= обратный геокодинг
 *   GET /api/route?a=lon,lat&b=lon,lat&mode=car|foot
 */
"use strict";

const http = require("http");
const fs = require("fs");
const path = require("path");
const zlib = require("zlib");

const ROOT = path.resolve(__dirname, "..");

// ---- аргументы ----
const args = process.argv.slice(2);
function argOf(name, def) {
  const i = args.indexOf(name);
  return i >= 0 && args[i + 1] ? args[i + 1] : def;
}
const PORT = parseInt(argOf("--port", process.env.PORT || "8080"), 10);
const DATA_DIR = path.resolve(ROOT, argOf("--data", "data"));
const WEB_DIR = path.join(ROOT, "web");

// ---- загрузка данных ----
const config = JSON.parse(fs.readFileSync(path.join(DATA_DIR, "config.json"), "utf8"));
const index = JSON.parse(fs.readFileSync(path.join(DATA_DIR, "index.json"), "utf8"));
const graph = JSON.parse(fs.readFileSync(path.join(DATA_DIR, "graph.json"), "utf8"));
const labelsFile = path.join(DATA_DIR, "labels.json");
const labels = fs.existsSync(labelsFile)
  ? JSON.parse(fs.readFileSync(labelsFile, "utf8"))
  : { labels: [] };

// ---- поисковый индекс ----
const NORM_RE = /[^\p{L}\p{N}]+/gu;
function norm(s) {
  return String(s || "").toLowerCase().replace(/ё/g, "е").replace(NORM_RE, " ").trim();
}
const entries = index.entries.map((e) => ({
  ...e,
  _n: norm(e.n),
  _s: norm(e.s || ""),
  _h: norm(e.h || ""),
  _tokens: norm((e.n || "") + " " + (e.s || "") + " " + (e.h || "")).split(" ").filter(Boolean),
}));

const TYPE_BOOST = { address: 1.25, poi: 1.15, place: 1.2, street: 1.0, street_pt: 0.3 };

function search(q, limit = 12) {
  const query = norm(q);
  if (!query) return [];
  const qTokens = query.split(" ").filter(Boolean);
  const out = [];
  for (const e of entries) {
    if (e.hid) continue;
    let score = 0;
    if (e._n === query) score += 1200;
    if (e._n.startsWith(query)) score += 700;
    if (e._n.includes(query)) score += 350;
    let allTokens = qTokens.length > 0;
    for (const qt of qTokens) {
      let tokScore = 0;
      if (e._n === qt) tokScore = 300;
      else if (e._n.startsWith(qt)) tokScore = 220;
      else if (e._tokens.some((t) => t === qt)) tokScore = 200;
      else if (e._tokens.some((t) => t.startsWith(qt))) tokScore = 150;
      else if (e._n.includes(qt)) tokScore = 80;
      else { allTokens = false; break; }
      score += tokScore;
    }
    if (!allTokens) continue;
    if (score <= 0) continue;
    score *= (e.w || 1) * (TYPE_BOOST[e.t] || 1);
    out.push({ e, score });
  }
  out.sort((a, b) => b.score - a.score);
  return out.slice(0, limit).map(({ e, score }) => ({
    type: e.t,
    label: formatLabel(e),
    name: e.n,
    kind: e.k,
    lon: e.lon,
    lat: e.lat,
    score: Math.round(score),
  }));
}

function formatLabel(e) {
  if (e.t === "address") {
    const city = config.nameRu;
    const parts = [];
    if (e.s) parts.push(e.s);
    parts.push(String(e.h));
    return (city ? city + ", " : "") + parts.join(", ");
  }
  return e.n;
}

function reverse(lon, lat, radius = 150) {
  let best = null;
  let bestD = radius;
  for (const e of entries) {
    const d = dist(lon, lat, e.lon, e.lat);
    if (d < bestD) {
      bestD = d;
      best = e;
    }
  }
  if (!best) return null;
  return {
    type: best.t,
    label: formatLabel(best),
    name: best.n,
    kind: best.k,
    lon: best.lon,
    lat: best.lat,
    distance: Math.round(bestD),
  };
}

function dist(lon1, lat1, lon2, lat2) {
  const R = 6371000;
  const p1 = (lat1 * Math.PI) / 180, p2 = (lat2 * Math.PI) / 180;
  const dp = ((lat2 - lat1) * Math.PI) / 180;
  const dl = ((lon2 - lon1) * Math.PI) / 180;
  const a = Math.sin(dp / 2) ** 2 + Math.cos(p1) * Math.cos(p2) * Math.sin(dl / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(a));
}

// ---- граф дорог ----
const nodes = graph.nodes;
const adj = new Map();      // id -> [[to, dist, time, name, cls]]
for (const [u, v, d, t, name, cls] of graph.edges) {
  const us = String(u), vs = String(v);
  if (!adj.has(us)) adj.set(us, []);
  adj.get(us).push([vs, d, t, name, cls]);
}

// пространственный индекс узлов для привязки
const CELL = 0.01;
const grid = new Map();
for (const [id, c] of Object.entries(nodes)) {
  const k = Math.floor(c[0] / CELL) + ":" + Math.floor(c[1] / CELL);
  if (!grid.has(k)) grid.set(k, []);
  grid.get(k).push(id);
}

function nearestNode(lon, lat, maxR = 1500) {
  let best = null, bestD = maxR;
  const cx = Math.floor(lon / CELL), cy = Math.floor(lat / CELL);
  const span = Math.ceil(maxR / 111000 / CELL);
  for (let dx = -span; dx <= span; dx++) {
    for (let dy = -span; dy <= span; dy++) {
      const list = grid.get((cx + dx) + ":" + (cy + dy));
      if (!list) continue;
      for (const id of list) {
        const c = nodes[id];
        const d = dist(lon, lat, c[0], c[1]);
        if (d < bestD) { bestD = d; best = id; }
      }
    }
  }
  return best ? { id: best, dist: bestD } : null;
}

const FOOT_OK = new Set(["footway", "steps", "path", "pedestrian", "cycleway",
  "living_street", "residential", "unclassified", "tertiary", "secondary",
  "primary", "primary_link", "service", "track", "bridleway", "road"]);

class Heap {
  constructor() { this.a = []; }
  push(item) {
    const a = this.a;
    a.push(item);
    let i = a.length - 1;
    while (i > 0) {
      const p = (i - 1) >> 1;
      if (a[p][0] <= a[i][0]) break;
      [a[p], a[i]] = [a[i], a[p]];
      i = p;
    }
  }
  pop() {
    const a = this.a;
    const top = a[0];
    const last = a.pop();
    if (a.length) {
      a[0] = last;
      let i = 0;
      for (;;) {
        const l = 2 * i + 1, r = l + 1;
        let m = i;
        if (l < a.length && a[l][0] < a[m][0]) m = l;
        if (r < a.length && a[r][0] < a[m][0]) m = r;
        if (m === i) break;
        [a[m], a[i]] = [a[i], a[m]];
        i = m;
      }
    }
    return top;
  }
  get size() { return this.a.length; }
}

function route(fromLon, fromLat, toLon, toLat, mode = "car") {
  const a = nearestNode(fromLon, fromLat);
  const b = nearestNode(toLon, toLat);
  if (!a || !b) return { error: "Не удалось привязать точку к дороге" };
  const foot = mode === "foot";
  const prev = new Map();
  const prevEdge = new Map();
  const dist0 = new Map([[a.id, 0]]);
  const time0 = new Map([[a.id, 0]]);
  const heap = new Heap();
  heap.push([0, a.id]);
  const done = new Set();
  while (heap.size) {
    const [d, u] = heap.pop();
    if (done.has(u)) continue;
    done.add(u);
    if (u === b.id) break;
    const list = adj.get(u);
    if (!list) continue;
    for (const [v, w, t, name, cls] of list) {
      if (done.has(v)) continue;
      if (foot && !FOOT_OK.has(cls)) continue;
      const nd = d + w;
      if (nd < (dist0.get(v) ?? Infinity)) {
        dist0.set(v, nd);
        time0.set(v, (time0.get(u) || 0) + (foot ? w / 1.25 : t));
        prev.set(v, u);
        prevEdge.set(v, { dist: w, time: foot ? w / 1.25 : t, name, cls });
        heap.push([nd, v]);
      }
    }
  }
  if (!prev.has(b.id) && a.id !== b.id) return { error: "Маршрут не найден" };

  const pathIds = [b.id];
  let cur = b.id;
  while (cur !== a.id) {
    cur = prev.get(cur);
    if (cur === undefined) break;
    pathIds.push(cur);
  }
  pathIds.reverse();
  const coords = pathIds.map((id) => nodes[id]);

  let totalDist = 0, totalTime = 0;
  const steps = [];
  let i = 1;
  let curName = null, curDist = 0, curTime = 0;
  while (i < pathIds.length) {
    const e = prevEdge.get(pathIds[i]);
    if (!e) { i++; continue; }
    totalDist += e.dist;
    totalTime += e.time;
    if (e.name !== curName) {
      if (curName !== null && curDist > 0) {
        steps.push({ name: curName, distance: curDist, time: curTime });
      }
      curName = e.name;
      curDist = 0;
      curTime = 0;
    }
    curDist += e.dist;
    curTime += e.time;
    i++;
  }
  if (curName !== null && curDist > 0) {
    steps.push({ name: curName, distance: curDist, time: curTime });
  }

  const instructions = buildInstructions(pathIds, prevEdge, a);
  return {
    distance: totalDist,
    duration: totalTime,
    mode,
    geometry: coords,
    steps,
    instructions,
    from: nodes[a.id],
    to: nodes[b.id],
  };
}

function bearing(lon1, lat1, lon2, lat2) {
  const p1 = (lat1 * Math.PI) / 180, p2 = (lat2 * Math.PI) / 180;
  const dl = ((lon2 - lon1) * Math.PI) / 180;
  const y = Math.sin(dl) * Math.cos(p2);
  const x = Math.cos(p1) * Math.sin(p2) - Math.sin(p1) * Math.cos(p2) * Math.cos(dl);
  return (Math.atan2(y, x) * 180) / Math.PI;
}

function turnType(b1, b2) {
  let d = b2 - b1;
  while (d > 180) d -= 360;
  while (d < -180) d += 360;
  if (d > 135 || d < -135) return "uturn";
  if (d > 45) return "right";
  if (d < -45) return "left";
  if (d > 18) return "slight-right";
  if (d < -18) return "slight-left";
  return "straight";
}

function buildInstructions(pathIds, prevEdge, a) {
  const out = [];
  const firstName = (prevEdge.get(pathIds[1]) || {}).name || "";
  out.push({
    text: firstName ? `Начните движение по «${firstName}»` : "Начните движение",
    distance: 0, maneuver: "depart", name: firstName,
  });
  for (let i = 1; i < pathIds.length - 1; i++) {
    const e1 = prevEdge.get(pathIds[i]);
    const e2 = prevEdge.get(pathIds[i + 1]);
    if (!e1 || !e2) continue;
    const c0 = nodes[pathIds[i - 1]] || nodes[pathIds[i]];
    const c1 = nodes[pathIds[i]];
    const c2 = nodes[pathIds[i + 1]];
    const b1 = bearing(c0[0], c0[1], c1[0], c1[1]);
    const b2 = bearing(c1[0], c1[1], c2[0], c2[1]);
    const tt = turnType(b1, b2);
    if (tt === "straight") continue;
    const name = e2.name || e1.name || "";
    let verb;
    switch (tt) {
      case "slight-right": verb = "Держитесь правее"; break;
      case "slight-left": verb = "Держитесь левее"; break;
      case "right": verb = "Поверните направо"; break;
      case "left": verb = "Поверните налево"; break;
      case "uturn": verb = "Развернитесь"; break;
      default: verb = "Продолжайте";
    }
    out.push({
      text: name ? `${verb} на «${name}»` : verb,
      distance: 0,
      maneuver: tt,
      name,
      at: c1,
    });
  }
  out.push({ text: "Вы прибыли в пункт назначения", distance: 0, maneuver: "arrive" });
  return out;
}

// ---- HTTP ----
const MIME = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".png": "image/png",
  ".svg": "image/svg+xml",
  ".ico": "image/x-icon",
  ".woff2": "font/woff2",
  ".map": "application/json",
};

function sendJson(res, obj, status = 200, req) {
  let body = Buffer.from(JSON.stringify(obj), "utf8");
  const ae = req && req.headers["accept-encoding"];
  if (ae && ae.includes("gzip") && body.length > 2048) {
    body = zlib.gzipSync(body);
    res.setHeader("Content-Encoding", "gzip");
  }
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Content-Length": body.length,
    "Cache-Control": "no-store",
  });
  res.end(body);
}

function sendStatic(res, filePath, req) {
  fs.readFile(filePath, (err, data) => {
    if (err) {
      res.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" });
      res.end("404");
      return;
    }
    const ext = path.extname(filePath).toLowerCase();
    const ae = req.headers["accept-encoding"] || "";
    if (ae.includes("gzip") && (ext === ".js" || ext === ".css" || ext === ".json")) {
      zlib.gzip(data, (e, gz) => {
        if (e) { res.end(data); return; }
        res.writeHead(200, {
          "Content-Type": MIME[ext] || "application/octet-stream",
          "Content-Encoding": "gzip",
          "Content-Length": gz.length,
        });
        res.end(gz);
      });
      return;
    }
    res.writeHead(200, { "Content-Type": MIME[ext] || "application/octet-stream" });
    res.end(data);
  });
}

const server = http.createServer((req, res) => {
  const u = new URL(req.url, "http://localhost");
  const p = decodeURIComponent(u.pathname);

  if (p === "/api/config") return sendJson(res, config, 200, req);

  if (p === "/api/labels") return sendJson(res, labels, 200, req);

  if (p === "/api/search") {
    const q = u.searchParams.get("q") || "";
    return sendJson(res, { query: q, results: search(q) }, 200, req);
  }

  if (p === "/api/reverse") {
    const lon = parseFloat(u.searchParams.get("lon"));
    const lat = parseFloat(u.searchParams.get("lat"));
    if (!isFinite(lon) || !isFinite(lat)) {
      return sendJson(res, { error: "bad coords" }, 400, req);
    }
    return sendJson(res, reverse(lon, lat) || {}, 200, req);
  }

  if (p === "/api/route") {
    const a = (u.searchParams.get("a") || "").split(",").map(Number);
    const b = (u.searchParams.get("b") || "").split(",").map(Number);
    const mode = u.searchParams.get("mode") === "foot" ? "foot" : "car";
    if (a.length !== 2 || b.length !== 2 || a.some((x) => !isFinite(x)) ||
        b.some((x) => !isFinite(x))) {
      return sendJson(res, { error: "bad coords" }, 400, req);
    }
    return sendJson(res, route(a[0], a[1], b[0], b[1], mode), 200, req);
  }

  const tm = p.match(/^\/api\/tiles\/(\d+)\/(\d+)\/(\d+)(\.pbf)?$/);
  if (tm) {
    const [, z, x, y] = tm;
    const file = path.join(DATA_DIR, "tiles", z, x, y + ".pbf.gz");
    fs.readFile(file, (err, data) => {
      if (err) {
        res.writeHead(204);
        res.end();
        return;
      }
      res.writeHead(200, {
        "Content-Type": "application/vnd.mapbox-vector-tile",
        "Content-Encoding": "gzip",
        "Content-Length": data.length,
        "Cache-Control": "public, max-age=31536000, immutable",
      });
      res.end(data);
    });
    return;
  }

  // статика
  let filePath = path.join(WEB_DIR, p === "/" ? "index.html" : p);
  if (!filePath.startsWith(WEB_DIR)) {
    res.writeHead(403);
    res.end();
    return;
  }
  fs.stat(filePath, (err, st) => {
    if (err || !st.isFile()) {
      sendStatic(res, path.join(WEB_DIR, "index.html"), req);
      return;
    }
    sendStatic(res, filePath, req);
  });
});

server.listen(PORT, "0.0.0.0", () => {
  console.log(`OptMap «${config.nameRu}» — http://localhost:${PORT}`);
  console.log(`  тайлов: ${config.stats.tiles}, индекс: ${config.stats.indexEntries}, `
    + `граф: ${config.stats.graphNodes} узлов`);
  console.log("  работает полностью офлайн");
});
