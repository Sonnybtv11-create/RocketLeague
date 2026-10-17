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
    Each profile edge gets its own vertices, so edges across the profile are sharp; faces are wound
    to point away from the profile's centre. cap=True closes the two ends (mat of prof[0])."""
    bm = bmesh.new()
    n = len(path)
    frames = []
    for i in range(n):
        p0 = Vector(path[max(0, i - 1)]); p1 = Vector(path[min(n - 1, i + 1)])
        if closed_path: p0 = Vector(path[(i - 1) % n]); p1 = Vector(path[(i + 1) % n])
        t = (p1 - p0).normalized()
        frames.append((Vector(path[i]), Vector((t.y, -t.x))))   # right-hand normal in the xz plane
    m = len(prof)
    ca = sum(p[0] for p in prof) / m; cb = sum(p[1] for p in prof) / m
    P = lambda c, nrm, a, b: Vector((c.x + nrm.x * a, b, c.y + nrm.y * a))
    segs = n if closed_path else n - 1
    for k in range(m):
        (a0, b0, mi), (a1, b1, _) = prof[k], prof[(k + 1) % m]
        ea, eb = b1 - b0, -(a1 - a0)                      # edge normal in the section
        if ea * ((a0 + a1) / 2 - ca) + eb * ((b0 + b1) / 2 - cb) < 0: ea, eb = -ea, -eb
        col = [(bm.verts.new(P(c, nrm, a0, b0)), bm.verts.new(P(c, nrm, a1, b1)), nrm) for c, nrm in frames]
        for i in range(segs):
            (A0, A1, nrm), (B0, B1, _) = col[i], col[(i + 1) % n]
            out = Vector((nrm.x * ea, eb, nrm.y * ea))
            vs = [A0, A1, B1, B0]
            fn = (A1.co - A0.co).cross(B0.co - A0.co)
            if fn.dot(out) < 0: vs.reverse()
            f = bm.faces.new(vs); f.material_index = mi
    if cap and not closed_path:
        for idx, sgn in ((0, -1), (n - 1, 1)):
            c, nrm = frames[idx]
            vs = [bm.verts.new(P(c, nrm, a, b)) for (a, b, _) in prof]
            f = bm.faces.new(vs); f.material_index = prof[0][2]
            t = Vector(path[min(n - 1, idx + 1)]) - Vector(path[max(0, idx - 1)])
            out = Vector((t.x, 0, t.y)) * sgn
            f.normal_update()
            if f.normal.dot(out) < 0: f.normal_flip()
    return new_obj(name, bm, mats, coll)

def fillet_path(pts, r, n_arc=8):
    """Polyline [(x, z)] with every interior corner rounded to radius r (clamped to fit)."""
    out = [pts[0]]
    for i in range(1, len(pts) - 1):
        p0, p1, p2 = Vector(pts[i - 1]), Vector(pts[i]), Vector(pts[i + 1])
        d0 = (p0 - p1).normalized(); d1 = (p2 - p1).normalized()
        ang = math.acos(max(-1, min(1, d0.dot(d1))))
        if ang > math.pi - 1e-3: out.append(pts[i]); continue
        t = r / math.tan(ang / 2)
        t = min(t, (p0 - p1).length * 0.45, (p2 - p1).length * 0.45)
        rr = t * math.tan(ang / 2)
        a = p1 + d0 * t; b = p1 + d1 * t
        bis = (d0 + d1).normalized()
        cen = p1 + bis * math.hypot(t, rr)
        va, vb = a - cen, b - cen
        a0 = math.atan2(va.y, va.x); a1 = math.atan2(vb.y, vb.x)
        da = (a1 - a0 + math.pi) % (2 * math.pi) - math.pi
        for k in range(n_arc + 1):
            q = a0 + da * k / n_arc
            out.append((cen.x + rr * math.cos(q), cen.y + rr * math.sin(q)))
    out.append(pts[-1])
    return out

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
# Modelled on the DFH Stadium goal (refs/dfh): a thick gunmetal rounded-rectangle ring around the mouth
# with thin LED lines along its front edges and a lit strip on its inner face, a slimmer ring at the
# back of the goal joined to it by rails along the rounded top edges, "wings" that run out from the
# top corners and slope down the back wall, two lamp lanterns on each top corner, and dark slatted
# grate walls (sides, roof, back) with team light strips between the slats.
goal = collection('goal')
FRAME = mat('metal_frame', (0.15, 0.16, 0.19))
FRAME_L = mat('metal_light', (0.62, 0.64, 0.69))
GRATE = mat('metal_grate', (0.34, 0.35, 0.39))
GRATE_BACK = mat('dark_grateback', (0.1, 0.105, 0.12))

