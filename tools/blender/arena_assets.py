# TURBO PITCH — arena props modelled in Blender: goal structure, boost pads, floodlight rigs, roof trusses.
# Run:  <python with bpy> tools/blender/arena_assets.py [--preview out_prefix]
# Builds every prop from code into tools/blender/models/arena_assets.blend (one collection per prop,
# open it to inspect or tweak), then exports src/render/env/arenaAssets.js.
#
# Units: metres = game (three.js) units, Blender axes, z up.
#   goal       mouth plane at y = 0 (the back wall), the goal box extends towards +y (into the goal),
#              x across; the game mirrors it for the blue goal.
#   pads       centred on the origin, ground at z = 0.
#   floodlight lamps face -y, centred on the origin (the frame's centre).
#   roof_truss runs along +x from the roof's inner edge (origin), top following the roof underside.
# Material names start with the game slot they map to: paint (team colour), metal, dark, glow (team /
# pad glow colour), light (white-hot lamps). The rest of the name is free; the base colour becomes the
# vertex colour.
import bpy, bmesh, math, sys, os
from mathutils import Vector, Matrix

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(os.path.dirname(HERE))
sys.path.insert(0, HERE)
import meshpack  # noqa: E402

OUT = os.path.join(ROOT, 'src', 'render', 'env', 'arenaAssets.js')
BLEND = os.path.join(HERE, 'models', 'arena_assets.blend')
arg = lambda k, d=None: sys.argv[sys.argv.index(k) + 1] if k in sys.argv else d
PREVIEW = arg('--preview')

# arena constants (uu -> m), from src/contracts.js
GW, GH, GD = 892.755 / 100, 642.775 / 100, (6000 - 5120) / 100

bpy.ops.wm.read_factory_settings(use_empty=True)
scene = bpy.context.scene

# ------------------------------------------------------------------ materials
MATS = {}
def mat(name, rgb):
    if name not in MATS:
        m = bpy.data.materials.new(name)
        m.diffuse_color = (*rgb, 1)
        m.use_nodes = True
        m.node_tree.nodes['Principled BSDF'].inputs['Base Color'].default_value = (*rgb, 1)
        MATS[name] = m
    return MATS[name]

PAINT = mat('paint_frame', (1, 1, 1))
METAL = mat('metal_steel', (0.55, 0.57, 0.62))
METAL_D = mat('metal_gunmetal', (0.16, 0.17, 0.2))
DARK = mat('dark_panel', (0.035, 0.04, 0.05))
DARK2 = mat('dark_rubber', (0.018, 0.02, 0.024))
GLOW = mat('glow_strip', (1, 1, 1))
GLOW_DIM = mat('glow_dim', (0.45, 0.45, 0.45))
LAMP = mat('light_lamp', (2.4, 2.3, 2.1))

def slot_of(m):
    if not m: return 'dark', (0.05, 0.05, 0.05)
    slot = m.name.split('_')[0]
    rgb = tuple(m.node_tree.nodes['Principled BSDF'].inputs['Base Color'].default_value[:3])
    return slot, rgb

# ------------------------------------------------------------------ helpers
def new_obj(name, bm, mats, coll, smooth=True):
    me = bpy.data.meshes.new(name)
    bm.to_mesh(me); bm.free()
    for m in mats: me.materials.append(m)
    if smooth:
        for p in me.polygons: p.use_smooth = True
    o = bpy.data.objects.new(name, me)
    coll.objects.link(o)
    return o

