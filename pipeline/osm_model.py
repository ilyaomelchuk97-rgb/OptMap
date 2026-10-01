"""Загрузка .osm.pbf в упрощённую модель: полигоны, линии, точки.

Модель максимально плоская — только то, что нужно для генерации тайлов,
поискового индекса и графа маршрутов.
"""
import math

import osmium

AREA_TAGS = (
    "building", "landuse", "leisure", "natural", "amenity", "man_made",
    "historic", "area:highway", "boundary", "waterway", "tourism", "shop",
    "office", "military",
)

# Классы дорог: (мин. тайл-зум, группа отрисовки)
ROAD_CLASSES = {
    "motorway": (8, "major"), "motorway_link": (8, "major"),
    "trunk": (8, "major"), "trunk_link": (8, "major"),
    "primary": (10, "major"), "primary_link": (10, "major"),
    "secondary": (12, "main"), "secondary_link": (12, "main"),
    "tertiary": (13, "main"), "tertiary_link": (13, "main"),
    "unclassified": (14, "local"), "residential": (14, "local"),
    "living_street": (14, "local"), "road": (14, "local"),
    "service": (15, "minor"), "pedestrian": (15, "minor"),
    "track": (15, "minor"),
    "footway": (16, "path"), "steps": (16, "path"), "path": (16, "path"),
    "cycleway": (16, "path"), "bridleway": (16, "path"),
}

ROUTABLE = set(ROAD_CLASSES) - {"construction"}

# Скорости (км/ч) для оценки времени по классам дорог
SPEED_CAR = {
    "motorway": 90, "motorway_link": 60, "trunk": 80, "trunk_link": 50,
    "primary": 50, "primary_link": 40, "secondary": 45, "secondary_link": 35,
    "tertiary": 40, "tertiary_link": 30, "unclassified": 40,
    "residential": 30, "living_street": 15, "road": 30,
    "service": 15, "pedestrian": 5, "track": 25, "footway": 5,
    "steps": 3, "path": 4.5, "cycleway": 15, "bridleway": 6,
}

POI_KEYS = ("amenity", "shop", "tourism", "leisure", "historic", "office",
            "emergency", "healthcare", "railway")

POI_KIND_RU = {
    "parking": "Парковка", "parking_entrance": "Въезд на парковку",
    "place_of_worship": "Храм", "school": "Школа", "kindergarten": "Детсад",
    "restaurant": "Ресторан", "cafe": "Кафе", "bar": "Бар", "pub": "Паб",
    "bank": "Банк", "police": "Полиция", "townhall": "Мэрия",
    "fuel": "АЗС", "fountain": "Фонтан", "swimming_pool": "Бассейн",
    "hospital": "Больница", "clinic": "Клиника", "pharmacy": "Аптека",
    "post_office": "Почта", "bus_station": "Автовокзал", "library": "Библиотека",
    "theatre": "Театр", "cinema": "Кинотеатр", "prison": "Тюрьма",
    "university": "Университет", "college": "Колледж", "fire_station": "Пожарная",
    "courthouse": "Суд", "embassy": "Посольство", "marketplace": "Рынок",
    "supermarket": "Супермаркет", "bakery": "Булочная", "convenience": "Магазин",
    "kiosk": "Киоск", "butcher": "Мясная лавка", "hairdresser": "Парикмахерская",
    "hotel": "Отель", "museum": "Музей", "attraction": "Достопримечательность",
    "artwork": "Арт-объект", "viewpoint": "Смотровая", "guest_house": "Гостевой дом",
    "hostel": "Хостел", "zoo": "Зоопарк", "theme_park": "Парк аттракционов",
    "stadium": "Стадион", "sports_centre": "Спорткомплекс", "pitch": "Площадка",
    "golf_course": "Поле для гольфа", "garden": "Сад", "park": "Парк",
    "monument": "Памятник", "castle": "Замок", "ruins": "Руины",
    "archaeological_site": "Археология", "church": "Церковь",
    "cathedral": "Собор", "mosque": "Мечеть", "synagogue": "Синаногая",
    "memorial": "Мемориал", "station": "Станция", "halt": "Остановка",
    "tram_stop": "Трамвайная остановка", "subway_entrance": "Вход в метро",
    "doctors": "Врачи", "dentist": "Стоматология", "veterinary": "Ветклиника",
    "car_rental": "Прокат авто", "atm": "Банкомат", "bureau_de_change": "Обмен валюты",
}

