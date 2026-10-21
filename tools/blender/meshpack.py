# TURBO PITCH — shared Blender -> game mesh export (used by import_octane.py, import_ball.py and
# arena_assets.py; run inside Blender's Python / bpy).
#
# Format (decoded by src/render/meshpack.js and the car body decoder): per material slot, quantised
# int16 positions (value * q, Blender axes x / y / z up), int8 normals, one palette index per vertex
# (uint8, into meta.palette), optional uint16 UVs (uv * uvq, so uv in [0, 65535 / uvq]) for slots
# listed in uv_slots, then
# uint16 / uint32 triangle indices. Every block is 4-byte aligned.
import bpy, struct, base64, json
from mathutils import Vector


def collect(objs, slot_of, xform, nxform=lambda n: n, q=64, uv_slots=(), uvq=65535):
    """Triangles of the evaluated objects, grouped by slot. slot_of(material) -> (slot, rgb)."""
    dg = bpy.context.evaluated_depsgraph_get()
    slots = {}
    for o in objs:
        ev = o.evaluated_get(dg); me = ev.to_mesh(); me.calc_loop_triangles()
        M = o.matrix_world
        N3 = M.to_3x3().inverted().transposed()
        flip = M.to_3x3().determinant() < 0          # mirrored instance: keep the winding outward
        cn = me.corner_normals
        uvl = me.uv_layers.active.data if me.uv_layers.active else None
        mats = list(o.material_slots)
        for lt in me.loop_triangles:
            if lt.area < 1e-10: continue            # collapsed by decimation
            m = mats[lt.material_index].material if mats and lt.material_index < len(mats) else None
            slot, col = slot_of(m)
            d = slots.setdefault(slot, {'v': {}, 'pos': [], 'nrm': [], 'col': [], 'uv': [], 'idx': []})
            loops = list(lt.loops)
            if flip: loops.reverse()
            for li in loops:
                p = xform(M @ me.vertices[me.loops[li].vertex_index].co)
                n = Vector(cn[li].vector)
                if n.length < 1e-6: n = Vector(lt.normal)   # decimation can leave degenerate corner normals
                n = nxform((N3 @ n).normalized())
                uv = (round(uvl[li].uv.x * uvq), round(uvl[li].uv.y * uvq)) if slot in uv_slots and uvl else (0, 0)
                key = (round(p.x * q), round(p.y * q), round(p.z * q), round(n.x * 100), round(n.y * 100), round(n.z * 100), col, uv)
                k = d['v'].get(key)
                if k is None:
                    k = len(d['pos']) // 3; d['v'][key] = k
                    d['pos'] += [key[0], key[1], key[2]]
                    d['nrm'] += [max(-127, min(127, round(c * 127))) for c in (n.x, n.y, n.z)]
                    d['col'].append(col)
                    d['uv'] += [max(0, min(65535, c)) for c in uv]
                d['idx'].append(k)
        ev.to_mesh_clear()
    return slots


def pack(slots, q=64, uv_slots=(), uvq=65535):
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
        part = {'slot': slot, 'nv': nv, 'ni': ni, 'off': len(blob), 'wide': wide}
        if uv_slots: part['uv'] = slot in uv_slots
        meta.append(part)
        if max(abs(v) for v in d['pos']) > 32767: raise ValueError(f'slot {slot}: positions overflow int16 at q={q}')
        blob += struct.pack(f'<{nv * 3}h', *d['pos'])
        blob += struct.pack(f'<{nv * 3}b', *d['nrm'])
        blob += bytes(ci)
        while len(blob) % 4: blob.append(0)
        if slot in uv_slots: blob += struct.pack(f'<{nv * 2}H', *d['uv'])
        blob += struct.pack(f'<{ni}{"I" if wide else "H"}', *d['idx'])
        while len(blob) % 4: blob.append(0)
    hdr = {'q': q, 'palette': palette, 'parts': meta}
    if uv_slots: hdr = {'q': q, 'uvq': uvq, 'palette': palette, 'parts': meta}
    return hdr, bytes(blob)


def write_module(path, comment, exports):
    """exports: {NAME: (hdr, blob)} -> NAME_META / NAME_B64 constants."""
    with open(path, 'w') as f:
        f.write(comment.rstrip('\n') + '\n')
        for name, (hdr, blob) in exports.items():
            f.write(f'export const {name}_META = {json.dumps(hdr)};\n')
            f.write(f'export const {name}_B64 = "{base64.b64encode(blob).decode()}";\n')
