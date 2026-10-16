# TURBO PITCH — Vector (Octane-class) body, built procedurally in Blender (bpy).
# Run:  <python with bpy> tools/blender/octane_build.py [--blend out.blend]
# Writes src/render/cars/vectorMesh.js (compact quantised mesh, decoded by the game).
#
# Units: Unreal units. Blender axes: +X forward, +Y left, +Z up; origin = car centre of mass
# (same as the sim / hitbox frame). The game maps (x, y, z) -> model (x, z, -y) and scales by 0.01.
# Every part is a low-poly control cage (rings of cross-section points) smoothed by a Subdivision
# Surface modifier, with edge creases on hard edges, plus bevelled primitives for mechanical parts.
import bpy, bmesh, math, sys, os, struct, base64, json
from mathutils import Vector, Matrix

ROOT = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
OUT_JS = os.path.join(ROOT, 'src', 'render', 'cars', 'vectorMesh.js')

bpy.ops.wm.read_factory_settings(use_empty=True)
scene = bpy.context.scene
ORIGIN = bpy.data.objects.new('origin', None); scene.collection.objects.link(ORIGIN)

# ------------------------------------------------------------------ materials (name = game slot[:variant])
MATS = {}
def mat(name, rgb):
    m = bpy.data.materials.new(name)
    m.diffuse_color = (*rgb, 1)
    m.node_tree.nodes['Principled BSDF'].inputs['Base Color'].default_value = (*rgb, 1)
    MATS[name] = m
    return m
for n, c in [('paint', (0.05, 0.25, 1.0)), ('trim', (0.04, 0.04, 0.05)), ('accent', (0.9, 0.9, 0.9)),
             ('glass', (0.01, 0.01, 0.02)), ('light:head', (1, 1, 1)), ('light:tail', (1, 0, 0)),
             ('light:amber', (1, 0.5, 0)), ('chrome', (0.8, 0.8, 0.8)), ('chrome:red', (0.8, 0.05, 0.04)),
             ('chrome:dark', (0.3, 0.3, 0.33)), ('glow', (0.2, 0.6, 1))]:
    mat(n, c)

def link(obj):
    scene.collection.objects.link(obj)
    return obj

def set_mats(me, names):
    for n in names: me.materials.append(MATS[n])

# ------------------------------------------------------------------ cage builder
def cage(name, rings, *, mirror=False, mirror_offset=0.0, faces_mat=None, crease_long=(), crease_ring=(),
         cap=(True, True), subdiv=2, mats=('paint',), bevel=0.0, smooth=True, closed=False):
    """rings: list of (x, [(y, z), ...]) — same point count per ring.
    open profile (closed=False): points run from one edge to the other (e.g. bottom centre -> top centre);
    closed=True: a closed loop.  faces_mat(i, j) -> material name for the quad between ring i..i+1, point j..j+1.
    crease_long: point indices creased along the length; crease_ring: ring indices creased around."""
    bm = bmesh.new()
    crease = bm.edges.layers.float.get('crease_edge') or bm.edges.layers.float.new('crease_edge')
    V = []
    for x, pts in rings:
        V.append([bm.verts.new((x, y, z)) for y, z in pts])
    n = len(rings[0][1])
    segs = n if closed else n - 1
    mi = {m: k for k, m in enumerate(mats)}
    for i in range(len(rings) - 1):
        for j in range(segs):
            j2 = (j + 1) % n
            f = bm.faces.new((V[i][j], V[i + 1][j], V[i + 1][j2], V[i][j2]))
            f.material_index = mi[faces_mat(i, j) if faces_mat else mats[0]]
    if cap[0]:
        f = bm.faces.new(list(reversed(V[0]))); f.material_index = mi[faces_mat(-1, -1) if faces_mat else mats[0]] if faces_mat else 0
    if cap[1]:
        f = bm.faces.new(V[-1]); f.material_index = mi[faces_mat(-2, -2) if faces_mat else mats[0]] if faces_mat else 0
    bm.normal_update()
    # creases
    for j in crease_long:
        for i in range(len(rings) - 1):
            e = bm.edges.get((V[i][j], V[i + 1][j]))
            if e: e[crease] = 1.0; e.smooth = False
    for i in crease_ring:
        for j in range(segs):
            e = bm.edges.get((V[i][j], V[i][(j + 1) % n]))
            if e: e[crease] = 1.0; e.smooth = False
    bmesh.ops.recalc_face_normals(bm, faces=bm.faces)
    me = bpy.data.meshes.new(name)
    bm.to_mesh(me); bm.free()
    set_mats(me, mats)
    ob = link(bpy.data.objects.new(name, me))
    if mirror:
        md = ob.modifiers.new('mirror', 'MIRROR'); md.use_axis = (False, True, False); md.mirror_object = ORIGIN
        md.use_clip = mirror_offset == 0.0; md.use_mirror_merge = mirror_offset == 0.0
    if subdiv:
        sd = ob.modifiers.new('subd', 'SUBSURF'); sd.levels = subdiv; sd.render_levels = subdiv
    if bevel:
        bv = ob.modifiers.new('bevel', 'BEVEL'); bv.width = bevel; bv.segments = 2; bv.limit_method = 'ANGLE'
    if smooth:
        for p in me.polygons: p.use_smooth = True
    return ob

