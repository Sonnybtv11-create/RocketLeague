// Goals: glowing team-coloured frames (posts + crossbar, emissive so bloom picks
// them up), rear frame + top rails, light blocks, transparent diamond-mesh nets
// on the goal box surfaces (exact SDF surfaces from arenaMesh), team-lit goal
// floors, the ramp end caps at the posts and a dark backing shell behind the
// nets. Both goals share draw calls (team colour comes from vertex attributes).
import * as THREE from 'three';
import { ARENA_PARAMS } from '../../sim/arena.js';
import { TEAM_COLORS } from '../../contracts.js';
import { makeNetTexture, makeGoalFloorTexture } from './textures.js';
import { setColor, setEmis, vertexEmissive, merge, scaleUV } from './matUtil.js';

const { Y, GW, GH, GD } = ARENA_PARAMS;
const S = 0.01;

// rounded "goal-mouth" frame path in a vertical plane at depth yy (sim)
function framePath(yy, r, cr) {
  const p = new THREE.CurvePath();
  const v = (x, z) => new THREE.Vector3(x * S, z * S, yy * S);
  const xo = GW + r, zt = GH + r;
  p.add(new THREE.LineCurve3(v(xo, -r), v(xo, zt - cr)));
  p.add(new THREE.QuadraticBezierCurve3(v(xo, zt - cr), v(xo, zt), v(xo - cr, zt)));
  p.add(new THREE.LineCurve3(v(xo - cr, zt), v(-xo + cr, zt)));
  p.add(new THREE.QuadraticBezierCurve3(v(-xo + cr, zt), v(-xo, zt), v(-xo, zt - cr)));
  p.add(new THREE.LineCurve3(v(-xo, zt - cr), v(-xo, -r)));
  return p;
}

// flip a planar geometry's triangles so its front face points towards `centre`
function faceTowards(g, centre) {
  const p = g.attributes.position, idx = g.index.array;
  const a = new THREE.Vector3().fromBufferAttribute(p, idx[0]), b = new THREE.Vector3().fromBufferAttribute(p, idx[1]), c = new THREE.Vector3().fromBufferAttribute(p, idx[2]);
  const n = new THREE.Vector3().subVectors(b, a).cross(new THREE.Vector3().subVectors(c, a));
  if (n.dot(new THREE.Vector3().subVectors(centre, a)) < 0) {
    for (let t = 0; t < idx.length; t += 3) { const tmp = idx[t + 1]; idx[t + 1] = idx[t + 2]; idx[t + 2] = tmp; }
    const nr = g.attributes.normal;
    if (nr) for (let i = 0; i < nr.count; i++) nr.setXYZ(i, -nr.getX(i), -nr.getY(i), -nr.getZ(i));
  }
  return g;
}

// keep only position/normal/uv (+ index) so differently-built parts can be merged
function clean(g) {
  const out = new THREE.BufferGeometry();
  if (!g.attributes.normal) g.computeVertexNormals();
  out.setAttribute('position', g.attributes.position.clone());
  out.setAttribute('normal', g.attributes.normal.clone());
  out.setAttribute('uv', g.attributes.uv ? g.attributes.uv.clone() : new THREE.BufferAttribute(new Float32Array(g.attributes.position.count * 2), 2));
  if (g.index) out.setIndex(g.index.clone());
  return out;
}

