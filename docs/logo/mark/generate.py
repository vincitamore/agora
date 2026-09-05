"""Agora / Places to gather. Original architectural braille studies by Bruno.

Python 3 + Pillow, build-time only. Run this file to regenerate its local assets.
All architecture is constructed from projected geometry, never traced from art.
"""
from pathlib import Path
import math
import json
import argparse
from PIL import Image, ImageDraw, ImageFont

OUT = Path(__file__).resolve().parent
SS = 3
BG = (12, 19, 24)
INK = {
    "stone": (231, 207, 166), "light": (255, 235, 193),
    "gold": (217, 173, 104), "bronze": (146, 105, 68),
    "shadow": (88, 79, 63), "teal": (90, 148, 150),
    "water": (130, 189, 182), "deep": (43, 86, 96),
    "copper": (197, 122, 87), "flame": (255, 233, 164),
    "night": (29, 44, 50),
}
BITS = ((1, 8), (2, 16), (4, 32), (64, 128))


class Drawing:
    def __init__(self):
        self.im = Image.new("RGBA", (192*SS, 192*SS))
        self.d = ImageDraw.Draw(self.im)

    def polygon(self, points, color):
        fill = INK[color] + (255,) if color is not None else (0, 0, 0, 0)
        self.d.polygon([(round(x*SS), round(y*SS)) for x, y in points], fill=fill)

    def ellipse(self, box, color):
        self.d.ellipse(tuple(round(v*SS) for v in box), fill=INK[color]+(255,))

    def rect(self, box, color):
        x0, y0, x1, y1 = box
        self.polygon([(x0,y0),(x1,y0),(x1,y1),(x0,y1)], color)

    def line(self, points, color, width=1):
        self.d.line([(round(x*SS),round(y*SS)) for x,y in points],
                    fill=INK[color]+(255,), width=round(width*SS))

    def sampled(self, size):
        grid=[]
        for y in range(size):
            row=[]
            for x in range(size):
                pixels=[]
                for dy in (-.3,0,.3):
                    for dx in (-.3,0,.3):
                        px=min(192*SS-1, max(0, int((x+.5+dx)*192*SS/size)))
                        py=min(192*SS-1, max(0, int((y+.5+dy)*192*SS/size)))
                        p=self.im.getpixel((px,py))
                        if p[3]: pixels.append(p[:3])
                row.append(tuple(round(sum(p[k] for p in pixels)/len(pixels))
                                 for k in range(3)) if len(pixels)>=5 else None)
            grid.append(row)
        return grid


def arc(cx, cy, rx, ry, start, end, count=80):
    return [(cx+rx*math.cos(math.radians(start+(end-start)*i/count)),
             cy+ry*math.sin(math.radians(start+(end-start)*i/count)))
            for i in range(count+1)]


def spark(d,x,y,r=4):
    d.polygon([(x,y-r),(x+1,y-1),(x+r,y),(x+1,y+1),
               (x,y+r),(x-1,y+1),(x-r,y),(x-1,y-1)], "flame")