def box(name, size, loc, rot=(0, 0, 0), mat_name='trim', bevel=0.6, segs=2, mirror=False):
    bm = bmesh.new()
    bmesh.ops.create_cube(bm, size=1.0)
    bmesh.ops.scale(bm, vec=Vector(size), verts=bm.verts)
    me = bpy.data.meshes.new(name); bm.to_mesh(me); bm.free()
    set_mats(me, [mat_name])
    ob = link(bpy.data.objects.new(name, me))
    ob.location = loc; ob.rotation_euler = rot
    if bevel:
        bv = ob.modifiers.new('bevel', 'BEVEL'); bv.width = bevel; bv.segments = segs; bv.harden_normals = True
    if mirror:
        md = ob.modifiers.new('mirror', 'MIRROR'); md.use_axis = (False, True, False); md.mirror_object = ORIGIN
    for p in me.polygons: p.use_smooth = True
    return ob

def cyl(name, r, depth, loc, rot=(0, 0, 0), mat_name='chrome', segs=20, bevel=0.3, mirror=False, r2=None):
    bm = bmesh.new()
    bmesh.ops.create_cone(bm, cap_ends=True, segments=segs, radius1=r, radius2=r if r2 is None else r2, depth=depth)
    me = bpy.data.meshes.new(name); bm.to_mesh(me); bm.free()
    set_mats(me, [mat_name])
    ob = link(bpy.data.objects.new(name, me))
    ob.location = loc; ob.rotation_euler = rot
    if bevel:
        bv = ob.modifiers.new('bevel', 'BEVEL'); bv.width = bevel; bv.segments = 2; bv.limit_method = 'ANGLE'; bv.harden_normals = True
    if mirror:
        md = ob.modifiers.new('mirror', 'MIRROR'); md.use_axis = (False, True, False); md.mirror_object = ORIGIN
    for p in me.polygons: p.use_smooth = True
    return ob

def lerp_table(tab, x):
    if x <= tab[0][0]: return tab[0][1]
    for (x0, v0), (x1, v1) in zip(tab, tab[1:]):
        if x <= x1:
            t = (x - x0) / (x1 - x0); t = t * t * (3 - 2 * t)
            return v0 + (v1 - v0) * t
    return tab[-1][1]

# ------------------------------------------------------------------ wheel layout (visual, matches the game)
WF = dict(x=51.25, y=25.9, z=-4.0, r=12.5)   # front: centre (hard point - rest suspension), visual track
WB = dict(x=-33.75, y=29.5, z=-2.3, r=15.0)
# wheel centres in the blueprint pose (the body is measured in this frame; in game the wheels hang lower)
WFB = dict(WF, z=0.7)
WBB = dict(WB, z=4.9)
def arch(x, w, clr):
    R = w['r'] + clr
    dx = x - w['x']
    return w['z'] + math.sqrt(R * R - dx * dx) if abs(dx) < R else -1e9

# ------------------------------------------------------------------ body parts, dimensioned from the blueprint (tools/blender/blueprint.py)
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import numpy as np
CUTTERS = set()

