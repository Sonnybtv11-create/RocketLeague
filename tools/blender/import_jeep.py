# TURBO PITCH — import the classic Roblox jeep (tools/blender/models/jeep.blend) as a car skin.
# Run:  <python with bpy> tools/blender/import_jeep.py
# Writes src/render/cars/jeepMesh.js: body + one wheel (meshpack format, with UVs) and its textures.
#
# The model is in Roblox studs, Blender axes (+X forward, +Y left, +Z up), ground at z = 0, wheels
# r = 2 studs at x = 3.5 / -5.5, y = ±4. The skin keeps the jeep's own proportions: one uniform scale,
# K = 7 uu / stud, makes it 119 x 84 uu, the Octane hitbox's footprint (118 x 84), centred on the
# hitbox. Its wheels are drawn where the jeep has them (skins.js `tyre.x`), while the car still drives
# on the Octane's wheels.
import bpy, math, sys, os, io, base64
from mathutils import Vector

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(os.path.dirname(HERE))
sys.path.insert(0, HERE)
import meshpack  # noqa: E402

SRC = os.path.join(HERE, 'models', 'jeep.blend')
OUT = os.path.join(ROOT, 'src', 'render', 'cars', 'jeepMesh.js')

bpy.ops.wm.open_mainfile(filepath=SRC, load_ui=False)
scene = bpy.context.scene

K = 7.0                                    # uu per stud
CX = 13.88                                 # Octane hitbox centre x (uu); the jeep's bumpers span ±8.5 studs
GROUND = -16.9                             # Octane model-space ground height (uu), as for the Vector body

def to_game(p):
    return Vector((CX + p.x * K, p.y * K, GROUND + p.z * K))
for n, x in (('front', 3.5), ('rear', -5.5)):
    print(f'{n} axle x', round(CX + x * K, 2), 'uu; wheel centre height', round(GROUND + 2 * K, 2), 'radius', 2 * K, 'track ±', 4 * K)

# ------------------------------------------------------------------ materials -> slots
# wood:  Roblox "Wood" parts (part colour x wood grain texture)      plastic: smooth plastic parts
# *_team / *_team_dark: the green parts, drawn in the team colour (camo body -> team colour, earth
# green floor / seats / headlights -> dark team colour); their vertex colour is white.
# decal_grille / decal_roblox: the two decals (textured, alpha)
def part_colour(m):
    for n in m.node_tree.nodes:
        if n.type == 'MIX' and n.name == 'Part Colour': return tuple(n.inputs['B'].default_value[:3])
    for n in m.node_tree.nodes:
        if n.type == 'BSDF_PRINCIPLED': return tuple(n.inputs['Base Color'].default_value[:3])
    return (0.5, 0.5, 0.5)

def slot_of(m):
    if m is None: return 'plastic', (0.5, 0.5, 0.5)
    if m.name.startswith('Decal grille'): return 'decal_grille', (1, 1, 1)
    if m.name.startswith('Decal roblox'): return 'decal_roblox', (1, 1, 1)
    kind = 'plastic' if 'Plastic' in m.name else 'wood'
    if '(Camo)' in m.name: return kind + '_team', (1, 1, 1)
    if '(Earth green)' in m.name: return kind + '_team_dark', (1, 1, 1)
    return kind, part_colour(m)

UV_SLOTS = ('wood', 'wood_team', 'wood_team_dark', 'decal_grille', 'decal_roblox')
wheel_names = [o.name for o in scene.objects if o.name.startswith('Wheel_')]
body_objs = [o for o in scene.objects if o.type == 'MESH' and o.parent and o.parent.name == 'ClassicJeep' and o.name not in wheel_names]

# UV range (Roblox tiles its textures per stud, so UVs run past 1): pick the quantisation to fit
dg = bpy.context.evaluated_depsgraph_get()
umax = 1.0
for o in body_objs + [scene.objects[n] for n in wheel_names]:
    me = o.evaluated_get(dg).to_mesh()
    if me.uv_layers.active:
        for l in me.uv_layers.active.data: umax = max(umax, abs(l.uv.x), abs(l.uv.y))
        if min(min(l.uv.x, l.uv.y) for l in me.uv_layers.active.data) < -1e-4: raise ValueError(f'{o.name}: negative UVs')
    o.evaluated_get(dg).to_mesh_clear()
