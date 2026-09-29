from PIL import Image, ImageDraw, ImageFont
from pathlib import Path
import math, os

ROOT=Path(__file__).resolve().parents[1]
OUT=ROOT/'textures'; OUT.mkdir(parents=True,exist_ok=True)
def resolve_font(env, candidates):
    for candidate in [os.environ.get(env, ''), *candidates]:
        if candidate and Path(candidate).is_file(): return candidate
    raise RuntimeError(f'Set {env} to a TrueType font path')
FONT=resolve_font('OSCAR_FONT', ['C:/Windows/Fonts/arial.ttf',
    '/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf',
    '/System/Library/Fonts/Supplemental/Arial.ttf'])
BOLD=resolve_font('OSCAR_BOLD_FONT', ['C:/Windows/Fonts/arialbd.ttf',
    '/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf',
    '/System/Library/Fonts/Supplemental/Arial Bold.ttf'])
def font(n,b=False): return ImageFont.truetype(BOLD if b else FONT,n)
def text(d,xy,s,n,fill,b=False): d.text(xy,s,font=font(n,b),fill=fill,anchor='mm')
def wave(d,box,count,color,reverse=False):
    x,y,w,h=box
    for k in range(count):
        pts=[]
        for j in range(160):
            t=j/159
            xx=x+w*t
            yy=y+h*(.12+.78/(1+math.exp(-9*(t-.48)))) + k*h*.022
            if reverse: yy=y+h-(yy-y)
            pts.append((xx,yy))
        d.line(pts,fill=color,width=2)

im=Image.new('RGBA',(2048,560));d=ImageDraw.Draw(im)
text(d,(1120,270),'AIMINGMED',138,(235,243,240,255))
cx,cy=575,270
for a in range(0,360,90):
    d.arc((cx-75,cy-75,cx+75,cy+75),a+12,a+75,fill='#e6efea',width=13)
    th=math.radians(a);d.line((cx+61*math.cos(th),cy+61*math.sin(th),cx+99*math.cos(th),cy+99*math.sin(th)),fill='#e6efea',width=10)
d.ellipse((cx-35,cy-35,cx+35,cy+35),outline='#e6efea',width=9)
im.save(OUT/'brand.png')

im=Image.new('RGBA',(1024,1600)); d=ImageDraw.Draw(im)
wave(d,(-100,200,930,800),17,(29,59,132,195),True)
wave(d,(520,360,620,740),16,(29,59,132,195),False)
d.rectangle((95,130,830,330),fill=(0,0,0,0))
text(d,(420,230),'OSCAR-',91,'#254682',True)
d.ellipse((645,156,801,312),fill='#24458d')
text(d,(723,236),'AI',85,'white',True)
im.save(OUT/'door_art.png')

im=Image.new('RGBA',(1800,640));d=ImageDraw.Draw(im)
wave(d,(-220,-270,850,640),15,(47,72,136,165))
wave(d,(1190,310,760,530),15,(47,72,136,165),True)
im.save(OUT/'window_art.png')

im=Image.new('RGB',(1280,760),'#e7edf0');d=ImageDraw.Draw(im)
d.rectangle((0,0,1280,75),fill='#123984');text(d,(220,38),'OSCAR-AI',34,'white',True)
text(d,(640,155),'Organoid culture & analysis',34,'#213b60',True)
for x,label,color in [(110,'CULTURE','#cee1e9'),(480,'ANALYSIS','#dbe0f0'),(850,'WORKFLOW','#d0e3de')]:
    d.rounded_rectangle((x,250,x+300,590),radius=20,fill=color)
    d.ellipse((x+75,310,x+225,460),outline='#6a90a6',width=7)
    text(d,(x+150,530),label,26,'#355773',True)
text(d,(640,680),'INTERFACE PLACEHOLDER',20,'#687f8e')
im.save(OUT/'screen.png')
reference=ROOT/'references/front.jpg'
if reference.exists():
    photo=Image.open(reference).convert('RGB')
    sx,sy=photo.width/1706,photo.height/1279
    points=[1158,164,1150,384,1543,382,1569,160]
    points=[v*(sx if i%2==0 else sy) for i,v in enumerate(points)]
    screen=photo.transform((1280,760),Image.Transform.QUAD,points,Image.Resampling.BICUBIC)
    screen.save(OUT/'screen.png')
print('Created four local decal textures')
