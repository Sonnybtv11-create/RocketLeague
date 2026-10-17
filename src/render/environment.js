// OWNER: Arena & environment agent.
// createEnvironment(ctx) -> { object3d, update(view, frameDt), setQuality(name), setGrass(on), dispose() }
//
// Builds the whole stadium: arena shell generated from the collision SDF
// parameters (render/env/arenaMesh.js, verified by render/env/check-sdf.mjs),
// procedural pitch, team-coloured lower walls with ad boards, hex-glass upper
// walls/ceiling with glowing mullions, goals (glowing frames, nets, team-lit
// interiors), two-tier stand bowl with an instanced animated crowd, roof with
// floodlight banks, procedural sky + distant scenery, boost pads from
// view.pads, and all scene lighting (shadow-casting sun, hemisphere fill,
// PMREM environment map for reflections).
import * as THREE from 'three';
import { QUALITY, TEAM_COLORS } from '../contracts.js';
import { arenaNormal, ARENA_PARAMS } from '../sim/arena.js';
import { buildArenaGeometries, halfRing, PROFILE, SPLIT_ROW, RING_S, V_LOWER } from './env/arenaMesh.js';
import { makeFieldTextures, makeGrassDetail, makeLowerWallAtlas, makeHexTexture, WALL_TILE, HEX_A, STRIPE_W } from './env/textures.js';
import { setColor, setEmis, vertexEmissive, merge, scaleUV } from './env/matUtil.js';
import { createSky, createScenery } from './env/sky.js';
import { createPads } from './env/pads.js';
import { createGoals } from './env/goals.js';
import { createStadium, STADIUM_EXTENT } from './env/stadium.js';
import { createSkyline } from './env/skyline.js';

const S = 0.01;
const { X, Y, H, GW, GD } = ARENA_PARAMS;

// Sun direction (towards the sun), sim coords -> three (x, z, y)
const SUN_SIM = new THREE.Vector3(-0.64, 0.2, 0.74).normalize();
const SUN_DIR = new THREE.Vector3(SUN_SIM.x, SUN_SIM.z, SUN_SIM.y);
const HAZE = 0xa9c6dc;

