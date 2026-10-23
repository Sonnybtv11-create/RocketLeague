# TURBO PITCH — import the ATK kart (tools/blender/models/kart.blend) as a car skin.
# Run:  <python with bpy> tools/blender/import_kart.py [--target 30000] [--atlas 1024] [--preview out_prefix]
# Writes src/render/cars/kartMesh.js: the static body, every animated part (with its pivot), one wheel,
# and a baked colour atlas.
#
# The model is in metres, Blender axes (+X forward, +Y left, +Z up), ground at z = 0. As with the jeep,
# it keeps its own proportions: one uniform scale (K = 42 uu / m) puts it on the Octane hitbox's
# footprint (123 x 76 uu), centred on the hitbox; its wheels are drawn at its own axles.
#
# Materials are procedural (stripes, wear, noise), so after converting everything to meshes and
# decimating, all of it is UV-unwrapped into one atlas and its base colour is baked with Cycles. The
# game samples the atlas and swaps the blue parts to the team colour by hue (see skins.js).
#
# Parts that move in the game (src/render/cars/kartRig.js) are exported separately, positioned
# relative to their pivot: the two hanging charms, the flag on its whip pole, the llama bobble, the
# cooler and its lid, the propane tank, the axe, the pickaxe sign, the roof light bar, the steering
# wheel, both pedals and the four suspension springs.
import bpy, bmesh, math, sys, os, io, json, base64
from mathutils import Vector

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(os.path.dirname(HERE))
sys.path.insert(0, HERE)
import meshpack  # noqa: E402

SRC = os.path.join(HERE, 'models', 'kart.blend')
OUT = os.path.join(ROOT, 'src', 'render', 'cars', 'kartMesh.js')
arg = lambda k, d=None: sys.argv[sys.argv.index(k) + 1] if k in sys.argv else d
TARGET = int(arg('--target', 30000))       # triangle budget for body + parts
WHEEL_TARGET = int(arg('--wheel', 4000))
ATLAS = int(arg('--atlas', 1024))
PAINT_DENSITY = float(arg('--paint-density', 2.2))   # extra atlas resolution for the painted panels
PREVIEW = arg('--preview')

K = 42.0                                   # uu per metre
GROUND = -16.9                             # Octane model-space ground height (uu)
CX = 13.88 + 0.133 * K                     # bumpers span -1.6 .. 1.334 m: centre them on the hitbox centre
def to_game(p): return Vector((CX + p.x * K, p.y * K, GROUND + p.z * K))

bpy.ops.wm.open_mainfile(filepath=SRC, load_ui=False)
scene = bpy.context.scene

# ------------------------------------------------------------------ what goes where
WHEEL_PREFIX = ('Tyre ', 'Tread ', 'Rim ', 'Rim lip ', 'Hub ', 'Lug ')
SKIP = ('Cyclorama', 'Well cutter', 'Target')
def is_wheel(n): return n.startswith(WHEEL_PREFIX)
def is_wheel_fr(n): return is_wheel(n) and (n.endswith(' FR') or n.startswith('Lug FR'))

# part id, kind, pivot (Blender metres), axis (Blender, for hinges / steering), object-name rule
PARTS = [
    ('charm_tomato', 'pendulum', (0.7, 0.02, 1.932), None, lambda n: n == 'Charm string' or n.startswith('Tomato')),
    ('charm_burger', 'pendulum', (0.68, 0.16, 1.934), None, lambda n: n == 'Charm string.001' or n.startswith(('Bun ', 'Lettuce', 'Patty', 'Burger'))),
    ('flag', 'whip', (-1.55, -0.53, 0.38), None, lambda n: n == 'Flag pole'),
    ('flag_cloth', 'cloth', (-1.55, -0.53, 0.38), None, lambda n: n == 'Flag'),   # rides on the pole, turns into the wind
    ('llama', 'bobble', (1.425, 0.0, 0.947), None, lambda n: n.startswith('Llama') and n != 'Llama clamp'),
    ('cooler', 'cargo', (-1.24, 0.0, 0.85), None, lambda n: n == 'Cooler'),
    ('cooler_lid', 'lid', (-1.42, 0.0, 1.07), (0, 1, 0), lambda n: n == 'Cooler lid'),
    ('propane', 'roll', (-1.4, 0.0, 0.52), (0, 1, 0), lambda n: n in ('Propane tank', 'Tank valve')),
    ('axe', 'cargo', (-1.3, 0.54, 0.87), None, lambda n: n.startswith('Axe')),
    ('sign', 'swing', (-1.27, -0.56, 1.29), (1, 0, 0), lambda n: n == 'Pickaxe sign' or n.startswith('Sign pick')),
    ('lightbar', 'tilt', (0.385, 0.34, 2.116), (0, 1, 0), lambda n: n.startswith(('Light housing', 'Light bezel', 'Light lens', 'Reflector rib', 'Lens strap'))),
    ('steering', 'steer', (0.24, 0.26, 1.17), (-0.26, 0, 0.25), lambda n: n.startswith(('Steering wheel', 'Steering hub', 'Steering spoke'))),
    ('pedal_go', 'pedal', (0.452, 0.34, 0.44), (0, 1, 0), lambda n: n == 'Pedal GO'),
    ('pedal_stop', 'pedal', (0.452, 0.18, 0.44), (0, 1, 0), lambda n: n == 'Pedal STOP'),
]
for corner, (sx, sy) in (('FL', (1, 1)), ('FR', (1, -1)), ('RL', (-1, 1)), ('RR', (-1, -1))):
    top = (0.74 * sx if sx > 0 else -0.72, (0.42 if sx > 0 else 0.38) * sy, 0.62 if sx > 0 else 0.64)
    def rule(n, sx=sx, sy=sy):
        if not n.startswith(('Spring', 'Damper')): return False
        o = scene.objects[n]
        c = o.matrix_world @ (sum((Vector(b) for b in o.bound_box), Vector()) / 8)
        return (c.x > 0) == (sx > 0) and (c.y > 0) == (sy > 0)
    PARTS.append(('spring_' + corner, 'spring', top, None, rule))

