// =============================================================================
// TURBO PITCH — car & ball models (OWNER: car & ball models agent)
// =============================================================================
// createCarModel(ctx, { bodyId, hitbox, team, accent, name, isPlayer })
//     -> { object3d, update(carView, dt, view), dispose() }
//   * Six original procedural low-poly bodies (see render/cars/bodies.js), one per hitbox
//     class: vector=OCTANE, lancer=DOMINUS, stingray=PLANK, arrowhead=BREAKOUT,
//     nomad=HYBRID, bulwark=MERC. Geometry is built once per body type and shared.
//   * object3d is a root Group at identity; it contains the car body group (placed with
//     applySimTransform every frame) and, for non-player cars, a camera-facing nameplate
//     (settings.graphics.nameplates) positioned in world space above the car.
//   * Wheels: one InstancedMesh for the 4 tyres + one for the 4 rims (skins: one per wheel material); placed at the wheel
//     hard points minus suspension length (suspension travel visible), spun by `spin`,
//     front wheels steered by cv.steer. Visual track is pushed outward a few uu per body so
//     the tyres sit under the fenders (physics hard points are unchanged).
//   * Draw calls per car (main pass): paint, trim, accent, glass, lights, chrome, boost glow,
//     tyres(instanced), rims(instanced) = 9, + 2 for the nameplate (bots only).
//   * Dev/debug URL params: ?hitbox=1 draws the hitbox wireframe; ?body=<id> forces a body;
//     ?carteam=0|1 forces the paint; ?carfov=<deg> sets the camera FOV (for side/top shots).
//
// getBoostNozzles(bodyId) -> THREE.Vector3[]
//   Model-space positions (metres, +X forward, +Y up, +Z right, origin = car origin/centre
//   of mass) of the centre of each boost nozzle EXIT plane. Flames should be emitted from
//   these points along -X (model space). bodyId may also be a hitbox preset name.
//   getBoostNozzleRadius(bodyId) -> number[] (metres), same order.
//
// createBallModel(ctx) -> { object3d, update(ballView, dt, view), dispose() }
//   Group with the panelled ball (procedural shader panels, emissive accents tinted by the
//   half of the pitch the ball is in, touch flash) and its world-down blob shadow decal
//   (render/cars/ball.js).
// =============================================================================
import * as THREE from 'three';
import { CAR_CONFIGS } from '../sim/carconfig.js';
import { TEAM_COLORS, CAR_BODIES } from '../contracts.js';
import { applySimTransform } from './util.js';
import { buildBody, bodySpec } from './cars/bodies.js';
import { isSkin, buildSkin } from './cars/skins.js';
import { getWheelGeometries } from './cars/wheels.js';
import { getSharedMaterials, getPaint, getAccent, syncEnvironment } from './cars/materials.js';
import { createNameplate } from './cars/nameplate.js';
export { createBallModel } from './cars/ball.js';

const params = typeof location !== 'undefined' ? new URLSearchParams(location.search) : new URLSearchParams();
const DEV_HITBOX = params.get('hitbox') === '1';
const DEV_BODY = params.get('body');
const DEV_TEAM = params.get('carteam');
const DEV_FOV = params.get('carfov');
const DEV_DEBUG = params.has('cardebug');

// a garage body or a skin (src/render/cars/skins.js, unlocked by modifier codes)
const bodyOrSkin = (bodyId) => (isSkin(bodyId) ? buildSkin(bodyId) : buildBody(bodySpec(bodyId)));
export function getBoostNozzles(bodyId) {
  return bodyOrSkin(bodyId).nozzles.map((v) => v.clone());
}
export function getBoostNozzleRadius(bodyId) {
  return bodyOrSkin(bodyId).nozzleRadius.slice();
}

// temporaries (no per-frame allocation)
const _m = new THREE.Matrix4(), _q = new THREE.Quaternion(), _qs = new THREE.Quaternion(), _qf = new THREE.Quaternion();
const _p = new THREE.Vector3(), _s = new THREE.Vector3(), _wp = new THREE.Vector3();
const AX_Y = new THREE.Vector3(0, 1, 0), AX_Z = new THREE.Vector3(0, 0, 1);
const Q_FLIP = new THREE.Quaternion().setFromAxisAngle(AX_Y, Math.PI);

