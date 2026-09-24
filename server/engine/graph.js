// Граф дорожной сети.
//
// Узлы — перекрёстки (lat/lon), рёбра — проезжаемые отрезки улиц с честной
// длиной (по геометрии), ограничением скорости, классом и именем.
// Рёбра направленные: для двухсторонней улицы добавляются два ребра
// (в каждую сторону), для односторонней — одно.

import zlib from 'node:zlib';

export class Graph {
  constructor() {
    this.lat = []; // координаты узлов
    this.lon = [];
    // направленные рёбра (параллельные массивы)
    this.eu = []; // узел-начало
    this.ev = []; // узел-конец
    this.lenM = []; // длина, м
    this.kmh = []; // ограничение скорости, км/ч
    this.clsI = []; // класс дороги (индекс в this.classes)
    this.nameI = []; // имя улицы (индекс в this.names), -1 если нет
    this.shapeOff = [0]; // смещения геометрии в shapeCoords
    this.shapeCoords = []; // плоский массив [lat, lon, ...] по рёбрам
    this.classes = []; // список классов
    this.classIdx = new Map();
    this.names = []; // список имён улиц
    this.nameIdx = new Map();
    this.meta = {
      source: 'unknown',
      sourceName: '',
      builtAt: null,
    };
    // индексы, построенные в build()
    this.outOff = null; // CSR-смещения исходящих рёбер
    this.outEids = null; // исходящие рёбра
    this.edgeKey = null; // Map "u:v" -> edgeId (для проверки обратного ребра)
    this.bbox = null; // [minLat, minLon, maxLat, maxLon]
    this.maxKmh = 60;
    this.shapeOffDirty = false;
  }

  get nodeCount() {
    return this.lat.length;
  }

  get edgeCount() {
    return this.eu.length;
  }

  addNode(lat, lon) {
    const id = this.lat.length;
    this.lat.push(lat);
    this.lon.push(lon);
    return id;
  }

  clsId(cls) {
    let id = this.classIdx.get(cls);
    if (id === undefined) {
      id = this.classes.push(cls) - 1;
      this.classIdx.set(cls, id);
    }
    return id;
  }

  nameId(name) {
    if (!name) return -1;
    let id = this.nameIdx.get(name);
    if (id === undefined) {
      id = this.names.push(name) - 1;
      this.nameIdx.set(name, id);
    }
    return id;
  }

  /**
   * Добавить ребро u→v (и v→u, если не одностороннее).
   * shape — плоский массив [lat, lon, ...] от u к v (включая концы).
   */
  addEdge(u, v, { lenM, kmh, cls, name = null, oneway = false, shape = null }) {
    const ci = this.clsId(cls);
    const ni = this.nameId(name);
    if (!shape) shape = [this.lat[u], this.lon[u], this.lat[v], this.lon[v]];
    this.pushDirected(u, v, lenM, kmh, ci, ni, shape);
    if (!oneway) {
      const rev = [];
      for (let i = shape.length - 2; i >= 0; i -= 2) rev.push(shape[i], shape[i + 1]);
      this.pushDirected(v, u, lenM, kmh, ci, ni, rev);
    }
  }

  pushDirected(u, v, lenM, kmh, ci, ni, shape) {
    this.eu.push(u);
    this.ev.push(v);
    this.lenM.push(lenM);
    this.kmh.push(kmh);
    this.clsI.push(ci);
    this.nameI.push(ni);
    for (let i = 0; i < shape.length; i++) this.shapeCoords.push(shape[i]);
    this.shapeOff.push(this.shapeCoords.length);
  }

