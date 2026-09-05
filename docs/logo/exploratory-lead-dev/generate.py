"""Procedural braille logo studies. Build only: Python 3 + Pillow.

Run: python docs/logo/generate.py
Geometry owns one square-pitch dot lattice. PNG and Unicode braille are two
representations of those same dots; no font rasterization or image tracing.
"""
from pathlib import Path
import math
from PIL import Image, ImageDraw, ImageFont

OUT = Path(__file__).resolve().parent
W = H = 128
S = 3
BG = '#0d1117'
GOLD = '#d8b87a'
IVORY = '#e7dcc3'
BRONZE = '#a77b49'
TEAL = '#668c91'


class Drawing:
    def __init__(self):
        self.layers = []

    def shape(self, color, polygon=None, ellipse=None):
        mask = Image.new('L', (W*S, H*S))
        pen = ImageDraw.Draw(mask)
        if polygon:
            pen.polygon([(round(x*S), round(y*S)) for x,y in polygon], fill=255)
        if ellipse:
            pen.ellipse(tuple(round(a*S) for a in ellipse), fill=255)
        self.layers.append((color, mask))

    def dots(self):
        grid = [[None]*W for _ in range(H)]
        for color, mask in self.layers:
            for y in range(H):
                for x in range(W):
                    votes = sum(mask.getpixel((x*S+sx,y*S+sy)) > 127
                                for sy in range(S) for sx in range(S))
                    if votes >= 5:
                        grid[y][x] = color
        return grid


def forum():
    d = Drawing()
    def p(a,b,z=0):
        return (64 + .86*(a-b), 43 + .48*(a+b)-z)
    def poly(color, points):
        d.shape(color, polygon=[p(*v) for v in points])
    def slab(a,b,c,e,z,thick,top=GOLD):
        poly(BRONZE,[(a,e,z),(c,e,z),(c,e,z-thick),(a,e,z-thick)])
        poly(TEAL,[(c,b,z),(c,e,z),(c,e,z-thick),(c,b,z-thick)])
        poly(top,[(a,b,z),(c,b,z),(c,e,z),(a,e,z)])
    # A substantial common floor, with the entrance facing the reader.
    slab(-3,-3,57,57,0,5,TEAL)
    # Inset empty court: architecture encloses space without occupying it.
    poly(BG,[(14,14,.1),(48,14,.1),(48,48,.1),(14,48,.1)])
    # Front step and open threshold. The floor is visibly reachable.
    slab(46,46,61,61,-3,3,BRONZE)
    # Two inhabited wings, with their shared corner forming the third mass.
    for a,b in [(5,t) for t in (5,17,29,41,53)]+[(t,5) for t in (17,29,41,53)]:
        slab(a-2.8,b-2.8,a+2.8,b+2.8,3,3,IVORY)
        poly(GOLD,[(a-1.8,b+1.8,27),(a+1.8,b+1.8,27),(a+1.8,b+1.8,4),(a-1.8,b+1.8,4)])
        poly(BRONZE,[(a+1.8,b-1.8,27),(a+1.8,b+1.8,27),(a+1.8,b+1.8,4),(a+1.8,b-1.8,4)])
        slab(a-3,b-3,a+3,b+3,27,2,IVORY)
    slab(-2,-2,12,58,32,4,IVORY)
    slab(12,-2,58,12,32,4,GOLD)
    return d.dots()


def chorus():
    d = Drawing()
    # Five distinct pillars share a courtyard, with no central commanding figure.
    points = [(31,55,31),(49,38,31),(74,38,31),(94,55,31),(64,81,31)]
    for x,y,h in points:
        d.shape(TEAL, ellipse=(x-10,y+12,x+10,y+21))
        d.shape(BRONZE,polygon=[(x-7,y-h),(x+7,y-h),(x+7,y+14),(x-7,y+14)])
        d.shape(GOLD,polygon=[(x-7,y-h),(x,y-h),(x,y+14),(x-7,y+14)])
        d.shape(IVORY,ellipse=(x-7,y-h-4,x+7,y-h+4))
        d.shape(GOLD,ellipse=(x-7,y+10,x+7,y+18))
    return d.dots()