def council():
    d=Drawing()
    def p(x,y,z=0): return (96+x,128+y*.43-z)
    def ring(inner,outer,z,thickness):
        angles=[-210+240*i/100 for i in range(101)]
        def edge(r,zz):
            return [p(r*math.cos(math.radians(a)),r*math.sin(math.radians(a)),zz) for a in angles]
        # Vertical faces first, with two explicit cut ends at the entrance.
        d.polygon(edge(outer,z)+edge(outer,z-thickness)[::-1], "bronze")
        d.polygon(edge(inner,z)+edge(inner,z-thickness)[::-1], "shadow")
        for a in (-210,30):
            c,s=math.cos(math.radians(a)),math.sin(math.radians(a))
            d.polygon([p(inner*c,inner*s,z),p(outer*c,outer*s,z),
                       p(outer*c,outer*s,z-thickness),p(inner*c,inner*s,z-thickness)], "gold")
        d.polygon(edge(outer,z)+edge(inner,z)[::-1], "stone")
        # Radial joints are carved in the seating, not separate scatter.
        for a in range(-195,30,15):
            c,s=math.cos(math.radians(a)),math.sin(math.radians(a))
            d.line([p((inner+1)*c,(inner+1)*s,z),p((outer-1)*c,(outer-1)*s,z)],"bronze",.7)
    # Low common platform; the foreground cut is an entrance, not a throne.
    d.ellipse((16,96,176,167),"bronze")
    d.ellipse((16,91,176,161),"shadow")
    d.ellipse((59,112,133,146),"gold")
    d.ellipse((62,114,130,144),"deep")
    d.polygon([(96,116),(125,129),(96,142),(67,129)],"teal")
    d.polygon([(96,120),(116,129),(96,138),(76,129)],"water")
    d.polygon([(96,124),(107,129),(96,134),(85,129)],"stone")
    d.line([(96,119),(96,139)],"deep",.8)
    d.line([(75,129),(117,129)],"deep",.8)
    for inner,outer,z,h in ((62,78,28,9),(48,62,19,8),(34,48,10,8)):
        ring(inner,outer,z,h)
    # Seven freestanding pillars follow the rear curve.
    for a in (-180,-150,-120,-90,-60,-30,0):
        theta=math.radians(a)
        x,y=70*math.cos(theta),70*math.sin(theta)
        xx,yy=p(x,y,28)
        d.rect((xx-4,yy-1,xx+4,yy+2),"gold")
        d.rect((xx-2.7,yy-27,xx+2.7,yy),"stone")
        d.rect((xx+.5,yy-27,xx+2.7,yy),"bronze")
        d.rect((xx-4,yy-30,xx+4,yy-27),"light")
        d.line([(xx-1,yy-23),(xx-1,yy-4)],"light",.7)
    top=[p(74*math.cos(math.radians(a)),74*math.sin(math.radians(a)),61) for a in range(-184,5,2)]
    bot=[p(66*math.cos(math.radians(a)),66*math.sin(math.radians(a)),61) for a in range(-184,5,2)]
    d.polygon(top+[(x,y+5) for x,y in top[::-1]],"gold")
    d.polygon(top+bot[::-1],"light")
    # Entrance staircase, tapering toward the shared floor.
    for y,w in ((164,31),(159,28),(154,25)):
        d.rect((96-w,y,96+w,y+3),"bronze")
        d.rect((96-w,y-2,96+w,y),"stone")
    for x in (49,143):
        d.rect((x-3,139,x+3,143),"bronze")
        d.rect((x-1,126,x+1,140),"gold")
        d.ellipse((x-3,123,x+3,128),"gold")
        spark(d,x,121,4)
    return d


