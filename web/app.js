/* OptMap — офлайн-карта: поиск, маршруты, подписи. Весь код работает
   против локального сервера, внешних запросов нет. */
"use strict";

const $ = (id) => document.getElementById(id);

const state = {
  config: null,
  labels: [],
  theme: localStorage.getItem("optmap-theme") || "light",
  pick: null,            // 'from' | 'to' | null — режим выбора точки кликом
  pointA: null,          // {lon, lat, label}
  pointB: null,
  route: null,
  markers: [],           // {el, lngLat, labelEl?}
};

// ---------------------------------------------------------------- утилиты
const fmtDist = (m) => (m < 1000 ? `${Math.round(m)} м` : `${(m / 1000).toFixed(1)} км`);
const fmtTime = (s) => {
  const m = Math.round(s / 60);
  if (m < 60) return `${m} мин`;
  const h = Math.floor(m / 60);
  return `${h} ч ${m % 60} мин`;
};
const debounce = (fn, ms) => {
  let t;
  return (...a) => {
    clearTimeout(t);
    t = setTimeout(() => fn(...a), ms);
  };
};

// ---------------------------------------------------------------- карта
let map;

async function boot() {
  const [config, labels] = await Promise.all([
    fetch("/api/config").then((r) => r.json()),
    fetch("/api/labels").then((r) => r.json()),
  ]);
  state.config = config;
  state.labels = labels.labels;
  $("attribution").textContent = config.attribution + " · OptMap";

  document.documentElement.dataset.theme = state.theme;

  map = new maplibregl.Map({
    container: "map",
    style: state.theme === "dark" ? "/style-dark.json" : "/style-light.json",
    center: config.center,
    zoom: 15,
    minZoom: config.minZoom,
    maxZoom: config.maxZoom,
    dragRotate: false,
    pitchWithRotate: false,
    attributionControl: false,
    fadeDuration: 0,
  });

  map.addControl(new maplibregl.NavigationControl({ showCompass: false }), "top-right");

  map.on("load", () => {
    addRouteLayers();
    updateLabels();
    updateStatus();
  });
  map.on("move", () => { scheduleLabels(); updateStatus(); });
  map.on("zoom", () => { scheduleLabels(); updateStatus(); });
  map.on("render", () => { if (!state._labs) scheduleLabels(); });
  map.on("click", onMapClick);

  bindUI();
}

function addRouteLayers() {
  map.addSource("route", {
    type: "geojson",
    data: { type: "Feature", properties: {}, geometry: { type: "LineString", coordinates: [] } },
  });
  map.addLayer({
    id: "route-casing", type: "line", source: "route",
    paint: { "line-color": "#1d4ed8", "line-width": 9, "line-opacity": .35, "line-cap": "round" },
    layout: { "line-join": "round" },
  });
  map.addLayer({
    id: "route-line", type: "line", source: "route",
    paint: { "line-color": "#2f7de1", "line-width": 5.5, "line-cap": "round" },
    layout: { "line-join": "round" },
  });
}

// ---------------------------------------------------------------- подписи
const labelEls = new Map();
let labelScheduled = false;

function scheduleLabels() {
  if (labelScheduled) return;
  labelScheduled = true;
  requestAnimationFrame(() => {
    labelScheduled = false;
    updateLabels();
  });
}

const measureCanvas = document.createElement("canvas").getContext("2d");

function labelFont(layer) {
  if (layer === "place") return "700 15px -apple-system, 'Segoe UI', Roboto, Arial, sans-serif";
  if (layer === "district") return "600 11px -apple-system, 'Segoe UI', Roboto, Arial, sans-serif";
  if (layer === "road") return "400 11.5px -apple-system, 'Segoe UI', Roboto, Arial, sans-serif";
  if (layer === "address") return "400 10.5px -apple-system, 'Segoe UI', Roboto, Arial, sans-serif";
  if (layer === "poi") return "500 12px -apple-system, 'Segoe UI', Roboto, Arial, sans-serif";
  return "400 12px -apple-system, 'Segoe UI', Roboto, Arial, sans-serif";
}

const MIN_ZOOM = { poi: 15, park: 15, water: 13, address: 17.2, place: 8, district: 11, road: 12 };

