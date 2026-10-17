// Goals: the goal structure is modelled in Blender after the DFH Stadium goal (tools/blender/
// arena_assets.py -> arenaAssets.js): a gunmetal rounded-rectangle ring with team LED lines, a back
// ring and top rails, wings sloping down the back wall, lanterns on the top corners and slatted grate
// walls with team light strips. Here: that model placed at both ends, plus the ramp end caps (exact
// SDF surfaces from arenaMesh) and the team-lit goal floors.
import * as THREE from 'three';
import { ARENA_PARAMS } from '../../sim/arena.js';
import { TEAM_COLORS } from '../../contracts.js';
import { makeGoalFloorTexture } from './textures.js';
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

  const frameParts = [], floorParts = [];
  for (const team of [0, 1]) {
    const tc = TEAM_COLORS[team];
    const glow = new THREE.Color(tc.glow), light = new THREE.Color(tc.light);

    // ramp end caps at the posts (exact SDF surface)
    frameParts.push(setEmis(setColor(clean(geos.caps[team]), new THREE.Color(0x2a2d33)), glow, 0.05));

    // goal floor (team-lit hex floor)
    const fl = clean(geos.goalFloor[team]);
    scaleUV(fl, (2 * GW) / 380, (GD - Y) / 380);
    floorParts.push(setEmis(setColor(fl, light.clone().lerp(new THREE.Color(0xffffff), 0.3).multiplyScalar(team ? 0.6 : 1)), glow, team ? 0.4 : 0.9));
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
    metal: track(new THREE.MeshStandardMaterial({ vertexColors: true, metalness: 0.5, roughness: 0.35, name: 'goal.metal' })),
    dark: track(new THREE.MeshStandardMaterial({ vertexColors: true, metalness: 0.35, roughness: 0.55, name: 'goal.dark' })),
    light: track(new THREE.MeshBasicMaterial({ vertexColors: true, name: 'goal.light' })),
  };
  for (const team of [0, 1]) {
    const tc = TEAM_COLORS[team];
    const mats = {
      ...shared,
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
  const ft = makeGoalFloorTexture(renderer); track(ft.map); track(ft.bumpMap);
  const floorMat = track(vertexEmissive(new THREE.MeshStandardMaterial({ map: ft.map, emissiveMap: ft.map, bumpMap: ft.bumpMap, bumpScale: 2, vertexColors: true, roughness: 0.5, metalness: 0.35 }), 'goalFloor'));
  const floors = new THREE.Mesh(track(merge(floorParts)), floorMat);
  floors.receiveShadow = true; floors.name = 'goalFloors';
  group.add(floors);
  return {
    object3d: group,
    dispose() { for (const d of disposables) d.dispose && d.dispose(); },
  };
}