def lantern():
    d=Drawing()
    def p(x,y,z=0): return (96+.81*(x-y),108+.36*(x+y)-.92*z)
    def face(points,c): d.polygon([p(*v) for v in points],c)
    def box(x0,y0,x1,y1,z0,z1,top="stone"):
        face([(x0,y1,z0),(x1,y1,z0),(x1,y1,z1),(x0,y1,z1)],"gold")
        face([(x1,y0,z0),(x1,y1,z0),(x1,y1,z1),(x1,y0,z1)],"bronze")
        face([(x0,y0,z1),(x1,y0,z1),(x1,y1,z1),(x0,y1,z1)],top)
    box(-53,-53,53,53,-7,-3,"bronze")
    box(-50,-50,50,50,-3,0,"stone")
    face([(-43,-43,.1),(44,-43,.1),(44,44,.1),(-43,44,.1)],"deep")
    # Tessellated open court; the center is walkable, not filled with a monument.
    for x in range(-30,39,12):
        for y in range(-30,39,12):
            face([(x,y,.2),(x+9,y,.2),(x+9,y+9,.2),(x,y+9,.2)],"teal" if (x+y)%24 else "water")
    # Two perpendicular arcades. Each bay has an actual curved intrados.
    for axis in (0,1):
        def q(t,z,depth=0): return (t,-41-depth,z) if axis==0 else (-41-depth,t,z)
        for t in (-40,-20,0,20,40):
            xx,yy,_=q(t,0)
            box(xx-3.5,yy-3.5,xx+3.5,yy+3.5,0,4,"light")
            box(xx-2.3,yy-2.3,xx+2.3,yy+2.3,4,36,"stone")
            box(xx-4,yy-4,xx+4,yy+4,34,38,"light")
        for t in (-30,-10,10,30):
            inner=[q(t+7*math.cos(math.radians(a)),23+9*math.sin(math.radians(a))) for a in range(0,181,5)]
            face([q(t-10,23),q(t-10,42),q(t+10,42),q(t+10,23)]+inner,"stone")
            # Dark inner soffit, then a narrow golden arch edge.
            d.line([p(*v) for v in inner],"gold",1.6)
        # Deep roof cornice with a copper standing-seam roof.
        face([q(-46,42,4),q(46,42,4),q(46,46,-4),q(-46,46,-4)],"gold")
        face([q(-46,46,-4),q(46,46,-4),q(46,51,3),q(-46,51,3)],"copper")
        for t in range(-42,46,7):
            d.line([p(*q(t,46,-4)),p(*q(t,51,3))],"bronze",.8)
    # Roof lantern at the rear meeting of the wings, light held inside glazing.
    box(-46,-46,-34,-34,47,52,"light")
    box(-43,-43,-37,-37,52,65,"flame")
    face([(-42,-35,54),(-36,-35,54),(-36,-35,64),(-42,-35,64)],"flame")
    face([(-35,-42,54),(-35,-36,54),(-35,-36,64),(-35,-42,64)],"gold")
    for x,y in ((-44,-44),(-36,-44),(-44,-36),(-36,-36)):
        box(x-.7,y-.7,x+.7,y+.7,52,66,"gold")
    face([(-47,-47,66),(-33,-47,66),(-40,-40,78)],"stone")
    face([(-33,-47,66),(-33,-33,66),(-40,-40,78)],"gold")
    face([(-33,-33,66),(-47,-33,66),(-40,-40,78)],"copper")
    tip=p(-40,-40,80); spark(d,*tip,3)
    # Foreground approach, with two warm lamps rather than a sealed courtyard.
    for a,z in ((53,-5),(58,-9),(63,-13)):
        box(22, a-5,50,a,z-3,z,"stone")
    for x,y in ((43,10),(10,43)):
        box(x-3,y-3,x+3,y+3,0,3,"gold")
        xx,yy=p(x,y,0)
        d.rect((xx-.8,yy-14,xx+.8,yy-1),"gold")
        spark(d,xx,yy-17,3.5)
    return d


def threshold():
    d=Drawing()
    # Broad stepped threshold and two freestanding, fluted pylons.
    for y,w in ((175,78),(169,72),(163,66),(157,60)):
        d.rect((96-w,y-4,96+w,y),"stone")
        d.rect((96-w,y,96+w,y+3),"bronze")
    # Receding interior arcade and a luminous path through the open portal.
    d.polygon([(60,152),(81,114),(111,114),(132,152)],"deep")
    for y in (123,132,141,149):
        w=(y-112)*.69+11
        d.line([(96-w,y),(96+w,y)],"teal",1.5)
    d.polygon([(91,114),(101,114),(109,152),(83,152)],"water")
    for outer,inner,cy in ((23,17,100),(16,11,106)):
        pts=arc(96,cy,outer,outer,180,360)+[(96+outer,127),(96+inner,127)]
        pts+=arc(96,cy,inner,inner,360,180)+[(96-inner,127),(96-outer,127)]
        d.polygon(pts,"bronze" if outer==23 else "gold")
    # Main arch is solid voussoirs, with depth on its outside right edge.
    def archband(dx,dy,color):
        pts=arc(96+dx,85+dy,54,54,180,360)+[(150+dx,154+dy),(132+dx,154+dy)]
        pts+=arc(96+dx,85+dy,36,36,360,180)+[(60+dx,154+dy),(42+dx,154+dy)]
        d.polygon(pts,color)
    archband(5,3,"bronze")
    archband(0,0,"stone")
    for a in range(195,360,15):
        theta=math.radians(a)
        d.line([(96+37*math.cos(theta),85+37*math.sin(theta)),
                (96+53*math.cos(theta),85+53*math.sin(theta))],"bronze",.9)
    d.polygon([(89,30),(103,30),(101,49),(91,49)],"light")
    for y in (96,113,130,147):
        for x in (42,132): d.line([(x,y),(x+18,y)],"bronze",.8)
    # Shoulder columns, layered capitals and hanging teal standards.
    for x in (37,155):
        d.rect((x-10,144,x+10,151),"gold")
        d.rect((x-7,84,x+7,144),"stone")
        d.rect((x+3,84,x+7,144),"bronze")
        for offset in (-3,0,3): d.line([(x+offset,91),(x+offset,139)],"gold",.8)
        d.rect((x-11,77,x+11,83),"light")
        d.rect((x-8,71,x+8,77),"gold")
        d.ellipse((x-5,66,x+5,72),"bronze")
        spark(d,x,61,5)
        innerx=x+12 if x<96 else x-12
        d.polygon([(innerx-3,90),(innerx+3,90),(innerx+3,119),(innerx,124),(innerx-3,119)],"teal")
    # A carved sunburst over the keystone, subordinate to the open doorway.
    d.ellipse((90,14,102,26),"gold")
    d.ellipse((93,17,99,23),"flame")
    for a in range(0,360,45):
        t=math.radians(a)
        d.line([(96+8*math.cos(t),20+8*math.sin(t)),
                (96+11*math.cos(t),20+11*math.sin(t))],"gold",1)
    return d