function updateLabels() {
  const container = $("labels");
  if (!map || !state.labels.length) return;
  const z = map.getZoom();
  const w = map.getCanvas().clientWidth;
  const h = map.getCanvas().clientHeight;

  const CELL = 180;
  const gw = Math.ceil(w / CELL) + 2;
  const occ = new Map();
  const key = (cx, cy) => cx * 1000 + cy;

  const placed = [];
  let count = 0;
  const MAX = 260;

  for (const lb of state.labels) {
    if (count >= MAX) break;
    const minz = lb.l === "road" ? (lb.z || 12) : (MIN_ZOOM[lb.l] || 0);
    if (z < minz) continue;
    if (z > (lb.l === "address" ? 19 : 19)) continue;

    const p = map.project([lb.lon, lb.lat]);
    const pad = 60;
    if (p.x < -pad || p.y < -pad || p.x > w + pad || p.y > h + pad) continue;

    const cls = lb.l === "place" && lb.p === 0 ? "place big" : lb.l;
    measureCanvas.font = labelFont(lb.l);
    let text = lb.n;
    if (lb.l === "address" && z < 18.2) text = "";
    const tw = measureCanvas.measureText(text).width;
    const extra = lb.l === "poi" ? 12 : 0;
    const bw = tw + extra + 8;
    const bh = 16;

    // коллизия по сетке
    const x0 = Math.floor((p.x - bw / 2) / CELL);
    const x1 = Math.floor((p.x + bw / 2) / CELL);
    const y0 = Math.floor((p.y - bh / 2) / CELL);
    const y1 = Math.floor((p.y + bh / 2) / CELL);
    let hit = false;
    for (let cx = x0; cx <= x1 && !hit; cx++) {
      for (let cy = y0; cy <= y1 && !hit; cy++) {
        const list = occ.get(key(cx, cy));
        if (!list) continue;
        for (const r of list) {
          if (Math.abs(r.x - p.x) * 2 < r.w + bw && Math.abs(r.y - p.y) * 2 < r.h + bh) {
            hit = true;
            break;
          }
        }
      }
    }
    if (hit) continue;

    // дедуп одноимённых улиц рядом
    if (lb.l === "road" || lb.l === "place") {
      for (const r of placed) {
        if (r.name === lb.n && Math.hypot(r.x - p.x, r.y - p.y) < 110) { hit = true; break; }
      }
      if (hit) continue;
    }

    for (let cx = x0; cx <= x1; cx++) {
      for (let cy = y0; cy <= y1; cy++) {
        const k = key(cx, cy);
        if (!occ.has(k)) occ.set(k, []);
        occ.get(k).push({ x: p.x, y: p.y, w: bw, h: bh });
      }
    }
    placed.push({ x: p.x, y: p.y, name: lb.n });

    let el = labelEls.get(lb);
    if (!el) {
      el = document.createElement("div");
      el.className = "lbl " + cls;
      labelEls.set(lb, el);
      container.appendChild(el);
    }
    let html = "";
    if (lb.l === "poi") html += `<span class="dot${lb.p === 4 ? " minor" : ""}"></span>`;
    html += text ? escapeHtml(text) : "";
    el.innerHTML = html;
    el.style.display = text ? "" : "none";
    el.style.font = labelFont(lb.l);
    el.style.transform = `translate(${p.x}px, ${p.y}px) translate(-50%, -50%)`;
    if (lb.l === "road" && lb.ang !== undefined && z >= 14) {
      el.style.rotate = `${lb.ang}deg`;
    } else {
      el.style.rotate = "";
    }
    el._used = true;
    count++;
  }

  // скрываем неиспользованные
  for (const [lb, el] of labelEls) {
    if (!el._used) el.style.display = "none";
    el._used = false;
  }
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}

