"""Agora / lead-dev studies II. Build-only Python 3 + Pillow.

Original geometry -> square dot lattice -> Unicode, PNG and fixed-shape GIF.
Run from any directory: python docs/logo/lead-dev-round2/generate.py
"""
from pathlib import Path
import math
import json
from PIL import Image, ImageDraw, ImageFont

OUT = Path(__file__).resolve().parent
N, SS = 192, 3
BG = (13,17,23)
GOLD = (210,171,104)
IVORY = (235,219,181)
BRONZE = (148,95,55)
TEAL = (87,139,144)
SHADOW = (42,74,82)
BITS = ((1,8),(2,16),(4,32),(64,128))


def mix(a,b,t):
    return tuple(round(x+(y-x)*t) for x,y in zip(a,b))


def bez(a,b,c,d,steps=40):
    return [tuple((1-t)**3*a[k]+3*(1-t)**2*t*b[k]+3*(1-t)*t*t*c[k]+t**3*d[k] for k in (0,1))
            for t in (i/steps for i in range(steps+1))]


class Canvas:
    def __init__(self):
        self.im=Image.new('RGB',(N*SS,N*SS),BG)
        self.pen=ImageDraw.Draw(self.im)

    def poly(self,points,color):
        self.pen.polygon([(round(x*SS),round(y*SS)) for x,y in points],fill=color)

    def ellipse(self,box,color):
        self.pen.ellipse(tuple(round(a*SS) for a in box),fill=color)

    def line(self,points,color,width=1):
        self.pen.line([(round(x*SS),round(y*SS)) for x,y in points],fill=color,width=max(1,round(width*SS)),joint='curve')

    def rect(self,x,y,w,h,color):
        self.poly([(x,y),(x+w,y),(x+w,y+h),(x,y+h)],color)

    def arch(self,x,y,w,h,thick,color,inside=BG):
        self.ellipse((x,y,x+w,y+w),color)
        self.rect(x,y+w/2,w,h-w/2,color)
        self.ellipse((x+thick,y+thick,x+w-thick,y+w-thick),inside)
        self.rect(x+thick,y+w/2,w-2*thick,h-w/2+1,inside)

    def dots(self):
        # Majority coverage removes antialias fringes; average only lit samples.
        pix=self.im.load(); grid=[]
        for y in range(N):
            row=[]
            for x in range(N):
                samples=[pix[x*SS+dx,y*SS+dy] for dy in range(SS) for dx in range(SS)]
                ink=[p for p in samples if p!=BG]
                row.append(tuple(round(sum(p[k] for p in ink)/len(ink)) for k in range(3)) if len(ink)>=5 else None)
            grid.append(row)
        return grid


def rotunda():
    c=Canvas()
    # Curved terraces establish the whole footprint before the architecture.
    for box,col in [((17,151,175,178),BRONZE),((17,147,175,173),IVORY),((22,143,170,168),BRONZE),((22,140,170,164),GOLD),((27,135,165,158),TEAL)]:
        c.ellipse(box,col)
    c.rect(32,66,128,79,SHADOW)
    c.ellipse((32,132,160,157),SHADOW)
    # The room has side bays and a deeper entrance at its centre.
    for x,y,w,h in [(36,80,39,66),(70,83,52,73),(117,80,39,66)]:
        c.arch(x,y,w,h,4,GOLD,TEAL)
        c.arch(x+7,y+10,w-14,h-12,2,BRONZE,SHADOW)
    c.arch(82,111,28,48,3,IVORY,BG)
    # Narrow, genuinely cylindrical columns: highlight is geometry/material.
    for x,base in [(32,145),(65,158),(127,158),(160,145)]:
        c.ellipse((x-7,base-3,x+7,base+3),BRONZE)
        c.ellipse((x-6,base-5,x+6,base),IVORY)
        c.rect(x-3.5,78,7,base-82,BRONZE)
        c.rect(x-3.5,78,2.6,base-82,IVORY)
        c.rect(x-.5,78,1.8,base-82,GOLD)
        c.poly([(x-6,76),(x+6,76),(x+3,83),(x-3,83)],GOLD)
        c.ellipse((x-7,73,x+7,78),IVORY)
    # Low dome and meridians; each line follows the curved roof surface.
    roof=[(29,63)]+[(96+67*math.cos(t),63-42*math.sin(t)) for t in (i*math.pi/100 for i in range(100,-1,-1))]+[(163,63)]
    c.poly(roof,BRONZE)
    for i in range(11):
        longitude=-math.pi/2+i*math.pi/10
        points=[(96+67*math.sin(t)*math.sin(longitude),63-42*math.cos(t)+7*math.sin(t)*math.cos(longitude))
                for t in (j*math.pi/2/60 for j in range(61))]
        c.line(points,IVORY if i<6 else GOLD,1.4)
    c.ellipse((23,59,169,80),BRONZE)
    c.ellipse((23,56,169,74),GOLD)
    c.ellipse((29,56,163,66),TEAL)
    c.line([(x,60+7*math.sqrt(max(0,1-((x-96)/67)**2))) for x in range(30,163)],IVORY,1.7)
    c.rect(91,16,10,5,GOLD)
    c.ellipse((93,11,99,17),IVORY)
    return c.dots()


