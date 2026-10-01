"""Генерация векторных тайлов (MVT) из модели OSM."""
import math
import os

from .mvt import POINT, LINESTRING, POLYGON, Layer, encode_tile
from .osm_model import (
    GREEN_NATURAL, GREEN_LANDUSE, GREEN_LEISURE, POI_KIND_RU, ROAD_CLASSES,
    centroid, haversine, polygon_centroid,
)

EXTENT = 4096


# ---------------- проекция ----------------

def lonlat_to_world(lon, lat):
    x = (lon + 180.0) / 360.0
    s = math.sin(math.radians(lat))
    s = max(-0.9999, min(0.9999, s))
    y = 0.5 - math.log((1 + s) / (1 - s)) / (4 * math.pi)
    return x, y


def world_to_tilepx(wx, wy, z, tx, ty):
    n = 2 ** z
    return (wx * n - tx) * EXTENT, (wy * n - ty) * EXTENT


def tile_bounds_lonlat(z, tx, ty):
    n = 2 ** z
    lon1 = tx / n * 360 - 180
    lon2 = (tx + 1) / n * 360 - 180
    lat1 = math.degrees(math.atan(math.sinh(math.pi * (1 - 2 * ty / n))))
    lat2 = math.degrees(math.atan(math.sinh(math.pi * (1 - 2 * (ty + 1) / n))))
    return lon1, lat2, lon2, lat1  # west, south, east, north


# ---------------- клиппинг ----------------

def _intersect(a, b, x, axis):
    t = (x - a[axis]) / (b[axis] - a[axis])
    return (a[0] + t * (b[0] - a[0]), a[1] + t * (b[1] - a[1]))


def clip_polygon(ring, x0, y0, x1, y1):
    def clip(pts, inside, inter):
        if not pts:
            return []
        out = []
        prev = pts[-1]
        pin = inside(prev)
        for cur in pts:
            cin = inside(cur)
            if cin:
                if not pin:
                    out.append(inter(prev, cur))
                out.append(cur)
            elif pin:
                out.append(inter(prev, cur))
            prev, pin = cur, cin
        return out

    pts = list(ring)
    pts = clip(pts, lambda p: p[0] >= x0, lambda a, b: _intersect(a, b, x0, 0))
    pts = clip(pts, lambda p: p[0] <= x1, lambda a, b: _intersect(a, b, x1, 0))
    pts = clip(pts, lambda p: p[1] >= y0, lambda a, b: _intersect(a, b, y0, 1))
    pts = clip(pts, lambda p: p[1] <= y1, lambda a, b: _intersect(a, b, y1, 1))
    return pts


def clip_line(p0, p1, x0, y0, x1, y1):
    dx, dy = p1[0] - p0[0], p1[1] - p0[1]
    t0, t1 = 0.0, 1.0
    for p, q in ((-dx, p0[0] - x0), (dx, x1 - p0[0]),
                 (-dy, p0[1] - y0), (dy, y1 - p0[1])):
        if p == 0:
            if q < 0:
                return None
        else:
            r = q / p
            if p < 0:
                if r > t1:
                    return None
                if r > t0:
                    t0 = r
            else:
                if r < t0:
                    return None
                if r < t1:
                    t1 = r
    if t1 <= t0:
        return None
    return ((p0[0] + t0 * dx, p0[1] + t0 * dy),
            (p0[0] + t1 * dx, p0[1] + t1 * dy))


def _same_pt(a, b):
    return abs(a[0] - b[0]) < 1e-9 and abs(a[1] - b[1]) < 1e-9


def clip_polyline(pts, x0, y0, x1, y1):
    out = []
    cur = []
    for i in range(len(pts) - 1):
        seg = clip_line(pts[i], pts[i + 1], x0, y0, x1, y1)
        if seg is None:
            if len(cur) >= 2:
                out.append(cur)
            cur = []
            continue
        a, b = seg
        if not cur:
            cur = [a, b]
        elif _same_pt(cur[-1], a):
            cur.append(b)
        else:
            if len(cur) >= 2:
                out.append(cur)
            cur = [a, b]
    if len(cur) >= 2:
        out.append(cur)
    return out


# ---------------- подготовка объектов ----------------

class Feature:
    __slots__ = ("layer", "minz", "props", "kind", "geom")

    def __init__(self, layer, minz, props, geom, kind="poly"):
        self.layer = layer
        self.minz = minz
        self.props = props
        self.geom = geom  # POINT: (lon,lat); POLY: [(role, pts)]; LINE: [pts]
        self.kind = kind