export function createGoals(ctx, geos) {
  const renderer = ctx.renderer;
  const group = new THREE.Group();
  group.name = 'goals';
  const disposables = [];
  const track = (o) => { disposables.push(o); return o; };

  const frameParts = [], shellParts = [], floorParts = [], netParts = [], glowParts = [];
  for (const team of [0, 1]) {
    const s = team === 0 ? -1 : 1;
    const tc = TEAM_COLORS[team];
    const glow = new THREE.Color(tc.glow), primary = new THREE.Color(tc.primary), dark = new THREE.Color(tc.dark), light = new THREE.Color(tc.light);

    // main frame (posts + crossbar)
    const rT = 22;
    const front = clean(new THREE.TubeGeometry(framePath(s * (Y - rT * 0.6), rT, 70), 96, rT * S, 12, false));
    frameParts.push(setEmis(setColor(front, primary), glow, 2.2));
    // rear frame + top rails + middle rail (thinner, dimmer)
    const r2 = 12;
    const rear = [new THREE.TubeGeometry(framePath(s * (GD + r2), r2, 50), 64, r2 * S, 8, false)];
    for (const sx of [-1, 1]) {
      rear.push(new THREE.TubeGeometry(new THREE.LineCurve3(new THREE.Vector3(sx * (GW + r2) * S, (GH + r2) * S, s * (Y - 10) * S), new THREE.Vector3(sx * (GW + r2) * S, (GH + r2) * S, s * (GD + r2) * S)), 4, r2 * S, 8, false));
    }
    const mid = s * (GD * 0.5 + Y * 0.5) * S;
    rear.push(new THREE.TubeGeometry(new THREE.LineCurve3(new THREE.Vector3(-(GW + r2) * S, (GH + r2) * S, mid), new THREE.Vector3((GW + r2) * S, (GH + r2) * S, mid)), 4, r2 * 0.7 * S, 8, false));
    for (const g of rear) frameParts.push(setEmis(setColor(clean(g), dark), glow, 1.2));
    // ramp end caps at the posts (exact SDF surface)
    frameParts.push(setEmis(setColor(clean(geos.caps[team]), primary), glow, 0.6));

    // light blocks on top of the crossbar near the corners (unlit glow)
    for (const sx of [-1, 1]) for (let k = 0; k < 3; k++) {
      const b = new THREE.BoxGeometry(0.36, 0.22, 0.3);
      b.translate(sx * (GW - 60 - k * 55) * S, (GH + rT * 2 + 11) * S, s * (Y - rT * 0.6) * S);
      glowParts.push(setColor(clean(b), new THREE.Color(1.0, 0.7, 0.2).multiplyScalar(1.6)));
    }

    // goal floor (team-lit hex floor)
    const fl = clean(geos.goalFloor[team]);
    scaleUV(fl, (2 * GW) / 380, (GD - Y) / 380);
    floorParts.push(setEmis(setColor(fl, light.clone().lerp(new THREE.Color(0xffffff), 0.3).multiplyScalar(team ? 0.6 : 1)), glow, team ? 0.4 : 0.9));

    // net (side walls, roof, back): transparent diamond mesh, team tint
    const net = clean(geos.goalNet[team]);
    scaleUV(net, 1 / 1.6, 1 / 1.6); // uv in metres -> one diamond pair per 1.6 m
    // orange glows much brighter than blue at equal intensity: balance so both
    // goal mouths read as openings at range
    netParts.push(setEmis(setColor(net, light.clone().multiplyScalar(team ? 0.32 : 0.8)), glow, team ? 0.18 : 0.6));

    // outer backing shell behind the net (dark structure, single-sided, faces into the goal)
    const o = 70, D0 = Y + 10, D1 = GD + o;
    const centre = new THREE.Vector3(0, GH * 0.5 * S, s * (Y + GD) * 0.5 * S);
    const shell = [];
    for (const sx of [-1, 1]) {
      const g = new THREE.PlaneGeometry((D1 - D0) * S, (GH + o) * S); g.rotateY(Math.PI / 2);
      g.translate(sx * (GW + o) * S, (GH + o) * 0.5 * S, s * (D0 + D1) * 0.5 * S); shell.push(g);
    }
    const roof = new THREE.PlaneGeometry(2 * (GW + o) * S, (D1 - D0) * S); roof.rotateX(Math.PI / 2); roof.translate(0, (GH + o) * S, s * (D0 + D1) * 0.5 * S); shell.push(roof);
    const back = new THREE.PlaneGeometry(2 * (GW + o) * S, (GH + o) * S); back.translate(0, (GH + o) * 0.5 * S, s * D1 * S); shell.push(back);
    for (const g of shell) shellParts.push(setEmis(setColor(faceTowards(clean(g), centre), new THREE.Color(0x080a0f)), dark, team ? 0.08 : 0.15));
    // light strips along the back of the shell
    for (const zz of [0.3, 0.62]) {
      const st = new THREE.PlaneGeometry(2 * GW * S, 0.12); st.translate(0, GH * zz * S, s * (D1 - 2) * S);
      glowParts.push(setColor(faceTowards(clean(st), centre), glow.clone().multiplyScalar(team ? 0.7 : 1.1)));
    }
  }

  // --- frames + caps (lit, per-vertex emissive)
  const frameMat = track(vertexEmissive(new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.35, metalness: 0.2, side: THREE.DoubleSide }), 'frame'));
  const frames = new THREE.Mesh(track(merge(frameParts)), frameMat);
  frames.castShadow = true; frames.name = 'goalFrames';
  group.add(frames);
  // --- unlit glow parts (light blocks, strips)
  const glowMat = track(new THREE.MeshBasicMaterial({ vertexColors: true }));
  const glowMesh = new THREE.Mesh(track(merge(glowParts)), glowMat);
  glowMesh.name = 'goalGlow';
  group.add(glowMesh);
  // --- floors
  const ft = track(makeGoalFloorTexture(renderer));
  const floorMat = track(vertexEmissive(new THREE.MeshStandardMaterial({ map: ft, emissiveMap: ft, vertexColors: true, roughness: 0.6, metalness: 0.2 }), 'goalFloor'));
  const floors = new THREE.Mesh(track(merge(floorParts)), floorMat);
  floors.receiveShadow = true; floors.name = 'goalFloors';
  group.add(floors);
  // --- backing shells
  const shellMat = track(vertexEmissive(new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.7 }), 'shell'));
  const shells = new THREE.Mesh(track(merge(shellParts)), shellMat);
  shells.name = 'goalShells';
  group.add(shells);
  // --- nets (transparent)
  const nt = track(makeNetTexture(renderer));
  const netMat = track(vertexEmissive(new THREE.MeshStandardMaterial({
    map: nt, emissiveMap: nt, vertexColors: true, transparent: true, opacity: 0.6, roughness: 0.6,
    side: THREE.DoubleSide, depthWrite: false, forceSinglePass: true,
  }), 'net'));
  const nets = new THREE.Mesh(track(merge(netParts)), netMat);
  nets.renderOrder = 2; nets.name = 'goalNets';
  group.add(nets);

  return {
    object3d: group,
    dispose() { for (const d of disposables) d.dispose && d.dispose(); },
  };
}