# ------------------------------------------------------------------ material -> class (+ team role)
# class: how the game shades it. The colour itself comes from the baked atlas.
def mat_class(m):
    if m is None: return 'satin'
    n = m.name
    if n in ('Tail Amber',): return 'brake'
    if n in ('Headlight Glass', 'Headlight Rib', 'Lamp Lens Mesh'): return 'lamp'
    p = next((x for x in m.node_tree.nodes if x.type == 'BSDF_PRINCIPLED'), None) if m.node_tree else None
    metal = p.inputs['Metallic'].default_value if p else 0
    rough = p.inputs['Roughness'].default_value if p else 0.5
    if metal >= 0.5: return 'metal'
    if rough <= 0.32: return 'gloss'
    if rough >= 0.65: return 'matte'
    return 'satin'

# ------------------------------------------------------------------ convert everything to plain meshes
for o in list(scene.objects):
    if o.type in ('LIGHT', 'CAMERA', 'EMPTY') or o.name.startswith(SKIP):
        bpy.data.objects.remove(o, do_unlink=True)
for o in list(scene.objects):
    if is_wheel(o.name) and not is_wheel_fr(o.name):
        bpy.data.objects.remove(o, do_unlink=True)

bpy.ops.object.select_all(action='DESELECT')
for o in scene.objects:
    o.select_set(True)
bpy.context.view_layer.objects.active = next(iter(scene.objects))
bpy.ops.object.convert(target='MESH')     # applies modifiers (booleans, bevels, subsurf), curves, text

def tris(objs):
    n = 0
    for o in objs:
        o.data.calc_loop_triangles(); n += len(o.data.loop_triangles)
    return n

wheel_objs = [o for o in scene.objects if is_wheel_fr(o.name)]
part_of = {}
for o in scene.objects:
    if o in wheel_objs: continue
    for pid, kind, piv, axis, rule in PARTS:
        if rule(o.name): part_of[o.name] = pid; break
body_objs = [o for o in scene.objects if o not in wheel_objs]
print('objects', len(body_objs), 'tris', tris(body_objs), '| wheel', tris(wheel_objs))
for pid, *_ in PARTS:
    objs = [o for o in body_objs if part_of.get(o.name) == pid]
    print(f'  part {pid:14s} objects {len(objs):3d} tris {tris(objs)}')

# ------------------------------------------------------------------ decimate to budget
NO_DECIMATE = ('Flag',)                    # the flag cloth keeps its vertices: the game waves it
def decimate(objs, target, keep_small=300):
    total = tris(objs)
    big = [o for o in objs if len(o.data.loop_triangles) > keep_small and o.name not in NO_DECIMATE]
    small = total - sum(len(o.data.loop_triangles) for o in big)
    if total <= target or not big: return
    ratio = max(0.03, (target - small) / max(1, total - small))
    for o in big:
        m = o.modifiers.new('dec', 'DECIMATE'); m.decimate_type = 'COLLAPSE'; m.ratio = ratio; m.use_collapse_triangulate = True
        bpy.context.view_layer.objects.active = o
        bpy.ops.object.modifier_apply(modifier=m.name)
