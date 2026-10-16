# Visual-hull body from the orthographic blueprint silhouettes.
# For every station x the cross-section is { (y, z) : side(x,z) & top(x,y) & front(y,z) & rear(y,z) },
# limited to the body region (wing and intake stack are modelled separately). Each section's outline
# is traced, smoothed and resampled to N points starting at the top centre, then the stations are
# lofted into one closed quad mesh.
import numpy as np
from skimage import measure
from scipy import ndimage as ndi
import blueprint as BPM

N = 96            # points per section
RES = 0.25        # uu per raster cell for section tracing
_M = None

def _sampler():
    global _M
    if _M: return _M
    ms = BPM.masks()
    def make(name):
        m, v = ms[name]
        # soften one pixel so sampling at 0.25 uu is not noisy, keep the silhouette size
        m = ndi.binary_closing(m, iterations=1)
        x0, y0 = v['box'][0], v['box'][1]
        def f(hu, vu):
            col = np.rint(v['ox'] + v['hs'] * np.asarray(hu) * BPM.S - x0).astype(int)
            row = np.rint(v['oy'] - np.asarray(vu) * BPM.S - y0).astype(int)
            ok = (col >= 0) & (col < m.shape[1]) & (row >= 0) & (row < m.shape[0])
            out = np.zeros(np.broadcast(col, row).shape, bool)
            out[ok] = m[row[ok], col[ok]]
            return out
        return f
    _M = {k: make(k) for k in ('side', 'top', 'front', 'rear')}
    return _M

def section_mask(x, ys, zs, zmax=None, zmin=-9.5):
    M = _sampler()
    Y, Z = np.meshgrid(ys, zs)  # rows z, cols y
    X = np.full_like(Y, x)
    m = M['side'](X, Z) & M['top'](X, Y) & M['front'](Y, Z) & M['rear'](Y, Z)
    m &= Z >= zmin
    if zmax is not None: m &= Z <= zmax
    # symmetric: the car is mirror-symmetric, average the two halves
    m = m | m[:, ::-1]
    lab, n = ndi.label(m)
    if n == 0: return m
    sizes = ndi.sum(m, lab, range(1, n + 1))
    m = lab == (1 + int(np.argmax(sizes)))
    m = ndi.binary_fill_holes(m)
    return m

def section_outline(x, zmax_fn, n=N, smooth=2.0):
    ys = np.arange(-42, 42 + RES, RES)
    zs = np.arange(-8, 46 + RES, RES)
    m = section_mask(x, ys, zs, zmax=zmax_fn(x))
    if m.sum() < 12: return None
    pad = np.pad(m.astype(float), 2)
    pad = ndi.gaussian_filter(pad, smooth)
    cs = measure.find_contours(pad, 0.5)
    c = max(cs, key=len)
    zz = (c[:, 0] - 2) * RES + zs[0]
    yy = (c[:, 1] - 2) * RES + ys[0]
    pts = np.stack([yy, zz], 1)
    # symmetric resample: build the right half (y >= 0) from top centre to bottom centre, then mirror
    # make CCW in (y, z)
    area = 0.5 * np.sum(pts[:-1, 0] * pts[1:, 1] - pts[1:, 0] * pts[:-1, 1])
    if area < 0: pts = pts[::-1]
    # start at the topmost point near y = 0
    centre = np.abs(pts[:, 0]) < 1.5
    i0 = int(np.argmax(np.where(centre, pts[:, 1], -1e9)))
    pts = np.roll(pts, -i0, 0)
    seg = np.linalg.norm(np.diff(pts, axis=0, append=pts[:1]), axis=1)
    s = np.concatenate([[0], np.cumsum(seg)])
    L = s[-1]
    t = np.linspace(0, L, n, endpoint=False)
    closed = np.vstack([pts, pts[:1]])
    yi = np.interp(t, s, closed[:, 0]); zi = np.interp(t, s, closed[:, 1])
    # enforce mirror symmetry: point k and n-k are mirror images
    out = np.stack([yi, zi], 1)
    sym = out.copy()
    for k in range(1, n):
        a, b = out[k], out[n - k]
        sym[k] = [(a[0] - b[0]) / 2, (a[1] + b[1]) / 2]
    sym[0, 0] = 0
    if n % 2 == 0: sym[n // 2, 0] = 0
    return sym
