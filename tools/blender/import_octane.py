# TURBO PITCH — import a hand-made Octane .blend (tools/blender/models/octane.blend) into the game.
# Run:  <python with bpy> tools/blender/import_octane.py [--target 26000] [--preview out_prefix]
# Writes src/render/cars/vectorMesh.js (body) and src/render/cars/vectorWheel.js (tyre + rim).
#
# The model is in metres, Blender axes (+X forward, +Y left, +Z up), ground at z = 0. Its wheel
# centres sit where the game's Octane wheels are (front r 12.5 uu, rear r 15 uu), so it is placed by
# matching the wheel centres to the game's rest pose. Materials are mapped to the game's slots by name.
import bpy, bmesh, math, sys, os, struct, base64, json
from mathutils import Vector, Matrix

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(os.path.dirname(HERE))
SRC = os.path.join(HERE, 'models', 'octane.blend')
OUT_BODY = os.path.join(ROOT, 'src', 'render', 'cars', 'vectorMesh.js')
OUT_WHEEL = os.path.join(ROOT, 'src', 'render', 'cars', 'vectorWheel.js')
arg = lambda k, d=None: sys.argv[sys.argv.index(k) + 1] if k in sys.argv else d
TARGET = int(arg('--target', 26000))       # body triangle budget
WHEEL_TARGET = int(arg('--wheel', 7000))   # tyre + rim triangle budget (instanced x4)

bpy.ops.wm.open_mainfile(filepath=SRC, load_ui=False)
scene = bpy.context.scene

# ------------------------------------------------------------------ material -> game slot (+ vertex colour)
def principled(m):
    if m and m.node_tree:
        for n in m.node_tree.nodes:
            if n.type == 'BSDF_PRINCIPLED': return n
    return None
def base_rgb(m):
    n = principled(m)
    return tuple(n.inputs['Base Color'].default_value[:3]) if n else (0.5, 0.5, 0.5)
SLOT = {
    'Paint_Primary_Blue': 'paint', 'Paint_Accent_Grey': 'accent',
    'Glass_Tinted': 'glass',
    'Trim_Black_Gloss': 'trim', 'Plastic_Black_Matte': 'trim', 'Window_Frame_Dark': 'trim',
    'Emit_Headlight': 'light', 'Emit_Taillight': 'light', 'Emit_Boost_Blue': 'glow',
    'Chrome': 'chrome', 'Metal_Steel': 'chrome', 'Metal_Gunmetal': 'chrome', 'Brass': 'chrome',
    'Rim_Silver': 'chrome', 'Trim_Grey': 'chrome', 'Paint_Red_Accent': 'chrome',
}
LIGHT_RGB = {'Emit_Headlight': (2.1, 2.2, 2.5), 'Emit_Taillight': (2.8, 0.06, 0.05)}
def slot_and_colour(m):
    name = m.name if m else 'Paint_Primary_Blue'
    slot = SLOT.get(name, 'trim')
    if slot == 'light': return slot, LIGHT_RGB.get(name, (2, 2, 2))
    if slot == 'chrome':
        r, g, b = base_rgb(m)
        if name == 'Trim_Grey': r, g, b = 0.3, 0.31, 0.34
        if name == 'Metal_Gunmetal': r, g, b = 0.16, 0.17, 0.19
        return slot, (r, g, b)
    return slot, (1, 1, 1)

# ------------------------------------------------------------------ placement: model wheel centres -> game rest pose (uu)
def wheel_centre(name):
    return scene.objects[name].matrix_world.translation
FL, RL = wheel_centre('Wheel_FL'), wheel_centre('Wheel_RL')
GAME_FX, GAME_RX = 51.25, -33.75          # game wheel hard-point x (uu)
GAME_FZ, GAME_RZ = -4.0, -2.3             # game rest wheel-centre heights (uu)
SX = 100.0
DX = ((GAME_FX - FL.x * SX) + (GAME_RX - RL.x * SX)) / 2
DZ = ((GAME_FZ - FL.z * SX) + (GAME_RZ - RL.z * SX)) / 2
print('placement: model FL', tuple(round(v * SX, 2) for v in FL), 'RL', tuple(round(v * SX, 2) for v in RL), 'shift', round(DX, 2), round(DZ, 2))
def to_game(p):            # Blender metres -> game uu, Blender axes
    return Vector((p.x * SX + DX, p.y * SX, p.z * SX + DZ))

