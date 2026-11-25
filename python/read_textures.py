"""read_textures.py - open NASCAR Thunder 2004 (Xbox) texture bundles in Python.

The UI pictures live in Data/UIS_*.DAT. Each one is a TERF bundle (a list of entries); an entry that starts with
"MMAP" is one texture (Xbox D3D format, usually swizzled = Morton order, or DXT-compressed).
  UIS_DRPO.DAT  driver portraits (256x256)      UIS_DRPS.DAT  small portraits      UIS_DRNM.DAT  driver name plates
  UIS_TRLG.DAT  track logos     UIS_LOGO.DAT  logos     UIS_SMNM.DAT  car numbers     ... (see TextureGroups in uis-render.mjs)
  UIS_FONT.DAT  the fonts: "FNTS" entries, exported as their glyph sheet (white, glyph coverage in alpha)

Needs: pip install numpy pillow

    python read_textures.py list    F:/recomp/rea-work/Data/UIS_DRPO.DAT
    python read_textures.py convert F:/recomp/rea-work/Data/UIS_DRPO.DAT out_portraits
    python read_textures.py convert F:/recomp/rea-work/Data/UIS_DRPO.DAT out_portraits --index 5

or from your own code:

    from read_textures import read_terf, decode_mmap
    entries = read_terf(open(path, "rb").read())        # list of bytes, one per entry
    img = decode_mmap(entries[5])                         # PIL.Image (RGBA)
    img.show()

Formats and layouts follow mmap-tex.mjs / terf.mjs / ea-lzh1.mjs (the JavaScript side of the port), compressed
(LZH1) bundles included.
"""
import struct
import sys
from pathlib import Path

import numpy as np
from PIL import Image

# ------------------------------------------------------------------ TERF bundles
_TAGS = {b"DIR1", b"COMP", b"DATA", b"HSH1"}