  /** Построить индексы после загрузки/генерации. */
  build() {
    const n = this.nodeCount;
    const m = this.edgeCount;
    // CSR-список исходящих рёбер
    this.outOff = new Uint32Array(n + 1);
    for (let e = 0; e < m; e++) this.outOff[this.eu[e] + 1]++;
    for (let i = 0; i < n; i++) this.outOff[i + 1] += this.outOff[i];
    this.outEids = new Uint32Array(m);
    const cursor = Uint32Array.from(this.outOff);
    for (let e = 0; e < m; e++) this.outEids[cursor[this.eu[e]]++] = e;
    // карта "u:v" -> edgeId (проверка наличия обратного ребра)
    this.edgeKey = new Map();
    for (let e = 0; e < m; e++) this.edgeKey.set(this.eu[e] * 4294967296 + this.ev[e], e);
    // bbox
    let minLat = 90, maxLat = -90, minLon = 180, maxLon = -180;
    for (let i = 0; i < n; i++) {
      if (this.lat[i] < minLat) minLat = this.lat[i];
      if (this.lat[i] > maxLat) maxLat = this.lat[i];
      if (this.lon[i] < minLon) minLon = this.lon[i];
      if (this.lon[i] > maxLon) maxLon = this.lon[i];
    }
    this.bbox = [minLat, minLon, maxLat, maxLon];
    this.maxKmh = Math.max(...this.kmh, 10);
    // связность не проверяем здесь — ROUTER сообщает об отсутствии пути
    return this;
  }

  reverseOf(edgeId) {
    return this.edgeKey.get(this.ev[edgeId] * 16777216 + this.eu[edgeId]) ?? null;
  }

  outgoing(nodeId) {
    const from = this.outOff[nodeId], to = this.outOff[nodeId + 1];
    const res = [];
    for (let i = from; i < to; i++) res.push(this.outEids[i]);
    return res;
  }

  shapeOf(edgeId) {
    return this.shapeCoords.slice(this.shapeOff[edgeId], this.shapeOff[edgeId + 1]);
  }

  clsOf(edgeId) {
    return this.classes[this.clsI[edgeId]];
  }

  nameOf(edgeId) {
    const i = this.nameI[edgeId];
    return i >= 0 ? this.names[i] : '';
  }

  serialize() {
    return {
      format: 'optmap-graph',
      version: 1,
      meta: this.meta,
      lat: this.lat,
      lon: this.lon,
      classes: this.classes,
      names: this.names,
      eu: this.eu,
      ev: this.ev,
      lenM: this.lenM.map((x) => Math.round(x * 10) / 10),
      kmh: this.kmh,
      clsI: this.clsI,
      nameI: this.nameI,
      shapeOff: this.shapeOff,
      shapeCoords: this.shapeCoords.map((x) => Math.round(x * 1e7) / 1e7),
      mapData: this.mapData || null,
    };
  }

  static deserialize(obj) {
    if (!obj || obj.format !== 'optmap-graph') {
      throw new Error('Неверный формат файла графа');
    }
    const g = new Graph();
    g.lat = obj.lat;
    g.lon = obj.lon;
    g.classes = obj.classes;
    g.classIdx = new Map(obj.classes.map((c, i) => [c, i]));
    g.names = obj.names;
    g.nameIdx = new Map(obj.names.map((c, i) => [c, i]));
    g.eu = obj.eu;
    g.ev = obj.ev;
    g.lenM = obj.lenM;
    g.kmh = obj.kmh;
    g.clsI = obj.clsI;
    g.nameI = obj.nameI;
    g.shapeOff = obj.shapeOff;
    g.shapeCoords = obj.shapeCoords;
    g.meta = obj.meta || g.meta;
    g.mapData = obj.mapData || null;
    g.build();
    return g;
  }

  static async loadGzip(filePath, fsMod = null) {
    const fs = fsMod || (await import('node:fs/promises'));
    const buf = await fs.readFile(filePath);
    const json = JSON.parse(zlib.gunzipSync(buf).toString('utf8'));
    return Graph.deserialize(json);
  }

  async saveGzip(filePath) {
    const fs = await import('node:fs/promises');
    const buf = zlib.gzipSync(Buffer.from(JSON.stringify(this.serialize())), { level: 6 });
    const dir = filePath.match(/^(.*)\//)?.[1] || '.';
    await fs.mkdir(dir, { recursive: true });
    await fs.writeFile(filePath, buf);
  }
}
