# Fit a pinhole camera to a reference render by maximising silhouette overlap with our model.
# Model frame: Blender (x fwd, y left, z up, uu). Wheels added in the blueprint pose.
import sys, json, numpy as np
from PIL import Image, ImageDraw
from scipy.optimize import minimize

def wheels():
    T = []
    for x, yc, z, r, hw in [(51.25, 25.9, 0.7, 12.5, 6.0), (-33.75, 29.5, 4.9, 15.0, 7.0)]:
        for s in (1, -1):
            n = 20
            ring = [(x + r * np.cos(a), z + r * np.sin(a)) for a in np.linspace(0, 2 * np.pi, n, endpoint=False)]
            for y in (s * (yc - hw), s * (yc + hw)):
                for k in range(n):
                    a, b = ring[k], ring[(k + 1) % n]
                    T.append(((x, y, z), (a[0], y, a[1]), (b[0], y, b[1])))
            for k in range(n):
                a, b = ring[k], ring[(k + 1) % n]; y0, y1 = s * (yc - hw), s * (yc + hw)
                T.append(((a[0], y0, a[1]), (b[0], y0, b[1]), (b[0], y1, b[1])))
                T.append(((a[0], y0, a[1]), (b[0], y1, b[1]), (a[0], y1, a[1])))
    return np.array(T, np.float32)

def camera(p):
    az, el, dist, tx, ty, tz, roll, f = p
    a, e = np.radians(az), np.radians(el)
    target = np.array([tx, ty, tz])
    eye = target + dist * np.array([np.cos(e) * np.cos(a), np.cos(e) * np.sin(a), np.sin(e)])
    fwd = target - eye; fwd /= np.linalg.norm(fwd)
    right = np.cross(fwd, [0, 0, 1]); right /= np.linalg.norm(right)
    up = np.cross(right, fwd)
    cr, sr = np.cos(np.radians(roll)), np.sin(np.radians(roll))
    right, up = right * cr + up * sr, -right * sr + up * cr
    return eye, fwd, right, up, f

def project(P, p, W, H):
    eye, fwd, right, up, f = camera(p)
    d = P - eye
    zc = d @ fwd
    x = (d @ right) / zc * f; y = (d @ up) / zc * f
    return np.stack([W / 2 + x * W, H / 2 - y * W], -1), zc   # f in units of image width

def raster(T, p, W, H):
    uv, zc = project(T.reshape(-1, 3), p, W, H)
    uv = uv.reshape(-1, 3, 2)
    img = Image.new('L', (W, H), 0); d = ImageDraw.Draw(img)
    for t in uv: d.polygon([tuple(q) for q in t], fill=255)
    return np.array(img) > 0

def fit(T, ref, p0, W=480, H=270):
    refs = np.array(Image.fromarray(ref.astype(np.uint8) * 255).resize((W, H), Image.BILINEAR)) > 127
    def loss(p):
        m = raster(T, p, W, H)
        return 1 - (m & refs).sum() / max((m | refs).sum(), 1)
    best = (loss(p0), p0)
    for it in range(3):
        r = minimize(loss, best[1], method='Powell', options={'maxiter': 3000, 'xtol': 1e-3, 'ftol': 1e-5})
        if r.fun < best[0]: best = (r.fun, r.x)
    return best
