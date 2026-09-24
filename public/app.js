// OptMap — клиентское приложение (демо-виджет + пример интеграции с API).
'use strict';

const $ = (s) => document.querySelector(s);

const state = {
  health: null,
  points: [], // {lat, lon, name, marker}
  result: null,
  routeLayer: null,
  legLines: [],
  map: null,
  demo: false,
  embed: new URLSearchParams(location.search).has('embed'),
};

/* ================= инициализация ================= */

async function init() {
  if (state.embed) document.body.classList.add('embed');

  let health = null;
  try {
    health = await (await fetch('/api/health')).json();
  } catch (e) {
    toast('API недоступен: ' + e.message, true);
  }
  state.health = health;

  initMap();

  if (health) {
    const badge = $('#engine-badge');
    const eng = health.engine;
    if (eng.demo) {
      badge.textContent = ' демо-данные: ' + eng.sourceName + ' ';
      badge.className = 'badge badge-demo';
      badge.title = 'Демонстрационная сеть. Загрузите реальный граф OSM: npm run ingest -- --pbf <файл>';
    } else {
      badge.textContent = ' данные: ' + eng.sourceName + ` (${(eng.edges / 1000).toFixed(0)} тыс. рёбер) `;
      badge.className = 'badge badge-osm';
    }
  }

  bindUI();
  renderPoints();

  // встроенный режим: точки из URL
  const q = new URLSearchParams(location.search);
  if (q.has('pts')) {
    for (const part of q.get('pts').split(';')) {
      const [lat, lon] = part.split(',').map(Number);
      if (Number.isFinite(lat) && Number.isFinite(lon)) addPoint(lat, lon, '');
    }
    if (state.points.length >= 2 && q.get('auto') === '1') optimize();
  }
}

async function initMap() {
  const map = L.map('map', { zoomControl: true, preferCanvas: true });
  state.map = map;
  state.routeLayer = L.layerGroup().addTo(map);

  let bbox = null;
  let showingTiles = false;
  if (state.health && state.health.engine.demo) {
    try {
      const md = await (await fetch('/api/mapdata')).json();
      bbox = md.bbox;
      renderVectorCity(md);
    } catch (e) {
      showingTiles = true;
    }
  } else {
    showingTiles = true;
  }

  if (showingTiles) {
    L.tileLayer(state.health?.tileUrl || 'https://tile.openstreetmap.org/{z}/{x}/{y}.png', {
      maxZoom: 19,
      attribution: '© OpenStreetMap',
    }).addTo(map);
    if (state.health?.engine.bbox) bbox = state.health.engine.bbox;
    else bbox = [53.87, 27.48, 53.95, 27.65];
  }

  if (bbox) {
    map.fitBounds([[bbox[0], bbox[1]], [bbox[2], bbox[3]]], { padding: [20, 20] });
  }

  map.on('click', (e) => {
    if (state.points.length >= (state.health?.limits.maxPoints || 50)) {
      toast(`Максимум ${state.health.limits.maxPoints} точек`, true);
      return;
    }
    addPoint(e.latlng.lat, e.latlng.lng, '');
  });
}

/* ---------- векторный демо-город ---------- */

const ROAD_STYLE = {
  motorway: { color: '#e892a2', weight: 5 },
  motorway_link: { color: '#e892a2', weight: 3.5 },
  trunk: { color: '#f9b29c', weight: 4.5 },
  trunk_link: { color: '#f9b29c', weight: 3 },
  primary: { color: '#fcd6a4', weight: 4.2 },
  primary_link: { color: '#fcd6a4', weight: 3 },
  secondary: { color: '#f7fabf', weight: 3.6 },
  secondary_link: { color: '#f7fabf', weight: 2.6 },
  tertiary: { color: '#ffffff', weight: 3 },
  tertiary_link: { color: '#ffffff', weight: 2.4 },
  unclassified: { color: '#ffffff', weight: 2.6 },
  residential: { color: '#ffffff', weight: 2.4 },
  living_street: { color: '#ffffff', weight: 2.2 },
  service: { color: '#fdfdfb', weight: 1.6 },
};