def leaf_gate():
    c=Canvas()
    # Each book half contains separate page leaves; no random decorative speckle.
    for side in (-1,1):
        def mirror(points): return [(96+side*(x-96),y) for x,y in points]
        cover=bez((18,50),(48,56),(64,100),(96,160))+bez((96,160),(69,175),(43,180),(20,164))+bez((20,164),(32,126),(32,90),(18,50))
        c.poly(mirror(cover),BRONZE)
        c.line(mirror(cover),GOLD,3)
        for j in range(6):
            x=26+j*8; top=48-j*4
            outer=bez((x,top),(x+26,top+12),(65+j*3,103),(96,158))
            inner=bez((96,158),(75+j*2,142),(x+15,95),(x+4,top+5))
            c.poly(mirror(outer+inner),IVORY if j%2==0 else GOLD)
            c.line(mirror(outer),TEAL if j==0 else BRONZE,1.1)
        c.line(mirror(bez((24,162),(45,169),(70,170),(95,159))),IVORY,2)
        c.line(mirror(bez((29,157),(49,165),(70,163),(91,157))),GOLD,1.3)
    # Pointed arch born at the spine; two flowing shoulders, open all the way down.
    outline=bez((96,19),(88,40),(62,65),(62,111))+[(62,160),(130,160),(130,111)]+bez((130,111),(130,65),(104,40),(96,19))
    c.poly(outline,TEAL)
    for inset,col in [(4,IVORY),(8,GOLD),(12,BRONZE),(16,IVORY),(20,BG)]:
        a=62+inset*.64; b=192-a; top=19+inset*1.45
        outline=bez((96,top),(89,top+18),(a,78),(a,112))+[(a,160),(b,160),(b,112)]+bez((b,112),(b,78),(103,top+18),(96,top))
        c.poly(outline,col)
    for j in range(3):
        c.poly([(75-j*5,160+j*5),(117+j*5,160+j*5),(123+j*5,163+j*5),(69-j*5,163+j*5)],IVORY if j==0 else GOLD)
        c.line([(69-j*5,163+j*5),(123+j*5,163+j*5)],BRONZE,1.2)
    return c.dots()


def bell():
    c=Canvas()
    # Masonry frame, open below, distinct from a notification-bell silhouette.
    for x in (30,162):
        c.rect(x-11,148,23,26,SHADOW)
        c.poly([(x+12,148),(x+18,144),(x+18,170),(x+12,174)],TEAL)
        for y,w in [(170,29),(165,25),(148,27),(144,22)]:
            c.rect(x-w/2,y,w,4,GOLD if y%2==0 else BRONZE)
            c.line([(x-w/2,y),(x+w/2,y)],IVORY,1.3)
        c.rect(x-4,80,8,63,BRONZE)
        c.rect(x-4,80,3,63,IVORY)
        c.rect(x+.5,80,1.5,63,GOLD)
        c.rect(x-8,77,16,4,GOLD)
    c.arch(22,14,148,70,12,GOLD,BG)
    # arch() has a semicircular top; discard its artificial lower rectangle by
    # constructing the actual arch ring above the spring line explicitly.
    c.rect(16,88,164,52,BG)
    for x in (30,162):
        c.rect(x-4,81,8,63,BRONZE);c.rect(x-4,81,3,63,IVORY)
    for i in range(11):
        t=math.pi+i*math.pi/10
        c.line([(96+62*math.cos(t),88+62*math.sin(t)),(96+74*math.cos(t),88+74*math.sin(t))],BRONZE,1.2)
    c.line([(96+72*math.cos(t),88+72*math.sin(t)) for t in (math.pi+j*math.pi/100 for j in range(101))],IVORY,2)
    c.line([(96+59*math.cos(t),88+59*math.sin(t)) for t in (math.pi+j*math.pi/100 for j in range(101))],TEAL,2)
    c.rect(51,63,90,6,BRONZE);c.rect(51,62,90,2,GOLD)
    c.arch(90,65,12,22,3,IVORY,BG)
    # Cast bronze profile and graduated shoulders.
    profile=bez((96,79),(70,79),(81,105),(65,128))+bez((65,128),(61,134),(57,137),(57,140))+[(135,140)]+bez((135,140),(135,137),(131,134),(127,128))+bez((127,128),(111,105),(122,79),(96,79))
    c.poly(profile,GOLD)
    c.poly(bez((96,80),(117,83),(108,112),(126,133))+[(130,140),(111,140)]+bez((111,140),(109,116),(100,99),(96,80)),BRONZE)
    c.line(bez((90,84),(77,91),(85,116),(67,133)),IVORY,2.2)
    for y,rx in [(99,17),(122,25),(130,31)]:
        c.line([(96+rx*math.cos(t),y+3*math.sin(t)) for t in (j*math.pi/60 for j in range(61))],BRONZE,1.3)
    c.ellipse((56,133,136,150),GOLD)
    c.ellipse((61,139,131,151),TEAL)
    c.ellipse((66,142,126,150),SHADOW)
    c.line([(96,140),(96,160)],GOLD,2.5)
    c.ellipse((91,157,101,167),GOLD);c.ellipse((92,158,96,162),IVORY)
    return c.dots()