# tub: mirrored half sections, bottom centre -> top centre
TUB_X = [-50, -47, -42, -34, -26, -18, -10, -2, 6, 14, 22, 30, 36, 42, 48, 54, 60, 65, 69, 72.5]
TT = {
    'zb':  [(-50, 0), (-44, -2.5), (40, -2.5), (64, -1.5), (72.5, 1)],
    'ws':  [(-50, 20), (-44, 21.5), (-16, 22), (-2, 22.5), (24, 22), (32, 20), (40, 17.5), (60, 16.5), (66, 15.5), (72.5, 13.5)],
    'zh':  [(-50, 24.5), (-44, 26), (-34, 26), (-20, 24.5), (-10, 23.5), (24, 23), (32, 20.8), (38, 18.0), (44, 14.8), (50, 12.8), (56, 11.2), (62, 9.4), (66, 7.8), (72.5, 4.3)],
    'zc':  [(-50, 25), (-44, 26.6), (-34, 26.6), (-20, 25), (-10, 24), (24, 23.5), (32, 22.0), (38, 19.2), (44, 15.8), (50, 13.8), (56, 12.2), (62, 10.4), (66, 8.6), (72.5, 5.0)],
}
def tub_ring(x):
    g = {k: lerp_table(v, x) for k, v in TT.items()}
    return (x, [(0, g['zb']), (g['ws'] - 3, g['zb']), (g['ws'], g['zb'] + 4), (g['ws'], g['zh'] - 2.5), (g['ws'] - 2.5, g['zh']), (0, g['zc'])])
def tub_mat(i, j):
    if i < 0: return 'trim'
    x = (TUB_X[i] + TUB_X[i + 1]) / 2
    if j == 0: return 'trim'
    if j in (1, 2) and x > 62: return 'trim'      # lower nose
    if j == 1: return 'trim'                      # dark sill edge
    return 'paint'
cage('tub', [tub_ring(x) for x in TUB_X], mirror=True, faces_mat=tub_mat, mats=('paint', 'trim'),
     crease_long=(1, 2, 3, 4), crease_ring=(0, len(TUB_X) - 1), subdiv=2)

# raised V ridge on the hood (photo: two creases converging towards the nose)
HOOD_X = [36, 42, 48, 54, 60, 66, 70]
def hood_ring(x):
    zc = lerp_table(TT['zc'], x)
    w = lerp_table([(36, 10), (54, 7), (70, 4.5)], x)
    return (x, [(w + 2.2, zc - 0.6), (w, zc + 1.0), (0, zc + 1.5)])
cage('hood', [hood_ring(x) for x in HOOD_X], mirror=True, crease_long=(1,), crease_ring=(0, len(HOOD_X) - 1), subdiv=2)

# cabin: base on the tub -> belt -> roof edge -> roof centre
CAB_X = [-27, -24, -20, -15, -8, 0, 8, 14, 20, 26, 31, 35.5]
CC = {
    'zb':  [(-27, 26.0), (-20, 25), (-10, 24), (24, 23.4), (35.5, 22.2)],
    'wb':  [(-30, 16), (-22, 18.5), (-14, 19.5), (20, 19.5), (30, 17.5), (35.5, 15)],
    'zbelt': [(-30, 27.2), (-22, 27.6), (-14, 27.4), (20, 26.4), (30, 24.4), (35.5, 22.8)],
    'wbelt': [(-30, 15), (-22, 16.6), (-14, 17), (20, 17), (30, 15.6), (35.5, 13.5)],
    'zr':  [(-27, 27.0), (-24, 29.0), (-20, 31.0), (-15, 32.6), (-8, 33.2), (0, 33.4), (8, 33.2), (14, 31.0), (20, 29.4), (26, 27.6), (31, 25.6), (35.5, 23.2)],
    'wr':  [(-30, 10.5), (-20, 11.8), (0, 12.2), (20, 12.4), (35.5, 12.6)],
}
def cab_ring(x):
    g = {k: lerp_table(v, x) for k, v in CC.items()}
    return (x, [(g['wb'], g['zb']), (g['wbelt'], g['zbelt']), (g['wr'], g['zr'] - 0.9), (0, g['zr'])])
def cab_mat(i, j):
    if i < 0: return 'paint'
    x = (CAB_X[i] + CAB_X[i + 1]) / 2
    if j == 1 and -15 < x < 29: return 'glass'      # side window (trapezoid; front edge follows the A-pillar)
    if j == 2 and 9 < x < 34: return 'glass'        # windscreen
    return 'paint'
