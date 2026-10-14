# BUILD PROMPT — Rocket League recreation, single HTML file

You are building a faithful, playable recreation of Rocket League (Soccar mode) that runs in a web browser from **one self-contained `index.html`**. The bar is "a Rocket League player could close their eyes, play it, and recognise the handling": same units, same constants, same mechanics, same match flow. Mechanics like half-flips, wavedashes, speed-flips, flip resets, air-roll shots, ceiling shots and demos must *emerge* from the physics, not be scripted.

Work in phases (below), test each phase against the numeric checks before moving on, and finish with a complete, working file — no TODOs, no placeholder systems, no "left as an exercise".

---

## 0. Hard requirements

- **One file:** `index.html` with all JS/CSS inline. Only external dependency allowed: Three.js (latest stable, ES module via import map from jsDelivr/unpkg). No build step. Must work opened straight from disk *and* from any static host.
- **Desktop only:** Mac (MacBook Pro M5 Pro — Safari + Chrome) and Windows gaming PC (RTX 3070 Ti / Ryzen 5 5600X — Chrome). No mobile support or touch controls needed. Physics always at a fixed 120 Hz; render uncapped up to the display refresh rate (support 120/144 Hz monitors), minimum 60 fps at High on both machines. Graphics can be ambitious — this is desktop-class hardware.
- **Inputs:** keyboard + mouse and gamepad (Gamepad API), both fully playable, all remappable.
- **Original assets only:** mechanics, numbers and layout match Rocket League, but car bodies, arena art, logos, sounds and music are original (procedural / made in code). Don't use the "Rocket League" name or Psyonix logos in the UI — give the game an original title (placeholder: **TURBO PITCH**). Don't load Rocket League's extracted collision meshes or any ripped files.
- **Units:** keep the simulation in Unreal Units (1 uu = 1 cm), Z-up, exactly like the real game. Convert to Three.js (Y-up, metres) only in the render layer.

---

## 1. Primary reference — port, don't guess

The constants and logic below come from **RocketSim** (github.com/ZealanL/RocketSim), an open-source re-implementation of RL's physics validated against the real game, plus the RLBot / RLGym game-value tables. **If you have web access, fetch and read these files first and port their logic to JS line by line** (check the repo licence and credit it in a comment):

- `src/RLConst.h` — every constant and curve
- `src/Sim/Car/Car.cpp` — drive, sticky forces, jump, dodge, air control, boost, supersonic, auto-flip/roll
- `src/Sim/Car/CarConfig/CarConfig.cpp` — hitbox & wheel presets
- `src/Sim/Ball/Ball.cpp` — ball setup, extra hit impulse, clamps
- `src/Sim/Arena/Arena.cpp` — car-ball / car-car / car-world contact rules, kickoff, goal check
- `btVehicleRL` (the modified Bullet raycast vehicle in the same repo) — suspension, wheel friction impulses
- `src/Sim/BoostPad/` — pad pickup volumes

Everything below is the fallback if you can't fetch, and the spec you must match either way. Anything marked **[verify]** should be checked online before use.

---

## 2. Coordinate system & conventions

- Field centre is origin. Blue defends −Y, Orange defends +Y. Z up.
- Car local axes: X forward, Y right, Z up. Yaw 0 faces +X; a blue kickoff yaw of π/2 faces +Y.
- RL's world is left-handed. Keep the sim in RL coordinates and mirror one axis in the render transform so that: steering right turns right on screen, blue goal appears where it should, kickoff spawns look correct. Write a quick visual test for this.
- Fixed timestep 1/120 s with an accumulator; render interpolates between the last two physics states. Clamp the accumulator (max ~8 ticks/frame) so a tab switch doesn't explode.

---

## 3. Constants (exact)

### World
| | |
|---|---|
| Gravity | −650 uu/s² |
| Side walls | x = ±4096 |
| Back walls (goal line) | y = ±5120 |
| Ceiling | z = 2044 |
| Back of net | y = ±6000 (goal depth 880) |
| Goal half-width (centre to post) | 892.755 |
| Goal height | 642.775 |
| Corner 45° wall catheti | 1152 |
| Floor→wall ramp height | 256 (curved transition) |
| Goal scored when | \|ball.y\| > 5124.25 + ball radius (whole ball over the line) |