// glowing vertical light lines on the glass (team coloured), following the profile
function buildMullions(team) {
  const sign = team === 0 ? -1 : 1;
  const pos = [], idx = [];
  const W = 14; // half width uu
  const total = RING_S[RING_S.length - 1];
  const n = new THREE.Vector3();
  const stations = [];
  for (let s = 600; s < total - 300; s += 1150) stations.push(s);
  // straight vertical lines: crossbar height up to where the ceiling fillet starts
  const rows = PROFILE.slice(SPLIT_ROW, SPLIT_ROW + 2);
  for (const s0 of stations) {
    const base = pos.length / 3;
    for (const row of rows) {
      const ring = halfRing(row.u, sign);
      for (const ds of [-W, W]) {
        const s = s0 + ds;
        let i = 0;
        while (i < RING_S.length - 2 && RING_S[i + 1] < s) i++;
        const f = (s - RING_S[i]) / Math.max(1e-6, RING_S[i + 1] - RING_S[i]);
        const x = ring[i][0] + (ring[i + 1][0] - ring[i][0]) * f;
        const y = ring[i][1] + (ring[i + 1][1] - ring[i][1]) * f;
        arenaNormal(x, y, Math.min(row.z, H - 1), n);
        const off = 3;
        pos.push((x + n.x * off) * S, (row.z + n.z * off) * S, (y + n.y * off) * S);
      }
    }
    for (let j = 0; j < rows.length - 1; j++) {
      const a = base + j * 2;
      idx.push(a, a + 1, a + 3, a, a + 3, a + 2);
    }
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setIndex(idx);
  return g;
}

// env-map scene: sky + pitch + stands ring + floodlights, rendered once to PMREM
function buildEnvScene(skyMaterial) {
  const sc = new THREE.Scene();
  const sky = new THREE.Mesh(new THREE.SphereGeometry(400, 32, 16), skyMaterial);
  sc.add(sky);
  const pitch = new THREE.Mesh(new THREE.PlaneGeometry(82, 102), new THREE.MeshBasicMaterial({ color: 0x3f7a35 }));
  pitch.rotation.x = -Math.PI / 2; sc.add(pitch);
  const outer = new THREE.Mesh(new THREE.CircleGeometry(390, 32), new THREE.MeshBasicMaterial({ color: 0x4d6045 }));
  outer.rotation.x = -Math.PI / 2; outer.position.y = -0.5; sc.add(outer);
  const stands = new THREE.Mesh(new THREE.CylinderGeometry(95, 70, 45, 32, 1, true), new THREE.MeshBasicMaterial({ color: 0x4a4f5c, side: THREE.BackSide }));
  stands.position.y = 22; sc.add(stands);
  const walls = new THREE.Mesh(new THREE.CylinderGeometry(52, 52, 6.4, 32, 1, true), new THREE.MeshBasicMaterial({ color: 0xb8bec8, side: THREE.BackSide }));
  walls.position.y = 3.2; sc.add(walls);
  const lampMat = new THREE.MeshBasicMaterial({ color: new THREE.Color(1, 0.95, 0.85).multiplyScalar(6) });
  for (let i = 0; i < 16; i++) {
    const a = i / 16 * Math.PI * 2;
    const l = new THREE.Mesh(new THREE.BoxGeometry(8, 2, 0.5), lampMat);
    l.position.set(Math.cos(a) * 75, 50, Math.sin(a) * 75);
    l.lookAt(0, 0, 0);
    sc.add(l);
  }
  return sc;
}

// Mown-turf sheen: alternate stripes have their blades laid towards +y or -y, so each stripe looks
// lighter when you look along its blades and darker against them; the pattern flips as the camera
// turns round and fades when looking across the stripes. Needs vMapUv / vViewPosition (standard material).
const MOW_SHEEN = `
float mowSheen(vec2 muv) {
  float band = floor((muv.y - 0.5) * ${(2 * Y / STRIPE_W).toFixed(4)});
  float dir = mod(band, 2.0) < 0.5 ? 1.0 : -1.0;
  vec3 mow = normalize((viewMatrix * vec4(0.0, 0.0, 1.0, 0.0)).xyz);
  vec3 look = normalize(-vViewPosition);
  return 1.0 + 0.24 * dir * dot(look, mow);
}`;

export function createEnvironment(ctx) {
  const { renderer, scene } = ctx;
  const root = new THREE.Group();
  root.name = 'environment';
  const disposables = [];
  const track = (o) => { disposables.push(o); return o; };
  const maxAniso = Math.min(16, renderer.capabilities.getMaxAnisotropy());

  // ------------------------------------------------------------ arena shell
  const geos = buildArenaGeometries();
  for (const k of ['lower', 'glass', 'ceiling', 'caps', 'goalFloor', 'goalNet']) geos[k].forEach(track);
  track(geos.floor);

  // pitch
  const field = makeFieldTextures(renderer);
  const detail = makeGrassDetail(renderer);
  track(field.map); track(detail);
  const floorMat = track(new THREE.MeshStandardMaterial({ map: field.map, roughness: 0.93, metalness: 0.0, envMapIntensity: 0.35 }));
  floorMat.onBeforeCompile = (sh) => {
    sh.uniforms.uDetail = { value: detail };
    sh.fragmentShader = sh.fragmentShader
      .replace('#include <common>', '#include <common>\nuniform sampler2D uDetail;\n' + MOW_SHEEN)
      .replace('#include <map_fragment>', `#include <map_fragment>
      diffuseColor.rgb *= mowSheen(vMapUv);
      {
        vec2 duv = vMapUv * vec2(${(2 * X / 95).toFixed(2)}, ${(2 * Y / 95).toFixed(2)});
        float dA = texture2D(uDetail, duv).r;
        float dB = texture2D(uDetail, duv * 0.21 + 0.37).r;
        float dd = dA * 0.6 + dB * 0.4;
        diffuseColor.rgb *= 0.70 + 0.60 * dd;
      }`);
  };
  floorMat.customProgramCacheKey = () => 'tp-field';
  const floor = new THREE.Mesh(geos.floor, floorMat);
  floor.receiveShadow = true;
  floor.name = 'pitch';
  root.add(floor);

  // 3D grass: stacked "shell" copies of the pitch a few cm apart; each layer keeps only the parts of
  // blades tall enough to reach it, so the turf looks fuzzy up close. Grows only on grass (not on the
  // painted lines, hex aprons or concrete), fades out with distance, receives shadows. Toggle: Settings ›
  // Graphics › Grass.
  const GRASS_H = 0.05, GRASS_LAYERS = 12;
  const grassMat = track(new THREE.MeshStandardMaterial({ map: field.map, roughness: 0.95, metalness: 0.0, envMapIntensity: 0.3 }));
  grassMat.onBeforeCompile = (sh) => {
    sh.vertexShader = sh.vertexShader
      .replace('#include <common>', '#include <common>\nvarying float vShell;\nvarying vec2 vBlade;')
      .replace('#include <begin_vertex>', `#include <begin_vertex>
      vShell = instanceMatrix[3][1] / ${GRASS_H.toFixed(3)};
      vBlade = position.xz * 38.0;`);
    sh.fragmentShader = sh.fragmentShader
      .replace('#include <common>', `#include <common>
      varying float vShell;
      varying vec2 vBlade;
      float gHash(vec2 p) { return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453); }
      ${MOW_SHEEN}`)
      .replace('#include <clipping_planes_fragment>', `#include <clipping_planes_fragment>
      float gDist = length(vViewPosition);
      float gReach = 1.0 - smoothstep(9.0, 26.0, gDist);
      if (vShell > gReach) discard;`)
      .replace('#include <map_fragment>', `#include <map_fragment>
      {
        float grassy = smoothstep(0.035, 0.09, diffuseColor.g - max(diffuseColor.r, diffuseColor.b));
        vec2 cell = floor(vBlade);
        vec2 f = fract(vBlade) - 0.5 + (vec2(gHash(cell + 3.1), gHash(cell + 7.7)) - 0.5) * 0.35;
        float hgt = (0.35 + 0.65 * gHash(cell)) * grassy * gReach;
        if (vShell > hgt) discard;
        float r = 0.4 * pow(1.0 - vShell / max(hgt, 0.001), 0.8);
        if (dot(f, f) > r * r) discard;
        diffuseColor.rgb *= mix(0.62, 1.12, vShell / max(hgt, 0.001)) * mowSheen(vMapUv);
      }`);
  };
  grassMat.customProgramCacheKey = () => 'tp-grass';
  const grass = new THREE.InstancedMesh(geos.floor, grassMat, GRASS_LAYERS);
  {
    const m4 = new THREE.Matrix4();
    for (let i = 0; i < GRASS_LAYERS; i++) grass.setMatrixAt(i, m4.makeTranslation(0, ((i + 1) / GRASS_LAYERS) * GRASS_H, 0));
  }
  grass.receiveShadow = true;
  grass.frustumCulled = false;
  grass.name = 'grass';
  grass.renderOrder = -1;
  root.add(grass);
  const setGrass = (on) => { grass.visible = !!on; };
  setGrass(!ctx.settings || !ctx.settings.graphics || ctx.settings.graphics.grass !== false);

  // lower walls (solid, team trims + ad boards): both halves in one mesh, the
  // team picks its half of the texture atlas through the uv.
  {
    const tx = makeLowerWallAtlas(renderer);
    track(tx.map); track(tx.emissiveMap);
    // the blue half's ring runs the other way round as seen from inside: flip s
    scaleUV(geos.lower[0], -1 / WALL_TILE, 0.5 / V_LOWER, 0, 0);
    scaleUV(geos.lower[1], 1 / WALL_TILE, 0.5 / V_LOWER, 0, 0.5);
    const m = track(new THREE.MeshStandardMaterial({
      map: tx.map, emissive: 0xffffff, emissiveMap: tx.emissiveMap, emissiveIntensity: 1.6,
      roughness: 0.55, metalness: 0.1, side: THREE.DoubleSide, envMapIntensity: 0.6,
    }));
    // back faces (seen only from outside the arena) are a plain dark structure
    m.onBeforeCompile = (sh) => {
      sh.fragmentShader = sh.fragmentShader
        .replace('#include <map_fragment>', `#include <map_fragment>
          if (!gl_FrontFacing) { // exterior: ribbed structural panels
            float rib = step(0.86, fract(vMapUv.x * 16.0));
            float band = step(0.47, fract(vMapUv.y * 2.0)) * step(fract(vMapUv.y * 2.0), 0.53);
            diffuseColor.rgb = vec3(0.13, 0.14, 0.16) + vec3(0.07) * max(rib, band);
          } else {
            // occlusion where the ramp meets the pitch: darkest at the floor, gone ~1.5 m up
            vec3 wpos = cameraPosition + transpose(mat3(viewMatrix)) * (-vViewPosition);
            diffuseColor.rgb *= mix(0.55, 1.0, smoothstep(0.0, 1.5, wpos.y)) * 0.9;
          }`)
        .replace('#include <emissivemap_fragment>', '#include <emissivemap_fragment>\n if (!gl_FrontFacing) totalEmissiveRadiance = vec3(0.0);');
    };
    m.customProgramCacheKey = () => 'tp-lowerwall';
    const wall = new THREE.Mesh(track(merge([geos.lower[0], geos.lower[1]])), m);
    wall.receiveShadow = true; wall.castShadow = true;
    wall.name = 'lowerWalls';
    root.add(wall);
  }

  // glass upper walls + ceiling (both teams, one transparent mesh): faint hex
  // grid, team tint via vertex colour/alpha, team glow via vertex emissive
  {
    const hex = track(makeHexTexture(renderer));
    const hexW = Math.sqrt(3) * HEX_A, hexH = 3 * HEX_A;
    const parts = [];
    for (const team of [0, 1]) {
      const tc = TEAM_COLORS[team];
      const tint = new THREE.Color(tc.light).lerp(new THREE.Color(0xffffff), 0.5);
      const glow = new THREE.Color(tc.glow);
      parts.push(setEmis(setColor(scaleUV(geos.glass[team], 1 / hexW, 1 / hexH), tint, 0.32), glow, 0.45));
      parts.push(setEmis(setColor(scaleUV(geos.ceiling[team], 1024 / hexW, 1024 / hexH), tint, 0.22), glow, 0.45));
    }
    const gm = track(vertexEmissive(new THREE.MeshStandardMaterial({
      map: hex, emissiveMap: hex, vertexColors: true, transparent: true,
      roughness: 0.15, metalness: 0.0, side: THREE.DoubleSide, depthWrite: false, forceSinglePass: true,
    }), 'glass'));
    const glass = new THREE.Mesh(track(merge(parts)), gm);
    glass.renderOrder = 3; glass.name = 'glass';
    root.add(glass);
  }

  // glowing mullions (both teams, unlit)
  {
    const parts = [0, 1].map((team) => setColor(buildMullions(team), new THREE.Color(TEAM_COLORS[team].glow).multiplyScalar(2.2)));
    const mull = new THREE.Mesh(track(merge(parts)), track(new THREE.MeshBasicMaterial({ vertexColors: true, side: THREE.DoubleSide })));
    mull.name = 'mullions';
    root.add(mull);
  }

  // ------------------------------------------------------------ goals, stadium, pads
  const goals = createGoals(ctx, geos);
  root.add(goals.object3d);
  const stadium = createStadium(ctx);
  root.add(stadium.object3d);
  const skyline = createSkyline();
  root.add(skyline.object3d);
  const pads = createPads(ctx);
  root.add(pads.object3d);

  // ------------------------------------------------------------ sky + scenery
  const sky = createSky(SUN_DIR, 1800);
  track(sky.geometry); track(sky.material);
  root.add(sky);
  const scenery = createScenery();
  track(scenery.geometry); track(scenery.material);
  root.add(scenery);

  // ------------------------------------------------------------ lighting
  const sun = new THREE.DirectionalLight(0xffeed6, 2.4);
  sun.castShadow = true;
  sun.shadow.bias = -0.0004;
  sun.shadow.normalBias = 0.025;
  sun.shadow.radius = 2.5;   // soft penumbra (PCF, Vogel-disk taps)
  const target = new THREE.Object3D();
  sun.target = target;
  root.add(target);
  // Tight shadow camera: X/Y extents fit the arena volume (incl. goals) in
  // light space, so car/ball shadows stay crisp. The depth range additionally
  // reaches up to the stadium roof/stands towards the sun, so the stadium casts
  // its shadow onto the pitch without widening the shadow map footprint.
  {
    const dist = 320;
    sun.position.copy(SUN_DIR).multiplyScalar(dist);
    target.position.set(0, 0, 0);
    const rot = new THREE.Matrix4().lookAt(sun.position, target.position, new THREE.Vector3(0, 1, 0));
    const inv = rot.clone().invert();
    const tmp = new THREE.Vector3();
    const toLight = (x, y, z) => tmp.set(x * S, z * S, y * S).sub(sun.position).applyMatrix4(inv);
    let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity, minZ = Infinity, maxZ = -Infinity;
    for (const x of [-X, X]) for (const y of [-GD, GD]) for (const z of [0, H]) {
      const p = toLight(x, y, z);
      minX = Math.min(minX, p.x); maxX = Math.max(maxX, p.x); minY = Math.min(minY, p.y); maxY = Math.max(maxY, p.y);
      minZ = Math.min(minZ, p.z); maxZ = Math.max(maxZ, p.z);
    }
    for (const x of [-STADIUM_EXTENT.x, STADIUM_EXTENT.x]) for (const y of [-STADIUM_EXTENT.y, STADIUM_EXTENT.y]) for (const z of [0, STADIUM_EXTENT.z]) {
      const p = toLight(x, y, z);
      maxZ = Math.max(maxZ, p.z); // nearest to the sun
    }
    const cam = sun.shadow.camera;
    cam.left = minX - 1; cam.right = maxX + 1; cam.bottom = minY - 1; cam.top = maxY + 1;
    cam.near = Math.max(0.5, -maxZ - 5); cam.far = -minZ + 5;
    cam.updateProjectionMatrix();
  }
  root.add(sun);
  const hemi = new THREE.HemisphereLight(0xc4dcff, 0x5a5a50, 0.5);
  root.add(hemi);
  // floodlight fill: the roof-ring lamps light the arena from every side, so the side away from the
  // sun is never flat ambient. A cooler, unshadowed key from the opposite quarter models that.
  const fill = new THREE.DirectionalLight(0xdfe8ff, 0.75);
  fill.position.set(-SUN_DIR.x, Math.max(0.6, SUN_DIR.y), -SUN_DIR.z).multiplyScalar(300);
  root.add(fill);

  // environment map (reflections / IBL)
  const pmrem = new THREE.PMREMGenerator(renderer);
  const envScene = buildEnvScene(sky.material);
  let envRT = null, envSize = 0;
  // Reflections: capture the real stadium (stands, lights, dome, skyline) from just above the
  // centre spot, so cars and the ball mirror the actual arena. The environment group is borrowed
  // into a capture scene for the six cube renders, then put back. Falls back to the simple stand-in.
  const captureScene = new THREE.Scene();
  captureScene.background = new THREE.Color(HAZE);
  function captureReal(size) {
    const parent = root.parent;
    const prevEnv = scene.environment;
    try {
      captureScene.add(root);
      captureScene.environment = prevEnv;
      captureScene.environmentIntensity = scene.environmentIntensity;
      return pmrem.fromScene(captureScene, 0.0, 0.3, 1900, { size, position: new THREE.Vector3(0, 1.6, 0) });
    } catch (e) {
      return null;
    } finally {
      if (parent) parent.add(root); else captureScene.remove(root);
    }
  }
  const standIn = (size) => pmrem.fromScene(envScene, 0.02, 0.1, 1000, { size, position: new THREE.Vector3(0, 3, 0) });
  function buildEnv(size) {
    if (size === envSize && envRT) return;
    // the first time, light the arena with the stand-in so the capture itself has sensible reflections
    if (!envRT) { envRT = standIn(size); scene.environment = envRT.texture; }
    const old = envRT;
    envRT = captureReal(size) || standIn(size);
    envSize = size;
    scene.environment = envRT.texture;
    old.dispose();
  }

  const prev = { environment: scene.environment, fog: scene.fog, background: scene.background, envInt: scene.environmentIntensity };
  scene.fog = new THREE.Fog(HAZE, 260, 1900);
  scene.background = new THREE.Color(HAZE);
  scene.environmentIntensity = 0.6;

  // ------------------------------------------------------------ quality
  // Only touch what changed. The environment map is built lazily a couple of
  // frames after start-up (keeps PMREM work off the critical start-up path).
  let envWanted = 128, envDelay = 2, curDetail = -1;
  function setQuality(name) {
    const q = QUALITY[name] || QUALITY.high;
    const sm = q.shadowMap || 2048;
    if (sun.shadow.mapSize.x !== sm) {
      sun.shadow.mapSize.set(sm, sm);
      if (sun.shadow.map) { sun.shadow.map.dispose(); sun.shadow.map = null; }
    }
    stadium.setCrowd(q.crowd ?? 1);
    const lvl = q.reflections ?? 1;
    envWanted = [64, 128, 256][Math.max(0, Math.min(2, lvl))];
    if (envDelay <= 0) buildEnv(envWanted);
    const detailLvl = name === 'low' ? 0 : (name === 'medium' ? 1 : 2);
    if (detailLvl !== curDetail) {
      const wasLow = curDetail === 0;
      curDetail = detailLvl;
      stadium.setDetail(detailLvl);
      skyline.setDetail(detailLvl);
      pads.setDetail(detailLvl);
      sky.material.uniforms.uCloudDetail.value = detailLvl === 0 ? 4 : 6;
      const aniso = detailLvl === 0 ? Math.min(4, maxAniso) : maxAniso;
      if (field.map.anisotropy !== aniso) { field.map.anisotropy = aniso; if (wasLow || detailLvl === 0) field.map.needsUpdate = true; }
    }
  }
  field.map.anisotropy = maxAniso;
  setQuality(ctx.qualityName || 'high');

  let time = 0;
  return {
    object3d: root,
    update(view, dt) {
      dt = Math.min(dt || 0, 0.1);
      time += dt;
      sky.material.uniforms.uTime.value = time;
      if (envDelay > 0 && --envDelay === 0) buildEnv(envWanted);
      if (view) pads.update(view, dt);
      stadium.update(view, dt, ctx.camera);
    },
    setQuality,
    setGrass,
    dispose() {
      pads.dispose(); goals.dispose(); stadium.dispose(); skyline.dispose();
      for (const d of disposables) d.dispose && d.dispose();
      if (envRT) envRT.dispose();
      pmrem.dispose();
      envScene.traverse((o) => { if (o.geometry) o.geometry.dispose(); if (o.material && o.material !== sky.material) o.material.dispose(); });
      if (sun.shadow.map) sun.shadow.map.dispose();
      scene.environment = prev.environment; scene.fog = prev.fog; scene.background = prev.background;
      if (prev.envInt !== undefined) scene.environmentIntensity = prev.envInt;
    },
  };
}
