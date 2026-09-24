// Фасад движка: граф + пробки + привязка точек + маршрутизация.

import fs from 'node:fs/promises';
import { Graph } from './graph.js';
import { TrafficModel } from './traffic.js';
import { SnapIndex } from './snap.js';
import { Router } from './router.js';
import { generateSyntheticCity } from './synthetic.js';
import { haversineM } from '../util/geo.js';

export class Engine {
  constructor(graph, traffic, snap, router, config) {
    this.graph = graph;
    this.traffic = traffic;
    this.snap = snap;
    this.router = router;
    this.config = config;
    this.startedAt = new Date().toISOString();
  }

  static async create(config) {
    let graph = null;
    let loadedFrom = null;
    try {
      graph = await Graph.loadGzip(config.graphPath);
      loadedFrom = config.graphPath;
    } catch (e) {
      if (!config.allowSynthetic) {
        throw new Error(
          `Дорожный граф не найден: ${config.graphPath}. Загрузите данные OSM: npm run ingest -- --help (или разрешите демо-данные ALLOW_SYNTHETIC=true)`
        );
      }
    }
    if (!graph) {
      console.log('[optmap] граф не найден — генерирую демо-город…');
      graph = generateSyntheticCity();
      await graph.saveGzip(config.graphPath).catch(() => {});
      loadedFrom = config.graphPath + ' (сгенерирован, демо)';
    }
    let traffic;
    if (config.trafficProfilePath) {
      try {
        const profile = JSON.parse(await fs.readFile(config.trafficProfilePath, 'utf8'));
        traffic = new TrafficModel(profile);
        console.log('[optmap] профиль загрузки дорог:', config.trafficProfilePath);
      } catch (e) {
        console.warn('[optmap] не удалось прочитать TRAFFIC_PROFILE, использую встроенный профиль:', e.message);
        traffic = new TrafficModel();
      }
    } else {
      traffic = new TrafficModel();
    }
    const snap = new SnapIndex(graph).build();
    const router = new Router(graph, traffic);
    console.log(
      `[optmap] граф: ${graph.nodeCount} узлов, ${graph.edgeCount} рёбер | источник: ${graph.meta.sourceName} (${graph.meta.source})`
    );
    return new Engine(graph, traffic, snap, router, { ...config, loadedFrom });
  }

  get isDemo() {
    return this.graph.meta.source === 'synthetic';
  }

  health() {
    const g = this.graph;
    return {
      status: 'ok',
      version: '0.1.0',
      engine: {
        source: g.meta.source,
        sourceName: g.meta.sourceName,
        builtAt: g.meta.builtAt,
        loadedFrom: this.config.loadedFrom,
        demo: this.isDemo,
        nodes: g.nodeCount,
        edges: g.edgeCount,
        bbox: g.bbox, // [minLat, minLon, maxLat, maxLon]
        maxKmh: g.maxKmh,
      },
      traffic: this.traffic.describe(),
      tileUrl: this.config.tileUrl,
      limits: {
        maxPoints: this.config.maxPoints,
        snapRadiusM: this.config.snapRadiusM,
      },
      startedAt: this.startedAt,
    };
  }

  /** Привязка точки к дороге; бросает ошибку с понятным сообщением. */
  snapPoint(lat, lon, label = '') {
    const s = this.snap.snap(lat, lon, this.config.snapRadiusM);
    if (!s) {
      const where = label ? `«${label}»` : `${lat.toFixed(5)}, ${lon.toFixed(5)}`;
      const err = new Error(
        `Точка ${where} слишком далеко от дорог (более ${this.config.snapRadiusM} м). Переместите точку ближе к дорожной сети.`
      );
      err.status = 400;
      err.code = 'SNAP_FAILED';
      throw err;
    }
    return s;
  }

  /** Путь между двумя точками. */
  route(from, to, opts = {}) {
    const sa = this.snapPoint(from.lat, from.lon, from.name);
    const sb = this.snapPoint(to.lat, to.lon, to.name);
    return this.router.route(sa, sb, opts);
  }

  /** Матрица времени/дистанций между точками. */
  matrix(points, opts = {}) {
    const snaps = points.map((p) => this.snapPoint(p.lat, p.lon, p.name));
    const mx = this.router.matrix(snaps, opts);
    mx.snaps = snaps;
    return mx;
  }

  /** Поиск улиц по названию (для строки поиска на карте). */
  geocode(q, limit = 8) {
    const g = this.graph;
    const query = String(q).trim().toLowerCase();
    if (query.length < 2) return [];
    const results = [];
    const seen = new Set();
    for (let e = 0; e < g.edgeCount && results.length < limit * 3; e++) {
      const ni = g.nameI[e];
      if (ni < 0) continue;
      const name = g.names[ni];
      const lower = name.toLowerCase();
      if (!lower.includes(query) || seen.has(name)) continue;
      seen.add(name);
      results.push({
        name,
        cls: g.classes[g.clsI[e]],
        lat: g.lat[g.eu[e]],
        lon: g.lon[g.eu[e]],
        // приблизительный центр улицы — середина ребра
        score: lower.startsWith(query) ? 0 : 1,
      });
    }
    results.sort((a, b) => a.score - b.score || a.name.localeCompare(b.name, 'ru'));
    return results.slice(0, limit);
  }

  /** Гео-данные карты для демо-режима (дороги, вода, парки). */
  mapData() {
    const g = this.graph;
    if (g.edgeCount > this.config.mapDataMaxEdges) {
      return null; // большой граф — клиент должен использовать тайлы
    }
    const byCls = new Map();
    for (let e = 0; e < g.edgeCount; e++) {
      const cls = g.classes[g.clsI[e]];
      let arr = byCls.get(cls);
      if (!arr) byCls.set(cls, (arr = []));
      arr.push([[g.lat[g.eu[e]], g.lon[g.eu[e]]], [g.lat[g.ev[e]], g.lon[g.ev[e]]]]);
    }
    return {
      roads: [...byCls.entries()].map(([cls, segments]) => ({ cls, segments })),
      water: g.mapData?.water || [],
      parks: g.mapData?.parks || [],
      labels: g.mapData?.labels || [],
      bbox: g.bbox,
    };
  }

  /** Прямое расстояние между точками (для сравнения с маршрутом). */
  directM(a, b) {
    return haversineM(a.lat, a.lon, b.lat, b.lon);
  }
}