### Ball
| | |
|---|---|
| Radius | 91.25 |
| Mass | 30 (car mass / 6), solid-sphere inertia |
| Rest height | 93.15 (kickoff spawn at (0, 0, 92.75)) |
| Max speed | 6000 uu/s |
| Max angular speed | 6 rad/s |
| Drag | 0.03 (linear damping: v *= (1−0.03)^dt) |
| World friction / restitution | 0.35 / 0.6 |

### Car (all hitboxes)
| | |
|---|---|
| Mass | 180, box inertia from hitbox, gyroscopic forces off |
| Max speed | 2300 uu/s (hard clamp on total velocity) |
| Max angular speed | 5.5 rad/s (hard clamp) |
| Supersonic | start ≥ 2200; while supersonic and supersonicTime < 1 s, stays supersonic down to 2100 |
| Spawn boost | 33.33 |

### Boost
| | |
|---|---|
| Consumption | 33.33 per second (full tank = 3 s) |
| Accel — on ground | 991.67 uu/s² (and forces throttle = 1 while boosting) |
| Accel — airborne | 1058.33 uu/s² |
| Minimum boost time | 0.1 s once started |
| Big pad | +100, respawn 10 s, pickup cylinder r 208 |
| Small pad | +12, respawn 4 s, pickup cylinder r 144 |
| Pad cylinder height | 95 |

**Big pads (z 73):** (±3584, 0), (±3072, ±4096)
**Small pads (z 70), all 28:** (0,−4240) (−1792,−4184) (1792,−4184) (−940,−3308) (940,−3308) (0,−2816) (−3584,−2484) (3584,−2484) (−1788,−2300) (1788,−2300) (−2048,−1036) (0,−1024) (2048,−1036) (−1024,0) (1024,0) (−2048,1036) (0,1024) (2048,1036) (−1788,2300) (1788,2300) (−3584,2484) (3584,2484) (0,2816) (−940,3308) (940,3308) (−1792,4184) (1792,4184) (0,4240)

### Driving
| | |
|---|---|
| Throttle accel | 1600 × curve(\|fwd speed\|) uu/s², curve: 0→1.0, 1400→0.1, 1410→0 (so throttle-only top speed ≈ 1410) |
| Fewer than 3 wheels down | drive force ÷ 4 |
| Brake (throttle opposite to motion) | ≈ 3500 uu/s², throttle killed while braking |
| Coasting (no throttle) | brake factor 0.15 (≈ 525 uu/s²); full brake below 25 uu/s |
| Max steer angle vs speed | 0→0.53356, 500→0.31930, 1000→0.18203, 1500→0.10570, 1750→0.08507, 3000→0.03454 rad |
| Powerslide steer angle | 0→0.39235, 2500→0.12610 rad (blended in by handbrake value) |
| Handbrake value | analog 0–1, rises 5/s while held, falls 2/s when released |
| Lateral friction vs slip ratio | 0→1.0, 1→0.2 (slip ratio = lat / (lat+long) when lat slip > 5 uu/s) |
| Under handbrake | lateral × lerp(1, 0.1, hb); longitudinal × lerp(1, curve(0→0.5, 1→0.9), hb) |
| Non-sticky (throttle = 0) | wheel friction × curve(contact normal z): 0→0.1, 0.7075→0.5, 1→1.0 — this is why you slide down walls when you let go |
| Sticky force | if any wheel touches world: force along −surfaceUp of (0.5 + (fullStick ? 1−\|up.z\| : 0)) × 650 × mass; fullStick = throttle ≠ 0 or speed > 25 |
| Fallback turning model (only if not using raycast wheels) | curvature 0→0.0069, 500→0.00398, 1000→0.00235, 1500→0.001375, 1750→0.0011, 2300→0.00088 |

**Suspension (btVehicleRL):** stiffness 500, damping compression 25, relaxation 40, max travel 12, force scale front 35.75 / back 54.265. Wheel raycasts must hit the arena **and the ball and other cars** — this is what makes flip resets and landing on cars work. `isOnGround` = 3+ wheels in contact.