def encode(grid):
    size=len(grid)
    text=[]; cells=[]
    for cy in range(size//4):
        row=[]
        for cx in range(size//2):
            mask=0; colors=[]
            for dy in range(4):
                for dx in range(2):
                    c=grid[cy*4+dy][cx*2+dx]
                    if c is not None:
                        mask |= BITS[dy][dx]; colors.append(c)
            color=tuple(round(sum(c[k] for c in colors)/len(colors)) for k in range(3)) if colors else None
            cells.append((cx,cy,mask,color))
            row.append(chr(0x2800+mask))
        text.append("".join(row))
    return "\n".join(text)+"\n", cells


def render(cells,size,edge=16,pitch=5,shimmer=None):
    ss=2; wh=size*pitch+edge*2
    im=Image.new("RGBA",(wh*ss,wh*ss)); d=ImageDraw.Draw(im)
    for cx,cy,mask,color in cells:
        if not mask: continue
        gain=0 if shimmer is None else .20*math.exp(-((cx*2/size+cy*4/size*.4-shimmer)/.09)**2)
        rgb=tuple(min(255,round(v+(255-v)*gain)) for v in color)+(255,)
        for dy in range(4):
            for dx in range(2):
                if mask & BITS[dy][dx]:
                    # Uniform raster pitch; cells only group bits and colour.
                    x=edge+(cx*2+dx+.5)*pitch; y=edge+(cy*4+dy+.5)*pitch
                    r=pitch*.37
                    d.ellipse(tuple(round(v*ss) for v in (x-r,y-r,x+r,y+r)),fill=rgb)
    return im.resize((wh,wh),Image.Resampling.LANCZOS)


def on_dark(mark,width):
    mark=mark.resize((width,width),Image.Resampling.LANCZOS)
    out=Image.new("RGB",mark.size,BG); out.paste(mark,(0,0),mark)
    return out


def font(size,serif=False):
    choices=("C:/Windows/Fonts/georgia.ttf","/usr/share/fonts/truetype/dejavu/DejaVuSerif.ttf") if serif else ("C:/Windows/Fonts/segoeui.ttf","/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf")
    for path in choices:
        if Path(path).exists(): return ImageFont.truetype(path,size)
    return ImageFont.load_default(size=size)


def gif(name,cells,size):
    frames=[]
    for i in range(60):
        center=-.45+2.4*i/43 if i<43 else None
        # A native 3px pitch at 512px avoids resizing the animation's lattice.
        frames.append(on_dark(render(cells,size,pitch=3,shimmer=center),512))
    samples=Image.new("RGB",(128,128*60))
    for i,f in enumerate(frames):
        samples.paste(f.resize((128,128),Image.Resampling.NEAREST),(0,i*128))
    palette=samples.quantize(colors=255)
    q=[f.quantize(palette=palette,dither=Image.Dither.NONE) for f in frames]
    q[0].save(OUT/f"{name}.gif",save_all=True,append_images=q[1:],duration=80,loop=0,disposal=1,optimize=False)
    saved=Image.open(OUT/f"{name}.gif")
    saved.convert('RGB').save(OUT/f"{name}-gif-poster.png")
    elapsed=0
    for i in range(saved.n_frames):
        saved.seek(i); elapsed+=saved.info['duration']
    assert elapsed==4800 and saved.info['loop']==0
    strip=Image.new("RGB",(960,240),BG)
    for i,n in enumerate((0,12,24,36)):
        saved.seek(min(n,saved.n_frames-1))
        strip.paste(saved.convert('RGB').resize((240,240)),(i*240,0))
    strip.save(OUT/f"{name}-animation-check.png")


def main(animated=True):
    cases=(("council",council,"THE ASSEMBLY COURT","A circle of seats. An open way in."),
           ("lantern",lantern,"THE LANTERN COURT","A room still lit when you arrive."),
           ("threshold",threshold,"THE COMMON GATE","A monumental entrance, with depth beyond it."))
    sheet=Image.new("RGB",(1800,1190),BG); d=ImageDraw.Draw(sheet)
    d.text((68,45),"AGORA",font=font(46,True),fill=INK['light'])
    d.text((70,109),"ASTRA / META-WIZARD     ·     PLACES TO GATHER     ·     STUDIES 02",font=font(15),fill=(135,152,155))
    d.line((70,151,1730,151),fill=(41,58,63))
    checks={}
    for i,(name,builder,title,caption) in enumerate(cases):
        art=builder()
        for n,suffix in ((160,""),(96,"-compact")):
            grid=art.sampled(n); text,cells=encode(grid)
            lines=text.splitlines()
            assert len(lines)==n//4 and all(len(line)==n//2 for line in lines)
            for y in range(n):
                for x in range(n):
                    assert bool((ord(lines[y//4][x//2])-0x2800)&BITS[y%4][x%2]) == (grid[y][x] is not None)
            occupied=[(x,y) for y in range(n) for x in range(n) if grid[y][x] is not None]
            bounds=[min(x for x,y in occupied),min(y for x,y in occupied),max(x for x,y in occupied),max(y for x,y in occupied)]
            assert bounds[0]>0 and bounds[1]>0 and bounds[2]<n-1 and bounds[3]<n-1, (name,bounds)
            checks[name+suffix]={"cells":[n//2,n//4],"dots":len(occupied),"bounds":bounds,"edgeDots":0}
            (OUT/f"{name}{suffix}.txt").write_text(text,encoding="utf-8",newline="\n")
            png=render(cells,n); png.save(OUT/f"{name}{suffix}.png")
            colors=[[None]*(n//2) for _ in range(n//4)]
            for cx,cy,mask,color in cells: colors[cy][cx]=color
            assert all((colors[y][x] is None)==(lines[y][x]=='\u2800')
                       for y in range(n//4) for x in range(n//2))
            (OUT/f"{name}{suffix}.colors.json").write_text(json.dumps(colors,separators=(',',':'))+'\n',encoding='utf-8',newline='\n')
            if not suffix:
                sheet.paste(on_dark(png,540),(30+i*600,183))
                if animated: gif(name,cells,n)
            else:
                sheet.paste(on_dark(png,270),(165+i*600,838))
                # Purpose-built 300px tier: 96 dots * 3px + 12px padding.
                # No non-integral raster resize to beat against the dot lattice.
                on_dark(render(cells,n,edge=6,pitch=3),300).save(OUT/f"{name}-readme-300.png")
        d.text((300+i*600,742),f"0{i+1} / {title}",anchor="mt",font=font(21,True),fill=INK['light'])
        d.text((300+i*600,780),caption,anchor="mt",font=font(16),fill=(141,159,162))
        d.text((300+i*600,1120),"48 × 24 CELLS / INDEPENDENT SMALL STUDY",anchor="mt",font=font(12),fill=(120,142,148))
    d.line((70,1162,1730,1162),fill=(41,58,63))
    sheet.save(OUT/'studies.png')
    (OUT/'geometry-checks.json').write_text(json.dumps(checks,indent=2)+'\n',encoding='utf-8',newline='\n')
    print(json.dumps(checks,indent=2))


if __name__=='__main__':
    parser=argparse.ArgumentParser(); parser.add_argument('--stills-only',action='store_true')
    main(not parser.parse_args().stills_only)