def _next_chunk(buf, pos, size, align):
    end = pos + max(size, 8)
    small = struct.unpack_from("<H", buf, 12)[0] or 1
    for a in (small, align):
        p = -(-end // a) * a
        if p + 8 <= len(buf) and buf[p:p + 4] in _TAGS:
            return p
    return -(-end // align) * align


# LZH1 (TERF compression method 5; ea-lzh1.mjs): a simplified DEFLATE, bits MSB-first, blocks of 285 + 30 4-bit
# code lengths then canonical-Huffman symbols (literals, 256 end of block, 257-284 lengths, 30 distance codes)
_LEN_EXTRA = [0,0,0,0,0,0,0,0,1,1,1,1,2,2,2,2,3,3,3,3,4,4,4,4,5,5,5,0]
_LEN_BASE = [3,4,5,6,7,8,9,10,11,13,15,17,19,23,27,31,35,43,51,59,67,83,99,115,131,163,195,227]
_DIST_EXTRA = [0,0,0,0,1,1,2,2,3,3,4,4,5,5,6,6,7,7,8,8,9,9,10,10,11,11,12,12,13,13]
_DIST_BASE = [1,2,3,4,5,7,9,13,17,25,33,49,65,97,129,193,257,385,513,769,1025,1537,2049,3073,
              4097,6145,8193,12289,16385,24577]


def lzh1_decompress(src, size):
    bits = np.unpackbits(np.frombuffer(src, np.uint8))         # MSB first
    pos = 0

    def read(n):
        nonlocal pos
        v = 0
        for _ in range(n):
            v = (v << 1) | int(bits[pos])
            pos += 1
        return v

    def decoder(lengths):
        count = [0] * 16
        for l in lengths:
            count[l] += 1
        count[0] = 0
        syms = [s for l in range(1, 16) for s in range(len(lengths)) if lengths[s] == l]

        def dec():
            nonlocal pos
            code = first = index = 0
            for l in range(1, 16):
                code |= int(bits[pos])
                pos += 1
                c = count[l]
                if code - first < c:
                    return syms[index + code - first]
                index += c
                first = (first + c) << 1
                code <<= 1
            raise ValueError("LZH1: invalid Huffman code")
        return dec

    out = bytearray(size)
    op = 0
    while op < size:
        if read(1):
            break
        lit = decoder([read(4) for _ in range(285)])
        dist = decoder([read(4) for _ in range(30)])
        while True:
            sym = lit()
            if sym < 256:
                out[op] = sym
                op += 1
                continue
            if sym == 256:
                break
            l = sym - 257
            n = _LEN_BASE[l] + (read(_LEN_EXTRA[l]) if _LEN_EXTRA[l] else 0)
            d = dist()
            back = _DIST_BASE[d] + (read(_DIST_EXTRA[d]) if _DIST_EXTRA[d] else 0)
            for _ in range(n):
                out[op] = out[op - back]
                op += 1
    if op != size:
        raise ValueError(f"LZH1: decompressed {op} bytes, expected {size}")
    return bytes(out)


def read_terf(buf):
    """The entries of a TERF bundle, as a list of bytes objects."""
    if buf[:4] != b"TERF":
        raise ValueError("not a TERF bundle")
    align = struct.unpack_from("<I", buf, 4)[0]
    count = struct.unpack_from("<H", buf, 14)[0]
    pos, chunks = align, {}
    while pos + 8 <= len(buf):
        tag, size = buf[pos:pos + 4], struct.unpack_from("<I", buf, pos + 4)[0]
        if tag not in _TAGS:
            raise ValueError(f"unexpected TERF chunk {tag!r} at 0x{pos:x}")
        chunks[tag] = pos
        if tag == b"DATA":
            break
        pos = _next_chunk(buf, pos, size, align)
    d, data, comp = chunks[b"DIR1"], chunks[b"DATA"], chunks.get(b"COMP")
    out = []
    for i in range(count):
        off, stored = struct.unpack_from("<II", buf, d + 8 + 8 * i)
        raw = bytes(buf[data + off:data + off + stored])
        if comp is not None:
            method, size = struct.unpack_from("<II", buf, comp + 8 + 8 * i)
            if method == 5:
                raw = lzh1_decompress(raw, size)
            elif method != 0:
                raise ValueError(f"entry {i}: compression method {method} not supported")
        out.append(raw)
    return out


# ------------------------------------------------------------------ MMAP textures
# Xbox D3DFORMAT: (name, bytes per pixel or 0 for DXT, swizzled)
FORMATS = {
    0x00: ("L8", 1, True), 0x01: ("AL8", 1, True), 0x02: ("A1R5G5B5", 2, True), 0x03: ("X1R5G5B5", 2, True),
    0x04: ("A4R4G4B4", 2, True), 0x05: ("R5G6B5", 2, True), 0x06: ("A8R8G8B8", 4, True), 0x07: ("X8R8G8B8", 4, True),
    0x0B: ("P8", 1, True), 0x0C: ("DXT1", 0, False), 0x0E: ("DXT3", 0, False), 0x0F: ("DXT5", 0, False),
    0x10: ("LIN_A1R5G5B5", 2, False), 0x11: ("LIN_R5G6B5", 2, False), 0x12: ("LIN_A8R8G8B8", 4, False),
    0x13: ("LIN_L8", 1, False), 0x19: ("A8", 1, True), 0x1A: ("A8L8", 2, True), 0x1B: ("LIN_AL8", 1, False),
    0x1C: ("LIN_X1R5G5B5", 2, False), 0x1D: ("LIN_A4R4G4B4", 2, False), 0x1E: ("LIN_X8R8G8B8", 4, False),
    0x1F: ("LIN_A8", 1, False), 0x20: ("LIN_A8L8", 2, False),
}


def mmap_info(b):
    """(name, width, height, format code) of an MMAP resource."""
    if b[:4] != b"MMAP":
        raise ValueError("not an MMAP resource")
    w, h, fmt = struct.unpack_from("<HHI", b, 0x28)
    name_off = struct.unpack_from("<I", b, 0x20)[0]
    name = b[name_off:b.index(b"\0", name_off)].decode("latin1") if name_off < len(b) else ""
    return name, w, h, fmt


def _morton(w, h):
    """Index of each (y, x) in a swizzled (Morton order, x bit first) image."""
    xs, ys = np.zeros(w, np.int64), np.zeros(h, np.int64)
    bit, xb, yb = 1, 1, 1
    while xb < w or yb < h:
        if xb < w:
            xs[(np.arange(w) & xb) != 0] |= bit
            bit <<= 1
            xb <<= 1
        if yb < h:
            ys[(np.arange(h) & yb) != 0] |= bit
            bit <<= 1
            yb <<= 1
    return ys[:, None] | xs[None, :]


def _c5(v): return ((v << 3) | (v >> 2)).astype(np.uint8)
def _c6(v): return ((v << 2) | (v >> 4)).astype(np.uint8)
def _c4(v): return (v * 17).astype(np.uint8)


def _dxt(fmt, b, off, w, h):
    bs = 8 if fmt == 0x0C else 16
    nbx, nby = max(1, (w + 3) // 4), max(1, (h + 3) // 4)
    blk = np.frombuffer(b, np.uint8, nbx * nby * bs, off).reshape(nby, nbx, bs).astype(np.uint32)
    cb = blk[..., 0:8] if fmt == 0x0C else blk[..., 8:16]
    c0 = cb[..., 0] | cb[..., 1] << 8
    c1 = cb[..., 2] | cb[..., 3] << 8
    bits = cb[..., 4] | cb[..., 5] << 8 | cb[..., 6] << 16 | cb[..., 7] << 24
    def rgb(c): return np.stack([_c5(c >> 11), _c6((c >> 5) & 63), _c5(c & 31)], -1).astype(np.int32)
    p0, p1 = rgb(c0), rgb(c1)
    four = (c0 > c1) | (fmt != 0x0C)
    p2 = np.where(four[..., None], (2 * p0 + p1) // 3, (p0 + p1) // 2)
    p3 = np.where(four[..., None], (p0 + 2 * p1) // 3, 0)
    pal = np.stack([p0, p1, p2, p3], -2)                               # nby, nbx, 4, 3
    pa = np.full(pal.shape[:-1], 255, np.int32)
    pa[..., 3] = np.where(four, 255, 0)
    idx = (bits[..., None] >> (2 * np.arange(16))) & 3                # nby, nbx, 16
    col = np.take_along_axis(pal, idx[..., None].astype(np.int64), -2)  # nby, nbx, 16, 3
    a = np.take_along_axis(pa, idx.astype(np.int64), -1)
    if fmt == 0x0E:                                                   # DXT3: 4-bit explicit alpha
        nib = np.stack([blk[..., :8] & 15, blk[..., :8] >> 4], -1).reshape(nby, nbx, 16)
        a = nib * 17
    elif fmt == 0x0F:                                                 # DXT5: interpolated alpha
        a0, a1 = blk[..., 0].astype(np.int32), blk[..., 1].astype(np.int32)
        ab = np.zeros(a0.shape, np.uint64)
        for i in range(6):
            ab |= blk[..., 2 + i].astype(np.uint64) << np.uint64(8 * i)
        ai = ((ab[..., None] >> (np.uint64(3) * np.arange(16, dtype=np.uint64))) & np.uint64(7)).astype(np.int64)
        tbl = np.zeros(a0.shape + (8,), np.int32)
        tbl[..., 0], tbl[..., 1] = a0, a1
        big = a0 > a1
        for i in range(1, 7):
            tbl[..., i + 1] = np.where(big, ((7 - i) * a0 + i * a1) // 7, tbl[..., i + 1])
        for i in range(1, 5):
            tbl[..., i + 1] = np.where(~big, ((5 - i) * a0 + i * a1) // 5, tbl[..., i + 1])
        tbl[..., 6] = np.where(~big, 0, tbl[..., 6])
        tbl[..., 7] = np.where(~big, 255, tbl[..., 7])
        a = np.take_along_axis(tbl, ai, -1)
    rgba = np.concatenate([col, a[..., None]], -1).astype(np.uint8)   # nby, nbx, 16, 4
    img = rgba.reshape(nby, nbx, 4, 4, 4).transpose(0, 2, 1, 3, 4).reshape(nby * 4, nbx * 4, 4)
    return img[:h, :w]


def decode_mmap(b):
    """An MMAP resource (bytes) -> PIL.Image in RGBA."""
    name, w, h, fmt = mmap_info(b)
    if fmt not in FORMATS:
        raise ValueError(f'MMAP "{name}": unsupported D3D format 0x{fmt:x}')
    fname, bpp, swz = FORMATS[fmt]
    off = 0x80 + struct.unpack_from("<I", b, 0x34)[0]
    if bpp == 0:
        return Image.fromarray(_dxt(fmt, b, off, w, h), "RGBA")
    raw = np.frombuffer(b, np.uint8, w * h * bpp, off).reshape(w * h, bpp)
    px = raw[_morton(w, h).ravel()] if swz else raw                  # pixels in row order
    px = px.reshape(h, w, bpp)
    out = np.zeros((h, w, 4), np.uint8)
    v16 = px[..., 0].astype(np.uint32) | (px[..., 1].astype(np.uint32) << 8) if bpp == 2 else None
    if fmt == 0x0B:                                                   # P8: palette of BGRA entries
        ph = struct.unpack_from("<I", b, 0x1C)[0]
        pal = np.frombuffer(b, np.uint8, 1024, 0x80 + struct.unpack_from("<I", b, ph + 8)[0]).reshape(256, 4)
        out = pal[px[..., 0]][..., [2, 1, 0, 3]]
    elif fmt in (0x06, 0x12):
        out = px[..., [2, 1, 0, 3]]
    elif fmt in (0x07, 0x1E):
        out[..., :3] = px[..., [2, 1, 0]]
        out[..., 3] = 255
    elif fmt in (0x05, 0x11):
        out[..., 0], out[..., 1], out[..., 2], out[..., 3] = _c5(v16 >> 11), _c6((v16 >> 5) & 63), _c5(v16 & 31), 255
    elif fmt in (0x02, 0x03, 0x10, 0x1C):
        out[..., 0], out[..., 1], out[..., 2] = _c5((v16 >> 10) & 31), _c5((v16 >> 5) & 31), _c5(v16 & 31)
        out[..., 3] = 255 if fmt in (0x03, 0x1C) else (v16 >> 15) * 255
    elif fmt in (0x04, 0x1D):
        out[..., 0], out[..., 1], out[..., 2], out[..., 3] = _c4((v16 >> 8) & 15), _c4((v16 >> 4) & 15), _c4(v16 & 15), _c4(v16 >> 12)
    elif fmt in (0x00, 0x13):
        out[..., :3] = px[..., :1]
        out[..., 3] = 255
    elif fmt in (0x01, 0x1B):
        out[...] = px[..., :1]
    elif fmt in (0x19, 0x1F):
        out[..., :3] = 255
        out[..., 3] = px[..., 0]
    elif fmt in (0x1A, 0x20):
        out[..., :3] = px[..., :1]
        out[..., 3] = px[..., 1]
    return Image.fromarray(np.ascontiguousarray(out), "RGBA")


def decode_font(b):
    """A font resource ("FNTS") -> PIL.Image of its glyph sheet: white, with the 4-bit glyph coverage as alpha."""
    if b[:4] != b"FNTS":
        raise ValueError("not a font resource")
    t = struct.unpack_from("<I", b, 0x1C)[0]
    w, h = struct.unpack_from("<HH", b, t + 4)
    px = np.frombuffer(b, np.uint8, (w * h + 1) // 2, t + 16)
    a = np.stack([px & 15, px >> 4], -1).reshape(-1)[:w * h].reshape(h, w) * 17
    out = np.full((h, w, 4), 255, np.uint8)
    out[..., 3] = a
    return Image.fromarray(out, "RGBA")


def picture(b):
    """Any picture resource (MMAP texture or FNTS font sheet) -> PIL.Image (RGBA)."""
    return decode_font(b) if b[:4] == b"FNTS" else decode_mmap(b)


def info(b):
    """(name, width, height, format name) of an MMAP texture or a font sheet."""
    if b[:4] == b"FNTS":
        t = struct.unpack_from("<I", b, 0x1C)[0]
        w, h = struct.unpack_from("<HH", b, t + 4)
        return "font", w, h, "FONT4"
    name, w, h, fmt = mmap_info(b)
    return name, w, h, FORMATS.get(fmt, ("0x%x" % fmt,))[0]


def textures(path):
    """(index, MMAP bytes) for every texture in a file: a TERF bundle (nested ones too) or a bare MMAP."""
    def walk(buf, prefix):
        if buf[:4] in (b"MMAP", b"FNTS"):
            yield prefix or "0", buf
        elif buf[:4] == b"TERF":
            for i, e in enumerate(read_terf(buf)):
                yield from walk(e, f"{prefix}.{i}" if prefix else str(i))
    yield from walk(Path(path).read_bytes(), "")


def main(argv):
    if len(argv) < 2 or argv[0] not in ("list", "convert"):
        print(__doc__)
        return 1
    cmd, path = argv[0], argv[1]
    only = argv[argv.index("--index") + 1] if "--index" in argv else None
    out_dir = Path(argv[2]) if cmd == "convert" and len(argv) > 2 and argv[2] != "--index" else Path("textures_out")
    stem = Path(path).stem.lower()
    for idx, b in textures(path):
        if only is not None and idx != only:
            continue
        name, w, h, fmt = info(b)
        if cmd == "list":
            print(f"{idx:>5}  {w:>4}x{h:<4}  {fmt:<13} {name}")
            continue
        out_dir.mkdir(parents=True, exist_ok=True)
        safe = "".join(c if c.isalnum() or c in "_.-" else "_" for c in name)
        dest = out_dir / f"{stem}_{idx.replace('.', '_'):>03}{'_' + safe if safe else ''}.png"
        try:
            picture(b).save(dest)
            print("wrote", dest)
        except ValueError as e:
            print(f"entry {idx}: {e}")
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