decimate(body_objs, TARGET)
decimate(wheel_objs, WHEEL_TARGET, keep_small=60)
print('after decimate: body', tris(body_objs), 'wheel', tris(wheel_objs))

# ------------------------------------------------------------------ one UV atlas for everything
allm = body_objs + wheel_objs
bpy.ops.object.select_all(action='DESELECT')
for o in allm:
    o.select_set(True)
    for uv in list(o.data.uv_layers): o.data.uv_layers.remove(uv)
    o.data.uv_layers.new(name='atlas')
bpy.context.view_layer.objects.active = allm[0]
bpy.ops.object.mode_set(mode='EDIT')
bpy.ops.mesh.select_all(action='SELECT')
bpy.ops.uv.smart_project(angle_limit=math.radians(60), island_margin=0.004, area_weight=0.0, scale_to_bounds=False)
bpy.ops.uv.average_islands_scale()          # same texel density everywhere...
bpy.ops.object.mode_set(mode='OBJECT')
# ...except the big painted panels (stripes, white body, roof), which get PAINT_DENSITY x the texels
PAINTED = ('ATK Body Paint', 'Roof White', 'Stripe Blue', 'Pale Blue', 'Steel Blue Plastic')
for o in allm:
    if any(sl.material and sl.material.name in PAINTED for sl in o.material_slots):
        for l in o.data.uv_layers['atlas'].data: l.uv *= PAINT_DENSITY
bpy.ops.object.mode_set(mode='EDIT')
bpy.ops.mesh.select_all(action='SELECT')
bpy.ops.uv.pack_islands(rotate=True, margin=0.002)
bpy.ops.object.mode_set(mode='OBJECT')

# ------------------------------------------------------------------ bake base colour
img = bpy.data.images.new('kart_atlas', ATLAS, ATLAS, alpha=False)
for m in bpy.data.materials:
    if not m.node_tree: continue
    n = m.node_tree.nodes.new('ShaderNodeTexImage'); n.image = img; n.name = 'BAKE'
    m.node_tree.nodes.active = n
scene.render.engine = 'CYCLES'
scene.cycles.samples = 4
scene.cycles.device = 'CPU'
bake = scene.render.bake
bake.use_pass_direct = False; bake.use_pass_indirect = False; bake.use_pass_color = True
bake.margin = 4
bpy.ops.object.bake(type='DIFFUSE', pass_filter={'COLOR'}, use_clear=True)
atlas_path = os.path.join(bpy.app.tempdir or '/tmp', 'kart_atlas.png')
img.filepath_raw = atlas_path; img.file_format = 'PNG'; img.save()
print('baked atlas', ATLAS)

# ------------------------------------------------------------------ export
SLOT = lambda o, m: (part_of.get(o.name, 'body')) + '.' + mat_class(m)
def slot_of_factory(o):
    return lambda m: (SLOT(o, m), (1, 1, 1))

UVQ = 65535
class _AllSlots:                          # every slot carries UVs (they all sample the atlas)
    def __contains__(self, k): return True

# body + parts: positions relative to the part pivot (game uu); pivots exported separately
pivots = {pid: to_game(Vector(piv)) for pid, kind, piv, axis, rule in PARTS}
def make_xform(o):
    pid = part_of.get(o.name)
    off = pivots[pid] if pid else Vector((0, 0, 0))
    return lambda p: to_game(p) - off
body = {}
for o in body_objs:
    s = meshpack.collect([o], slot_of_factory(o), make_xform(o), q=16, uv_slots=_AllSlots(), uvq=UVQ)
    for k, d in s.items():
        if k not in body: body[k] = {'v': {}, 'pos': [], 'nrm': [], 'col': [], 'uv': [], 'idx': []}
        M = body[k]; base = len(M['pos']) // 3
        M['pos'] += d['pos']; M['nrm'] += d['nrm']; M['col'] += d['col']; M['uv'] += d['uv']; M['idx'] += [i + base for i in d['idx']]