GREEN_NATURAL = {"wood", "scrub", "grassland", "heath", "wetland", "moor"}
GREEN_LANDUSE = {"forest", "grass", "recreation_ground", "village_green",
                 "meadow", "orchard", "vineyard", "farmland"}
GREEN_LEISURE = {"park", "garden", "pitch", "golf_course", "common",
                 "sports_centre", "stadium", "dog_park", "playground"}


def haversine(lon1, lat1, lon2, lat2):
    R = 6371000.0
    p1, p2 = math.radians(lat1), math.radians(lat2)
    dp = math.radians(lat2 - lat1)
    dl = math.radians(lon2 - lon1)
    a = math.sin(dp / 2) ** 2 + math.cos(p1) * math.cos(p2) * math.sin(dl / 2) ** 2
    return 2 * R * math.asin(math.sqrt(a))


def centroid(pts):
    x = sum(p[0] for p in pts) / len(pts)
    y = sum(p[1] for p in pts) / len(pts)
    return (x, y)


def polygon_centroid(rings):
    """Площадко-взвешенный центроид. Принимает список колец или одно
    кольцо (список точек (lon, lat))."""
    if rings and isinstance(rings[0], tuple) and len(rings[0]) == 2 \
            and isinstance(rings[0][0], (int, float)):
        rings = [rings]
    ring = max(rings, key=lambda r: abs(_ring_area(r)))
    return _poly_true_centroid(ring)


def _ring_area(ring):
    a = 0.0
    n = len(ring)
    for i in range(n):
        x1, y1 = ring[i]
        x2, y2 = ring[(i + 1) % n]
        a += x1 * y2 - x2 * y1
    return a / 2.0


def _poly_true_centroid(ring):
    a = _ring_area(ring)
    if abs(a) < 1e-12:
        return centroid(ring)
    cx = cy = 0.0
    n = len(ring)
    for i in range(n):
        x1, y1 = ring[i]
        x2, y2 = ring[(i + 1) % n]
        cr = x1 * y2 - x2 * y1
        cx += (x1 + x2) * cr
        cy += (y1 + y2) * cr
    return (cx / (6 * a), cy / (6 * a))


def point_in_ring(pt, ring):
    x, y = pt
    inside = False
    n = len(ring)
    j = n - 1
    for i in range(n):
        xi, yi = ring[i]
        xj, yj = ring[j]
        if (yi > y) != (yj > y):
            xint = (xj - xi) * (y - yi) / (yj - yi) + xi
            if x < xint:
                inside = not inside
        j = i
    return inside


def assemble_rings(ways, max_gap_deg=0.001):
    """Собирает список путей (списки id узлов) в замкнутые кольца.

    Возвращает (rings, open_chains). rings — список списков (lon, lat)."""
    # Сначала конвертируем пути в координаты (вызывающий код передаёт
    # уже готовые списки координат).
    raise NotImplementedError


def chain_rings(coord_ways, max_gap_m=60.0):
    """coord_ways: список списков [(lon, lat), ...]. Сцепляет по конечным
    точкам (в пределах max_gap_m) в замкнутые кольца."""
    remaining = [list(w) for w in coord_ways if len(w) >= 2]
    rings = []
    while remaining:
        chain = remaining.pop(0)
        extended = True
        while extended:
            extended = False
            for i, other in enumerate(remaining):
                if other is chain:
                    continue
                if haversine(*chain[-1], *other[0]) <= max_gap_m:
                    chain = chain + other[1:]
                    remaining.pop(i)
                    extended = True
                    break
                if haversine(*chain[-1], *other[-1]) <= max_gap_m:
                    chain = chain + other[::-1][1:]
                    remaining.pop(i)
                    extended = True
                    break
                if haversine(*chain[0], *other[-1]) <= max_gap_m:
                    chain = other[:-1] + chain
                    remaining.pop(i)
                    extended = True
                    break
                if haversine(*chain[0], *other[0]) <= max_gap_m:
                    chain = other[::-1][:-1] + chain
                    remaining.pop(i)
                    extended = True
                    break
            if len(chain) > 2 and haversine(*chain[0], *chain[-1]) <= max_gap_m:
                break
        if len(chain) >= 4:
            if haversine(*chain[0], *chain[-1]) > max_gap_m:
                chain = chain + [chain[0]]
            rings.append(chain)
    return rings, remaining