export function createCarModel(ctx, opts) {
  let bodyId = DEV_BODY || opts.bodyId;
  if (!bodyId || !(isSkin(bodyId) || CAR_BODIES.find((b) => b.id === bodyId))) bodyId = bodySpec(opts.hitbox || 'OCTANE');
  const team = DEV_TEAM != null ? Number(DEV_TEAM) : opts.team;
  const body = bodyOrSkin(bodyId);
  const hitbox = body.hitbox;
  const cfg = CAR_CONFIGS[hitbox];
  const sh = getSharedMaterials();
  const paint = getPaint(team);
  let accentHex = opts.accent || '#e8e8e8';
  let accent = getAccent(accentHex);
  const tc = TEAM_COLORS[team] || TEAM_COLORS[0];
  const glowMat = new THREE.MeshBasicMaterial({ color: new THREE.Color(tc.glow), toneMapped: false, name: 'car.boostglow' });
  const glowBase = new THREE.Color(tc.glow);

  const root = new THREE.Group();
  root.name = 'car:' + bodyId;
  const carG = new THREE.Group();
  root.add(carG);
  const meshes = {};
  const mats = { paint, trim: sh.trim, accent, glass: sh.glass, light: sh.light, chrome: sh.chrome, glow: glowMat,
    ...(body.materialsFor ? body.materialsFor(team) : null) };   // skins bring their own (team-coloured) materials
  // Skins may split their mesh into moving parts: slot "<part>.<material>", geometry relative to the
  // part's pivot. Each part gets a group at its pivot, which the skin's rig moves every frame.
  const partGroups = {};
  for (const slot of Object.keys(body.geoms)) {
    const g = body.geoms[slot];
    if (!g) continue;
    const dot = slot.indexOf('.');
    const pid = dot > 0 ? slot.slice(0, dot) : null, cls = dot > 0 ? slot.slice(dot + 1) : slot;
    const m = new THREE.Mesh(g, mats[slot] || mats[cls]);
    m.name = slot;
    m.castShadow = cls !== 'light' && cls !== 'glow' && cls !== 'lamp' && !cls.startsWith('decal');
    m.receiveShadow = cls === 'paint' || cls === 'accent' || cls === 'trim' || cls.startsWith('wood') || ['satin', 'matte', 'gloss'].includes(cls);
    const part = pid && body.parts && body.parts[pid];
    if (part) {
      let grp = partGroups[pid];
      if (!grp) { grp = partGroups[pid] = new THREE.Group(); grp.name = 'part:' + pid; grp.position.copy(part.pivot); carG.add(grp); }
      grp.add(m);
    } else carG.add(m);
    meshes[slot] = m;
  }
  // wheels: one instanced mesh per wheel material (garage bodies: tyre + rim)
  const wg = body.wheel || getWheelGeometries(1, body.tyre.spokes || 5);
  const wm = (body.wheelMaterialsFor && body.wheelMaterialsFor(team)) || body.wheelMaterials || sh;
  const wheelMeshes = [];
  for (const [slot, geo] of Object.entries(wg)) {
    if (!geo) continue;
    const im = new THREE.InstancedMesh(geo, wm[slot] || sh.rim, 4);
    im.frustumCulled = false; im.receiveShadow = false;
    im.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    im.name = slot === 'tyre' ? 'tyres' : slot === 'rim' ? 'rims' : 'wheel.' + slot;
    // only the tyres cast a shadow (the rest sits inside them)
    im.castShadow = slot === 'tyre';
    if (slot === 'tyre') im.customDepthMaterial = sh.tyreDepth;
    carG.add(im);
    wheelMeshes.push(im);
  }
  const tyres = wheelMeshes.find((m) => m.name === 'tyres'), rims = wheelMeshes.find((m) => m.name === 'rims');
  const rig = body.createRig ? body.createRig(partGroups, { team, cfg, meshes }) : null;
  // chunky tyres that poke out past the body (wider than the base spec, pushed outward)
  const widen = body.tyre.modelled ? 1 : TYRE_WIDEN, out = body.tyre.modelled ? 0 : TYRE_OUT;
  const tyreW = [body.tyre.wF * widen / 100, body.tyre.wB * widen / 100];
  const extra = [body.tyre.extraF + out, body.tyre.extraB + out];

  // initial wheel pose (rest) so the model looks right before the first update
  const restSusp = (cfgW) => cfgW.suspRest - 12 - 2;
  {
    const ws = [cfg.frontWheels, cfg.frontWheels, cfg.backWheels, cfg.backWheels];
    for (let i = 0; i < 4; i++) {
      const w = ws[i], left = (i % 2) === 1, front = i < 2;
      setWheel(i, { offset: { x: w.offset.x, y: left ? -w.offset.y : w.offset.y, z: w.offset.z }, radius: w.radius, suspLen: restSusp(w), spin: 0, front, left }, 0);
    }
    for (const im of wheelMeshes) im.instanceMatrix.needsUpdate = true;
  }

  function setWheel(i, w, steer) {
    const front = w.front, left = w.left;
    const ex = front ? extra[0] : extra[1];
    // skins may draw their wheels elsewhere / at another size than the hitbox's: same contact height
    const tr = body.tyre.r;
    const vx = body.tyre.x ? body.tyre.x[front ? 0 : 1] : w.offset.x, vr = (Array.isArray(tr) ? tr[front ? 0 : 1] : tr) || w.radius;
    _p.set(vx / 100, (w.offset.z - w.suspLen - w.radius + vr) / 100, (w.offset.y + (left ? -ex : ex)) / 100);
    _qs.setFromAxisAngle(AX_Z, left ? w.spin : -w.spin);
    if (front && steer) { _qf.setFromAxisAngle(AX_Y, -steer); _q.copy(_qf); } else _q.identity();
    if (left) _q.multiply(Q_FLIP);
    _q.multiply(_qs);
    const r = vr / 100;
    _s.set(r, r, front ? tyreW[0] : tyreW[1]);
    _m.compose(_p, _q, _s);
    for (const im of wheelMeshes) im.setMatrixAt(i, _m);
  }


  // hitbox debug wireframe
  if (DEV_HITBOX) {
    const s = cfg.hitboxSize, o = cfg.hitboxOffset;
    const box = new THREE.LineSegments(new THREE.EdgesGeometry(new THREE.BoxGeometry(s.x / 100, s.z / 100, s.y / 100)),
      new THREE.LineBasicMaterial({ color: 0x00ff66, depthTest: false, transparent: true, toneMapped: false }));
    box.position.set(o.x / 100, o.z / 100, 0);
    box.renderOrder = 60;
    carG.add(box);
    // wheel hard points
    const hp = new THREE.Mesh(new THREE.SphereGeometry(0.012, 8, 6), new THREE.MeshBasicMaterial({ color: 0xff00ff, depthTest: false }));
    for (const w of [cfg.frontWheels, cfg.backWheels]) for (const sgn of [1, -1]) {
      const m = hp.clone(); m.position.set(w.offset.x / 100, w.offset.z / 100, sgn * w.offset.y / 100); m.renderOrder = 61; carG.add(m);
    }
  }

  // nameplate (non-player cars)
  const plate = opts.isPlayer ? null : createNameplate(opts.name || 'Bot', team);
  if (plate) root.add(plate.object3d);

  let glowLevel = 0.25;
  let t = Math.random() * 10;
  const dbg = DEV_DEBUG ? { bodyId, tyres, rims, carG, root, last: null } : null;
  if (dbg) (window.__carsDebug || (window.__carsDebug = { ctx, models: [] })).models.push(dbg);

  return {
    object3d: root,
    bodyId,
    update(cv, dt = 1 / 60, view) {
      syncEnvironment(ctx);
      if (DEV_FOV && ctx.camera.fov !== Number(DEV_FOV)) { ctx.camera.fov = Number(DEV_FOV); ctx.camera.updateProjectionMatrix(); }
      if (dbg) dbg.last = cv;
      const vis = !cv.isDemoed;
      carG.visible = vis;
      if (plate) {
        const on = vis && !(view && view.hideNameplates) && !!(ctx.settings && ctx.settings.graphics && ctx.settings.graphics.nameplates !== false);
        if (on) { _wp.set(cv.pos.x / 100, cv.pos.z / 100, cv.pos.y / 100); plate.update(_wp, cv.boost, ctx.camera, true, view); }
        else plate.update(null, 0, null, false, view);
      }
      if (!vis) return;
      applySimTransform(carG, cv.pos, cv.rot);
      // accent colour may change live (garage preview)
      if (cv.accent && cv.accent !== accentHex) {
        accentHex = cv.accent; accent = getAccent(accentHex);
        if (meshes.accent) meshes.accent.material = accent;
      }
      // wheels
      const ws = cv.wheels;
      if (ws && ws.length === 4) {
        const steer = cv.steer || 0;
        for (let i = 0; i < 4; i++) setWheel(i, ws[i], steer);
        for (const im of wheelMeshes) im.instanceMatrix.needsUpdate = true;
      }
      if (rig) rig.update(cv, dt);
      // boost nozzle glow (idle ember -> hot core while boosting, slight flicker)
      t += dt;
      const target = cv.isBoosting ? 3.2 + Math.sin(t * 47) * 0.35 + Math.sin(t * 23.3) * 0.25 : 0.22;
      glowLevel += (target - glowLevel) * Math.min(1, dt * (cv.isBoosting ? 30 : 8));
      const hot = Math.min(1, Math.max(0, (glowLevel - 0.3) / 3));
      glowMat.color.copy(glowBase).multiplyScalar(glowLevel).lerp(_white.setScalar(glowLevel * 0.9), hot * 0.45);
    },
    dispose() {
      glowMat.dispose();
      if (plate) plate.dispose();
      for (const im of wheelMeshes) im.dispose();
      if (rig && rig.dispose) rig.dispose();
      // body/wheel geometries and team/accent/skin materials are shared caches: not disposed here
    },
  };
}
const _white = new THREE.Color();
const TYRE_WIDEN = 1.35, TYRE_OUT = 2.5;
