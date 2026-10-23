# TURBO PITCH — import the bacon-hair Roblox avatar (tools/blender/models/bacon_hair.glb, "Bacon Hair."
# by John Doe @mauimorehu on Sketchfab, CC BY 4.0) as the jeep's driver.
# Run:  <python with bpy> tools/blender/import_bacon.py [--preview out_prefix]
# Writes src/render/cars/baconMesh.js: the avatar split into Roblox's six R6 parts plus the hair
# accessory (meshpack format, uu, Blender axes, each part relative to its joint), its two textures
# and the joint / part data the driver rig needs.
#
# The model is one body mesh (an R15-style avatar with hands and shoes, 237 pieces) and one hair mesh,
# in studs, facing +Y, Z up. Each piece goes to the R6 part it sits in: head, torso, right / left arm,
# right / left leg. It is seated the way Roblox seats an R6 in a VehicleSeat: torso centre 1.5 studs
# above the seat top, over the seat's centre, facing forward; the jeep's driver seat is its
# "VehicleSeat" part (x -3.5..-0.5, y 0..3, top z 4 studs). Same scale and placement as the jeep
# (import_jeep.py): K = 7 uu per stud.
import bpy, bmesh, math, sys, os, io, base64, json
from mathutils import Vector

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(os.path.dirname(HERE))
sys.path.insert(0, HERE)
import meshpack  # noqa: E402

SRC = os.path.join(HERE, 'models', 'bacon_hair.glb')
OUT = os.path.join(ROOT, 'src', 'render', 'cars', 'baconMesh.js')
arg = lambda k, d=None: sys.argv[sys.argv.index(k) + 1] if k in sys.argv else d

for o in list(bpy.data.objects): bpy.data.objects.remove(o)
bpy.ops.import_scene.gltf(filepath=SRC)
body = next(o for o in bpy.data.objects if o.type == 'MESH' and o.data.materials[0].name == 'Rig1Mtl')
hair = next(o for o in bpy.data.objects if o.type == 'MESH' and o.data.materials[0].name == 'Handle1Mtl')

# same placement as the jeep (import_jeep.py)
K, CX, GROUND = 7.0, 13.88, -16.9
SEAT = Vector((-2.0, 1.5, 4.0))            # VehicleSeat: centre x / y, top z (studs)

# ------------------------------------------------------------------ split the body into R6 parts
bm = bmesh.new(); bm.from_mesh(body.data); bm.transform(body.matrix_world)
bm.verts.ensure_lookup_table(); bm.faces.ensure_lookup_table()
seen, islands = set(), []
for f in bm.faces:
    if f.index in seen: continue
    stack, isl = [f], []
    seen.add(f.index)
    while stack:
        x = stack.pop(); isl.append(x)
        for e in x.edges:
            for g in e.link_faces:
                if g.index not in seen: seen.add(g.index); stack.append(g)
    islands.append(isl)

vs = [v.co for v in bm.verts]
lo = Vector([min(c[i] for c in vs) for i in range(3)]); hi = Vector([max(c[i] for c in vs) for i in range(3)])
mid_x = (lo.x + hi.x) / 2
TORSO_HALF_W = 0.88                         # pieces centred further out than this are arms
NECK_Z, HIP_Z = 4.95, 2.95                  # pieces centred above / below are head / legs

def part_of(isl):
    c = sum((v.co for f in isl for v in f.verts), Vector()) / sum(len(f.verts) for f in isl)
    dx = c.x - mid_x
    if c.z > NECK_Z and abs(dx) < 0.75: return 'head'
    if abs(dx) > TORSO_HALF_W: return 'arm_r' if dx > 0 else 'arm_l'    # facing +Y: +X is the right
    if c.z < HIP_Z: return 'leg_r' if dx > 0 else 'leg_l'
    return 'torso'

faces_of = {}
for isl in islands:
    faces_of.setdefault(part_of(isl), []).extend(f.index for f in isl)

def bounds(idx):
    co = [v.co for i in idx for v in bm.faces[i].verts]
    return Vector([min(c[k] for c in co) for k in range(3)]), Vector([max(c[k] for c in co) for k in range(3)])
B = {p: bounds(i) for p, i in faces_of.items()}
for p, (a, b) in sorted(B.items()):
    print(f'{p:6s} {len(faces_of[p]):5d} faces  {tuple(round(x, 3) for x in a)} .. {tuple(round(x, 3) for x in b)}')

