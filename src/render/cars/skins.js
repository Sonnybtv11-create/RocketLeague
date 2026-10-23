// TURBO PITCH — car skins: extra cars unlocked with profile reward codes (src/game/profile.js), then
// picked in the garage. A skin drives on an existing hitbox but brings its own body mesh, wheel,
// materials and boost nozzle. buildSkin(id) returns the same shape as bodies.js buildBody(), plus
// materialsFor(team) -> { [body slot]: material } and wheelMaterials ({ tyre, rim }), which cars.js
// uses instead of its own (or wheelMaterialsFor(team)), and optional tyre.x / tyre.r ([front, rear]
// allowed): where its wheels are drawn (uu) when they differ from the hitbox's. Skins with moving
// parts also give `parts` ({ id: { pivot (model metres) } }, mesh slots "<part>.<material>") and
// createRig(groups, { team, cfg, meshes, root }) -> { update(carView, dt), demoed?(carView, dt), dispose() }
// (demoed runs instead of update while the car is demolished; root is the car's world-space group).
// A skin can add a second mesh (extraMesh, same format), e.g. a driver.
import * as THREE from 'three';
import { decodeMesh } from '../meshpack.js';
import { registerEnvUser } from './materials.js';
import { TEAM_COLORS } from '../../contracts.js';
import { JEEP_MESH_META, JEEP_MESH_B64, JEEP_WHEEL_META, JEEP_WHEEL_B64, JEEP_TEX } from './jeepMesh.js';
import { KART_SKIN } from './kart.js';
import { BACON_MESH_META, BACON_MESH_B64, BACON_INFO, BACON_TEX } from './baconMesh.js';
import { createR6Driver } from './r6driver.js';

// the jeep's driver: the bacon-hair avatar's parts (model metres; pivot, and box relative to it)
const toModel = (v) => new THREE.Vector3(v[0] / 100, v[2] / 100, -v[1] / 100);
const BACON_PARTS = Object.fromEntries(BACON_INFO.parts.map((p) => {
  const a = toModel(p.box[0]), b = toModel(p.box[1]);
  return [p.id, { pivot: toModel(p.pivot), box: [[a.x, Math.min(a.y, b.y), Math.min(a.z, b.z)], [b.x, Math.max(a.y, b.y), Math.max(a.z, b.z)]] }];
}));

function texture(url, { repeat = 1, wrap = true } = {}) {
  const t = new THREE.TextureLoader().load(url);
  t.colorSpace = THREE.SRGBColorSpace;
  if (wrap) { t.wrapS = t.wrapT = THREE.RepeatWrapping; t.repeat.set(repeat, repeat); }
  t.anisotropy = 8;
  return t;
}

const SKINS = {
  kart: KART_SKIN,   // the ATK kart, with moving parts (kart.js)
  // Classic Roblox jeep (tools/blender/import_jeep.py), Octane hitbox, scaled uniformly to the Octane's
  // footprint. Its green parts take the team colour. Wheels: 4 studs (28 uu) wide, radius 14, drawn
  // at the jeep's own axles. Driven by a bacon-hair R6 avatar (import_bacon.py, r6driver.js) in its
  // own colours.
  jeep: {
    hitbox: 'OCTANE',
    tyre: { wF: 28, wB: 28, extraF: 2.1, extraB: -1.5, spokes: 0, modelled: true, x: [38.38, -24.62], r: 14 },
    nozzles: [[-52.6, -6.4, 9.1, 3.5]],
    build() {
      const wood = texture(JEEP_TEX.wood, { repeat: 0.25 });   // Roblox maps the grain at 4 studs per tile
      // the original multiplies the part colour by the grain texture (mean ~0.5): match its brightness
      const woodMat = (opts) => {
        const m = new THREE.MeshStandardMaterial({ vertexColors: true, map: wood, roughness: 0.62, metalness: 0, ...opts });
        m.onBeforeCompile = (sh) => {
          sh.fragmentShader = sh.fragmentShader.replace('#include <map_fragment>', '#include <map_fragment>\ndiffuseColor.rgb *= 2.0;');
        };
        m.customProgramCacheKey = () => 'skin-wood-x2';
        registerEnvUser(m);
        return m;
      };
      const plasticMat = (opts) => { const m = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.22, metalness: 0, ...opts }); registerEnvUser(m); return m; };
      const decal = (url, name) => new THREE.MeshStandardMaterial({ map: texture(url, { wrap: false }), transparent: true, alphaTest: 0.05, roughness: 0.45,
        polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -2, name });
      const shared = {
        wood: woodMat({ name: 'skin.jeep.wood' }),
        plastic: plasticMat({ name: 'skin.jeep.plastic' }),
        decal_grille: decal(JEEP_TEX.grille, 'skin.jeep.grille'),
        decal_roblox: decal(JEEP_TEX.roblox, 'skin.jeep.roblox'),
      };
      // Roblox avatar parts: smooth plastic
      const avatarMat = (url, name) => { const m = new THREE.MeshStandardMaterial({ map: texture(url, { wrap: false }), roughness: 0.55, metalness: 0, name }); registerEnvUser(m); return m; };
      shared.r6 = avatarMat(BACON_TEX.body, 'skin.jeep.driver');
      shared.hair = avatarMat(BACON_TEX.hair, 'skin.jeep.driverhair');
      const perTeam = new Map();
      return {
        mesh: [JEEP_MESH_META, JEEP_MESH_B64],
        extraMesh: [BACON_MESH_META, BACON_MESH_B64],
        parts: BACON_PARTS,
        createRig: (groups, { root, sfx }) => createR6Driver(groups, BACON_PARTS, root, sfx),
        wheel: [JEEP_WHEEL_META, JEEP_WHEEL_B64],
        materialsFor(team) {
          const t = team === 1 ? 1 : 0;
          if (!perTeam.has(t)) {
            const tc = TEAM_COLORS[t];
            const main = new THREE.Color(tc.primary).multiplyScalar(0.62), dark = new THREE.Color(tc.dark);
            perTeam.set(t, {
              ...shared,
              wood_team: woodMat({ color: main, name: 'skin.jeep.team' + t }),
              wood_team_dark: woodMat({ color: dark, name: 'skin.jeep.teamdark' + t }),
              plastic_team_dark: plasticMat({ color: dark, name: 'skin.jeep.lamps' + t }),
            });
          }
          return perTeam.get(t);
        },
        wheelMaterials: { tyre: shared.wood, rim: shared.wood },
      };
    },
  },
};

export const isSkin = (id) => Object.prototype.hasOwnProperty.call(SKINS, id);

const cache = new Map();
export function buildSkin(id) {
  if (cache.has(id)) return cache.get(id);
  const spec = SKINS[id];
  const b = spec.build();
  const res = {
    id, hitbox: spec.hitbox, tyre: spec.tyre,
    geoms: { ...decodeMesh(...b.mesh, { scale: 0.01 }), ...(b.extraMesh ? decodeMesh(...b.extraMesh, { scale: 0.01 }) : null) },   // uu -> metres, Blender axes -> model axes
    wheel: decodeMesh(...b.wheel, { blenderAxes: false }),   // already in wheel space
    materialsFor: b.materialsFor, wheelMaterials: b.wheelMaterials, wheelMaterialsFor: b.wheelMaterialsFor,
    parts: b.parts || null, createRig: b.createRig || null,
    nozzles: spec.nozzles.map(([x, y, z]) => new THREE.Vector3(x / 100, y / 100, z / 100)),
    nozzleRadius: spec.nozzles.map((n) => n[3] / 100),
  };
  cache.set(id, res);
  return res;
}
