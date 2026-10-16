# Blueprint measurement: silhouette masks + profile curves (in uu) from the orthographic Octane
# blueprint (tools/blender/ref/octane_blueprint.png). Scale and origin are calibrated from the
# drawn hitbox rectangles (118.01 x 84.20 x 36.16 uu, offset x 13.88 / z 20.75): 1.805 px per uu.
import os, json
import numpy as np
from PIL import Image
from scipy import ndimage as ndi

HERE = os.path.dirname(os.path.abspath(__file__))
BP = os.path.join(HERE, 'ref', 'octane_blueprint.png')
S = 1.805
VIEWS = {   # origin px, horizontal sign (+uu -> right?), horizontal/vertical uu axes, crop box
  'side':  dict(ox=387.6, oy=160.8, hs=-1, h='x', v='z', box=(240, 75, 500, 185)),
  'top':   dict(ox=387.6, oy=288.0, hs=-1, h='x', v='y', box=(240, 205, 500, 375)),
  'front': dict(ox=116.0, oy=160.8, hs=-1, h='y', v='z', box=(30, 75, 205, 185)),
  'rear':  dict(ox=659.0, oy=160.8, hs=1,  h='y', v='z', box=(570, 75, 750, 185)),
}

def masks():
    im = np.array(Image.open(BP).convert('RGB')).astype(int)
    r, g, b = im[..., 0], im[..., 1], im[..., 2]
    grey = (np.abs(r - g) < 22) & (np.abs(g - b) < 22) & (r > 62)
    colored = (np.max(im, -1) - np.min(im, -1)) > 40
    out = {}
    for name, v in VIEWS.items():
        x0, y0, x1, y1 = v['box']
        m = grey[y0:y1, x0:x1].copy()
        c = colored[y0:y1, x0:x1]
        # bridge the coloured axis lines that cross the car
        m = m | (ndi.binary_dilation(m, iterations=2) & ndi.binary_dilation(c, iterations=1))
        m = ndi.binary_closing(m, iterations=2)
        m = ndi.binary_fill_holes(m)
        m = ndi.binary_opening(m, iterations=1)
        lab, n = ndi.label(m)
        if n:
            sizes = ndi.sum(m, lab, range(1, n + 1))
            keep = [i + 1 for i, s in enumerate(sizes) if s > 150]
            m = np.isin(lab, keep)
        out[name] = (m, v)
    return out

def to_uu(v, col, row):
    x0, y0 = v['box'][0], v['box'][1]
    hu = (col + x0 - v['ox']) / (S * v['hs'])
    vu = (v['oy'] - (row + y0)) / S
    return hu, vu

def profiles(step=1.0):
    ms = masks()
    res = {}
    for name, (m, v) in ms.items():
        cols = {}
        for col in range(m.shape[1]):
            rows = np.nonzero(m[:, col])[0]
            if len(rows) == 0: continue
            hu, top = to_uu(v, col, rows.min())
            _, bot = to_uu(v, col, rows.max())
            cols[round(hu, 2)] = (round(top, 2), round(bot, 2))
        res[name] = dict(sorted(cols.items()))
    return res, ms

if __name__ == '__main__':
    res, ms = profiles()
    json.dump({k: {str(a): b for a, b in v.items()} for k, v in res.items()}, open(os.path.join(HERE, 'ref', 'octane_profiles.json'), 'w'), indent=0)
    for name, (m, v) in ms.items():
        Image.fromarray((m * 255).astype(np.uint8)).resize((m.shape[1] * 4, m.shape[0] * 4), Image.NEAREST).save(f'/home/user/RocketLeague/shots/mask_{name}.png')
    for name, d in res.items():
        hs = sorted(d)
        print(name, 'h range', hs[0], hs[-1], 'v max', max(t for t, b in d.values()), 'v min', min(b for t, b in d.values()))
