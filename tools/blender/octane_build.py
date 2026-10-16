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
WF = dict(x=51.25, y=34.4, z=-4.0, r=12.5)   # front: centre (hard point - rest suspension), visual track
WB = dict(x=-33.75, y=37.0, z=-2.3, r=15.0)
def arch(x, w, clr):
    R = w['r'] + clr
    dx = x - w['x']
    return w['z'] + math.sqrt(R * R - dx * dx) if abs(dx) < R else -1e9

# ------------------------------------------------------------------ main tub (mirrored half: bottom centre -> top centre)
TUB_X = [-49, -46, -40, -30, -20, -12, -4, 4, 14, 24, 32, 38, 44, 50, 55, 60, 64, 67, 70]
T = {
    'zb': [(-49, 10), (-44, 7), (-30, 6), (59.1111, 6), (70, 9)],
    'wb': [(-49, 18), (-44, 21), (-20, 21), (20, 19), (59.1111, 16), (70, 12)],
    'zs': [(-49, 16), (-30, 15), (20, 14), (59.1111, 12), (70, 11)],
    'ws': [(-49, 23), (-44, 25.5), (-20, 25.5), (-4, 26.5), (20, 25.5), (44, 23), (60.6667, 20), (70, 15)],
    'zh': [(-49, 26.5), (-40, 28), (-20, 28.5), (-4, 28), (20, 26.5), (34, 25), (44, 22.5), (56, 19.5), (63.7778, 17), (70, 14.5)],
    'wh': [(-49, 22), (-44, 25), (-20, 25), (-4, 26), (20, 25), (44, 22.5), (60.6667, 19), (70, 14)],
    'zt': [(-49, 29.5), (-40, 30.5), (-20, 30.5), (-4, 29.8), (20, 28.4), (34, 26.6), (44, 24), (56, 21), (63.7778, 18.5), (70, 16)],
    'wt': [(-49, 17), (-40, 19), (-20, 19), (20, 19), (44, 17), (60.6667, 14), (70, 10)],
    'zc': [(-49, 30), (-40, 31), (-20, 31), (-4, 30.3), (20, 29), (34, 27.6), (44, 25.6), (56, 22.6), (63.7778, 20), (70, 17)],
}
def tub_ring(x):
    g = {k: lerp_table(v, x) for k, v in T.items()}
    return (x, [(0, g['zb']), (g['wb'], g['zb']), (g['ws'], g['zs']), (g['wh'], g['zh']), (g['wt'], g['zt']), (0, g['zc'])])
def tub_mat(i, j):
    if i < 0: return 'trim' if i == -1 else 'trim'
    x = (TUB_X[i] + TUB_X[i + 1]) / 2
    if j == 0: return 'trim'                       # underside
    if j == 1 and (x > 62 or x < -40): return 'trim'  # lower nose fascia / rear frame
    return 'paint'
tub = cage('tub', [tub_ring(x) for x in TUB_X], mirror=True, faces_mat=tub_mat, mats=('paint', 'trim'),
           crease_long=(1, 3, 4), crease_ring=(0, len(TUB_X) - 1), subdiv=2)

# raised centre hood panel + racing stripes
HOOD_X = [34, 40, 48, 56, 62, 67]
def hood_ring(x):
    zt = lerp_table(T['zc'], x)
    w = lerp_table([(34, 9), (56, 8), (71, 6)], x)
    return (x, [(w + 1.5, zt - 1.0), (w, zt + 1.6), (0, zt + 2.0)])
cage('hood', [hood_ring(x) for x in HOOD_X], mirror=True, crease_long=(1,), crease_ring=(0, len(HOOD_X) - 1), subdiv=2)
STRIPE_X = [-48, -40, -30, -20, -14]
# (roof stripes are on the cabin; hood/deck stripes:)
def stripe_strip(name, xs, surf, y0, y1, lift=0.25):
    rings = []
    for x in xs:
        z = surf(x)
        rings.append((x, [(y0, z + lift), (y1, z + lift)]))
    ob = cage(name, rings, mirror=True, mirror_offset=1, mats=('accent',), cap=(False, False), subdiv=0, smooth=False)
    return ob
stripe_strip('stripe_hood', [36, 44, 52, 60, 65, 68.5], lambda x: lerp_table(T['zc'], x) + 2.0 + 0.05, 2.2, 5.2)
stripe_strip('stripe_deck', [-49, -44, -38], lambda x: lerp_table(T['zc'], x), 2.2, 5.2)

