// Тесты движка: маршрутизация, односторонние дороги, привязка точек, пробки, трафик.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Graph } from '../server/engine/graph.js';
import { TrafficModel } from '../server/engine/traffic.js';
import { SnapIndex } from '../server/engine/snap.js';
import { Router } from '../server/engine/router.js';

function lineGraph() {
  const g = new Graph();
  // прямая улица ~3.3 км: A(0,0) -> B(0,0.015) -> C(0,0.03), 60 км/ч
  // 0.015° долготы = 1669.8 м — lenM согласован с геометрией
  const a = g.addNode(0, 0);
  const b = g.addNode(0, 0.015);
  const c = g.addNode(0, 0.03);
  g.addEdge(a, b, { lenM: 1669.8, kmh: 60, cls: 'secondary', shape: [0, 0, 0, 0.015] });
  g.addEdge(b, c, { lenM: 1669.8, kmh: 60, cls: 'secondary', shape: [0, 0.015, 0, 0.03] });
  g.build();
  return g;
}

test('маршрут по прямой улице: длина и время по ограничению скорости', () => {
  const g = lineGraph();
  const traffic = new TrafficModel();
  const snap = new SnapIndex(g).build();
  const router = new Router(g, traffic);
  const r = router.route(snap.snap(0, 0.001), snap.snap(0, 0.029), { mode: 'time', trafficOn: false });
  assert.ok(r, 'путь найден');
  assert.ok(Math.abs(r.distanceM - 3339) < 40, `длина ~3339 м, получено ${r.distanceM}`);
  // 3.34 км на 60 км/ч = 200 с
  assert.ok(Math.abs(r.durationS - 200) < 4, `время ~200 с, получено ${r.durationS}`);
});

test('односторонняя дорога: объезд или отсутствие пути', () => {
  const g = new Graph();
  const a = g.addNode(0, 0);
  const b = g.addNode(0, 0.015);
  g.addEdge(a, b, { lenM: 1669.8, kmh: 60, cls: 'secondary', oneway: true, shape: [0, 0, 0, 0.015] });
  g.build();
  const snap = new SnapIndex(g).build();
  const router = new Router(g, new TrafficModel());
  // путь "против" одностороннего — невозможен (нельзя развернуться)
  const r = router.route(snap.snap(0, 0.01), snap.snap(0, 0.002), {});
  assert.equal(r, null, 'пути против одностороннего нет');
  const r2 = router.route(snap.snap(0, 0.002), snap.snap(0, 0.01), {});
  assert.ok(r2, 'путь по ходу одностороннего есть');
});

test('двусторонняя дорога позволяет движение в обе стороны', () => {
  const g = lineGraph();
  const snap = new SnapIndex(g).build();
  const router = new Router(g, new TrafficModel());
  const back = router.route(snap.snap(0, 0.029), snap.snap(0, 0.001), {});
  assert.ok(back, 'обратный путь существует');
  assert.ok(Math.abs(back.distanceM - 3339) < 40, `длина ~3339 м, получено ${back.distanceM}`);
});

test('пробки: в час пик время больше, ночью — свободное', () => {
  const g = lineGraph();
  const snap = new SnapIndex(g).build();
  const router = new Router(g, new TrafficModel());
  const night = router.route(snap.snap(0, 0), snap.snap(0, 0.03), { departHour: 3, trafficOn: true });
  const rush = router.route(snap.snap(0, 0), snap.snap(0, 0.03), { departHour: 8, trafficOn: true });
  assert.ok(rush.durationS > night.durationS * 1.3, `пик (${rush.durationS}с) должен быть заметно дольше ночи (${night.durationS}с)`);
});

test('TrafficModel: коэффициенты в разумных пределах', () => {
  const t = new TrafficModel();
  const night = t.factor('arterial', 3, false);
  const peak = t.factor('arterial', 8, false);
  assert.ok(night > peak, 'ночь свободнее пика');
  assert.ok(t.minFactor >= 0.15 && t.minFactor < 0.7);
  assert.equal(t.factor('motorway', 12, true), t.factor('motorway', 12, true), 'детерминированность');
});

test('снап: точка рядом с ребром проецируется с точностью до метров', () => {
  const g = lineGraph();
  const snap = new SnapIndex(g).build();
  const s = snap.snap(0.0005, 0.0225); // ~56 м сбоку от середины второго ребра
  assert.ok(s, 'снап найден');
  assert.ok(s.distM < 70, `расстояние ~56 м, получено ${s.distM}`);
  assert.ok(Math.abs(s.t - 0.5) < 0.06, `проекция в середине ребра, t=${s.t}`);
});

test('сериализация графа: полный кругооборот', async () => {
  const g = lineGraph();
  const json = g.serialize();
  const g2 = Graph.deserialize(JSON.parse(JSON.stringify(json)));
  assert.equal(g2.nodeCount, g.nodeCount);
  assert.equal(g2.edgeCount, g.edgeCount);
  const snap = new SnapIndex(g2).build();
  const r = new Router(g2, new TrafficModel()).route(snap.snap(0, 0), snap.snap(0, 0.03), {});
  assert.ok(r && Math.abs(r.distanceM - 3339) < 40, `длина ~3339 м, получено ${r?.distanceM}`);
});

test('синтетический демо-город: связный, с разумными скоростями', async () => {
  const { generateSyntheticCity } = await import('../server/engine/synthetic.js');
  const g = generateSyntheticCity();
  assert.ok(g.nodeCount > 200, 'город нетривиальный');
  assert.ok(g.maxKmh >= 90, 'есть магистраль');
  // связность: из центра достигается большинство узлов
  const snap = new SnapIndex(g).build();
  const router = new Router(g, new TrafficModel());
  // 4 точки по краям города
  const pts = [
    [53.9045, 27.5615], [53.94, 27.60], [53.87, 27.52], [53.895, 27.63],
  ];
  const snaps = pts.map(([lat, lon]) => snap.snap(lat, lon, 600));
  const mx = router.matrix(snaps, { trafficOn: false });
  assert.equal(mx.unreachable.length, 0, 'город должен быть связным: ' + JSON.stringify(mx.unreachable));
});
