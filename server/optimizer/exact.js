// Точный алгоритм Хелда-Карпа (динамическое программирование по подмножествам)
// для задачи коммивояжёра. Применяется при малом числе точек.
//
// Матрица может быть асимметричной (односторонние дороги, пробки) — алгоритм
// это учитывает: cost(i→j) = m[i][j].

import { tourCost } from './common.js';

const INF = Infinity;

/**
 * @param {number[][]} m  матрица стоимостей (m[i][j] — из i в j)
 * @param {object} opts { roundTrip: boolean, endLocked: boolean }
 *   Старт всегда фиксирован — точка 0.
 *   roundTrip=true  → замкнутый маршрут (возврат в точку 0);
 *   endLocked=true  → открытый маршрут, финиш строго в последней точке.
 */
export function heldKarp(m, { roundTrip = true, endLocked = false } = {}) {
  const n = m.length;
  if (n === 0) return null;
  if (n === 1) return { order: [0], cost: 0 };

  const FULL = 1 << n;
  // dp[mask][i] — минимальная стоимость пути из 0 в i, проходящего ровно по mask
  const size = FULL * n;
  const dp = new Float64Array(size).fill(INF);
  const parent = new Int32Array(size).fill(-1);

  for (let i = 1; i < n; i++) {
    dp[(1 << i) * n + i] = m[0][i];
  }

  for (let mask = 1; mask < FULL; mask++) {
    if (mask & 1) continue; // старт (точка 0) никогда не входит в маску
    for (let i = 0; i < n; i++) {
      if (!(mask & (1 << i))) continue;
      const cur = dp[mask * n + i];
      if (cur === INF) continue;
      for (let j = 1; j < n; j++) {
        if (mask & (1 << j)) continue;
        const nm = mask | (1 << j);
        const c = cur + m[i][j];
        const idx = nm * n + j;
        if (c < dp[idx]) {
          dp[idx] = c;
          parent[idx] = mask * n + i;
        }
      }
    }
  }

  const full = (FULL - 1) & ~1; // все точки, кроме стартовой (бит 0)
  let best = INF;
  let bestEnd = -1;
  for (let i = 1; i < n; i++) {
    let c = dp[full * n + i];
    if (c === INF) continue;
    if (roundTrip) c += m[i][0];
    else if (endLocked && i !== n - 1) continue;
    if (c < best) {
      best = c;
      bestEnd = i;
    }
  }
  if (bestEnd === -1) return null;

  // восстановление порядка
  const order = [];
  let idx = full * n + bestEnd;
  while (idx !== -1) {
    order.push(idx % n);
    idx = parent[idx];
  }
  order.reverse(); // [0, ...rest]
  if (order[0] !== 0) order.unshift(0);
  return { order, cost: tourCost(m, order, roundTrip) };
}