class Model:
    """Плоская модель карты."""

    def __init__(self):
        self.nodes = {}          # id -> (lon, lat)
        self.node_tags = {}      # id -> dict
        self.ways = []           # {id, tags, pts, closed, area}
        self.relations = []      # {id, tags, members: [(type, ref, role)]}
        self.bounds = None       # (minlon, minlat, maxlon, maxlat)

    # ---------- загрузка ----------

    def load(self, path):
        h = _Loader(self)
        h.apply_file(path, locations=False)
        self._postprocess()
        return self

    def _postprocess(self):
        self._way_by_id = {w["id"]: w for w in self.ways}
        lons = [p[0] for p in self.nodes.values()]
        lats = [p[1] for p in self.nodes.values()]
        if lons:
            self.bounds = (min(lons), min(lats), max(lons), max(lats))

    # ---------- производные сущности ----------

    def way_coords(self, way):
        pts = []
        for nid in way["refs"]:
            p = self.nodes.get(nid)
            if p:
                pts.append(p)
        return pts

    def iter_area_ways(self):
        for w in self.ways:
            t = w["tags"]
            if t.get("area") == "no":
                continue
            if not any(k in t for k in AREA_TAGS):
                continue
            if "highway" in t and t.get("area") != "yes":
                continue
            if not w["closed"]:
                continue
            yield w

    def iter_line_ways(self):
        for w in self.ways:
            t = w["tags"]
            if "highway" in t and t.get("highway") != "construction":
                yield w
            elif "railway" in t and t["railway"] in ("rail", "light_rail",
                                                     "subway", "tram",
                                                     "narrow_gauge", "monorail"):
                yield w
            elif "waterway" in t and t["waterway"] in ("river", "stream",
                                                       "canal", "drain"):
                yield w
            elif "barrier" in t and t["barrier"] in ("wall", "fence", "hedge",
                                                     "city_wall", "retaining_wall"):
                yield w
            elif t.get("natural") == "coastline":
                yield w

    def multipolygon_relations(self):
        """Мультиполигоны (вода, лес, границы) -> список
        {tags, rings: [(role, pts)]}."""
        out = []
        for r in self.relations:
            if r["tags"].get("type") != "multipolygon":
                continue
            outers, inners = [], []
            for mtype, ref, role in r["members"]:
                if mtype != "way":
                    continue
                w = self._way_by_id.get(ref)
                if not w:
                    continue
                pts = self.way_coords(w)
                if len(pts) < 3:
                    continue
                if role == "inner":
                    inners.append(pts)
                else:
                    outers.append(pts)
            rings = []
            for ring in chain_rings(outers)[0]:
                rings.append(("outer", ring))
            for ring in chain_rings(inners)[0]:
                rings.append(("hole", ring))
            if rings:
                out.append({"tags": r["tags"], "rings": rings})
        return out

    def boundary_relations(self):
        """Административные границы: линии (куски) + centroid для подписи."""
        out = []
        for r in self.relations:
            t = r["tags"]
            if t.get("type") != "boundary" or t.get("boundary") != "administrative":
                continue
            lines = []
            outer_ways = []
            for mtype, ref, role in r["members"]:
                if mtype not in ("w", "way"):
                    continue
                w = self._way_by_id.get(ref)
                if not w:
                    continue
                pts = self.way_coords(w)
                if len(pts) < 2:
                    continue
                if role == "outer":
                    outer_ways.append(pts)
                lines.append(pts)
            if not lines:
                continue
            rings, _ = chain_rings(outer_ways)
            c = polygon_centroid(rings[0]) if rings else None
            out.append({"tags": t, "lines": lines, "centroid": c})
        return out


class _Loader(osmium.SimpleHandler):
    def __init__(self, model: Model):
        super().__init__()
        self.m = model

    def node(self, n):
        if n.location.valid():
            self.m.nodes[n.id] = (n.location.lon, n.location.lat)
            if len(n.tags):
                self.m.node_tags[n.id] = {t.k: t.v for t in n.tags}

    def way(self, w):
        tags = {t.k: t.v for t in w.tags}
        if not tags:
            return
        refs = [n.ref for n in w.nodes]
        if len(refs) < 2:
            return
        closed = refs[0] == refs[-1] and len(refs) >= 4
        self.m.ways.append({"id": w.id, "tags": tags, "refs": refs,
                            "closed": closed})

    def relation(self, r):
        tags = {t.k: t.v for t in r.tags}
        members = [(m.type, m.ref, m.role) for m in r.members]
        self.m.relations.append({"id": r.id, "tags": tags, "members": members})


def finalize(model: Model):
    model._way_by_id = {w["id"]: w for w in model.ways}
    return model