def sweep(name, path, prof, mats, coll, closed_path=False, cap=False):
    """Sweep a closed 2D profile along a path in the xz plane (y = depth).
    path: [(x, z)], prof: [(a, b, mat_index)] where a is along the in-plane normal (right of the
    tangent) and b along +y; the edge from prof[i] to prof[i+1] gets mat_index of prof[i].
    Each profile edge gets its own vertices, so edges across the profile are sharp. Faces point along
    (profile direction) x (path tangent): list the profile so that comes out of the solid."""
    bm = bmesh.new()
    n = len(path)
    frames = []
    for i in range(n):
        p0 = Vector(path[max(0, i - 1)]); p1 = Vector(path[min(n - 1, i + 1)])
        if closed_path: p0 = Vector(path[(i - 1) % n]); p1 = Vector(path[(i + 1) % n])
        t = (p1 - p0).normalized()
        nrm = Vector((t.y, -t.x))           # right-hand normal in the xz plane
        frames.append((Vector(path[i]), nrm))
    m = len(prof)
    rings = []
    for (c, nrm) in frames:
        ring = []
        for (a, b, _) in prof:
            ring.append(bm.verts.new((c.x + nrm.x * a, b, c.y + nrm.y * a)))
        rings.append(ring)
    # duplicate per edge for sharp profile corners
    edge_rings = []
    for ring in rings:
        er = []
        for k in range(m):
            v0 = ring[k]; v1 = ring[(k + 1) % m]
            er.append((bm.verts.new(v0.co), bm.verts.new(v1.co)))
        edge_rings.append(er)
    for ring in rings:
        for v in ring: bm.verts.remove(v)
    segs = n if closed_path else n - 1
    for i in range(segs):
        A = edge_rings[i]; B = edge_rings[(i + 1) % n]
        for k in range(m):
            f = bm.faces.new((A[k][0], A[k][1], B[k][1], B[k][0]))
            f.material_index = prof[k][2]
    return new_obj(name, bm, mats, coll)

def lathe(name, prof, mats, coll, segs=48, phase=0.0):
    """Revolve [(r, z, mat_index)] about z; edge i -> i+1 gets prof[i] material; sharp profile edges.
    List the profile from the outside in, over the top: faces then point up / out."""
    bm = bmesh.new()
    m = len(prof)
    for k in range(m - 1):
        (r0, z0, mi), (r1, z1, _) = prof[k], prof[k + 1]
        ring0 = []; ring1 = []
        for s in range(segs):
            a = phase + s / segs * math.tau
            ring0.append(bm.verts.new((r0 * math.cos(a), r0 * math.sin(a), z0)))
            ring1.append(bm.verts.new((r1 * math.cos(a), r1 * math.sin(a), z1)))
        for s in range(segs):
            s2 = (s + 1) % segs
            vs = (ring0[s], ring0[s2], ring1[s2], ring1[s])
            if r0 < 1e-6: vs = (ring0[s], ring1[s2], ring1[s])
            elif r1 < 1e-6: vs = (ring0[s], ring0[s2], ring1[s])
            try:
                f = bm.faces.new(vs); f.material_index = mi
            except ValueError:
                pass
    bmesh.ops.remove_doubles(bm, verts=bm.verts, dist=1e-6)
    return new_obj(name, bm, mats, coll)

def box(name, size, loc, m, coll, bevel=0.02, rot=None, segments=2):
    bm = bmesh.new()
    bmesh.ops.create_cube(bm, size=1.0)
    bmesh.ops.scale(bm, vec=size, verts=bm.verts)
    if rot is not None: bmesh.ops.rotate(bm, matrix=rot, verts=bm.verts)
    bmesh.ops.translate(bm, vec=loc, verts=bm.verts)
    o = new_obj(name, bm, [m], coll, smooth=False)
    if bevel > 0:
        b = o.modifiers.new('bevel', 'BEVEL'); b.width = bevel; b.segments = segments; b.limit_method = 'ANGLE'
        b.harden_normals = True
        o.data.shade_smooth()  # bevel + harden normals: smooth rounded edges, flat faces
    return o

def rod(name, p0, p1, r, m, coll, segs=10):
    p0, p1 = Vector(p0), Vector(p1)
    d = p1 - p0
    bm = bmesh.new()
    bmesh.ops.create_cone(bm, cap_ends=True, segments=segs, radius1=r, radius2=r, depth=d.length)
    rot = d.normalized().to_track_quat('Z', 'Y').to_matrix().to_4x4()
    bmesh.ops.transform(bm, matrix=Matrix.Translation((p0 + p1) / 2) @ rot, verts=bm.verts)
    o = new_obj(name, bm, [m], coll, smooth=True)
    return o