bhdr, bblob = meshpack.pack(body, q=16, uv_slots=_AllSlots(), uvq=UVQ)
print('body slots', {m['slot']: m['ni'] // 3 for m in bhdr['parts']}, 'bytes', len(bblob))

# wheel (front right): game wheel space radius 1, width 1, axle +Z, outer face +Z (= -Y in Blender)
pts = [o.matrix_world @ v.co for o in wheel_objs if o.name.startswith(('Tyre', 'Tread')) for v in o.data.vertices]
C = Vector(((min(p.x for p in pts) + max(p.x for p in pts)) / 2, (min(p.y for p in pts) + max(p.y for p in pts)) / 2, (min(p.z for p in pts) + max(p.z for p in pts)) / 2))
R = max(math.hypot(p.x - C.x, p.z - C.z) for p in pts)
W = max(p.y for p in pts) - min(p.y for p in pts)
print('wheel centre', tuple(round(c, 3) for c in C), 'radius', round(R, 3), 'width', round(W, 3))
def wheel_x(p):
    d = p - C
    return Vector((d.x / R, d.z / R, -(d.y) / W))
def wheel_n(n): return Vector((n.x * R, n.z * R, -n.y * W)).normalized()
def wheel_slot(o):
    def f(m):
        if o.name.startswith(('Tyre', 'Tread')): return 'tyre', (1, 1, 1)
        if o.name.startswith('Rim lip'): return 'lip', (1, 1, 1)
        return ('rim' if mat_class(m) == 'metal' else 'hub'), (1, 1, 1)
    return f
wheel = {}
for o in wheel_objs:
    s = meshpack.collect([o], wheel_slot(o), wheel_x, wheel_n, q=8192, uv_slots=_AllSlots(), uvq=UVQ)
    for k, d in s.items():
        if k not in wheel: wheel[k] = {'v': {}, 'pos': [], 'nrm': [], 'col': [], 'uv': [], 'idx': []}
        M = wheel[k]; base = len(M['pos']) // 3
        M['pos'] += d['pos']; M['nrm'] += d['nrm']; M['col'] += d['col']; M['uv'] += d['uv']; M['idx'] += [i + base for i in d['idx']]
whdr, wblob = meshpack.pack(wheel, q=8192, uv_slots=_AllSlots(), uvq=UVQ)
print('wheel slots', {m['slot']: m['ni'] // 3 for m in whdr['parts']}, 'bytes', len(wblob))

# atlas -> JPEG data URL
from PIL import Image
buf = io.BytesIO()
Image.open(atlas_path).convert('RGB').save(buf, 'JPEG', quality=88)
atlas_url = 'data:image/jpeg;base64,' + base64.b64encode(buf.getvalue()).decode()
print('atlas jpeg bytes', len(buf.getvalue()))

def axis_game(a):  # Blender direction -> game uu axes (uniform scale: direction unchanged)
    if a is None: return None
    v = Vector(a).normalized(); return [round(v.x, 4), round(v.y, 4), round(v.z, 4)]
parts_meta = [{'id': pid, 'kind': kind, 'pivot': [round(c, 2) for c in pivots[pid]], 'axis': axis_game(axis)} for pid, kind, piv, axis, rule in PARTS]
# flag: the cloth spans from the pole back to its tip; the rig waves it by distance from the pole
fl = scene.objects['Flag']
fpts = [to_game(fl.matrix_world @ v.co) - pivots['flag_cloth'] for v in fl.data.vertices]
flag_meta = {'xNear': round(max(p.x for p in fpts), 2), 'xFar': round(min(p.x for p in fpts), 2), 'zTop': round(max(p.z for p in fpts), 2), 'zBot': round(min(p.z for p in fpts), 2)}
info = {
    'parts': parts_meta, 'flag': flag_meta,
    'axles': [round(CX + 0.9 * K, 2), round(CX - 0.9 * K, 2)],
    # radius to the tread tips = hub height (front 0.305 m, rear 0.365 m); widths over the tread
    'wheelR': [round(0.305 * K, 2), round(0.365 * K, 2)], 'wheelW': [round(W * K, 2), round(0.362 * K, 2)],
    'trackY': round(0.72 * K, 2),
    # boost from the back, under the rear bumper (the tailpipes point sideways into the rear wheels)
    'nozzles': [[round(CX - 1.6 * K, 1), round(GROUND + 0.3 * K, 1), 0.0, 3.0]],
}
print(json.dumps(info, indent=1))
meshpack.write_module(OUT, '// GENERATED by tools/blender/import_kart.py from tools/blender/models/kart.blend — do not edit.\n'
                      '// ATK kart skin (Octane hitbox): body + animated parts (slot "<part>.<class>", positions relative to the\n'
                      '// part pivot, uu, Blender axes), one wheel (normalised) and the baked colour atlas.',
                      {'KART_MESH': (bhdr, bblob), 'KART_WHEEL': (whdr, wblob)})
with open(OUT, 'a') as f:
    f.write(f'export const KART_INFO = {json.dumps(info)};\n')
    f.write(f'export const KART_ATLAS = "{atlas_url}";\n')
print('wrote', OUT, os.path.getsize(OUT), 'bytes')

if PREVIEW:
    Image.open(atlas_path).save(PREVIEW + '-atlas.png')
