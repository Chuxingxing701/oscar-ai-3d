import bpy,json,math
from pathlib import Path
from mathutils import Vector
ROOT=Path(__file__).resolve().parents[1]
bpy.ops.wm.open_mainfile(filepath=str(ROOT/'OSCAR_master.blend'))
s=bpy.context.scene
def bounds(o):
    p=[o.matrix_world@Vector(c) for c in o.bound_box]
    return [min(v[k] for v in p) for k in range(3)],[max(v[k] for v in p) for k in range(3)]
def gap(a,b):return [max(b[0][i]-a[1][i],a[0][i]-b[1][i]) for i in range(3)]
exterior=[o for o in bpy.data.collections['01_Exterior'].objects if o.type=='MESH']
allboxes=[bounds(o) for o in exterior]
lo=[min(b[0][k] for b in allboxes) for k in range(3)];hi=[max(b[1][k] for b in allboxes) for k in range(3)]
envelope=[hi[k]-lo[k] for k in range(3)]
assert all(abs(x-y)<.03 for x,y in zip(envelope,[2.1,.6,1.8])),envelope
deck=bpy.data.objects['Stainless_deck'];d=bounds(deck)
lab=[o for o in bpy.data.collections['02_Work_Chamber'].objects if o.name.startswith('Station_')]
assert all(bounds(o)[0][0]>=d[0][0]-.002 and bounds(o)[1][0]<=d[1][0]+.002 and bounds(o)[0][1]>=d[0][1]-.002 and bounds(o)[1][1]<=d[1][1]+.002 for o in lab),'Labware falls outside deck'
obstacles=[(o.name,bounds(o)) for o in lab]
moving=[o for o in bpy.data.collections['03_Motion'].objects if o.type=='MESH' and o.parent and o.parent.name=='Motion_Z']
collisions=[];minimum_clearance=100
for frame in range(1,542,3):
    s.frame_set(frame);bpy.context.view_layer.update()
    for o in moving:
        ob=bounds(o)
        for name,lb in obstacles:
            g=gap(ob,lb)
            if all(x<-.0002 for x in g):collisions.append([frame,o.name,name])
            if g[0]<0 and g[1]<0:minimum_clearance=min(minimum_clearance,g[2])
assert not collisions,collisions[:10]
s.frame_set(1)
start={n:tuple(bpy.data.objects[n].location) for n in ['Motion_X','Motion_Y','Motion_Z']}
s.frame_set(541)
end={n:tuple(bpy.data.objects[n].location) for n in start}
assert start==end,'Loop endpoints do not match'
report={'units':'m','measured_exterior_bounds_xyz':envelope,'bounds_min':lo,'bounds_max':hi,'requested_estimate':[2.1,.6,1.8],'bound_tolerance':.03,'labware_within_deck':True,'motion_sample_step_frames':3,'sampled_head_labware_intersections':collisions,'minimum_vertical_clearance_over_overlapping_labware':minimum_clearance,'loop_endpoints_match':True,'limits':'AABB clearance check covers modeled head and labware, not real hardware kinematics, invisible mechanisms or tubing flex.'}
# Fresh-import validation uses the actual distributed files.
for name in ['OSCAR_full.glb','OSCAR_exterior.glb','OSCAR_interior.glb']:
    bpy.ops.wm.read_factory_settings(use_empty=True)
    bpy.ops.import_scene.gltf(filepath=str(ROOT/'models'/name))
    meshes=[o for o in bpy.context.scene.objects if o.type=='MESH']
    assert meshes,name
    assert all(all(math.isfinite(v) for v in o.location) for o in meshes)
    if 'exterior' not in name:
        assert bpy.data.objects.get('Motion_Z') is not None
        animated=[o for o in bpy.context.scene.objects if o.animation_data]
        assert animated,'Animation lost on import'
    report[name]={'reimported_meshes':len(meshes),'objects':len(bpy.context.scene.objects),'materials':len(bpy.data.materials)}
(ROOT/'reports/model_validation.json').write_text(json.dumps(report,indent=2),encoding='utf-8')
print(json.dumps(report,indent=2))