def collection(name):
    c = bpy.data.collections.new(name); scene.collection.children.link(c); return c

# ================================================================== GOAL
goal = collection('goal')
W, D = 0.58, 0.78                  # frame beam: width in the mouth plane, depth along y
B_FRONT = -0.3                     # frame front face sticks 30 cm out of the back wall into the arena
XO, ZT, CR = GW + W / 2, GH + W / 2, 0.7

def mouth_path(xo, zt, cr, z0=0.0, n_arc=14, n_line=6):
    pts = []
    for k in range(n_line): pts.append((xo, z0 + (zt - cr - z0) * k / n_line))
    for k in range(n_arc + 1):
        a = k / n_arc * math.pi / 2
        pts.append((xo - cr + cr * math.cos(a), zt - cr + cr * math.sin(a)))
    for k in range(1, n_line * 2):
        pts.append((xo - cr - (2 * (xo - cr)) * k / (n_line * 2), zt))
    for k in range(n_arc + 1):
        a = math.pi / 2 + k / n_arc * math.pi / 2
        pts.append((-xo + cr + cr * math.cos(a), zt - cr + cr * math.sin(a)))
    for k in range(1, n_line + 1): pts.append((-xo, zt - cr - (zt - cr - z0) * k / n_line))
    return pts

# path runs up the +x post, over the bar, down the -x post: the right-hand normal points away from
# the opening (outward). Cross-section (a outward, b depth), chamfered, with:
#   - a recessed LED channel on the front face (glow at the bottom of the groove)
#   - a glowing strip on the inner face (towards the opening), set into a dark rubber gasket
h, c = W / 2, 0.05
b0, b1 = B_FRONT, B_FRONT + D
g0, g1, gd = -0.09, 0.09, 0.045      # front groove across a, depth
i0, i1 = B_FRONT + 0.10, B_FRONT + 0.34   # inner-face strip along b
PROF = [
    # front face (b = b0), from inner edge (a = -h) to outer edge (a = +h), with the groove
    (-h, b0 + c, 0), (-h + c, b0, 0), (g0, b0, 3), (g0, b0 + gd, 2), (g1, b0 + gd, 3), (g1, b0, 0), (h - c, b0, 0), (h, b0 + c, 0),
    # outer face (a = +h) back to the wall
    (h, b1, 1),
    # back face (inside the wall)
    (-h, b1, 0),
    # inner face (a = -h), from the back towards the front, with the glowing strip
    (-h, i1 + 0.02, 3), (-h + 0.012, i1, 2), (-h + 0.012, i0, 3), (-h, i0 - 0.02, 0),
]
sweep('goal_frame', mouth_path(XO, ZT, CR), PROF, [PAINT, METAL_D, GLOW, DARK2], goal)

# thin outer trim beam hugging the frame (metal), and a back plate where the frame meets the wall
sweep('goal_frame_trim', mouth_path(XO + h + 0.06, ZT + h + 0.06, CR + h + 0.06),
      [(-0.06, B_FRONT + 0.12, 0), (0.06, B_FRONT + 0.12, 0), (0.06, 0.05, 0), (-0.06, 0.05, 0)], [METAL_D], goal)

# lamp units on top of the crossbar, near each corner: housing + lens + cooling fins
for sx in (-1, 1):
    for k in range(3):
        x = sx * (GW - 0.7 - k * 0.62)
        zb = ZT + h
        box(f'goal_lamp_{sx}_{k}', (0.42, 0.34, 0.26), (x, B_FRONT + 0.22, zb + 0.13), METAL_D, goal, bevel=0.03)
        box(f'goal_lens_{sx}_{k}', (0.32, 0.03, 0.15), (x, B_FRONT + 0.04, zb + 0.14), LAMP, goal, bevel=0.012)
        for f in range(4):
            box(f'goal_fin_{sx}_{k}_{f}', (0.36, 0.02, 0.06), (x, B_FRONT + 0.3 + f * 0.05, zb + 0.29), METAL, goal, bevel=0.0)

