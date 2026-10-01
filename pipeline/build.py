"""OptMap — конвейер сборки офлайн-карты из .osm.pbf.

Использование:
    python3 -m pipeline.build --input data/monaco.osm.pbf \
        --name Monaco --name-ru "Монако" --out data

Что делает:
  1. читает .osm.pbf (через pyosmium)
  2. режет векторные тайлы (MVT) -> data/tiles/{z}/{x}/{y}.pbf.gz
  3. строит поисковый индекс -> data/index.json
  4. строит граф дорог -> data/graph.json
  5. пишет метаданные -> data/config.json
"""
import argparse
import json
import os
import sys
import time

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from pipeline.labels import build_labels
from pipeline.osm_model import Model
from pipeline.routing_graph import build_graph
from pipeline.search_index import build_index
from pipeline.tiles import collect_features, generate_tiles


def main():
    ap = argparse.ArgumentParser(description="OptMap: сборка офлайн-карты")
    ap.add_argument("--input", required=True, help="путь к .osm.pbf")
    ap.add_argument("--out", default="data", help="каталог вывода")
    ap.add_argument("--name", default="Region", help="латинское название")
    ap.add_argument("--name-ru", default="Регион", help="русское название")
    ap.add_argument("--minz", type=int, default=11)
    ap.add_argument("--maxz", type=int, default=18)
    ap.add_argument("--no-preview", action="store_true")
    args = ap.parse_args()

    t0 = time.time()
    os.makedirs(args.out, exist_ok=True)

    print(f"[1/5] Читаю {args.input} ...")
    model = Model().load(args.input)
    bounds = model.bounds
    print(f"  узлов: {len(model.nodes)}, путей: {len(model.ways)}, "
          f"связей: {len(model.relations)}")
    print(f"  габариты: {bounds}")

    print("[2/5] Готовлю объекты ...")
    feats = collect_features(model)
    print(f"  объектов: {len(feats)}")

    print("[3/5] Генерирую тайлы ...")
    tiles_dir = os.path.join(args.out, "tiles")
    if os.path.isdir(tiles_dir):
        import shutil
        shutil.rmtree(tiles_dir)   # не оставляем тайлы прошлых сборок
    n = generate_tiles(feats, tiles_dir, bounds, args.minz, args.maxz)
    print(f"  всего тайлов: {n}")

    print("[4/5] Строю поисковый индекс ...")
    index = build_index(model)
    with open(os.path.join(args.out, "index.json"), "w",
              encoding="utf-8") as fh:
        json.dump(index, fh, ensure_ascii=False, separators=(",", ":"))

    print("[5/5] Строю граф дорог ...")
    graph = build_graph(model)
    with open(os.path.join(args.out, "graph.json"), "w",
              encoding="utf-8") as fh:
        json.dump(graph, fh, ensure_ascii=False, separators=(",", ":"))

    labels = build_labels(model)
    with open(os.path.join(args.out, "labels.json"), "w",
              encoding="utf-8") as fh:
        json.dump(labels, fh, ensure_ascii=False, separators=(",", ":"))

    center = [(bounds[0] + bounds[2]) / 2, (bounds[1] + bounds[3]) / 2]
    config = {
        "name": args.name,
        "nameRu": args.name_ru,
        "bounds": [round(b, 6) for b in bounds],
        "center": [round(center[0], 6), round(center[1], 6)],
        "minZoom": args.minz,
        "maxZoom": args.maxz,
        "attribution": "© OpenStreetMap contributors (ODbL)",
        "generated": time.strftime("%Y-%m-%d %H:%M:%S"),
        "stats": {
            "nodes": len(model.nodes),
            "ways": len(model.ways),
            "features": len(feats),
            "tiles": n,
            "indexEntries": len(index["entries"]),
            "graphNodes": len(graph["nodes"]),
            "graphEdges": len(graph["edges"]),
        },
    }
    with open(os.path.join(args.out, "config.json"), "w",
              encoding="utf-8") as fh:
        json.dump(config, fh, ensure_ascii=False, indent=2)

    if not args.no_preview:
        try:
            from pipeline.preview import render_preview
            render_preview(feats, bounds, os.path.join(args.out,
                                                       "preview.png"))
        except Exception as e:  # noqa: BLE001
            print(f"  превью пропущено: {e}")

    print(f"Готово за {time.time() - t0:.1f} с. Данные в {args.out}/")


if __name__ == "__main__":
    main()
