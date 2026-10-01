"""Файл подписей data/labels.json для HTML-движка подписей клиента.

Формат: {"labels": [{"l": слой, "n": текст, "lon": , "lat": , "ang": ,
                      "p": приоритет, "k": вид}]}
Слой: place | district | poi | road | water | park | address
"""
from .osm_model import POI_KIND_RU, ROAD_CLASSES, haversine, polygon_centroid


def build_labels(model, log=print):
    labels = []

    def bearing(pts):
        # азимут в средней точке самого длинного сегмента
        best, bi = 0, 0
        for i in range(len(pts) - 1):
            d = haversine(*pts[i], *pts[i + 1])
            if d > best:
                best, bi = d, i
        a, b = pts[bi], pts[bi + 1]
        import math
        p1, p2 = math.radians(a[1]), math.radians(b[1])
        dl = math.radians(b[0] - a[0])
        y = math.sin(dl) * math.cos(p2)
        x = math.cos(p1) * math.sin(p2) - math.sin(p1) * math.cos(p2) * math.cos(dl)
        return math.degrees(math.atan2(y, x))

    # ---- населённые пункты и районы ----
    for b in model.boundary_relations():
        t = b["tags"]
        lvl = _num(t.get("admin_level"))
        if lvl is None or not b["centroid"]:
            continue
        name = t.get("name:ru") or t.get("name")
        if not name:
            continue
        p = 0 if lvl <= 2 else 1 if lvl <= 8 else 2
        labels.append({"l": "place" if p <= 1 else "district", "n": name,
                       "lon": round(b["centroid"][0], 6),
                       "lat": round(b["centroid"][1], 6), "p": p})
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
        p = 0 if rank <= 2 else 1 if rank <= 8 else 2
        labels.append({"l": "place" if p <= 1 else "district", "n": name,
                       "lon": round(lon, 6), "lat": round(lat, 6), "p": p})

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
        major = kind in _MAJOR
        labels.append({"l": "poi", "n": name, "lon": round(lon, 6),
                       "lat": round(lat, 6), "p": 3 if major else 4,
                       "k": kind})
    for w in model.iter_area_ways():
        t = w["tags"]
        name = t.get("name:ru") or t.get("name")
        if not name:
            continue
        kind = _kind(t)
        if not kind:
            continue
        pts = model.way_coords(w)
        if len(pts) < 4:
            continue
        c = polygon_centroid(pts)
        labels.append({"l": "poi", "n": name, "lon": round(c[0], 6),
                       "lat": round(c[1], 6),
                       "p": 3 if kind in _MAJOR else 4, "k": kind})

    # ---- дороги ----
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
        mid = _midpoint(pts)
        if mid is None:
            continue
        p = {"major": 5, "main": 6, "local": 7}.get(group, 8)
        labels.append({"l": "road", "n": name, "lon": round(mid[0], 6),
                       "lat": round(mid[1], 6), "p": p,
                       "ang": round(bearing(pts), 1), "z": minz})

    # ---- водоёмы и парки ----
    for w in model.iter_area_ways():
        t = w["tags"]
        pts = model.way_coords(w)
        if len(pts) < 4:
            continue
        c = polygon_centroid(pts)
        if t.get("natural") in ("water", "bay", "strait"):
            name = t.get("name:ru") or t.get("name")
            if name:
                labels.append({"l": "water", "n": name,
                               "lon": round(c[0], 6), "lat": round(c[1], 6),
                               "p": 8})
        elif t.get("leisure") in ("park", "garden", "golf_course", "common"):
            name = t.get("name:ru") or t.get("name")
            if name:
                labels.append({"l": "park", "n": name,
                               "lon": round(c[0], 6), "lat": round(c[1], 6),
                               "p": 9})

    # ---- адреса ----
    for nid, (lon, lat) in model.nodes.items():
        t = model.node_tags.get(nid)
        if not t:
            continue
        hn = t.get("addr:housenumber")
        if not hn:
            continue
        labels.append({"l": "address", "n": str(hn), "lon": round(lon, 6),
                       "lat": round(lat, 6), "p": 10,
                       "s": t.get("addr:street") or ""})
    for w in model.iter_area_ways():
        t = w["tags"]
        hn = t.get("addr:housenumber")
        if not hn:
            continue
        pts = model.way_coords(w)
        if len(pts) < 4:
            continue
        c = polygon_centroid(pts)
        labels.append({"l": "address", "n": str(hn), "lon": round(c[0], 6),
                       "lat": round(c[1], 6), "p": 10,
                       "s": t.get("addr:street") or ""})

    labels.sort(key=lambda x: x["p"])
    log(f"  подписи: {len(labels)}")
    return {"labels": labels}


_MAJOR = {"parking", "place_of_worship", "school", "hospital", "townhall",
          "police", "university", "theatre", "cinema", "restaurant", "cafe",
          "bus_station", "fuel", "bank", "post_office", "library", "hotel",
          "museum", "attraction", "stadium", "sports_centre", "supermarket",
          "monument", "castle", "cathedral", "church", "pharmacy",
          "swimming_pool", "marketplace"}


def _kind(t):
    for key in ("amenity", "shop", "tourism", "leisure", "historic",
                "office", "emergency", "healthcare", "railway"):
        if key in t:
            return t[key]
    return None


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
