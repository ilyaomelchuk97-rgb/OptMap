// Тесты адаптера Nominatim (геокодер OpenStreetMap) — на мок-запросах.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { NominatimAdapter, NominatimError } from '../server/adapters/nominatim.js';

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

test('Nominatim: разбор ответа поиска', async () => {
  const nom = new NominatimAdapter({
    fetchImpl: mockFetch({
      '/search': [
        {
          place_id: 1,
          lat: '53.9006',
          lon: '27.5590',
          display_name: 'улица Ленина, Минск, Беларусь',
          category: 'highway',
          type: 'residential',
          namedetails: { name: 'улица Ленина' },
          address: { road: 'улица Ленина', city: 'Минск', country: 'Беларусь' },
        },
      ],
    }),
  });
  const res = await nom.geocode('Ленина');
  assert.equal(res.length, 1);
  assert.equal(res[0].name, 'улица Ленина');
  assert.equal(res[0].fullName, 'улица Ленина, Минск, Беларусь');
  assert.equal(res[0].lat, 53.9006);
  assert.equal(res[0].cls, 'residential');
  assert.equal(res[0].source, 'osm-nominatim');
});

test('Nominatim: короткое имя без namedetails — из адреса', async () => {
  const nom = new NominatimAdapter({
    fetchImpl: mockFetch({
      '/search': [
        {
          lat: '55.75',
          lon: '37.61',
          display_name: 'Тверская улица, Москва, Россия',
          category: 'highway',
          type: 'tertiary',
          address: { road: 'Тверская улица' },
        },
      ],
    }),
  });
  const res = await nom.geocode('Тверская');
  assert.equal(res[0].name, 'Тверская улица');
});

test('Nominatim: reverse разбирает адрес', async () => {
  const nom = new NominatimAdapter({
    fetchImpl: mockFetch({
      '/reverse': {
        display_name: 'проспект Независимости, Минск, Беларусь',
        category: 'highway',
        type: 'primary',
        namedetails: { name: 'проспект Независимости' },
        address: { road: 'проспект Независимости', city: 'Минск' },
      },
    }),
  });
  const r = await nom.reverse(53.9, 27.56);
  assert.equal(r.name, 'проспект Независимости');
  assert.equal(r.cls, 'primary');
  assert.equal(r.source, 'osm-nominatim');
});

test('Nominatim: reverse с ошибкой → null', async () => {
  const nom = new NominatimAdapter({
    fetchImpl: mockFetch({ '/reverse': { error: 'Unable to geocode' } }),
  });
  assert.equal(await nom.reverse(0, 0), null);
});

test('Nominatim: HTTP-ошибка → NominatimError', async () => {
  const nom = new NominatimAdapter({
    fetchImpl: mockFetch({ '/search': { __status: 503 } }),
  });
  await assert.rejects(() => nom.geocode('x'), NominatimError);
});

test('Nominatim: viewbox передаётся при заданной области', async () => {
  let seen = null;
  const nom = new NominatimAdapter({
    fetchImpl: async (url) => {
      seen = String(url);
      return { ok: true, status: 200, json: async () => [] };
    },
  });
  await nom.geocode('Тверская', { lat: 55.75, lon: 37.61, limit: 5 });
  assert.ok(seen.includes('viewbox='));
  assert.ok(seen.includes('limit=5'));
});
