// Адаптер Nominatim — геокодер OpenStreetMap (OSM-native, без ключей).
//
// https://nominatim.openstreetmap.org/search?q=…&format=jsonv2
// Политика использования: обязателен корректный User-Agent, не более 1 запроса/сек.
// Используется как адресный поиск, когда локального поиска по графу мало;
// при недоступности — вызывающий код делает фолбэк (граф/Яндекс).

export class NominatimError extends Error {
  constructor(message, { status = null } = {}) {
    super(message);
    this.name = 'NominatimError';
    this.status = status;
  }
}

export class NominatimAdapter {
  constructor({
    url = 'https://nominatim.openstreetmap.org',
    userAgent = 'OptMap/0.1 (self-hosted route optimizer; OSM data)',
    timeoutMs = 10000,
    fetchImpl = null,
  } = {}) {
    this.url = url.replace(/\/$/, '');
    this.userAgent = userAgent;
    this.timeoutMs = timeoutMs;
    this._fetch = fetchImpl || fetch.bind(globalThis);
  }

  get enabled() {
    return Boolean(this.url);
  }

  async _fetchJson(url) {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), this.timeoutMs);
    try {
      const r = await this._fetch(url, { signal: ctrl.signal, headers: { 'User-Agent': this.userAgent } });
      if (!r.ok) throw new NominatimError(`HTTP ${r.status}`, { status: r.status });
      return await r.json();
    } catch (e) {
      if (e instanceof NominatimError) throw e;
      const why = e.name === 'AbortError' ? `таймаут ${this.timeoutMs} мс` : e.message;
      throw new NominatimError(why);
    } finally {
      clearTimeout(timer);
    }
  }

  /**
   * Поиск адреса/улицы/POI.
   * @returns [{name, fullName, lat, lon, cls, source:'osm-nominatim'}]
   */
  async geocode(q, { lat = null, lon = null, limit = 8 } = {}) {
    const params = new URLSearchParams({
      q: String(q),
      format: 'jsonv2',
      addressdetails: '1',
      namedetails: '1',
      limit: String(Math.min(10, Math.max(1, limit))),
      'accept-language': 'ru',
    });
    if (lat !== null && lon !== null) {
      // viewbox вокруг области интереса (не строго: bounded=0)
      const dLat = 0.5, dLon = 0.5;
      params.set('viewbox', `${lon - dLon},${lat + dLat},${lon + dLon},${lat - dLat}`);
      params.set('bounded', '0');
    }
    const data = await this._fetchJson(`${this.url}/search?${params}`);
    if (!Array.isArray(data)) throw new NominatimError('неожиданный формат ответа');
    return data.map((item) => {
      const addr = item.address || {};
      const shortName =
        item.namedetails?.name ||
        addr.road ||
        addr.pedestrian ||
        addr.hamlet ||
        addr.village ||
        addr.town ||
        addr.city ||
        String(item.display_name || '').split(',')[0];
      return {
        name: shortName,
        fullName: item.display_name || shortName,
        lat: Number(item.lat),
        lon: Number(item.lon),
        cls: item.type || item.category || 'obj',
        source: 'osm-nominatim',
      };
    }).filter((p) => Number.isFinite(p.lat) && Number.isFinite(p.lon));
  }

  /** Обратное геокодирование: координаты → адрес. */
  async reverse(lat, lon) {
    const params = new URLSearchParams({
      lat: String(lat),
      lon: String(lon),
      format: 'jsonv2',
      addressdetails: '1',
      namedetails: '1',
      zoom: '17',
      'accept-language': 'ru',
    });
    const item = await this._fetchJson(`${this.url}/reverse?${params}`);
    if (!item || item.error) return null;
    const addr = item.address || {};
    const shortName =
      item.namedetails?.name ||
      addr.road ||
      addr.pedestrian ||
      [addr.house_number, addr.road].filter(Boolean).join(', ') ||
      String(item.display_name || '').split(',')[0];
    return {
      name: shortName,
      fullName: item.display_name || shortName,
      lat,
      lon,
      cls: item.type || item.category || 'obj',
      source: 'osm-nominatim',
    };
  }
}