def portico():
    d = Drawing()
    # Monumental A, its counter opened into a traversable door.
    d.shape(GOLD,polygon=[(57,12),(70,12),(109,101),(85,101),(64,44),(42,101),(19,101)])
    d.shape(IVORY,polygon=[(57,12),(63,12),(31,101),(19,101)])
    d.shape(BRONZE,polygon=[(70,12),(109,101),(99,101),(64,24)])
    d.shape(GOLD,ellipse=(39,58,89,109))
    d.shape(GOLD,polygon=[(39,83),(89,83),(89,105),(39,105)])
    d.shape(BG,ellipse=(49,69,79,100))
    d.shape(BG,polygon=[(49,84),(79,84),(79,107),(49,107)])
    d.shape(IVORY,polygon=[(14,106),(114,106),(114,111),(14,111)])
    d.shape(BRONZE,polygon=[(9,115),(119,115),(119,120),(9,120)])
    return d.dots()


BITS = ((1,8),(2,16),(4,32),(64,128))


def braille(grid):
    lines = []
    for y in range(0,H,4):
        line = ''
        for x in range(0,W,2):
            bits = sum(BITS[dy][dx] for dy in range(4) for dx in range(2)
                       if grid[y+dy][x+dx] not in (None,BG))
            line += chr(0x2800+bits)
        lines.append(line)
    return '\n'.join(lines)+'\n'


def render(grid, background=BG):
    # Horizontal cell gap1; vertical gap2 => equal mean dot pitch5.5.
    pitch,gx,gy,pad = 5,1,2,28
    size = pad*2+W*pitch+(W//2-1)*gx
    im = Image.new('RGBA',(size,size),background)
    pen = ImageDraw.Draw(im)
    for y in range(H):
        for x in range(W):
            color = grid[y][x]
            if color in (None,BG):
                continue
            px,py=pad+x*pitch+(x//2)*gx,pad+y*pitch+(y//4)*gy
            # Mild upper-left illumination, no blur: the dots remain the mark.
            v=.80+.20*(1-(x+y)/(W+H))
            rgb=tuple(round(int(color[k:k+2],16)*v) for k in (1,3,5))
            pen.ellipse((px-1.55,py-1.55,px+1.55,py+1.55),fill=rgb+(255,))
    return im


def font(size):
    for name in ('C:/Windows/Fonts/consola.ttf','/usr/share/fonts/truetype/dejavu/DejaVuSansMono.ttf'):
        if Path(name).exists():
            return ImageFont.truetype(name,size)
    return ImageFont.load_default()


def main():
    sheet=Image.new('RGB',(1800,850),BG)
    pen=ImageDraw.Draw(sheet)
    pen.text((70,50),'agora / braille studies',font=font(30),fill=IVORY)
    pen.text((70,96),'A place for independent voices.',font=font(17),fill='#89939f')
    for i,(name,build,label) in enumerate((('forum',forum,'01  THE FORUM'),('chorus',chorus,'02  THE CHORUS'),('portico',portico,'03  THE PORTICO'))):
        grid=build()
        txt=braille(grid)
        (OUT/f'{name}.txt').write_text(txt,encoding='utf-8')
        still=render(grid)
        still.save(OUT/f'{name}.png')
        render(grid,(0,0,0,0)).save(OUT/f'{name}-transparent.png')
        small=still.resize((530,530),Image.Resampling.LANCZOS)
        sheet.paste(small,(35+i*600,150))
        pen.text((75+i*600,710),label,font=font(22),fill=IVORY)
        # Decode every glyph back to the source mask: this is actual braille.
        rows=txt.splitlines()
        assert len(rows)==H//4 and all(len(r)==W//2 for r in rows)
        for y in range(H):
            for x in range(W):
                lit=bool((ord(rows[y//4][x//2])-0x2800)&BITS[y%4][x%2])
                assert lit == (grid[y][x] not in (None,BG))
    sheet.save(OUT/'studies.png')


if __name__=='__main__':
    main()
