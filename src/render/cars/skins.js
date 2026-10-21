// TURBO PITCH — car skins: alternative looks unlocked with modifier codes (src/game/modifiers.js).
// A skin keeps the hitbox of the car it replaces; it brings its own body mesh, wheel, materials and
// boost nozzles. buildSkin(id) returns the same shape as bodies.js buildBody(), plus `materials`
// (per body slot) and `wheelMaterials` ({ tyre, rim }), which cars.js uses instead of its own.
import * as THREE from 'three';
import { decodeMesh } from '../meshpack.js';
import { registerEnvUser } from './materials.js';
import { JEEP_MESH_META, JEEP_MESH_B64, JEEP_WHEEL_META, JEEP_WHEEL_B64, JEEP_TEX } from './jeepMesh.js';

function texture(url, { repeat = 1, wrap = true } = {}) {
  const t = new THREE.TextureLoader().load(url);
  t.colorSpace = THREE.SRGBColorSpace;
  if (wrap) { t.wrapS = t.wrapT = THREE.RepeatWrapping; t.repeat.set(repeat, repeat); }
  t.anisotropy = 8;
  return t;
}

const SKINS = {
  // Classic Roblox jeep (tools/blender/import_jeep.py), Octane hitbox. Its wheels are 4 studs wide and
  // fitted to the Octane's axles; the tyre width / offsets below put them where the jeep has them.
  jeep: {
    hitbox: 'OCTANE',
    tyre: { wF: 27.6, wB: 27.6, extraF: 1.7, extraB: -1.9, spokes: 0, modelled: true },
    nozzles: [[-61.3, -6.6, 9.0, 3.5]],
    build() {
      const wood = texture(JEEP_TEX.wood, { repeat: 0.25 });   // Roblox maps the grain at 4 studs per tile
      const woodMat = new THREE.MeshStandardMaterial({ vertexColors: true, map: wood, roughness: 0.62, metalness: 0, name: 'skin.jeep.wood' });
      const plastic = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.22, metalness: 0, name: 'skin.jeep.plastic' });
      const decal = (url, name) => new THREE.MeshStandardMaterial({ map: texture(url, { wrap: false }), transparent: true, alphaTest: 0.05, roughness: 0.45,
        polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -2, name });
      // the original multiplies the part colour by the grain texture (mean ~0.5): match its brightness
      woodMat.onBeforeCompile = (sh) => {
        sh.fragmentShader = sh.fragmentShader.replace('#include <map_fragment>', '#include <map_fragment>\ndiffuseColor.rgb *= 2.0;');
      };
      woodMat.customProgramCacheKey = () => 'skin-wood-x2';
      for (const m of [woodMat, plastic]) registerEnvUser(m);
      return {
        mesh: [JEEP_MESH_META, JEEP_MESH_B64],
        wheel: [JEEP_WHEEL_META, JEEP_WHEEL_B64],
        materials: { wood: woodMat, plastic, decal_grille: decal(JEEP_TEX.grille, 'skin.jeep.grille'), decal_roblox: decal(JEEP_TEX.roblox, 'skin.jeep.roblox') },
        wheelMaterials: { tyre: woodMat, rim: woodMat },
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
    geoms: decodeMesh(...b.mesh, { scale: 0.01 }),          // uu -> metres, Blender axes -> model axes
    wheel: decodeMesh(...b.wheel, { blenderAxes: false }),   // already in wheel space
    materials: b.materials, wheelMaterials: b.wheelMaterials,
    nozzles: spec.nozzles.map(([x, y, z]) => new THREE.Vector3(x / 100, y / 100, z / 100)),
    nozzleRadius: spec.nozzles.map((n) => n[3] / 100),
  };
  cache.set(id, res);
  return res;
}