// ---------------------------------------------------------------- поиск
function makeSearch(inputId, ddId, onPick) {
  const input = $(inputId);
  const dd = $(ddId);
  let items = [];
  let sel = -1;

  const render = (results) => {
    items = results;
    sel = -1;
    if (!results.length) {
      dd.innerHTML = `<div class="empty">Ничего не найдено</div>`;
    } else {
      dd.innerHTML = results.map((r, i) => `
        <div class="item" data-i="${i}">
          <div class="ic">${iconFor(r)}</div>
          <div class="tx">
            <div class="t">${escapeHtml(r.label)}</div>
            <div class="s">${typeName(r.type)}</div>
          </div>
        </div>`).join("");
      dd.querySelectorAll(".item").forEach((el) =>
        el.addEventListener("mousedown", (e) => {
          e.preventDefault();
          choose(parseInt(el.dataset.i, 10));
        }));
    }
    dd.hidden = false;
  };

  const choose = (i) => {
    const r = items[i];
    if (!r) return;
    dd.hidden = true;
    input.value = r.label;
    onPick(r);
  };

  const doSearch = debounce(async () => {
    const q = input.value.trim();
    if (q.length < 2) { dd.hidden = true; return; }
    try {
      const res = await fetch("/api/search?q=" + encodeURIComponent(q));
      const data = await res.json();
      render(data.results);
    } catch (e) {
      dd.hidden = true;
    }
  }, 160);

  input.addEventListener("input", doSearch);
  input.addEventListener("focus", () => { if (items.length) dd.hidden = false; });
  input.addEventListener("keydown", (e) => {
    if (dd.hidden) return;
    const els = dd.querySelectorAll(".item");
    if (e.key === "ArrowDown" || e.key === "ArrowUp") {
      e.preventDefault();
      sel += e.key === "ArrowDown" ? 1 : -1;
      sel = Math.max(-1, Math.min(els.length - 1, sel));
      els.forEach((el, i) => el.classList.toggle("sel", i === sel));
      if (sel >= 0) els[sel].scrollIntoView({ block: "nearest" });
    } else if (e.key === "Enter") {
      e.preventDefault();
      if (sel >= 0) choose(sel);
      else if (els.length) choose(0);
    } else if (e.key === "Escape") {
      dd.hidden = true;
    }
  });
  input.addEventListener("blur", () => setTimeout(() => { dd.hidden = true; }, 120));

  return { setValue: (v) => { input.value = v; } };
}

function iconFor(r) {
  if (r.type === "address") return "№";
  if (r.type === "street") return "〰";
  if (r.type === "poi") return "★";
  return "◉";
}
function typeName(t) {
  return { address: "Адрес", street: "Улица", poi: "Объект", place: "Населённый пункт" }[t] || "";
}

// ---------------------------------------------------------------- попап
let popupEl = null;
function showPopup(lngLat, title, sub, actions) {
  hidePopup();
  const el = document.createElement("div");
  el.id = "popup";
  el.className = "popup";
  el.hidden = false;
  el._lngLat = lngLat;
  el.innerHTML = `
    <div class="t">${escapeHtml(title)}</div>
    ${sub ? `<div class="s">${escapeHtml(sub)}</div>` : ""}
    <div class="acts"></div>`;
  const acts = el.querySelector(".acts");
  (actions || []).forEach((a) => {
    const b = document.createElement("button");
    b.className = "btn small";
    b.textContent = a.label;
    b.addEventListener("click", () => { a.onClick(); hidePopup(); });
    acts.appendChild(b);
  });
  document.body.appendChild(el);
  popupEl = el;
  positionPopup();
}

function positionPopup() {
  if (!popupEl || !map || !popupEl._lngLat) return;
  const p = map.project(popupEl._lngLat);
  popupEl.style.left = p.x + "px";
  popupEl.style.top = p.y + "px";
}

function hidePopup() {
  if (popupEl) { popupEl.remove(); popupEl = null; }
}

function onMapClick(e) {
  const { lng, lat } = e.lngLat;
  if (state.pick) {
    setPoint(state.pick, { lon: lng, lat, label: `${lat.toFixed(5)}, ${lng.toFixed(5)}` });
    state.pick = null;
    document.body.style.cursor = "";
    return;
  }
  fetch(`/api/reverse?lon=${lng}&lat=${lat}`)
    .then((r) => r.json())
    .then((d) => {
      if (!d || !d.label) {
        showPopup([lng, lat], "Нет данных", `${lat.toFixed(5)}, ${lng.toFixed(5)}`, [
          { label: "Отсюда", onClick: () => setPoint("from", { lon: lng, lat, label: "Точка на карте" }) },
          { label: "Сюда", onClick: () => setPoint("to", { lon: lng, lat, label: "Точка на карте" }) },
        ]);
        popupEl._lngLat = [lng, lat];
        positionPopup();
        return;
      }
      showPopup([lng, lat], d.label,
        `${typeName(d.type)}${d.kind ? " · " + d.kind : ""} · ${d.distance} м`,
        [
          { label: "Отсюда", onClick: () => setPoint("from", { lon: lng, lat, label: d.label }) },
          { label: "Сюда", onClick: () => setPoint("to", { lon: lng, lat, label: d.label }) },
        ]);
      popupEl._lngLat = [lng, lat];
      positionPopup();
    })
    .catch(() => {});
}

