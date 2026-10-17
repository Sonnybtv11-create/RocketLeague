// Goals: the goal structure is modelled in Blender (tools/blender/arena_assets.py -> arenaAssets.js):
// a bevelled team-painted frame with a recessed LED channel and a glowing inner strip, lamp units on
// the crossbar, metal net-support rods and a ribbed, panelled housing with recessed light bars behind
// the net. Here: that model placed at both ends, plus the transparent diamond-mesh nets on the goal
// box surfaces and the ramp end caps (exact SDF surfaces from arenaMesh) and the team-lit goal floors.
import * as THREE from 'three';
import { ARENA_PARAMS } from '../../sim/arena.js';
import { TEAM_COLORS } from '../../contracts.js';
import { makeNetTexture, makeGoalFloorTexture } from './textures.js';
import { setColor, setEmis, vertexEmissive, merge, scaleUV } from './matUtil.js';
import { decodeMesh } from '../meshpack.js';
import { GOAL_META, GOAL_B64 } from './arenaAssets.js';

const { Y, GW, GH, GD } = ARENA_PARAMS;
const S = 0.01;

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

  const frameParts = [], floorParts = [], netParts = [];
  for (const team of [0, 1]) {
    const tc = TEAM_COLORS[team];
    const glow = new THREE.Color(tc.glow), primary = new THREE.Color(tc.primary), light = new THREE.Color(tc.light);

    // ramp end caps at the posts (exact SDF surface)
    frameParts.push(setEmis(setColor(clean(geos.caps[team]), primary), glow, 0.6));

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
  }

  // --- ramp end caps (lit, per-vertex emissive)
  const frameMat = track(vertexEmissive(new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.35, metalness: 0.2, side: THREE.DoubleSide }), 'frame'));
  const frames = new THREE.Mesh(track(merge(frameParts)), frameMat);
  frames.castShadow = true; frames.name = 'goalCaps';
  group.add(frames);

  // --- modelled goal structure, one per end (the model's +y runs into the goal: the blue goal uses
  // it as decoded, the orange one turned round)
  const geo = decodeMesh(GOAL_META, GOAL_B64, { scale: S });
  for (const g of Object.values(geo)) track(g);
  const shared = {
    metal: track(new THREE.MeshStandardMaterial({ vertexColors: true, metalness: 0.85, roughness: 0.32, name: 'goal.metal' })),
    dark: track(new THREE.MeshStandardMaterial({ vertexColors: true, metalness: 0.35, roughness: 0.55, name: 'goal.dark' })),
    light: track(new THREE.MeshBasicMaterial({ vertexColors: true, name: 'goal.light' })),
  };
  for (const team of [0, 1]) {
    const tc = TEAM_COLORS[team];
    const mats = {
      ...shared,
      paint: track(new THREE.MeshStandardMaterial({ color: tc.primary, metalness: 0.25, roughness: 0.32, emissive: tc.primary, emissiveIntensity: 0.12, name: 'goal.paint' + team })),
      // orange reads much brighter than blue at equal intensity: balance the two
      glow: track(new THREE.MeshBasicMaterial({ vertexColors: true, color: new THREE.Color(tc.glow).multiplyScalar(team ? 1.7 : 2.6), name: 'goal.glow' + team })),
    };
    const model = new THREE.Group();
    model.name = 'goalModel' + team;
    for (const [slot, g] of Object.entries(geo)) {
      const m = new THREE.Mesh(g, mats[slot] || shared.dark);
      m.castShadow = slot !== 'glow' && slot !== 'light';
      m.receiveShadow = slot !== 'glow' && slot !== 'light';
      model.add(m);
    }
    if (team === 1) model.rotation.y = Math.PI;
    model.position.z = (team ? 1 : -1) * Y * S;
    group.add(model);
  }
  // --- floors
  const ft = track(makeGoalFloorTexture(renderer));
  const floorMat = track(vertexEmissive(new THREE.MeshStandardMaterial({ map: ft, emissiveMap: ft, vertexColors: true, roughness: 0.6, metalness: 0.2 }), 'goalFloor'));
  const floors = new THREE.Mesh(track(merge(floorParts)), floorMat);
  floors.receiveShadow = true; floors.name = 'goalFloors';
  group.add(floors);
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
