"""OSCAR-AI reference-based presentation model. Run with Blender --background --python.
X right, Y back, Z up, metres. Photo-derived geometry, not manufacturing CAD.
"""
import bpy, math, json, sys
from pathlib import Path
from mathutils import Vector

ROOT=Path(__file__).resolve().parents[1]
P=json.loads((ROOT/'source/parameters.json').read_text())
for folder in ('models','previews','reports'): (ROOT/folder).mkdir(exist_ok=True)
bpy.ops.object.select_all(action='SELECT');bpy.ops.object.delete(use_global=False)
for c in list(bpy.data.collections):
    if c.name!='Collection': bpy.data.collections.remove(c)
scene=bpy.context.scene
scene.unit_settings.system='METRIC';scene.unit_settings.scale_length=1
scene.render.engine='CYCLES';scene.cycles.samples=24
scene.cycles.use_denoising=True
scene.render.resolution_x=1500;scene.render.resolution_y=1300;scene.render.resolution_percentage=100
scene.render.image_settings.file_format='PNG';scene.render.film_transparent=False
scene.world.color=(.32,.32,.32)
scene.view_settings.view_transform='AgX'
scene.render.fps=P['fps'];scene.frame_start=1;scene.frame_end=P['cycle_seconds']*P['fps']+1

def coll(name):
    c=bpy.data.collections.new(name);scene.collection.children.link(c);return c
EXT=coll('01_Exterior');INT=coll('02_Work_Chamber');MOV=coll('03_Motion');STU=coll('90_Studio')
def root(name,c):
    o=bpy.data.objects.new(name,None);c.objects.link(o);return o
er=root('Exterior',EXT);ir=root('Interior',INT);mr=root('Motion',MOV)
def mat(name,color,metal=0,rough=.4,alpha=1):
    m=bpy.data.materials.new(name);m.diffuse_color=(*color,alpha);m.use_nodes=True
    n=m.node_tree.nodes.get('Principled BSDF');n.inputs['Base Color'].default_value=(*color,alpha);n.inputs['Metallic'].default_value=metal;n.inputs['Roughness'].default_value=rough;n.inputs['Alpha'].default_value=alpha
    if alpha<1:m.surface_render_method='DITHERED'
    return m
white=mat('Warm white powder coat',(.77,.795,.765),.08,.3)
blue=mat('Cobalt blue front fascia',(.003,.009,.135),.13,.29)
dark=mat('Graphite polymer',(.022,.027,.032),.13,.35)
steel=mat('Brushed stainless steel',(.49,.56,.59),.78,.29)
alum=mat('Satin aluminium',(.61,.66,.68),.65,.35)
black=mat('Gaskets and recesses',(.012,.017,.020),0,.6)
glass=mat('Lavender observation glazing',(.30,.32,.41),.18,.14,.32)
sideglass=mat('Frosted violet indicator window',(.27,.24,.32),.16,.34)
orange=mat('Orange end effector frame',(.76,.17,.025),.25,.32)
red=mat('Emergency stop red',(.57,.014,.018),.15,.25)
clear=mat('Clear lab polymer',(.72,.79,.79),.05,.18,.46)
ivory=mat('Labware off white',(.83,.84,.72),0,.35)
yellow=mat('Pale yellow tip rack',(.66,.72,.18),0,.4)
cyan=mat('Status light strip',(.41,.8,.85),.05,.2)
cyan.node_tree.nodes.get('Principled BSDF').inputs['Emission Color'].default_value=(.2,.7,.75,1)
cyan.node_tree.nodes.get('Principled BSDF').inputs['Emission Strength'].default_value=.5

def place(o,name,c,material,parent=None):
    o.name=name
    for cc in list(o.users_collection):cc.objects.unlink(o)
    c.objects.link(o)
    if material:o.data.materials.append(material)
    o.parent=parent or (er if c==EXT else ir if c==INT else mr if c==MOV else None)
    return o
