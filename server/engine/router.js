// Маршрутизатор: поиск быстрейшего/кратчайшего пути на графе.
//
// Особенности:
//  • A* с гео-эвристикой (допустимая нижняя оценка по прямой);
//  • точки привязываются к произвольному месту ребра (виртуальный старт/финиш),
//    а не к ближайшему перекрёстку — километраж честный, с точностью до метров;
//  • односторонние дороги; время = длина / (maxspeed × загрузка (пробки));
//  • matrix() — асимметричные матрицы времени/дистанций для оптимизатора.

import { MinHeap } from '../util/heap.js';
import { haversineM } from '../util/geo.js';

const INF = Infinity;

export class Router {
  constructor(graph, traffic) {
    this.g = graph;
    this.traffic = traffic;
  }

  /** Множители скорости по классам дорог для заданного часа. */
  classFactors(hour, isWeekend) {
    return this.g.classes.map((c) => this.traffic.factor(this.traffic.group(c), hour, isWeekend));
  }

  /** Стоимость прохождения ребра целиком (секунды или метры). */
  _edgeCost(e, mode, factors, trafficOn) {
    const len = this.g.lenM[e];
    if (mode === 'distance') return len;
    const f = trafficOn ? factors[this.g.clsI[e]] : 1;
    const kmh = Math.max(2, this.g.kmh[e] * f);
    return (len * 3.6) / kmh; // секунды
  }

  /**
   * Путь между двумя привязанными точками.
   * Опции: { mode: 'time'|'distance', departHour: 0–23|null, trafficOn: bool, isWeekend: bool }
   * Возвращает { durationS, distanceM, coords } или null, если пути нет.
   */
  route(sa, sb, opts = {}) {
    const { mode = 'time', departHour = null, trafficOn = true, isWeekend = false } = opts;
    if (sa.edgeId === sb.edgeId && Math.abs(sa.t - sb.t) < 1e-9) {
      return { durationS: 0, distanceM: 0, coords: [[sa.lat, sa.lon]] };
    }
    const g = this.g;
    const n = g.nodeCount;
    const factors = this.classFactors(departHour ?? new Date().getHours(), isWeekend);
    const costOf = (e) => this._edgeCost(e, mode, factors, trafficOn);
    const scale = mode === 'time'
      ? 3.6 / Math.max(5, g.maxKmh * (trafficOn ? this.traffic.minFactor : 1))
      : 1;

    const cost = new Float64Array(n).fill(INF);
    const prevE = new Int32Array(n).fill(-1);
    const settled = new Uint8Array(n);
    const heap = new MinHeap();
    const h = (node) => haversineM(g.lat[node], g.lon[node], sb.lat, sb.lon) * scale * 0.999;

    const se = sa.edgeId;
    const revS = g.reverseOf(se);
    const te = sb.edgeId;
    const tu = g.eu[te];
    const tv = g.ev[te];
    const revT = g.reverseOf(te);

    let bestCost = INF;
    let bestViaRev = false;
    let sameEdge = false;

    // старт и финиш лежат на одном ребре, финиш дальше по ходу
    if (se === te && sb.t >= sa.t) {
      bestCost = (sb.t - sa.t) * costOf(se);
      sameEdge = true;
    }

    const relax = (node, c, pe) => {
      if (c < cost[node]) {
        cost[node] = c;
        prevE[node] = pe;
        heap.push(c + h(node), node);
      }
    };

    // виртуальный старт: точка на ребре se (u→v) в доле sa.t
    const seedV = g.ev[se];
    relax(seedV, (1 - sa.t) * costOf(se), se);
    if (revS !== null) relax(g.eu[se], sa.t * costOf(revS), revS);

    while (heap.size > 0) {
      const { key, val: node } = heap.pop();
      if (settled[node]) continue;
      if (key - h(node) >= bestCost) break; // дальше оптимально дешевле не станет
      settled[node] = true;

      if (node === tu) {
        const c = cost[node] + sb.t * costOf(te);
        if (c < bestCost) { bestCost = c; bestViaRev = false; }
      }
      if (node === tv && revT !== null) {
        const c = cost[node] + (1 - sb.t) * costOf(revT);
        if (c < bestCost) { bestCost = c; bestViaRev = true; }
      }

      const from = g.outOff[node], to = g.outOff[node + 1];
      for (let i = from; i < to; i++) {
        const e = g.outEids[i];
        const w = g.ev[e];
        if (settled[w]) continue;
        relax(w, cost[node] + costOf(e), e);
      }
    }

    if (bestCost === INF) return null;

    // --- восстановление геометрии ---
    const coords = [[sa.lat, sa.lon]];
    const edges = [];
    const partials = []; // { edgeId, t0, t1, reverse } — куски рёбер для времени

    if (sameEdge) {
      pushPartial(coords, g, se, sa.t, sb.t, false);
      partials.push({ edgeId: se, t0: sa.t, t1: sb.t });
    } else {
      // цепочка рёбер от финального узла назад, пока не дойдём до виртуального старта
      const chain = [];
      let cur = bestViaRev ? tv : tu;
      while (cur !== -1) {
        const pe = prevE[cur];
        if (pe === -1) break;
        chain.push(pe);
        if (pe === se || pe === revS) break;
        cur = g.eu[pe];
      }
      chain.reverse();
      const firstE = chain[0];
      if (firstE === se) {
        pushPartial(coords, g, se, sa.t, 1, false);
        partials.push({ edgeId: se, t0: sa.t, t1: 1 });
      } else if (revS !== undefined && firstE === revS) {
        pushPartial(coords, g, se, 0, sa.t, true);
        partials.push({ edgeId: se, t0: 0, t1: sa.t });
      }
      for (const e of chain) {
        edges.push(e);
        const shape = g.shapeOf(e);
        for (let j = 2; j < shape.length; j += 2) {
          coords.push([shape[j], shape[j + 1]]);
        }
      }
      if (bestViaRev) {
        pushPartial(coords, g, te, sb.t, 1, true);
        partials.push({ edgeId: te, t0: sb.t, t1: 1 });
      } else {
        pushPartial(coords, g, te, 0, sb.t, false);
        partials.push({ edgeId: te, t0: 0, t1: sb.t });
      }
    }
    coords.push([sb.lat, sb.lon]);

    const clean = [];
    for (const c of coords) {
      const last = clean[clean.length - 1];
      if (!last || last[0] !== c[0] || last[1] !== c[1]) clean.push(c);
    }

    // честные метры — по фактической геометрии пути
    let distanceM = 0;
    for (let i = 0; i + 1 < clean.length; i++) {
      distanceM += haversineM(clean[i][0], clean[i][1], clean[i + 1][0], clean[i + 1][1]);
    }

    // время — по рёбрам пути (с учётом загрузки, если mode=time)
    let durationS = 0;
    if (mode === 'time') {
      durationS = bestCost;
    } else {
      const timeOfPiece = (edgeId, t0, t1) => {
        const len = g.lenM[edgeId] * Math.abs(t1 - t0);
        return (len * 3.6) / Math.max(2, g.kmh[edgeId]);
      };
      for (const e of edges) durationS += (g.lenM[e] * 3.6) / Math.max(2, g.kmh[e]);
      for (const p of partials) durationS += timeOfPiece(p.edgeId, p.t0, p.t1);
      // частичные куски в mode=distance не входят в edges — добавили через partials
    }

    return {
      durationS: Math.round(durationS * 10) / 10,
      distanceM: Math.round(distanceM),
      coords: clean,
    };
  }