# net support frame: rods along the edges of the net box + a mid arch (metal)
R = 0.055
nb = [(-GW, 0.15, GH), (GW, 0.15, GH), (GW, GD, GH), (-GW, GD, GH)]
rod('net_top_back', (-GW, GD, GH), (GW, GD, GH), R, METAL, goal)
for sx in (-1, 1):
    rod(f'net_top_side_{sx}', (sx * GW, 0.1, GH), (sx * GW, GD, GH), R, METAL, goal)
    rod(f'net_back_post_{sx}', (sx * GW, GD, 0), (sx * GW, GD, GH), R, METAL, goal)
    rod(f'net_mid_post_{sx}', (sx * GW, GD * 0.5, 0), (sx * GW, GD * 0.5, GH), R * 0.8, METAL, goal)
rod('net_mid_bar', (-GW, GD * 0.5, GH), (GW, GD * 0.5, GH), R * 0.8, METAL, goal)
rod('net_back_floor', (-GW, GD, 0.04), (GW, GD, 0.04), R, METAL, goal)
for xx in (-GW / 3, GW / 3):  # back verticals
    rod(f'net_back_v_{xx:.1f}', (xx, GD, 0), (xx, GD, GH), R * 0.7, METAL, goal)
# corner brackets where the rods meet
for p in nb[2:] + [(-GW, GD, 0.0), (GW, GD, 0.0)]:
    box(f'net_bracket_{p[0]:.1f}_{p[2]:.1f}', (0.18, 0.18, 0.18), p, METAL_D, goal, bevel=0.03)

# housing around the net box: panelled shell with ribs and recessed light bars, seen through the net
O = 0.7                                     # gap between the net and the housing
HX, HY, HZ = GW + O, GD + O, GH + O
PT = 0.06                                   # panel thickness
# back wall
box('house_back', (2 * HX, PT, HZ), (0, HY + PT / 2, HZ / 2), DARK, goal, bevel=0.0)
# side walls
for sx in (-1, 1):
    box(f'house_side_{sx}', (PT, HY - 0.1, HZ), (sx * (HX + PT / 2), (HY + 0.1) / 2, HZ / 2), DARK, goal, bevel=0.0)
# roof
box('house_roof', (2 * HX + 2 * PT, HY - 0.1, PT), (0, (HY + 0.1) / 2, HZ + PT / 2), DARK, goal, bevel=0.0)
# ribs: vertical on the back + sides, across the roof
RIB = 0.12
nrib = 9
for k in range(nrib + 1):
    x = -HX + 2 * HX * k / nrib
    box(f'rib_back_{k}', (RIB, 0.16, HZ), (x, HY - 0.06, HZ / 2), METAL_D, goal, bevel=0.02)
    box(f'rib_roof_{k}', (RIB, HY - 0.1, 0.16), (x, (HY + 0.1) / 2, HZ - 0.06), METAL_D, goal, bevel=0.02)
for sx in (-1, 1):
    for k in range(5):
        y = 0.4 + (HY - 0.5) * k / 4
        box(f'rib_side_{sx}_{k}', (0.16, RIB, HZ), (sx * (HX - 0.06), y, HZ / 2), METAL_D, goal, bevel=0.02)
# horizontal rails + recessed light bars on the back wall and sides
for zz, glow in ((0.18, False), (HZ * 0.34, True), (HZ * 0.68, True), (HZ - 0.25, False)):
    box(f'rail_back_{zz:.2f}', (2 * HX, 0.1, 0.1), (0, HY - 0.1, zz), METAL, goal, bevel=0.02)
    if glow:
        box(f'bar_back_{zz:.2f}', (2 * HX - 0.6, 0.03, 0.12), (0, HY - 0.015, zz + 0.2), GLOW_DIM, goal, bevel=0.0)
        for sx in (-1, 1):
            box(f'bar_side_{sx}_{zz:.2f}', (0.03, HY - 0.8, 0.12), (sx * (HX - 0.015), HY / 2, zz + 0.2), GLOW_DIM, goal, bevel=0.0)