cage('cabin', [cab_ring(x) for x in CAB_X], mirror=True, faces_mat=cab_mat, mats=('paint', 'glass'),
     crease_long=(0, 1, 2), crease_ring=(0, len(CAB_X) - 1), cap=(True, True), subdiv=2)

# window frames: body-coloured A-pillar / roof rail along the roof edge, and a sill rail under the side window
def rail(name, pts, r=0.9, mat_name='paint'):
    rings = [(x, [(y - r, z), (y, z + r), (y + r, z), (y, z - r)]) for x, y, z in pts]
    return cage(name, rings, mirror=True, mirror_offset=1, closed=True, mats=(mat_name,), subdiv=1)
roof_pts, sill_pts = [], []
for x in [-14, -8, 0, 8, 14, 20, 26, 31, 34.5]:
    g = {k: lerp_table(v, x) for k, v in CC.items()}
    roof_pts.append((x, g['wr'] + 0.4, g['zr'] - 0.9))
    sill_pts.append((x, g['wbelt'] + 0.3, g['zbelt']))
rail('roofrail', roof_pts, 1.0)
rail('sillrail', sill_pts[:-1], 0.7)
# B-pillar at the back of the side window and the windscreen centre-free A-pillar foot
for xx in (-14.5,):
    g = {k: lerp_table(v, xx) for k, v in CC.items()}
    rail('bpillar', [(xx, g['wbelt'] + 0.2, g['zbelt']), (xx - 0.01, (g['wbelt'] + g['wr']) / 2 + 0.3, (g['zbelt'] + g['zr']) / 2), (xx - 0.02, g['wr'] + 0.4, g['zr'] - 0.9)], 1.2)

# ---- mudguards: thin swept shells over the wheels (clay render), open underneath, dark lip on the outer edge
def mudguard(name, w, a0, a1, rad, yin, yout, thick=1.4, droop=1.6, lip=2.2, n=22, m=6):
    """arc over the wheel in the x-z plane (angle 0 = front, 90 = top); rad(t), yout(t) with t in 0..1"""
    rings = []
    for k in range(n + 1):
        t = k / n
        a = math.radians(a0 + (a1 - a0) * t)
        ca, sa = math.cos(a), math.sin(a)
        R = rad(t); yo = yout(t)
        pts = []
        # top surface from body side out to the edge (slight droop), then the lip down, back under
        for q in range(m + 1):
            u = q / m
            y = yin + (yo - yin) * u
            r = R - droop * u * u
            pts.append((y, r))
        pts.append((yo + 0.3, R - droop - lip))
        pts.append((yo - thick, R - droop - lip))
        for q in range(m, -1, -1):
            u = q / m
            y = yin + (yo - thick - yin) * u
            r = R - thick - droop * u * u
            pts.append((y, r))
        ring = [(w['x'] + ca * r, y, w['z'] + sa * r) for y, r in pts]
        rings.append(ring)
    bm2 = bmesh.new()
    crease = bm2.edges.layers.float.new('crease_edge')
    V = [[bm2.verts.new(p) for p in ring] for ring in rings]
    L = len(rings[0]); lipk = (m + 1, m + 2)
    for k in range(n):
        for q in range(L):
            f = bm2.faces.new((V[k][q], V[k + 1][q], V[k + 1][(q + 1) % L], V[k][(q + 1) % L]))
            f.material_index = 1 if q in (m, m + 1, m + 2) else 0
    bm2.faces.new(list(reversed(V[0]))); bm2.faces.new(V[-1])
    for k in range(n):
        for q in (m, m + 1, m + 2, m + 3):
            e = bm2.edges.get((V[k][q], V[k + 1][q]))
            if e: e[crease] = 1.0; e.smooth = False
    bmesh.ops.recalc_face_normals(bm2, faces=bm2.faces)
    me = bpy.data.meshes.new(name); bm2.to_mesh(me); bm2.free(); set_mats(me, ['paint', 'trim'])
    ob = link(bpy.data.objects.new(name, me))
    md = ob.modifiers.new('mirror', 'MIRROR'); md.use_axis = (False, True, False); md.mirror_object = ORIGIN
    sd = ob.modifiers.new('subd', 'SUBSURF'); sd.levels = 1; sd.render_levels = 1
    for pp in me.polygons: pp.use_smooth = True
    return ob

