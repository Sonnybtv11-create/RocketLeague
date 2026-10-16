# Refine a PnP camera by maximising silhouette IoU with the reference mask; draw overlays.
import numpy as np, cv2, json
from PIL import Image, ImageDraw
from scipy.optimize import minimize
import camfit as C

def proj(P, rv, tv, f, W=1920, H=1080):
    K = np.array([[f, 0, W / 2], [0, f, H / 2], [0, 0, 1]], float)
    uv, _ = cv2.projectPoints(P.reshape(-1, 3).astype(np.float64), np.asarray(rv, float), np.asarray(tv, float), K, None)
    return uv.reshape(P.shape[:-1] + (2,))

def raster(T, rv, tv, f, scale):
    uv = proj(T, rv, tv, f) * scale
    W, H = int(1920 * scale), int(1080 * scale)
    img = Image.new('L', (W, H), 0); d = ImageDraw.Draw(img)
    for t in uv: d.polygon([tuple(q) for q in t], fill=255)
    return np.array(img) > 0

def refine(T, ref, cam, scale=0.25, iters=2):
    refs = np.array(Image.fromarray(ref.astype(np.uint8) * 255).resize((int(1920 * scale), int(1080 * scale)), Image.BILINEAR)) > 127
    x0 = np.concatenate([cam['rv'], cam['tv'], [np.log(cam['f'])]])
    def loss(x):
        m = raster(T, x[:3], x[3:6], np.exp(x[6]), scale)
        return 1 - (m & refs).sum() / max((m | refs).sum(), 1)
    best = (loss(x0), x0)
    for _ in range(iters):
        r = minimize(loss, best[1], method='Powell', options={'maxiter': 3000, 'xtol': 1e-4, 'ftol': 1e-6})
        if r.fun < best[0]: best = (r.fun, r.x)
    x = best[1]
    return {'rv': x[:3].tolist(), 'tv': x[3:6].tolist(), 'f': float(np.exp(x[6])), 'iou': 1 - best[0]}