# R6 joints (model studs): neck at the torso top, shoulders 0.5 above the torso centre, hips at
# the torso bottom (all at the torso's depth centre)
tlo, thi = B['torso']
tc = (tlo + thi) / 2
neck = Vector((tc.x, tc.y, thi.z))
joints = {
    'torso': tc.copy(), 'head': neck, 'hair': neck,
    'arm_r': Vector((B['arm_r'][0].x, tc.y, tc.z + 0.5)), 'arm_l': Vector((B['arm_l'][1].x, tc.y, tc.z + 0.5)),
    'leg_r': Vector(((B['leg_r'][0].x + B['leg_r'][1].x) / 2, tc.y, tlo.z)), 'leg_l': Vector(((B['leg_l'][0].x + B['leg_l'][1].x) / 2, tc.y, tlo.z)),
}

# model studs (facing +Y, right +X) -> jeep studs (Blender axes: +X forward, +Y left), torso centre
# 1.5 studs over the seat top -> game uu
OFF = Vector((SEAT.x, SEAT.y, SEAT.z + 1.5))
def to_jeep(p):
    d = p - tc
    return Vector((d.y, -d.x, d.z)) + OFF
def to_game(p):
    j = to_jeep(p)
    return Vector((CX + j.x * K, j.y * K, GROUND + j.z * K))
def n_jeep(n):
    return Vector((n.y, -n.x, n.z))

# one object per part (faces moved out of the body mesh)
part_objs = {}
for p, idx in faces_of.items():
    b2 = bm.copy(); b2.faces.ensure_lookup_table()
    keep = set(idx)
    bmesh.ops.delete(b2, geom=[f for f in b2.faces if f.index not in keep], context='FACES')
    me = bpy.data.meshes.new('r6_' + p); b2.to_mesh(me); b2.free()
    for m in body.data.materials: me.materials.append(m)
    ob = bpy.data.objects.new('r6_' + p, me); bpy.context.scene.collection.objects.link(ob)
    part_objs[p] = ob
part_objs['hair'] = hair

# ------------------------------------------------------------------ export
UVQ = 65535
slots, info = {}, []
for p, ob in part_objs.items():
    J = to_game(joints[p])
    cls = 'hair' if p == 'hair' else 'r6'
    s = meshpack.collect([ob], lambda m, p=p, cls=cls: (f'{p}.{cls}', (1, 1, 1)),
                         lambda q, J=J: to_game(q) - J, n_jeep, q=64, uv_slots=(f'{p}.{cls}',), uvq=UVQ)
    slots.update(s)
    # part box in game uu (Blender axes), relative to the joint: the rig's falling-apart physics
    pts = [to_game(ob.matrix_world @ v.co) - J for v in ob.data.vertices]
    a = Vector([min(q[k] for q in pts) for k in range(3)]); b = Vector([max(q[k] for q in pts) for k in range(3)])
    info.append({'id': p, 'pivot': [round(c, 2) for c in J], 'box': [[round(c, 2) for c in a], [round(c, 2) for c in b]]})
hdr, blob = meshpack.pack(slots, q=64, uv_slots=tuple(slots), uvq=UVQ)
print('parts', {m['slot']: m['ni'] // 3 for m in hdr['parts']}, 'bytes', len(blob))

def image_data_url(img, fmt='PNG', quality=90):
    from PIL import Image
    tmp = os.path.join(bpy.app.tempdir or '/tmp', 'bacon_' + img.name + '.png')
    img.filepath_raw = tmp; img.file_format = 'PNG'; img.save()
    im = Image.open(tmp); buf = io.BytesIO()
    if fmt == 'JPEG': im.convert('RGB').save(buf, 'JPEG', quality=quality)
    else: im.save(buf, 'PNG', optimize=True)
    return f'data:image/{fmt.lower()};base64,' + base64.b64encode(buf.getvalue()).decode()
def tex_of(ob):
    return next(n.image for n in ob.data.materials[0].node_tree.nodes if n.type == 'TEX_IMAGE' and n.image)
tex = {'body': image_data_url(tex_of(body)), 'hair': image_data_url(tex_of(hair), 'JPEG', 88)}

meshpack.write_module(OUT, '// GENERATED by tools/blender/import_bacon.py from tools/blender/models/bacon_hair.glb — do not edit.\n'
                      '// "Bacon Hair." by John Doe (@mauimorehu), Sketchfab, CC BY 4.0: the jeep\'s driver as six R6 parts + hair\n'
                      '// (uu, Blender axes, each relative to its joint), seated in the jeep\'s VehicleSeat.', {'BACON_MESH': (hdr, blob)})
with open(OUT, 'a') as f:
    f.write(f'export const BACON_INFO = {json.dumps({"parts": info})};\n')
    f.write(f'export const BACON_TEX = {json.dumps(tex)};\n')
print('wrote', OUT, os.path.getsize(OUT), 'bytes')
for p in info: print(p)
