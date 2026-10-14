// Helpers to merge differently-coloured (team) parts into one draw call:
// per-vertex colour (+ optional alpha) and per-vertex emissive radiance.
import * as THREE from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';

// fill a constant colour attribute (rgb or rgba) on geometry g
export function setColor(g, color, alpha) {
  const n = g.attributes.position.count;
  const size = alpha === undefined ? 3 : 4;
  const a = new Float32Array(n * size);
  for (let i = 0; i < n; i++) {
    a[i * size] = color.r; a[i * size + 1] = color.g; a[i * size + 2] = color.b;
    if (size === 4) a[i * size + 3] = alpha;
  }
  g.setAttribute('color', new THREE.BufferAttribute(a, size));
  return g;
}

// constant per-vertex emissive radiance (linear, may exceed 1 for bloom)
export function setEmis(g, color, intensity = 1) {
  const n = g.attributes.position.count;
  const a = new Float32Array(n * 3);
  for (let i = 0; i < n; i++) { a[i * 3] = color.r * intensity; a[i * 3 + 1] = color.g * intensity; a[i * 3 + 2] = color.b * intensity; }
  g.setAttribute('emis', new THREE.BufferAttribute(a, 3));
  return g;
}

// MeshStandardMaterial whose emissive radiance comes from the 'emis' vertex
// attribute (still multiplied by emissiveMap when present).
export function vertexEmissive(mat, key) {
  const prev = mat.onBeforeCompile;
  mat.onBeforeCompile = (sh, r) => {
    if (prev) prev(sh, r);
    sh.vertexShader = sh.vertexShader
      .replace('#include <common>', '#include <common>\nattribute vec3 emis;\nvarying vec3 vEmis;')
      .replace('#include <begin_vertex>', '#include <begin_vertex>\nvEmis = emis;');
    sh.fragmentShader = sh.fragmentShader
      .replace('#include <common>', '#include <common>\nvarying vec3 vEmis;')
      .replace('#include <emissivemap_fragment>', 'totalEmissiveRadiance = vEmis;\n#include <emissivemap_fragment>');
  };
  const prevKey = mat.customProgramCacheKey ? mat.customProgramCacheKey.bind(mat) : () => '';
  mat.customProgramCacheKey = () => `${prevKey()}|vemis|${key}`;
  return mat;
}

// merge geometries that may be a mix of indexed / non-indexed
export function merge(geos) {
  const allIndexed = geos.every((g) => g.index);
  const list = allIndexed ? geos : geos.map((g) => (g.index ? g.toNonIndexed() : g));
  const m = mergeGeometries(list, false);
  if (!m) throw new Error('merge failed: attribute mismatch');
  return m;
}

// scale a geometry's uv attribute in place
export function scaleUV(g, su, sv, ou = 0, ov = 0) {
  const uv = g.attributes.uv;
  for (let i = 0; i < uv.count; i++) uv.setXY(i, uv.getX(i) * su + ou, uv.getY(i) * sv + ov);
  uv.needsUpdate = true;
  return g;
}
