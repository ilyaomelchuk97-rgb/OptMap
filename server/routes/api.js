// REST API OptMap.
//
// Два движка расчёта:
//  • local  — собственный движок на графе дорог OSM (по умолчанию);
//  • yandex — официальные API Яндекс Карт (маршруты с реальными пробками,
//    матрица расстояний), включается ключом YANDEX_ROUTER_KEY.
// Выбор: options.engine = 'auto' | 'yandex' | 'local' (по умолчанию — auto:
// Яндекс, если настроен ключ, иначе локальный движок). При недоступности
// Яндекса автоматический transparent-фолбэк на локальный движок.

import { Router } from 'express';
import { optimizeOrder } from '../optimizer/index.js';
import { YandexAdapter, YandexError, nextDepartureTime } from '../adapters/yandex.js';
import { NominatimAdapter } from '../adapters/nominatim.js';

const WEEKEND_DAYS = [0, 6];
const TILE_UA = 'OptMap/0.1 (self-hosted routing; tile proxy for demo map)';

export function createApi(engine) {
  const api = Router();

  // адаптер Яндекс Карт (официальные API; включается ключами из окружения)
  const yandex = new YandexAdapter({
    geocoderKey: engine.config.yandexGeocoderKey,
    routerKey: engine.config.yandexRouterKey,
    geocoderUrl: engine.config.yandexGeocoderUrl,
    routerUrl: engine.config.yandexRouterUrl,
  });

  // адаптер Nominatim — геокодер OpenStreetMap (без ключей)
  const nominatim = new NominatimAdapter({ url: engine.config.nominatimUrl });

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
    const engineName = o.engine === undefined || o.engine === null ? null : String(o.engine);
    if (engineName !== null && !['auto', 'yandex', 'local'].includes(engineName)) {
      const err = new Error('options.engine: допустимо auto | yandex | local');
      err.status = 400;
      throw err;
    }
    return {
      mode,
      departHour,
      engine: engineName,
      trafficOn: o.traffic !== false && mode === 'time',
      roundTrip: o.roundTrip !== false,
      endLocked: o.endLocked === true,
      returnGeometry: o.returnGeometry !== false,
      isWeekend:
        o.isWeekend !== undefined
          ? o.isWeekend === true || o.isWeekend === 'true'
          : WEEKEND_DAYS.includes(new Date().getDay()),
    };
  }

  function engineOpts(po) {
    return { mode: po.mode, departHour: po.departHour, trafficOn: po.trafficOn, isWeekend: po.isWeekend };
  }

  /** departure_time для Яндекса (unix-сек) либо null. */
  function departureTimeOf(po) {
    return po.departHour !== null ? nextDepartureTime(po.departHour) : null;
  }

  /** Какой движок использовать: 'yandex' | 'local'. */
  function resolveEngine(po) {
    const pref = po.engine || engine.config.routingEngine || 'auto';
    const wantYandex =
      pref === 'yandex' || (pref === 'auto' && yandex.routerEnabled && po.mode === 'time' && po.trafficOn);
    if (wantYandex && !yandex.routerEnabled) {
      const err = new Error(
        'Запрошен движок «yandex», но не настроен YANDEX_ROUTER_KEY. Получите ключ на developer.tech.yandex.ru (API Маршрутизации) или укажите options.engine=local.'
      );
      err.status = 400;
      throw err;
    }
    return wantYandex ? 'yandex' : 'local';
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
      return {
        lat,
        lon,
        name: typeof p.name === 'string' && p.name.trim() ? p.name.trim().slice(0, 80) : `Точка ${i + 1}`,
      };
    });
  }

  const pointName = (p, i) => p.name || `Точка ${i + 1}`;

  function avgKmh(distanceM, durationS) {
    return durationS > 0 ? Math.round((distanceM / 1000 / (durationS / 3600)) * 10) / 10 : 0;
  }

  /* ---------- Health ---------- */

  api.get('/health', (_req, res) => {
    res.json({
      ...engine.health(),
      yandex: {
        geocoder: yandex.geocoderEnabled,
        router: yandex.routerEnabled,
        tiles: Boolean(engine.config.yandexTiles),
        jsKey: engine.config.yandexJsKey, // открытый ключ JS API (для браузера)
      },
      nominatim: {
        enabled: nominatim.enabled,
        url: engine.config.nominatimUrl || null,
      },
      routingEngine: resolveEngine({ mode: 'time', trafficOn: true, engine: null }),
    });
  });

  /* ---------- Оптимизация маршрута по точкам (главный метод) ---------- */

  api.post('/optimize', async (req, res) => {
    const t0 = Date.now();
    let po;
    let points;
    try {
      po = parseOpts(req.body);
      points = parsePoints(req.body);
    } catch (e) {
      return fail(res, e.status || 400, e.message);
    }

    let engineName;
    try {
      engineName = resolveEngine(po);
    } catch (e) {
      return fail(res, e.status || 400, e.message);
    }
    const warnings = [];

    // Яндекс строит только быстрые маршруты с пробками
    if (engineName === 'yandex' && (po.mode !== 'time' || !po.trafficOn)) {
      warnings.push('Движок Яндекс строит только быстрые маршруты с пробками (mode=time, traffic=on) — считаю локальным движком');
      engineName = 'local';
    }

    let result = null;
    if (engineName === 'yandex') {
      try {
        result = await computeYandex(po, points, t0);
      } catch (e) {
        if (e instanceof YandexError) {
          warnings.push(`Яндекс недоступен (${e.message}) — считаю локальным движком по графу OSM`);
          result = null;
        } else {
          return fail(res, e.status || 500, e.message, e.code);
        }
      }
    }
    if (!result) {
      try {
        result = computeLocal(po, points, t0, warnings);
      } catch (e) {
        return fail(res, e.status || 500, e.message, e.code);
      }
    }

    res.json({
      order: result.order,
      legs: result.legs,
      totals: result.totals,
      optimizer: result.optimizer,
      engine: {
        name: result.engineName,
        trafficType: result.trafficType ?? null,
        graph: {
          source: engine.graph.meta.source,
          sourceName: engine.graph.meta.sourceName,
          demo: engine.isDemo,
        },
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

  /** Расчёт локальным движком (граф OSM). */
  function computeLocal(po, points, t0, warnings) {
    // 1. матрица времени/дистанций с учётом загрузки дорог
    const tMatrix = Date.now();
    const mx = engine.matrix(points, engineOpts(po));
    const matrixMs = Date.now() - tMatrix;

    if (mx.unreachable.length > 0) {
      const [i, j] = mx.unreachable[0];
      const err = new Error(
        `Между точками «${pointName(points[i], i)}» и «${pointName(points[j], j)}» нет дорожной связи (нет пути по графу).`
      );
      err.status = 422;
      err.code = 'NO_PATH';
      throw err;
    }

    for (let i = 0; i < (mx.snaps?.length ?? 0); i++) {
      const s = mx.snaps[i];
      if (s && s.distM > 50) {
        warnings.push(`Точка «${pointName(points[i], i)}» привязана к дороге с точностью ~${Math.round(s.distM)} м`);
      }
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
        const err = new Error(`Нет пути между «${pointName(points[a], a)}» и «${pointName(points[b], b)}»`);
        err.status = 422;
        err.code = 'NO_PATH';
        throw err;
      }
      legs.push({
        from: a,
        to: b,
        fromName: pointName(points[a], a),
        toName: pointName(points[b], b),
        distanceM: leg.distanceM,
        durationS: leg.durationS,
        avgSpeedKmh: avgKmh(leg.distanceM, leg.durationS),
        coords: po.returnGeometry ? leg.coords : undefined,
      });
    }

    const totals = summarize(legs, seq, points, engine);

    return {
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
      engineName: 'local',
      trafficType: null,
    };
  }

  /** Расчёт через официальные API Яндекс Карт (реальные пробки). */
  async function computeYandex(po, points, t0) {
    const dep = departureTimeOf(po);

    // 1. матрица времени/дистанций (прогноз пробок Яндекса)
    const tMatrix = Date.now();
    const mx = await yandex.matrix(points, points, { departureTime: dep });
    const matrixMs = Date.now() - tMatrix;

    for (let i = 0; i < points.length; i++) {
      for (let j = 0; j < points.length; j++) {
        if (i !== j && !isFinite(mx.times[i][j]) && !isFinite(mx.lens[i][j])) {
          throw new YandexError(
            `не удалось построить маршрут между «${pointName(points[i], i)}» и «${pointName(points[j], j)}»`
          );
        }
      }
    }

    // 2. оптимальный порядок обхода
    const costMx = mx.times.map((r) => [...r]);
    const opt = optimizeOrder(costMx, { roundTrip: po.roundTrip, endLocked: po.endLocked });
    const order = opt.order;

    // 3. единый запрос маршрута по всей последовательности (геометрия + точное время)
    const seq = [...order];
    if (po.roundTrip && order.length > 2) seq.push(order[0]);
    const tLegs = Date.now();
    const rr = await yandex.route(
      seq.map((i) => ({ lat: points[i].lat, lon: points[i].lon })),
      { departureTime: dep }
    );
    const legsMs = Date.now() - tLegs;
    if (rr.legs.length !== seq.length - 1) {
      throw new YandexError(`ожидалось ${seq.length - 1} участков маршрута, получено ${rr.legs.length}`);
    }

    const legs = rr.legs.map((leg, s) => ({
      from: seq[s],
      to: seq[s + 1],
      fromName: pointName(points[seq[s]], seq[s]),
      toName: pointName(points[seq[s + 1]], seq[s + 1]),
      distanceM: Math.round(leg.distanceM),
      durationS: Math.round(leg.durationS),
      avgSpeedKmh: avgKmh(leg.distanceM, leg.durationS),
      coords: po.returnGeometry ? leg.coords : undefined,
    }));

    const totals = summarize(legs, seq, points, engine);

    return {
      order,
      legs,
      totals,
      optimizer: {
        method: opt.method,
        points: points.length,
        matrixMs,
        optimizeMs: opt.elapsedMs ?? null,
        legsMs,
        totalMs: Date.now() - t0,
      },
      engineName: 'yandex',
      trafficType: rr.trafficType,
    };
  }

  function summarize(legs, seq, points, engineRef) {
    const totals = {
      distanceM: Math.round(legs.reduce((s, l) => s + l.distanceM, 0)),
      durationS: Math.round(legs.reduce((s, l) => s + l.durationS, 0)),
    };
    totals.avgSpeedKmh = avgKmh(totals.distanceM, totals.durationS);
    let directM = 0;
    for (let s = 0; s + 1 < seq.length; s++) {
      directM += engineRef.directM(points[seq[s]], points[seq[s + 1]]);
    }
    totals.directDistanceM = Math.round(directM);
    totals.detourFactor = directM > 0 ? Math.round((totals.distanceM / directM) * 100) / 100 : null;
    return totals;
  }

  /* ---------- Матрица времени/дистанций ---------- */

  api.post('/matrix', async (req, res) => {
    let po;
    let points;
    try {
      po = parseOpts(req.body);
      points = parsePoints(req.body);
    } catch (e) {
      return fail(res, e.status || 400, e.message);
    }
    try {
      let timesS;
      let distancesM;
      let source;
      if (resolveEngine(po) === 'yandex') {
        const mx = await yandex.matrix(points, points, { departureTime: departureTimeOf(po) });
        timesS = mx.times.map((r) => [...r].map((v) => (isFinite(v) ? Math.round(v * 10) / 10 : null)));
        distancesM = mx.lens.map((r) => [...r].map((v) => (isFinite(v) ? Math.round(v) : null)));
        source = 'yandex';
      } else {
        const mx = engine.matrix(points, engineOpts(po));
        if (mx.unreachable.length > 0) {
          return fail(res, 422, `Нет дорожной связи между точками: ${mx.unreachable.map(([i, j]) => `${i}→${j}`).join(', ')}`, 'NO_PATH');
        }
        timesS = mx.times.map((r) => [...r].map((v) => Math.round(v * 10) / 10));
        distancesM = mx.lens.map((r) => [...r].map((v) => Math.round(v)));
        source = 'osm-graph';
      }
      res.json({
        points: points.map((p, i) => pointName(p, i)),
        timesS,
        distancesM,
        source,
      });
    } catch (e) {
      if (e instanceof YandexError) return fail(res, 502, `Яндекс: ${e.message}`, 'YANDEX_ERROR');
      return fail(res, e.status || 500, e.message, e.code);
    }
  });

  /* ---------- Маршрут между двумя точками (как в навигаторе) ---------- */

  async function buildRoute(from, to, optsRaw, res) {
    try {
      const po = parseOpts({ options: optsRaw });
      for (const [name, p] of [['from', from], ['to', to]]) {
        const lat = Number(p?.lat), lon = Number(p?.lon);
        if (!Number.isFinite(lat) || !Number.isFinite(lon)) {
          throw Object.assign(new Error(`${name}: ожидаются координаты {lat, lon}`), { status: 400 });
        }
      }
      let engineName = resolveEngine(po);
      if (engineName === 'yandex' && (po.mode !== 'time' || !po.trafficOn)) engineName = 'local';

      let out = null;
      let warning = null;
      let trafficType = null;
      if (engineName === 'yandex') {
        try {
          const rr = await yandex.route(
            [{ lat: from.lat, lon: from.lon }, { lat: to.lat, lon: to.lon }],
            { departureTime: departureTimeOf(po) }
          );
          const leg = rr.legs[0];
          out = { distanceM: leg.distanceM, durationS: leg.durationS, coords: leg.coords };
          trafficType = rr.trafficType;
        } catch (e) {
          if (!(e instanceof YandexError)) throw e;
          warning = `Яндекс недоступен (${e.message}) — локальный движок`;
          engineName = 'local';
        }
      }
      if (!out) {
        const leg = engine.route(from, to, engineOpts(po));
        if (!leg) return fail(res, 422, 'Маршрут между точками не найден', 'NO_PATH');
        out = { distanceM: leg.distanceM, durationS: leg.durationS, coords: leg.coords };
      }

      return res.json({
        distanceM: out.distanceM,
        durationS: out.durationS,
        avgSpeedKmh: avgKmh(out.distanceM, out.durationS),
        coords: out.coords,
        engine: {
          name: engineName,
          trafficType,
          graph: { source: engine.graph.meta.source, demo: engine.isDemo },
        },
        warning,
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
      {
        mode: req.query.mode,
        departHour: req.query.departHour,
        traffic: req.query.traffic,
        engine: req.query.engine,
      },
      res
    );
  });

  /* ---------- Геокодирование: OSM-граф → Nominatim → Яндекс (по запросу) ---------- */

  api.get('/geocode', async (req, res) => {
    const q = String(req.query.q || '').trim();
    const limit = Math.min(12, Number(req.query.limit) || 8);
    if (q.length < 2) return res.json({ results: [], source: 'none' });
    const lat = req.query.lat !== undefined && req.query.lat !== '' ? Number(req.query.lat) : null;
    const lon = req.query.lon !== undefined && req.query.lon !== '' ? Number(req.query.lon) : null;
    // src: auto (по умолчанию) | graph | osm | yandex
    const src = ['auto', 'graph', 'osm', 'yandex'].includes(String(req.query.src)) ? String(req.query.src) : 'auto';
    const warnings = [];

    // 1. быстрый локальный поиск по загруженному дорожному графу (работает офлайн)
    const graphResults = src === 'osm' || src === 'yandex' ? [] : engine.geocode(q, limit);
    if (src === 'graph' || graphResults.length >= Math.min(limit, 3)) {
      return res.json({ results: graphResults, source: 'osm-graph' });
    }

    // 2. Nominatim — геокодер OpenStreetMap (адреса, дома, POI)
    if (src === 'auto' || src === 'osm') {
      if (nominatim.enabled) {
        try {
          const results = await nominatim.geocode(q, { lat, lon, limit });
          if (results.length > 0) {
            return res.json({ results, source: 'osm-nominatim', warnings });
          }
          warnings.push('Nominatim не нашёл совпадений');
        } catch (e) {
          warnings.push(`Nominatim недоступен: ${e.message}`);
        }
      }
    }

    // 3. Яндекс-геокодер — только если настроен ключ
    if ((src === 'auto' || src === 'yandex') && yandex.geocoderEnabled) {
      try {
        const results = await yandex.geocode(q, { lat, lon, limit });
        return res.json({ results, source: 'yandex', warnings });
      } catch (e) {
        warnings.push(`Яндекс-геокодер недоступен: ${e.message}`);
      }
    }

    return res.json({ results: graphResults, source: 'osm-graph', warnings });
  });

  /** Обратное геокодирование: координаты → адрес/улица (OSM-граф → Nominatim → Яндекс). */
  api.get('/geocode/reverse', async (req, res) => {
    const lat = Number(req.query.lat);
    const lon = Number(req.query.lon);
    if (!Number.isFinite(lat) || !Number.isFinite(lon)) {
      return fail(res, 400, 'Ожидаются параметры lat и lon');
    }
    const src = ['auto', 'graph', 'osm', 'yandex'].includes(String(req.query.src)) ? String(req.query.src) : 'auto';
    const warnings = [];

    if (src === 'graph') {
      return res.json({ result: engine.reverseName(lat, lon), source: 'osm-graph' });
    }

    // Nominatim — основной адресный источник OSM
    if (src === 'auto' || src === 'osm') {
      if (nominatim.enabled) {
        try {
          const r = await nominatim.reverse(lat, lon);
          if (r) return res.json({ result: r, source: 'osm-nominatim', warnings });
        } catch (e) {
          warnings.push(`Nominatim недоступен: ${e.message}`);
        }
      }
    }

    if ((src === 'auto' || src === 'yandex') && yandex.geocoderEnabled) {
      try {
        const r = await yandex.reverse(lat, lon);
        if (r) return res.json({ result: r, source: 'yandex', warnings });
      } catch (_e) {
        /* ниже — фолбэк на граф */
      }
    }

    return res.json({ result: engine.reverseName(lat, lon), source: 'osm-graph', warnings });
  });

  /* ---------- Тайл-прокси Яндекса (подложка демо-карты) ---------- */
  // Проекция тайлов — EPSG:3395 (клиент включает соответствующий CRS Leaflet).

  const tileCache = new Map(); // "z/x/y" -> {buf, ct}
  const TILE_CACHE_MAX = 600;

  api.get('/tiles/:z/:x/:y', async (req, res) => {
    if (!engine.config.yandexTiles) {
      return fail(res, 404, 'Тайл-прокси Яндекса выключен (YANDEX_TILES=off)');
    }
    const z = Number(req.params.z);
    const x = Number(req.params.x);
    const ym = /^(\d+)(?:\.png)?$/i.exec(String(req.params.y));
    const y = ym ? Number(ym[1]) : NaN;
    if (!Number.isInteger(z) || !Number.isInteger(x) || !Number.isInteger(y) || z < 0 || z > 19 || x >= 2 ** z || y >= 2 ** z) {
      return fail(res, 400, 'Некорректные координаты тайла');
    }
    const key = `${z}/${x}/${y}`;
    const hit = tileCache.get(key);
    if (hit) {
      // LRU: перекладываем в конец
      tileCache.delete(key);
      tileCache.set(key, hit);
      return res.set('Content-Type', hit.ct).set('Cache-Control', 'public, max-age=86400').send(hit.buf);
    }
    const url = `${engine.config.yandexTileUrl}?l=map&x=${x}&y=${y}&z=${z}&scale=1&lang=ru_RU`;
    try {
      const ctrl = new AbortController();
      const timer = setTimeout(() => ctrl.abort(), 8000);
      const r = await fetch(url, { signal: ctrl.signal, headers: { 'User-Agent': TILE_UA } });
      clearTimeout(timer);
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      const buf = Buffer.from(await r.arrayBuffer());
      const ct = r.headers.get('content-type') || 'image/png';
      tileCache.set(key, { buf, ct });
      if (tileCache.size > TILE_CACHE_MAX) tileCache.delete(tileCache.keys().next().value);
      return res.set('Content-Type', ct).set('Cache-Control', 'public, max-age=86400').send(buf);
    } catch (e) {
      return fail(res, 502, `Тайлы Яндекса недоступны: ${e.message}. Проверьте доступ сервера в интернет или переключите слой карты.`);
    }
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
