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
import { ARENA_PARAMS } from '../sim/arena.js';
import { buildArenaGeometries, V_LOWER } from './env/arenaMesh.js';
import { makeFieldTextures, makeGrassDetail, makeLowerWallAtlas, makeHexTexture, WALL_TILE, HEX_A, STRIPE_W } from './env/textures.js';
import { setColor, setEmis, vertexEmissive, merge, scaleUV } from './env/matUtil.js';
import { createSky, createScenery } from './env/sky.js';
import { createPads } from './env/pads.js';
import { createGoals } from './env/goals.js';
import { createStadium } from './env/stadium.js';
import { buildWallDetail } from './env/wallDetail.js';
import { createSkyline } from './env/skyline.js';

const S = 0.01;
const { X, Y, H, GW, GD } = ARENA_PARAMS;

// Sun direction (towards the sun), sim coords -> three (x, z, y)
const SUN_SIM = new THREE.Vector3(-0.64, 0.2, 0.74).normalize();
const SUN_DIR = new THREE.Vector3(SUN_SIM.x, SUN_SIM.z, SUN_SIM.y);
const HAZE = 0xa9c6dc;

// glowing vertical light lines on the glass (team coloured), following the profile
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
  track(field.map); track(field.bumpMap); track(detail);
  const floorMat = track(new THREE.MeshStandardMaterial({ map: field.map, bumpMap: field.bumpMap, bumpScale: 3, roughness: 0.93, metalness: 0.0, envMapIntensity: 0.35 }));
  floorMat.onBeforeCompile = (sh) => {
    sh.uniforms.uDetail = { value: detail };
    sh.fragmentShader = sh.fragmentShader
      .replace('#include <common>', '#include <common>\nuniform sampler2D uDetail;\nfloat gDetailH;\n' + MOW_SHEEN)
      // blade-scale relief from the grass detail texture on top of the field bump map
      .replace('#include <normal_fragment_maps>', `
      #ifdef USE_BUMPMAP
        vec2 dH = dHdxy_fwd() + vec2(dFdx(gDetailH), dFdy(gDetailH)) * 0.9;
        normal = perturbNormalArb( - vViewPosition, normal, dH, faceDirection );
      #endif`)
      .replace('#include <map_fragment>', `#include <map_fragment>
      diffuseColor.rgb *= mowSheen(vMapUv);
      {
        vec2 duv = vMapUv * vec2(${(2 * X / 95).toFixed(2)}, ${(2 * Y / 95).toFixed(2)});
        float dA = texture2D(uDetail, duv).r;
        float dB = texture2D(uDetail, duv * 0.21 + 0.37).r;
        float dd = dA * 0.6 + dB * 0.4;
        gDetailH = dA;
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
    track(tx.map); track(tx.emissiveMap); track(tx.bumpMap);
    // the blue half's ring runs the other way round as seen from inside: flip s
    scaleUV(geos.lower[0], -1 / WALL_TILE, 0.5 / V_LOWER, 0, 0);
    scaleUV(geos.lower[1], 1 / WALL_TILE, 0.5 / V_LOWER, 0, 0.5);
    const m = track(new THREE.MeshStandardMaterial({
      map: tx.map, emissive: 0xffffff, emissiveMap: tx.emissiveMap, emissiveIntensity: 1.6, bumpMap: tx.bumpMap, bumpScale: 2.5,
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

  // physical wall detail: panel ribs, rim beam with LED strip, glass frame (lit metal + unlit glow)
  {
    const wd = buildWallDetail();
    const lit = track(merge([wd.metal, wd.dark].filter(Boolean)));
    const wm = new THREE.Mesh(lit, track(new THREE.MeshStandardMaterial({ vertexColors: true, metalness: 0.65, roughness: 0.34, envMapIntensity: 0.9 })));
    wm.name = 'wallDetail'; wm.receiveShadow = true; wm.castShadow = true;
    root.add(wm);
    const wg = new THREE.Mesh(track(wd.glow), track(new THREE.MeshBasicMaterial({ vertexColors: true })));
    wg.name = 'wallGlow';
    root.add(wg);
    for (const k of ['metal', 'dark']) if (wd[k]) wd[k].dispose();
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
  // Shadow camera follows the view: a SHADOW_HALF-metre square (light space) centred on the point of
  // the pitch the camera looks at, snapped to whole shadow texels so edges don't crawl as it moves.
  // This keeps car and ball shadows sharp (2048 px over ~56 m) instead of spreading the map over the
  // whole arena. The depth range reaches the stands, so they still shadow the pitch edges in view.
  const SHADOW_HALF = 28, SHADOW_DIST = 320;
  const cam = sun.shadow.camera;
  cam.left = -SHADOW_HALF; cam.right = SHADOW_HALF; cam.bottom = -SHADOW_HALF; cam.top = SHADOW_HALF;
  cam.near = 1; cam.far = SHADOW_DIST + 120;
  cam.updateProjectionMatrix();
  const lightRot = new THREE.Matrix4().lookAt(SUN_DIR, new THREE.Vector3(), new THREE.Vector3(0, 1, 0));
  const lightInv = lightRot.clone().invert();
  const _f = new THREE.Vector3(), _d = new THREE.Vector3(), _ls = new THREE.Vector3();
  const LIM_X = X * S - 4, LIM_Z = (Y + GD) * S - 4;
  function fitShadow(camera) {
    if (!camera) return;
    // focus: where the view ray meets the floor (or 22 m ahead when looking up), clamped to the arena
    camera.getWorldPosition(_f); camera.getWorldDirection(_d);
    let t = _d.y < -0.05 ? Math.min(22, -_f.y / _d.y) : 22;
    _f.addScaledVector(_d, t);
    _f.x = Math.max(-LIM_X, Math.min(LIM_X, _f.x)); _f.z = Math.max(-LIM_Z, Math.min(LIM_Z, _f.z)); _f.y = 0;
    // snap in light space
    const texel = (2 * SHADOW_HALF) / sun.shadow.mapSize.x;
    _ls.copy(_f).applyMatrix4(lightInv);
    _ls.x = Math.round(_ls.x / texel) * texel; _ls.y = Math.round(_ls.y / texel) * texel;
    _f.copy(_ls).applyMatrix4(lightRot);
    target.position.copy(_f);
    sun.position.copy(SUN_DIR).multiplyScalar(SHADOW_DIST).add(_f);
    target.updateMatrixWorld();
  }
  sun.position.copy(SUN_DIR).multiplyScalar(SHADOW_DIST);
  root.add(sun);
  const hemi = new THREE.HemisphereLight(0xc4dcff, 0x5a5a50, 0.5);
  root.add(hemi);
  // floodlight fill: the roof-ring lamps light the arena from every side, so the side away from the
  // sun is never flat ambient. A cooler, unshadowed key from the opposite quarter models that.
  const fill = new THREE.DirectionalLight(0xdfe8ff, 0.5);
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
      fitShadow(ctx.camera);
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