# roof light bars running front to back
for xx in (-HX * 0.5, 0, HX * 0.5):
    box(f'bar_roof_{xx:.1f}', (0.14, HY - 0.9, 0.03), (xx + 0.35, HY / 2, HZ - 0.015), GLOW_DIM, goal, bevel=0.0)

# ================================================================== BIG PAD
big = collection('big_pad')
# stepped pedestal: outer bevelled ring, vent deck, inner raised collar, glowing well with emitter dish
lathe('big_base', [
    (1.42, 0.0, 0), (1.42, 0.05, 0), (1.38, 0.09, 0), (1.18, 0.11, 1),   # outer ring (metal) + top
    (1.12, 0.09, 1), (0.9, 0.09, 0),                                     # vent deck (dark)
    (0.86, 0.13, 0), (0.82, 0.19, 0), (0.74, 0.21, 2),                   # collar
    (0.70, 0.19, 1), (0.66, 0.08, 1), (0.36, 0.06, 0),                   # well wall + floor
    (0.30, 0.10, 0), (0.0, 0.12, 0),                                     # emitter dish
], [METAL, DARK, METAL_D], big, segs=64)
# glow ring in the well + emitter disc
lathe('big_glow', [(0.655, 0.085, 0), (0.42, 0.075, 0)], [GLOW], big, segs=64)
lathe('big_glow_core', [(0.27, 0.115, 0), (0.0, 0.13, 0)], [GLOW], big, segs=48)
# six radial vents (slots with fins) on the deck and three lamp lobes
for k in range(6):
    a = k / 6 * math.tau
    rot = Matrix.Rotation(a, 3, 'Z')
    for f in range(3):
        loc = rot @ Vector((1.0 + f * 0.07, 0, 0.1))
        box(f'big_vent_{k}_{f}', (0.035, 0.22, 0.03), loc, DARK2, big, bevel=0.0, rot=rot)
for k in range(3):
    a = k / 3 * math.tau + math.pi / 6
    rot = Matrix.Rotation(a, 3, 'Z')
    loc = rot @ Vector((1.52, 0, 0.07))
    box(f'big_lobe_{k}', (0.42, 0.56, 0.14), loc, METAL_D, big, bevel=0.035, rot=rot)
    box(f'big_lobe_lamp_{k}', (0.26, 0.4, 0.03), rot @ Vector((1.55, 0, 0.145)), GLOW, big, bevel=0.0, rot=rot)

# ================================================================== SMALL PAD
small = collection('small_pad')
lathe('small_base', [
    (0.78, 0.0, 0), (0.78, 0.03, 0), (0.74, 0.06, 0), (0.6, 0.07, 1),
    (0.56, 0.06, 1), (0.44, 0.06, 0), (0.42, 0.085, 0), (0.38, 0.09, 1),
    (0.34, 0.05, 1), (0.0, 0.05, 0),
], [METAL, DARK, METAL_D], small, segs=48)
lathe('small_glow', [(0.335, 0.06, 0), (0.0, 0.07, 0)], [GLOW], small, segs=40)
lathe('small_glow_ring', [(0.58, 0.072, 0), (0.46, 0.072, 0)], [GLOW_DIM], small, segs=48)
for k in range(4):
    a = k / 4 * math.tau + math.pi / 4
    rot = Matrix.Rotation(a, 3, 'Z')
    box(f'small_notch_{k}', (0.16, 0.06, 0.05), rot @ Vector((0.62, 0, 0.06)), METAL_D, small, bevel=0.015, rot=rot)