# ------------------------------------------------------------------ cabin canopy (sits on the tub): base -> sill -> roof edge -> roof centre
CAB_X = [-17, -14, -8, 0, 8, 16, 24, 30, 35]
C = {
    'zb': [(-17, 30.2), (0, 29.8), (20, 28.6), (35, 26.8)],
    'wb': [(-17, 20), (-8, 24.5), (16, 24.5), (30, 22.5), (35, 20)],
    'zs': [(-17, 31.5), (-8, 32.5), (16, 31.5), (30, 28.8), (35, 27.4)],
    'ws': [(-17, 19.5), (-8, 23.8), (16, 23.8), (30, 22), (35, 19.5)],
    'zr': [(-17, 32.5), (-14, 38), (-8, 43.5), (0, 45), (8, 44.6), (16, 40.8), (24, 35.2), (30, 30.8), (35, 27.8)],
    'wr': [(-17, 15), (-8, 16.5), (8, 16.5), (24, 17.5), (35, 18.5)],
    'zc': [(-17, 33), (-14, 38.8), (-8, 44.3), (0, 45.8), (8, 45.4), (16, 41.6), (24, 35.8), (30, 31.3), (35, 28)],
}
def cab_ring(x):
    g = {k: lerp_table(v, x) for k, v in C.items()}
    return (x, [(g['wb'], g['zb']), (g['ws'], g['zs']), (g['wr'], g['zr']), (0, g['zc'])])
def cab_mat(i, j):
    if i < 0: return 'paint'
    x = (CAB_X[i] + CAB_X[i + 1]) / 2
    if j == 1 and -9 < x < 27: return 'glass'      # side windows
    if j == 2 and x > 9: return 'glass'            # windscreen
    if j == 2 and x < -11: return 'glass'          # rear window
    return 'paint'
cage('cabin', [cab_ring(x) for x in CAB_X], mirror=True, faces_mat=cab_mat, mats=('paint', 'glass'),
     crease_long=(0, 1, 2), crease_ring=(0, len(CAB_X) - 1), cap=(True, True), subdiv=2)
# window frames: thin dark rails along the sill and the roof edge
for nm, pick in (('sill', lambda g: (g['ws'] + 0.3, g['zs'] + 0.1)), ('roofrail', lambda g: (g['wr'] + 0.6, g['zr'] - 0.2))):
    rings = []
    for x in [-9, -2, 6, 14, 22, 28]:
        g = {k: lerp_table(v, x) for k, v in C.items()}
        y, z = pick(g)
        rings.append((x, [(y, z - 0.5), (y + 0.6, z), (y, z + 0.5), (y - 0.6, z)]))
    cage('frame_' + nm, rings, mirror=True, mirror_offset=1, closed=True, mats=('trim',), subdiv=1)
stripe_strip('stripe_roof', [-14, -8, 0, 8, 16, 24, 30, 34], lambda x: lerp_table(C['zc'], x) + 0.05, 2.2, 5.2)

# ------------------------------------------------------------------ front fender pods (angular, flat top), closed loop sections along x
POD_X = [27, 32, 38, 44, 50, 56, 61, 64.5, 67]
def pod_ring(x):
    a = arch(x, WF, 3.5)
    top = lerp_table([(27, 20), (36, 23.5), (50, 24.5), (61, 23.5), (67, 19.5)], x)
    yin = lerp_table([(27, 25), (40, 24), (69, 24)], x)
    yout = lerp_table([(27, 30), (34, 40), (44, 43.5), (56, 43.5), (63, 41.5), (67, 37)], x)
    bot = max(a, lerp_table([(27, 15), (40, 10), (60, 10), (69, 13)], x))
    bot = min(bot, top - 2.5)
    return (x, [(yin, bot), (yin, top - 1.5), (yin + 3, top), (yout - 3.5, top - 0.4), (yout, top - 3.5), (yout, bot + 1.2), (yout - 1.2, bot)])
pod = cage('pod', [pod_ring(x) for x in POD_X], mirror=True, mirror_offset=1, closed=True, mats=('paint', 'trim'),
           faces_mat=lambda i, j: 'trim' if j == 6 else 'paint', crease_long=(0, 1, 2, 3, 4, 5, 6), crease_ring=(0, len(POD_X) - 1), subdiv=2)