def box(name,loc,dim,material=white,c=EXT,bevel=.005,parent=None):
    dx,dy,dz=[v/2 for v in dim]
    verts=[(-dx,-dy,-dz),(dx,-dy,-dz),(dx,dy,-dz),(-dx,dy,-dz),(-dx,-dy,dz),(dx,-dy,dz),(dx,dy,dz),(-dx,dy,dz)]
    faces=[(0,3,2,1),(4,5,6,7),(0,1,5,4),(1,2,6,5),(2,3,7,6),(3,0,4,7)]
    mesh=bpy.data.meshes.new(name);mesh.from_pydata(verts,[],faces);mesh.update()
    o=place(bpy.data.objects.new(name,mesh),name,c,material,parent);o.location=loc
    if bevel:
        m=o.modifiers.new('Manufactured edge radius','BEVEL');m.width=bevel;m.segments=3
        m=o.modifiers.new('Weighted surface normals','WEIGHTED_NORMAL')
    return o
def cyl(name,loc,r,depth,material,c=INT,parent=None,verts=24,axis='Z'):
    points=[(r*math.cos(2*math.pi*i/verts),r*math.sin(2*math.pi*i/verts),z) for z in [-depth/2,depth/2] for i in range(verts)]
    faces=[tuple(range(verts-1,-1,-1)),tuple(range(verts,2*verts))]+[(i,(i+1)%verts,(i+1)%verts+verts,i+verts) for i in range(verts)]
    mesh=bpy.data.meshes.new(name);mesh.from_pydata(points,[],faces);mesh.update()
    o=place(bpy.data.objects.new(name,mesh),name,c,material,parent);o.location=loc
    if axis=='Y':o.rotation_euler.x=math.pi/2
    if axis=='X':o.rotation_euler.y=math.pi/2
    for p in o.data.polygons:p.use_smooth=True
    return o
def curve(name,pts,r,material,c=EXT,parent=None):
    cu=bpy.data.curves.new(name,'CURVE');cu.dimensions='3D';cu.resolution_u=1;cu.bevel_depth=r;cu.bevel_resolution=2
    s=cu.splines.new('POLY');s.points.add(len(pts)-1)
    for p,co in zip(s.points,pts):p.co=(*co,1)
    o=bpy.data.objects.new(name,cu);c.objects.link(o);o.data.materials.append(material);o.parent=parent or (er if c==EXT else ir if c==INT else mr);return o
def rr(cx,cz,w,h,r,n=8):
    pts=[]
    for x,z,a in [(cx+w/2-r,cz+h/2-r,0),(cx-w/2+r,cz+h/2-r,90),(cx-w/2+r,cz-h/2+r,180),(cx+w/2-r,cz-h/2+r,270)]:
        for i in range(n):
            t=math.radians(a+90*i/(n-1));pts.append((x+r*math.cos(t),z+r*math.sin(t)))
    return pts
def panel(name,cx,cz,w,h,r,front,thick,material,c=EXT,hole=None):
    out=rr(cx,cz,w,h,r);loops=[out]
    if hole:loops.append(rr(*hole))
    verts=[(x,y,z) for y in (front,front+thick) for lp in loops for x,z in lp]
    n=len(out);stride=n*len(loops);faces=[]
    if hole:
        for i in range(n):
            j=(i+1)%n;faces += [(i,j,n+j,n+i),(stride+i,stride+n+i,stride+n+j,stride+j),(i,stride+i,stride+j,j),(n+i,n+j,stride+n+j,stride+n+i)]
    else:
        faces=[tuple(range(n-1,-1,-1)),tuple(range(n,2*n))]
        for i in range(n):j=(i+1)%n;faces.append((i,j,n+j,n+i))
    mesh=bpy.data.meshes.new(name);mesh.from_pydata(verts,[],faces);mesh.update()
    o=bpy.data.objects.new(name,mesh);c.objects.link(o);o.parent=er if c==EXT else ir;o.data.materials.append(material)
    bpy.context.view_layer.objects.active=o;o.select_set(True)
    # Mesh normals from polygon topology are recalculated for reliable glTF export.
    bpy.ops.object.select_all(action='DESELECT');o.select_set(True);bpy.ops.object.mode_set(mode='EDIT');bpy.ops.mesh.select_all(action='SELECT');bpy.ops.mesh.normals_make_consistent(inside=False);bpy.ops.object.mode_set(mode='OBJECT')
    return o