# front: from the nose corner (low, curling up) over the wheel, down behind it into the body side
mudguard('fender_f', WFB, 16, 178, rad=lambda t: 14.6 + 0.6 * math.sin(math.pi * t) + 9.0 * max(0, t - 0.72) ** 1.3, yin=16,
         yout=lambda t: 23.5 + 8.0 * math.sin(math.pi * min(1, 0.18 + t * 0.95)), droop=1.4)
# rear: rises from the body side ahead of the wheel, over it and out back into a long blade
mudguard('fender_r', WBB, 6, 172, rad=lambda t: 18.4 + 1.6 * math.sin(math.pi * t) + 4.0 * max(0, t - 0.75),
         yin=19, yout=lambda t: 26 + 9.4 * math.sin(math.pi * min(1, 0.12 + t * 0.95)), droop=3.4, lip=2.6)

# side recess: diagonal dark inset edge behind the front wheel down towards the rear wheel
xz_plate_side = None
def side_slot(name, pts, y, depth=0.8):
    bm3 = bmesh.new()
    vs = [[bm3.verts.new((x, yy, z)) for x, z in pts] for yy in (y, y + depth)]
    k = len(pts)
    for j2 in range(k):
        bm3.faces.new((vs[0][j2], vs[1][j2], vs[1][(j2 + 1) % k], vs[0][(j2 + 1) % k]))
    bm3.faces.new(list(reversed(vs[0]))); bm3.faces.new(vs[1])
    bmesh.ops.recalc_face_normals(bm3, faces=bm3.faces)
    me = bpy.data.meshes.new(name); bm3.to_mesh(me); bm3.free(); set_mats(me, ['trim'])
    ob = link(bpy.data.objects.new(name, me))
    md = ob.modifiers.new('mirror', 'MIRROR'); md.use_axis = (False, True, False); md.mirror_object = ORIGIN
    return ob
side_slot('side_slot', [(30, 17.0), (28, 18.4), (6, 8.6), (-8, 5.4), (-10, 4.2), (8, 6.8)], 21.9)

# roof crest fins (row of five small spikes in front of the intake)
for yy in (-8.5, -4.2, 0.0, 4.2, 8.5):
    bm4 = bmesh.new()
    prof = [(4.0, 33.0), (-0.5, 33.0), (-2.2, 35.6), (-1.4, 35.6)]
    vs = [[bm4.verts.new((x, yy + d, z)) for x, z in prof] for d in (-0.7, 0.7)]
    for j2 in range(4):
        bm4.faces.new((vs[0][j2], vs[1][j2], vs[1][(j2 + 1) % 4], vs[0][(j2 + 1) % 4]))
    bm4.faces.new(list(reversed(vs[0]))); bm4.faces.new(vs[1])
    bmesh.ops.recalc_face_normals(bm4, faces=bm4.faces)
    me = bpy.data.meshes.new('spike'); bm4.to_mesh(me); bm4.free(); set_mats(me, ['trim'])
    link(bpy.data.objects.new('spike', me))

# ------------------------------------------------------------------ details at blueprint coordinates
def xz_plate(name, poly, y0, y1, mat_name, bevel=0.4, mirror=True):
    bmx = bmesh.new()
    vs = [[bmx.verts.new((x, y, z)) for x, z in poly] for y in (y0, y1)]
    k = len(poly)
    for j in range(k):
        bmx.faces.new((vs[0][j], vs[1][j], vs[1][(j + 1) % k], vs[0][(j + 1) % k]))
    bmx.faces.new(list(reversed(vs[0]))); bmx.faces.new(vs[1])
    bmesh.ops.recalc_face_normals(bmx, faces=bmx.faces)
    me = bpy.data.meshes.new(name); bmx.to_mesh(me); bmx.free(); set_mats(me, [mat_name])
    ob = link(bpy.data.objects.new(name, me))
    if bevel:
        bv = ob.modifiers.new('bevel', 'BEVEL'); bv.width = bevel; bv.segments = 2; bv.harden_normals = True
    if mirror:
        md = ob.modifiers.new('mirror', 'MIRROR'); md.use_axis = (False, True, False); md.mirror_object = ORIGIN
    for p in me.polygons: p.use_smooth = True
    return ob

