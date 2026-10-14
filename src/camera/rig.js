// TURBO PITCH — camera rigs in simulation space (camera & input agent).
// Pure math (no THREE) so it can be tested in Node. Units: Unreal Units, Z-up, RL axes.
// Each rig returns a pose { pos, dir, up, hfov } (hfov = horizontal FOV, degrees).
//
// CAR CAM (RL behaviour, settings.camera):
//   * camera sits `distance` behind and `height` above the pivot (car centre), in a
//     frame whose forward = heading and up = frame up; the view is pitched by `angle` deg
//     (the car therefore sits in the lower part of the screen, like RL).
//   * heading: on the floor the car's forward; on walls / ceiling and in the air the
//     car's velocity direction (smoothly), falling back to forward when slow / reversing.
//   * frame up: world up on the floor and in the air; the surface normal (car up) on
//     walls and the ceiling, blended in over the curved ramp.
//   * stiffness: the pivot lags behind the car along its velocity by
//     (1 - stiffness) * 0.05 s, i.e. at 0 stiffness the camera falls ~115 uu further back at
//     2300 uu/s, at 1 it is rigid (matches the community measurement "at 0 stiffness the
//     distance grows by more than 100 at max speed").
//   * swivel speed: free-look (right stick) follow rate. transition speed: ball/car cam blend.
// BALL CAM: heading = horizontal car->ball direction (world up). When the ball is high the
//   whole rig orbits around the car (camera lowers, view tilts up, car keeps its screen
//   position) until the camera nears the floor, then the view tilts further on its own
//   (car slides toward the bottom of the screen). Ball directly above the car -> the
//   heading is kept (RL keeps the last direction instead of spinning).
// COLLISION: the camera is pulled in along the car->camera ray until it has > CLEARANCE
//   uu of free space (arena SDF), then pushed out along the SDF normal if still too close.

const DEG = Math.PI / 180;
export const CLEARANCE = 32;
const WORLD_UP = Object.freeze({ x: 0, y: 0, z: 1 });

// ---- tiny vector helpers (plain objects) ---------------------------------------
export const v3 = (x = 0, y = 0, z = 0) => ({ x, y, z });
const cp = (a) => ({ x: a.x, y: a.y, z: a.z });
const add = (a, b) => ({ x: a.x + b.x, y: a.y + b.y, z: a.z + b.z });
const sub = (a, b) => ({ x: a.x - b.x, y: a.y - b.y, z: a.z - b.z });
const mul = (a, s) => ({ x: a.x * s, y: a.y * s, z: a.z * s });
const dot = (a, b) => a.x * b.x + a.y * b.y + a.z * b.z;
const cross = (a, b) => ({ x: a.y * b.z - a.z * b.y, y: a.z * b.x - a.x * b.z, z: a.x * b.y - a.y * b.x });
const len = (a) => Math.sqrt(dot(a, a));
const norm = (a, fb = WORLD_UP) => { const l = len(a); return l > 1e-9 ? mul(a, 1 / l) : cp(fb); };
const lerpV = (a, b, t) => ({ x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t, z: a.z + (b.z - a.z) * t });
const clamp = (v, lo, hi) => (v < lo ? lo : v > hi ? hi : v);
const smoothstep = (e0, e1, x) => { const t = clamp((x - e0) / (e1 - e0), 0, 1); return t * t * (3 - 2 * t); };
const expK = (rate, dt) => 1 - Math.exp(-rate * dt);
const wrapPi = (a) => { while (a > Math.PI) a -= 2 * Math.PI; while (a < -Math.PI) a += 2 * Math.PI; return a; };
// project onto plane with normal n
const planar = (v, n) => sub(v, mul(n, dot(v, n)));
// rotate v about unit axis k by angle a (Rodrigues)
function rotAxis(v, k, a) {
  const c = Math.cos(a), s = Math.sin(a);
  const kxv = cross(k, v), kdv = dot(k, v);
  return { x: v.x * c + kxv.x * s + k.x * kdv * (1 - c), y: v.y * c + kxv.y * s + k.y * kdv * (1 - c), z: v.z * c + kxv.z * s + k.z * kdv * (1 - c) };
}
// signed angle from a to b about axis n (a, b in the plane of n)
function signedAngle(a, b, n) { return Math.atan2(dot(cross(a, b), n), dot(a, b)); }
// spherical-ish interpolation of unit vectors
function slerpDir(a, b, t) {
  const d = clamp(dot(a, b), -1, 1);
  if (d > 0.9999) return norm(lerpV(a, b, t));
  if (d < -0.9999) {
    // opposite: rotate around any perpendicular axis
    const axis = norm(Math.abs(a.z) < 0.9 ? cross(a, WORLD_UP) : cross(a, v3(1, 0, 0)));
    return rotAxis(a, axis, Math.PI * t);
  }
  const axis = norm(cross(a, b));
  return rotAxis(a, axis, Math.acos(d) * t);
}