def text(name,words,loc,size,material=blue,c=EXT):
    cu=bpy.data.curves.new(name,'FONT');cu.body=words;cu.size=size;cu.align_x='CENTER';cu.align_y='CENTER';cu.extrude=.0002
    o=bpy.data.objects.new(name,cu);c.objects.link(o);o.location=loc;o.rotation_euler=(math.pi/2,0,0);o.parent=er if c==EXT else ir;cu.materials.append(material);return o
def decal(name,file,cx,cz,w,h,y):
    m=bpy.data.materials.new(name);m.use_nodes=True;bs=m.node_tree.nodes.get('Principled BSDF');tex=m.node_tree.nodes.new('ShaderNodeTexImage');tex.image=bpy.data.images.load(str(ROOT/'textures'/file));m.node_tree.links.new(tex.outputs['Color'],bs.inputs['Base Color']);m.node_tree.links.new(tex.outputs['Alpha'],bs.inputs['Alpha']);bs.inputs['Roughness'].default_value=.43;m.surface_render_method='DITHERED'
    verts=[(cx-w/2,y,cz-h/2),(cx+w/2,y,cz-h/2),(cx+w/2,y,cz+h/2),(cx-w/2,y,cz+h/2)]
    me=bpy.data.meshes.new(name);me.from_pydata(verts,[],[(0,1,2,3)]);me.uv_layers.new()
    for l,uv in zip(me.uv_layers.active.data,[(0,0),(1,0),(1,1),(0,1)]):l.uv=uv
    o=bpy.data.objects.new(name,me);EXT.objects.link(o);o.parent=er;me.materials.append(m);return o

# Exterior envelope: x +/-1.05, y +/-0.30, z 0..1.80.
box('Main_left_side',(-1.033,0,.936),(.034,.58,1.728))
box('Main_top',(-.43,0,1.778),(1.24,.60,.044),bevel=.012)
box('Main_back',(-.43,.285,.935),(1.24,.03,1.69))
box('Main_base',(-.43,0,.073),(1.24,.58,.048))
box('Right_cabinet_body',(.7075,.03,.936),(.685,.54,1.728),bevel=.018)
box('Vertical_divider',(.275,-.008,.928),(.164,.574,1.744),bevel=.009)
panel('Divider_vertical_window',.275,.615,.09,1.06,.025,-.300,.007,sideglass)
box('Main_left_front_stile',(-1.014,-.272,.94),(.072,.053,1.64),bevel=.01)
box('Main_right_front_stile',(.15,-.272,.94),(.074,.053,1.64),bevel=.008)
box('Front_top_crossbar',(-.43,-.271,1.757),(1.16,.056,.052),bevel=.009)
box('Front_lower_crossbar',(-.43,-.274,.827),(1.16,.052,.075),bevel=.006)
panel('Cobalt_fascia_with_window',-.43,1.314,1.12,.884,.05,-.292,.023,blue,hole=(-.43,1.106,.946,.365,.03))
panel('Observation_glass',-.43,1.106,.945,.364,.03,-.270,.006,glass)
decal('Window_wave_graphics','window_art.png',-.43,1.106,.932,.349,-.294)
panel('Status_strip',-.43,1.659,.922,.015,.007,-.295,.003,cyan)
decal('Aimingmed_brand','brand.png',-.43,1.535,.80,.219,-.295)
text('OSCAR_label','OSCAR-AI',(-.822,-.296,1.337),.026,white)
text('Robot_descriptor','Organoid Systematic Culture and Analysis Robot-AI',(-.215,-.296,1.337),.010,white)
# Horizontal split observed in the real front.
box('Upper_fascia_seam',(-.43,-.296,1.402),(1.114,.0015,.0018),black,bevel=0)
panel('Main_lift_handle_recess',-.43,.835,.125,.018,.008,-.302,.004,alum)
text('Lower_small_label','OSCAR-AI',(-.65,-.303,.828),.010,blue)
# Lower actual cabinet: narrow tank inspection door and sealed centre service doors.
panel('Lower_left_door',-.825,.437,.359,.703,.013,-.292,.023,white,hole=(-.842,.43,.225,.543,.025))
panel('Tank_inspection_glazing',-.842,.43,.223,.54,.023,-.278,.005,glass)
box('Visible_tank',(-.842,-.11,.41),(.194,.22,.49),ivory,bevel=.027)
panel('Tank_handle_slot',-.842,.661,.123,.026,.012,-.232,.005,black)
panel('Lower_service_upper',-.229,.612,.831,.354,.009,-.292,.023,white,hole=(-.19,.656,.543,.173,.021))
panel('Service_observation_glass',-.19,.656,.54,.169,.019,-.277,.006,glass)
for i in range(5):box('Service_internal_module_%02d'%i,(-.405+i*.108,-.14,.646),(.096,.17,.149),alum,bevel=.006)
box('Lower_service_left_door',(-.5,-.282,.267),(.287,.026,.365),bevel=.009)
box('Lower_service_right_door',(-.087,-.282,.267),(.526,.026,.365),bevel=.009)
for x,z in [(-.668,.39),(-.324,.25)]:
    box('Recessed_service_handle',(x,-.301,z),(.017,.009,.095),alum,bevel=.008)
    box('Handle_grip',(x,-.308,z),(.008,.008,.074),white,bevel=.003)
