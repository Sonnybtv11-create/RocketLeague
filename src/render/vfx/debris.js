// OWNER: VFX agent. Demolition debris: tumbling body panels (one InstancedMesh).
//
// A handful of irregular, bent panel shards per demolition, team-tinted via
// instanceColor, with a hot glow that cools over the first second
// (per-instance heat attribute injected into MeshStandardMaterial). Simple
// ballistic CPU sim with bounces against the arena SDF; chunks trail fire,
// then smoke (emitted by the caller through onTrail).
import * as THREE from 'three';

function shardGeometry() {
  // a slightly bent, bevel-less panel with jittered corners: reads as a torn body panel
  const g = new THREE.BoxGeometry(1, 0.16, 1, 3, 1, 3);
  const p = g.getAttribute('position');
  const rnd = (i) => { const s = Math.sin(i * 12.9898) * 43758.5453; return s - Math.floor(s); };
  for (let i = 0; i < p.count; i++) {
    let x = p.getX(i), y = p.getY(i), z = p.getZ(i);
    y += (x * x + z * z) * 0.35;                           // bend
    x += (rnd(i + Math.round(x * 7 + z * 13) * 31) - 0.5) * 0.18;
    z += (rnd(i * 3 + 7 + Math.round(x * 5 + z * 11) * 17) - 0.5) * 0.18;
    if (x > 0.3 && z > 0.3) { x *= 0.7; z *= 0.7; }         // torn corner
    p.setXYZ(i, x, y, z);
  }
  g.computeVertexNormals();
  return g;
}

export class Debris {
  constructor(capacity = 48) {
    this.capacity = capacity;
    const geo = shardGeometry();
    this.heat = new THREE.InstancedBufferAttribute(new Float32Array(capacity), 1).setUsage(THREE.DynamicDrawUsage);
    geo.setAttribute('aHeat', this.heat);
    const mat = new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: 0.45, metalness: 0.55 });
    mat.onBeforeCompile = (sh) => {
      sh.vertexShader = sh.vertexShader
        .replace('#include <common>', '#include <common>\nattribute float aHeat;\nvarying float vHeat;')
        .replace('#include <begin_vertex>', '#include <begin_vertex>\nvHeat = aHeat;');
      sh.fragmentShader = sh.fragmentShader
        .replace('#include <common>', '#include <common>\nvarying float vHeat;')
        .replace('#include <emissivemap_fragment>', '#include <emissivemap_fragment>\ntotalEmissiveRadiance += vec3(1.6, 0.45, 0.08) * vHeat * vHeat;');
    };
    mat.customProgramCacheKey = () => 'vfx-debris-heat';
    this.material = mat;
    this.mesh = new THREE.InstancedMesh(geo, mat, capacity);
    this.mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    this.mesh.instanceColor = new THREE.InstancedBufferAttribute(new Float32Array(capacity * 3), 3);
    this.mesh.frustumCulled = false;
    this.mesh.castShadow = true;
    this.mesh.name = 'vfx.debris';
    this.mesh.count = 0;
    this.items = [];
    for (let i = 0; i < capacity; i++) {
      this.items.push({
        alive: false, t: 0, life: 0, pos: new THREE.Vector3(), vel: new THREE.Vector3(),
        q: new THREE.Quaternion(), axis: new THREE.Vector3(1, 0, 0), spin: 0,
        scale: new THREE.Vector3(1, 1, 1), color: new THREE.Color(), trailAcc: 0, rest: false,
      });
    }
    this.next = 0;
    this._m = new THREE.Matrix4(); this._dq = new THREE.Quaternion(); this._s = new THREE.Vector3();
    this._n = { x: 0, y: 0, z: 0 };
    this._e = new THREE.Euler();
    this.zero = new THREE.Matrix4().makeScale(0, 0, 0);
  }

  spawn(pos, vel, scale, color, life) {
    const it = this.items[this.next];
    this.next = (this.next + 1) % this.capacity;
    it.alive = true; it.t = 0; it.life = life; it.rest = false; it.trailAcc = 0;
    it.pos.copy(pos); it.vel.copy(vel);
    it.q.setFromEuler(this._e.set(Math.random() * 6.28, Math.random() * 6.28, Math.random() * 6.28));
    it.axis.set(Math.random() - 0.5, Math.random() - 0.5, Math.random() - 0.5).normalize();
    it.spin = 6 + Math.random() * 14;
    it.scale.copy(scale);
    it.color.copy(color);
  }

  // sdf(x,y,z) in sim units (positive inside the arena); onTrail(item, dt) to emit fire/smoke
  update(dt, sdf, normal, onTrail) {
    const G = 6.5; // RL gravity, m/s²
    let maxIdx = -1;
    const m = this._m, mesh = this.mesh, heat = this.heat.array;
    for (let i = 0; i < this.capacity; i++) {
      const it = this.items[i];
      if (!it.alive) { mesh.setMatrixAt(i, this.zero); heat[i] = 0; continue; }
      it.t += dt;
      if (it.t >= it.life) { it.alive = false; mesh.setMatrixAt(i, this.zero); heat[i] = 0; continue; }
      maxIdx = i;
      if (!it.rest) {
        it.vel.y -= G * dt;
        it.vel.multiplyScalar(Math.exp(-0.25 * dt));
        it.pos.addScaledVector(it.vel, dt);
        this._dq.setFromAxisAngle(it.axis, it.spin * dt);
        it.q.premultiply(this._dq);
        // arena collision (sim units: x, z->y, y->z)
        const r = 0.12 * Math.max(it.scale.x, it.scale.z);
        const sx = it.pos.x * 100, sy = it.pos.z * 100, sz = it.pos.y * 100;
        const d = sdf(sx, sy, sz) / 100;
        if (d < r) {
          const n = normal(sx, sy, sz, this._n);
          const nx = n.x, ny = n.z, nz = n.y; // -> three
          it.pos.x += nx * (r - d); it.pos.y += ny * (r - d); it.pos.z += nz * (r - d);
          const vn = it.vel.x * nx + it.vel.y * ny + it.vel.z * nz;
          if (vn < 0) {
            it.vel.x -= 1.45 * vn * nx; it.vel.y -= 1.45 * vn * ny; it.vel.z -= 1.45 * vn * nz;
            it.vel.multiplyScalar(0.6);
            it.spin *= 0.6;
            if (it.vel.lengthSq() < 0.6 && ny > 0.7) it.rest = true;
          }
        }
      }
      const shrink = Math.min(1, (it.life - it.t) / 0.4);
      this._s.copy(it.scale).multiplyScalar(shrink);
      m.compose(it.pos, it.q, this._s);
      mesh.setMatrixAt(i, m);
      mesh.setColorAt(i, it.color);
      heat[i] = Math.max(0, 1 - it.t / 1.1);
      if (onTrail) onTrail(it, dt);
    }
    mesh.count = maxIdx + 1;
    mesh.visible = mesh.count > 0;
    if (maxIdx >= 0 || this._wasActive) {
      mesh.instanceMatrix.needsUpdate = true;
      mesh.instanceColor.needsUpdate = true;
      this.heat.needsUpdate = true;
    }
    this._wasActive = maxIdx >= 0;
  }

  clear() { for (const it of this.items) it.alive = false; this.mesh.count = 0; this.mesh.visible = false; }
  dispose() { this.mesh.geometry.dispose(); this.material.dispose(); }
}