### Hitboxes (length, width, height | offset x, z)
| Preset | Size | Offset | Wheel radius F/B | Susp. rest F/B | Front wheel (x,y,z) | Back wheel (x,y,z) |
|---|---|---|---|---|---|---|
| Octane | 120.507 × 86.6994 × 38.6591 | 13.8757, 20.755 | 12.5 / 15 | 38.755 / 37.055 | 51.25, 25.90, 20.755 | −33.75, 29.50, 20.755 |
| Dominus | 130.427 × 85.7799 × 33.8 | 9.0, 15.75 | 12 / 13.5 | 33.95 / 33.85 | 50.30, 31.10, 15.75 | −34.75, 33.00, 15.75 |
| Plank | 131.32 × 87.1704 × 31.8944 | 9.00857, 12.0942 | 12.5 / 17 | 31.9242 / 27.9242 | 49.97, 27.80, 12.0942 | −35.43, 20.28, 12.0942 |
| Breakout | 133.992 × 83.021 × 32.8 | 12.5, 11.75 | 13.5 / 15 | 29.7 / 29.666 | 51.50, 26.67, 11.75 | −35.75, 35.00, 11.75 |
| Hybrid | 129.519 × 84.6879 × 36.6591 | 13.8757, 20.755 | 12.5 / 15 | 38.755 / 37.055 | 51.25, 25.90, 20.755 | −34.00, 29.50, 20.755 |
| Merc | 123.22 × 79.2103 × 44.1591 | 11.3757, 21.505 | 15 / 15 | 39.505 / 39.105 | 51.25, 25.90, 21.505 | −33.75, 29.50, 21.505 |

(Suspension ray length = rest − 12 max travel, per RocketSim. Mirror y for left wheels.) Build an **original** low-poly body for each preset that fills its hitbox convincingly; the player picks one in a garage screen and the label shows which hitbox class it uses.

### Jumping & dodging
| | |
|---|---|
| Jump impulse | 291.67 uu/s along car up |
| Jump hold accel | 1458.33 uu/s² along car up (× 0.62 for the first 0.025 s) |
| Jump min / max hold | 0.025 s / 0.2 s |
| Second jump window | within 1.25 s **after the first jump finishes**; no window limit if you never jumped (drove off a wall/ramp) |
| Double jump | another 291.67 uu/s along car up |
| Dodge vs double jump | dodge if \|pitch\|+\|yaw\|+\|roll\| ≥ 0.5 (dodge deadzone), else double jump |
| Dodge direction | dir = normalize(−pitch, yaw+roll) in car forward/right; zeroed if both components < 0.1 (= stall) |
| Dodge impulse | 500 × dir; forward component × (1 + (S−1)·v/2300) with S = 1.0 forward, 2.5 backward; side component × (1 + 0.9·v/2300); backward also × 16/15; applied in the car's flattened (2D) forward/right frame |
| Flip torque | angular accel 260 rad/s² (roll axis, side dodges) and 224 rad/s² (pitch axis) in local frame, for 0.65 s; angular speed still clamped to 5.5 |
| Flip cancel | if pitch input has the same sign as the flip's pitch torque, scale that torque by 1−\|pitch\| (this is how half-flips work) |
| Z-velocity damping | from 0.15 s to 0.65 s into the flip, while vz < 0 or t < 0.21 s: vz *= 0.65 per 120 Hz tick |
| Pitch lock | no pitch air control during flip and for 0.3 s after flip torque ends |
| Flip resets | landing 3+ wheels on anything (incl. the ball) resets jump/flip state; if the car hasn't jumped since, the flip is kept indefinitely |

### Air control (per full input, rad/s², local axes)
| | Torque | Damping |
|---|---|---|
| Pitch | 12.46 | 2.876 × ω × (1 − \|pitch input\|) |
| Yaw | 9.11 | 1.917 × ω × (1 − \|yaw input\|) |
| Roll | 38.35 | 4.79 × ω (always on) |
| Air throttle | 66.67 uu/s² forward when throttle held in air | |

