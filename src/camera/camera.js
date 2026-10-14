// TURBO PITCH — camera controller (camera & input agent).
// createCameraController(ctx) -> { update(view, opts, frameDt), shake(amount 0..1), dispose() }
// opts = { mode: 'car'|'spectator'|'replay'|'fixed', targetCarId, ballCam, look:{x,y},
//          hint:{mode:'follow'|'wide'|'ball'|'goal', targetCarId, goalTeam?, goalPos?}, fixed:{pos, target, fov?} }  (sim units)
// While view.match.ballHidden (after a goal) ball-framing cams hold the last visible ball position.
// All rig maths lives in ./rig.js (sim space, Node-testable); this file converts the pose to
// Three.js, handles FOV (settings are HORIZONTAL degrees) and screen shake.
import * as THREE from 'three';
import { simToThree, simDirToThree } from '../render/util.js';
import { createCarRig, createLookRig, spectatorTarget, replayTarget, hfovToVfov } from './rig.js';

const BROADCAST_HFOV = 90;

export function createCameraController(ctx) {
  const cam = ctx.camera;
  const arena = ctx.arena ? { sdf: ctx.arena.sdf, raycast: ctx.arena.raycast } : null;
  const carRig = createCarRig();
  const replayCarRig = createCarRig();
  const lookRig = createLookRig();
  let lastMode = null, lastKey = null, replaySide = 1;
  let trauma = 0, shakeT = 0;
  let lastBall = null;

  const _p = new THREE.Vector3(), _d = new THREE.Vector3(), _u = new THREE.Vector3(), _t = new THREE.Vector3();
  const _right = new THREE.Vector3();

  function setFov(vfovDeg) {
    if (Math.abs(cam.fov - vfovDeg) > 1e-4) { cam.fov = vfovDeg; cam.updateProjectionMatrix(); }
  }

  const debug = { simPos: null, mode: null };
  const setMode = (m) => { debug.mode = m; };
  function applyPose(pose, dt) {
    debug.simPos = { x: pose.pos.x, y: pose.pos.y, z: pose.pos.z };
    simToThree(pose.pos, _p);
    simDirToThree(pose.dir, _d).normalize();
    simDirToThree(pose.up, _u).normalize();
    // screen shake: decaying positional + rotational noise in camera space
    if (trauma > 0) {
      shakeT += dt;
      const k = trauma * trauma;
      _right.crossVectors(_d, _u).normalize();
      const n1 = Math.sin(shakeT * 61.3) * 0.6 + Math.sin(shakeT * 97.1 + 1.3) * 0.4;
      const n2 = Math.sin(shakeT * 53.7 + 2.1) * 0.6 + Math.sin(shakeT * 89.9 + 0.4) * 0.4;
      const n3 = Math.sin(shakeT * 71.9 + 4.2);
      const amp = 0.22 * k; // metres
      _p.addScaledVector(_right, n1 * amp).addScaledVector(_u, n2 * amp);
      const rot = 0.022 * k; // radians
      _d.addScaledVector(_right, n2 * rot).addScaledVector(_u, n1 * rot).normalize();
      _u.addScaledVector(_right, n3 * rot * 0.6).normalize();
      trauma = Math.max(0, trauma - dt * 1.4);
    }
    cam.position.copy(_p);
    cam.up.copy(_u);
    _t.copy(_p).add(_d);
    cam.lookAt(_t);
  }

  function goalSide(ball) {
    if (Math.abs(ball.pos.y) > 1500) return Math.sign(ball.pos.y);
    const vy = ball.vel ? ball.vel.y : 0;
    return vy !== 0 ? Math.sign(vy) : (ball.pos.y >= 0 ? 1 : -1);
  }

  const api = {
    update(view, opts, frameDt) {
      opts = opts || { mode: 'car' };
      const dt = Math.min(Math.max(frameDt || 0, 0), 0.1);
      const aspect = cam.aspect || 16 / 9;
      const settingsCam = (ctx.settings && ctx.settings.camera) || {};
      const mode = opts.mode || 'car';
      setMode(mode);

      if (mode === 'fixed' && opts.fixed) {
        if (opts.fixed.fov) setFov(opts.fixed.fov);
        else if (lastMode !== 'fixed') setFov(70);
        debug.simPos = { ...opts.fixed.pos };
        simToThree(opts.fixed.pos, cam.position);
        cam.up.set(0, 1, 0);
        cam.lookAt(simToThree(opts.fixed.target, _t));
        lastMode = 'fixed';
        return;
      }

      const cars = view.cars || [];
      // after a goal the ball is parked behind the net while view.match.ballHidden: keep
      // framing the last position where it was visible (ball cam must not swing to the net)
      const hidden = !!(view.match && view.match.ballHidden);
      if (view.ball && !hidden) lastBall = { pos: { ...view.ball.pos }, vel: view.ball.vel ? { ...view.ball.vel } : { x: 0, y: 0, z: 0 } };
      const ball = hidden ? (lastBall || null) : view.ball;

      if (mode === 'replay') {
        const hint = opts.hint || { mode: 'follow' };
        const hm = hint.mode || 'follow';
        const tid = hint.targetCarId ?? opts.targetCarId;
        const car = cars.find((c) => c.id === tid) || null;
        const key = `${hm}|${tid}`;
        if (key !== lastKey || lastMode !== 'replay') {
          // which goal the action ends in: hint.goalPos (sim units) or hint.goalTeam (scoring
          // team: blue scores into +Y), else from the ball's position / direction
          if (hint.goalPos && Math.abs(hint.goalPos.y) > 1) replaySide = Math.sign(hint.goalPos.y);
          else if (hint.goalTeam === 0 || hint.goalTeam === 1) replaySide = hint.goalTeam === 0 ? 1 : -1;
          else replaySide = ball ? goalSide(ball) : 1;
          replayCarRig.reset();
          lookRig.reset();
        }
        lastKey = key;
        lastMode = 'replay';
        if (hm === 'follow' && car) {
          const pose = replayCarRig.update(car, ball, settingsCam, { ballCam: true, look: { x: 0, y: 0 } }, dt, aspect, arena);
          setFov(hfovToVfov(pose.hfov, aspect));
          applyPose(pose, dt);
          return;
        }
        if (!ball) return;
        const m = hm === 'follow' ? 'ball' : hm;
        const t = replayTarget(m, ball, car, replaySide);
        const pose = lookRig.update(t.pos, t.look, dt, m === 'ball' ? 4 : 2.5, m === 'ball' ? 9 : 6, key, arena);
        setFov(hfovToVfov(m === 'wide' ? 80 : BROADCAST_HFOV, aspect));
        applyPose(pose, dt);
        return;
      }

      const car = mode === 'car' ? cars.find((c) => c.id === opts.targetCarId) : null;
      if (!car) {
        // spectator broadcast cam (no player car)
        if (lastMode !== 'spectator') lookRig.reset();
        lastMode = 'spectator'; lastKey = null;
        if (!ball) return;
        const t = spectatorTarget(ball);
        const pose = lookRig.update(t.pos, t.look, dt, 1.6, 4, 'spectator', arena);
        setFov(hfovToVfov(BROADCAST_HFOV, aspect));
        applyPose(pose, dt);
        return;
      }

      if (lastMode !== 'car') carRig.reset();
      lastMode = 'car'; lastKey = null;
      const pose = carRig.update(car, ball, settingsCam, { ballCam: !!opts.ballCam, look: opts.look }, dt, aspect, arena);
      setFov(hfovToVfov(pose.hfov, aspect));
      applyPose(pose, dt);
    },
    shake(amount = 1) {
      trauma = Math.min(1, Math.max(trauma, amount));
    },
    dispose() {},
    // exposed for tests / debugging
    _rigs: { carRig, replayCarRig, lookRig },
    debug,
  };
  // automation hook (read-only): last camera position in sim units
  if (typeof window !== 'undefined') window.__camCtl = api;
  return api;
}
