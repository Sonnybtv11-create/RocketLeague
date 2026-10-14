# TURBO PITCH — module interfaces (lead-owned)

Everything here is a contract. Code against it; if you need a change, ask the lead.
The simulation (`src/sim/*`), `src/contracts.js`, `src/main.js`, `src/game/view.js`,
`src/game/settings.js`, `src/render/util.js` and `src/shell.html` are **lead-owned — do not edit**.

## Units & coordinates
* Simulation: Unreal Units (1 uu = 1 cm), Z-up. Blue defends −Y, orange defends +Y.
  Car local axes X forward, Y right, Z up. `RotMat.m` is row-major; columns are forward/right/up.
* Render (Three.js r186, `import * as THREE from 'three'`, addons from `'three/addons/...'`): Y-up, metres.
  Use `src/render/util.js`:
  * `simToThree(v)` → `(x, z, y) * 0.01`
  * `applySimTransform(obj3d, simPos, simRotMat)`
  * **Model space for anything attached to a car/ball: metres, +X forward, +Y up, +Z right**, origin = car origin
    (centre of mass). Hitbox centre is at `hitboxOffset` (sim local) → model `(off.x, off.z, 0)/100`.
* The arena collision SDF is in `src/sim/arena.js`: `arenaSDF(x,y,z)`, `arenaNormal`, `arenaRaycast`,
  `arenaRing(u)` (2D footprint ring offset inward by u), `arenaProfile()` (wall profile curve), `ARENA_PARAMS`
  (`X=4096, Y=5120, H=2044, C=1152 corner catheti, RF=256 floor fillet, RCG=256 ceiling fillet,
  RC=200 vertical corner rounding, GW=892.755 goal half width, GH=642.775 goal height, GD=6000 back of net`).

## The view object (read-only, built every frame by main.js — see `src/game/view.js`)
```
view = { time, tick, isReplay, ball: {pos, vel, angVel, rot}, cars: [CarView], pads: [PadView], match: MatchView|null }
CarView = { id, team, name, isBot, bodyId, hitbox, accent, pos, vel, angVel, rot, forward, right, up,
  boost, isBoosting, isSupersonic, isDemoed, isOnGround, numWheelsInContact, handbrakeVal, forwardSpeed, steer,
  controls:{throttle,steer,pitch,yaw,roll,jump,boost,handbrake}, hasJumped, hasFlipped, isFlipping, isJumping,
  airTimeSinceJump, demoRespawnTimer,
  wheels: [{offset{x,y,z}, radius, restLen, suspLen, spin, contact, front, left}] // 0 FR, 1 FL, 2 BR, 3 BL
}   // wheel centre (sim local) = offset - (0,0,suspLen)
PadView = { index, pos, isBig, isActive, cooldown }
```

## Events (array per frame, see `EV` in contracts.js)
`ballHit, ballBounce, carBump, demo, respawn, jump, doubleJump, dodge, land, supersonicStart, boostStart,
boostEnd, padPickup, goal, kickoffCountdown, kickoffGo, matchEnd, overtime, stat, quickChat, replayStart, replayEnd`
Each has `type` plus payload documented in contracts.js. Positions are sim units.

## ctx (passed to render modules)
`{ THREE, renderer, scene, camera, canvas, settings (live object), quality (QUALITY preset), qualityName, arena:{sdf, normal, raycast, ring, profile, params}, carConfigs }`
Renderer: WebGLRenderer, sRGB output, ACES tone mapping, PCFSoft shadow maps enabled.