# wing: swept blade (side profile from the blueprint), endplates, struts
xz_plate('wing', [(-39.0, 37.4), (-40.5, 38.9), (-46, 39.3), (-57.5, 39.4), (-58.5, 38.2), (-50, 36.5), (-42, 36.4)], -26.5, 26.5, 'paint', 0.4, mirror=False)
xz_plate('endplate', [(-46, 36.0), (-50, 35.2), (-60.3, 38.4), (-60.6, 43.8), (-57, 44.2), (-50, 41.8)], 26.3, 29.6, 'trim', 0.4)
xz_plate('strut', [(-39.5, 26.5), (-36.5, 26.5), (-39.0, 33.0), (-41.2, 37.4), (-43.4, 37.2), (-41.0, 32.6)], 11.2, 13.2, 'chrome', 0.3)  # swan neck
# intake stack on the roof (x -1..-16, z 33..38.7) with a dark forward-facing mouth
xz_plate('intake', [(-1.0, 33.0), (-1.0, 38.4), (-3.0, 38.9), (-15.5, 38.4), (-16.5, 34.6), (-16.5, 32.6)], -8.0, 8.0, 'chrome:dark', 0.8, mirror=False)
xz_plate('intake_mouth', [(-0.6, 34.4), (-0.6, 37.6), (-1.6, 37.6), (-1.6, 34.4)], -6.6, 6.6, 'trim', 0.2, mirror=False)
# engine bay behind the cabin: red covers + canisters on the deck
box('engine', (14, 18, 3.6), (-28, 0, 27.4), mat_name='chrome:dark', bevel=1.0)
box('engine_cover', (10, 13, 3.0), (-29, 0, 29.4), mat_name='chrome:red', bevel=1.0)
for yy in (11.5,):
    cyl('canister', 2.6, 10, (-36, yy, 27.5), rot=(0, math.pi / 2, 0), mat_name='chrome:red', segs=16, mirror=True)
# nose: grille cage (x 72..79, z -10..4, |y| <= 19), slats, lamps, fog lamps
box('grille_back', (1.2, 24, 9), (74.0, 0, -1.5), mat_name='trim', bevel=0.3)
for yy in [-10.5, -7.5, -4.5, -1.5, 1.5, 4.5, 7.5, 10.5]:
    box(f'slat{yy}', (1.4, 1.0, 8.4), (75.0, yy, -1.5), mat_name='chrome:dark', bevel=0.3)
cyl('cage_top', 1.2, 30, (77.2, 0, 4.0), rot=(math.pi / 2, 0, 0), mat_name='chrome', segs=10)
cyl('cage_bot', 1.2, 34, (77.0, 0, -8.6), rot=(math.pi / 2, 0, 0), mat_name='chrome', segs=10)
for yy in (6.0, 13.5):
    cyl(f'cage_up{yy}', 1.1, 13, (77.3, yy, -2.3), mat_name='chrome', segs=10, mirror=True)
for yy in (17.5,):
    cyl('lamp_can', 3.3, 4, (75.6, yy, 1.0), rot=(0, math.pi / 2, 0), mat_name='trim', segs=20, mirror=True, r2=3.8)
    cyl('lamp_bezel', 4.0, 1.2, (78.0, yy, 1.0), rot=(0, math.pi / 2, 0), mat_name='chrome', segs=24, mirror=True)
    cyl('lamp_lens', 3.0, 0.6, (78.6, yy, 1.0), rot=(0, math.pi / 2, 0), mat_name='light:head', segs=24, bevel=0, mirror=True)
for yy in (9.0,):
    cyl('fog_bezel', 2.0, 1.4, (77.8, yy, -6.6), rot=(0, math.pi / 2, 0), mat_name='chrome', segs=18, mirror=True)
    cyl('fog_lens', 1.5, 0.5, (78.5, yy, -6.6), rot=(0, math.pi / 2, 0), mat_name='light:head', segs=18, bevel=0, mirror=True)
