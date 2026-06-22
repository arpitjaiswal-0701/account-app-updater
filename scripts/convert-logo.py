#!/usr/bin/env python3
"""Convert a source logo (webp/png/jpg) into transparent toast assets.

Produces assets/alm.png (512x512, transparent) and a multi-size transparent
assets/alm.ico. Removes a white/solid background (antialiased, no halo),
autocrops to the mark, pads to a centered square with a small margin, and
renders at high resolution so both the small header icon and the large
appLogoOverride image stay crisp.

Usage:
    python scripts/convert-logo.py [SOURCE]
    SOURCE defaults to the alm-webp.webp drop in ~/Downloads.
"""
import struct
import sys
from pathlib import Path
from PIL import Image, ImageChops

ROOT = Path(__file__).resolve().parent.parent
ASSETS = ROOT / "assets"
SRC = Path(sys.argv[1]) if len(sys.argv) > 1 else Path.home() / "Downloads" / "alm-webp.webp"

RENDER = 512                                  # png master size (downscales crisp)
ICO_SIZES = [256, 128, 64, 48, 32, 24, 16]    # ICO caps at 256
MARGIN_FRAC = 0.06                            # tight margin -> mark fills the tile


def whiten_to_alpha(img: Image.Image) -> Image.Image:
    """Turn a white/light background transparent, preserving antialiased edges.

    alpha = 255 - min(R,G,B): pure white -> 0 (gone), saturated colour -> 255.
    Edge pixels (white-blended) get graded alpha, so no hard halo. Combined
    with any existing alpha so already-transparent sources are respected.
    """
    rgba = img.convert("RGBA")
    r, g, b, a = rgba.split()
    min_rgb = ImageChops.darker(ImageChops.darker(r, g), b)
    whiteness_alpha = ImageChops.invert(min_rgb)          # white->0, colour->255
    new_alpha = ImageChops.multiply(a, whiteness_alpha)   # a is 255 -> == whiteness_alpha
    rgba.putalpha(new_alpha)
    return rgba


def autocrop_alpha(img: Image.Image) -> Image.Image:
    bbox = img.split()[3].getbbox()
    return img.crop(bbox) if bbox else img


def _dib_entry(im: Image.Image) -> bytes:
    """One 32bpp BMP/DIB icon entry in TRUE BGRA byte order + AND mask.

    This is the canonical Win32 icon format. Pillow's ICO writer emits the
    pixel bytes in the wrong channel order, so Windows' icon decoder renders
    the toast header swapped (red->blue) / wrong (cyan). We lay out the bytes
    as B,G,R,A ourselves so Windows reads it correctly -> true red.
    """
    s = im.width
    px = im.load()
    # BITMAPINFOHEADER: height is doubled (XOR colour bitmap + AND mask).
    hdr = struct.pack("<IiiHHIIiiII", 40, s, s * 2, 1, 32, 0, 0, 0, 0, 0, 0)
    # XOR bitmap, bottom-up rows, each pixel B,G,R,A.
    rows = []
    for y in range(s - 1, -1, -1):
        row = bytearray()
        for x in range(s):
            r, g, b, a = px[x, y]
            row += bytes((b, g, r, a))
        rows.append(bytes(row))
    xor = b"".join(rows)
    # AND mask: 1bpp, rows padded to 4 bytes, all zero (alpha drives transparency).
    row_bytes = ((s + 31) // 32) * 4
    and_mask = b"\x00" * (row_bytes * s)
    return hdr + xor + and_mask


def save_ico_bgra(master: Image.Image, sizes, path: Path) -> None:
    """Assemble a multi-size .ico from hand-written BGRA DIB entries."""
    entries = [(s, _dib_entry(master.resize((s, s), Image.LANCZOS).convert("RGBA")))
               for s in sizes]
    n = len(entries)
    out = struct.pack("<HHH", 0, 1, n)          # ICONDIR: reserved, type=1(icon), count
    offset = 6 + 16 * n
    dir_block = b""
    data_block = b""
    for s, dib in entries:
        dim = 0 if s >= 256 else s              # 0 encodes 256 in ICONDIRENTRY
        dir_block += struct.pack("<BBBBHHII", dim, dim, 0, 0, 1, 32, len(dib), offset)
        data_block += dib
        offset += len(dib)
    path.write_bytes(out + dir_block + data_block)


def square(img: Image.Image) -> Image.Image:
    w, h = img.size
    side = max(w, h)
    pad = int(side * MARGIN_FRAC)
    canvas = side + 2 * pad
    out = Image.new("RGBA", (canvas, canvas), (0, 0, 0, 0))   # transparent pad
    out.paste(img, ((canvas - w) // 2, (canvas - h) // 2), img)
    return out


def main() -> int:
    if not SRC.exists():
        print(f"ERROR: source not found: {SRC}", file=sys.stderr)
        return 1
    ASSETS.mkdir(parents=True, exist_ok=True)

    img = Image.open(SRC)
    img = whiten_to_alpha(img)
    img = autocrop_alpha(img)
    img = square(img)
    big = img.resize((RENDER, RENDER), Image.LANCZOS)        # stays RGBA

    png_path = ASSETS / "alm.png"
    ico_path = ASSETS / "alm.ico"
    big.save(png_path, "PNG")                                # transparent
    save_ico_bgra(big, ICO_SIZES, ico_path)                  # hand-written BGRA DIB

    print(f"Source : {SRC}")
    print(f"Wrote  : {png_path}  ({RENDER}x{RENDER}, transparent)")
    print(f"Wrote  : {ico_path}  (sizes {ICO_SIZES}, transparent)")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
