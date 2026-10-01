import gzip
import struct

EXTENT = 4096

# GeomType
POINT = 1
LINESTRING = 2
POLYGON = 3


def _varint(n: int) -> bytes:
    out = bytearray()
    while True:
        b = n & 0x7F
        n >>= 7
        if n:
            out.append(b | 0x80)
        else:
            out.append(b)
            return bytes(out)


def _zigzag(n: int) -> int:
    return (n << 1) ^ (n >> 63)


def _tag(buf: bytearray, field: int, wire: int, payload: bytes):
    buf += _varint((field << 3) | wire)
    if wire == 2:
        buf += _varint(len(payload))
    buf += payload


def _encode_value(v) -> bytes:
    if isinstance(v, bool):
        return _varint((7 << 3) | 0) + _varint(1 if v else 0)
    if isinstance(v, str):
        b = v.encode("utf-8")
        return _varint((1 << 3) | 2) + _varint(len(b)) + b
    if isinstance(v, int):
        return _varint((4 << 3) | 0) + _varint(v)
    if isinstance(v, float):
        return _varint((2 << 3) | 5) + struct.pack("<f", v)
    return _varint((1 << 3) | 2) + _varint(0)


def _quantize(ring, extent):
    pts = []
    px = py = None
    for x, y in ring:
        qx = int(round(x))
        qy = int(round(y))
        if qx < 0:
            qx = 0
        elif qx > extent:
            qx = extent
        if qy < 0:
            qy = 0
        elif qy > extent:
            qy = extent
        if qx == px and qy == py:
            continue
        pts.append((qx, qy))
        px, py = qx, qy
    return pts


def _signed_area(pts):
    a = 0.0
    n = len(pts)
    for i in range(n):
        x1, y1 = pts[i]
        x2, y2 = pts[(i + 1) % n]
        a += x1 * y2 - x2 * y1
    return a / 2.0


def _encode_geometry(geom_type, rings, extent):
    """rings: POINT -> [[(x,y),...]]; LINESTRING -> [[(x,y),...],...];
    POLYGON -> [((role, pts)), ...] with role in {'outer','hole'}"""
    cmds = []
    cx = cy = 0
    if geom_type == POINT:
        pts = _quantize(rings[0] if rings else [], extent)
        if not pts:
            return b""
        cmds.append((1, len(pts)))
        for x, y in pts:
            cmds.append((None, _zigzag(x - cx), _zigzag(y - cy)))
            cx, cy = x, y
    elif geom_type == LINESTRING:
        for ring in rings:
            pts = _quantize(ring, extent)
            if len(pts) < 2:
                continue
            cmds.append((1, 1))
            x, y = pts[0]
            cmds.append((None, _zigzag(x - cx), _zigzag(y - cy)))
            cx, cy = x, y
            cmds.append((2, len(pts) - 1))
            for x, y in pts[1:]:
                cmds.append((None, _zigzag(x - cx), _zigzag(y - cy)))
                cx, cy = x, y
    elif geom_type == POLYGON:
        for role, ring in rings:
            pts = _quantize(ring, extent)
            if len(pts) < 3:
                continue
            if pts[0] == pts[-1]:
                pts = pts[:-1]
            if len(pts) < 3:
                continue
            area = _signed_area(pts)
            if role == "outer" and area < 0:
                pts = pts[::-1]
            elif role == "hole" and area > 0:
                pts = pts[::-1]
            cmds.append((1, 1))
            x, y = pts[0]
            cmds.append((None, _zigzag(x - cx), _zigzag(y - cy)))
            cx, cy = x, y
            cmds.append((2, len(pts) - 1))
            for x, y in pts[1:]:
                cmds.append((None, _zigzag(x - cx), _zigzag(y - cy)))
                cx, cy = x, y
            cmds.append((7, 1))
    out = bytearray()
    for c in cmds:
        if c[0] is not None:
            out += _varint((c[0] & 0x7) | (c[1] << 3))
        else:
            out += _varint(_zigzag(c[1]))
            out += _varint(_zigzag(c[2]))
    return bytes(out)


class Layer:
    __slots__ = ("name", "features")

    def __init__(self, name):
        self.name = name
        self.features = []

    def add(self, geom_type, rings, props=None):
        self.features.append((geom_type, rings, props or {}))


def encode_tile(layers, extent=EXTENT, compress=True):
    out = bytearray()
    for layer in layers:
        if not layer.features:
            continue
        keys = []
        values = []
        key_idx = {}
        val_idx = {}
        feats = []
        for fid, (geom_type, rings, props) in enumerate(layer.features):
            tags = []
            for k, v in props.items():
                if v is None:
                    continue
                ki = key_idx.get(k)
                if ki is None:
                    ki = len(keys)
                    keys.append(k)
                    key_idx[k] = ki
                vb = _encode_value(v)
                vi = val_idx.get(vb)
                if vi is None:
                    vi = len(values)
                    values.append(vb)
                    val_idx[vb] = vi
                tags.append(ki)
                tags.append(vi)
            geom = _encode_geometry(geom_type, rings, extent)
            if not geom:
                continue
            feats.append((fid, tags, geom_type, geom))

        lb = bytearray()
        nb = layer.name.encode("utf-8")
        _tag(lb, 1, 2, nb)
        for fid, tags, geom_type, geom in feats:
            fb = bytearray()
            _tag(fb, 1, 0, _varint(fid))
            if tags:
                # tags — packed repeated uint32 -> wire type 2 + длина
                _tag(fb, 2, 2, b"".join(_varint(t) for t in tags))
            _tag(fb, 3, 0, _varint(geom_type))
            # geometry — packed repeated uint32 -> wire type 2 + длина
            _tag(fb, 4, 2, geom)
            _tag(lb, 2, 2, bytes(fb))
        for k in keys:
            kb = k.encode("utf-8")
            _tag(lb, 3, 2, kb)
        for v in values:
            _tag(lb, 4, 2, v)
        _tag(lb, 5, 0, _varint(extent))
        _tag(lb, 15, 0, _varint(2))
        _tag(out, 3, 2, bytes(lb))
    data = bytes(out)
    if compress:
        data = gzip.compress(data, 6)
    return data
