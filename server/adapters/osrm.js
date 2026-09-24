// Адаптер OSRM (Open Source Routing Machine) — улицы и маршруты из OSM.
//
// https://router.project-osrm.org (демо-сервер; для продакшена лучше свой:
// docker run osrm/osrm-backend + данные из Geofabrik).
//
// Методы HTTP API:
//  • /route/v1/driving/{lon,lat;…}?geometries=geojson  — маршрут через все
//    точки (промежуточные — обязательные), километраж/время по дорогам OSM;
//  • /table/v1/driving/{lon,lat;…}?sources=…&destinations=… — матрица
//    времён (и дистанций при annotations=distance,distance) для оптимизатора.
//
// Время OSRM — «свободный поток» по профилю OSM (без live-пробок).

export class OsrmError extends Error {
  constructor(message, { status = null, endpoint = null } = {}) {
    super(message);
    this.name = 'OsrmError';
    this.status = status;
    this.endpoint = endpoint;
  }
}

export class OsrmAdapter {
  constructor({
    url = 'https://router.project-osrm.org',
    timeoutMs = 15000,
    maxTableCoords = 100, // лимит demo-сервера (--max-table-size)
    fetchImpl = null,
  } = {}) {
    this.url = url.replace(/\/$/, '');
    this.timeoutMs = timeoutMs;
    this.maxTableCoords = maxTableCoords;
    this._fetch = fetchImpl || fetch.bind(globalThis);
  }

  get enabled() {
    return Boolean(this.url);
  }

  async _fetchJson(url, { label = 'osrm' } = {}) {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), this.timeoutMs);
    try {
      const r = await this._fetch(url, { signal: ctrl.signal, headers: { 'User-Agent': 'OptMap/0.1' } });
      if (!r.ok) {
        let msg = `HTTP ${r.status}`;
        try {
          const body = await r.json();
          if (body?.message) msg = body.message;
          else if (body?.error) msg = String(body.error);
          else if (body?.code) msg = body.code;
        } catch { /* не JSON */ }
        throw new OsrmError(`${label}: ${msg}`, { status: r.status, endpoint: url.split('?')[0] });
      }
      const data = await r.json();
      if (data.code && data.code !== 'Ok') {
        throw new OsrmError(`${label}: ${data.code}${data.message ? ' — ' + data.message : ''}`, { endpoint: url.split('?')[0] });
      }
      return data;
    } catch (e) {
      if (e instanceof OsrmError) throw e;
      const why = e.name === 'AbortError' ? `таймаут ${this.timeoutMs} мс` : e.message;
      throw new OsrmError(`${label}: ${why}`, { endpoint: url.split('?')[0] });
    } finally {
      clearTimeout(timer);
    }
  }

  /**
   * Маршрут через все точки (промежуточные — обязательные).
   * @returns { legs: [{distanceM, durationS, coords}] } — legs[i]: от i-й точки к (i+1)-й.
   */
  async route(waypoints) {
    if (waypoints.length < 2) throw new OsrmError('нужно минимум 2 точки');
    const coords = waypoints.map((p) => `${p.lon},${p.lat}`).join(';');
    const url = `${this.url}/route/v1/driving/${coords}?overview=false&geometries=geojson&steps=false&annotations=false`;
    const data = await this._fetchJson(url, { label: 'osrm/route' });
    const route = data?.routes?.[0];
    if (!route) throw new OsrmError('osrm/route: маршрут не построен');
    const legs = (route.legs || []).map((leg) => {
      const cs = leg.geometry?.coordinates || [];
      return {
        distanceM: leg.distance || 0,
        durationS: leg.duration || 0,
        coords: cs.map(([lon, lat]) => [lat, lon]), // GeoJSON → [lat, lon]
      };
    });
    if (legs.length === 0) throw new OsrmError('osrm/route: пустой ответ');
    return { legs };
  }

  /**
   * Матрица времён/дистанций.
   * mode='time' → стоимости в times; mode='distance' → нужны distance-аннотации.
   * @returns { times[][], lens[][] } (Infinity для недостижимых ячеек)
   */
  async matrix(origins, destinations, { mode = 'time' } = {}) {
    const n = origins.length;
    const k = destinations.length;
    const times = Array.from({ length: n }, () => new Array(k).fill(Infinity));
    const lens = Array.from({ length: n }, () => new Array(k).fill(Infinity));

    // лимит координат на запрос: sources + destinations ≤ maxTableCoords
    const chunk = Math.max(1, this.maxTableCoords - k);
    for (let i0 = 0; i0 < n; i0 += chunk) {
      const srcIdx = origins.slice(i0, i0 + chunk);
      const coords = [...srcIdx, ...destinations].map((p) => `${p.lon},${p.lat}`).join(';');
      const sources = srcIdx.map((_, i) => i).join(';');
      const destinationsIdx = srcIdx.map((_, i) => srcIdx.length + i).join(';');
      const annotations = mode === 'distance' ? 'distance,duration' : 'duration';
      const url =
        `${this.url}/table/v1/driving/${coords}` +
        `?sources=${sources}&destinations=${destinationsIdx}&annotations=${annotations}`;
      const data = await this._fetchJson(url, { label: 'osrm/table' });
      const durations = data.durations || [];
      const distances = data.distances || null;
      if (mode === 'distance' && !distances) {
        throw new OsrmError('osrm/table: сервер не отдаёт дистанции (annotations=distance) — нужен OSRM с поддержкой аннотаций');
      }
      srcIdx.forEach((_, ri) => {
        const dRow = durations[ri] || [];
        const sRow = distances ? distances[ri] || [] : [];
        for (let ci = 0; ci < k; ci++) {
          const d = dRow[ci];
          if (d !== null && d !== undefined && isFinite(d)) times[i0 + ri][ci] = d;
          const s = sRow[ci];
          if (s !== null && s !== undefined && isFinite(s)) lens[i0 + ri][ci] = s;
        }
      });
    }
    return { times, lens };
  }
}
