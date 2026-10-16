# Silhouette check: rasterise the built model (+ wheels placed as in the blueprint) into each blueprint
# view's pixel grid and compare with the blueprint silhouette. Prints IoU per view, writes an overlay.
# Usage (inside Blender python, after building):  import compare; compare.run(objects, out_png)
import numpy as np
from PIL import Image, ImageDraw
import blueprint as BPM

# wheels as drawn in the blueprint (mesh rest pose): centre x, |y| centre, z, radius, half width
BP_WHEELS = [(51.25, 25.9, 0.7, 12.5, 6.0), (-33.75, 29.5, 4.9, 15.0, 7.0)]

def wheel_tris():
    tris = []
    for x, yc, z, r, hw in BP_WHEELS:
        for s in (1, -1):
            n = 24
            ring = [(x + r * np.cos(a), z + r * np.sin(a)) for a in np.linspace(0, 2 * np.pi, n, endpoint=False)]
            for y in (s * (yc - hw), s * (yc + hw)):
                for k in range(n):
                    a, b = ring[k], ring[(k + 1) % n]
                    tris.append(((x, y, z), (a[0], y, a[1]), (b[0], y, b[1])))
            for k in range(n):
                a, b = ring[k], ring[(k + 1) % n]
                y0, y1 = s * (yc - hw), s * (yc + hw)
                tris.append(((a[0], y0, a[1]), (b[0], y0, b[1]), (b[0], y1, b[1])))
                tris.append(((a[0], y0, a[1]), (b[0], y1, b[1]), (a[0], y1, a[1])))
    return np.array(tris)

def raster(tris_xyz, name, shape):
    """tris in car frame (x fwd, y right, z up) -> mask in the view's crop pixels"""
    v = BPM.VIEWS[name]
    x0, y0 = v['box'][0], v['box'][1]
    hmap = {'x': 0, 'y': 1, 'z': 2}
    H = tris_xyz[..., hmap[v['h']]]
    V = tris_xyz[..., hmap[v['v']]]
    cols = v['ox'] + v['hs'] * H * BPM.S - x0
    rows = v['oy'] - V * BPM.S - y0
    if name == 'top':  # top view: +y (car right) is drawn downwards (checked against the wing / exhaust)
        rows = v['oy'] + tris_xyz[..., 1] * BPM.S - y0
    SS = 4
    img = Image.new('L', (shape[1] * SS, shape[0] * SS), 0)
    d = ImageDraw.Draw(img)
    for c, r in zip(cols, rows):
        d.polygon([(c[k] * SS, r[k] * SS) for k in range(3)], fill=255)
    img = img.resize((shape[1], shape[0]), Image.BOX)
    return np.array(img) > 127

def run(tris_xyz, out_png):
    ms = BPM.masks()
    tris = tris_xyz
    rows_img = []
    report = {}
    for name in ('side', 'top', 'front', 'rear'):
        ref, v = ms[name]
        ours = raster(tris, name, ref.shape)
        if name != 'top':  # ignore the wheels (posed differently in the blueprint): drop the wheel zones
            ref = ref.copy(); ours = ours.copy()
            Z = (v['oy'] - (np.arange(ref.shape[0])[:, None] + v['box'][1])) / BPM.S
            Hc = (np.arange(ref.shape[1])[None, :] + v['box'][0] - v['ox']) / (BPM.S * v['hs'])
            if name == 'side':
                wz = ((Hc - 51.25) ** 2 + (Z - 0.7) ** 2 < 13.5 ** 2) | ((Hc + 33.75) ** 2 + (Z - 4.9) ** 2 < 16 ** 2)
            else:
                wz = (np.abs(Hc) > 19) & (Z < 4)
            ref &= ~wz; ours &= ~wz
        inter = (ref & ours).sum(); uni = (ref | ours).sum()
        report[name] = round(inter / max(uni, 1), 4)
        rgb = np.zeros(ref.shape + (3,), np.uint8)
        rgb[ref & ours] = (235, 235, 235)
        rgb[ref & ~ours] = (255, 40, 40)
        rgb[~ref & ours] = (0, 200, 255)
        rows_img.append(Image.fromarray(rgb).resize((ref.shape[1] * 4, ref.shape[0] * 4), Image.NEAREST))
    W = rows_img[0].size[0] + rows_img[2].size[0]
    Hh = rows_img[0].size[1] + rows_img[1].size[1]
    sheet = Image.new('RGB', (W, Hh))
    sheet.paste(rows_img[0], (0, 0)); sheet.paste(rows_img[1], (0, rows_img[0].size[1]))
    sheet.paste(rows_img[2], (rows_img[0].size[0], 0)); sheet.paste(rows_img[3], (rows_img[0].size[0], rows_img[2].size[1]))
    sheet.save(out_png)
    return report