  /**
   * Матрица времени/дистанций между k точками (асимметричная из-за односторонних).
   * Возвращает { times[][], lens[][], unreachable: [[i,j],...] }.
   */
  matrix(snaps, opts = {}) {
    const { mode = 'time', departHour = null, trafficOn = true, isWeekend = false } = opts;
    const g = this.g;
    const k = snaps.length;
    const factors = this.classFactors(departHour ?? new Date().getHours(), isWeekend);
    const times = Array.from({ length: k }, () => new Float64Array(k).fill(INF));
    const lens = Array.from({ length: k }, () => new Float64Array(k).fill(INF));
    for (let i = 0; i < k; i++) {
      times[i][i] = 0;
      lens[i][i] = 0;
      this._matrixRow(i, snaps, { mode, factors, trafficOn, isWeekend, times, lens });
    }
    const unreachable = [];
    for (let i = 0; i < k; i++) {
      for (let j = 0; j < k; j++) {
        if (i !== j && !isFinite(times[i][j]) && !isFinite(lens[i][j])) unreachable.push([i, j]);
      }
    }
    return { times, lens, unreachable };
  }

  /** Одна строка матрицы: Дейкстра из точки i во все остальные. */
  _matrixRow(i, snaps, { mode, factors, trafficOn, times, lens }) {
    const g = this.g;
    const n = g.nodeCount;
    const k = snaps.length;
    const costOf = (e) => this._edgeCost(e, mode, factors, trafficOn);

    const cost = new Float64Array(n).fill(INF);
    const accOther = new Float64Array(n); // вторая метрика вдоль оптимального пути
    const settled = new Uint8Array(n);
    const heap = new MinHeap();

    const te = snaps.map((s) => s.edgeId);
    const tu = te.map((e) => g.eu[e]);
    const tv = te.map((e) => g.ev[e]);
    const revT = te.map((e) => g.reverseOf(e));
    const best = new Float64Array(k).fill(INF);
    const bestOther = new Float64Array(k).fill(INF);

    const se = sa_edge(g, i, snaps);
    const revS = g.reverseOf(se);
    const sa = snaps[i];

    const relax = (node, c, other) => {
      if (c < cost[node]) {
        cost[node] = c;
        accOther[node] = other;
        heap.push(c, node);
      }
    };

    // частичная стоимость куска ребра вдоль (other — поперечная метрика того же куска)
    const piece = (e, t0, t1) => {
      const frac = Math.abs(t1 - t0);
      return mode === 'time'
        ? { c: (g.lenM[e] * frac * 3.6) / Math.max(2, g.kmh[e] * (trafficOn ? factors[g.clsI[e]] : 1)), o: g.lenM[e] * frac }
        : { c: g.lenM[e] * frac, o: (g.lenM[e] * frac * 3.6) / Math.max(2, g.kmh[e]) };
    };

    // прямое попадание: финиш j на том же ребре, дальше по ходу
    for (let j = 0; j < k; j++) {
      if (j === i) continue;
      if (se === te[j] && snaps[j].t >= sa.t) {
        const p = piece(se, sa.t, snaps[j].t);
        if (p.c < best[j]) { best[j] = p.c; bestOther[j] = p.o; }
      }
    }

    const seedV = g.ev[se];
    {
      const p = piece(se, sa.t, 1);
      relax(seedV, p.c, p.o);
    }
    if (revS !== null) {
      const p = piece(se, 0, sa.t);
      relax(g.eu[se], p.c, p.o);
    }

    // регистрация целевых точек: попали в узел — можно закончить куском ребра
    const targetSet = new Map();
    const addTarget = (node, j, addC, addO) => {
      let arr = targetSet.get(node);
      if (!arr) targetSet.set(node, (arr = []));
      arr.push([j, addC, addO]);
    };
    for (let j = 0; j < k; j++) {
      if (j === i) continue;
      {
        const p = piece(te[j], 0, snaps[j].t);
        addTarget(tu[j], j, p.c, p.o);
      }
      if (revT[j] !== null) {
        const p = piece(te[j], snaps[j].t, 1);
        addTarget(tv[j], j, p.c, p.o);
      }
    }

    let foundCount = best[0] !== undefined ? 0 : 0;
    for (let j = 0; j < k; j++) if (j !== i && best[j] !== INF) foundCount++;
    const totalTargets = k - 1;
    let minBest = INF;

    while (heap.size > 0) {
      const { val: node } = heap.pop();
      if (settled[node]) continue;
      settled[node] = true;

      const arr = targetSet.get(node);
      if (arr) {
        for (const [j, addC, addO] of arr) {
          const c = cost[node] + addC;
          if (c < best[j]) {
            if (best[j] === INF) foundCount++;
            best[j] = c;
            bestOther[j] = accOther[node] + addO;
            if (mode === 'time') {
              times[i][j] = c;
              lens[i][j] = bestOther[j];
            } else {
              lens[i][j] = c;
              times[i][j] = bestOther[j];
            }
            if (c < minBest) minBest = c;
          }
        }
      }

      const from = g.outOff[node], to = g.outOff[node + 1];
      for (let idx = from; idx < to; idx++) {
        const e = g.outEids[idx];
        const w = g.ev[e];
        if (settled[w]) continue;
        const p = piece(e, 0, 1);
        relax(w, cost[node] + p.c, accOther[node] + p.o);
      }

      // ранний выход: всё найдено, дешевле не станет
      if (foundCount === totalTargets && heap.size > 0 && heap.keys[0] >= minBest) break;
    }
  }
}

