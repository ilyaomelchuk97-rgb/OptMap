// Эвристический оптимизатор маршрута: GRASP-подобные случайные перестановки +
// жадный «ближайший сосед» + локальные улучшения 2-opt и Or-opt.
//
// Корректно работает с асимметричной матрицей (односторонние дороги, пробки):
//  • Or-opt переносит сегмент без разворота (направление сохраняется);
//  • 2-opt при развороте сегмента пересчитывает внутренние рёбра в обратную
//    сторону по фактическим значениям матрицы.
//
// Старт (точка 0) всегда фиксирован; последняя точка фиксирована при
// endLocked (открытый маршрут «до последней точки»).

import { tourCost } from './common.js';

function mulberry32(seed) {
  let a = seed;
  return function () {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Жадный маршрут «ближайший сосед» из точки 0. */
export function nearestNeighbor(m, { endLocked = false, noise = null } = {}) {
  const n = m.length;
  const used = new Uint8Array(n);
  used[0] = 1;
  const order = [0];
  let cur = 0;
  while (order.length < n) {
    let bestJ = -1;
    let bestC = Infinity;
    for (let j = 1; j < n; j++) {
      if (used[j]) continue;
      if (endLocked && j === n - 1 && order.length < n - 1) continue; // финиш берём последним
      const c = noise ? noise(cur, j) : m[cur][j];
      if (c < bestC) {
        bestC = c;
        bestJ = j;
      }
    }
    if (bestJ === -1) break;
    used[bestJ] = 1;
    order.push(bestJ);
    cur = bestJ;
  }
  return order;
}

/**
 * Or-opt: перенос сегментов длины 1–3 в лучшую позицию без разворота.
 * Старт и (при endLocked) финиш неподвижны; замыкающее ребро не трогается.
 * Возвращает суммарное улучшение.
 */
export function orOpt(m, order, { endLocked = false } = {}) {
  const n = order.length;
  const maxLen = Math.min(3, n - 2);
  let gain = 0;
  let improved = true;
  while (improved) {
    improved = false;
    outer: for (let len = 1; len <= maxLen; len++) {
      for (let i = 1; i + len <= n - 1; i++) {
        const s0 = order[i];
        const s1 = order[i + len - 1];
        const prev = order[i - 1];
        const next = order[i + len];
        const remove = m[prev][s0] + m[s1][next];
        for (let pos = 1; pos <= n - 1; pos++) {
          if (pos >= i && pos <= i + len) continue; // внутрь/на место сегмента нельзя
          const ip = order[pos - 1];
          const inx = order[pos];
          // дельта: новые рёбра (ip→s0, s1→inx, prev→next) минус старые
          // (prev→s0, s1→next, ip→inx); prev→next — смыкание на месте вырезки
          const delta =
            m[ip][s0] + m[s1][inx] + m[prev][next] - remove - m[ip][inx];
          if (delta < -1e-9) {
            const seg = order.splice(i, len);
            const at = pos > i ? pos - len : pos;
            order.splice(at, 0, ...seg);
            gain -= delta;
            improved = true;
            break outer;
          }
        }
      }
    }
  }
  return gain;
}

/** 2-opt: разворот хвоста маршрута (учитывает асимметрию и замыкание тура). */
export function twoOpt(m, order, { roundTrip = true, endLocked = false } = {}) {
  const n = order.length;
  let gain = 0;
  let improved = true;
  while (improved) {
    improved = false;
    for (let i = 1; i < n - 1; i++) {
      for (let k = i + 1; k < n; k++) {
        if (endLocked && k === n - 1) continue; // финиш фиксирован
        const a = order[i - 1], b = order[i];
        const c = order[k];
        const d = k + 1 < n ? order[k + 1] : -1;
        let delta = m[a][c] - m[a][b];
        // внутренние рёбра сегмента меняют направление — берём обратные стоимости
        for (let t = i + 1; t <= k; t++) {
          delta += m[order[t]][order[t - 1]] - m[order[t - 1]][order[t]];
        }
        if (d !== -1) {
          delta += m[b][d] - m[c][d];
        } else if (roundTrip) {
          // замыкающее ребро: было c→order[0], станет b→order[0]
          delta += m[b][0] - m[c][0];
        } else {
          continue; // открытый маршрут: разворот всего хвоста меняет финиш — пропускаем
        }
        if (delta < -1e-9) {
          for (let l = i, r = k; l < r; l++, r--) {
            const tmp = order[l];
            order[l] = order[r];
            order[r] = tmp;
          }
          gain -= delta;
          improved = true;
        }
      }
    }
  }
  return gain;
}

/**
 * Оптимизация порядка точек.
 * @param {number[][]} m — матрица стоимостей
 * @param {object} opts { roundTrip, endLocked, timeLimitMs }
 */
export function heuristicTSP(m, { roundTrip = true, endLocked = false, timeLimitMs = 3000 } = {}) {
  const t0 = Date.now();
  const n = m.length;
  if (n <= 1) return { order: [0], cost: 0, method: 'trivial', elapsedMs: 0 };
  if (n === 2) return { order: [0, 1], cost: tourCost(m, [0, 1], roundTrip), method: 'trivial', elapsedMs: 0 };

  const rnd = mulberry32(0x0b5eed);
  const restarts = n <= 15 ? 16 : n <= 30 ? 10 : 6;
  let bestOrder = null;
  let bestCost = Infinity;

  for (let r = 0; r < restarts; r++) {
    if (Date.now() - t0 > timeLimitMs) break;
    // GRASP: первый прогон — чистый NN, дальше — со «шумом» в матрице
    const noisy = r === 0 ? null : (i, j) => m[i][j] * (0.88 + rnd() * 0.24);
    const order = nearestNeighbor(m, { endLocked, noise: noisy });
    if (order.length < n) continue;
    orOpt(m, order, { endLocked });
    twoOpt(m, order, { roundTrip, endLocked });
    orOpt(m, order, { endLocked });
    const cost = tourCost(m, order, roundTrip);
    if (cost < bestCost) {
      bestCost = cost;
      bestOrder = order.slice();
    }
  }

  // сравнение с тривиальным порядком (как ввели точки)
  const identity = [...Array(n).keys()];
  const identityCost = tourCost(m, identity, roundTrip);
  if (!bestOrder || identityCost < bestCost) {
    bestOrder = identity;
    bestCost = identityCost;
  }

  return {
    order: bestOrder,
    cost: bestCost,
    method: 'NN + 2-opt + Or-opt (мультистарт)',
    elapsedMs: Date.now() - t0,
  };
}