function renderVectorCity(md) {
  const map = state.map;
  // фон-подложка: тонкая обводка дорог + заливка
  for (const grp of md.roads) {
    const st = ROAD_STYLE[grp.cls] || { color: '#ffffff', weight: 2 };
    // обводка
    L.polyline(grp.segments, {
      color: '#d9d0c9',
      weight: st.weight + 1.6,
      opacity: 0.8,
      interactive: false,
    }).addTo(map);
    L.polyline(grp.segments, {
      color: st.color,
      weight: st.weight,
      opacity: 1,
      interactive: false,
    }).addTo(map);
  }
  // вода
  for (const w of md.water || []) {
    if (w.kind === 'line') {
      L.polyline(w.coords, { color: '#a5c8d4', weight: 14, opacity: 0.9, interactive: false }).addTo(map);
      L.polyline(w.coords, { color: '#aad3df', weight: 10, opacity: 1, interactive: false }).addTo(map);
    } else if (w.kind === 'poly') {
      L.polygon(ellipseCoords(w.center, w.rxKm, w.ryKm), { color: '#9fc9d6', weight: 1, fillColor: '#aad3df', fillOpacity: 0.9, interactive: false }).addTo(map);
    }
  }
  // парки
  for (const p of md.parks || []) {
    L.polygon(ellipseCoords(p.center, p.rxKm, p.ryKm), { color: '#b7e2b9', weight: 1, fillColor: '#c8facc', fillOpacity: 0.75, interactive: false }).addTo(map);
  }
  // подписи
  for (const lb of md.labels || []) {
    const cls = lb.size === 'big' ? 'district-label' : 'road-label';
    L.marker(lb.at, {
      icon: L.divIcon({ className: cls, html: lb.name, iconSize: null }),
      interactive: false,
      keyboard: false,
    }).addTo(map);
  }
}

function ellipseCoords([lat, lon], rxKm, ryKm, n = 36) {
  const pts = [];
  const dLat = ryKm / 111.32;
  const dLon = rxKm / (111.32 * Math.cos((lat * Math.PI) / 180));
  for (let i = 0; i < n; i++) {
    const a = (2 * Math.PI * i) / n;
    pts.push([lat + Math.sin(a) * dLat, lon + Math.cos(a) * dLon]);
  }
  return pts;
}

/* ================= точки ================= */

function addPoint(lat, lon, name) {
  const p = { lat, lon, name: name || `Точка ${state.points.length + 1}`, marker: null };
  state.points.push(p);
  clearResult();
  renderPoints();
}

function removePoint(i) {
  const p = state.points[i];
  if (p.marker) p.marker.remove();
  state.points.splice(i, 1);
  clearResult();
  renderPoints();
}

function movePoint(i, dir) {
  const j = i + dir;
  if (j < 0 || j >= state.points.length) return;
  [state.points[i], state.points[j]] = [state.points[j], state.points[i]];
  clearResult();
  renderPoints();
}

function makeStart(i) {
  const [p] = state.points.splice(i, 1);
  state.points.unshift(p);
  clearResult();
  renderPoints();
}

function markerIcon(pos, isStart, isEnd) {
  const kind = isStart ? 'pin-start' : isEnd ? 'pin-end' : '';
  return L.divIcon({
    className: '',
    html: `<div class="marker-pin ${kind}"><span>${pos + 1}</span></div>`,
    iconSize: [26, 26],
    iconAnchor: [13, 26],
  });
}

