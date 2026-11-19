"""upscale_textures.py - upscale the game's menu / HUD pictures into the texture override folder.

Reads pictures straight from Data/UIS_*.DAT (read_textures.py, same folder), upscales them and writes
textures/<bundle>/<NNN>.png, which the game picks up on its next start (see textures/README.txt).

    python upscale_textures.py                                   (driver portraits, plain Lanczos 2x: a quick test)
    python upscale_textures.py --model 4x-UltraSharp.pth         (an AI model in the models folder: much sharper)
    python upscale_textures.py --model RealESRGAN_x4plus.pth --bundles uis_drpo uis_drps uis_trlg --scale 2
    python upscale_textures.py --model m.pth --bundles uis_drpo --index 5 12 30 --overwrite
    python upscale_textures.py --pre 1x-cleanup.pth --model RealESRGAN_x4plus.pth --overwrite   (clean up, then upscale)
    python upscale_textures.py --soften 0.7 --model RealESRGAN_x4plus.pth --overwrite            (melt the blocks first)
    python upscale_textures.py --bundles ui --model <model>.pth                                    (every menu / HUD picture and the fonts)

What it does to each picture
  1. Transparency is split off. The colour under fully transparent pixels (black in these files) is replaced by
     the colours of the nearest visible pixels, so the upscaler does not pull black into the edges (dark fringes).
  2. The colour is upscaled by the model (at the model's own scale, e.g. 4x), in tiles to bound GPU memory.
  3. It is resized to the target scale (default 2x) with Lanczos: 4x-then-down usually looks cleaner than 2x direct.
  4. The transparency mask is resized with Lanczos; a mask that was on/off only (the portraits) is made on/off
     again with a soft one-pixel edge.
  Blank pictures (nothing visible, or one flat colour) are skipped; existing outputs too, unless --overwrite.

Models: any single-image upscaling model spandrel can load (.pth / .safetensors: ESRGAN, Real-ESRGAN, SwinIR,
HAT, ...). Put model files in a "models" folder beside this script (or pass a full path). Photos (portraits): RealESRGAN_x4plus, 4x-UltraSharp, 4x_NMKD-Siax. Flat art / text: try an anime model
(RealESRGAN_x4plus_anime_6B) or keep Lanczos for those bundles. Models: openmodeldb.info.

Needs: pip install numpy pillow       and for --model: pip install torch spandrel
       (torch with CUDA for an NVIDIA card: see pytorch.org; on CPU it works, slowly)
"""
import argparse
import sys
from pathlib import Path

import numpy as np
from PIL import Image

sys.path.insert(0, str(Path(__file__).resolve().parent))
from read_textures import read_terf, picture, info  # noqa: E402

HERE = Path(__file__).resolve().parent


# ------------------------------------------------------------------ helpers
def box_blur(a, r):
    """Box blur of a (H, W[, C]) float array with radius r (edges clamped)."""
    if r < 1:
        return a
    for axis in (0, 1):
        n = a.shape[axis]
        pad = [(0, 0)] * a.ndim
        pad[axis] = (r + 1, r)
        c = np.cumsum(np.pad(a, pad, mode="edge"), axis=axis)
        hi = np.take(c, np.arange(2 * r + 1, 2 * r + 1 + n), axis=axis)
        lo = np.take(c, np.arange(0, n), axis=axis)
        a = (hi - lo) / (2 * r + 1)
    return a


def fill_transparent(rgb, alpha):
    """Colour of invisible pixels from the visible ones around them (normalised blur, widening until all filled)."""
    vis = (alpha > 0).astype(np.float64)
    if vis.all() or not vis.any():
        return rgb
    out = rgb.astype(np.float64).copy()
    need = vis == 0
    r = 1
    while need.any() and r <= max(rgb.shape[:2]):
        w = box_blur(vis, r)
        c = box_blur(rgb * vis[..., None], r)
        ok = need & (w > 1e-6)
        out[ok] = c[ok] / w[ok][:, None]
        need &= ~ok
        r *= 2
    return out


def is_blank(img):
    a = np.asarray(img)
    if a[..., 3].max() == 0:
        return True
    vis = a[a[..., 3] > 0]
    return np.ptp(vis[:, :3], axis=0).max() <= 2 and np.ptp(a[..., 3]) <= 2      # one flat colour, flat alpha