box('Lower_bottom_rail',(-.43,-.278,.092),(1.24,.035,.045),bevel=.004)
# Right display and door.
panel('Display_front_surround',.707,1.515,.655,.486,.018,-.295,.018,white)
panel('Blue_screen_bezel',.707,1.528,.581,.381,.026,-.299,.008,blue)
panel('Display_black_inner',.707,1.528,.542,.339,.012,-.301,.004,black)
decal('Screen_display','screen.png',.707,1.528,.533,.326,-.303)
cyl('Emergency_stop_mount',(.411,-.303,1.284),.013,.009,alum,EXT,axis='Y')
cyl('Emergency_stop_button',(.411,-.312,1.284),.0095,.014,red,EXT,axis='Y')
text('Emergency_stop_label','E-STOP',(.451,-.304,1.284),.009,dark)
panel('Right_lower_door',.707,.663,.663,1.139,.012,-.299,.026,white)
decal('Right_door_wave_brand','door_art.png',.702,.678,.626,1.07,-.301)
box('Right_door_handle',(.995,-.307,.72),(.011,.012,.83),white,bevel=.005)
# Rear and side evidence-supported ventilation and access panels.
for side in (-1,1):
    for i in range(25):
        box('Side_vent_%s_%02d'%(side,i),(side*1.050, -.18+i*.014,1.542),(.0018,.006,.10),dark,bevel=.001)
for x in [-.81,-.43,-.05,.66]:
    box('Rear_access_panel',(x,.302,.82),(.345 if x<.3 else .65,.006,1.48),white,bevel=.004)
for i in range(35):box('Rear_lower_vent_%02d'%i,(-.94+i*.026,.307,.21),(.01,.003,.095),dark,bevel=.001)
box('Left_power_service_box',(-1.051,.13,.21),(.008,.11,.09),dark,bevel=.004)
for x in [-.97,.10,.43,.97]:
    for y in [-.22,.22]:cyl('Levelling_foot',(x,y,.025),.026,.05,black,EXT)

# Interior working chamber, deliberately independent of exterior shell.
DECK=P['deck_height'];xmin=-.978;xmax=.115
box('Stainless_deck',(-.431,0,DECK-.018),(1.094,.518,.035),steel,INT,.006)
box('Chamber_back_wall',(-.431,.262,1.286),(1.094,.012,.77),steel,INT,.002)
box('Chamber_left_wall',(-.981,0,1.283),(.01,.52,.77),steel,INT,.002)
box('Chamber_right_wall',(.117,0,1.283),(.01,.52,.77),steel,INT,.002)
for i in range(68):
    for j in range(3):cyl('Rear_perforation_%02d_%d'%(i,j),(-.963+i*.016,.254,.935+j*.012),.0034,.0014,dark,INT,verts=8,axis='Y')
