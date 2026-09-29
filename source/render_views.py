import bpy
from mathutils import Vector
from pathlib import Path
ROOT=Path(__file__).resolve().parents[1]
bpy.ops.wm.open_mainfile(filepath=str(ROOT/'OSCAR_master.blend'))
s=bpy.context.scene;c=s.camera;s.render.engine='CYCLES';s.cycles.samples=12;s.cycles.use_denoising=True;s.render.resolution_x=1200;s.render.resolution_y=1040;s.render.resolution_percentage=100
def render(name,loc,target,scale):
    c.location=loc;c.rotation_euler=(Vector(target)-c.location).to_track_quat('-Z','Y').to_euler();c.data.ortho_scale=scale;s.render.filepath=str(ROOT/'previews'/(name+'.png'));bpy.ops.render.render(write_still=True)
for args in [('01_exterior',(3.1,-5.8,2.7),(0,0,.92),2.85),('02_front',(0,-6,.9),(0,0,.9),2.45),('03_left',(-6,0,.9),(0,0,.9),2.18),('04_right',(6,0,.9),(0,0,.9),2.18),('05_back',(0,6,.9),(0,0,.9),2.45),('06_top',(0,0,6),(0,0,0),2.45)]:render(*args)
for o in bpy.data.collections['01_Exterior'].objects:o.hide_render=True
for args in [('07_interior',(.8,-2.5,2.25),(-.43,.015,1.20),1.5),('08_lab_deck',(-.43,-1.2,2.8),(-.43,0,1.03),1.30)]:render(*args)
print('FINAL VIEWS COMPLETE')