# ------------------------------------------------------------------ upscalers
class Lanczos:
    scale = 1
    name = "lanczos"

    def __call__(self, rgb):            # rgb: float32 (H, W, 3) in 0..1; returns it as is: resizing happens later
        return rgb


class SpandrelModel:
    def __init__(self, path, tile, fp16, device):
        import torch
        from spandrel import ModelLoader, ImageModelDescriptor
        self.torch = torch
        m = ModelLoader().load_from_file(str(path))
        if not isinstance(m, ImageModelDescriptor):
            raise SystemExit(f"{path}: not a single-image model")
        self.device = device or ("cuda" if torch.cuda.is_available() else "cpu")
        self.model = m.to(self.device).eval()
        self.fp16 = fp16 and self.device == "cuda" and m.supports_half
        if self.fp16:
            self.model.half()
        self.scale, self.tile, self.name = m.scale, tile, Path(path).stem
        print(f"model {self.name}: {m.architecture.name}, x{m.scale}, on {self.device}{' fp16' if self.fp16 else ''}")

    def run(self, rgb):
        t = self.torch.from_numpy(np.ascontiguousarray(rgb.transpose(2, 0, 1)))[None].to(self.device)
        t = t.half() if self.fp16 else t.float()
        with self.torch.inference_mode():
            o = self.model(t)
        return o[0].float().clamp(0, 1).permute(1, 2, 0).cpu().numpy()

    def __call__(self, rgb):
        h, w = rgb.shape[:2]
        T, s = self.tile, self.scale
        if not T or (h <= T and w <= T):
            return self.run(rgb)
        pad = 16                                         # overlap: each tile gets context, only its middle is kept
        out = np.zeros((h * s, w * s, 3), np.float32)
        for y in range(0, h, T):
            for x in range(0, w, T):
                y0, x0, y1, x1 = max(0, y - pad), max(0, x - pad), min(h, y + T + pad), min(w, x + T + pad)
                o = self.run(rgb[y0:y1, x0:x1])
                yy, xx = (y - y0) * s, (x - x0) * s
                th, tw = (min(y + T, h) - y) * s, (min(x + T, w) - x) * s
                out[y * s:y * s + th, x * s:x * s + tw] = o[yy:yy + th, xx:xx + tw]
        return out


# ------------------------------------------------------------------ one picture
def soften(rgb, r):
    """A light blur (radius r pixels, box approximating a Gaussian) to melt the 4x4 compression blocks first."""
    if r <= 0:
        return rgb
    k = max(1, int(round(r)))
    out = rgb
    for _ in range(3):                                  # three box passes ~ Gaussian
        out = box_blur(out, k)
    return (rgb * (1 - min(1.0, r / k)) + out * min(1.0, r / k)).astype(np.float32) if r < k else out.astype(np.float32)


def upscale(img, up, scale, pre=None, soft=0.0):
    a = np.asarray(img.convert("RGBA")).astype(np.float32) / 255
    rgb, alpha = a[..., :3], a[..., 3]
    h, w = alpha.shape
    W, H = round(w * scale), round(h * scale)
    if rgb.min() >= 1:                                   # white with shape in alpha (font glyph sheets): the alpha IS
        g = np.repeat(alpha[..., None], 3, -1)           # the picture, so it goes through the upscaler as grey
        big = up(soften(g, soft) if soft else g)
        m = Image.fromarray((np.clip(big.mean(-1), 0, 1) * 255 + 0.5).astype(np.uint8), "L").resize((W, H), Image.LANCZOS)
        out = Image.new("RGBA", (W, H), (255, 255, 255, 0))
        out.putalpha(m)
        return out
    rgb = fill_transparent(rgb, alpha).astype(np.float32)
    rgb = soften(rgb, soft)
    if pre is not None:                                 # a 1x clean-up model (de-JPEG / de-block) before the upscale
        rgb = pre(rgb)
        if rgb.shape[:2] != (h, w):
            rgb = np.asarray(Image.fromarray((np.clip(rgb, 0, 1) * 255 + 0.5).astype(np.uint8)).resize((w, h), Image.LANCZOS)).astype(np.float32) / 255
    big = up(rgb)
    col = Image.fromarray((np.clip(big, 0, 1) * 255 + 0.5).astype(np.uint8), "RGB").resize((W, H), Image.LANCZOS)
    if alpha.min() >= 1:
        return col
    m = Image.fromarray((alpha * 255 + 0.5).astype(np.uint8), "L").resize((W, H), Image.LANCZOS)
    binary = np.isin(np.unique((alpha * 255).round()), [0, 255]).all()
    if binary:                                           # on/off mask (DXT1): crisp again, one soft pixel at the edge
        ma = np.asarray(m).astype(np.float32)
        ma = np.clip((ma - 128) * 2 + 128, 0, 255)
        m = Image.fromarray(ma.astype(np.uint8), "L")
    out = col.convert("RGBA")
    out.putalpha(m)
    return out