# ------------------------------------------------------------------ split objects: wheel (one corner) vs body
SKIP = ('Studio',)
wheel_root = {'FL': scene.objects['Wheel_FL'], 'RL': scene.objects['Wheel_RL']}
wheel_children = {k: [c for c in v.children_recursive if c.type == 'MESH'] for k, v in wheel_root.items()}
in_wheels = set()
for k in ('Wheel_FL', 'Wheel_FR', 'Wheel_RL', 'Wheel_RR'):
    for c in scene.objects[k].children_recursive: in_wheels.add(c.name)
body_objs = [o for o in scene.objects if o.type == 'MESH' and o.name not in in_wheels and not o.name.startswith(SKIP)]

# reduce subdivision one level (shape is kept by the cage) before decimating
for o in scene.objects:
    for md in o.modifiers:
        if md.type == 'SUBSURF': md.levels = max(0, min(md.levels, md.render_levels) - 1)
        if md.type == 'BEVEL': md.segments = min(md.segments, 2)

def evaluated_tris(objs):
    dg = bpy.context.evaluated_depsgraph_get()
    n = 0
    for o in objs:
        me = o.evaluated_get(dg).to_mesh(); me.calc_loop_triangles(); n += len(me.loop_triangles); o.evaluated_get(dg).to_mesh_clear()
    return n

def decimate_to(objs, target):
    total = evaluated_tris(objs)
    if total <= target: return total
    ratio = target / total
    for o in objs:
        dm = o.modifiers.new('decimate', 'DECIMATE'); dm.decimate_type = 'COLLAPSE'; dm.ratio = max(0.05, ratio); dm.use_collapse_triangulate = True
    return evaluated_tris(objs)

print('body tris before', evaluated_tris(body_objs))
print('body tris after', decimate_to(body_objs, TARGET))

# ------------------------------------------------------------------ collect triangles per slot
def collect(objs, xform, normal_xform, q=64):
    dg = bpy.context.evaluated_depsgraph_get()
    slots = {}
    for o in objs:
        ev = o.evaluated_get(dg); me = ev.to_mesh(); me.calc_loop_triangles()
        M = o.matrix_world
        N3 = M.to_3x3().inverted().transposed()
        cn = me.corner_normals
        mats = list(o.material_slots)
        for lt in me.loop_triangles:
            if lt.area < 1e-10: continue        # collapsed by decimation
            m = mats[lt.material_index].material if mats and lt.material_index < len(mats) else None
            slot, col = slot_and_colour(m)
            d = slots.setdefault(slot, {'v': {}, 'pos': [], 'nrm': [], 'col': [], 'idx': []})
            tri = []
            for li in lt.loops:
                p = xform(M @ me.vertices[me.loops[li].vertex_index].co)
                n = Vector(cn[li].vector)
                if n.length < 1e-6: n = Vector(lt.normal)   # decimation can leave degenerate corner normals
                n = normal_xform((N3 @ n).normalized())
                key = (round(p.x * q), round(p.y * q), round(p.z * q), round(n.x * 100), round(n.y * 100), round(n.z * 100), col)
                k = d['v'].get(key)
                if k is None:
                    k = len(d['pos']) // 3; d['v'][key] = k
                    d['pos'] += [key[0], key[1], key[2]]
                    d['nrm'] += [max(-127, min(127, round(c * 127))) for c in (n.x, n.y, n.z)]
                    d['col'].append(col)
                tri.append(k)
            d['idx'] += tri
        ev.to_mesh_clear()
    return slots

def pack(slots, q=64):
    palette = [(1, 1, 1)]
    blob = bytearray(); meta = []
    for slot, d in slots.items():
        nv = len(d['pos']) // 3; ni = len(d['idx'])
        ci = []
        for c in d['col']:
            c = tuple(round(v, 3) for v in c)
            if c not in palette: palette.append(c)
            ci.append(palette.index(c))
        wide = nv > 65535
        meta.append({'slot': slot, 'nv': nv, 'ni': ni, 'off': len(blob), 'wide': wide})
        blob += struct.pack(f'<{nv * 3}h', *d['pos'])
        blob += struct.pack(f'<{nv * 3}b', *d['nrm'])
        blob += bytes(ci)
        while len(blob) % 4: blob.append(0)
        blob += struct.pack(f'<{ni}{"I" if wide else "H"}', *d['idx'])
        while len(blob) % 4: blob.append(0)
    return {'q': q, 'palette': palette, 'parts': meta}, bytes(blob)