# dark underbody: chassis tub, lower arms and the low front bumper (blueprint: down to z -9/-10)
box('chassis', (96, 26, 4), (10, 0, -2.5), mat_name='trim', bevel=1.2)
box('belly', (36, 22, 6), (8, 0, -6.0), mat_name='trim', bevel=1.5)
box('front_lower', (10, 30, 8), (72, 0, -5.5), mat_name='trim', bevel=1.2)
for xx in (51.25, -33.75):
    box(f'arm{xx}', (8, 12, 2.2), (xx, 18, -5.5), mat_name='trim', bevel=0.6, mirror=True)
# rear: open slatted face at x -50, exhaust, tail lights
box('rear_frame', (1.6, 34, 24), (-49.6, 0, 11.5), mat_name='trim', bevel=0.5)
for zz in (1.0, 4.3, 9.3, 13.7):
    box(f'rear_slat{zz}', (1.0, 30, 0.9), (-50.6, 0, zz), mat_name='chrome:dark', bevel=0.2)
cyl('exhaust', 2.0, 5, (-51.0, 6.5, 20.5), rot=(0, math.pi / 2, 0), mat_name='chrome', segs=16, mirror=True, r2=2.3)
cyl('exhaust_in', 1.5, 1, (-53.4, 6.5, 20.5), rot=(0, math.pi / 2, 0), mat_name='trim', segs=16, bevel=0, mirror=True)
box('tail', (1.0, 5, 2.4), (-50.6, 24, 20.0), mat_name='light:tail', bevel=0.3, mirror=True)
# front coilovers visible in the wheel wells
cyl('spring', 1.8, 7, (49.5, 19.0, 3.0), rot=(0, math.radians(-14), 0), mat_name='chrome:red', segs=12, mirror=True)
cyl('shock', 0.8, 10, (49.7, 19.0, 3.0), rot=(0, math.radians(-14), 0), mat_name='chrome', segs=10, mirror=True)

# ------------------------------------------------------------------ export: evaluated meshes -> compact quantised slots
SLOT_OF = lambda n: n.split(':')[0]
COLORS = {'light:head': (2.1, 2.2, 2.5), 'light:tail': (2.8, 0.06, 0.05), 'light:amber': (3.2, 1.3, 0.1),
          'chrome:red': (0.8, 0.07, 0.05), 'chrome:dark': (0.32, 0.33, 0.37)}
slots = {}
dg = bpy.context.evaluated_depsgraph_get()
tris_total = 0
for ob in list(scene.objects):
    if ob.type != 'MESH' or ob in CUTTERS: continue
    ev = ob.evaluated_get(dg)
    me = ev.to_mesh()
    me.calc_loop_triangles()
    M = ob.matrix_world
    N3 = M.to_3x3().inverted().transposed()
    cn = me.corner_normals
    for lt in me.loop_triangles:
        mname = me.materials[lt.material_index].name if me.materials else 'paint'
        slot = SLOT_OF(mname)
        col = COLORS.get(mname, (1, 1, 1))
        d = slots.setdefault(slot, {'v': {}, 'pos': [], 'nrm': [], 'col': [], 'idx': []})
        tri = []
        for li in lt.loops:
            vi = me.loops[li].vertex_index
            p = M @ me.vertices[vi].co
            n = (N3 @ Vector(cn[li].vector)).normalized()
            key = (round(p.x * 64), round(p.y * 64), round(p.z * 64), round(n.x * 100), round(n.y * 100), round(n.z * 100), col)
            k = d['v'].get(key)
            if k is None:
                k = len(d['pos']) // 3
                d['v'][key] = k
                d['pos'] += [key[0], key[1], key[2]]
                d['nrm'] += [max(-127, min(127, round(n.x * 127))), max(-127, min(127, round(n.y * 127))), max(-127, min(127, round(n.z * 127)))]
                d['col'].append(col)
            tri.append(k)
        d['idx'] += tri
        tris_total += 1
    ev.to_mesh_clear()

# silhouette check against the blueprint (all exported triangles, Blender -> car frame y right)
if '--compare' in sys.argv:
    import compare as CMP
    T = []
    for ob in list(scene.objects):
        if ob.type != 'MESH' or ob in CUTTERS: continue
        ev = ob.evaluated_get(dg); me2 = ev.to_mesh(); me2.calc_loop_triangles(); M = ob.matrix_world
        for lt in me2.loop_triangles:
            T.append([tuple(M @ me2.vertices[i].co) for i in lt.vertices])
        ev.to_mesh_clear()
    T = np.array(T); T[..., 1] *= -1
    print('IOU', CMP.run(T, sys.argv[sys.argv.index('--compare') + 1]))
