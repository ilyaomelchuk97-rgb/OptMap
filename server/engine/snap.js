// Привязка произвольной точки (клика на карте) к ближайшему ребру дорожного графа.
//
// Точка проецируется на геометрию ребра: получаем edgeId + параметр t (0..1 — доля
// длины ребра от начального узла). Так километраж считается честно — с точностью
// до метров, а не «до ближайшего перекрёстка».

import { haversineM, projectOnSegment } from '../util/geo.js';

export class SnapIndex {
  constructor(graph, cellDeg = 0.0045) {
    this.g = graph;
    this.cell = cellDeg; // ~500 м
    this.cells = new Map(); // "ix:iy" -> [edgeId...]
  }

  build() {
    const g = this.g;
    for (let e = 0; e < g.edgeCount; e++) {
      const shape = g.shapeOf(e);
      let minLat = 90, maxLat = -90, minLon = 180, maxLon = -180;
      for (let i = 0; i < shape.length; i += 2) {
        if (shape[i] < minLat) minLat = shape[i];
        if (shape[i] > maxLat) maxLat = shape[i];
        if (shape[i + 1] < minLon) minLon = shape[i + 1];
        if (shape[i + 1] > maxLon) maxLon = shape[i + 1];
      }
      const ix0 = Math.floor(minLon / this.cell), ix1 = Math.floor(maxLon / this.cell);
      const iy0 = Math.floor(minLat / this.cell), iy1 = Math.floor(maxLat / this.cell);
      for (let iy = iy0; iy <= iy1; iy++) {
        for (let ix = ix0; ix <= ix1; ix++) {
          const key = ix + ':' + iy;
          let arr = this.cells.get(key);
          if (!arr) this.cells.set(key, (arr = []));
          arr.push(e);
        }
      }
    }
    return this;
  }

  /**
   * Привязать точку к дорожной сети.
   * maxM — максимальный радиус поиска (м).
   * Возвращает { edgeId, t, lat, lon, distM } или null.
   */
  snap(lat, lon, maxM = 400) {
    const g = this.g;
    const cx = Math.floor(lon / this.cell);
    const cy = Math.floor(lat / this.cell);
    const cellM = this.cell * 111320;
    const rMax = Math.ceil(maxM / cellM);
    let best = null;
    const seen = new Set();
    // расширяем поиск кольцами ячеек, пока не превысим радиус
    for (let r = 0; r <= rMax; r++) {
      for (let iy = cy - r; iy <= cy + r; iy++) {
        for (let ix = cx - r; ix <= cx + r; ix++) {
          // только периметр кольца (внутренние уже смотрели)
          if (r > 0 && Math.abs(ix - cx) !== r && Math.abs(iy - cy) !== r) continue;
          const arr = this.cells.get(ix + ':' + iy);
          if (!arr) continue;
          for (const e of arr) {
            if (seen.has(e)) continue;
            seen.add(e);
            const cand = this.projectOnEdge(e, lat, lon);
            if (cand && (!best || cand.distM < best.distM)) best = cand;
          }
        }
      }
      // если нашли что-то ближе, чем внешний радиус кольца — хватит
      if (best && best.distM < r * cellM) break;
    }
    if (!best || best.distM > maxM) return null;
    return best;
  }

  /** Проецирование точки на ребро с учётом полилинии. */
  projectOnEdge(edgeId, lat, lon) {
    const g = this.g;
    const shape = g.shapeOf(edgeId);
    let total = 0;
    const segLens = [];
    for (let i = 0; i + 3 < shape.length; i += 2) {
      const l = haversineM(shape[i], shape[i + 1], shape[i + 2], shape[i + 3]);
      segLens.push(l);
      total += l;
    }
    if (total === 0) return null;
    let acc = 0;
    let bestSeg = null;
    for (let i = 0, s = 0; i + 3 < shape.length; i += 2, s++) {
      const p = projectOnSegment(lat, lon, shape[i], shape[i + 1], shape[i + 2], shape[i + 3]);
      if (!bestSeg || p.distM < bestSeg.p.distM) {
        bestSeg = { p, accBefore: acc, segLen: segLens[s], i };
      }
      acc += segLens[s];
    }
    const t = (bestSeg.accBefore + bestSeg.p.t * bestSeg.segLen) / total;
    return {
      edgeId,
      t,
      lat: bestSeg.p.projLat,
      lon: bestSeg.p.projLon,
      distM: bestSeg.p.distM,
    };
  }
}
