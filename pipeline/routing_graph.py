"""Граф дорог для офлайн-маршрутов.

Формат data/graph.json:
{"nodes": {"<id>": [lon, lat]},
 "edges": [[u, v, dist_m, time_s, name, cls, oneway]]}
"""
from .osm_model import SPEED_CAR, haversine

FOOT_OK = {"footway", "steps", "path", "pedestrian", "cycleway",
           "living_street", "residential", "unclassified", "tertiary",
           "secondary", "primary", "service", "track", "bridleway"}
CAR_OK = {"motorway", "motorway_link", "trunk", "trunk_link", "primary",
          "primary_link", "secondary", "secondary_link", "tertiary",
          "tertiary_link", "unclassified", "residential", "living_street",
          "road", "service", "track"}


def build_graph(model, log=print):
    nodes = {}
    edges = []
    for w in model.ways:
        t = w["tags"]
        hw = t.get("highway")
        if hw not in SPEED_CAR:
            continue
        pts = model.way_coords(w)
        if len(pts) < 2:
            continue
        refs = [r for r in w["refs"] if r in model.nodes]
        if len(refs) != len(pts):
            # часть узлов отсутствует в выгрузке — пропускаем путь
            if len(refs) < 2:
                continue
        name = t.get("name") or t.get("ref") or ""
        oneway = 1 if t.get("oneway") in ("yes", "1", "-1") else 0
        reverse_oneway = t.get("oneway") == "-1"
        speed = SPEED_CAR.get(hw, 30)
        # замкнутые кольца (кольцевые): не дублируем последний узел
        seq = list(zip(refs, pts))
        if len(seq) >= 2 and seq[0][0] == seq[-1][0]:
            seq = seq[:-1]
        for i in range(len(seq) - 1):
            (u, up), (v, vp) = seq[i], seq[i + 1]
            nodes[u] = [round(up[0], 6), round(up[1], 6)]
            nodes[v] = [round(vp[0], 6), round(vp[1], 6)]
            d = haversine(*up, *vp)
            if d < 0.5:
                continue
            tsec = d / (speed * 1000 / 3600)
            fwd = not (oneway and reverse_oneway)
            bwd = not oneway or reverse_oneway
            if fwd:
                edges.append([u, v, round(d, 1), round(tsec, 1), name, hw, 0])
            if bwd:
                edges.append([v, u, round(d, 1), round(tsec, 1), name, hw, 0])

    log(f"  граф: {len(nodes)} узлов, {len(edges)} рёбер")
    return {"nodes": nodes, "edges": edges}
