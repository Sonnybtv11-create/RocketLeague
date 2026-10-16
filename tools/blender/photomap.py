# Map surface materials from a calibrated reference photo onto mesh faces.
# Every face is projected with the solved camera; a painter's-algorithm ID buffer keeps only the
# visible pixels of each face; the photo colours under them vote for paint / dark (trim, glass) / red.
import numpy as np, cv2, json
from PIL import Image, ImageDraw

def project(P, cam):
    f = cam['f']; K = np.array([[f, 0, 960], [0, f, 540], [0, 0, 1]], float)
    uv, _ = cv2.projectPoints(P.reshape(-1, 3).astype(np.float64), np.asarray(cam['rv'], float), np.asarray(cam['tv'], float), K, None)
    R, _ = cv2.Rodrigues(np.asarray(cam['rv'], float))
    zc = (P.reshape(-1, 3) @ R.T + np.asarray(cam['tv'], float))[:, 2]
    return uv.reshape(P.shape[:-1] + (2,)), zc.reshape(P.shape[:-1])

def classify_pixels(rgb):
    r, g, b = [rgb[:, k].astype(int) for k in range(3)]
    mx = np.max(rgb, 1).astype(int); mn = np.min(rgb, 1).astype(int)
    lab = np.full(len(rgb), -1)
    blueish = (b > r + 18) & (b >= g - 12)
    lab[blueish & (mx > 30)] = 0                              # blue paint (lit or in shadow)
    lab[(mx < 70) & ~blueish & (np.abs(r - b) < 45)] = 1      # black / dark grey: trim, glass, tyres
    lab[(r > 120) & (r > g + 70) & (r > b + 60) & (g < 90)] = 2  # red parts
    lab[(mn > 150) & (mx - mn < 40)] = 3                     # chrome / white highlight
    return lab

def map_faces(faces, occluders, cam, photo_path, min_px=6):
    """faces: (F, 3 or 4, 3) polygons to classify (they also occlude); occluders: (T, 3, 3) extra triangles.
    returns per-face (label or -1, visible pixel count, label fractions)"""
    photo = np.array(Image.open(photo_path).convert('RGB'))
    H, W = photo.shape[:2]
    polys = [np.asarray(f) for f in faces] + [np.asarray(t) for t in occluders]
    nF = len(faces)
    uv, zc = [], []
    for p in polys:
        u, z = project(p, cam); uv.append(u); zc.append(z.mean())
    order = np.argsort(-np.array(zc))           # far first
    idimg = Image.new('RGB', (W, H), (0, 0, 0)); d = ImageDraw.Draw(idimg)
    for i in order:
        k = i + 1
        d.polygon([tuple(q) for q in uv[i]], fill=(k & 255, (k >> 8) & 255, (k >> 16) & 255))
    ids = np.array(idimg).astype(np.int64)
    ids = ids[..., 0] + (ids[..., 1] << 8) + (ids[..., 2] << 16) - 1
    flat = ids.ravel(); pix = photo.reshape(-1, 3)
    sel = (flat >= 0) & (flat < nF)
    fidx = flat[sel]; labs = classify_pixels(pix[sel])
    counts = np.zeros((nF, 4), int)
    for L in range(4):
        np.add.at(counts[:, L], fidx[labs == L], 1)
    total = np.bincount(fidx, minlength=nF)
    out = np.full(nF, -1)
    known = counts.sum(1)
    ok = (total >= min_px) & (known >= max(3, min_px // 2))
    out[ok] = np.argmax(counts[ok], 1)
    return out, total, counts
