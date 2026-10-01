// Адаптер Яндекс Карт (официальные HTTP API):
//  • Геокодер  — определение адресов/улиц по строке и обратное геокодирование
//    https://geocode-maps.yandex.ru/1.x/?apikey=…&geocode=…&format=json
//  • Маршрутизация — честные километраж и время с реальными пробками Яндекса
//    https://api.routing.yandex.net/v2/route            (маршрут + геометрия)
//    https://api.routing.yandex.net/v2/distancematrix   (матрица для оптимизатора)
//
// Ключи выдаются в кабинете разработчика: https://developer.tech.yandex.ru/
// Все методы бросают YandexError при недоступности/ошибке API — вызывающий
// код решает, делать ли фолбэк на локальный движок.

const DEFAULT_UA = 'OptMap/0.1 (+self-hosted routing demo)';

export class YandexError extends Error {
  constructor(message, { status = null, endpoint = null } = {}) {
    super(message);
    this.name = 'YandexError';
    this.status = status;
    this.endpoint = endpoint;
  }
}

export class YandexAdapter {
  constructor({
    geocoderKey = null,
    routerKey = null,
    geocoderUrl = 'https://geocode-maps.yandex.ru/1.x/',
    routerUrl = 'https://api.routing.yandex.net/v2',
    timeoutMs = 12000,
    fetchImpl = null,
  } = {}) {
    this.geocoderKey = geocoderKey;
    this.routerKey = routerKey;
    this.geocoderUrl = geocoderUrl;
    this.routerUrl = routerUrl;
    this.timeoutMs = timeoutMs;
    this._fetch = fetchImpl || fetch.bind(globalThis);
  }

  get geocoderEnabled() {
    return Boolean(this.geocoderKey);
  }

  get routerEnabled() {
    return Boolean(this.routerKey);
  }