// horizontal FOV (deg) -> vertical FOV (deg) for a given aspect (Hor+ beyond 16:9)
export function hfovToVfov(hfovDeg, aspect) {
  const a = Math.min(aspect || 16 / 9, 16 / 9);
  return 2 * Math.atan(Math.tan((hfovDeg * DEG) / 2) / a) / DEG;
}

// Pull a camera position in along origin->cam until it has clearance from the arena.
// Returns the allowed length along the ray.
export function clearanceLength(sdf, raycast, origin, dir, wantLen, clearance = CLEARANCE) {
  const o = origin;
  if (raycast) {
    const t = raycast(o.x, o.y, o.z, dir.x, dir.y, dir.z, wantLen + clearance, null);
    if (t >= 0) wantLen = Math.min(wantLen, Math.max(t - clearance, 0));
  }
  // corners / fillets: the sphere-traced hit may still leave the end point too close
  for (let i = 0; i < 12 && wantLen > 0; i++) {
    const p = add(o, mul(dir, wantLen));
    const d = sdf(p.x, p.y, p.z);
    if (d >= clearance) break;
    wantLen = Math.max(wantLen - Math.max(clearance - d, 4), 0);
  }
  return wantLen;
}
// push a point out of walls along the SDF gradient
export function pushOut(sdf, p, clearance = CLEARANCE) {
  let q = cp(p);
  for (let i = 0; i < 6; i++) {
    const d = sdf(q.x, q.y, q.z);
    if (d >= clearance) break;
    const e = 1;
    const n = norm(v3(
      sdf(q.x + e, q.y, q.z) - sdf(q.x - e, q.y, q.z),
      sdf(q.x, q.y + e, q.z) - sdf(q.x, q.y - e, q.z),
      sdf(q.x, q.y, q.z + e) - sdf(q.x, q.y, q.z - e)));
    q = add(q, mul(n, clearance - d + 1));
  }
  return q;
}