def text(grid):
    n=len(grid); rows=[]
    for y in range(0,n,4):
        rows.append(''.join(chr(0x2800+sum(BITS[dy][dx] for dy in range(4) for dx in range(2) if grid[y+dy][x+dx])) for x in range(0,n,2)))
    return '\n'.join(rows)+'\n'


def raster(grid,phase=None,size=864):
    n=len(grid); pad=24; pitch=(size-2*pad)/n
    im=Image.new('RGB',(size,size),BG); pen=ImageDraw.Draw(im)
    for y,row in enumerate(grid):
        for x,col in enumerate(row):
            if col is None: continue
            # Small periodic cell gaps preserve square average pitch.
            px=pad+(x+.5)*pitch+(-.12 if x%2==0 else .12)*pitch
            py=pad+(y+.5)*pitch+(-.12 if y%4<2 else .12)*pitch
            base=mix(BG,col,.86+.14*(1-(x+y)/(2*n)))
            if phase is not None:
                along=(x+y)/(2*n)
                center=-.35+1.7*phase
                delta=abs(along-center)
                shine=.5*(1+math.cos(math.pi*delta/.12)) if delta<.12 else 0
                base=mix(base,IVORY,.65*shine)
            r=pitch*.30
            pen.ellipse((px-r,py-r,px+r,py+r),fill=base)
    return im


def font(size):
    for f in ('C:/Windows/Fonts/consola.ttf','/usr/share/fonts/truetype/dejavu/DejaVuSansMono.ttf'):
        if Path(f).exists(): return ImageFont.truetype(f,size)
    return ImageFont.load_default()


def main():
    report={}; sheet=Image.new('RGB',(1800,860),BG);pen=ImageDraw.Draw(sheet)
    pen.text((64,38),'agora / studies II',font=font(30),fill=IVORY)
    pen.text((64,84),'Places, memory, and voices that reach one another.',font=font(17),fill=(145,158,165))
    for i,(name,label,build) in enumerate((('rotunda','04  THE ROTUNDA',rotunda),('leaf-gate','05  THE LEAF GATE',leaf_gate),('bell','06  THE BELL',bell))):
        grid=build(); txt=text(grid);rows=txt.splitlines()
        assert all(len(r)==N//2 for r in rows) and len(rows)==N//4
        for y in range(N):
            for x in range(N):
                assert bool((ord(rows[y//4][x//2])-0x2800)&BITS[y%4][x%2])==bool(grid[y][x])
        assert not any(grid[0]+grid[-1]+[r[0] for r in grid]+[r[-1] for r in grid])
        (OUT/f'{name}.txt').write_text(txt,encoding='utf-8')
        still=raster(grid);still.save(OUT/f'{name}.png')
        sheet.paste(still.resize((570,570),Image.Resampling.LANCZOS),(15+i*600,143))
        pen.text((65+i*600,749),label,font=font(22),fill=IVORY)
        # Fixed palette across the loop; stationary geometry, no alpha flicker.
        palette=still.quantize(colors=192)
        frames=[raster(grid,j/60,size=648).quantize(palette=palette,dither=Image.Dither.NONE) for j in range(60)]
        assert frames[0].tobytes()==frames[-1].tobytes(),'sweep must rest identically across loop seam'
        frames[0].save(OUT/f'{name}.gif',save_all=True,append_images=frames[1:],duration=80,loop=0,optimize=False,disposal=1)
        report[name]={'dots':sum(bool(v) for r in grid for v in r),'text':[N//2,N//4],'png':list(still.size),'gif_ms':4800,'same_loop_endpoints':True}
    sheet.save(OUT/'studies-II.png')
    (OUT/'geometry-checks.json').write_text(json.dumps(report,indent=2)+'\n',encoding='utf-8')
    print(json.dumps(report))


if __name__=='__main__': main()
