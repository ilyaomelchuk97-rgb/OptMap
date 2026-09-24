// Пример интеграции OptMap с Яндекс Картами (официальный Yandex Maps JS API 2.1).
//
// Что показывает пример:
//  • карта Яндекса в браузере (ключ YANDEX_JS_KEY);
//  • точки ставятся кликом, адрес определяется геокодером Яндекса
//    (серверный прокси /api/geocode/reverse — ключ YANDEX_GEOCODER_KEY);
//  • «Оптимизировать» вызывает POST /api/optimize: порядок точек считает
//    оптимизатор OptMap, километраж и время — Яндекс с реальными пробками
//    (если настроен YANDEX_ROUTER_KEY), иначе локальный граф OSM;
//  • маршрут рисуется полилиниями поверх карты Яндекса.
'use strict';

const $ = (s) => document.querySelector(s);

const state = {
  health: null,
  map: null,
  points: [], // {lat, lon, name, placemark}
  result: null,
  lines: [], // ymaps.Polyline
};

/* ---------- загрузка ---------- */

async function main() {
  const health = await (await fetch('/api/health')).json();
  state.health = health;

  const key = health?.yandex?.jsKey;
  if (!key) {
    $('#setup').classList.remove('hidden');
    return;
  }

  // загружаем JS API Яндекса с ключом
  await loadScript(`https://api-maps.yandex.ru/2.1/?apikey=${encodeURIComponent(key)}&lang=ru_RU`);
  ymaps.ready(initMap);
}

function loadScript(src) {
  return new Promise((resolve, reject) => {
    const s = document.createElement('script');
    s.src = src;
    s.onload = resolve;
    s.onerror = () => reject(new Error('Не удалось загрузить Yandex Maps JS API'));
    document.head.appendChild(s);
  });
}

/* ---------- карта ---------- */

function bboxCenter(bbox) {
  if (!bbox) return [53.9045, 27.5615];
  return [(bbox[0] + bbox[2]) / 2, (bbox[1] + bbox[3]) / 2];
}

function initMap() {
  const bbox = state.health?.engine?.bbox;
  state.map = new ymaps.Map('map', {
    center: bboxCenter(bbox),
    zoom: 12,
    controls: ['zoomControl', 'typeSelector', 'fullscreenControl', 'geolocationControl'],
  }, {
    suppressMapOpenBlock: true,
  });

  state.map.events.add('click', (e) => {
    if (state.points.length >= (state.health?.limits?.maxPoints || 50)) return;
    const coords = e.get('coords');
    addPoint(coords[0], coords[1], '');
  });

  bindUI();
  renderPoints();
  $('#content').style.display = 'flex';
}

/* ---------- точки ---------- */

function addPoint(lat, lon, name) {
  const p = { lat, lon, name: name || '', placemark: null };
  state.points.push(p);
  clearResult();
  renderPoints();
  if (!name) namePoint(p); // определяем адрес геокодером
}

async function namePoint(p) {
  try {
    const r = await (await fetch(`/api/geocode/reverse?lat=${p.lat}&lon=${p.lon}`)).json();
    if (r?.result?.name) {
      p.name = r.result.name;
      const i = state.points.indexOf(p);
      const row = document.querySelectorAll('#points-list .pname')[i];
      if (row) row.textContent = p.name;
    }
  } catch (_e) { /* останется «Точка N» */ }
}

function placemarkIcon(pos, isStart, isEnd) {
  const color = isStart ? '#1f9d55' : isEnd ? '#d64545' : '#2b7de9';
  return new ymaps.Placemark(
    [state.points[pos].lat, state.points[pos].lon],
    {},
    {
      preset: 'islands#circleIcon',
      iconColor: color,
      draggable: true,
    }
  );
}