(These are RocketSim's `CAR_AIR_CONTROL_TORQUE (130, 95, 400)` and `DAMPING (30, 20, 50)` × `CAR_TORQUE_SCALE = 2π/65536 × 1000`.) Air control is only active with 0 wheels touching; partial contact runs auto-roll instead.

### Auto-flip / auto-roll
- **Auto-flip** (on your roof): jump pressed while touching world with normal z > 0.707 and |roll| > 2.8 rad → impulse 200 uu/s along −up, roll angular accel 50 rad/s² for 0.4 × (|roll|/π) s. No dodge allowed while auto-flipping.
- **Auto-roll**: throttle held with 1–3 wheels down (or hitbox touching world) → push toward the surface at 100 uu/s² and torque 80 to align wheels with it.

### Contacts
| Pair | Friction | Restitution | Extra |
|---|---|---|---|
| Car–ball | 2.0 | 0.0 | + Psyonix extra impulse (below) |
| Car–car | 0.09 | 0.1 | + bump / demo (below) |
| Car–world | 0.3 | 0.3 | records contact normal for auto-flip/roll |
| Ball–world | 0.35 | 0.6 | |

**Extra car→ball impulse** (on top of the rigid-body contact; at most once per 2 ticks per car):
```
relPos  = ball.pos − car.pos
relSpeed = min(|ball.vel − car.vel|, 4600)
hitDir  = normalize(relPos * (1, 1, 0.35))
hitDir  = normalize(hitDir − carForward * dot(hitDir, carForward) * 0.35)
ball.vel += hitDir * relSpeed * curve(relSpeed)     // curve: 0→0.65, 500→0.65, 2300→0.55, 4600→0.30
```
Added at the end of the tick, then the ball's 6000 / 6 rad/s clamps apply.

**Bump / demo** (checked both ways each contact, 0.25 s cooldown per pair):
- Attacker must be moving toward the victim faster than the victim moves away, and the contact point must be on the attacker's front (local x > 64.5).
- Attacker supersonic and on the other team → **demolish**: victim explodes, respawns after 3 s.
- Otherwise → victim velocity += velDir × curve + up × upCurve, where ground curve: 0→0.833, 1400→1100, 2200→1530; air curve: 0→0.833, 1400→1390, 2200→1945; upward curve: 0→0.333, 1400→278, 2200→417 (up = victim's up if grounded, else world up).

---

## 4. Physics engine architecture

Write a small custom rigid-body engine (no physics library — the game-specific behaviour needs to be exact):

1. **Arena as a signed distance field** built procedurally from the dimensions above: floor, side walls, back walls with goal cut-outs, 45° corner walls, curved floor-to-wall and wall-to-ceiling transitions, ceiling, goal interiors (floor, side walls, roof, back net). Provide `sdf(p)` and `normal(p)` (analytic gradient). The ball is a sphere vs SDF; wheel raycasts sphere-march the SDF; the car hitbox tests its 8 corners, 12 edge midpoints and 6 face centres against the SDF. Also generate a matching render mesh from the same parameters so visuals and collision never disagree.
2. **Car–ball:** exact OBB-vs-sphere closest point. **Car–car:** OBB-vs-OBB SAT with contact points.
3. **Solver:** sequential impulses (8–10 iterations) with Coulomb friction, restitution, and split-impulse / position correction so nothing sinks. Contact friction/restitution per the table above.
4. **Car update order per tick** (match RocketSim's `_PreTickUpdate`): handbrake value → wheel raycasts → throttle/brake/steer → friction → sticky force → air torque (if < 3 wheels) → jump → auto-flip → double jump / dodge → auto-roll → suspension & wheel forces → boost. Then integrate, solve contacts, then post-tick (supersonic, cooldowns, velocity clamps, boost-pad pickup, demo respawn timers).
5. **Ball prediction:** a function that clones the ball and steps it forward alone (same code path) for up to 6 s — used by the bots and by an optional prediction line in Free Play.

---

## 5. Match rules & flow (Soccar)

- Modes: 1v1, 2v2, 3v3 (exhibition vs bots, any team mix), plus **Free Play** (you + ball, no clock, reset ball key, toggleable ball-prediction line, unlimited boost toggle).
- **5:00 match clock.** Clock doesn't start counting until the ball is first touched after a kickoff **[verify]**.
- **Kickoff:** 3-2-1-GO countdown, cars frozen until GO, everyone on 33.33 boost, all pads reset. Spawns (blue; mirror x and y and add π to yaw for orange), assigned randomly without repeats: (−2048, −2560, yaw π/4), (2048, −2560, 3π/4), (−256, −3840, π/2), (256, −3840, π/2), (0, −4608, π/2). Car z 17.
- **Demo respawn:** after 3 s at a random one of (−2304, −4608), (−2688, −4608), (2304, −4608), (2688, −4608), facing π/2 (mirrored for orange), z 36, with 33.33 boost.
- **Goal:** ball explodes in the scoring team's colour with a radial blast that throws nearby cars; ~3 s celebration; skippable replay; kickoff.
- **Zero-second rule:** at 0:00 the match only ends when the ball next touches the floor.
- **Overtime:** if tied, unlimited sudden-death; clock counts up as "+M:SS".
- **Points & stats per player:** goals, assists, saves, shots, demos, score. Use RL's points table (Goal 100, Assist 50, Save 50, Epic Save 75, Shot on goal 20, Demolition 25, Clear 20, Centre 10, Aerial hit 25, First touch 10 **[verify all]**). Shot/save detection: use the ball-prediction function — a touch that sends the ball on a trajectory into the goal is a shot; a touch that stops a predicted goal is a save.
- End-of-match scoreboard with MVP, and "Rematch / Main menu".

---

## 6. Replays

Record full world state (all cars incl. inputs-derived visual state like boost flames, ball, pad states) into a 120 Hz ring buffer. Goal replay plays the last ~6 s with a few auto-cut cameras (following scorer, wide arena shot, ball chase), with a "Skip" button and a "REPLAY" banner. Cars and ball interpolate exactly as in live play.

---

## 7. Camera (must feel like RL's)

- Behind-car chase camera with RL's settings, all adjustable in a settings menu and saved: **FOV** (60–110, default 110), **Distance** (100–400, default 270), **Height** (40–200, default 100), **Angle** (−15 to 0, default −4), **Stiffness** (0–1, default 0.45), **Swivel speed** (1–10, default 5), **Transition speed** (1–2, default 1.2) **[verify defaults]**.
- **Ball cam** toggle (and hold-to-toggle option): camera keeps the ball framed while staying behind the car, with smooth transition at the transition speed. Car cam follows velocity direction smoothly when airborne/on walls, not raw car orientation.
- Free-look via right stick / mouse when car cam is active. Camera never clips through walls (pull in along the ray).
- Spectator / replay cameras as above.

---

## 8. Controls (all remappable, saved)

**Keyboard & mouse (RL PC defaults):** W/S throttle/reverse, A/D steer & air yaw/roll-depending, mouse or arrow keys for air pitch (option), **Left mouse = boost, Right mouse = jump**, Left Shift = powerslide / free air roll, Q/E = air roll left/right, Space = ball cam, Esc = pause. Separate binds for air pitch up/down.

**Gamepad (Gamepad API, standard mapping):** RT throttle, LT reverse, left stick steer/pitch/yaw, A jump, B boost, X powerslide/air roll, Y ball cam, LB/RB directional air roll (configurable), right stick free-look. Settings for stick deadzone (default 0.2), dodge deadzone (default 0.5), and analog sensitivity like RL's "controller deadzone / dodge deadzone / aerial sensitivity / steering sensitivity".

Pressing jump must register the exact tick it was pressed (sample input every physics tick from the latest state; buffer presses between frames so a quick tap is never lost).

---

## 9. Bots (three difficulties)

Bots drive the **same car simulation with the same inputs** a player has — no cheating physics.

- **Core:** ball prediction → find earliest reachable intercept (time to reach given speed/boost) → drive/steer with a PD controller, powerslide for tight turns, boost management (pick up pads on route, don't waste when supersonic).
- **Rookie:** ground play only, slow reactions (~400 ms), no flips except basic.
- **Pro:** jump shots, front flips for speed, simple aerials, basic rotation.
- **All-Star:** full aerials (boost + air control solved toward predicted intercept), wall play, dodging into the ball, speed-flip kickoffs, half-flips to turn around, demos when supersonic and convenient, shadow defence, fast rotation.
- **Teamwork (2v2/3v3):** roles recalculated continually — first man challenges, second supports/backs up, third stays back; rotate back-post; don't double commit.
- **Kickoffs:** each bot recognises its spawn and runs a kickoff routine (diagonal speed-flip, centre fake/cheat by difficulty).
- Human-sounding quick chat from bots ("What a save!", "Nice shot!") optional.

---

## 10. Visuals

- Three.js with a stadium that reads like a real RL arena at a glance: field with team-coloured halves, centre circle and lines, goal-box markings, glowing goal frames, nets (transparent with mesh pattern), stands with crowd silhouettes, floodlights, skybox, team-coloured back walls. All original designs.
- **Ball:** panelled ball with emissive accents; **ball shadow directly beneath it on the floor** (critical gameplay cue); ball-touch flash.
- **Cars:** team paint (blue / orange), spinning wheels with suspension travel visible, boost flame + trail particles, supersonic wind streaks, landing sparks, powerslide tyre marks.
- **Boost pads:** big pads as tall glowing orbs on a pad, small pads as flat discs; visibly empty while respawning.
- **Goal explosion**, **demo explosion** (car breaks apart, smoke), screen shake on big hits (toggleable).
- Nameplates above cars with boost bar optional.
- Quality presets (Low/Medium/High/Ultra): shadow map size, particle counts, render scale, post-processing (bloom, SSAO, motion blur toggle, tone mapping), crowd detail, reflection quality. Default High.

## 11. HUD & UI

- Top centre: blue score – clock – orange score; "OVERTIME" when relevant.
- Bottom right: circular boost meter 0–100 with number.
- Event feed (goals, saves, demos with player names) and points pop-ups ("GOAL +100").
- Countdown and "GO!" overlay; "REPLAY" banner; end-of-match scoreboard with per-player stats and MVP.
- Main menu: Play (choose mode/team size/bot difficulty/car), Free Play, Garage (pick body/hitbox, paint accent), Settings (camera, controls, bindings, graphics, audio), Controls help.
- Debug overlay toggle (F3): fps, tick, car speed, forward speed, boost, wheels in contact, isOnGround, hasJumped/hasFlipped/airTimeSinceJump, supersonic, handbrake value, ball speed.

## 12. Audio (Web Audio, all synthesised)

Engine tone that rises with forward speed, boost roar, supersonic whoosh, jump/land thuds, ball hit volume scaled by impulse, ball bounce, wall scrape, boost pad pickup chime, demo boom, goal horn + crowd swell, ambient crowd bed, countdown beeps. Master / SFX / crowd volume sliders. Audio context starts on first click/keypress (browser autoplay rules).

## 13. Persistence

Settings, bindings, camera, chosen car, and lifetime stats saved in `localStorage` (wrap every read/write in try/catch; game must still run if storage is blocked).

---

## 14. Build phases & acceptance checks

1. **Sim core + arena SDF + ball.** Checks: ball dropped from z = 1000 bounces to roughly 0.36× the drop height on the first bounce (restitution 0.6 on velocity); ball never exceeds 6000 uu/s; ball rolls into a corner and up the curved ramp smoothly; ball can't leave the arena or tunnel through the goal frame at 6000 uu/s.
2. **Car ground driving.** Checks: throttle-only top speed settles at ~1410; boost reaches 2300 and caps; full tank lasts 3.0 s; supersonic flag at 2200; coasting decel ~525; braking ~3500; powerslide visibly slides; car drives up the curved wall, along the wall and onto the ceiling while holding throttle; car slides off a wall when throttle released.
3. **Jumps, dodges, air control.** Checks: dodge only available within 1.25 s after jump ends; driving off a ramp without jumping keeps the flip indefinitely; front flip at 1000 uu/s adds 500 uu/s forward; side flip at max speed adds ~950 uu/s sideways; backflip at speed scales up to 2.5×; flip-cancel produces a working half-flip; pitch is locked during flip; air roll rotates at the right rate and is capped at 5.5 rad/s.
4. **Contacts.** Checks: driving into a still ball at 1400 uu/s sends it at plausible RL speed (~2500–2800 [verify against a known clip]); dribbling on the roof is possible; landing all wheels on the ball resets the flip; supersonic front-bumper hit on an enemy demos them; non-supersonic hit bumps them per the curves; 0.25 s bump cooldown.
5. **Boost pads, kickoff, match flow, goals, replay, overtime, zero-second rule.**
6. **Camera + ball cam + keyboard/mouse and gamepad input.**
7. **Bots** at all three difficulties, 1v1 to 3v3.
8. **Visuals, audio, UI polish, quality presets, performance pass** (60+ fps at High on both target machines), each visual area signed off through the reference-image loop in section 16.

## 16. Reference images — use them throughout

Every visual decision should be made against real Rocket League reference images, not memory.

- At the start, each visual agent searches the web for reference images of its area and saves them to `refs/<area>/`. Also collect a few gameplay screenshots from the default chase camera to match framing, FOV and how big the car and ball sit on screen.
- **Look at them** (open the images) before building, and write a short notes file per area: proportions, colours (sample actual hex values), lighting, how effects move and fade, screen positions of HUD elements.
- **Visual QA loop:** run the build in a headless browser (Playwright/Puppeteer) and screenshot the same views as the references. Put screenshot and reference side by side, list the differences, fix, re-shoot. Keep going until the reviewer agent can't name a meaningful difference in layout, scale, lighting, or feel.
- References guide proportions, layout, scale, colour palette, lighting and motion. The finished models, textures, logos and effects must still be original — match the look and feel, don't trace or reproduce Psyonix's car bodies, decals, logos or arena art.
- Don't ship reference images in the final file.
