# Match rules: research notes and implementation

This file documents what `src/game/match.js`, `src/game/match/*.js` and `src/game/replay.js` do, and where each rule comes from.
Each item is marked **[sourced]** (a source states it), **[inferred]** (a source implies it) or **[assumption]** (no public source found, so a value was chosen that plays like the real game). Every tunable lives in `src/game/match/rules.js`.

## Sources
- S1: RL Fandom wiki, *Points*, current revision, read through the MediaWiki API: <https://rocketleague.fandom.com/api.php?action=parse&page=Points&prop=wikitext&format=json>
- S2: The same page's old revisions 16486 (2017-10), 26248 (2019-06) and 41097 (2020-04): `...&oldid=<rev>`
- S3: RL Fandom wiki, *Demolition*: <https://rocketleague.fandom.com/wiki/Demolition>
- S4: RLBot flatbuffers spec, the `GameInfo` table comments: <https://github.com/RLBot/RLBot/blob/master/src/main/flatbuffers/rlbot.fbs>
- S5: RL Fandom wiki, *Patch v1.17* (overtime timer counts up): <https://rocketleague.fandom.com/wiki/Patch_v1.17>
- S6: RL Fandom wiki, *Patch v2.45* (OT shown as "5:00 (+2:11)"): <https://rocketleague.fandom.com/wiki/Patch_v2.45>
- S7: Kotaku, *This is why you should never give up in Rocket League* (zero-second rule): <https://kotaku.com/this-is-why-you-should-never-give-up-in-rocket-league-1797799988>
- S8: Rocket League patch notes v1.95 (fix for 0.1 s being added when the ball hits the ground at 0:00): <https://www.rocketleague.com/news/patch-notes-v1-95>
- S9: RL Fandom wiki, *Mutator Settings* (match length is 5 minutes by default; "Disable Goal Reset" skips the goal highlight): <https://rocketleague.fandom.com/wiki/Mutator_Settings>
- S10: Steam discussion *How is it not an assist if...* (assists have a time limit): <https://steamcommunity.com/app/252950/discussions/0/1769259642882486689/>
- S11: Liquipedia glossary (assist = a teammate's touch before the goal): <https://liquipedia.net/rocketleague/Liquipedia:Glossary>

## Clock
- **5:00 by default** [sourced S9]. `durationSec` defaults to 300.
- **The clock does not run during a kickoff until the ball is first touched** [sourced S4]. RLBot's `isKickoffPause` is described as *"True when the clock is paused due to kickoff, but false during kickoff countdown… true while cars can move during kickoff. Note that if both players sit still, game clock start[s] and this will become false."* This applies after every kickoff, including overtime kickoffs. The clock also starts if nobody touches the ball for `KICKOFF_CLOCK_FALLBACK_SEC` = 5 s after GO. That timeout is [assumption]: S4 confirms a fallback exists but gives no duration. `MatchView.isKickoffPause` exposes this state.
- The clock runs only in state `playing`. It stops during the goal celebration, the replay and the countdown.

## Kickoff
- The countdown is 3-2-1-GO, one second per step, with cars frozen until GO [sourced, SPEC + S4 "false during kickoff countdown"]. `EV.kickoffCountdown {n:3}` fires on entering the countdown, `{n:2}` at 1 s and `{n:1}` at 2 s. `EV.kickoffGo` fires at 3 s.
- `world.resetKickoff()` sets random spawns, 33.33 boost, resets all pads and puts the ball at centre.
- `MatchView.countdown` is 3/2/1 during the countdown and 0 for 1 s after GO (the "GO!" overlay). It is −1 at all other times.

## Zero-second rule
- At 0:00 the match does not end while the ball is in the air. It ends the first time the ball touches the ground [sourced S7, S8]. The ball counts as on the ground when either:
  - an `EV.ballBounce` has `normal.z > 0.7`; or
  - the ball is rolling, meaning its centre is below z 100 and |vz| < 160. This covers soft contacts below the 150 uu/s threshold for bounce events.
- Wall and ceiling contacts do not end the match.
- `MatchView.waitingForBallToLand` is true while the match waits for this.
- A goal scored during this time counts [inferred S7, the whole point of the rule]. After its celebration and replay, the match ends if the scores now differ, otherwise it goes to overtime.
- If the scores are tied when the ball lands, the match goes to overtime.

## Overtime
- Unlimited sudden death and the first goal wins [sourced SPEC, S5].
- The clock counts up from +0:00 [sourced S5, S6]. `MatchView.overtimeSec` holds the value and the UI shows it as `+M:SS`. Like the regulation clock, it waits for the first touch after the OT kickoff.
- Overtime starts with `EV.overtime` followed by a normal kickoff countdown.

## Goal, explosion, celebration, replay
- A goal is scored when the whole ball is over the line, `|y| > 5124.25 + 91.25` (sim, from RocketSim).
- **Scorer**: the last player on the scoring team to touch the ball. If the defending team touched it last, it is an own goal. RL then credits the last attacker who touched the ball [inferred: RL's goal feed always names an attacking player]. `lastGoal.ownGoal` and `EV.goal.ownGoal` flag this case. If no attacker touched the ball, `scorerId` is −1.
- **Assist**: the most recent touch by a different teammate before the scorer's touch, no more than `ASSIST_WINDOW_SEC` = 5 s before the goal [sourced S11 for the definition; S10 confirms a time limit; the 5 s value is an assumption]. An own goal gets no assist.
- **Explosion**: the ball explodes in the scoring team's colour. In the sim it is moved, asleep, to just behind the back of the net it entered. A sleeping ball is never integrated, collided or ray-hit, so it cannot produce more goals, touches or events. `MatchView.ballHidden` is true for the rest of the celebration (and for the 2 s before a free-play respawn).
- **Blast**: cars within 1500 uu of the ball get a push away from it with some upward bias, falling off linearly from 2000 uu/s at the centre, plus a small random tumble. The sim then clamps car speed to 2300. [assumption] The real game pushes nearby cars, but Psyonix has not published the numbers and RocketSim does not model it. These values throw a car standing at the post into the air and barely nudge one at midfield, which matches gameplay footage.
- **Celebration**: 3 s in state `goal` [assumption, matches the game's pacing]. Cars keep driving and demos still count. The clock is stopped.
- **Replay**: the last 6 s before the goal plus 1.25 s after it, in real time [assumption: RL's goal replays run about 5–8 s]. It is skippable and shows a REPLAY banner. The replay is shown even for the match-winning goal, and the end screen comes afterwards. S4: `isMatchEnded` *"turns true after final replay, the moment the 'winner' screen appears"*. After the goal moment, the replay holds the ball frozen where it crossed the line, because live it has been moved out of play. During the replay `ballHidden` is false.
- **Replay cameras**: auto-cut hints per frame. `follow` stays on the scorer until 4.0 s before the goal, then `wide` until 2.6 s before, then `ball` until 0.7 s before, then `goal`.

## Points table (S1 = current game, S2 = history)
| Action | Points used | Notes |
|---|---|---|
| Goal | 100 | S1 |
| Assist | 50 | S1 |
| Save | 50 | S1 |
| Epic save | 75 | S1 ("on the verge of scoring"). Was 60 in 2017 |
| Shot on goal | 10 | S1. Was 30 in 2017 and 20 in 2019 |
| Centre ball | 10 | S1. Was 20 before 2020 |
| Clear ball | 20 | S1 |
| Demolition | 0 | S1, S3: no points. Was 10 in 2019 |
| First touch | 0 | S1. Was 10 before 2020 |
| Aerial hit | 0 | S1: removed (was 10, and 5 in 2016) |
| Ball touch | 2 | S1: "hitting the ball gives 2 points, unless the hit is a First Touch; multiple quick hits only give 2". Added to the score silently with no `EV.stat`. Cooldown is 1 s [assumption] |
| Aerial / backwards / long / turtle goal | +20 each | S1 bonuses on top of the goal |
| Overtime goal | +25 | S1 |
| Hat trick / Playmaker / Savior (3 goals / 3 assists / 3 saves) | +25 | S1 |
| Extermination (7 demos) | +20 | S1, S3 |
| MVP | 0 | S1: the highest score on the winning team. Ties go to the alphabetically first name. Win and MVP no longer give points |

Zero-point events are still emitted as `EV.stat` (with `points: 0`) because the scoreboard counts them (demos) and the UI may name them. Every `EV.stat` also carries a `label` such as `'EPIC SAVE'`, plus `team` and `name`. `POINTS_LEGACY` in `rules.js` keeps the classic values for a possible "classic scoring" option.

## Stat detection (our implementation of RL's undocumented internals)
Contacts in consecutive ticks less than 3 ticks apart count as one *touch*. When a touch ends, the ball trajectory is re-predicted with the sim's own ball step (`stepBallAlone`), up to 6 s or until the ball crosses a goal line. The prediction is cached until the next touch. It is also re-run if the live ball drifts more than 40 uu from the path, for example after scripted teleports or wheel pushes. The trajectory from before a touch is the cached one.

- **Shot on goal**: after the touch, the ball is predicted to enter the opponent goal within 5 s. One shot is credited per possession, and possession changes when a different player touches the ball. Every non-own goal is also a shot, credited at the goal if no shot was credited yet.
- **Save**: before the touch, the ball was predicted to enter the toucher's own goal within 4 s, the toucher was not the player who sent it there, and after the touch it no longer goes in.
- **Epic save**: a save where the goal was ≤ 0.35 s away, or the ball's centre was within 350 uu of the goal line ("on the verge of scoring", S1).
- **Clear**: a touch with the ball in the toucher's defensive third (|y| > 5120/3 on its own side) that sends it into the other half within 3 s without heading into the toucher's own goal. A touch that is a save is not also a clear. One clear per possession.
- **Centre**: a touch in the attacking third from wide (|x| > 1100) that sends the ball through the slot in front of the opponent goal (|x| < 900, more than 3100 deep, z < 900) within 2.5 s, and is not a shot. One centre per possession.
- **Aerial hit**: the car has no wheels on any surface and the ball is above goal height (642.775), per S1 "above goal height". This also qualifies the touch for the aerial-goal bonus.
- **First touch**: the first touch after each kickoff.
- **Backwards goal**: the scoring touch came from a grounded car with forward speed < −200. **Turtle goal**: the car's up vector had z < −0.5. **Long goal**: the touch was in the scorer's own half.
- **Demolition**: comes from `EV.demo` with a valid `attackerId` on the other team. Demos count during play and during the celebration.

## Free play
There is no clock and no countdown, and the state is always `playing`. A goal emits `EV.goal` (explosion VFX and audio) with no stats and no score. The ball is hidden for 2 s and then respawns at centre, dropped from z ≈ 393, without resetting the car. `match.resetBall()` respawns it immediately; main's reset-ball key calls it.
