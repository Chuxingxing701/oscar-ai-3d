"""Recover original embedded textures and derive the scene map from the shipped GLB.

No Blender/Pillow required. Does not rewrite the GLB or editable master.
python3 source/prepare_scene_assets.py [--check]
"""
import hashlib
import json
import struct
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
blob = (ROOT / 'models/OSCAR_full.glb').read_bytes()
assert blob[:4] == b'glTF' and struct.unpack_from('<I', blob, 4)[0] == 2
length = struct.unpack_from('<I', blob, 12)[0]
gltf = json.loads(blob[20:20 + length])
binary = blob[28 + length:]
nodes = {n['name']: n for n in gltf['nodes']}
# Current export uses translation-only ancestors for all mapped objects. Fail on
# changed transforms rather than silently emitting incorrect world coordinates.
parents = {child: i for i, n in enumerate(gltf['nodes']) for child in n.get('children', [])}
indices = {n['name']: i for i, n in enumerate(gltf['nodes'])}


def center(name):
    i = indices[name]
    result = [0., 0., 0.]
    while True:
        n = gltf['nodes'][i]
        assert 'matrix' not in n and n.get('rotation', [0, 0, 0, 1]) == [0, 0, 0, 1]
        assert n.get('scale', [1, 1, 1]) == [1, 1, 1]
        result = [a + b for a, b in zip(result, n.get('translation', [0, 0, 0]))]
        if i not in parents:
            return [round(x, 7) for x in result]
        i = parents[i]


def write(path, data):
    path = ROOT / path
    if '--check' in sys.argv:
        assert path.read_bytes() == data, f'Stale asset: {path}'
    else:
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_bytes(data)


mapping = {
    'version': 1, 'device_id': 'oscar-01',
    'model': '../../models/OSCAR_full.glb',
    'model_sha256': hashlib.sha256(blob).hexdigest(),
    'coordinates': {'unit': 'm', 'up': '+Y', 'front': '+Z',
                    'blender_to_gltf': ['x', 'z', '-y'],
                    'well_numbering': 'column=i+1; row=A+(ny-1-j); A is far from operator'},
    'motion': {'root': 'Motion', 'x': 'Motion_X', 'y': 'Motion_Y', 'z': 'Motion_Z',
               'idle_clip': 'OSCAR_Demo_18s', 'home_m': [-.463, 0, -.155],
               'row_head': {'channels': 6, 'pitch_m': .0216, 'tip_height_m': 1.113,
                            'tip_depth_m': .018,
                            'source_needle_nodes': [f'Visible_needle_{i:02d}' for i in range(8)],
                            'note': 'Display head matches one full six-well row of the current 24-well plates.'},
               'lowering_m': .12},
    'stations': []
}
specs = [('plate-01', 'Station_1_2', 'plate', 6, 4),
         ('plate-02', 'Station_1_3', 'plate', 6, 4),
         ('media-01', 'Station_3_3', 'media', 0, 0),
         ('waste-01', 'Station_3_4', 'waste', 0, 0),
         *[(f'tips-0{i}', f'Station_4_{i}', 'tips', 12, 8) for i in range(1, 4)]]
for logical_id, prefix, kind, nx, ny in specs:
    anchor = prefix + ('_body' if kind == 'plate' else '_tray_insert' if not nx else '_tipbox')
    station = {'id': logical_id, 'kind': kind, 'prefix': prefix, 'anchor_node': anchor,
               'center_m': center(anchor),
               'nodes': sorted(n for n in nodes if n.startswith(prefix + '_'))}
    if nx:
        station.update({'columns': nx, 'rows': ny, 'wells': []})
        for j in range(ny - 1, -1, -1):
            for i in range(nx):
                name = f'{prefix}{"_tips" if kind == "tips" else ""}_well_{i}_{j}'
                station['wells'].append({'well_id': f'{chr(65 + ny - 1 - j)}{i+1}',
                                         'node': name, 'center_m': center(name)})
    mapping['stations'].append(station)
write('web/scene/scene-map.json', (json.dumps(mapping, indent=2, ensure_ascii=False) + '\n').encode())
for image in gltf['images']:
    assert image['mimeType'] == 'image/png'
    view = gltf['bufferViews'][image['bufferView']]
    start = view.get('byteOffset', 0)
    write(f'textures/{image["name"]}.png', binary[start:start + view['byteLength']])
print('Scene map: 7 stations, 48 culture wells, 288 tips; 4 original textures verified.'
      if '--check' in sys.argv else 'Scene map and 4 original embedded textures generated.')
