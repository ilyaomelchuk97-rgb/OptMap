"""Проверка: все source-layer из стилей присутствуют в сгенерированных тайлах.

    python3 tests/check_layers.py [--data data]
"""
import argparse
import glob
import gzip
import json
import os
import sys


def read_varint(buf, pos):
    shift = 0
    result = 0
    while True:
        if pos >= len(buf):
            raise ValueError("обрыв varint")
        b = buf[pos]
        pos += 1
        result |= (b & 0x7F) << shift
        if not (b & 0x80):
            return result, pos
        shift += 7


def tile_layer_names(buf):
    """Быстро вытаскивает имена слоёв из MVT без полной декодировки."""
    names = []
    pos = 0
    end = len(buf)
    while pos < end:
        key, pos = read_varint(buf, pos)
        field, wire = key >> 3, key & 7
        if wire == 2:
            ln, pos = read_varint(buf, pos)
            chunk = buf[pos:pos + ln]
            pos += ln
            if field == 3:  # layer
                names.append(layer_name(chunk))
        elif wire == 0:
            _, pos = read_varint(buf, pos)
        elif wire == 5:
            pos += 4
        elif wire == 1:
            pos += 8
        else:
            break
    return names


def layer_name(chunk):
    pos = 0
    while pos < len(chunk):
        key, pos = read_varint(chunk, pos)
        field, wire = key >> 3, key & 7
        if wire == 2:
            ln, pos = read_varint(chunk, pos)
            data = chunk[pos:pos + ln]
            pos += ln
            if field == 1:
                return data.decode("utf-8", "replace")
        elif wire == 0:
            _, pos = read_varint(chunk, pos)
        elif wire == 5:
            pos += 4
        elif wire == 1:
            pos += 8
        else:
            break
    return "?"


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--data", default="data")
    ap.add_argument("--samples", type=int, default=40)
    args = ap.parse_args()

    needed = set()
    for style in ("style-light.json", "style-dark.json"):
        path = os.path.join("web", style)
        if not os.path.exists(path):
            continue
        st = json.load(open(path, encoding="utf-8"))
        for layer in st["layers"]:
            if "source-layer" in layer:
                needed.add(layer["source-layer"])
    print("слои в стилях:", sorted(needed))

    files = sorted(glob.glob(os.path.join(args.data, "tiles", "*", "*", "*.pbf.gz")))
    if not files:
        print("Нет тайлов — сначала запустите pipeline/build.py")
        return 1
    # выбираем образцы из КАЖДОГО зума, иначе проверка сведётся к z18
    by_zoom = {}
    for f in files:
        by_zoom.setdefault(f.split(os.sep)[-3], []).append(f)
    sample = []
    for z, zfiles in sorted(by_zoom.items()):
        step = max(1, len(zfiles) // args.samples)
        sample.extend(zfiles[::step])

    found = set()
    empty = 0
    for f in sample:
        try:
            raw = gzip.decompress(open(f, "rb").read())
        except OSError:
            print("БИЫТЫЙ GZIP:", f)
            return 1
        names = tile_layer_names(raw)
        if not names:
            empty += 1
        found.update(names)

    missing = needed - found
    print(f"проверено тайлов: {len(sample)} (пустых: {empty})")
    print("найдено слоёв:", len(found))
    if missing:
        print("ОТСУТСТВУЮТ СЛОИ:", sorted(missing))
        return 1
    print("OK — все слои стилей присутствуют в тайлах")
    return 0


if __name__ == "__main__":
    sys.exit(main())