# ------------------------------------------------------------------ main
def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--data", default=str(HERE / "Data"), help="the game's Data folder (default: Data beside this script)")
    ap.add_argument("--out", default=str(HERE / "textures"), help="override folder (default: textures beside this script)")
    ap.add_argument("--bundles", nargs="+", default=["uis_drpo", "uis_drps"],
                    help="bundle names (default: the portraits); 'ui' = every picture bundle of the menus and HUD, fonts included")
    ap.add_argument("--index", nargs="+", type=int, help="only these entry numbers")
    ap.add_argument("--model", help="upscaling model file (.pth / .safetensors); without it: Lanczos")
    ap.add_argument("--pre", help="clean-up model run first at the original size (a 1x de-JPEG / de-block model)")
    ap.add_argument("--soften", type=float, default=0.0, help="blur the original by this many pixels first (0.5-1 melts compression blocks)")
    ap.add_argument("--scale", type=float, default=2.0, help="output size as a multiple of the original (default 2)")
    ap.add_argument("--tile", type=int, default=512, help="model tile size in input pixels (0: whole image)")
    ap.add_argument("--fp16", action="store_true", help="half precision on CUDA (faster, less memory)")
    ap.add_argument("--device", help="cuda / cpu (default: cuda when available)")
    ap.add_argument("--overwrite", action="store_true", help="replace existing outputs")
    args = ap.parse_args()

    def find(name):                     # as given, or in a models folder beside this script
        for c in (Path(name), HERE / "models" / name, HERE / name):
            if c.is_file():
                return c
        raise SystemExit(f"model file not found: {name}\n"
                         f"Download it (e.g. from openmodeldb.info) and put it in {HERE / 'models'}, "
                         f"or pass its full path.")
    up = SpandrelModel(find(args.model), args.tile, args.fp16, args.device) if args.model else Lanczos()
    pre = SpandrelModel(find(args.pre), args.tile, args.fp16, args.device) if args.pre else None
    done = skipped = 0
    bundles = []
    for b in args.bundles:                # 'ui': all UIS_*.DAT except the screens (UIS_ALL) and the video bundles
        if b.lower() == "ui":
            bundles += sorted(p.stem.lower() for p in Path(args.data).glob("UIS_*.DAT")
                              if p.stem.upper() not in ("UIS_ALL", "UIS_VIDE", "UIS_FMVS") and not p.stem.upper().startswith("UIS_CVD"))
        else:
            bundles.append(b.lower())
    for k, bundle in enumerate(bundles):
        print(f"[{k + 1}/{len(bundles)}] {bundle}", flush=True)
        path = Path(args.data) / f"{bundle.upper()}.DAT"
        if not path.exists():
            print(f"{path}: not found")
            continue
        entries = read_terf(path.read_bytes())
        dest_dir = Path(args.out) / bundle.lower()
        dest_dir.mkdir(parents=True, exist_ok=True)
        for i, b in enumerate(entries):
            if args.index and i not in args.index:
                continue
            if b[:4] not in (b"MMAP", b"FNTS"):
                continue
            dest = dest_dir / f"{i:03d}.png"
            if dest.exists() and not args.overwrite:
                skipped += 1
                continue
            name, w, h, fmt = info(b)
            try:
                img = picture(b)
            except ValueError as e:
                print(f"{bundle} {i}: {e}")
                continue
            if is_blank(img):
                skipped += 1
                continue
            upscale(img, up, args.scale, pre, args.soften).save(dest)
            done += 1
            print(f"{bundle} {i:3d}  {w}x{h} -> {round(w * args.scale)}x{round(h * args.scale)}  {dest}")
    print(f"done: {done} written, {skipped} skipped ({up.name}). Restart the game server to see them.")


if __name__ == "__main__":
    main()