function renderPoints() {
  const list = $('#points-list');
  list.innerHTML = '';
  // пересоздаём метки (нумерация/цвета зависят от позиции)
  for (const p of state.points) {
    if (p.placemark) state.map.geoObjects.remove(p.placemark);
    p.placemark = null;
  }
  state.points.forEach((p, i) => {
    const isStart = i === 0;
    const isEnd = i === state.points.length - 1 && state.points.length > 1;
    p.placemark = placemarkIcon(i, isStart, isEnd);
    p.placemark.events.add('dragend', (e) => {
      const coords = e.get('target').geometry.getCoordinates();
      p.lat = coords[0];
      p.lon = coords[1];
      renderPoints();
      clearResult();
    });
    state.map.geoObjects.add(p.placemark);

    const row = document.createElement('div');
    row.className = 'point-item' + (isStart ? ' is-start' : isEnd ? ' is-end' : '');
    row.innerHTML = `
      <div class="num">${i + 1}</div>
      <div class="pname" title="${escapeHtml(p.name || 'Определяю адрес…')}">${escapeHtml(p.name || 'Определяю адрес…')}</div>
      <div class="pcoords">${p.lat.toFixed(4)}, ${p.lon.toFixed(4)}</div>
      <div class="tools">
        <button title="Сделать стартом" data-act="start">⌂</button>
        <button title="Удалить" class="del" data-act="del">✕</button>
      </div>`;
    row.querySelector('[data-act=start]').onclick = () => {
      const [moved] = state.points.splice(i, 1);
      state.points.unshift(moved);
      clearResult();
      renderPoints();
    };
    row.querySelector('[data-act=del]').onclick = () => {
      state.points.splice(i, 1);
      clearResult();
      renderPoints();
    };
    list.appendChild(row);
  });
  redrawLines();
  $('#points-empty').classList.toggle('hidden', state.points.length > 0);
  $('#btn-optimize').disabled = state.points.length < 2;
}

function redrawLines() {
  for (const l of state.lines) state.map.geoObjects.remove(l);
  state.lines = [];
  if (!state.result) return;
  const visitPos = new Map();
  state.result.order.forEach((pi, pos) => visitPos.set(pi, pos));
  // перерисовка меток с номерами маршрута
  state.points.forEach((p, i) => {
    const pos = visitPos.get(i) ?? i;
    const isStart = pos === 0;
    const isEnd = pos === state.result.order.length - 1;
    if (p.placemark) {
      p.placemark.options.set('iconColor', isStart ? '#1f9d55' : isEnd ? '#d64545' : '#2b7de9');
    }
  });
  state.result.legs.forEach((leg, idx) => {
    if (!leg.coords) return;
    const line = new ymaps.Polyline(
      leg.coords,
      { hintContent: `${leg.fromName} → ${leg.toName}: ${(leg.distanceM / 1000).toFixed(1)} км · ${fmtDur(leg.durationS)}` },
      { strokeColor: '#1d5fc4', strokeWidth: 5, strokeOpacity: 0.95 }
    );
    line.events.add('mouseenter', () => line.options.set({ strokeWidth: 8, strokeColor: '#0f3f8a' }));
    line.events.add('mouseleave', () => line.options.set({ strokeWidth: 5, strokeColor: '#1d5fc4' }));
    state.map.geoObjects.add(line);
    state.lines.push(line);
  });
}

/* ---------- оптимизация ---------- */