function sa_edge(g, i, snaps) {
  void g;
  return snaps[i].edgeId;
}

/** Длина полилинии [[lat,lon],...] в метрах. */
export function pathLengthM(coords) {
  let s = 0;
  for (let i = 0; i + 1 < coords.length; i++) {
    s += haversineM(coords[i][0], coords[i][1], coords[i + 1][0], coords[i + 1][1]);
  }
  return s;
}

/** Кусок геометрии ребра между долями t0..t1 (reverse — в обратном порядке). */
function pushPartial(coords, g, edgeId, t0, t1, reverse) {
  const shape = g.shapeOf(edgeId);
  const segs = [];
  let total = 0;
  for (let i = 0; i + 3 < shape.length; i += 2) {
    const l = haversineM(shape[i], shape[i + 1], shape[i + 2], shape[i + 3]);
    segs.push(l);
    total += l;
  }
  if (total === 0) return;
  const a = Math.min(t0, t1), b = Math.max(t0, t1);
  const pts = [];
  for (let s = 0, acc = 0; s < segs.length; s++) {
    const s0 = acc / total, s1 = (acc + segs[s]) / total;
    if (s1 > a && s0 < b) {
      const tA = Math.max(0, (a - s0) / (s1 - s0));
      const tB = Math.min(1, (b - s0) / (s1 - s0));
      pts.push([
        shape[s * 2] + (shape[s * 2 + 2] - shape[s * 2]) * tA,
        shape[s * 2 + 1] + (shape[s * 2 + 3] - shape[s * 2 + 1]) * tA,
      ]);
      if (tB >= 1) pts.push([shape[s * 2 + 2], shape[s * 2 + 3]]);
    }
    acc += segs[s];
  }
  if (reverse) pts.reverse();
  for (const p of pts) coords.push(p);
}