# ================================================================== FLOODLIGHT BANK
# A roof-edge floodlight rig, lamps facing -y (the game turns -y towards the pitch): a back beam on two
# yoke arms, a frame holding 2 x 5 lamp heads (housing, rim, visor, glowing lens), cable trays.
flood = collection('floodlight')
box('fl_beam', (4.2, 0.3, 0.3), (0, 0.55, 0.0), METAL_D, flood, bevel=0.04)
for sx in (-1, 1):
    box(f'fl_arm_{sx}', (0.16, 0.6, 0.16), (sx * 1.7, 0.25, 0.0), METAL, flood, bevel=0.03)
box('fl_frame_top', (4.0, 0.14, 0.12), (0, 0.0, 0.78), METAL_D, flood, bevel=0.02)
box('fl_frame_bot', (4.0, 0.14, 0.12), (0, 0.0, -0.78), METAL_D, flood, bevel=0.02)
for sx in (-1, 1):
    box(f'fl_frame_side_{sx}', (0.12, 0.14, 1.68), (sx * 2.0, 0.0, 0.0), METAL_D, flood, bevel=0.02)
for row, z in enumerate((0.38, -0.38)):
    for k in range(5):
        x = -1.56 + k * 0.78
        # housing: lathe around the local y axis -> build around z then rotate
        o = lathe(f'fl_head_{row}_{k}', [
            (0.0, -0.42, 1), (0.28, -0.42, 1), (0.33, -0.06, 0), (0.36, 0.03, 0),
            (0.29, 0.0, 2), (0.0, 0.0, 2)],
            [METAL, METAL_D, LAMP], flood, segs=12)
        o.rotation_euler = (math.radians(90), 0, 0)
        o.location = (x, -0.05, z)
        # visor over the top half of the lens
        v = box(f'fl_visor_{row}_{k}', (0.66, 0.16, 0.03), (x, -0.13, z + 0.33), METAL_D, flood, bevel=0.0)
for k in range(3):
    box(f'fl_tray_{k}', (3.9, 0.08, 0.05), (0, 0.18, 0.62 - k * 0.62), DARK2, flood, bevel=0.0)

# ================================================================== ROOF TRUSS
# Triangular steel truss hung under the roof ring, running outward (+x) 17 m from the roof's inner
# edge; its top follows the roof underside (2.2 m drop over the span), 1.5 m deep.
truss = collection('roof_truss')
L, DROP, DEPTH, HW = 17.0, 2.2, 1.5, 0.7
top = lambda x: -0.15 - DROP * x / L
CH = 0.09
for sy in (-1, 1):
    rod(f'tr_top_{sy}', (0, sy * HW, top(0)), (L, sy * HW, top(L)), CH, METAL_D, truss, segs=6)
rod('tr_bottom', (0.4, 0, top(0.4) - DEPTH), (L - 0.4, 0, top(L - 0.4) - DEPTH), CH * 1.2, METAL_D, truss, segs=6)
NP = 12
for k in range(NP + 1):
    x = 0.4 + (L - 0.8) * k / NP
    x2 = 0.4 + (L - 0.8) * (k + 0.5) / NP
    rod(f'tr_cross_{k}', (x, -HW, top(x)), (x, HW, top(x)), CH * 0.5, METAL, truss, segs=6)
    if k < NP:
        for sy in (-1, 1):
            rod(f'tr_diag_a_{k}_{sy}', (x, sy * HW, top(x)), (x2, 0, top(x2) - DEPTH), CH * 0.45, METAL, truss, segs=6)
            x3 = 0.4 + (L - 0.8) * (k + 1) / NP
            rod(f'tr_diag_b_{k}_{sy}', (x2, 0, top(x2) - DEPTH), (x3, sy * HW, top(x3)), CH * 0.45, METAL, truss, segs=6)
# end plates where it meets the roof edge and the back pylon
box('tr_plate_in', (0.12, 1.7, 1.9), (0.05, 0, top(0) - 0.85), METAL_D, truss, bevel=0.02)
box('tr_plate_out', (0.12, 1.7, 1.9), (L - 0.05, 0, top(L) - 0.85), METAL_D, truss, bevel=0.02)

