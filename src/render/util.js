// Shared render helpers (lead-owned). Sim (x,y,z) Z-up uu -> Three (x,z,y) Y-up metres.
//
// MODEL SPACE CONVENTION for anything attached to a sim body (cars, ball):
//   build meshes in metres with +X = forward, +Y = up, +Z = right.
//   applySimTransform(object3d, simPos, simRotMat) then places it correctly.
import * as THREE from 'three';
import { UU_TO_M } from '../contracts.js';

const _m4 = new THREE.Matrix4();

export function simToThree(v, out = new THREE.Vector3()) {
  return out.set(v.x * UU_TO_M, v.z * UU_TO_M, v.y * UU_TO_M);
}
export function simDirToThree(v, out = new THREE.Vector3()) {
  return out.set(v.x, v.z, v.y);
}
export function threeToSim(v) {
  return { x: v.x / UU_TO_M, y: v.z / UU_TO_M, z: v.y / UU_TO_M };
}
// RotMat (row-major, columns fwd/right/up) -> THREE.Quaternion in model space (X fwd, Y up, Z right)
export function simRotToQuat(rm, out = new THREE.Quaternion()) {
  const a = rm.m;
  // P R P with P swapping y/z. Columns become (fwd', up', right') in three space.
  _m4.set(
    a[0], a[2], a[1], 0,
    a[6], a[8], a[7], 0,
    a[3], a[5], a[4], 0,
    0, 0, 0, 1);
  return out.setFromRotationMatrix(_m4);
}
export function applySimTransform(obj, pos, rot) {
  simToThree(pos, obj.position);
  if (rot) simRotToQuat(rot, obj.quaternion);
}