// ---------------------------------------------------------------- маркеры
function setMarker(kind, lngLat, label) {
  const el = document.createElement("div");
  el.className = "marker " + (kind === "from" ? "a" : kind === "to" ? "b" : "sel");
  const lab = document.createElement("div");
  lab.className = "marker-label";
  lab.textContent = label || "";
  $("labels").appendChild(el);
  $("labels").appendChild(lab);
  state.markers.push({ el, lngLat, labelEl: lab, kind });
  positionMarkers();
}

function positionMarkers() {
  if (!map) return;
  for (const m of state.markers) {
    const p = map.project(m.lngLat);
    m.el.style.left = p.x + "px";
    m.el.style.top = p.y + "px";
    m.labelEl.style.left = p.x + "px";
    m.labelEl.style.top = p.y + "px";
  }
}

function clearMarkers() {
  for (const m of state.markers) { m.el.remove(); m.labelEl.remove(); }
  state.markers = [];
}

// ---------------------------------------------------------------- маршрут
function setPoint(kind, pt) {
  if (kind === "from") { state.pointA = pt; searchFrom.setValue(pt.label || ""); }
  else { state.pointB = pt; searchTo.setValue(pt.label || ""); }
  clearMarkers();
  if (state.pointA) setMarker("from", [state.pointA.lon, state.pointA.lat], "А");
  if (state.pointB) setMarker("to", [state.pointB.lon, state.pointB.lat], "Б");
}

function setRoute(geo) {
  const src = map.getSource("route");
  if (!src) return;
  src.setData({
    type: "Feature",
    properties: {},
    geometry: { type: "LineString", coordinates: geo },
  });
}

let searchFrom, searchTo;

async function buildRoute() {
  if (!state.pointA || !state.pointB) {
    alert("Укажите обе точки маршрута");
    return;
  }
  const mode = document.querySelector('input[name="mode"]:checked').value;
  const url = `/api/route?a=${state.pointA.lon},${state.pointA.lat}`
    + `&b=${state.pointB.lon},${state.pointB.lat}&mode=${mode}`;
  const data = await fetch(url).then((r) => r.json());
  const summary = $("route-summary");
  const stepsEl = $("route-steps");
  if (data.error) {
    summary.hidden = false;
    summary.innerHTML = `<div>${escapeHtml(data.error)}</div>`;
    stepsEl.innerHTML = "";
    setRoute([]);
    return;
  }
  state.route = data;
  setRoute(data.geometry);
  summary.hidden = false;
  summary.innerHTML = `
    <div>${fmtDist(data.distance)} · ${fmtTime(data.duration)}</div>
    <div class="sub">${mode === "foot" ? "Пешком" : "На автомобиле"} · ${data.steps.length} участков</div>`;
  stepsEl.innerHTML = "";
  data.instructions.forEach((s) => {
    const li = document.createElement("li");
    li.innerHTML = `<span class="mn">${maneuverIcon(s.maneuver)}</span>`
      + `<span>${escapeHtml(s.text)}</span>`;
    if (s.at) {
      li.addEventListener("click", () => {
        map.easeTo({ center: s.at, duration: 500 });
      });
    }
    stepsEl.appendChild(li);
  });
  // вписать маршрут в экран
  const b = new maplibregl.LngLatBounds();
  data.geometry.forEach((c) => b.extend(c));
  map.fitBounds(b, { padding: 70, duration: 700 });
}

function maneuverIcon(m) {
  return {
    depart: "↑", arrive: "⚑", left: "↰", right: "↱",
    "slight-left": "←", "slight-right": "→", uturn: "↺", straight: "↑",
  }[m] || "↑";
}