for x in [-.90,-.73,-.55,-.37,-.19,-.01]:
    box('Deck_track',(x,0,DECK+.002),(.006,.48,.004),dark,INT,.0005)
cols=[-.875,-.669,-.463,-.257,-.051];rows=[-.19,-.075,.04,.155]
stations=[]
def carrier(ci,ri):
    x,y=cols[ci],rows[ri];name='Station_%d_%d'%(ci+1,ri+1)
    box(name+'_carrier',(x,y,DECK+.008),(.145,.10,.014),dark,INT,.005)
    for dx in [-.065,.065]:
        for dy in [-.04,.04]:box(name+'_locator',(x+dx,y+dy,DECK+.019),(.009,.012,.014),black,INT,.001)
    stations.append({'name':name,'x':x,'y':y,'deck_z':DECK,'footprint':[.145,.10]})
    return x,y,name
def wells(name,x,y,z,nx,ny,material=ivory):
    # Common 127.8 x 85.5 mm footprint; preserve dimensions instead of compressing to fit.
    box(name+'_body',(x,y,z+.012),(.1278,.0855,.024),material,INT,.004)
    dx=.108/max(nx-1,1);dy=.065/max(ny-1,1)
    for i in range(nx):
        for j in range(ny):cyl(name+'_well_%d_%d'%(i,j),(x+(i-(nx-1)/2)*dx,y+(j-(ny-1)/2)*dy,z+.0245),.003 if nx==12 else .006,.0015,dark,INT,verts=12)
    return z+.024
for ci in range(5):
    for ri in range(4):
        x,y,n=carrier(ci,ri)
        if ci==0 and ri in (1,2):wells(n,x,y,DECK+.025,6,4,ivory)
        elif ci==1 and ri in (0,1):
            cyl(n+'_Petri_dish',(x,y,DECK+.025),.039,.013,clear)
            cyl(n+'_medium',(x,y,DECK+.022),.034,.003,ivory)
        elif ci==1 and ri==2:
            for k in range(3):wells(n+'_stack%d'%k,x,y,DECK+.018+k*.024,6,4,ivory)
        elif ci==2 and ri in (0,2,3):
            box(n+'_shallow_tray',(x,y,DECK+.03),(.128,.085,.016),alum,INT,.003)
            box(n+'_tray_insert',(x,y,DECK+.039),(.114,.07,.002),ivory,INT,.002)
        elif ci==2 and ri==1:
            box(n+'_tube_rack',(x,y,DECK+.04),(.128,.085,.05),dark,INT,.003)
            for i in range(6):
                for j in range(4):cyl(n+'_tube',(x+(i-2.5)*.018,y+(j-1.5)*.018,DECK+.069),.0055,.025,clear,verts=12)
        elif ci==3 and ri in (0,1,2):
            box(n+'_tipbox',(x,y,DECK+.044),(.128,.086,.065),ivory,INT,.004)
            wells(n+'_tips',x,y,DECK+.074,12,8,yellow if ri==2 else ivory)
        elif ci==4 and ri==0:wells(n,x,y,DECK+.024,6,4,ivory)
        elif ci==4 and ri==2:wells(n,x,y,DECK+.025,12,8,alum)