# ------------------------------------------------------------------ save, preview, export
bpy.ops.wm.save_as_mainfile(filepath=BLEND)

def tris(coll):
    dg = bpy.context.evaluated_depsgraph_get(); n = 0
    for o in coll.objects:
        me = o.evaluated_get(dg).to_mesh(); me.calc_loop_triangles(); n += len(me.loop_triangles); o.evaluated_get(dg).to_mesh_clear()
    return n

exports = {}
Q = 16   # 1/16 uu precision, range ±2048 uu
for name, coll in (('GOAL', goal), ('BIG_PAD', big), ('SMALL_PAD', small), ('FLOODLIGHT', flood), ('ROOF_TRUSS', truss)):
    hdr, blob = meshpack.pack(meshpack.collect(list(coll.objects), slot_of, lambda p: p * 100, q=Q), q=Q)
    exports[name] = (hdr, blob)
    print(name, 'tris', tris(coll), {m['slot']: m['ni'] // 3 for m in hdr['parts']}, 'bytes', len(blob))
meshpack.write_module(OUT, '// GENERATED by tools/blender/arena_assets.py (source: tools/blender/models/arena_assets.blend) — do not edit.\n'
                      '// Arena props: quantised positions (uu * q, Blender axes x / y / z up), int8 normals, palette colours,\n'
                      '// per slot (paint / metal / dark / glow / light). Decode with render/meshpack.js (scale 1/100).', exports)

if PREVIEW:
    sc = scene
    sc.render.engine = 'BLENDER_WORKBENCH'
    sh = sc.display.shading
    sh.light = 'STUDIO'; sh.color_type = 'MATERIAL'; sh.show_cavity = True; sh.cavity_type = 'BOTH'
    sh.background_type = 'WORLD'; sc.world = bpy.data.worlds.new('w'); sc.world.color = (0.19, 0.19, 0.19)
    PAINT.diffuse_color = (0.1, 0.3, 0.9, 1); GLOW.diffuse_color = (0.4, 0.8, 1.0, 1); GLOW_DIM.diffuse_color = (0.3, 0.6, 0.9, 1); LAMP.diffuse_color = (1, 1, 0.9, 1)
    for m in MATS.values():
        if m not in (PAINT, GLOW, GLOW_DIM, LAMP): m.diffuse_color = (*m.node_tree.nodes['Principled BSDF'].inputs['Base Color'].default_value[:3], 1)
    sc.render.resolution_x = 960; sc.render.resolution_y = 600
    cam = bpy.data.objects.new('cam', bpy.data.cameras.new('cam')); sc.collection.objects.link(cam); sc.camera = cam
    def shoot(fname, target, dist, az, el, lens=35, only=None):
        for c in (goal, big, small, flood, truss): c.hide_render = only is not None and c is not only
        a, e = math.radians(az), math.radians(el)
        cam.data.lens = lens
        cam.location = Vector(target) + dist * Vector((math.cos(e) * math.cos(a), math.cos(e) * math.sin(a), math.sin(e)))
        cam.rotation_euler = (Vector(target) - cam.location).to_track_quat('-Z', 'Y').to_euler()
        sc.render.filepath = f'{PREVIEW}-{fname}.png'
        bpy.ops.render.render(write_still=True)
    shoot('goal-front', (0, 2, 3.2), 26, -90, 12, only=goal)
    shoot('goal-34', (0, 3, 3.2), 24, -60, 22, only=goal)
    shoot('goal-corner', (GW, 0, GH), 6, -55, 25, only=goal)
    shoot('goal-inside', (0, GD, 3), 9, -100, 8, lens=24, only=goal)
    shoot('big', (0, 0, 0.1), 7, -60, 35, only=big)
    shoot('small', (0, 0, 0.05), 4, -60, 35, only=small)
    shoot('flood', (0, 0, 0), 9, -110, 15, only=flood)
    shoot('truss', (8.5, 0, -1.5), 20, -70, -10, only=truss)
