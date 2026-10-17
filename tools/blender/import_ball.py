# TURBO PITCH — import the hand-made ball .blend (tools/blender/models/ball.blend) into the game.
# Run:  <python with bpy> tools/blender/import_ball.py [--target 46000] [--print 9000] [--core-subdiv 5] [--preview out_prefix]
# Writes src/render/cars/ballMesh.js.
#
# The model is in metres, Blender axes (z up), centred on the origin, core radius ~0.912 m. It is scaled
# so the core radius equals the game's ball radius. The honeycomb core is a ~1M-face displaced mesh;
# the game draws it as a light sphere that keeps the model's UVs and redraws the honeycomb in the
# shader (the hex holes are laid out in UV space, see ball.js). Everything else is decimated.
import bpy, bmesh, math, sys, os
from mathutils import Vector
from mathutils.bvhtree import BVHTree
from mathutils.geometry import barycentric_transform

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(os.path.dirname(HERE))
sys.path.insert(0, HERE)
import meshpack  # noqa: E402
SRC = os.path.join(HERE, 'models', 'ball.blend')
OUT = os.path.join(ROOT, 'src', 'render', 'cars', 'ballMesh.js')
arg = lambda k, d=None: sys.argv[sys.argv.index(k) + 1] if k in sys.argv else d
TARGET = int(arg('--target', 46000))          # triangle budget for everything except the core
CORE_SUBDIV = int(arg('--core-subdiv', 5))    # icosphere subdivisions for the core (5 -> 5120 tris)
PREVIEW = arg('--preview')
BALL_RADIUS = 91.25                           # uu (contracts.js)

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
SLOT = {'Mesh_Core_Gunmetal': 'core', 'Print_White': 'print', 'Light_Lens': 'glow', 'Light_Pill': 'glow'}
def slot_and_colour(m):
    name = m.name if m else ''
    slot = SLOT.get(name, 'shell')
    if slot == 'glow': return slot, (1.0, 1.0, 1.0) if name == 'Light_Lens' else (0.7, 0.7, 0.7)
    return slot, base_rgb(m)

core = scene.objects['Ball_Core_Mesh']
parts = [o for o in scene.objects if o.type == 'MESH' and o is not core and not o.name.startswith('Studio')]

# core: the honeycomb sphere is an icosphere cage (82k tris) with subdivision + displacement. Replace
# it by a coarser icosphere at the same radius and carry the UVs over: each new triangle takes the UV
# map of the original face under its centre (extrapolated affinely), so triangles across a UV seam
# stay inside one island; elsewhere corners use the exact UV at their own position.
for md in list(core.modifiers): core.modifiers.remove(md)
src = core.data
src_uv = src.uv_layers.active.data
src_bvh = BVHTree.FromPolygons([v.co.copy() for v in src.vertices], [list(p.vertices) for p in src.polygons])
RC = sum(v.co.length for v in src.vertices) / len(src.vertices)
def face_uv(fi, p):
    poly = src.polygons[fi]
    vs = [src.vertices[i].co for i in poly.vertices]
    ts = [src_uv[li].uv.to_3d() for li in poly.loop_indices]
    return barycentric_transform(p, vs[0], vs[1], vs[2], ts[0], ts[1], ts[2]).to_2d()
bm = bmesh.new()
bmesh.ops.create_icosphere(bm, subdivisions=CORE_SUBDIV, radius=RC)
uvl = bm.loops.layers.uv.new('UVMap')
for f in bm.faces:
    c = f.calc_center_median()
    _, _, fi, _ = src_bvh.find_nearest(c)
    for l in f.loops:
        ex = face_uv(fi, l.vert.co)
        _, _, fj, _ = src_bvh.find_nearest(l.vert.co)
        own = face_uv(fj, l.vert.co)
        l[uvl].uv = own if (own - ex).length < 0.01 else ex
    f.smooth = True
newme = bpy.data.meshes.new('core_lod')
bm.to_mesh(newme); bm.free()
newme.materials.append(src.materials[0])
core.data = newme