if '--photo' in sys.argv:
    import photomap as PM, json as _json
    from PIL import Image as _Im, ImageDraw as _Dr
    cam = _json.load(open(os.path.join(os.path.dirname(os.path.abspath(__file__)), 'ref', 'cam_blue.json')))
    polys, labs = [], []
    LID = {'paint': 1, 'accent': 1, 'trim': 2, 'glass': 3, 'chrome': 4, 'light': 5}
    for ob in list(scene.objects):
        if ob.type != 'MESH' or ob in CUTTERS: continue
        ev = ob.evaluated_get(dg); me2 = ev.to_mesh(); me2.calc_loop_triangles(); M = ob.matrix_world
        for lt in me2.loop_triangles:
            mn = me2.materials[lt.material_index].name
            polys.append(np.array([tuple(M @ me2.vertices[i].co) for i in lt.vertices])); labs.append(6 if mn == 'chrome:red' else LID[mn.split(':')[0]])
        ev.to_mesh_clear()
    uv, zc = [], []
    for q in polys:
        u, z = PM.project(q, cam); uv.append(u); zc.append(z.mean())
    img = _Im.new('L', (1920, 1080), 0); d = _Dr.Draw(img)
    for i in np.argsort(-np.array(zc)): d.polygon([tuple(t) for t in uv[i]], fill=labs[i])
    L = np.array(img)
    photo = np.array(_Im.open(os.path.join(os.path.dirname(os.path.abspath(__file__)), 'ref', 'octane_blue.webp')).convert('RGB')).astype(float)
    edge = (L != np.roll(L, 1, 0)) | (L != np.roll(L, 1, 1))
    edge = edge | np.roll(edge, 1, 0) | np.roll(edge, 1, 1)
    COL = {1: (255, 255, 255), 2: (0, 255, 0), 3: (255, 0, 255), 4: (255, 255, 0), 5: (0, 255, 255), 6: (255, 60, 60)}
    out = photo.copy()
    for k, c in COL.items():
        sel = edge & (L == k)
        out[sel] = c
    _Im.fromarray(out.astype(np.uint8)).crop((560, 280, 1880, 980)).save(sys.argv[sys.argv.index('--photo') + 1])
if '--tris' in sys.argv:
    T2 = []
    for ob in list(scene.objects):
        if ob.type != 'MESH' or ob in CUTTERS: continue
        ev = ob.evaluated_get(dg); me2 = ev.to_mesh(); me2.calc_loop_triangles(); M = ob.matrix_world
        for lt in me2.loop_triangles:
            T2.append([tuple(M @ me2.vertices[i].co) for i in lt.vertices])
        ev.to_mesh_clear()
    np.save(sys.argv[sys.argv.index('--tris') + 1], np.array(T2, np.float32))
# binary: per slot  [u32 nv][u32 ni][i16 pos*3nv][i8 nrm*3nv][u8 colIndex*nv][pad4][u16|u32 idx]
palette = [(1, 1, 1)]
blob = bytearray()
meta = []
for slot, d in slots.items():
    nv = len(d['pos']) // 3; ni = len(d['idx'])
    ci = []
    for c in d['col']:
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
header = {'q': 64, 'palette': palette, 'parts': meta}
js = ('// GENERATED by tools/blender/octane_build.py — do not edit by hand.\n'
      '// Vector (Octane-class) body mesh: quantised positions (uu * q, Blender axes x fwd / y left / z up),\n'
      '// int8 normals, colour palette index per vertex, per material slot.\n'
      f'export const VECTOR_MESH_META = {json.dumps(header)};\n'
      f'export const VECTOR_MESH_B64 = "{base64.b64encode(bytes(blob)).decode()}";\n')
with open(OUT_JS, 'w') as f: f.write(js)
print('tris', tris_total, 'bytes', len(blob), 'slots', {m['slot']: m['nv'] for m in meta})
if '--blend' in sys.argv:
    bpy.ops.wm.save_as_mainfile(filepath=sys.argv[sys.argv.index('--blend') + 1])