# dark arch liner inside each pod
LINER = []
for k in range(17):
    ang = math.radians(-8 + k * (196 / 16))
    LINER.append(ang)
rings = []
for ang in LINER:
    r0, r1 = WF['r'] + 3.0, WF['r'] + 4.0
    x0, z0 = WF['x'] + math.cos(ang) * r0, WF['z'] + math.sin(ang) * r0
    x1, z1 = WF['x'] + math.cos(ang) * r1, WF['z'] + math.sin(ang) * r1
    rings.append((0, [(0, 0)]))
# (liner built as a swept strip below)
def swept_arch(name, w, rin, rout, yin, yout, a0, a1, n=18, mat_name='trim'):
    bm = bmesh.new()
    vs = []
    for k in range(n + 1):
        ang = math.radians(a0 + (a1 - a0) * k / n)
        c, s = math.cos(ang), math.sin(ang)
        ring = [(w['x'] + c * rin, yin, w['z'] + s * rin), (w['x'] + c * rout, yin, w['z'] + s * rout),
                (w['x'] + c * rout, yout, w['z'] + s * rout), (w['x'] + c * rin, yout, w['z'] + s * rin)]
        vs.append([bm.verts.new(p) for p in ring])
    for k in range(n):
        for j in range(4):
            bm.faces.new((vs[k][j], vs[k + 1][j], vs[k + 1][(j + 1) % 4], vs[k][(j + 1) % 4]))
    bm.faces.new(list(reversed(vs[0]))); bm.faces.new(vs[-1])
    bmesh.ops.recalc_face_normals(bm, faces=bm.faces)
    me = bpy.data.meshes.new(name); bm.to_mesh(me); bm.free(); set_mats(me, [mat_name])
    ob = link(bpy.data.objects.new(name, me))
    md = ob.modifiers.new('mirror', 'MIRROR'); md.use_axis = (False, True, False); md.mirror_object = ORIGIN
    for p in me.polygons: p.use_smooth = True
    return ob
swept_arch('pod_liner', WF, WF['r'] + 3.2, WF['r'] + 3.9, 25, 42.5, 10, 170)

# ------------------------------------------------------------------ rear haunches (boxy, flat top, rising into fins at the back)
H_X = [-6, -10, -16, -24, -32, -40, -46, -50, -53]
H_X = sorted(H_X)
def haunch_ring(x):
    a = arch(x, WB, 4.0)
    top = lerp_table([(-53, 33), (-48, 31.5), (-40, 30), (-24, 29.5), (-12, 28), (-6, 24)], x)
    yin = 23
    yout = lerp_table([(-53, 42), (-46, 46.5), (-30, 47), (-16, 46), (-8, 40), (-6, 34)], x)
    bot = max(a, lerp_table([(-53, 21), (-49, 17), (-20, 9), (-6, 16)], x))
    bot = min(bot, top - 2.5)
    return (x, [(yin, bot), (yin, top - 1.2), (yin + 3, top), (yout - 4, top - 0.3), (yout, top - 4), (yout, bot + 1.5), (yout - 1.5, bot)])
cage('haunch', [haunch_ring(x) for x in H_X], mirror=True, mirror_offset=1, closed=True, mats=('paint', 'trim'),
     faces_mat=lambda i, j: 'trim' if j == 6 else 'paint', crease_long=(0, 1, 2, 3, 4, 5, 6), crease_ring=(0, len(H_X) - 1), subdiv=2)
swept_arch('haunch_liner', WB, WB['r'] + 3.6, WB['r'] + 4.3, 24, 46, 10, 170)

# swept fins on the haunch tops, near the outer edge
F_X = [-22, -30, -38, -44, -49, -53, -56]
F_X = sorted(F_X)
def fin_ring(x):
    base = lerp_table([(-56, 32), (-48, 31), (-40, 30), (-22, 29.2)], x) - 1.0
    tip = lerp_table([(-56, 44), (-53, 44.5), (-49, 41), (-44, 37.5), (-38, 34.5), (-30, 32), (-22, 29.6)], x)
    yc = lerp_table([(-56, 41), (-40, 40), (-22, 39)], x)
    t = lerp_table([(-56, 1.2), (-48, 2.4), (-22, 3.0)], x)
    return (x, [(yc - t, base), (yc - t * 0.6, tip), (yc + t * 0.6, tip), (yc + t, base)])