function renderPoints() {
  const list = $('#points-list');
  list.innerHTML = '';
  state.points.forEach((p, i) => {
    const isStart = i === 0;
    const isEnd = i === state.points.length - 1 && state.points.length > 1;
    const row = document.createElement('div');
    row.className = 'point-item' + (isStart ? ' is-start' : isEnd ? ' is-end' : '');
    row.innerHTML = `
      <div class="num">${i + 1}</div>
      <div class="pname" title="${p.name}">${escapeHtml(p.name)}</div>
      <div class="pcoords">${p.lat.toFixed(4)}, ${p.lon.toFixed(4)}</div>
      <div class="tools">
        <button title="Сделать стартом" data-act="start">⌂</button>
        <button title="Выше" data-act="up">↑</button>
        <button title="Ниже" data-act="down">↓</button>
        <button title="Удалить" class="del" data-act="del">✕</button>
      </div>`;
    row.querySelector('[data-act=start]').onclick = () => makeStart(i);
    row.querySelector('[data-act=up]').onclick = () => movePoint(i, -1);
    row.querySelector('[data-act=down]').onclick = () => movePoint(i, 1);
    row.querySelector('[data-act=del]').onclick = () => removePoint(i);
    list.appendChild(row);

    if (!p.marker) {
      p.marker = L.marker([p.lat, p.lon], { draggable: true }).addTo(state.map);
      p.marker.on('dragend', (e) => {
        const ll = e.target.getLatLng();
        p.lat = ll.lat;
        p.lon = ll.lng;
        renderPoints();
        clearResult();
      });
      p.marker.on('click', () => makeStart(i));
    } else {
      p.marker.setLatLng([p.lat, p.lon]);
    }
    p.marker.setIcon(markerIcon(i, isStart, isEnd));
  });
  $('#points-empty').classList.toggle('hidden', state.points.length > 0);
  $('#btn-optimize').disabled = state.points.length < 2;
}