## Modules (owner → file → factory)
| Module | File | Factory & methods |
|---|---|---|
| Environment (arena agent) | render/environment.js | `createEnvironment(ctx) → { object3d, update(view, dt), setQuality(name), dispose() }` — stadium, field, goals/nets, stands, crowd, lights (owns the shadow-casting light), sky, **boost pads from view.pads** |
| Cars & ball (car agent) | render/cars.js | `createCarModel(ctx, {bodyId, hitbox, team, accent, name, isPlayer}) → { object3d, update(carView, dt, view), dispose() }`; `createBallModel(ctx) → { object3d, update(ballView, dt, view), dispose() }` (ball includes its floor shadow decal) |
| VFX (vfx agent) | render/vfx.js | `createVFX(ctx) → { onEvents(events, view), update(view, dt, camera), setQuality(name), clear(), dispose() }` |
| Post (vfx agent) | render/post.js | `createPost(ctx) → { render(), setSize(w, h, pixelRatio), setQuality(name), dispose() }` — must call renderer for the scene; bloom, tone mapping, optional SSAO/motion blur |
| Camera (camera agent) | camera/camera.js | `createCameraController(ctx) → { update(view, opts, dt), shake(amount 0..1), dispose() }` opts: `{mode:'car'|'spectator'|'replay'|'fixed', targetCarId, ballCam, look:{x,y}, hint:{mode, targetCarId}, fixed:{pos,target}}` |
| Input (camera agent) | input/input.js | `createInput({canvas, settings, onAction}) → { poll(now), sampleTick() → Controls, getLook(), isBallCam(), setEnabled(b), startRebind(action, device, cb), cancelRebind(), lastDevice, dispose() }`. `onAction(name, down)` names: `pause, resetBall, debug (F3), skipReplay, scoreboard (down/up), ballCam` |
| Audio | audio/audio.js | `createAudio({settings}) → { unlock(), onEvents(events, view), update(view, listener, dt), setVolumes(audioSettings), setPaused(b), dispose() }` listener = `{pos (THREE.Vector3), quaternion, camera, playerCarId}` |
| UI | ui/ui.js (+ ui/*.js) | `createUI({root, api, settings, stats}) → { update(view, dt, info), onEvents(events, view), showMainMenu(), showPause(), hideMenus(), showEndScreen(matchView), showScoreboard(bool), isMenuOpen(), setDebug(on), dispose() }` |
| Bots | bots/bot.js (+ bots/*.js) | `createBot({difficulty:'rookie'|'pro'|'allstar', carId, team, rng}) → { tick(world, matchView, dt) → Controls, events: [] }` |
| Match flow & replay | game/match.js, game/replay.js | `createMatch({world, mode:'exhibition'|'freeplay', teamSize, durationSec, rng}) → Match` (see header of game/match.js) |

`info` passed to `ui.update`: `{ fps, playerCarId, tick, ballCam, inputDevice, mode ('menu'|'exhibition'|'freeplay'), paused, playerCar (CarView), world }`

`api` given to the UI by main.js:
`startMatch(cfg {teamSize, difficulty, teammateDifficulty, opponentDifficulty, playerTeam, bodyId, accent, durationSec}), startFreePlay(cfg), resumeGame(), quitToMenu(), rematch(), settingsChanged(), saveSettings(), getInput(), getSettings(), getStats(), runSelfTests(onLine) → Promise<results>, setPreviewCar(bodyId, accent, team), skipReplay(), resetBall(), getGame(), isFreePlay()`

Settings schema: `src/game/settings.js` (`DEFAULT_SETTINGS`, `DEFAULT_BINDINGS`). Modules read `settings` live; the UI mutates it then calls `api.settingsChanged()`.

## Dev workflow
* `npm install` (if `node_modules` is missing), then `node tools/assemble.mjs --dev` writes `src/dev.html`.
* Screenshot / smoke test: `node tools/shot.mjs "<query>" shots/x.png [--wait=ms] [--eval="js"] [--w= --h=]`.
  Query params understood by main.js:
  * `scene=kickoff|match` (exhibition, `size=1..3`, `diff=rookie|pro|allstar`), `scene=freeplay`, `scene=spectate` (bots only)
  * `cam=x,y,z,tx,ty,tz` fixed camera (sim units) — e.g. `cam=0,-7400,1700,0,0,0` wide shot from behind the blue goal
  * `advance=seconds` (run the sim forward before the first frame), `q=low|medium|high|ultra`, `debug=1`
  * `window.__game` exposes `{world, match, bots, playerCarId, mode, curFrame}` for `--eval` scripts.
  The tool prints console errors — keep it at **zero errors**.
* Physics self-tests: `node tools/run-selftests.mjs`.
* Final single file: `node tools/assemble.mjs` → `index.html` (lead runs this).