// ============================================================================ car / ball cam
export function createCarRig() {
  const s = {
    init: false, lastCarPos: v3(), pivotLag: v3(), heading: v3(0, 1, 0), up: cp(WORLD_UP),
    ballBlend: 0, pitchExtra: 0, lookYaw: 0, boomScale: 1, lastPose: null,
  };

  function reset() { s.init = false; }

  // car: CarView, ball: {pos}, cam: settings.camera, opts: {ballCam, look}, arena: {sdf, raycast}
  function update(car, ball, cam, opts, dt, aspect, arena) {
    dt = clamp(dt || 0, 0, 0.1);
    const D = cam.distance ?? 270, H = cam.height ?? 100;
    const angle = (cam.angle ?? -4) * DEG;
    const stiff = clamp(cam.stiffness ?? 0.45, 0, 1);
    const hfov = cam.fov ?? 110;
    const vHalf = (hfovToVfov(hfov, aspect) * DEG) / 2;
    const wantBall = !!opts.ballCam && !!ball;
    const cpos = car.pos;
    const fwd = car.forward, cup = car.up, vel = car.vel || v3();

    const teleport = !s.init || len(sub(cpos, s.lastCarPos)) > 500;
    s.lastCarPos = cp(cpos);
    if (car.isDemoed && s.lastPose && !teleport) {
      // demolished: hold the camera, keep looking at the ball
      const p = s.lastPose;
      if (ball) p.dir = slerpDir(p.dir, norm(sub(ball.pos, p.pos), p.dir), expK(3, dt));
      p.up = cp(WORLD_UP);
      return { ...p, hfov };
    }

    // ---------------------------------------------------------------- surface state
    const wheels = car.numWheelsInContact ?? (car.isOnGround ? 4 : 0);
    const onSurface = wheels >= 3 || !!car.isOnGround;
    // floor -> 0, ramp/wall/ceiling -> 1
    const wallW = onSurface ? smoothstep(0.97, 0.72, cup.z) : 0;

    // ---------------------------------------------------------------- ball cam blend
    const trans = clamp(cam.transitionSpeed ?? 1.2, 0.1, 5);
    const blendRate = 2.2 * trans; // 1.2 -> ~0.45 s full transition
    s.ballBlend = teleport ? (wantBall ? 1 : 0) : clamp(s.ballBlend + (wantBall ? 1 : -1) * blendRate * dt, 0, 1);
    const b = s.ballBlend * s.ballBlend * (3 - 2 * s.ballBlend);

    // ---------------------------------------------------------------- frame up
    const carCamUp = norm(lerpV(WORLD_UP, cup, wallW));
    const upTarget = b > 0 ? slerpDir(carCamUp, WORLD_UP, b) : carCamUp;
    if (teleport) s.up = upTarget;
    else s.up = norm(slerpDir(s.up, upTarget, expK(onSurface ? 9 : 3.2, dt)));
    const up = s.up;

    // ---------------------------------------------------------------- heading targets
    const fwdP = planar(fwd, up);
    let carHead = len(fwdP) > 0.1 ? norm(fwdP) : null;
    const vP = planar(vel, up), vSpeed = len(vP);
    if (!onSurface || wallW > 0.5) {
      // air / walls: follow the velocity direction when moving (not when reversing)
      const vDir = vSpeed > 1 ? mul(vP, 1 / vSpeed) : null;
      const vw = vDir ? smoothstep(150, 550, vSpeed) : 0;
      const ref = carHead || s.heading;
      if (vDir && vw > 0 && dot(vDir, ref) > (onSurface ? -0.2 : -0.6)) carHead = slerpDir(onSurface ? ref : planarNorm(s.heading, up), vDir, vw);
      else if (!onSurface) carHead = planarNorm(s.heading, up); // keep (e.g. straight up jump, reversing jump)
    }
    if (!carHead) carHead = planarNorm(s.heading, up);

    let target = carHead;
    if (b > 0 && ball) {
      const toBall = planar(sub(ball.pos, cpos), up);
      const lb = len(toBall);
      // ball (almost) directly above/below the car: keep the current direction
      const w = smoothstep(40, 380, lb);
      if (w > 0) {
        const ballHead = norm(toBall);
        const cur = planarNorm(s.heading, up);
        const bh = w < 1 ? slerpDir(cur, ballHead, w) : ballHead;
        const a = signedAngle(carHead, bh, up);
        target = rotAxis(carHead, up, a * b);
      } else {
        const cur = planarNorm(s.heading, up);
        target = rotAxis(carHead, up, signedAngle(carHead, cur, up) * b);
      }
    }
    // smoothing: car cam on a surface is nearly rigid; air & ball cam swing smoothly
    const rateCar = onSurface ? (wallW > 0.5 ? 10 : 22) : 5;
    const rate = rateCar + (9 - rateCar) * b;
    if (teleport) s.heading = target;
    else {
      const cur = planarNorm(s.heading, up);
      s.heading = rotAxis(cur, up, signedAngle(cur, target, up) * expK(rate, dt));
    }
    s.heading = planarNorm(s.heading, up);

    // ---------------------------------------------------------------- free look (car cam only)
    const look = opts.look || { x: 0, y: 0 };
    const lm = Math.hypot(look.x || 0, look.y || 0);
    let lookTarget = 0;
    if (lm > 0.05) lookTarget = Math.atan2(look.x || 0, -(look.y || 0)) * Math.min(lm, 1);
    lookTarget *= 1 - b;
    const swivel = clamp(cam.swivelSpeed ?? 5, 0.5, 20);
    if (teleport) s.lookYaw = lookTarget;
    else s.lookYaw = wrapPi(s.lookYaw + wrapPi(lookTarget - s.lookYaw) * expK(swivel * 2.2, dt));
    const heading = Math.abs(s.lookYaw) > 1e-5 ? rotAxis(s.heading, up, s.lookYaw) : s.heading;

    // ---------------------------------------------------------------- stiffness lag
    const lagT = (1 - stiff) * 0.05;
    let lagTarget = mul(vel, -lagT);
    const ll = len(lagTarget);
    if (ll > 150) lagTarget = mul(lagTarget, 150 / ll);
    s.pivotLag = teleport ? lagTarget : lerpV(s.pivotLag, lagTarget, expK(5, dt));
    const pivot = add(cpos, s.pivotLag);

    // ---------------------------------------------------------------- ball cam pitch
    const beta0 = Math.atan2(H, D);
    const orbitMax = Math.max(beta0 - 6 * DEG, 0);
    const boomL = Math.hypot(D, H);
    let pitchTarget = 0;
    if (b > 0 && ball) {
      let pe = s.pitchExtra;
      for (let it = 0; it < 3; it++) {
        const camP = rigPos(pivot, heading, up, D, H, Math.min(pe, orbitMax));
        const d = sub(ball.pos, camP);
        const e = Math.atan2(dot(d, up), len(planar(d, up)));
        // keep the ball a little above the screen centre, never tilt below the set angle
        pe = clamp(e - angle - vHalf * 0.3, 0, orbitMax + vHalf * 0.55);
      }
      pitchTarget = pe * b;
    }
    s.pitchExtra = teleport ? pitchTarget : s.pitchExtra + (pitchTarget - s.pitchExtra) * expK(6, dt);
    const orbit = Math.min(s.pitchExtra, orbitMax);
    const viewPitch = angle + s.pitchExtra;

    // ---------------------------------------------------------------- position + collision
    const ideal = rigPos(pivot, heading, up, D, H, orbit);
    const origin = cpos;
    const off = sub(ideal, origin);
    const offLen = len(off) || boomL;
    const dirC = mul(off, 1 / offLen);
    let allowed = offLen;
    if (arena && arena.sdf) allowed = clearanceLength(arena.sdf, arena.raycast, origin, dirC, offLen);
    const scaleT = allowed / offLen;
    if (teleport || scaleT < s.boomScale) s.boomScale = scaleT;
    else s.boomScale += (scaleT - s.boomScale) * expK(4, dt);
    let pos = add(origin, mul(dirC, offLen * s.boomScale));
    if (arena && arena.sdf) pos = pushOut(arena.sdf, pos);

    const dir = norm(add(mul(heading, Math.cos(viewPitch)), mul(up, Math.sin(viewPitch))));
    const camUp = norm(sub(mul(up, Math.cos(viewPitch)), mul(heading, Math.sin(viewPitch))));
    s.init = true;
    s.lastPose = { pos, dir, up: camUp };
    return { pos, dir, up: camUp, hfov };
  }

  return { update, reset, state: s };
}