def mouth_path(xo, zt, cr, z0=0.0, n_arc=16, n_line=6):
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

# --- front ring: section 0.8 wide (inner face flush with the goal box), 1.45 deep, 45 cm proud of
# the wall. Path runs up the +x post, over the bar, down the -x post; a points away from the opening.
h, c = 0.4, 0.12
XO, ZT, CR = GW + h, GH + h, 2.3
b0, b1 = -0.45, 1.0
g = 0.025                                   # LED groove depth
RING = [
    (-h, b0 + c, 1), (-h + c, b0, 1),                                       # inner chamfer (silver front face)
    (-h + 0.13, b0, 2), (-h + 0.13, b0 + g, 2), (-h + 0.23, b0 + g, 1), (-h + 0.23, b0, 1),   # inner LED line
    (h - 0.27, b0, 2), (h - 0.27, b0 + g, 2), (h - 0.17, b0 + g, 1), (h - 0.17, b0, 1),       # outer LED line
    (h - c, b0, 2), (h, b0 + c, 0),                                         # outer chamfer (lit edge)
    (h, b1, 0), (-h, b1, 1),                                                # outer face, back
    (-h, 0.46, 2), (-h + 0.02, 0.44, 1), (-h + 0.02, 0.30, 2), (-h, 0.28, 1),  # lit strip on the inner face
]
sweep('goal_ring', mouth_path(XO, ZT, CR), RING, [FRAME, FRAME_L, GLOW], goal)

# --- back ring + rails along the rounded top edges
h2 = 0.26
BACK = [(-h2, -0.26, 0), (-0.05, -0.26, 2), (-0.05, -0.24, 2), (0.05, -0.24, 0), (0.05, -0.26, 0), (h2, -0.26, 0), (h2, 0.26, 0), (-h2, 0.26, 0)]
yb = GD - 0.4                               # just inside the back grate: framed portal deep in the goal
sweep('goal_back_ring', mouth_path(GW + h2, GH + h2, 2.0), [(a, bb + yb, m) for a, bb, m in BACK], [FRAME, FRAME_L, GLOW], goal)
for sx in (-1, 1):
    x45 = sx * (XO - CR + CR * math.cos(math.radians(45)))
    z45 = ZT - CR + CR * math.sin(math.radians(45))
    rod(f'goal_top_rail_{sx}', (x45 - sx * 0.25, b1 - 0.05, z45 - 0.25), (sx * (GW + h2 - 2.0 + 2.0 * 0.7071) - sx * 0.1, yb, GH + h2 - 2.0 + 2.0 * 0.7071 - 0.1), 0.17, FRAME, goal, segs=12)
    rod(f'goal_floor_rail_{sx}', (sx * (GW + 0.25), b1 - 0.05, 0.12), (sx * (GW + 0.25), yb, 0.12), 0.14, FRAME, goal, segs=10)

# --- wings: out from the top corners, sloping down the back wall (12 cm proud of it)
WING = [(-0.22, -0.12, 0), (-0.05, -0.12, 2), (-0.05, -0.1, 2), (0.05, -0.1, 0), (0.05, -0.12, 0), (0.22, -0.12, 0), (0.22, 0.4, 0), (-0.22, 0.4, 0)]
for sx in (-1, 1):
    pts = [(XO + h - 0.15, GH - 0.25), (GW + 3.2, GH - 0.25), (GW + 6.6, 3.0), (GW + 11.0, 3.0)]
    path = fillet_path([(sx * x, z) for x, z in pts], 0.9)
    sweep(f'goal_wing_{sx}', path, WING, [FRAME, FRAME_L, GLOW], goal, cap=True)
    for x, z in ((GW + 3.2, GH - 0.25), (GW + 6.6, 3.0)):           # mounting brackets at the bends
        box(f'goal_wing_bracket_{sx}_{x:.1f}', (0.5, 0.25, 0.55), (sx * x, 0.42, z), METAL_D, goal, bevel=0.04)