function escapeHtml(s) {
  return s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

/* ================= оптимизация ================= */

async function optimize() {
  if (state.points.length < 2) return;
  const btn = $('#btn-optimize');
  btn.disabled = true;
  btn.classList.add('loading');
  btn.textContent = 'Считаю маршрут…';
  try {
    const body = {
      points: state.points.map((p) => ({ lat: p.lat, lon: p.lon, name: p.name })),
      options: currentOptions(),
    };
    const r = await fetch('/api/optimize', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    const res = await r.json();
    if (!r.ok || res.error) {
      throw new Error(res.error?.message || `HTTP ${r.status}`);
    }
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

function currentOptions() {
  const depart = $('#opt-depart').value;
  return {
    roundTrip: $('#opt-roundtrip').checked,
    endLocked: $('#opt-endlocked').checked,
    mode: $('#opt-mode').value,
    traffic: $('#opt-traffic').checked,
    departHour: depart === '' ? null : Number(depart),
  };
}

function clearResult() {
  state.result = null;
  state.routeLayer.clearLayers();
  $('#results').classList.add('hidden');
}

function fmtDur(s) {
  const m = Math.round(s / 60);
  if (m < 60) return m + ' мин';
  return Math.floor(m / 60) + ' ч ' + (m % 60) + ' мин';
}

function fmtKm(m) {
  return (m / 1000).toFixed(1);
}

function drawResult(res) {
  const map = state.map;
  state.routeLayer.clearLayers();
  state.legLines = [];

  // маркеры в порядке посещения
  const visitPos = new Map();
  res.order.forEach((pi, pos) => visitPos.set(pi, pos));
  state.points.forEach((p, i) => {
    const pos = visitPos.get(i) ?? i;
    const isStart = pos === 0;
    const isEnd = pos === res.order.length - 1;
    const kind = isStart ? 'pin-start' : isEnd && !res.options.roundTrip ? 'pin-end' : '';
    p.marker.setIcon(
      L.divIcon({
        className: '',
        html: `<div class="marker-pin ${kind}"><span>${pos + 1}</span></div>`,
        iconSize: [26, 26],
        iconAnchor: [13, 26],
      })
    );
    p.marker.bindTooltip(`${pos + 1}. ${p.name}`, { direction: 'top' });
  });

  // линии ног
  const bounds = [];
  res.legs.forEach((leg, idx) => {
    if (leg.coords) {
      // подложка (белая обводка) под основной линией маршрута
      L.polyline(leg.coords, { color: '#ffffff', weight: 9, opacity: 0.7, interactive: false }).addTo(state.routeLayer);
      const line = L.polyline(leg.coords, { color: '#2b7de9', weight: 5, opacity: 0.95 }).addTo(state.routeLayer);
      line.bindTooltip(
        `${leg.fromName} → ${leg.toName}: ${fmtKm(leg.distanceM)} км · ${fmtDur(leg.durationS)}`,
        { sticky: true }
      );
      line.on('mouseover', () => line.setStyle({ weight: 8, color: '#1d5fc4' }));
      line.on('mouseout', () => line.setStyle({ weight: 5, color: '#2b7de9' }));
      state.legLines.push(line);
      for (const c of leg.coords) bounds.push(c);
    }
  });

  // итоги
  const t = res.totals;
  $('#totals').innerHTML = `
    <div class="tot"><div class="v">${fmtKm(t.distanceM)}</div><div class="l">км по дорогам</div></div>
    <div class="tot"><div class="v">${fmtDur(t.durationS)}</div><div class="l">в пути</div></div>
    <div class="tot"><div class="v">${t.avgSpeedKmh}</div><div class="l">средняя, км/ч</div></div>
    <div class="tot"><div class="v">${t.detourFactor ?? '—'}</div><div class="l">к объезду</div></div>`;

  $('#order-chips').innerHTML =
    'Порядок: ' +
    res.order.map((pi, pos) => `<span class="chip"><b>${pos + 1}</b>. ${escapeHtml(state.points[pi].name)}</span>`).join(' ');

  // таблица ног
  const departBase = res.options.departHour !== null && res.options.departHour !== undefined
    ? new Date(new Date().setHours(res.options.departHour, 0, 0, 0))
    : new Date();
  let acc = departBase.getTime();
  const tbody = $('#legs-table tbody');
  tbody.innerHTML = '';
  res.legs.forEach((leg, i) => {
    const arrive = new Date(acc + leg.durationS * 1000);
    const hhmm = (d) => String(d.getHours()).padStart(2, '0') + ':' + String(d.getMinutes()).padStart(2, '0');
    const tr = document.createElement('tr');
    tr.innerHTML = `
      <td>${i + 1}</td>
      <td>${escapeHtml(leg.fromName)} → ${escapeHtml(leg.toName)}</td>
      <td><b>${fmtKm(leg.distanceM)}</b></td>
      <td>${fmtDur(leg.durationS)}</td>
      <td>${leg.avgSpeedKmh}</td>
      <td>${i === 0 ? hhmm(departBase) : ''}${i > 0 ? hhmm(arrive) : ''}</td>`;
    tr.onmouseenter = () => state.legLines[i]?.setStyle({ weight: 8, color: '#1d5fc4' });
    tr.onmouseleave = () => state.legLines[i]?.setStyle({ weight: 5, color: '#2b7de9' });
    tbody.appendChild(tr);
    acc += leg.durationS * 1000;
  });

  $('#result-meta').textContent =
    `${res.optimizer.method} · точек: ${res.optimizer.points} · матрица ${res.optimizer.matrixMs} мс · ` +
    `оптимизация ${res.optimizer.optimizeMs ?? '—'} мс · всего ${res.optimizer.totalMs} мс` +
    (res.options.traffic ? ' · пробки учтены' : ' · без пробок');

  $('#warnings').innerHTML = (res.warnings || []).map((w) => '⚠ ' + escapeHtml(w)).join('<br>');

  $('#results').classList.remove('hidden');
  if (bounds.length > 0) {
    map.fitBounds(bounds, { padding: [40, 40] });
  }
}

/* ================= экспорт ================= */

function download(name, content, type) {
  const a = document.createElement('a');
  a.href = URL.createObjectURL(new Blob([content], { type }));
  a.download = name;
  a.click();
  URL.revokeObjectURL(a.href);
}

function exportGPX() {
  if (!state.result) return;
  const pts = [];
  for (const leg of state.result.legs) {
    if (leg.coords) for (const [lat, lon] of leg.coords) pts.push([lat, lon]);
  }
  const gpx =
    `<?xml version="1.0" encoding="UTF-8"?>\n<gpx version="1.1" creator="OptMap" xmlns="http://www.topografix.com/GPX/1/1">\n` +
    `  <trk><name>OptMap маршрут</name><trkseg>\n` +
    pts.map(([lat, lon]) => `    <trkpt lat="${lat.toFixed(6)}" lon="${lon.toFixed(6)}"/>`).join('\n') +
    `\n  </trkseg></trk>\n</gpx>\n`;
  download('optmap-route.gpx', gpx, 'application/gpx+xml');
}

function exportJSON() {
  if (!state.result) return;
  download('optmap-result.json', JSON.stringify(state.result, null, 2), 'application/json');
}

function showCurl() {
  if (!state.points.length) return;
  const body = {
    points: state.points.map((p) => ({ lat: +p.lat.toFixed(5), lon: +p.lon.toFixed(5), name: p.name })),
    options: currentOptions(),
  };
  $('#curl-box').textContent =
    `curl -X POST ${location.origin}/api/optimize \\\n` +
    `  -H "Content-Type: application/json" \\\n` +
    `  -d '${JSON.stringify(body)}'`;
  $('#curl-box').classList.remove('hidden');
}

/* ================= UI ================= */

function bindUI() {
  $('#btn-optimize').onclick = optimize;
  $('#btn-gpx').onclick = exportGPX;
  $('#btn-json').onclick = exportJSON;
  $('#btn-curl').onclick = showCurl;

  $('#opt-roundtrip').onchange = () => {
    $('#row-endlocked').style.display = $('#opt-roundtrip').checked ? 'none' : '';
    clearResult();
  };
  for (const id of ['opt-endlocked', 'opt-mode', 'opt-traffic', 'opt-depart']) {
    $('#' + id).onchange = clearResult;
  }
  $('#opt-traffic').onchange = () => {
    $('#opt-depart').disabled = !$('#opt-traffic').checked;
  };

  // варианты времени выезда
  const dep = $('#opt-depart');
  for (let h = 0; h < 24; h++) {
    const o = document.createElement('option');
    o.value = String(h);
    o.textContent = `${String(h).padStart(2, '0')}:00`;
    dep.appendChild(o);
  }
  dep.value = '';
  // отметим часы пик в подсказке
  dep.title = '8:00–9:00 и 17:00–18:00 — час пик (будни)';

  // поиск
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
      try {
        const r = await (await fetch('/api/geocode?q=' + encodeURIComponent(q))).json();
        box.innerHTML = '';
        for (const item of r.results || []) {
          const el = document.createElement('div');
          el.className = 'search-item';
          el.innerHTML = `<span>${escapeHtml(item.name)}</span><span class="cls">${item.cls}</span>`;
          el.onclick = () => {
            box.classList.add('hidden');
            input.value = '';
            addPoint(item.lat, item.lon, item.name);
            state.map.setView([item.lat, item.lon], Math.max(state.map.getZoom(), 14));
          };
          box.appendChild(el);
        }
        box.classList.toggle('hidden', (r.results || []).length === 0);
      } catch (e) {
        box.classList.add('hidden');
      }
    }, 250);
  };
  document.addEventListener('click', (e) => {
    if (!e.target.closest('.search-row')) box.classList.add('hidden');
  });
}

function toast(msg, isError = false) {
  const t = $('#toast');
  t.textContent = msg;
  t.className = 'toast' + (isError ? ' error' : '');
  clearTimeout(t._timer);
  t._timer = setTimeout(() => t.classList.add('hidden'), 5000);
}

init();
