"""Original Agora identity studies. Python 3 + Pillow; no runtime dependency.

Run: python docs/logo/generate.py
Geometry -> sampled dot mask -> Unicode braille and faithful dot raster.
The presentation sheet is a proposal, not adopted branding.
"""
from pathlib import Path
import math
import json
from PIL import Image, ImageDraw, ImageFont

OUT = Path(__file__).resolve().parent
BITS = ((1, 8), (2, 16), (4, 32), (64, 128))
PALETTE = ((222, 206, 174), (111, 178, 173), (202, 132, 105))
BG = (15, 20, 23)


def shape(name, x, y):
    """128-square dot coordinates; return a material, or -1 for open space."""
    x, y = x - 64, y - 64
    if name == "forum":
        # Three independent substantial benches, with entrances between them.
        r = math.hypot(x, y)
        a = (math.degrees(math.atan2(y, x)) + 90) % 360
        if 29 <= r <= 51 and 9 <= a % 120 <= 111:
            return int(a // 120)
        return -1
    if name == "stoa":
        # Three open bays over a shared ground. The higher middle bay gives
        # the silhouette an architectural cadence instead of a headset shape.
        arch = y <= -4 and 23 <= math.hypot(x, y + 4) <= 35
        jambs = 23 <= abs(x) <= 35 and -4 <= y <= 39
        floor = abs(x) <= 61 and 44 <= y <= 51
        if arch or jambs:
            return 0
        for sign in (-1, 1):
            u, v = x - sign * 43, y - 10
            outer = v <= 0 and 10 <= math.hypot(u, v) <= 18
            piers = 10 <= abs(u) <= 18 and 0 <= v <= 29
            if outer or piers:
                return 1
        return 2 if floor else -1
    if name == "voices":
        # Two facing, hooked voice forms. Neither overlaps or owns the center.
        for material, sign in ((1, 1), (2, -1)):
            u, v = x * sign, y * sign
            # Rounded outer rectangle, square-cut aperture open to the other
            # speaker, and a broad tail. The centerline gap is unconditional.
            qx, qy = abs(u + 30) - 8, abs(v + 12) - 16
            shell = math.hypot(max(qx, 0), max(qy, 0)) <= 16
            hollow = u >= -35 and -27 <= v <= 2
            tail = -54 <= u <= -35 and 4 <= v <= 39 and v <= -u - 13
            if ((shell and not hollow) or tail) and u <= -6:
                return material
        return -1
    raise ValueError(name)


def sample(name, size):
    """Majority of 3x3 sub-samples, evaluated at dot centers."""
    grid = []
    for y in range(size):
        row = []
        for x in range(size):
            votes = [shape(name, (x + .5 + dx) * 128 / size,
                           (y + .5 + dy) * 128 / size)
                     for dy in (-.3, 0, .3) for dx in (-.3, 0, .3)]
            lit = [v for v in votes if v >= 0]
            row.append(max(set(lit), key=lit.count) if len(lit) >= 5 else -1)
        grid.append(row)
    return grid


def cells(grid):
    for cy in range(len(grid) // 4):
        for cx in range(len(grid[0]) // 2):
            mask, materials = 0, []
            for dy in range(4):
                for dx in range(2):
                    material = grid[cy * 4 + dy][cx * 2 + dx]
                    if material >= 0:
                        mask |= BITS[dy][dx]
                        materials.append(material)
            yield cx, cy, mask, max(set(materials), key=materials.count) if materials else -1


def text_form(grid):
    width = len(grid[0]) // 2
    rows = [["\u2800"] * width for _ in range(len(grid) // 4)]
    for x, y, mask, _ in cells(grid):
        rows[y][x] = chr(0x2800 + mask)
    return "\n".join("".join(row) for row in rows) + "\n"


def raster(grid, mono=False, shimmer=None):
    # Mean x pitch = 6 + 3/2; mean y pitch = 6 + 6/4. Exactly square.
    pitch, gap_x, gap_y, edge, ss = 6, 3, 6, 16, 3
    width = len(grid[0]) * pitch + (len(grid[0]) // 2 - 1) * gap_x + 2 * edge
    height = len(grid) * pitch + (len(grid) // 4 - 1) * gap_y + 2 * edge
    img = Image.new("RGBA", (width * ss, height * ss))
    draw = ImageDraw.Draw(img)
    for cx, cy, mask, material in cells(grid):
        if not mask:
            continue
        # A terminal can colour a cell, never its individual dots.
        base = PALETTE[0] if mono else PALETTE[material]
        light = 1.07 - .25 * (cy * 4 / len(grid))
        if shimmer is not None:
            position = cx * 2 / len(grid[0]) + cy * 4 / len(grid) * .4
            light += .32 * math.exp(-((position - shimmer) / .11) ** 2)
        color = tuple(min(255, round(c * light)) for c in base) + (255,)
        for dy in range(4):
            for dx in range(2):
                if mask & BITS[dy][dx]:
                    x = edge + (cx * 2 + dx + .5) * pitch + cx * gap_x
                    y = edge + (cy * 4 + dy + .5) * pitch + cy * gap_y
                    r = 2.25
                    draw.ellipse(tuple(round(v * ss) for v in (x-r, y-r, x+r, y+r)), fill=color)
    return img.resize((width, height), Image.Resampling.LANCZOS)


def animation(name, grid):
    """A 4.8-second quiet loop; fixed geometry, cell-wise diagonal light."""
    frames = []
    for i in range(60):
        sweep = -.55 + 2.6 * i / 40 if i < 40 else None
        mark = raster(grid, shimmer=sweep)
        mark.thumbnail((440, 440), Image.Resampling.LANCZOS)
        frame = Image.new("RGB", (480, 480), BG)
        frame.paste(mark, ((480-mark.width)//2, (480-mark.height)//2), mark)
        frames.append(frame)
    # One palette for the whole loop; no frame-wise colour reclassification.
    samples = Image.new("RGB", (128, 128 * len(frames)))
    for i, frame in enumerate(frames):
        # Nearest preserves actual bright dot colours. Averaging thumbnails
        # here teaches the GIF palette only dark dot/background mixtures.
        samples.paste(frame.resize((128, 128), Image.Resampling.NEAREST), (0, 128*i))
    palette = samples.quantize(colors=255, method=Image.Quantize.MEDIANCUT)
    quantized = [f.quantize(palette=palette, dither=Image.Dither.NONE) for f in frames]
    quantized[0].save(OUT / f"{name}.gif", save_all=True,
                      append_images=quantized[1:], duration=80, loop=0,
                      optimize=False, disposal=1)
    # Contact strip is decoded from the actual GIF, not its source frames.
    decoded = Image.open(OUT / f"{name}.gif")
    decoded.convert("RGB").save(OUT / f"{name}-gif-poster.png")
    strip = Image.new("RGB", (4 * 240, 240), BG)
    elapsed = 0
    for i in range(decoded.n_frames):
        decoded.seek(i)
        elapsed += decoded.info["duration"]
    assert elapsed == 4800
    assert decoded.info["loop"] == 0
    for j, frame_id in enumerate((0, 10, 20, 30)):
        decoded.seek(min(frame_id, decoded.n_frames - 1))
        strip.paste(decoded.convert("RGB").resize((240, 240)), (240*j, 0))
    strip.save(OUT / f"{name}-shimmer-frames.png")


def font(size, serif=False):
    names = (["C:/Windows/Fonts/georgia.ttf", "/usr/share/fonts/truetype/dejavu/DejaVuSerif.ttf"]
             if serif else ["C:/Windows/Fonts/segoeui.ttf", "/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf"])
    for name in names:
        if Path(name).exists():
            return ImageFont.truetype(name, size)
    return ImageFont.load_default(size=size)


def centered(draw, message, x, y, face, fill):
    draw.text((x, y), message, font=face, anchor="mt", fill=fill)


def generate():
    names = ("forum", "stoa", "voices")
    labels = (("01 / THE OPEN FORUM", "A shared center. Three distinct presences."),
              ("02 / THE STOA", "A place to enter. A common ground."),
              ("03 / THE EXCHANGE", "Two voices. Neither swallowed by the other."))
    sheet = Image.new("RGB", (1560, 1020), BG)
    d = ImageDraw.Draw(sheet)
    d.text((70, 45), "AGORA", font=font(43, True), fill=PALETTE[0])
    d.text((72, 105), "ASTRA / IDENTITY STUDIES     01", font=font(15), fill=(128, 143, 145))
    d.line((70, 146, 1490, 146), fill=(46, 58, 61), width=1)
    metrics = {}
    for i, name in enumerate(names):
        grid = sample(name, 128)
        compact = sample(name, 64)
        for suffix, dots in (("", grid), ("-compact", compact)):
            text = text_form(dots)
            assert len({len(row) for row in text.splitlines()}) == 1
            assert all(v == -1 for row in (dots[0], dots[-1]) for v in row)
            assert all(row[0] == row[-1] == -1 for row in dots)
            # Roundtrip every encoded bit back to its original occupancy.
            for cx, cy, mask, _ in cells(dots):
                for dy in range(4):
                    for dx in range(2):
                        assert bool(mask & BITS[dy][dx]) == (dots[cy*4+dy][cx*2+dx] >= 0)
            (OUT / f"{name}{suffix}.txt").write_text(text, encoding="utf-8")
            raster(dots).save(OUT / f"{name}{suffix}.png")
        hero = raster(grid)
        hero.thumbnail((410, 410), Image.Resampling.LANCZOS)
        x = 300 + 480 * i
        sheet.paste(hero, (x-hero.width//2, 177), hero)
        centered(d, labels[i][0], x, 613, font(18), PALETTE[0])
        centered(d, labels[i][1], x, 647, font(16), (148, 159, 161))
        # Separate small-grid evaluation, not merely a scaled hero.
        small = raster(compact, mono=True)
        small.thumbnail((185, 185), Image.Resampling.LANCZOS)
        sheet.paste(small, (x-small.width//2, 711), small)
        centered(d, "32 × 16 CELLS / ONE COLOUR", x, 916, font(13), (128, 143, 145))
        metrics[name] = {"fullCells": [64, 32], "compactCells": [32, 16],
                         "fullLitDots": sum(v >= 0 for row in grid for v in row),
                         "compactLitDots": sum(v >= 0 for row in compact for v in row),
                         "edgeLitDots": 0}
        animation(name, grid)
    d.line((70, 966, 1490, 966), fill=(46, 58, 61), width=1)
    d.text((72, 984), "Original geometry · true Unicode braille · proposals, not adopted branding", font=font(14), fill=(128, 143, 145))
    sheet.save(OUT / "astra-studies.png")
    (OUT / "geometry-checks.json").write_text(json.dumps(metrics, indent=2) + "\n", encoding="utf-8")
    print(json.dumps(metrics, indent=2))


if __name__ == "__main__":
    generate()
