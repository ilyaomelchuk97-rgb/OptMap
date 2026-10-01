// Тесты оптимизатора порядка точек.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { heldKarp } from '../server/optimizer/exact.js';
import { heuristicTSP } from '../server/optimizer/heuristic.js';
import { optimizeOrder } from '../server/optimizer/index.js';
import { tourCost } from '../server/optimizer/common.js';

/** Полный перебор — эталон для тестов. */
function bruteForce(m, { roundTrip = true, endLocked = false } = {}) {
  const n = m.length;
  const perm = (arr) => {
    if (arr.length <= 1) return [arr];
    const out = [];
    for (let i = 0; i < arr.length; i++) {
      const rest = [...arr.slice(0, i), ...arr.slice(i + 1)];
      for (const p of perm(rest)) out.push([arr[i], ...p]);
    }
    return out;
  };
  let best = Infinity;
  const middle = [...Array(n).keys()].slice(1, endLocked ? n - 1 : n);
  const tails = endLocked ? [[n - 1]] : [[]];
  for (const p of perm(middle)) {
    for (const tail of tails) {
      const order = [0, ...p, ...tail];
      best = Math.min(best, tourCost(m, order, roundTrip));
    }
  }
  return best;
}

// Классическая асимметричная матрица (из литературы по TSP, 5 городов)
const ASYM = [
  [0, 12, 10, 19, 8],
  [12, 0, 3, 7, 2],
  [10, 3, 0, 6, 20],
  [19, 7, 6, 0, 4],
  [8, 2, 20, 4, 0],
];

test('Хелд-Карп находит оптимум замкнутого тура (асимметричная матрица)', () => {
  const r = heldKarp(ASYM, { roundTrip: true });
  assert.ok(r, 'результат не должен быть null');
  assert.equal(Math.round(r.cost), bruteForce(ASYM, { roundTrip: true }));
  assert.equal(r.order[0], 0, 'старт из точки 0');
  // порядок корректен: все точки по одному разу
  assert.deepEqual([...r.order].sort(), [0, 1, 2, 3, 4]);
});

test('Хелд-Карп: открытый маршрут с фиксированным финишем', () => {
  const r = heldKarp(ASYM, { roundTrip: false, endLocked: true });
  assert.equal(r.order[r.order.length - 1], 4, 'финиш в последней точке');
  assert.equal(Math.round(r.cost), bruteForce(ASYM, { roundTrip: false, endLocked: true }));
});

test('Эвристика достигает оптимума на малой матрице', () => {
  const r = heuristicTSP(ASYM, { roundTrip: true });
  assert.equal(Math.round(r.cost), bruteForce(ASYM, { roundTrip: true }));
});

test('Диспетчер: до 12 точек — точный алгоритм', () => {
  const r = optimizeOrder(ASYM, { roundTrip: true });
  assert.match(r.method, /точный/);
});

test('Эвристика на 40 точках не хуже жадного исходного порядка', () => {
  // псевдослучайные "города" на плоскости
  let seed = 42;
  const rnd = () => {
    seed = (seed * 1103515245 + 12345) % 2147483648;
    return seed / 2147483648;
  };
  const n = 40;
  const pts = Array.from({ length: n }, () => [rnd() * 100, rnd() * 100]);
  const m = pts.map((a) => pts.map((b) => Math.hypot(a[0] - b[0], a[1] - b[1]) + 0.5)); // +0.5 асимметрия не нужна, добавим
  for (let i = 0; i < n; i++) for (let j = 0; j < n; j++) if (i !== j) m[i][j] += (i + j) % 3; // лёгкая асимметрия
  const r = heuristicTSP(m, { roundTrip: true, timeLimitMs: 4000 });
  const identity = tourCost(m, [...Array(n).keys()], true);
  assert.ok(r.cost <= identity, `эвристика (${r.cost.toFixed(1)}) должна быть не хуже исходного порядка (${identity.toFixed(1)})`);
  // порядок — валидная перестановка
  assert.deepEqual([...r.order].sort((a, b) => a - b), [...Array(n).keys()]);
});

test('tourCost учитывает замыкание', () => {
  const m = [
    [0, 1, 100],
    [1, 0, 1],
    [1, 100, 0],
  ];
  // открытый: 0→1→2 = 1 + 1 = 2
  assert.equal(tourCost(m, [0, 1, 2], false), 2);
  // замкнутый: + ребро 2→0 = 1 → итого 3
  assert.equal(tourCost(m, [0, 1, 2], true), 3);
});