def _num(v, default=None):
    try:
        return float(v)
    except (TypeError, ValueError):
        return default


def collect_features(model):
    """Превращает модель в плоский список Feature (в градусах)."""
    feats = []

    # --- земля: кольца береговой линии ---
    coast = [model.way_coords(w) for w in model.iter_line_ways()
             if w["tags"].get("natural") == "coastline"]
    rings, _ = chain(coast)
    for ring in rings:
        if len(ring) < 4:
            continue
        feats.append(Feature("land", 0, {"kind": "land"}, [("outer", ring)]))

    # --- мультиполигоны ---
    for mp in model.multipolygon_relations():
        t = mp["tags"]
        layer = _area_layer(t)
        if not layer:
            continue
        minz = 11 if layer != "sand" else 14
        feats.append(Feature(layer, minz, _area_props(t), mp["rings"]))

    # --- полигоны из закрытых путей ---
    for w in model.iter_area_ways():
        t = w["tags"]
        layer = _area_layer(t)
        if not layer:
            continue
        pts = model.way_coords(w)
        if len(pts) < 4:
            continue
        minz = 11 if layer != "sand" else 14
        feats.append(Feature(layer, minz, _area_props(t), [("outer", pts)]))

    # --- линии ---
    for w in model.iter_line_ways():
        t = w["tags"]
        pts = model.way_coords(w)
        if len(pts) < 2:
            continue
        if "highway" in t and t["highway"] in ROAD_CLASSES:
            minz, group = ROAD_CLASSES[t["highway"]]
            props = _road_props(t)
            layer = "road_" + ("major" if group == "major" else
                               "main" if group == "main" else
                               "local" if group == "local" else
                               "minor" if group == "minor" else "path")
            if layer in ("road_major", "road_main"):
                feats.append(Feature(layer + "_case", max(minz - 1, 8),
                                     dict(props), [pts], kind="line"))
            feats.append(Feature(layer, minz, props, [pts], kind="line"))
        elif "railway" in t:
            feats.append(Feature("rail", 13, {"kind": t.get("railway", "rail")},
                                 [pts], kind="line"))
        elif "waterway" in t:
            feats.append(Feature("waterway", 14, {"kind": t["waterway"]},
                                 [pts], kind="line"))
        elif "barrier" in t:
            feats.append(Feature("barrier", 15, {"kind": t["barrier"]},
                                 [pts], kind="line"))

    # --- административные границы (линии) ---
    for b in model.boundary_relations():
        lvl = _num(b["tags"].get("admin_level"))
        if lvl is None or lvl > 8:
            continue
        for line in b["lines"]:
            feats.append(Feature("boundary", 8, {"level": int(lvl)},
                                 [line], kind="line"))

    # --- подписи районов/городов из границ ---
    for b in model.boundary_relations():
        t = b["tags"]
        lvl = _num(t.get("admin_level"))
        if lvl is None or not b["centroid"]:
            continue
        name = t.get("name:ru") or t.get("name")
        if not name:
            continue
        if lvl <= 4:
            feats.append(Feature("place", 0, {"name": name, "rank": int(lvl)},
                                 b["centroid"], kind="point"))
        elif lvl <= 8:
            feats.append(Feature("place", 9, {"name": name, "rank": int(lvl)},
                                 b["centroid"], kind="point"))
        else:
            feats.append(Feature("district", 12, {"name": name, "rank": int(lvl)},
                                 b["centroid"], kind="point"))

    # --- POI и подписи из узлов ---
    for nid, (lon, lat) in model.nodes.items():
        t = model.node_tags.get(nid)
        if not t:
            continue
        name = t.get("name:ru") or t.get("name")
        place = t.get("place")
        if place and name:
            rank = {"continent": 1, "country": 2, "state": 3, "city": 8,
                    "town": 8, "village": 9, "suburb": 10, "quarter": 11,
                    "neighbourhood": 12, "islet": 14}.get(place, 12)
            layer = "place" if rank <= 9 else "district"
            feats.append(Feature(layer, 0 if rank <= 9 else 12,
                                 {"name": name, "rank": rank},
                                 (lon, lat), kind="point"))
            continue
        kind, kind_ru = _poi_kind(t)
        if not kind:
            continue
        imp = _poi_importance(kind)
        props = {"name": name, "kind": kind, "kind_ru": kind_ru}
        if name:
            feats.append(Feature("poi", imp["minz"], props, (lon, lat),
                                 kind="point"))
        elif imp.get("icon"):
            feats.append(Feature("poi_minor", imp["minz"] + 1, props,
                                 (lon, lat), kind="point"))

    # --- POI из путей (центроид) ---
    for w in model.iter_area_ways():
        t = w["tags"]
        if not any(k in t for k in ("amenity", "shop", "tourism", "leisure",
                                    "historic", "office")):
            continue
        name = t.get("name:ru") or t.get("name")
        if not name:
            continue
        pts = model.way_coords(w)
        if len(pts) < 4:
            continue
        kind, kind_ru = _poi_kind(t)
        imp = _poi_importance(kind) if kind else {"minz": 16, "icon": False}
        feats.append(Feature("poi", imp["minz"],
                             {"name": name, "kind": kind, "kind_ru": kind_ru},
                             polygon_centroid(pts), kind="point"))

    # --- подписи дорог ---
    for w in model.iter_line_ways():
        t = w["tags"]
        hw = t.get("highway")
        if hw not in ROAD_CLASSES:
            continue
        name = t.get("name") or t.get("ref")
        if not name:
            continue
        minz, group = ROAD_CLASSES[hw]
        if group == "path":
            continue
        pts = model.way_coords(w)
        if len(pts) < 2:
            continue
        mid = _midpoint_of_way(pts)
        if mid is None:
            continue
        feats.append(Feature("road_label", minz,
                             {"name": name, "ref": t.get("ref"),
                              "group": group}, mid, kind="point"))

    # --- подписи водоёмов ---
    for w in model.iter_area_ways():
        t = w["tags"]
        if t.get("natural") not in ("water", "bay", "strait"):
            continue
        name = t.get("name:ru") or t.get("name")
        if not name:
            continue
        pts = model.way_coords(w)
        if len(pts) < 4:
            continue
        feats.append(Feature("water_label", 13, {"name": name},
                             polygon_centroid(pts), kind="point"))

    # --- подписи парков ---
    for w in model.iter_area_ways():
        t = w["tags"]
        if t.get("leisure") in ("park", "garden", "golf_course", "common"):
            name = t.get("name:ru") or t.get("name")
            if not name:
                continue
            pts = model.way_coords(w)
            if len(pts) < 4:
                continue
            feats.append(Feature("park_label", 15, {"name": name},
                                 polygon_centroid(pts), kind="point"))

    # --- адреса (номера домов) ---
    for nid, (lon, lat) in model.nodes.items():
        t = model.node_tags.get(nid)
        if not t:
            continue
        hn = t.get("addr:housenumber")
        if not hn:
            continue
        feats.append(Feature("address", 18,
                             {"housenumber": hn,
                              "street": t.get("addr:street"),
                              "city": t.get("addr:city")},
                             (lon, lat), kind="point"))
    for w in model.iter_area_ways():
        t = w["tags"]
        hn = t.get("addr:housenumber")
        if not hn:
            continue
        pts = model.way_coords(w)
        if len(pts) < 4:
            continue
        feats.append(Feature("address", 18,
                             {"housenumber": hn,
                              "street": t.get("addr:street"),
                              "city": t.get("addr:city")},
                             polygon_centroid(pts), kind="point"))

    return feats