def evaluated_tris(objs):
    dg = bpy.context.evaluated_depsgraph_get()
    n = 0
    for o in objs:
        me = o.evaluated_get(dg).to_mesh(); me.calc_loop_triangles(); n += len(me.loop_triangles); o.evaluated_get(dg).to_mesh_clear()
    return n

# small parts (lenses, vents, clips) are only lightly reduced so they keep their shape; the big ones
# (scale panels, print, armour) share the rest of the budget
# (scale panels, armour) share the rest of the budget; the lettering has its own budget
BIG, SMALL_RATIO, PRINT_TRIS = 3000, 0.4, int(arg('--print', 9000))
counts = {o.name: evaluated_tris([o]) for o in parts}
is_print = lambda o: o.name.startswith('Oval_Print')
before = sum(counts.values())
fixed = sum(n * SMALL_RATIO for k, n in counts.items() if n <= BIG) + sum(min(counts[o.name], PRINT_TRIS) for o in parts if is_print(o))
big = sum(counts[o.name] for o in parts if counts[o.name] > BIG and not is_print(o))
ratio = min(1.0, max(0.02, (TARGET - fixed) / big)) if big else 1.0
for o in parts:
    r = min(1.0, PRINT_TRIS / counts[o.name]) if is_print(o) else ratio if counts[o.name] > BIG else SMALL_RATIO
    if r < 1:
        dm = o.modifiers.new('decimate', 'DECIMATE'); dm.decimate_type = 'COLLAPSE'; dm.ratio = r; dm.use_collapse_triangulate = True
print('parts tris', before, '->', evaluated_tris(parts), '| core tris', evaluated_tris([core]))

S = BALL_RADIUS / (RC * core.matrix_world.to_scale().x)
print('core radius', round(RC, 4), 'm, scale', round(S, 3))

if PREVIEW:
    sc = scene
    for ob in sc.objects:
        if ob.name.startswith('Studio'): ob.hide_render = True
    sc.render.engine = 'BLENDER_WORKBENCH'
    sh = sc.display.shading
    sh.light = 'STUDIO'; sh.color_type = 'TEXTURE'; sh.show_cavity = True; sh.cavity_type = 'BOTH'
    sh.background_type = 'WORLD'; sc.world = sc.world or bpy.data.worlds.new('w'); sc.world.color = (0.19, 0.19, 0.19)
    sc.render.resolution_x = 800; sc.render.resolution_y = 800
    cam = bpy.data.objects.new('camx', bpy.data.cameras.new('camx')); sc.collection.objects.link(cam); sc.camera = cam
    cam.data.lens = 120
    for name, (az, el) in {'a': (20, 15), 'b': (100, 40)}.items():
        a, e = math.radians(az), math.radians(el)
        cam.location = 8.5 * Vector((math.cos(e) * math.cos(a), math.cos(e) * math.sin(a), math.sin(e)))
        cam.rotation_euler = (-cam.location).to_track_quat('-Z', 'Y').to_euler()
        sc.render.filepath = f'{PREVIEW}-{name}.png'
        bpy.ops.render.render(write_still=True)

# ------------------------------------------------------------------ export
# positions: uu, Blender axes (the game maps (x, y, z) -> (x, z, -y)); the core also carries its UVs
Q = 256
hdr, blob = meshpack.pack(meshpack.collect([core] + parts, slot_and_colour, lambda p: p * S, q=Q, uv_slots=('core',)), q=Q, uv_slots=('core',))
meshpack.write_module(OUT, '// GENERATED by tools/blender/import_ball.py from tools/blender/models/ball.blend — do not edit.\n'
                      '// Ball: quantised positions (uu * q, Blender axes x / y / z up), int8 normals, colour palette index\n'
                      '// per vertex, per material slot; the core slot also has uint16 UVs (uv * uvq).', {'BALL_MESH': (hdr, blob)})
print('slots', {m['slot']: m['ni'] // 3 for m in hdr['parts']}, 'bytes', len(blob))