box('Far_right_instrument_cover',(.035,.194,DECK+.045),(.135,.075,.072),dark,INT,.004)
# Conservative support geometry: hidden drive assembly is schematic.
for x in [-.946,.078]:box('Motion_support_column',(x,.219,1.38),(.028,.035,.57),alum,INT,.003)
box('X_beam_support',(-.431,.221,1.633),(1.04,.055,.073),dark,INT,.004)
for z in [1.619,1.651]:cyl('X_guide_rail',(-.431,.181,z),.006,1.01,steel,INT,axis='X')
mx=root('Motion_X',MOV);mx.parent=mr
my=root('Motion_Y',MOV);my.parent=mx
mz=root('Motion_Z',MOV);mz.parent=my
box('X_carriage',(0,.173,1.622),(.155,.047,.096),alum,MOV,.004,mx)
box('Y_slide_body',(0,.018,1.638),(.09,.34,.035),dark,MOV,.003,mx)
for dx in [-.03,.03]:cyl('Y_guide_rail',(dx,.004,1.613),.004,.345,steel,MOV,mx,axis='Y')
box('Z_carriage_back',(0,.039,1.472),(.17,.042,.252),alum,MOV,.004,my)
box('Pipetting_head_black_body',(0,0,1.449),(.175,.127,.292),dark,MOV,.007,mz)
box('Pipetting_head_front_plate',(0,-.068,1.449),(.151,.013,.271),alum,MOV,.003,mz)
for z in [1.387,1.513]:box('Pipetting_head_dark_inset',(0,-.078,z),(.124,.01,.098),dark,MOV,.01,mz)
for i in range(8):
    x=(i-3.5)*.014
    cyl('Visible_needle_%02d'%i,(x,-.018,1.206),.0014,.186,steel,MOV,mz,verts=12)
    cyl('Needle_connector_%02d'%i,(x,-.018,1.300),.003,.019,alum,MOV,mz,verts=16)
    curve('Pipette_upper_tube_%02d'%i,[(x,.007,1.59),(x-.008,.002,1.616),(x-.025,-.025,1.62),(x-.024,-.044,1.586)],.0019,ivory,MOV,mz)
for sign in [-1,1]:
    # Orange side frames kept as separate parts; no unverified gripping action.
    x=sign*.107
    curve('Orange_frame_%s'%sign,[(x,.009,1.302),(x,-.056,1.192),(x,-.13,1.192),(x,-.069,1.302),(x,.009,1.302)],.008,orange,MOV,mz)
    cyl('Frame_mount_bolt_%s'%sign,(x,-.014,1.3),.0045,.023,steel,MOV,mz,axis='X')
for x in [-.064,.064]:
    for z in [1.343,1.558]:cyl('Head_face_bolt',(x,-.083,z),.003,.003,steel,MOV,mz,axis='Y',verts=12)
# 18-second illustrative motion. Needle rest tip is 1.113 m. Lowering 0.12 -> .993 m.
# Low target uses a shallow tray; lateral travel is always at the raised height.
keys=[(1,-.463,.155,0),(76,-.463,.04,0),(106,-.463,.04,-.12),(151,-.463,.04,-.12),(181,-.463,.04,0),(286,-.669,-.19,0),(316,-.669,-.19,-.12),(361,-.669,-.19,-.12),(391,-.669,-.19,0),(481,-.463,.155,0),(541,-.463,.155,0)]
for fr,x,y,z in keys:
    mx.location=(x,0,0);my.location=(0,y,0);mz.location=(0,0,z)
    for o in [mx,my,mz]:o.keyframe_insert(data_path='location',frame=fr,group='OSCAR_demo')
for o in [mx,my,mz]:
    a=o.animation_data.action;a.name=o.name+'_Demo'
    for strip in a.layers[0].strips:
        for bag in strip.channelbags:
            for f in bag.fcurves:
                for kp in f.keyframe_points:kp.interpolation='LINEAR'
    track=o.animation_data.nla_tracks.new();track.name='OSCAR_Demo_18s';track.strips.new('OSCAR_Demo_18s',1,a);o.animation_data.action=None
scene.frame_set(1)

# Metadata remains with the editable project and GLB custom properties.
er['source']='Front: 2026-09-29 real photograph; other faces: user five-view sheet'
ir['source']='Actual work-chamber image; close-up render only for component detail'
mr['motion_status']='Illustrative; not a calibrated hardware trajectory'
mz['visible_needle_count_is_unverified']=True
scene['dimensions_are_estimates']=True

