// REST API OptMap.

import { Router } from 'express';
import { optimizeOrder } from '../optimizer/index.js';

const WEEKEND_DAYS = [0, 6];

export function createApi(engine) {
  const api = Router();

  /* ---------- вспомогательное ---------- */

  function fail(res, status, message, code) {
    return res.status(status).json({ error: { message, code: code || null } });
  }

  function parseOpts(body = {}) {
    const o = body.options || {};
    const mode = o.mode === 'distance' ? 'distance' : 'time';
    let departHour = null;
    if (o.departHour !== undefined && o.departHour !== null) {
      departHour = Number(o.departHour);
      if (!Number.isInteger(departHour) || departHour < 0 || departHour > 23) {
        const err = new Error('options.departHour должен быть целым числом 0–23 или null');
        err.status = 400;
        throw err;
      }
    }
    return {
      mode,
      departHour,
      trafficOn: o.traffic !== false && mode === 'time',
      roundTrip: o.roundTrip !== false,
      endLocked: o.endLocked === true,
      returnGeometry: o.returnGeometry !== false,
      isWeekend: o.isWeekend !== undefined ? o.isWeekend === true : WEEKEND_DAYS.includes(new Date().getDay()),
    };
  }

  function engineOpts(po) {
    return { mode: po.mode, departHour: po.departHour, trafficOn: po.trafficOn, isWeekend: po.isWeekend };
  }

  /** Валидация массива точек. */
  function parsePoints(body) {
    const pts = body.points;
    if (!Array.isArray(pts)) {
      const err = new Error('Ожидается массив points: [{lat, lon, name?}, …]');
      err.status = 400;
      throw err;
    }
    if (pts.length < 2) {
      const err = new Error('Нужно минимум 2 точки');
      err.status = 400;
      throw err;
    }
    if (pts.length > engine.config.maxPoints) {
      const err = new Error(`Максимум ${engine.config.maxPoints} точек в одном запросе (MAX_POINTS)`);
      err.status = 400;
      throw err;
    }
    return pts.map((p, i) => {
      const lat = Number(p.lat), lon = Number(p.lon);
      if (!Number.isFinite(lat) || !Number.isFinite(lon) || Math.abs(lat) > 90 || Math.abs(lon) > 180) {
        const err = new Error(`points[${i}]: некорректные координаты {lat, lon}`);
        err.status = 400;
        throw err;
      }
      return { lat, lon, name: typeof p.name === 'string' && p.name.trim() ? p.name.trim().slice(0, 80) : `Точка ${i + 1}` };
    });
  }

  const pointName = (p, i) => p.name || `Точка ${i + 1}`;

  /* ---------- Health ---------- */

  api.get('/health', (_req, res) => {
    res.json(engine.health());
  });

  /* ---------- Оптимизация маршрута по точкам (главный метод) ---------- */

  api.post('/optimize', (req, res) => {
    const t0 = Date.now();
    let po;
    let points;
    try {
      po = parseOpts(req.body);
      points = parsePoints(req.body);
    } catch (e) {
      return fail(res, e.status || 400, e.message);
    }

    const warnings = [];

    // 1. матрица времени/дистанций с учётом загрузки дорог
    const tMatrix = Date.now();
    let mx;
    try {
      mx = engine.matrix(points, engineOpts(po));
    } catch (e) {
      return fail(res, e.status || 500, e.message, e.code);
    }
    const matrixMs = Date.now() - tMatrix;

    if (mx.unreachable.length > 0) {
      const [i, j] = mx.unreachable[0];
      return fail(
        res,
        422,
        `Между точками «${pointName(points[i], i)}» и «${pointName(points[j], j)}» нет дорожной связи (нет пути по графу).`,
        'NO_PATH'
      );
    }

    for (const p of points) {
      if (p._snap && p._snap.distM > 50) warnings.push(`Точка «${pointName(p)}» привязана к дороге с точностью ${Math.round(p._snap.distM)} м`);
    }

    // 2. оптимальный порядок обхода
    const costMx = po.mode === 'time' ? mx.times.map((r) => [...r]) : mx.lens.map((r) => [...r]);
    const opt = optimizeOrder(costMx, { roundTrip: po.roundTrip, endLocked: po.endLocked });
    const order = opt.order;

    // 3. ноги маршрута с геометрией
    const seq = [...order];
    if (po.roundTrip && order.length > 2) seq.push(order[0]);
    const legs = [];
    let legMs = 0;
    for (let s = 0; s + 1 < seq.length; s++) {
      const a = seq[s], b = seq[s + 1];
      const tL = Date.now();
      const leg = engine.route(points[a], points[b], engineOpts(po));
      legMs += Date.now() - tL;
      if (!leg) {
        return fail(res, 422, `Нет пути между «${pointName(points[a], a)}» и «${pointName(points[b], b)}»`, 'NO_PATH');
      }
      legs.push({
        from: a,
        to: b,
        fromName: pointName(points[a], a),
        toName: pointName(points[b], b),
        distanceM: leg.distanceM,
        durationS: leg.durationS,
        avgSpeedKmh: leg.distanceM > 0 ? Math.round((leg.distanceM / 1000 / (leg.durationS / 3600)) * 10) / 10 : 0,
        coords: po.returnGeometry ? leg.coords : undefined,
      });
    }

    const totals = {
      distanceM: Math.round(legs.reduce((s, l) => s + l.distanceM, 0)),
      durationS: Math.round(legs.reduce((s, l) => s + l.durationS, 0)),
    };
    totals.avgSpeedKmh =
      totals.durationS > 0 ? Math.round((totals.distanceM / 1000 / (totals.durationS / 3600)) * 10) / 10 : 0;

    // прямой километраж (по воздушным линиям между последовательными точками)
    let directM = 0;
    for (let s = 0; s + 1 < seq.length; s++) {
      directM += engine.directM(points[seq[s]], points[seq[s + 1]]);
    }
    totals.directDistanceM = Math.round(directM);
    totals.detourFactor = directM > 0 ? Math.round((totals.distanceM / directM) * 100) / 100 : null;

    res.json({
      order,
      legs,
      totals,
      optimizer: {
        method: opt.method,
        points: points.length,
        matrixMs,
        optimizeMs: opt.elapsedMs ?? null,
        legsMs: legMs,
        totalMs: Date.now() - t0,
      },
      engine: {
        source: engine.graph.meta.source,
        sourceName: engine.graph.meta.sourceName,
        demo: engine.isDemo,
      },
      options: {
        mode: po.mode,
        roundTrip: po.roundTrip,
        endLocked: po.endLocked,
        traffic: po.trafficOn,
        departHour: po.departHour,
        isWeekend: po.isWeekend,
      },
      warnings,
    });
  });

  /* ---------- Матрица времени/дистанций ---------- */

  api.post('/matrix', (req, res) => {
    let po;
    let points;
    try {
      po = parseOpts(req.body);
      points = parsePoints(req.body);
    } catch (e) {
      return fail(res, e.status || 400, e.message);
    }
    const mx = engine.matrix(points, engineOpts(po));
    if (mx.unreachable.length > 0) {
      return fail(res, 422, `Нет дорожной связи между точками: ${mx.unreachable.map(([i, j]) => `${i}→${j}`).join(', ')}`, 'NO_PATH');
    }
    res.json({
      points: points.map((p, i) => pointName(p, i)),
      timesS: mx.times.map((r) => [...r].map((v) => Math.round(v * 10) / 10)),
      distancesM: mx.lens.map((r) => [...r].map((v) => Math.round(v))),
    });
  });

  /* ---------- Маршрут между двумя точками (как в навигаторе) ---------- */

  function buildRoute(from, to, optsRaw, res) {
    try {
      const po = parseOpts({ options: optsRaw });
      for (const [name, p] of [['from', from], ['to', to]]) {
        const lat = Number(p?.lat), lon = Number(p?.lon);
        if (!Number.isFinite(lat) || !Number.isFinite(lon)) {
          throw Object.assign(new Error(`${name}: ожидаются координаты {lat, lon}`), { status: 400 });
        }
      }
      const leg = engine.route(from, to, engineOpts(po));
      if (!leg) return fail(res, 422, 'Маршрут между точками не найден', 'NO_PATH');
      return res.json({
        distanceM: leg.distanceM,
        durationS: leg.durationS,
        avgSpeedKmh: leg.durationS > 0 ? Math.round((leg.distanceM / 1000 / (leg.durationS / 3600)) * 10) / 10 : 0,
        coords: leg.coords,
        engine: { source: engine.graph.meta.source, demo: engine.isDemo },
        options: { mode: po.mode, traffic: po.trafficOn, departHour: po.departHour },
      });
    } catch (e) {
      return fail(res, e.status || 500, e.message, e.code);
    }
  }

  api.post('/route', (req, res) => {
    buildRoute(req.body?.from, req.body?.to, req.body?.options, res);
  });

  api.get('/route', (req, res) => {
    const num = (v) => (v === undefined ? undefined : Number(v));
    buildRoute(
      { lat: num(req.query.fromLat), lon: num(req.query.fromLon) },
      { lat: num(req.query.toLat), lon: num(req.query.toLon) },
      { mode: req.query.mode, departHour: req.query.departHour, traffic: req.query.traffic },
      res
    );
  });

  /* ---------- Геокодирование по дорожному графу ---------- */

  api.get('/geocode', (req, res) => {
    const q = String(req.query.q || '');
    res.json({ results: engine.geocode(q, Math.min(12, Number(req.query.limit) || 8)) });
  });

  /* ---------- Гео-данные для отрисовки демо-карты ---------- */

  api.get('/mapdata', (_req, res) => {
    const data = engine.mapData();
    if (!data) {
      return fail(res, 404, 'Граф слишком большой для отрисовки целиком — карта работает на тайлах OSM', 'USE_TILES');
    }
    res.json(data);
  });

  return api;

}