UVQ = int(65535 // math.ceil(umax))
print('uv max', round(umax, 2), 'uvq', UVQ)

body = meshpack.collect(body_objs, slot_of, to_game, q=64, uv_slots=UV_SLOTS, uvq=UVQ)
bhdr, bblob = meshpack.pack(body, q=64, uv_slots=UV_SLOTS, uvq=UVQ)
print('body', {m['slot']: m['ni'] // 3 for m in bhdr['parts']}, 'bytes', len(bblob))

# ------------------------------------------------------------------ wheel: front-right, normalised
# Game wheel space: radius 1 (= the jeep's 2 studs), width 1, axle +Z, outer face +Z. Front-right is the
# -Y side, so wheel-local (x, y, z) = (dx / R, dz / R, -dy / W). Side of the cylinder -> 'tyre', the two
# flat faces -> 'rim' (the game draws them as separate instanced meshes; both use the wood material).
w = scene.objects['Wheel_FrontRight']
me = w.evaluated_get(dg).to_mesh()
pts = [w.matrix_world @ v.co for v in me.vertices]
w.evaluated_get(dg).to_mesh_clear()
C = Vector(((min(p.x for p in pts) + max(p.x for p in pts)) / 2, (min(p.y for p in pts) + max(p.y for p in pts)) / 2, (min(p.z for p in pts) + max(p.z for p in pts)) / 2))
R = max(math.hypot(p.x - C.x, p.z - C.z) for p in pts)
W = max(p.y for p in pts) - min(p.y for p in pts)
print('wheel centre', tuple(round(c, 3) for c in C), 'radius', round(R, 3), 'width', round(W, 3), 'studs ->', round(W * K, 2), 'uu wide, centre y', round(C.y * K, 2))
def wheel_x(p):
    d = p - C
    return Vector((d.x / R, d.z / R, -d.y / W))
def wheel_n(n):
    return Vector((n.x * R, n.z * R, -n.y * W)).normalized()
def wheel_slot(m):
    return 'wheel', part_colour(m)
ws = meshpack.collect([w], wheel_slot, wheel_x, wheel_n, q=8192, uv_slots=('wheel',), uvq=UVQ)['wheel']
# split by normal: faces whose normal runs along the axle are the flat sides
tyre = {'v': {}, 'pos': [], 'nrm': [], 'col': [], 'uv': [], 'idx': []}
rim = {'v': {}, 'pos': [], 'nrm': [], 'col': [], 'uv': [], 'idx': []}
remap = {}
for t in range(0, len(ws['idx']), 3):
    tri = ws['idx'][t:t + 3]
    flat = all(abs(ws['nrm'][i * 3 + 2]) > 100 for i in tri)
    dst = rim if flat else tyre
    for i in tri:
        key = (id(dst), i)
        if key not in remap:
            remap[key] = len(dst['pos']) // 3
            dst['pos'] += ws['pos'][i * 3:i * 3 + 3]; dst['nrm'] += ws['nrm'][i * 3:i * 3 + 3]
            dst['col'].append(ws['col'][i]); dst['uv'] += ws['uv'][i * 2:i * 2 + 2]
        dst['idx'].append(remap[key])
whdr, wblob = meshpack.pack({'tyre': tyre, 'rim': rim}, q=8192, uv_slots=('tyre', 'rim'), uvq=UVQ)
print('wheel', {m['slot']: m['ni'] // 3 for m in whdr['parts']}, 'bytes', len(wblob))

# exhaust exit (boost nozzle), model axes [x, y up, z right, r]
ex = scene.objects['ExhaustPipe']
eb = [ex.matrix_world @ Vector(c) for c in ex.bound_box]
lo = Vector((min(p.x for p in eb), min(p.y for p in eb), min(p.z for p in eb))); hi = Vector((max(p.x for p in eb), max(p.y for p in eb), max(p.z for p in eb)))
g = to_game(Vector((lo.x, (lo.y + hi.y) / 2, (lo.z + hi.z) / 2)))
print('nozzle [x, up, right, r]:', [round(g.x, 1), round(g.z, 1), round(-g.y, 1), round((hi.z - lo.z) / 2 * K, 1)])

# ------------------------------------------------------------------ textures (data URLs)
def image_data_url(name, size=None, fmt='PNG', quality=85):
    from PIL import Image
    img = bpy.data.images[name]
    tmp = os.path.join(bpy.app.tempdir or '/tmp', 'jeep_' + name.replace('/', '_') + '.png')
    img.filepath_raw = tmp; img.file_format = 'PNG'; img.save()
    im = Image.open(tmp)
    if size: im = im.resize(size, Image.LANCZOS)
    buf = io.BytesIO()
    if fmt == 'JPEG': im.convert('RGB').save(buf, 'JPEG', quality=quality)
    else: im.save(buf, 'PNG', optimize=True)
    return f'data:image/{fmt.lower()};base64,' + base64.b64encode(buf.getvalue()).decode()

tex = {
    'wood': image_data_url('roblox_wood_color.png', (256, 256), 'JPEG', 82),
    'grille': image_data_url('grille.png'),
    'roblox': image_data_url('roblox.png'),
}
meshpack.write_module(OUT, '// GENERATED by tools/blender/import_jeep.py from tools/blender/models/jeep.blend — do not edit.\n'
                      '// Classic jeep skin (Octane hitbox): body + wheel in meshpack format (uu, Blender axes; wheel normalised)\n'
                      '// and its textures as data URLs.', {'JEEP_MESH': (bhdr, bblob), 'JEEP_WHEEL': (whdr, wblob)})
with open(OUT, 'a') as f:
    import json
    f.write(f'export const JEEP_TEX = {json.dumps(tex)};\n')
print('wrote', OUT, os.path.getsize(OUT), 'bytes')