# Normalize curves/text for glTF compatibility while retaining source script.
for o in list(EXT.objects)+list(INT.objects)+list(MOV.objects):
    if o.type in {'CURVE','FONT'}:
        bpy.ops.object.select_all(action='DESELECT');o.select_set(True);bpy.context.view_layer.objects.active=o;bpy.ops.object.convert(target='MESH')

# Export selection with the same shared world coordinate system.
def export(name,collections):
    bpy.ops.object.select_all(action='DESELECT')
    for c in collections:
        for o in c.objects:o.select_set(True)
    bpy.ops.export_scene.gltf(filepath=str(ROOT/'models'/name),export_format='GLB',use_selection=True,export_apply=True,export_animations=True,export_animation_mode='NLA_TRACKS',export_extras=True,export_cameras=False,export_lights=False)
export('OSCAR_full.glb',[EXT,INT,MOV]);export('OSCAR_exterior.glb',[EXT]);export('OSCAR_interior.glb',[INT,MOV])

# Studio only lives in the .blend, excluded from GLBs.
floor=box('Studio_floor',(0,0,-.014),(200,200,.02),mat('Studio white',(.74,.78,.80),0,.7),STU,.0)
def aim(o,target):o.rotation_euler=(Vector(target)-o.location).to_track_quat('-Z','Y').to_euler()
def area(name,loc,power,size,target):
    d=bpy.data.lights.new(name,'AREA');d.energy=power;d.shape='DISK';d.size=size;o=bpy.data.objects.new(name,d);STU.objects.link(o);o.location=loc;aim(o,target)
area('Key_softbox',(-3,-4,5),650,4,(0,0,.9));area('Fill_softbox',(4,-2,3),480,3,(0,0,1));area('Rim_softbox',(1,3,4),800,3,(0,0,1.2))
camera=bpy.data.cameras.new('Presentation_camera');cam=bpy.data.objects.new('Presentation_camera',camera);STU.objects.link(cam);scene.camera=cam;camera.type='ORTHO';camera.ortho_scale=2.85;cam.location=(3.1,-5.8,2.7);aim(cam,(0,0,.92))
for img in bpy.data.images:
    if img.source=='FILE':img.pack()
scene.frame_set(1)
bpy.ops.wm.save_as_mainfile(filepath=str(ROOT/'OSCAR_master.blend'))
manifest={'dimensions_estimated_m':[P['width'],P['depth'],P['height']],'station_footprint_m':[.145,.1],'labware_footprint_m':[.1278,.0855],'stations':stations,'animation_keyframes':keys,'collections':{c.name:[{'name':o.name,'type':o.type,'parent':o.parent.name if o.parent else None} for o in c.objects] for c in [EXT,INT,MOV]}}
(ROOT/'reports/model_manifest.json').write_text(json.dumps(manifest,indent=2),encoding='utf-8')
if '--skip-render' not in sys.argv:
    views=[('01_exterior', (3.1,-5.8,2.7),(0,0,.92),2.85),('02_front',(0,-6,.9),(0,0,.9),2.45),('03_left',(-6,0,.9),(0,0,.9),2.18),('04_right',(6,0,.9),(0,0,.9),2.18),('05_back',(0,6,.9),(0,0,.9),2.45),('06_top',(0,0,6),(0,0,0),2.45)]
    for name,loc,target,scale in views:
        cam.location=loc;aim(cam,target);camera.ortho_scale=scale;scene.render.filepath=str(ROOT/'previews'/(name+'.png'));bpy.ops.render.render(write_still=True)
    for o in EXT.objects:o.hide_render=True
    for name,loc,target,scale in [('07_interior',(.8,-2.5,2.25),(-.43,.015,1.20),1.5),('08_lab_deck',(-.43,-1.2,2.8),(-.43,0,1.03),1.30)]:
        cam.location=loc;aim(cam,target);camera.ortho_scale=scale;scene.render.filepath=str(ROOT/'previews'/(name+'.png'));bpy.ops.render.render(write_still=True)
print('OSCAR BUILD COMPLETE')