def chain(coord_ways):
    from .osm_model import chain_rings
    return chain_rings(coord_ways)


def _area_layer(t):
    if t.get("building") and t.get("building") != "no":
        return "building"
    nat = t.get("natural")
    if nat == "water" or t.get("waterway") in ("riverbank", "dock"):
        return "water"
    if nat in ("beach", "sand"):
        return "sand"
    if nat in GREEN_NATURAL or t.get("landuse") in GREEN_LANDUSE:
        return "green"
    if t.get("leisure") in ("park", "garden", "golf_course", "common",
                            "pitch", "dog_park"):
        return "park"
    if t.get("leisure") in GREEN_LEISURE:
        return "park"
    if t.get("landuse") in ("cemetery", "grave_yard"):
        return "cemetery"
    if t.get("amenity") in ("parking", "university", "college", "school",
                            "hospital", "kindergarten"):
        return "park"
    if t.get("landuse") in ("residential", "commercial", "retail",
                            "industrial", "construction"):
        return "area"
    return None


def _area_props(t):
    if t.get("building"):
        return {"kind": t["building"]}
    if t.get("natural") in ("water", "bay", "strait"):
        return {"kind": "water"}
    return {"kind": t.get("natural") or t.get("landuse") or
            t.get("leisure") or "area"}


