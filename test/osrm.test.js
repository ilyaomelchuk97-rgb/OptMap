// Тесты адаптера OSRM — на мок-запросах (без сети).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { OsrmAdapter, OsrmError } from '../server/adapters/osrm.js';

function mockFetch(routes) {
  return async (url) => {
    for (const [pattern, resp] of Object.entries(routes)) {
      if (url.includes(pattern)) {
        return {
          ok: resp.__status === undefined,
          status: resp.__status ?? 200,
          json: async () => resp,
        };
      }
    }
    return { ok: false, status: 404, json: async () => ({}) };
  };
}

test('OSRM route: разбор ног и GeoJSON → [lat, lon]', async () => {
  const osrm = new OsrmAdapter({
    fetchImpl: mockFetch({
      '/route/v1/': {
        code: 'Ok',
        routes: [
          {
            legs: [
              {
                distance: 1500.4,
                duration: 180.2,
                geometry: { coordinates: [[27.56, 53.9], [27.57, 53.91], [27.58, 53.92]] },
              },
              {
                distance: 2500,
                duration: 300,
                geometry: { coordinates: [[27.58, 53.92], [27.60, 53.93]] },
              },
            ],
          },
        ],
      },
    }),
  });
  const r = await osrm.route([
    { lat: 53.9, lon: 27.56 },
    { lat: 53.92, lon: 27.58 },
    { lat: 53.93, lon: 27.6 },
  ]);
  assert.equal(r.legs.length, 2);
  assert.equal(r.legs[0].distanceM, 1500.4);
  assert.equal(r.legs[0].durationS, 180.2);
  assert.deepEqual(r.legs[0].coords[0], [53.9, 27.56]); // широта первой
  assert.deepEqual(r.legs[1].coords[1], [53.93, 27.6]);
});

test('OSRM route: код ошибки → OsrmError', async () => {
  const osrm = new OsrmAdapter({
    fetchImpl: mockFetch({ '/route/v1/': { code: 'NoRoute', message: 'No route found' } }),
  });
  await assert.rejects(
    () => osrm.route([{ lat: 1, lon: 1 }, { lat: 2, lon: 2 }]),
    (e) => e instanceof OsrmError && /NoRoute/.test(e.message)
  );
});

test('OSRM table: разбор матрицы, null → Infinity', async () => {
  const osrm = new OsrmAdapter({
    maxTableCoords: 100,
    fetchImpl: mockFetch({
      '/table/v1/': {
        code: 'Ok',
        durations: [
          [0, 120, null],
          [300, 0, 60],
          [100, 200, 0],
        ],
        distances: [
          [0, 1500, null],
          [4000, 0, 700],
          [1000, 2500, 0],
        ],
      },
    }),
  });
  const pts = [{ lat: 1, lon: 1 }, { lat: 2, lon: 2 }, { lat: 3, lon: 3 }];
  const mx = await osrm.matrix(pts, pts);
  assert.equal(mx.times[0][1], 120);
  assert.equal(mx.times[0][2], Infinity); // null — недостижимо
  assert.equal(mx.lens[1][0], 4000);
  assert.equal(mx.lens[2][1], 2500);
});

test('OSRM table: чанкинг по лимиту координат', async () => {
  let calls = 0;
  const chunks = [];
  const k = 11; // 11 целей
  const osrm = new OsrmAdapter({
    maxTableCoords: 15, // по 4 источника за запрос
    fetchImpl: async (url) => {
      calls++;
      const m = String(url).match(/sources=([\d;]+)&/);
      chunks.push(m[1].split(';').length);
      const nSrc = m[1].split(';').length;
      return {
        ok: true,
        status: 200,
        json: async () => ({
          code: 'Ok',
          durations: Array.from({ length: nSrc }, (_, i) =>
            Array.from({ length: k }, (_, j) => 10 * (i + j))
          ),
        }),
      };
    },
  });
  const pts = Array.from({ length: 11 }, (_, i) => ({ lat: i, lon: i }));
  const mx = await osrm.matrix(pts, pts);
  assert.equal(calls, 3); // 4 + 4 + 3 источника
  assert.deepEqual(chunks, [4, 4, 3]);
  assert.equal(mx.times[10][10], 10 * (2 + 10));
});

test('OSRM table: без distance-аннотаций при mode=distance — ошибка', async () => {
  const osrm = new OsrmAdapter({
    fetchImpl: mockFetch({ '/table/v1/': { code: 'Ok', durations: [[0, 5], [5, 0]] } }),
  });
  const pts = [{ lat: 1, lon: 1 }, { lat: 2, lon: 2 }];
  await assert.rejects(() => osrm.matrix(pts, pts, { mode: 'distance' }), OsrmError);
});

test('OSRM: HTTP-ошибка → OsrmError со статусом', async () => {
  const osrm = new OsrmAdapter({
    fetchImpl: mockFetch({ '/route/v1/': { __status: 503, message: 'Too Many Requests' } }),
  });
  await assert.rejects(
    () => osrm.route([{ lat: 1, lon: 1 }, { lat: 2, lon: 2 }]),
    (e) => e instanceof OsrmError && e.status === 503
  );
});