async function optimize() {
  if (state.points.length < 2) return;
  const btn = $('#btn-optimize');
  btn.disabled = true;
  btn.classList.add('loading');
  btn.textContent = 'Считаю маршрут…';
  try {
    const body = {
      points: state.points.map((p) => ({ lat: p.lat, lon: p.lon, name: p.name || `Точка ${state.points.indexOf(p) + 1}` })),
      options: {
        roundTrip: $('#opt-roundtrip').checked,
        traffic: $('#opt-traffic').checked,
        engine: state.health?.yandex?.router ? 'yandex' : 'auto',
      },
    };
    const r = await fetch('/api/optimize', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    const res = await r.json();
    if (!r.ok || res.error) throw new Error(res.error?.message || `HTTP ${r.status}`);
    state.result = res;
    drawResult(res);
  } catch (e) {
    toast('Не удалось построить маршрут: ' + e.message, true);
  } finally {
    btn.disabled = state.points.length < 2;
    btn.classList.remove('loading');
    btn.textContent = 'Оптимизировать маршрут';
  }
}

function clearResult() {
  state.result = null;
  redrawLines();
  $('#results')?.classList.add('hidden');
}

function fmtDur(s) {
  const m = Math.round(s / 60);
  if (m < 60) return m + ' мин';
  return Math.floor(m / 60) + ' ч ' + (m % 60) + ' мин';
}

function engineLabel(res) {
  if (res.engine?.name === 'yandex') {
    const t = res.engine.trafficType === 'forecast' ? 'прогноз пробок' : res.engine.trafficType === 'realtime' ? 'пробки realtime' : 'пробки';
    return `Яндекс Карты (${t})`;
  }
  return 'локальный граф OSM';
}

function drawResult(res) {
  const t = res.totals;
  $('#totals').innerHTML = `
    <div class="tot"><div class="v">${(t.distanceM / 1000).toFixed(1)}</div><div class="l">км по дорогам</div></div>
    <div class="tot"><div class="v">${fmtDur(t.durationS)}</div><div class="l">в пути</div></div>
    <div class="tot"><div class="v">${t.avgSpeedKmh}</div><div class="l">средняя, км/ч</div></div>
    <div class="tot"><div class="v">${t.detourFactor ?? '—'}</div><div class="l">к объезду</div></div>`;

  $('#order-chips').innerHTML =
    'Порядок: ' +
    res.order.map((pi, pos) => `<span class="chip"><b>${pos + 1}</b>. ${escapeHtml(state.points[pi]?.name || `Точка ${pi + 1}`)}</span>`).join(' ');

  $('#result-meta').textContent =
    `${res.optimizer.method} · движок: ${engineLabel(res)} · расчёт ${res.optimizer.totalMs} мс` +
    (res.options.traffic ? ' · пробки учтены' : ' · без пробок');

  $('#warnings').innerHTML = (res.warnings || []).map((w) => '⚠ ' + escapeHtml(w)).join('<br>');
  $('#results').classList.remove('hidden');

  redrawLines();

  // подгоняем вид по маршруту
  let minLat = 90, maxLat = -90, minLon = 180, maxLon = -180;
  for (const leg of res.legs) {
    for (const [lat, lon] of leg.coords || []) {
      if (lat < minLat) minLat = lat;
      if (lat > maxLat) maxLat = lat;
      if (lon < minLon) minLon = lon;
      if (lon > maxLon) maxLon = lon;
    }
  }
  if (maxLat > minLat) {
    state.map.setBounds([[minLat, minLon], [maxLat, maxLon]], { checkZoomRange: true, zoomMargin: 40 });
  }
}

/* ---------- UI ---------- */

function bindUI() {
  $('#btn-optimize').onclick = optimize;
  $('#btn-json').onclick = () => {
    if (state.result) {
      const a = document.createElement('a');
      a.href = URL.createObjectURL(new Blob([JSON.stringify(state.result, null, 2)], { type: 'application/json' }));
      a.download = 'optmap-yandex-result.json';
      a.click();
    }
  };
  $('#btn-curl').onclick = () => {
    const body = {
      points: state.points.map((p) => ({ lat: +p.lat.toFixed(5), lon: +p.lon.toFixed(5), name: p.name })),
      options: { roundTrip: $('#opt-roundtrip').checked, engine: state.health?.yandex?.router ? 'yandex' : 'auto' },
    };
    $('#curl-box').textContent =
      `curl -X POST ${location.origin}/api/optimize \\\n  -H "Content-Type: application/json" \\\n  -d '${JSON.stringify(body)}'`;
    $('#curl-box').classList.remove('hidden');
  };

  // поиск адресов через сервер (Яндекс-геокодер, если настроен)
  const input = $('#search');
  const box = $('#search-results');
  let timer = null;
  input.oninput = () => {
    clearTimeout(timer);
    timer = setTimeout(async () => {
      const q = input.value.trim();
      if (q.length < 2) {
        box.classList.add('hidden');
        return;
      }
      const c = state.map.getCenter();
      const r = await (
        await fetch(`/api/geocode?q=${encodeURIComponent(q)}&lat=${c[0].toFixed(5)}&lon=${c[1].toFixed(5)}`)
      ).json();
      box.innerHTML = '';
      const src = r.source === 'yandex' ? 'Яндекс' : 'граф';
      for (const item of r.results || []) {
        const el = document.createElement('div');
        el.className = 'search-item';
        el.innerHTML = `<span>${escapeHtml(item.name)}${
          item.fullName && item.fullName !== item.name ? `<small>${escapeHtml(item.fullName)}</small>` : ''
        }</span><span class="cls">${escapeHtml(item.cls || '')} · ${src}</span>`;
        el.onclick = () => {
          box.classList.add('hidden');
          input.value = '';
          addPoint(item.lat, item.lon, item.name);
          state.map.setCenter([item.lat, item.lon], Math.max(state.map.getZoom(), 15));
        };
        box.appendChild(el);
      }
      box.classList.toggle('hidden', (r.results || []).length === 0);
    }, 250);
  };
  document.addEventListener('click', (e) => {
    if (!e.target.closest('.search-row')) box.classList.add('hidden');
  });
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

function toast(msg, isError = false) {
  let t = document.querySelector('#toast');
  if (!t) {
    t = document.createElement('div');
    t.id = 'toast';
    document.body.appendChild(t);
  }
  t.textContent = msg;
  t.className = 'toast' + (isError ? ' error' : '');
  clearTimeout(t._timer);
  t._timer = setTimeout(() => t.classList.add('hidden'), 6000);
}

main().catch((e) => {
  const box = $('#setup');
  if (box) {
    box.classList.remove('hidden');
    box.insertAdjacentHTML('afterbegin', `<p style="color:#d64545"><b>Ошибка:</b> ${escapeHtml(e.message)}</p>`);
  }
});
