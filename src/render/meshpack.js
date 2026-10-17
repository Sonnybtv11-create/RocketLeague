// TURBO PITCH — decoder for meshes exported from Blender by tools/blender/meshpack.py.
// decodeMesh(meta, b64, { scale, blenderAxes }) -> { [slot]: indexed BufferGeometry }
//   scale        multiplies the dequantised positions (e.g. 1/100: uu -> metres)
//   blenderAxes  true: Blender (x, y, z up) -> three (x, z, -y); false: positions used as stored
// Every geometry carries position, normal and a vertex colour (from the palette); slots exported
// with UVs also get a uv attribute.
import * as THREE from 'three';

export function decodeMesh(meta, b64, { scale = 1, blenderAxes = true } = {}) {
  const bin = Uint8Array.from(atob(b64), (c) => c.charCodeAt(0)).buffer;
  const q = scale / meta.q, out = {};
  for (const { nv, ni, off, wide, slot, uv } of meta.parts) {
    let o = off;
    const P = new Int16Array(bin, o, nv * 3); o += nv * 6;
    const N = new Int8Array(bin, o, nv * 3); o += nv * 3;
    const C = new Uint8Array(bin, o, nv); o += nv;
    o = (o + 3) & ~3;
    let U = null;
    if (uv) { U = new Uint16Array(bin, o, nv * 2); o += nv * 4; }
    const I = wide ? new Uint32Array(bin, o, ni) : new Uint16Array(bin, o, ni);
    const pos = new Float32Array(nv * 3), nrm = new Float32Array(nv * 3), col = new Float32Array(nv * 3);
    for (let v = 0; v < nv; v++) {
      const x = P[v * 3], y = P[v * 3 + 1], z = P[v * 3 + 2];
      let nx = N[v * 3], ny = N[v * 3 + 1], nz = N[v * 3 + 2];
      if (blenderAxes) {
        pos[v * 3] = x * q; pos[v * 3 + 1] = z * q; pos[v * 3 + 2] = -y * q;
        const t = ny; ny = nz; nz = -t;
      } else {
        pos[v * 3] = x * q; pos[v * 3 + 1] = y * q; pos[v * 3 + 2] = z * q;
      }
      let l = Math.hypot(nx, ny, nz);
      if (!l) { nx = 0; ny = 1; nz = 0; l = 1; } // never feed a zero normal to the shader (NaN -> bloom blowout)
      nrm[v * 3] = nx / l; nrm[v * 3 + 1] = ny / l; nrm[v * 3 + 2] = nz / l;
      const c = meta.palette[C[v]];
      col[v * 3] = c[0]; col[v * 3 + 1] = c[1]; col[v * 3 + 2] = c[2];
    }
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    g.setAttribute('normal', new THREE.BufferAttribute(nrm, 3));
    g.setAttribute('color', new THREE.BufferAttribute(col, 3));
    if (U) {
      const t = new Float32Array(nv * 2);
      for (let k = 0; k < nv * 2; k++) t[k] = U[k] / meta.uvq;
      g.setAttribute('uv', new THREE.BufferAttribute(t, 2));
    }
    g.setIndex(new THREE.BufferAttribute(wide ? new Uint32Array(I) : new Uint16Array(I), 1));
    g.computeBoundingSphere();
    out[slot] = g;
  }
  return out;
}