  async _fetchJson(url, { label = 'yandex' } = {}) {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), this.timeoutMs);
    try {
      const r = await this._fetch(url, {
        signal: ctrl.signal,
        headers: { 'User-Agent': DEFAULT_UA },
      });
      if (!r.ok) {
        let msg = `HTTP ${r.status}`;
        try {
          const body = await r.json();
          if (body?.error?.message) msg = body.error.message;
          else if (body?.errors?.length) msg = body.errors.join('; ');
          else if (body?.message) msg = body.message;
        } catch { /* тело не JSON — оставляем HTTP-код */ }
        throw new YandexError(`${label}: ${msg}`, { status: r.status, endpoint: url.split('?')[0] });
      }
      return await r.json();
    } catch (e) {
      if (e instanceof YandexError) throw e;
      const why = e.name === 'AbortError' ? `таймаут ${this.timeoutMs} мс` : e.message;
      throw new YandexError(`${label}: ${why}`, { endpoint: url.split('?')[0] });
    } finally {
      clearTimeout(timer);
    }
  }

  /* ---------------- Геокодер ---------------- */

  /**
   * Поиск адреса/улицы (определение дорог).
   * @returns [{name, fullName, lat, lon, cls, source:'yandex'}]
   */
  async geocode(q, { lat = null, lon = null, limit = 8 } = {}) {
    if (!this.geocoderKey) throw new YandexError('геокодер: не задан YANDEX_GEOCODER_KEY');
    const params = new URLSearchParams({
      apikey: this.geocoderKey,
      geocode: String(q),
      format: 'json',
      results: String(Math.min(10, Math.max(1, limit))),
      lang: 'ru_RU',
    });
    // смещение поиска к области интереса (не строго)
    if (lat !== null && lon !== null) {
      params.set('ll', `${lon},${lat}`);
      params.set('spn', '0.6,0.3');
    }
    const data = await this._fetchJson(`${this.geocoderUrl}?${params}`, { label: 'геокодер' });
    const members = data?.response?.GeoObjectCollection?.featureMember || [];
    return members.map(({ GeoObject: g }) => {
      const [lonX, latX] = String(g.Point?.pos || '').split(' ').map(Number);
      const meta = g.metaDataProperty?.GeocoderMetaData || {};
      return {
        name: g.name || meta.text || String(q),
        fullName: meta.text || g.name || '',
        lat: latX,
        lon: lonX,
        cls: meta.kind || 'obj',
        source: 'yandex',
      };
    }).filter((p) => Number.isFinite(p.lat) && Number.isFinite(p.lon));
  }

  /** Обратное геокодирование: координаты → ближайший адрес. */
  async reverse(lat, lon) {
    if (!this.geocoderKey) throw new YandexError('геокодер: не задан YANDEX_GEOCODER_KEY');
    const params = new URLSearchParams({
      apikey: this.geocoderKey,
      geocode: `${lon},${lat}`,
      format: 'json',
      results: '1',
      lang: 'ru_RU',
    });
    const data = await this._fetchJson(`${this.geocoderUrl}?${params}`, { label: 'геокодер(rev)' });
    const g = data?.response?.GeoObjectCollection?.featureMember?.[0]?.GeoObject;
    if (!g) return null;
    const meta = g.metaDataProperty?.GeocoderMetaData || {};
    return {
      name: g.name || meta.text || '',
      fullName: meta.text || g.name || '',
      lat,
      lon,
      cls: meta.kind || 'obj',
      source: 'yandex',
    };
  }

  /* ---------------- Маршрутизация ---------------- */

  /**
   * Маршрут через все точки (с реальными пробками).
   * @param waypoints [{lat,lon}, ...] (≥2)
   * @returns { trafficType, legs: [{distanceM, durationS, coords}] } — legs[i]:
   *          от waypoints[i] до waypoints[i+1].
   */
  async route(waypoints, { departureTime = null, timeoutMs = null } = {}) {
    if (!this.routerKey) throw new YandexError('роутер: не задан YANDEX_ROUTER_KEY');
    if (waypoints.length < 2) throw new YandexError('нужно минимум 2 точки');
    const params = new URLSearchParams({
      apikey: this.routerKey,
      waypoints: waypoints.map((p) => `${p.lat},${p.lon}`).join('|'),
      mode: 'driving',
    });
    if (departureTime) params.set('departure_time', String(Math.floor(departureTime)));
    const prevTimeout = this.timeoutMs;
    if (timeoutMs) this.timeoutMs = timeoutMs;
    try {
      const data = await this._fetchJson(`${this.routerUrl}/route?${params}`, { label: 'роутер' });
      return this._parseRoute(data);
    } finally {
      this.timeoutMs = prevTimeout;
    }
  }

  _parseRoute(data) {
    const legsRaw = data?.route?.legs || [];
    const legs = [];
    for (const leg of legsRaw) {
      if (leg.status && leg.status !== 'OK') {
        throw new YandexError(`роутер: участок маршрута не построен (${leg.status})`);
      }
      let distanceM = 0;
      let durationS = 0;
      const coords = [];
      for (const step of leg.steps || []) {
        distanceM += step.length || 0;
        durationS += step.duration || 0;
        const pts = step.polyline?.points || [];
        for (const [lat, lon] of pts) {
          const last = coords[coords.length - 1];
          if (!last || last[0] !== lat || last[1] !== lon) coords.push([lat, lon]);
        }
      }
      legs.push({ distanceM, durationS, coords });
    }
    if (legs.length === 0) throw new YandexError('роутер: пустой ответ');
    return { trafficType: data.traffic_type || null, legs };
  }

  /**
   * Матрица времени/дистанций (с прогнозом пробок).
   * Лимит API — 100 ячеек на запрос, поэтому большие матрицы бьются на блоки.
   * @returns { times[][], lens[][] } (Infinity для несостоявшихся ячеек)
   */
  async matrix(origins, destinations, { departureTime = null } = {}) {
    if (!this.routerKey) throw new YandexError('роутер: не задан YANDEX_ROUTER_KEY');
    const n = origins.length;
    const k = destinations.length;
    const times = Array.from({ length: n }, () => new Array(k).fill(Infinity));
    const lens = Array.from({ length: n }, () => new Array(k).fill(Infinity));

    // не превышаем 100 ячеек на запрос
    const rowsPerReq = Math.max(1, Math.floor(100 / Math.min(k, 100)));
    for (let i0 = 0; i0 < n; i0 += rowsPerReq) {
      const rows = origins.slice(i0, i0 + rowsPerReq);
      const params = new URLSearchParams({
        apikey: this.routerKey,
        origins: rows.map((p) => `${p.lat},${p.lon}`).join('|'),
        destinations: destinations.map((p) => `${p.lat},${p.lon}`).join('|'),
        mode: 'driving',
      });
      if (departureTime) params.set('departure_time', String(Math.floor(departureTime)));
      const data = await this._fetchJson(`${this.routerUrl}/distancematrix?${params}`, { label: 'матрица' });
      const rowsOut = data?.rows || [];
      rows.forEach((_, ri) => {
        const els = rowsOut[ri]?.elements || [];
        els.forEach((cell, ci) => {
          if (ci >= k) return;
          if (cell.status === 'OK' && cell.duration && cell.distance) {
            times[i0 + ri][ci] = cell.duration.value;
            lens[i0 + ri][ci] = cell.distance.value;
          }
        });
      });
    }
    return { times, lens };
  }
}

/** Время следующего выезда в заданный час (unix-секунды, локальное время сервера). */
export function nextDepartureTime(hour, now = new Date()) {
  const d = new Date(now);
  d.setHours(hour, 0, 0, 0);
  if (d <= now) d.setDate(d.getDate() + 1);
  return Math.floor(d.getTime() / 1000);
}