function planarNorm(v, n) {
  const p = planar(v, n);
  if (len(p) > 1e-4) return norm(p);
  // degenerate: pick something perpendicular to n
  return norm(planar(Math.abs(n.y) < 0.9 ? v3(0, 1, 0) : v3(1, 0, 0), n));
}

// rig position: boom (-D, H) in (heading, up), orbited by `orbit` (pitch-up of the rig)
function rigPos(pivot, heading, up, D, H, orbit) {
  const c = Math.cos(orbit), sn = Math.sin(orbit);
  const bx = -D * c - H * sn;
  const bz = -D * sn + H * c;
  return add(pivot, add(mul(heading, bx), mul(up, bz)));
}

// ============================================================================ look-at rigs
// Smoothly moving camera that looks at a smoothed target. Used by spectator / replay cams.
export function createLookRig() {
  const s = { init: false, pos: v3(), target: v3(), key: null };
  function update(posTarget, lookTarget, dt, posRate, lookRate, key, arena) {
    dt = clamp(dt || 0, 0, 0.1);
    if (!s.init || key !== s.key) { s.pos = cp(posTarget); s.target = cp(lookTarget); s.init = true; s.key = key; }
    else {
      s.pos = lerpV(s.pos, posTarget, expK(posRate, dt));
      s.target = lerpV(s.target, lookTarget, expK(lookRate, dt));
    }
    let pos = s.pos;
    if (arena && arena.sdf) pos = pushOut(arena.sdf, pos, 60);
    const dir = norm(sub(s.target, pos), v3(0, 1, 0));
    return { pos, dir, up: cp(WORLD_UP) };
  }
  return { update, state: s, reset() { s.init = false; } };
}

// Spectator: broadcast camera high on the side of the pitch, tracking the ball.
export function spectatorTarget(ball) {
  const bp = ball.pos;
  const pos = v3(-3500, clamp(bp.y * 0.82, -3900, 3900), 1150 + Math.max(bp.z - 300, 0) * 0.25);
  const look = v3(bp.x * 0.85 - 150, bp.y, Math.min(bp.z, 900) * 0.8);
  return { pos, look };
}

// Replay hint cams. side = +1/-1: goal the ball is heading for (fixed per cut).
export function replayTarget(mode, ball, car, side) {
  const bp = ball.pos, bv = ball.vel || v3();
  if (mode === 'goal') {
    return { pos: v3(clamp(bp.x * 0.25, -600, 600), side * 5860, 330), look: cp(bp) };
  }
  if (mode === 'ball') {
    const hv = v3(bv.x, bv.y, 0);
    const d = len(hv) > 200 ? norm(hv) : v3(0, side, 0);
    const pos = add(bp, add(mul(d, -650), v3(0, 0, 260)));
    pos.z = clamp(pos.z, 120, 1900);
    return { pos, look: cp(bp) };
  }
  // 'wide': high end-on broadcast view from behind the attacking side, looking at the action
  const focus = car ? lerpV(bp, car.pos, 0.3) : bp;
  const pos = v3(clamp(focus.x * 0.35, -2500, 2500), clamp(focus.y - side * 3400, -4700, 4700), 1350);
  return { pos, look: v3(focus.x, focus.y, Math.min(focus.z, 700)) };
}