// ---------------------------------------------------------------- UI
function bindUI() {
  searchFrom = makeSearch("route-from", "dd-from", (r) =>
    setPoint("from", { lon: r.lon, lat: r.lat, label: r.label }));
  searchTo = makeSearch("route-to", "dd-to", (r) =>
    setPoint("to", { lon: r.lon, lat: r.lat, label: r.label }));

  makeSearch("search", "search-results", (r) => {
    map.easeTo({ center: [r.lon, r.lat], zoom: Math.max(map.getZoom(), 16.5), duration: 700 });
    showPopup([r.lon, r.lat], r.label, typeName(r.type), [
      { label: "Отсюда", onClick: () => setPoint("from", { lon: r.lon, lat: r.lat, label: r.label }) },
      { label: "Сюда", onClick: () => setPoint("to", { lon: r.lon, lat: r.lat, label: r.label }) },
    ]);
    popupEl._lngLat = [r.lon, r.lat];
    positionPopup();
  });

  $("btn-theme").addEventListener("click", () => {
    state.theme = state.theme === "light" ? "dark" : "light";
    localStorage.setItem("optmap-theme", state.theme);
    document.documentElement.dataset.theme = state.theme;
    map.setStyle(state.theme === "dark" ? "/style-dark.json" : "/style-light.json");
    map.once("style.load", () => { addRouteLayers(); if (state.route) setRoute(state.route.geometry); });
  });

  $("btn-route").addEventListener("click", () => {
    const p = $("route-panel");
    p.hidden = !p.hidden;
    $("btn-route").classList.toggle("active", !p.hidden);
  });
  $("route-close").addEventListener("click", () => {
    $("route-panel").hidden = true;
    $("btn-route").classList.remove("active");
  });

  $("route-build").addEventListener("click", buildRoute);
  $("route-swap").addEventListener("click", () => {
    const a = state.pointA, b = state.pointB;
    state.pointA = b; state.pointB = a;
    if (a) searchTo.setValue(a.label || "");
    if (b) searchFrom.setValue(b.label || "");
    clearMarkers();
    if (state.pointA) setMarker("from", [state.pointA.lon, state.pointA.lat], "А");
    if (state.pointB) setMarker("to", [state.pointB.lon, state.pointB.lat], "Б");
  });

  $("btn-zoom-in").addEventListener("click", () => map.zoomIn());
  $("btn-zoom-out").addEventListener("click", () => map.zoomOut());
  $("btn-reset").addEventListener("click", () => {
    map.easeTo({ center: state.config.center, zoom: 15, duration: 600 });
  });
  $("btn-locate").addEventListener("click", () => {
    if (!navigator.geolocation) return;
    navigator.geolocation.getCurrentPosition(
      (pos) => {
        const c = [pos.coords.longitude, pos.coords.latitude];
        map.easeTo({ center: c, zoom: 17 });
        clearMarkers();
        setMarker("sel", c, "Вы здесь");
      },
      () => alert("Не удалось определить местоположение"),
      { enableHighAccuracy: true, timeout: 8000 });
  });

  document.addEventListener("keydown", (e) => {
    if (e.key === "/" && document.activeElement.tagName !== "INPUT") {
      e.preventDefault();
      $("search").focus();
    }
  });

  map.on("move", positionMarkers);
  map.on("move", positionPopup);

  window.addEventListener("resize", debounce(() => {
    scheduleLabels();
    positionMarkers();
    positionPopup();
    updateStatus();
  }, 150));
}

function updateStatus() {
  const c = map.getCenter();
  $("coords").textContent = `${c.lat.toFixed(5)}, ${c.lng.toFixed(5)}`;
  $("zoomlabel").textContent = "z" + map.getZoom().toFixed(1);

  // масштаб
  const mpp = 156543.03392 * Math.cos((c.lat * Math.PI) / 180) / Math.pow(2, map.getZoom());
  const nice = [1, 2, 5, 10, 20, 50, 100, 200, 500, 1000, 2000, 5000, 10000, 20000, 50000, 100000];
  let d = nice[nice.length - 1];
  for (const n of nice) { if (n / mpp <= 110) { d = n; break; } }
  $("scale").textContent = d < 1000 ? `${d} м` : `${d / 1000} км`;
  $("scalebar-fill").style.width = Math.round(d / mpp) + "px";
}

boot();