cage('fin', [fin_ring(x) for x in F_X], mirror=True, mirror_offset=1, closed=True, mats=('paint', 'trim'),
     faces_mat=lambda i, j: 'trim' if j == 1 and i >= 0 and F_X[i] < -42 else 'paint', crease_long=(1, 2), crease_ring=(0,), subdiv=2)

# side rib: from the back of the front pod sweeping up along the body side to the haunch
R_X = [-6, 0, 8, 16, 24, 30]
def rib_ring(x):
    zc = lerp_table([(-6, 23), (8, 21), (20, 19.5), (30, 18)], x)
    y = lerp_table([(-6, 27.5), (30, 26.8)], x)
    return (x, [(y - 0.5, zc - 2.2), (y + 1.6, zc - 1.2), (y + 1.6, zc + 1.0), (y - 0.5, zc + 1.6)])
cage('rib', [rib_ring(x) for x in R_X], mirror=True, mirror_offset=1, closed=True, mats=('paint',), crease_long=(1, 2), subdiv=1)
# dark side intake scoop below the rib
S_X = [-4, 4, 14, 24]
def scoop_ring(x):
    y = lerp_table([(-4, 26.4), (24, 25.8)], x)
    top = lerp_table([(-4, 20.5), (24, 17.2)], x)
    return (x, [(y, 9), (y + 0.6, 9.5), (y + 0.6, top), (y, top + 0.3)])
cage('scoop', [scoop_ring(x) for x in S_X], mirror=True, mirror_offset=1, closed=True, mats=('trim',), subdiv=1)

# ------------------------------------------------------------------ nose: bumper, grille cage with slats, lamps
box('bumper', (8, 30, 7), (66.5, 0, 6.5), mat_name='trim', bevel=1.5)
for y in [-12, -9, -6, -3, 0, 3, 6, 9, 12]:
    box(f'slat{y}', (1.4, 1.0, 8.5), (70.6, y, 10.2), mat_name='chrome:dark', bevel=0.3)
box('grille_back', (1.2, 27, 9), (69.6, 0, 10.2), mat_name='trim', bevel=0.3)
# cage tubes
cyl('cage_top', 1.4, 36, (73, 0, 15.2), rot=(math.pi / 2, 0, 0), mat_name='trim', segs=10)
cyl('cage_bot', 1.4, 40, (72.5, 0, 4.8), rot=(math.pi / 2, 0, 0), mat_name='trim', segs=10)
for y in (14.5, 7):
    cyl(f'cage_up{y}', 1.3, 11, (72.9, y, 10), mat_name='trim', segs=10, mirror=True)
cyl('cage_side', 1.3, 10, (69.5, 19.5, 14.6), rot=(0, math.pi / 2, math.radians(35)), mat_name='trim', segs=10, mirror=True)
# corner lamps: can + chrome bezel + lens
for y in (18.5,):
    cyl('lamp_can', 3.6, 5, (71.5, y, 5.2), rot=(0, math.pi / 2, 0), mat_name='trim', segs=20, mirror=True, r2=4.2)
    cyl('lamp_bezel', 4.5, 1.4, (74.4, y, 5.2), rot=(0, math.pi / 2, 0), mat_name='chrome', segs=24, mirror=True)
    cyl('lamp_lens', 3.3, 0.6, (75.0, y, 5.2), rot=(0, math.pi / 2, 0), mat_name='light:head', segs=24, bevel=0, mirror=True)
box('drl', (1, 5, 1.2), (68.2, 12, 13.6), mat_name='light:head', bevel=0.3, mirror=True)

# ------------------------------------------------------------------ rear: frame, exhaust, tail lights, engine, canisters, intake, wing
box('rear_frame', (2.5, 26, 12), (-48.6, 0, 17.5), mat_name='trim', bevel=0.8)
for y in (8,):
    cyl('exhaust', 2.2, 7, (-49.5, y, 13), rot=(0, math.pi / 2, 0), mat_name='chrome', segs=16, mirror=True, r2=2.5)
    cyl('exhaust_in', 1.6, 1, (-53.2, y, 13), rot=(0, math.pi / 2, 0), mat_name='trim', segs=16, bevel=0, mirror=True)
