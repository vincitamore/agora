"""Dot-level controls for Common Gate's operator-requested refinements."""
import sys
sys.dont_write_bytecode = True
import generate as art
from PIL import Image


def check(size):
    drawing = art.threshold()
    grid = drawing.sampled(size)
    isolated = art.Drawing()
    isolated.ornament = drawing.ornament
    detail = isolated.sampled(size)
    scale = 192 / size
    at = lambda x, y: grid[y][x] is not None
    lit = lambda x, y: detail[y][x] is not None
    # The two filled crosses and paired sun rays must mirror at the actual
    # braille-dot level, independently of colour grouping or raster preview.
    assert all(lit(x, y) == lit(size-1-x, y)
               for y in range(size) for x in range(size)), 'ornament symmetry'
    for cx in (37, 155):
        rows = []
        for y in range(size):
            py = (y+.5)*scale
            if 52 < py < 67:
                dots = [x for x in range(size)
                        if abs((x+.5)*scale-cx) < 6 and lit(x, y)]
                assert dots, ('broken cross stem', size, cx, y)
                rows.append(len(dots))
        assert max(rows) >= 2*min(rows), ('missing crossbar', size, cx)
        # Every dot-column under the old projecting pedestal reaches the stair.
        for y in range(size):
            if 151 < (y+.5)*scale < 165:
                for x in range(size):
                    if abs((x+.5)*scale-cx) < 9:
                        assert at(x, y), ('unsupported pedestal', size, x, y)
    rays = [0]*8
    import math
    for y in range(size):
        for x in range(size):
            dx, dy = (x+.5)*scale-96, (y+.5)*scale-20
            if lit(x, y) and 7.5 < math.hypot(dx, dy) < 13:
                rays[round(math.degrees(math.atan2(dy, dx))/45) % 8] += 1
    assert all(rays), ('missing sun ray', size, rays)
    print(f'{size} dots: mirrored ornaments, formed crosses, supported bases, eight rays {rays}')


if __name__ == '__main__':
    for size in (160, 96):
        check(size)
    image = Image.open(art.OUT/'threshold-readme-300.png')
    assert image.size == (300, 300)
    for suffix, width in (('', 512), ('-compact', 300)):
        animation = Image.open(art.OUT/f'threshold{suffix}.gif')
        assert animation.size == (width, width) and animation.info['loop'] == 0
        duration = 0
        for i in range(animation.n_frames):
            animation.seek(i)
            duration += animation.info['duration']
        assert duration == 4800
    print('300px still and decoded 512px/300px 4.8s looping GIFs verified')
