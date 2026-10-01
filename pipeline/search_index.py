"""Поисковый индекс: адреса, улицы, POI, населённые пункты.

Формат data/index.json:
{"entries": [{"t": тип, "n": имя, "s": улица, "h": номер, "k": вид,
              "lon": , "lat": , "w": вес, "hid": 1 (скрыт из поиска)}]}
"""
import json

from .osm_model import ROAD_CLASSES, centroid, haversine, polygon_centroid


def build_index(model, log=print):
    entries = []
    seen = set()

    def add(t, n, lon, lat, w=1.0, s=None, h=None, k=None, hid=None):
        key = (t, n, s, h, round(lon, 5), round(lat, 5))
        if key in seen:
            return
        seen.add(key)
        e = {"t": t, "n": n, "lon": round(lon, 6), "lat": round(lat, 6),
             "w": round(w, 3)}
        if s:
            e["s"] = s
        if h:
            e["h"] = h
        if k:
            e["k"] = k
        if hid:
            e["hid"] = 1
        entries.append(e)

    # ---- улицы (по именованным дорогам) ----
    streets = {}
    for w in model.ways:
        t = w["tags"]
        name = t.get("name")
        if not name or "highway" not in t:
            continue
        pts = model.way_coords(w)
        if len(pts) < 2:
            continue
        length = sum(haversine(*pts[i], *pts[i + 1])
                     for i in range(len(pts) - 1))
        cur = streets.get(name)
        if cur is None or length > cur[0]:
            mid = _midpoint(pts)
            if mid:
                streets[name] = (length, mid, t.get("ref"))
    for name, (length, mid, ref) in streets.items():
        w = 1.0 + min(length / 2000.0, 1.5)
        add("street", name, mid[0], mid[1], w=w, k=ref)

    # ---- адреса ----
    for nid, (lon, lat) in model.nodes.items():
        t = model.node_tags.get(nid)
        if not t:
            continue
        hn = t.get("addr:housenumber")
        if not hn:
            continue
        street = t.get("addr:street") or t.get("addr:place")
        city = t.get("addr:city")
        label = _addr_label(hn, street, city)
        add("address", label, lon, lat, w=1.15, s=street, h=hn)
    for w in model.iter_area_ways():
        t = w["tags"]
        hn = t.get("addr:housenumber")
        if not hn:
            continue
        pts = model.way_coords(w)
        if len(pts) < 4:
            continue
        street = t.get("addr:street") or t.get("addr:place")
        city = t.get("addr:city")
        c = polygon_centroid(pts)
        add("address", _addr_label(hn, street, city), c[0], c[1], w=1.15,
            s=street, h=hn)

    # ---- POI ----
    for nid, (lon, lat) in model.nodes.items():
        t = model.node_tags.get(nid)
        if not t:
            continue
        name = t.get("name:ru") or t.get("name")
        if not name:
            continue
        kind = _kind(t)
        if not kind:
            continue
        w = 1.05 if _major(t) else 0.9
        add("poi", name, lon, lat, w=w, k=kind)
    for w in model.iter_area_ways():
        t = w["tags"]
        name = t.get("name:ru") or t.get("name")
        if not name or not _kind(t):
            continue
        pts = model.way_coords(w)
        if len(pts) < 4:
            continue
        c = polygon_centroid(pts)
        wgt = 1.05 if _major(t) else 0.9
        add("poi", name, c[0], c[1], w=wgt, k=_kind(t))

    # ---- населённые пункты / районы ----
    for b in model.boundary_relations():
        t = b["tags"]
        lvl = _num(t.get("admin_level"))
        if lvl is None or not b["centroid"]:
            continue
        name = t.get("name:ru") or t.get("name")
        if not name:
            continue
        if lvl <= 2:
            w = 1.4
        elif lvl <= 4:
            w = 1.25
        elif lvl <= 8:
            w = 1.1
        else:
            w = 0.95
        add("place", name, b["centroid"][0], b["centroid"][1], w=w)
    for nid, (lon, lat) in model.nodes.items():
        t = model.node_tags.get(nid)
        if not t:
            continue
        name = t.get("name:ru") or t.get("name")
        place = t.get("place")
        if not name or not place:
            continue
        rank = {"continent": 1, "country": 2, "state": 3, "city": 8,
                "town": 8, "village": 9, "suburb": 10, "quarter": 11,
                "neighbourhood": 12}.get(place, 12)
        add("place", name, lon, lat, w=1.3 if rank <= 2 else 1.0)

    # ---- скрытые образцы улиц (для обратного геокодинга) ----
    for w in model.ways:
        t = w["tags"]
        name = t.get("name")
        if not name or "highway" not in t:
            continue
        pts = model.way_coords(w)
        if len(pts) < 2:
            continue
        acc = 0.0
        last = pts[0]
        for p in pts[1:]:
            d = haversine(*last, *p)
            acc += d
            last = p
            if acc >= 60:
                acc = 0.0
                add("street_pt", name, p[0], p[1], w=0.5, hid=1)

    log(f"  индекс: {len(entries)} записей "
        f"({sum(1 for e in entries if not e.get('hid'))} видимых)")
    return {"entries": entries}


def _addr_label(hn, street, city):
    parts = []
    if city:
        parts.append(city)
    if street:
        parts.append(street)
    parts.append(str(hn))
    return ", ".join(parts)


def _kind(t):
    for key in ("amenity", "shop", "tourism", "leisure", "historic",
                "office", "emergency", "healthcare", "railway"):
        if key in t:
            return t[key]
    return None


_MAJOR = {"parking", "place_of_worship", "school", "hospital", "townhall",
          "police", "university", "theatre", "cinema", "restaurant", "cafe",
          "bus_station", "fuel", "bank", "post_office", "library", "hotel",
          "museum", "attraction", "stadium", "sports_centre", "supermarket",
          "monument", "castle", "cathedral", "church", "pharmacy",
          "swimming_pool", "marketplace"}


def _major(t):
    return _kind(t) in _MAJOR


def _num(v):
    try:
        return float(v)
    except (TypeError, ValueError):
        return None


def _midpoint(pts):
    total = sum(haversine(*pts[i], *pts[i + 1]) for i in range(len(pts) - 1))
    if total <= 0:
        return None
    half, acc = total / 2, 0.0
    for i in range(len(pts) - 1):
        d = haversine(*pts[i], *pts[i + 1])
        if acc + d >= half:
            t = (half - acc) / d if d else 0
            a, b = pts[i], pts[i + 1]
            return (a[0] + t * (b[0] - a[0]), a[1] + t * (b[1] - a[1]))
        acc += d
    return pts[len(pts) // 2]