def _road_props(t):
    hw = t["highway"]
    props = {"class": hw}
    name = t.get("name") or t.get("ref")
    if name:
        props["name"] = name
    if t.get("ref"):
        props["ref"] = t["ref"]
    if t.get("tunnel") in ("yes", "building_passage", "culvert"):
        props["tunnel"] = 1
    if t.get("bridge") in ("yes", "viaduct"):
        props["bridge"] = 1
    if t.get("oneway") in ("yes", "-1", "1"):
        props["oneway"] = 1
    lanes = _num(t.get("lanes"))
    if lanes:
        props["lanes"] = int(lanes)
    ms = _num(t.get("maxspeed"))
    if ms:
        props["maxspeed"] = ms
    return props


def _poi_kind(t):
    for key in ("amenity", "shop", "tourism", "leisure", "historic",
                "office", "emergency", "healthcare", "railway"):
        if key in t:
            v = t[key]
            return (key + "=" + v, POI_KIND_RU.get(v, _ru_kind(key, v)))
    return (None, None)


def _ru_kind(key, v):
    m = {"amenity": "Объект", "shop": "Магазин", "tourism": "Место",
         "leisure": "Зона отдыха", "historic": "Памятник",
         "office": "Офис", "emergency": "Экстренная служба",
         "healthcare": "Медицина", "railway": "Ж/д"}
    return m.get(key, "Место")


def _poi_importance(kind):
    if not kind:
        return {"minz": 17, "icon": False}
    k, v = kind.split("=", 1)
    major = {"amenity": ("parking", "place_of_worship", "school", "hospital",
                         "townhall", "police", "university", "theatre",
                         "cinema", "restaurant", "cafe", "bus_station",
                         "fuel", "bank", "post_office", "library"),
             "tourism": ("hotel", "museum", "attraction", "viewpoint",
                         "artwork", "zoo", "theme_park"),
             "shop": ("supermarket", "mall", "department_store"),
             "leisure": ("stadium", "sports_centre", "park", "garden",
                         "golf_course", "swimming_pool"),
             "historic": ("monument", "castle", "memorial", "ruins",
                          "cathedral", "church")}
    minor = {"amenity": ("fountain", "bench", "waste_basket", "atm",
                         "vending_machine", "bicycle_parking"),
             "shop": ("bakery", "convenience", "kiosk", "hairdresser",
                      "butcher", "clothes"),
             "tourism": ("guest_house", "hostel", "picnic_site", "camp_site")}
    if v in major.get(k, ()):
        return {"minz": 15, "icon": True}
    if v in minor.get(k, ()):
        return {"minz": 17, "icon": False}
    return {"minz": 16, "icon": False}


