"""Статичное превью карты (PNG) — для быстрой визуальной проверки данных
без запуска сервера. Использует PIL."""
import math
import os

from .tiles import lonlat_to_world


def render_preview(features, bounds, out_path, width=1600):
    try:
        from PIL import Image, ImageDraw, ImageFont
    except ImportError:
        raise RuntimeError("нужен pillow: pip install pillow")

    minlon, minlat, maxlon, maxlat = bounds
    wx0, wy0 = lonlat_to_world(minlon, maxlat)
    wx1, wy1 = lonlat_to_world(maxlon, minlat)
    span = max(wx1 - wx0, wy1 - wy0)
    cx, cy = (wx0 + wx1) / 2, (wy0 + wy1) / 2
    scale = width / span
    height = int((wy1 - wy0) * scale)
    img = Image.new("RGB", (width, height), (168, 204, 226))  # море
    dr = ImageDraw.Draw(img, "RGBA")

    def P(lon, lat):
        wx, wy = lonlat_to_world(lon, lat)
        return ((wx - cx) * scale + width / 2, (wy - cy) * scale + height / 2)

    def px_size(m):
        return max(1, int(m / 111320 * scale))

    def draw_rings(f, fill, outline=None, ow=1):
        for role, ring in f.geom:
            pts = [P(*p) for p in ring]
            if len(pts) < 3:
                continue
            dr.polygon(pts, fill=fill, outline=outline, width=ow)

    def draw_line(f, color, w):
        for pts in f.geom:
            dr.line([P(*p) for p in pts], fill=color, width=w, joint="curve")

    try:
        font = ImageFont.truetype("/usr/share/fonts/truetype/dejavu/"
                                  "DejaVuSans.ttf", 13)
        font_b = ImageFont.truetype("/usr/share/fonts/truetype/dejavu/"
                                    "DejaVuSans-Bold.ttf", 16)
    except OSError:
        font = font_b = ImageFont.load_default()

    for f in features:
        if f.layer == "land":
            draw_rings(f, (242, 239, 233))
    for f in features:
        if f.layer == "green":
            draw_rings(f, (200, 226, 190))
        elif f.layer == "park":
            draw_rings(f, (205, 232, 199))
        elif f.layer == "water":
            draw_rings(f, (170, 211, 233))
        elif f.layer == "sand":
            draw_rings(f, (242, 233, 206))
        elif f.layer == "cemetery":
            draw_rings(f, (206, 224, 200))
        elif f.layer == "area":
            draw_rings(f, (238, 236, 232))
        elif f.layer == "building":
            draw_rings(f, (224, 219, 211), (205, 199, 189), 1)

    widths = {"road_major": 7, "road_main": 5, "road_local": 3,
              "road_minor": 2, "road_path": 1}
    for f in features:
        if f.layer == "boundary":
            draw_line(f, (180, 160, 210), 2)
        elif f.layer == "rail":
            draw_line(f, (150, 150, 150), 2)
        elif f.layer == "waterway":
            draw_line(f, (170, 211, 233), 2)
        elif f.layer == "barrier":
            draw_line(f, (160, 160, 160), 1)
        elif f.layer.endswith("_case"):
            draw_line(f, (214, 209, 201), widths.get(
                f.layer.replace("_case", ""), 2) + 2)
    for f in features:
        if f.layer in widths:
            color = (250, 205, 110) if f.layer == "road_major" else \
                    (252, 224, 160) if f.layer == "road_main" else \
                    (255, 255, 255)
            draw_line(f, color, widths[f.layer])

    for f in features:
        if f.layer in ("place", "district"):
            x, y = P(*f.geom)
            n = f.props.get("name", "")
            fnt = font_b if f.layer == "place" else font
            dr.text((x + 5, y - 7), n, fill=(60, 60, 60), font=fnt,
                    stroke_width=2, stroke_fill=(255, 255, 255))
        elif f.layer == "water_label":
            x, y = P(*f.geom)
            dr.text((x + 4, y - 6), f.props.get("name", ""), fill=(70, 120, 160),
                    font=font, stroke_width=2, stroke_fill=(255, 255, 255))
        elif f.layer == "poi":
            x, y = P(*f.geom)
            if f.props.get("name"):
                dr.ellipse([x - 2, y - 2, x + 2, y + 2], fill=(200, 60, 60))
                dr.text((x + 5, y - 6), f.props["name"], fill=(50, 50, 50),
                        font=font, stroke_width=2, stroke_fill=(255, 255, 255))
        elif f.layer == "road_label":
            x, y = P(*f.geom)
            dr.text((x + 4, y - 6), f.props.get("name", ""), fill=(110, 105, 95),
                    font=font, stroke_width=2, stroke_fill=(255, 255, 255))
        elif f.layer == "address":
            x, y = P(*f.geom)
            dr.text((x + 3, y - 5), f.props.get("housenumber", ""),
                    fill=(90, 90, 90), font=font, stroke_width=2,
                    stroke_fill=(255, 255, 255))

    img.save(out_path)
    return out_path
