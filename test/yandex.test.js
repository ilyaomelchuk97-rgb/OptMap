// Тесты адаптера Яндекс Карт (на мок-запросах, без сети).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { YandexAdapter, YandexError, nextDepartureTime } from '../server/adapters/yandex.js';

/** Мок fetch: маршруты по url → ответ. */
function mockFetch(routes) {
  return async (url) => {
    for (const [pattern, resp] of Object.entries(routes)) {
      if (url.includes(pattern)) {
        if (resp instanceof Error) throw resp;
        return {
          ok: resp.__status === undefined ? true : resp.__status >= 200 && resp.__status < 300,
          status: resp.__status ?? 200,
          headers: new Map([['content-type', 'application/json']]),
          json: async () => resp,
        };
      }
    }
    return { ok: false, status: 404, json: async () => ({}) };
  };
}

test('геокодер: разбор ответа Яндекса', async () => {
  const ya = new YandexAdapter({
    geocoderKey: 'KEY',
    fetchImpl: mockFetch({
      'geocode-maps.yandex.ru': {
        response: {
          GeoObjectCollection: {
            featureMember: [
              {
                GeoObject: {
                  name: 'улица Новый Арбат, 24',
                  metaDataProperty: {
                    GeocoderMetaData: {
                      kind: 'house',
                      text: 'Россия, Москва, улица Новый Арбат, 24',
                    },
                  },
                  Point: { pos: '37.587614 55.753083' },
                },
              },
            ],
          },
        },
      },
    }),
  });
  const res = await ya.geocode('Новый Арбат 24');
  assert.equal(res.length, 1);
  assert.equal(res[0].name, 'улица Новый Арбат, 24');
  assert.equal(res[0].lat, 55.753083);
  assert.equal(res[0].lon, 37.587614);
  assert.equal(res[0].cls, 'house');
  assert.equal(res[0].source, 'yandex');
});

test('геокодер без ключа — ошибка', async () => {
  const ya = new YandexAdapter({ fetchImpl: mockFetch({}) });
  await assert.rejects(() => ya.geocode('x'), YandexError);
});

test('матрица: разбор ячеек и FAIL → Infinity', async () => {
  const ya = new YandexAdapter({
    routerKey: 'KEY',
    fetchImpl: mockFetch({
      distancematrix: {
        rows: [
          { elements: [{ status: 'OK', duration: { value: 120 }, distance: { value: 1500 } }, { status: 'FAIL' }] },
          { elements: [{ status: 'OK', duration: { value: 300 }, distance: { value: 4200 } }, { status: 'OK', duration: { value: 60 }, distance: { value: 700 } }] },
        ],
      },
    }),
  });
  const pts = [{ lat: 1, lon: 1 }, { lat: 2, lon: 2 }];
  const mx = await ya.matrix(pts, pts);
  assert.equal(mx.times[0][0], 120);
  assert.equal(mx.times[0][1], Infinity); // FAIL
  assert.equal(mx.lens[0][1], Infinity);
  assert.equal(mx.times[1][1], 60);
  assert.equal(mx.lens[1][0], 4200);
});

test('матрица: лимит 100 ячеек — разбивка на блоки', async () => {
  let calls = 0;
  const seen = [];
  const ya = new YandexAdapter({
    routerKey: 'KEY',
    fetchImpl: async (url) => {
      calls++;
      seen.push(url);
      const origins = decodeURIComponent(url).match(/origins=([^&]*)/)[1].split('|').length;
      const k = 11;
      return {
        ok: true,
        status: 200,
        json: async () => ({
          rows: Array.from({ length: origins }, () => ({
            elements: Array.from({ length: k }, (_, ci) => ({
              status: 'OK',
              duration: { value: 10 * (ci + 1) },
              distance: { value: 100 * (ci + 1) },
            })),
          })),
        }),
      };
    },
  });
  const pts = Array.from({ length: 11 }, (_, i) => ({ lat: i, lon: i })); // 121 ячейка
  const mx = await ya.matrix(pts, pts);
  assert.equal(calls, 2); // 99 + 22 ячейки
  assert.equal(mx.times[10][10], 110);
  assert.equal(mx.lens[3][7], 800);
});

test('маршрут: суммирование шагов и геометрии по участкам', async () => {
  const ya = new YandexAdapter({
    routerKey: 'KEY',
    fetchImpl: mockFetch({
      '/v2/route': {
        traffic_type: 'realtime',
        route: {
          legs: [
            {
              status: 'OK',
              steps: [
                { length: 100, duration: 20, polyline: { points: [[1, 1], [1, 2]] } },
                { length: 200, duration: 40, polyline: { points: [[1, 2], [2, 2]] } },
              ],
            },
            {
              status: 'OK',
              steps: [{ length: 500, duration: 90, polyline: { points: [[2, 2], [3, 3]] } }],
            },
          ],
        },
      },
    }),
  });
  const r = await ya.route([{ lat: 1, lon: 1 }, { lat: 2, lon: 2 }, { lat: 3, lon: 3 }]);
  assert.equal(r.trafficType, 'realtime');
  assert.equal(r.legs.length, 2);
  assert.equal(r.legs[0].distanceM, 300);
  assert.equal(r.legs[0].durationS, 60);
  assert.deepEqual(r.legs[0].coords, [[1, 1], [1, 2], [2, 2]]);
  assert.equal(r.legs[1].distanceM, 500);
});

test('маршрут: FAIL на участке → ошибка', async () => {
  const ya = new YandexAdapter({
    routerKey: 'KEY',
    fetchImpl: mockFetch({
      '/v2/route': { route: { legs: [{ status: 'FAIL', steps: [] }] } },
    }),
  });
  await assert.rejects(() => ya.route([{ lat: 1, lon: 1 }, { lat: 2, lon: 2 }]), YandexError);
});

test('маршрут: HTTP-ошибка API → YandexError со статусом', async () => {
  const ya = new YandexAdapter({
    routerKey: 'BAD',
    fetchImpl: mockFetch({ '/v2/route': { __status: 403, message: 'Key is required' } }),
  });
  await assert.rejects(
    () => ya.route([{ lat: 1, lon: 1 }, { lat: 2, lon: 2 }]),
    (e) => e instanceof YandexError && e.status === 403
  );
});

test('nextDepartureTime: ближайший будущий выезд в заданный час', () => {
  const now = new Date('2026-09-24T10:30:00');
  const sameDay = nextDepartureTime(17, now); // сегодня 17:00
  assert.ok(sameDay * 1000 > now.getTime());
  const d = new Date(sameDay * 1000);
  assert.equal(d.getHours(), 17);
  assert.equal(d.getMinutes(), 0);
  const nextDay = nextDepartureTime(8, now); // 8:00 уже прошло → завтра
  const d2 = new Date(nextDay * 1000);
  assert.equal(d2.getHours(), 8);
  assert.ok(nextDay * 1000 > now.getTime());
});