# --- lanterns on the top corners
for sx in (-1, 1):
    for k, x in enumerate((GW - 1.55, GW - 2.3)):
        o = lathe(f'goal_lamp_{sx}_{k}', [
            (0.27, 0.0, 0), (0.27, 0.07, 0), (0.22, 0.09, 0),      # base (metal)
            (0.2, 0.09, 1), (0.2, 0.5, 1),                          # glowing body
            (0.24, 0.52, 0), (0.24, 0.6, 0), (0.12, 0.64, 0), (0.0, 0.64, 0)],   # cap
            [METAL_D, GLOW], goal, segs=20)
        o.location = (sx * x, 0.25, ZT + h)

# --- grate walls just outside the goal box: slats over a dark backing, light strips in some gaps
SL, GAP = 0.12, 0.34
nz = int(GH / GAP)
for sx in (-1, 1):
    X0 = sx * (GW + 0.08)
    box(f'grate_side_back_{sx}', (0.04, GD - b1, GH), (sx * (GW + 0.3), (GD + b1) / 2, GH / 2), GRATE_BACK, goal, bevel=0.0)
    for k in range(nz):
        z = (k + 0.5) * GAP
        box(f'grate_side_{sx}_{k}', (0.08, GD - b1, SL), (X0 + sx * 0.04, (GD + b1) / 2, z), GRATE, goal, bevel=0.015)
        if k % 3 == 1:
            box(f'grate_side_led_{sx}_{k}', (0.02, GD - b1 - 0.4, 0.06), (sx * (GW + 0.27), (GD + b1) / 2, z + GAP / 2), GLOW, goal, bevel=0.0)
    for y in (b1 + 0.2, (GD + b1) / 2, GD - 0.2):                 # vertical posts holding the slats
        box(f'grate_side_post_{sx}_{y:.1f}', (0.14, 0.14, GH), (sx * (GW + 0.2), y, GH / 2), METAL_D, goal, bevel=0.02)
# back wall
box('grate_back_back', (2 * GW, 0.04, GH), (0, GD + 0.3, GH / 2), GRATE_BACK, goal, bevel=0.0)
for k in range(nz):
    z = (k + 0.5) * GAP
    box(f'grate_back_{k}', (2 * GW, 0.08, SL), (0, GD + 0.12, z), GRATE, goal, bevel=0.015)
    if k % 3 == 1:
        box(f'grate_back_led_{k}', (2 * GW - 0.6, 0.02, 0.06), (0, GD + 0.27, z + GAP / 2), GLOW, goal, bevel=0.0)
for x in (-GW * 0.66, -GW * 0.33, 0, GW * 0.33, GW * 0.66):
    box(f'grate_back_post_{x:.1f}', (0.14, 0.14, GH), (x, GD + 0.2, GH / 2), METAL_D, goal, bevel=0.02)
# roof: slats running front to back
box('grate_roof_back', (2 * GW, GD - b1, 0.04), (0, (GD + b1) / 2, GH + 0.3), GRATE_BACK, goal, bevel=0.0)
nr = int(2 * GW / GAP)
for k in range(nr):
    x = -GW + (k + 0.5) * (2 * GW / nr)
    box(f'grate_roof_{k}', (SL, GD - b1, 0.08), (x, (GD + b1) / 2, GH + 0.12), GRATE, goal, bevel=0.015)
    if k % 4 == 2:
        box(f'grate_roof_led_{k}', (0.06, GD - b1 - 0.4, 0.02), (x + GAP / 2, (GD + b1) / 2, GH + 0.27), GLOW, goal, bevel=0.0)
for y in (b1 + 1.0, (GD + b1) / 2, GD - 0.4):
    box(f'grate_roof_beam_{y:.1f}', (2 * GW, 0.16, 0.16), (0, y, GH + 0.2), METAL_D, goal, bevel=0.02)

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
    shoot('goal-front', (0, 2, 3.6), 30, -90, 8, only=goal)
    shoot('goal-34', (0, 3, 3.6), 28, -55, 18, only=goal)
    shoot('goal-corner', (GW, 0, GH), 7, -60, 28, only=goal)
    shoot('goal-inside', (0, GD, 3), 9, -100, 8, lens=24, only=goal)
    shoot('big', (0, 0, 0.1), 7, -60, 35, only=big)
    shoot('small', (0, 0, 0.05), 4, -60, 35, only=small)
    shoot('flood', (0, 0, 0), 9, -110, 15, only=flood)
    shoot('truss', (8.5, 0, -1.5), 20, -70, -10, only=truss)