def _midpoint_of_way(pts):
    total = 0.0
    segs = []
    for i in range(len(pts) - 1):
        d = haversine(*pts[i], *pts[i + 1])
        segs.append(d)
        total += d
    if total <= 0:
        return None
    half = total / 2
    acc = 0.0
    for i, d in enumerate(segs):
        if acc + d >= half:
            t = (half - acc) / d if d else 0
            a, b = pts[i], pts[i + 1]
            return (a[0] + t * (b[0] - a[0]), a[1] + t * (b[1] - a[1]))
        acc += d
    return pts[len(pts) // 2]


# ---------------- генерация тайлов ----------------

def generate_tiles(features, out_dir, bounds, min_zoom, max_zoom, log=print):
    minlon, minlat, maxlon, maxlat = bounds
    wx0, wy1 = lonlat_to_world(minlon, minlat)   # wy1: южная граница
    wx1, wy0 = lonlat_to_world(maxlon, maxlat)   # wy0: северная граница

    by_layer = {}
    for f in features:
        by_layer.setdefault(f.layer, []).append(f)

    total = 0
    for z in range(min_zoom, max_zoom + 1):
        n = 2 ** z
        tx0 = max(int(math.floor(wx0 * n)) - 1, 0)
        tx1 = min(int(math.ceil(wx1 * n)) + 1, n - 1)
        ty0 = max(int(math.floor(wy0 * n)) - 1, 0)
        ty1 = min(int(math.ceil(wy1 * n)) + 1, n - 1)

        # ---- 1. проецируем активные объекты один раз на зум ----
        # prepared: {layer: [(feature, geom_px, bbox_px)]}
        prepared = {}
        for name, feats in by_layer.items():
            lst = []
            for f in feats:
                if f.minz > z:
                    continue
                gp, bb = _project(f, z)
                if gp is None:
                    continue
                lst.append((f, gp, bb))
            if lst:
                prepared[name] = lst

        # ---- 2. распределяем по тайлам через bbox ----
        tile_feats = {}
        for name, lst in prepared.items():
            for item in lst:
                f, gp, bb = item
                x0p, y0p, x1p, y1p = bb
                txa = int(x0p // EXTENT)
                txb = int(x1p // EXTENT)
                tya = int(y0p // EXTENT)
                tyb = int(y1p // EXTENT)
                if txb < tx0 or txa > tx1 or tyb < ty0 or tya > ty1:
                    continue
                for tx in range(max(txa, tx0), min(txb, tx1) + 1):
                    for ty in range(max(tya, ty0), min(tyb, ty1) + 1):
                        tile_feats.setdefault((tx, ty), []).append(item)

        # ---- 3. кодируем тайлы ----
        made = 0
        for (tx, ty), items in tile_feats.items():
            layers = {}
            for f, gp, bb in items:
                layer = layers.get(f.layer)
                if layer is None:
                    layer = Layer(f.layer)
                    layers[f.layer] = layer
                _emit(layer, f, gp, tx, ty)
            out = [l for l in layers.values() if l.features]
            if not out:
                continue
            data = encode_tile(out)
            if not data:
                continue
            d = os.path.join(out_dir, str(z), str(tx))
            os.makedirs(d, exist_ok=True)
            with open(os.path.join(d, f"{ty}.pbf.gz"), "wb") as fh:
                fh.write(data)
            made += 1
        total += made
        log(f"  зум {z}: тайлов {made}", flush=True)
    return total


def buckets_assign(lst):
    return lst


def _project(f, z):
    """Проецирует объект в абсолютные пиксели зума z (x = wx*2^z*EXTENT).
    Возвращает (geom_px, bbox_px) или (None, None)."""
    n = 2 ** z
    k = n * EXTENT
    if f.kind == "point":
        wx, wy = lonlat_to_world(*f.geom)
        px, py = wx * k, wy * k
        return [(px, py)], (px, py, px, py)
    if f.kind == "line":
        geom = []
        xs, ys = [], []
        for pts in f.geom:
            line = []
            for lon, lat in pts:
                wx, wy = lonlat_to_world(lon, lat)
                line.append((wx * k, wy * k))
            if len(line) >= 2:
                geom.append(line)
                xs.extend(p[0] for p in line)
                ys.extend(p[1] for p in line)
        if not geom:
            return None, None
        return geom, (min(xs), min(ys), max(xs), max(ys))
    # poly
    geom = []
    xs, ys = [], []
    for role, pts in f.geom:
        ring = []
        for lon, lat in pts:
            wx, wy = lonlat_to_world(lon, lat)
            ring.append((wx * k, wy * k))
        if len(ring) >= 3:
            geom.append((role, ring))
            xs.extend(p[0] for p in ring)
            ys.extend(p[1] for p in ring)
    if not geom:
        return None, None
    return geom, (min(xs), min(ys), max(xs), max(ys))


def _emit(layer, f, gp, tx, ty):
    ox, oy = tx * EXTENT, ty * EXTENT
    x0, y0 = 0.0, 0.0
    x1, y1 = float(EXTENT), float(EXTENT)
    if f.kind == "point":
        px, py = gp[0][0] - ox, gp[0][1] - oy
        if px < -64 or py < -64 or px > EXTENT + 64 or py > EXTENT + 64:
            return
        layer.add(POINT, [[(px, py)]], f.props)
    elif f.kind == "line":
        rings = []
        for pts in gp:
            local = [(p[0] - ox, p[1] - oy) for p in pts]
            for sub in clip_polyline(local, x0, y0, x1, y1):
                if len(sub) >= 2:
                    rings.append(sub)
        if rings:
            layer.add(LINESTRING, rings, f.props)
    else:
        rings = []
        for role, pts in gp:
            local = [(p[0] - ox, p[1] - oy) for p in pts]
            clipped = clip_polygon(local, x0, y0, x1, y1)
            if len(clipped) >= 4:
                rings.append((role, clipped))
        if rings:
            layer.add(POLYGON, rings, f.props)