box('tail', (1.2, 4, 6), (-55.3, 40.5, 37), rot=(0, math.radians(-25), 0), mat_name='light:tail', bevel=0.3, mirror=True)
box('tail_amber', (1.2, 4, 2.5), (-50.3, 40, 27.2), mat_name='light:amber', bevel=0.3, mirror=True)
box('engine_plinth', (22, 26, 4), (-36, 0, 32), mat_name='trim', bevel=1)
box('engine', (15, 18, 7.5), (-35, 0, 36.5), mat_name='chrome', bevel=1.5)
box('engine_cover', (11, 15, 4.4), (-37, 0, 41.2), mat_name='chrome:red', bevel=1.2)
for y in (10.5,):
    cyl('canister', 3, 10, (-45, y, 36), rot=(0, math.pi / 2, 0), mat_name='chrome:red', segs=16, mirror=True)
box('intake_base', (13, 15, 2), (-21, 0, 40.6), mat_name='trim', bevel=0.6)
box('intake', (11, 13, 6.5), (-21.5, 0, 45.5), mat_name='chrome:dark', bevel=1.4)
box('intake_mouth', (1, 10.5, 4.6), (-15.9, 0, 45.5), mat_name='trim', bevel=0.2)
# wing: aerofoil section extruded across, endplates, struts
bmw = bmesh.new()
prof = [(-55, 50.0), (-52.5, 52.6), (-44, 52.2), (-41, 51.0), (-46, 49.8)]
vs = []
for y in (-34, 34):
    vs.append([bmw.verts.new((x, y, z)) for x, z in prof])
for j in range(len(prof)):
    bmw.faces.new((vs[0][j], vs[1][j], vs[1][(j + 1) % len(prof)], vs[0][(j + 1) % len(prof)]))
bmw.faces.new(list(reversed(vs[0]))); bmw.faces.new(vs[1])
bmesh.ops.recalc_face_normals(bmw, faces=bmw.faces)
me = bpy.data.meshes.new('wing'); bmw.to_mesh(me); bmw.free(); set_mats(me, ['accent'])
wing = link(bpy.data.objects.new('wing', me))
bv = wing.modifiers.new('bevel', 'BEVEL'); bv.width = 0.5; bv.segments = 2
bme = bmesh.new()
ep = [(-56, 48), (-53, 55), (-41, 54), (-40, 50.5), (-44, 47.5)]
vs = [[bme.verts.new((x, y, z)) for x, z in ep] for y in (34, 35.6)]
for j in range(len(ep)):
    bme.faces.new((vs[0][j], vs[1][j], vs[1][(j + 1) % len(ep)], vs[0][(j + 1) % len(ep)]))
bme.faces.new(list(reversed(vs[0]))); bme.faces.new(vs[1])
bmesh.ops.recalc_face_normals(bme, faces=bme.faces)
me = bpy.data.meshes.new('endplate'); bme.to_mesh(me); bme.free(); set_mats(me, ['trim'])
ep_ob = link(bpy.data.objects.new('endplate', me))
md = ep_ob.modifiers.new('mirror', 'MIRROR'); md.use_axis = (False, True, False); md.mirror_object = ORIGIN
bv = ep_ob.modifiers.new('bevel', 'BEVEL'); bv.width = 0.4; bv.segments = 2
box('strut', (3, 1.6, 12), (-45.5, 13, 44), rot=(0, math.radians(-14), 0), mat_name='trim', bevel=0.4, mirror=True)
# front coilovers (red springs on dark shocks), visible between body and pods
cyl('spring', 1.9, 8, (49, 24.5, 4), rot=(0, math.radians(-14), 0), mat_name='chrome:red', segs=12, mirror=True)
cyl('shock', 0.8, 12, (49.3, 24.5, 4), rot=(0, math.radians(-14), 0), mat_name='chrome', segs=10, mirror=True)
box('pod_strut', (8, 6, 2.5), (51, 23, 16), mat_name='trim', bevel=0.6, mirror=True)

# ------------------------------------------------------------------ export: evaluated meshes -> compact quantised slots
SLOT_OF = lambda n: n.split(':')[0]
COLORS = {'light:head': (2.1, 2.2, 2.5), 'light:tail': (2.8, 0.06, 0.05), 'light:amber': (3.2, 1.3, 0.1),
          'chrome:red': (0.8, 0.07, 0.05), 'chrome:dark': (0.32, 0.33, 0.37)}
slots = {}
dg = bpy.context.evaluated_depsgraph_get()
tris_total = 0
for ob in list(scene.objects):
    if ob.type != 'MESH': continue
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