# body: game uu, Blender axes (the game decoder maps to its model axes)
body = collect(body_objs, to_game, lambda n: n)
hdr, blob = pack(body)
with open(OUT_BODY, 'w') as f:
    f.write('// GENERATED by tools/blender/import_octane.py from tools/blender/models/octane.blend — do not edit.\n'
            '// Vector (Octane) body: quantised positions (uu * q, Blender axes x fwd / y left / z up), int8 normals,\n'
            '// colour palette index per vertex, per material slot.\n'
            f'export const VECTOR_MESH_META = {json.dumps(hdr)};\n'
            f'export const VECTOR_MESH_B64 = "{base64.b64encode(blob).decode()}";\n')
print('body slots', {m['slot']: m['ni'] // 3 for m in hdr['parts']}, 'bytes', len(blob))

# ------------------------------------------------------------------ wheel: front-right corner, normalised
# Game wheel geometry: radius 1, axle +Z (scaled by tyre width), rim face towards +Z (outer side of a
# right-hand wheel). Front-right in Blender is the -Y side, so wheel-local (x, y, z) = (x, z, -y).
wr = scene.objects['Wheel_FR']
C = wr.matrix_world.translation
wobjs = [c for c in wr.children_recursive if c.type == 'MESH' and not c.name.startswith(('Brake_',))]
for o in wobjs:
    for md in o.modifiers:
        if md.type == 'SUBSURF': md.levels = 0
tyre_objs = [o for o in wobjs if o.name.startswith('Tire')]
rim_objs = [o for o in wobjs if not o.name.startswith('Tire')]
decimate_to(tyre_objs, int(WHEEL_TARGET * 0.6)); decimate_to(rim_objs, int(WHEEL_TARGET * 0.4))
# extents for normalisation
dg = bpy.context.evaluated_depsgraph_get()
ys = []
R = 0.0
for o in tyre_objs:
    me = o.evaluated_get(dg).to_mesh()
    for v in me.vertices:
        p = o.matrix_world @ v.co - C
        ys.append(p.y); R = max(R, math.hypot(p.x, p.z))
    o.evaluated_get(dg).to_mesh_clear()
W = max(ys) - min(ys); YC = (max(ys) + min(ys)) / 2
print('wheel tread radius', round(R * 100, 2), 'uu, width', round(W * 100, 2), 'uu')
R = C.z     # nominal radius = hub height (ground is z = 0), so the game's wheel radius maps onto it exactly
def wheel_x(p):
    d = p - C
    return Vector((d.x / R, d.z / R, -(d.y - YC) / W))
def wheel_n(n):
    v = Vector((n.x * R, n.z * R, -n.y * W)); return v.normalized()   # inverse-transpose of the scale
wslots = {}
for name, objs in (('tyre', tyre_objs), ('rim', rim_objs)):
    s = collect(objs, wheel_x, wheel_n, q=8192)
    merged = {'v': {}, 'pos': [], 'nrm': [], 'col': [], 'idx': []}
    for d in s.values():
        base = len(merged['pos']) // 3
        merged['pos'] += d['pos']; merged['nrm'] += d['nrm']; merged['col'] += d['col']; merged['idx'] += [i + base for i in d['idx']]
    # colours for the rim (tyre uses its own material)
    wslots[name] = merged
whdr, wblob = pack(wslots, q=8192)
with open(OUT_WHEEL, 'w') as f:
    f.write('// GENERATED by tools/blender/import_octane.py from tools/blender/models/octane.blend — do not edit.\n'
            '// Octane wheel (front-right corner) normalised to radius 1 / width 1, axle +Z, rim face +Z.\n'
            f'export const VECTOR_WHEEL_META = {json.dumps(whdr)};\n'
            f'export const VECTOR_WHEEL_B64 = "{base64.b64encode(wblob).decode()}";\n')
print('wheel tris', {m['slot']: m['ni'] // 3 for m in whdr['parts']}, 'bytes', len(wblob))

def box_uu(name):
    o = scene.objects[name]
    pts = [to_game(o.matrix_world @ Vector(c)) for c in o.bound_box]
    lo = [min(q[i] for q in pts) for i in range(3)]
    hi = [max(q[i] for q in pts) for i in range(3)]
    return [round((a + b) / 2, 1) for a, b in zip(lo, hi)], [round(b - a, 1) for a, b in zip(lo, hi)]


for n in [o.name for o in scene.objects if 'Exhaust' in o.name or 'Boost' in o.name]:
    print('exhaust part', n, *box_uu(n))
