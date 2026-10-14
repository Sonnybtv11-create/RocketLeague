// TURBO PITCH — in-match HUD (UI agent).
// Score bug, boost meter, event feed, points pop-ups, kickoff countdown, goal banner, replay overlay,
// ball-cam indicator, free-play hints, demolished notice and the Tab scoreboard.
// Per-frame work only touches the DOM when a displayed value changes.
import { EV } from '../contracts.js';
import { h, s, setText, setClass, setShown, esc, keyName, padName, fmtClock, fmtOvertime, TEAM_NAME } from './dom.js';
import { buildScoreboard, scoreboardKey } from './scoreboard.js';

const STAT_LABEL = {
  goal: 'GOAL', assist: 'ASSIST', save: 'SAVE', epicSave: 'EPIC SAVE', shot: 'SHOT ON GOAL', demo: 'DEMOLITION',
  clear: 'CLEAR', centre: 'CENTER BALL', center: 'CENTER BALL', aerialHit: 'AERIAL HIT', firstTouch: 'FIRST TOUCH',
  aerialGoal: 'AERIAL GOAL', backwardsGoal: 'BACKWARDS GOAL', longGoal: 'LONG GOAL', turtleGoal: 'TURTLE GOAL',
  overtimeGoal: 'OVERTIME GOAL', hatTrick: 'HAT TRICK', playmaker: 'PLAYMAKER', savior: 'SAVIOR', extermination: 'EXTERMINATION',
};
// Fallback only — the match module sends `points` (and `label`) with every EV.stat.
const STAT_POINTS = { goal: 100, assist: 50, save: 50, epicSave: 75, shot: 10, demo: 0, clear: 20, centre: 10, center: 10, aerialHit: 0, firstTouch: 0 };
const BIG_STATS = new Set(['goal', 'epicSave', 'save', 'demo', 'assist', 'aerialGoal', 'backwardsGoal', 'longGoal', 'turtleGoal', 'overtimeGoal', 'hatTrick', 'playmaker', 'savior', 'extermination']);

const ICONS = {
  goal: '<svg class="ico" viewBox="0 0 24 24"><circle cx="12" cy="12" r="9.5" fill="#fff"/><path d="M12 7.2l3.4 2.5-1.3 4h-4.2l-1.3-4z" fill="#1a2440"/><path d="M12 2.5v4.7M15.4 9.7l4.6-1.6M14.1 13.7l2.8 3.9M9.9 13.7l-2.8 3.9M8.6 9.7L4 8.1" stroke="#1a2440" stroke-width="1.3"/></svg>',
  save: '<svg class="ico" viewBox="0 0 24 24"><path d="M12 2l8 3v6.2c0 5-3.4 9-8 10.8C7.4 20.2 4 16.2 4 11.2V5z" fill="#e8eeff"/><path d="M8 11.5l3 3 5.5-6" stroke="#1a2440" stroke-width="2.2" fill="none"/></svg>',
  epicSave: '<svg class="ico" viewBox="0 0 24 24"><path d="M12 2l8 3v6.2c0 5-3.4 9-8 10.8C7.4 20.2 4 16.2 4 11.2V5z" fill="#ffc94a"/><path d="M12 6.5l1.6 3.4 3.7.4-2.8 2.5.8 3.7-3.3-1.9-3.3 1.9.8-3.7-2.8-2.5 3.7-.4z" fill="#3a2600"/></svg>',
  demo: '<svg class="ico" viewBox="0 0 24 24"><path d="M12 2.5c-4.7 0-8 3.2-8 7.6 0 2.6 1.2 4.4 3 5.5V19h2.2v-2h1.6v2h2.4v-2h1.6v2H17v-3.4c1.8-1.1 3-2.9 3-5.5 0-4.4-3.3-7.6-8-7.6z" fill="#fff"/><circle cx="8.8" cy="10.6" r="2.1" fill="#16101c"/><circle cx="15.2" cy="10.6" r="2.1" fill="#16101c"/><path d="M12 12.6l-1.2 2h2.4z" fill="#16101c"/></svg>',
  assist: '<svg class="ico" viewBox="0 0 24 24"><path d="M3 13l6-1 4-6 2 1-2.5 5H20v3h-8l-5 4-2-1 2.5-3H3z" fill="#cfe0ff"/></svg>',
  chat: '<svg class="ico" viewBox="0 0 24 24"><path d="M3 5h18v11H9l-5 4v-4H3z" fill="#cfe0ff"/></svg>',
};

function teamCls(t) { return t === 1 ? 't1' : 't0'; }

export function createHUD({ api, settings }) {
  const el = h('div.tp-layer.tp-hud');

  // ---------------------------------------------------------- score bug
  const bugBlue = h('div.tp-bug-team.b', '0');
  const bugOrange = h('div.tp-bug-team.o', '0');
  const bugClock = h('div.tp-bug-clock', '5:00');
  const bugTag = h('div.tp-bug-tag.tp-hidden', 'OVERTIME');
  const waitTag = h('div.tp-bug-tag.wait.tp-hidden', 'WAITING FOR THE BALL TO HIT THE GROUND');
  const bug = h('div.tp-bug', h('div.tp-bug-glow.b'), h('div.tp-bug-glow.o'), bugBlue, bugClock, bugOrange, bugTag, waitTag);
  const fpBug = h('div.tp-bug-fp.tp-hidden', 'FREE PLAY');

  // ---------------------------------------------------------- boost meter
  const N_TICKS = 34, START = 220, SWEEP = 260;
  const svg = s('svg', { viewBox: '-100 -100 200 200' });
  const defs = s('defs');
  const grad = s('linearGradient', { id: 'tpBoostGrad', x1: '0', y1: '1', x2: '0.3', y2: '0' });
  grad.appendChild(s('stop', { offset: '0', 'stop-color': '#ff7a10' }));
  grad.appendChild(s('stop', { offset: '1', 'stop-color': '#ffc040' }));
  defs.appendChild(grad);
  const disc = s('radialGradient', { id: 'tpBoostDisc', cx: '50%', cy: '40%', r: '60%' });
  disc.appendChild(s('stop', { offset: '0', 'stop-color': '#1d3fb8', 'stop-opacity': '0.95' }));
  disc.appendChild(s('stop', { offset: '0.75', 'stop-color': '#0b1a5a', 'stop-opacity': '0.92' }));
  disc.appendChild(s('stop', { offset: '1', 'stop-color': '#050a24', 'stop-opacity': '0.9' }));
  defs.appendChild(disc);
  svg.appendChild(defs);
  svg.appendChild(s('circle', { cx: 0, cy: 0, r: 70, fill: 'url(#tpBoostDisc)' }));
  svg.appendChild(s('circle', { cx: 0, cy: 0, r: 70, fill: 'none', stroke: 'rgba(120,170,255,0.45)', 'stroke-width': 1.5 }));
  // thin inner track arc
  const arcPath = (r, a0, a1) => {
    const p = (a) => [Math.sin(a * Math.PI / 180) * r, -Math.cos(a * Math.PI / 180) * r];
    const [x0, y0] = p(a0), [x1, y1] = p(a1);
    return `M ${x0.toFixed(2)} ${y0.toFixed(2)} A ${r} ${r} 0 ${a1 - a0 > 180 ? 1 : 0} 1 ${x1.toFixed(2)} ${y1.toFixed(2)}`;
  };
  svg.appendChild(s('path', { d: arcPath(75, START, START + SWEEP), fill: 'none', stroke: 'rgba(255,255,255,0.18)', 'stroke-width': 1.2 }));
  const ticks = [];
  for (let i = 0; i < N_TICKS; i++) {
    const a = (START + (SWEEP * (i + 0.5)) / N_TICKS) * Math.PI / 180;
    const big = i % 5 === 4;
    const r0 = 79, r1 = big ? 97 : 94;
    const ln = s('line', { class: 'tk', x1: (Math.sin(a) * r0).toFixed(2), y1: (-Math.cos(a) * r0).toFixed(2), x2: (Math.sin(a) * r1).toFixed(2), y2: (-Math.cos(a) * r1).toFixed(2) });
    ticks.push(ln); svg.appendChild(ln);
  }
  const boostNum = s('text', { class: 'num', x: 0, y: 14, 'text-anchor': 'middle' }, '33');
  const boostLbl = s('text', { class: 'lbl', x: 0, y: 40, 'text-anchor': 'middle' }, 'BOOST');
  svg.appendChild(boostNum); svg.appendChild(boostLbl);
  const boostEl = h('div.tp-boost', svg);
  let boostDisp = 33, boostShownInt = -1, boostTicksOn = -1;

  // ---------------------------------------------------------- feed / popups / overlays
  const feed = h('div.tp-feed');
  const feedItems = [];
  const pops = h('div.tp-pops');
  const popItems = [];
  const count = h('div.tp-count.tp-hidden');
  const goalEl = h('div.tp-goal.tp-hidden');
  const demoEl = h('div.tp-demoed.tp-hidden', h('div.t', 'DEMOLISHED'), h('div.s'));
  const ballCamLbl = h('span.lbl', 'BALL CAM');
  const ballCamEl = h('div.tp-ballcam.tp-hidden', h('div.t', h('span.dot'), ballCamLbl), h('div.s'));
  const fpHint = h('div.tp-fphint.tp-hidden');

  // replay overlay (clicking anywhere skips)
  const replayCard = h('div.tp-replay-card');
  const replaySkip = h('div.tp-replay-skip');
  const replayEl = h('div.tp-layer.tp-replay.tp-hidden', h('div.tp-replay-edge'), h('div.tp-replay-tag', h('span.dot'), 'REPLAY'), replayCard, replaySkip);
  replayEl.addEventListener('click', (e) => { e.preventDefault(); api.skipReplay && api.skipReplay(); });

  // scoreboard
  const sbLayer = h('div.tp-layer.tp-hidden', h('div.tp-sb-overlay'));
  let sbHolder = null, sbKey = '', sbOn = false;

  el.append(bug, fpBug, fpHint, feed, pops, count, goalEl, demoEl, ballCamEl, boostEl, replayEl, sbLayer);

  // ---------------------------------------------------------- state
  let lastCd = 0, lastCdView = -1, lastState = null, countT = 0, goalT = 0, lastPlayerId = -1, lastReplayKey = '', lastDemoFeed = { id: -2, t: -9 };
  let lastDemoBy = null;
  let bigHoldUntil = -1;
  let now = 0;
  let lastView = null;

  function carInfo(id, view) {
    const v = view || lastView;
    const c = v && v.cars ? v.cars.find((x) => x.id === id) : null;
    if (c) return { name: c.name, team: c.team };
    const mp = v && v.match && v.match.players ? v.match.players.find((p) => p.carId === id) : null;
    if (mp) return { name: mp.name, team: mp.team };
    return null;
  }
  function pill(info) { return info ? `<span class="pill ${teamCls(info.team)}">${esc(info.name)}</span>` : ''; }
  function nameSpan(info) { return info ? `<span class="nm ${teamCls(info.team)}">${esc(info.name)}</span>` : ''; }

  function addFeed(html, cls = '') {
    const it = h('div.tp-fi' + (cls ? '.' + cls : ''), { html });
    feed.appendChild(it);
    feedItems.push({ el: it, t: 0, life: cls === 'chat' ? 6 : 5.5 });
    while (feedItems.length > 6) { const o = feedItems.shift(); o.el.remove(); }
  }
  function addPop(kind, points, label0) {
    const pts = points ?? STAT_POINTS[kind] ?? 0;
    if (!pts) return; // zero-point stats (e.g. demos in the current points table) get no pop-up
    const label = String(label0 || STAT_LABEL[kind] || kind).toUpperCase();
    const it = h('div.tp-pop' + (BIG_STATS.has(kind) ? '.big' : ''), h('span.k', label), h('span.p', `+${pts}`));
    pops.appendChild(it);
    popItems.push({ el: it, t: 0 });
    while (popItems.length > 5) { const o = popItems.shift(); o.el.remove(); }
  }
  function restartAnim(node) { node.classList.remove('anim'); void node.offsetWidth; node.classList.add('anim'); }
  function showCount(n) {
    if (now < bigHoldUntil) return; // e.g. OVERTIME is showing; the countdown follows it
    if (n === lastCd && countT > 0) return;
    lastCd = n;
    count.classList.remove('go');
    count.textContent = String(n);
    setShown(count, true);
    restartAnim(count);
    countT = 1.05;
  }
  function showBig(text, hold = 0) {
    bigHoldUntil = hold > 0 ? now + hold : bigHoldUntil;
    count.classList.add('go');
    count.textContent = text;
    setShown(count, true);
    restartAnim(count);
    countT = Math.max(1.15, hold);
  }
  let goShownAt = -9;
  function showGo() {
    if (now - goShownAt < 1) return;
    goShownAt = now; lastCd = 0;
    showBig('GO!');
  }
  function showGoal(e, view) {
    const scorer = carInfo(e.scorerId, view);
    const assist = e.assistId !== undefined && e.assistId !== null && e.assistId >= 0 ? carInfo(e.assistId, view) : null;
    const team = e.team === 1 ? 1 : 0;
    const kmh = Math.round((e.ballSpeed || 0) * 0.036);
    goalEl.innerHTML = '';
    goalEl.append(
      h('div.tp-goal-band.' + teamCls(team), h('div.tp-goal-title', `${TEAM_NAME[team]} SCORES!`)),
      h('div.tp-goal-sub',
        scorer ? h('span', h('span.lbl', 'GOAL'), h('span.v.' + teamCls(scorer.team), scorer.name)) : h('span', h('span.v', 'TEAM GOAL')),
        e.ownGoal ? h('span', h('span.v', { style: { color: 'var(--gold-l)' } }, 'OWN GOAL')) : null,
        assist ? h('span', h('span.lbl', 'ASSIST'), h('span.v.' + teamCls(assist.team), assist.name)) : null,
        h('span', h('span.lbl', 'SPEED'), h('span.v', `${kmh} KM/H`))));
    setShown(goalEl, true);
    // re-trigger entrance animation
    goalEl.style.animation = 'none'; void goalEl.offsetWidth; goalEl.style.animation = '';
    goalT = 3.2;
  }

  function clearTransient() {
    for (const f of feedItems) f.el.remove();
    feedItems.length = 0;
    for (const p of popItems) p.el.remove();
    popItems.length = 0;
    setShown(count, false); countT = 0; lastCd = 0;
    setShown(goalEl, false); goalT = 0;
    lastState = null; lastReplayKey = '';
  }

  // ---------------------------------------------------------- events
  function onEvents(events, view) {
    if (!events || !events.length) return;
    lastView = view || lastView;
    const game = api.getGame ? api.getGame() : null;
    const pid = game ? game.playerCarId : lastPlayerId;
    for (const e of events) {
      switch (e.type) {
        case EV.GOAL: {
          const sc = carInfo(e.scorerId, view);
          const as = e.assistId !== undefined && e.assistId !== null && e.assistId >= 0 ? carInfo(e.assistId, view) : null;
          const teamName = TEAM_NAME[e.team === 1 ? 1 : 0];
          const gl = e.ownGoal ? 'GOAL · OWN GOAL' : 'GOAL';
          let html = sc ? `${pill(sc)}${ICONS.goal}<span class="ev">${gl}</span>` : `<span class="nm ${teamCls(e.team)}">${teamName}</span>${ICONS.goal}<span class="ev">${gl}</span>`;
          if (as) html += `<span class="ev">ASSIST</span>${nameSpan(as)}`;
          addFeed(html);
          showGoal(e, view);
          break;
        }
        case EV.DEMO: {
          const a = carInfo(e.attackerId, view), v = carInfo(e.victimId, view);
          addFeed(`${a ? pill(a) : ''}${ICONS.demo}${v ? pill(v) : ''}`);
          lastDemoFeed = { id: e.attackerId, t: now };
          if (e.victimId === pid) lastDemoBy = a;
          break;
        }
        case EV.STAT: {
          if (e.carId === pid && pid >= 0) addPop(e.kind, e.points, e.label);
          const sc = carInfo(e.carId, view) || (e.name ? { name: e.name, team: e.team } : null);
          if (e.kind === 'save' || e.kind === 'epicSave') {
            const c = sc;
            if (c) addFeed(`${pill(c)}${ICONS[e.kind]}<span class="ev">${e.kind === 'epicSave' ? 'EPIC SAVE' : 'SAVE'}</span>`);
          } else if (e.kind === 'demo') {
            if (!(lastDemoFeed.id === e.carId && now - lastDemoFeed.t < 0.6)) {
              const c = sc;
              if (c) addFeed(`${pill(c)}${ICONS.demo}<span class="ev">DEMOLITION</span>`);
              lastDemoFeed = { id: e.carId, t: now };
            }
          }
          break;
        }
        case EV.QUICK_CHAT: {
          const c = carInfo(e.carId, view);
          addFeed(`${ICONS.chat}${nameSpan(c || { name: 'Player', team: 0 })}<span class="msg">${esc(e.text || '')}</span>`, 'chat');
          break;
        }
        case EV.KICKOFF_COUNTDOWN: if (e.n > 0) showCount(e.n); break;
        case EV.KICKOFF_GO: showGo(); break;
        case EV.OVERTIME: showBig('OVERTIME', 1.6); addFeed('<span class="msg">OVERTIME — NEXT GOAL WINS</span>', 'sys'); break;
        case EV.REPLAY_START: setShown(goalEl, false); goalT = 0; break;
        default: break;
      }
    }
  }

  // ---------------------------------------------------------- per-frame
  const bugTagState = { ot: null };
  function update(view, dt, info) {
    now += dt;
    lastView = view;
    lastPlayerId = info.playerCarId;
    const m = view.match;
    const replay = !!view.isReplay || !!(m && m.replayActive && m.state === 'replay');
    const freeplay = info.mode === 'freeplay' || (m && m.mode === 'freeplay');

    // score bug
    setShown(bug, !!m && !freeplay);
    setShown(fpBug, freeplay);
    if (m && !freeplay) {
      setText(bugBlue, m.scores ? m.scores[0] : 0);
      setText(bugOrange, m.scores ? m.scores[1] : 0);
      const ot = !!m.isOvertime;
      setText(bugClock, ot ? fmtOvertime(m.overtimeSec || 0) : fmtClock(m.clockSec || 0));
      setClass(bugClock, 'ot', ot);
      if (bugTagState.ot !== ot) { bugTagState.ot = ot; setShown(bugTag, ot); }
      setShown(waitTag, !!m.waitingForBallToLand && !replay);
    }

    // countdown / GO
    const state = m ? m.state : null;
    // matchView.countdown: 3/2/1 while counting, 0 while GO is shown, -1 otherwise
    const cdv = m ? m.countdown : -1;
    const counting = !!m && cdv > 0 && state !== 'replay' && state !== 'goal';
    if (counting) showCount(cdv);
    if (m && cdv === 0 && lastCdView > 0) showGo();
    if (lastState === 'countdown' && state === 'playing' && lastCdView !== 0) showGo();
    lastState = state;
    lastCdView = cdv;
    if (countT > 0) { countT -= dt; if (countT <= 0 && !counting) setShown(count, false); }
    if (!counting && countT <= 0) { setShown(count, false); lastCd = 0; }
    if (counting && countT <= 0 && now >= bigHoldUntil && lastCd !== cdv) showCount(cdv);

    // goal banner
    if (goalT > 0) { goalT -= dt; if (goalT <= 0 || replay) { goalT = 0; setShown(goalEl, false); } }

    // replay overlay
    setShown(replayEl, replay);
    if (replay) {
      const lg = m && m.lastGoal;
      const pad = info.inputDevice === 'pad' || info.inputDevice === 'gamepad';
      const jumpKb = settings.bindings && settings.bindings.kb && settings.bindings.kb.jump;
      const jumpPad = settings.bindings && settings.bindings.pad && settings.bindings.pad.jump;
      const keyTxt = pad ? padName(jumpPad) : keyName(Array.isArray(jumpKb) ? jumpKb[0] : jumpKb);
      const key = JSON.stringify([lg, keyTxt, pad]);
      if (key !== lastReplayKey) {
        lastReplayKey = key;
        replayCard.innerHTML = '';
        if (lg) {
          const team = lg.team === 1 ? 1 : 0;
          const kmh = Math.round((lg.ballSpeed || 0) * 0.036);
          const hasScorer = lg.scorerId !== undefined && lg.scorerId !== null && lg.scorerId >= 0 && !!lg.scorerName;
          replayCard.append(
            h('div.hd', hasScorer ? 'GOAL BY' : 'TEAM GOAL'),
            hasScorer ? h('div.bar.' + teamCls(team), h('div.who', lg.scorerName),
              lg.assistName ? h('div.ast', `Assist: ${lg.assistName}`) : null) : null,
            h('div.meta', h('span', `${kmh}`, h('small', 'KM/H')), h('span', TEAM_NAME[team], h('small', 'SCORES')),
              lg.ownGoal ? h('span', { style: { color: 'var(--gold-l)' } }, 'OWN GOAL') : null));
        }
        replaySkip.innerHTML = '';
        replaySkip.append('Press ', h('span.tp-key' + (pad ? '.pad' : ''), keyTxt), ' / click to skip');
      }
    }

    // boost meter
    const pc = info.playerCar;
    const showBoost = !!pc && !replay && info.mode !== 'menu';
    setShown(boostEl, showBoost);
    if (showBoost) {
      const target = Math.max(0, Math.min(100, pc.boost || 0));
      boostDisp += (target - boostDisp) * Math.min(1, dt * 14);
      if (Math.abs(target - boostDisp) < 0.05) boostDisp = target;
      const iv = Math.round(boostDisp);
      if (iv !== boostShownInt) { boostShownInt = iv; boostNum.textContent = String(iv); }
      const on = Math.round((boostDisp / 100) * N_TICKS);
      if (on !== boostTicksOn) {
        for (let i = 0; i < N_TICKS; i++) setClass(ticks[i], 'on', i < on);
        boostTicksOn = on;
      }
      setClass(boostEl, 'full', iv >= 100);
      setClass(boostEl, 'low', iv < 1);
      setClass(boostEl, 'active', !!pc.isBoosting && target > 0);
    }

    // ball cam indicator
    const showCam = !!pc && !replay && !pc.isDemoed;
    setShown(ballCamEl, showCam);
    if (showCam) {
      setClass(ballCamEl, 'off', !info.ballCam);
      setText(ballCamLbl, info.ballCam ? 'BALL CAM' : 'CAR CAM');
      const pad = info.inputDevice === 'pad' || info.inputDevice === 'gamepad';
      const kb = settings.bindings && settings.bindings.kb && settings.bindings.kb.ballCam;
      const pb = settings.bindings && settings.bindings.pad && settings.bindings.pad.ballCam;
      const keyTxt = pad ? padName(pb) : keyName(Array.isArray(kb) ? kb[0] : kb);
      const mode = settings.camera && settings.camera.ballCamMode === 'hold' ? 'HOLD' : 'TOGGLE';
      const k = `${keyTxt}|${pad}|${mode}`;
      const sEl = ballCamEl.lastChild;
      if (sEl._k !== k) {
        sEl._k = k; sEl.innerHTML = '';
        sEl.append('Press', h('span.tp-key' + (pad ? '.pad' : ''), keyTxt), `to ${mode.toLowerCase()}`);
      }
    }

    // demolished notice
    const demoed = !!pc && !!pc.isDemoed && !replay;
    setShown(demoEl, demoed);
    if (demoed) {
      const t = Math.max(0, pc.demoRespawnTimer || 0);
      setText(demoEl.lastChild, (lastDemoBy ? `By ${lastDemoBy.name} · ` : '') + `Respawn in ${t.toFixed(1)}`);
    } else lastDemoBy = null;

    // free play hint
    setShown(fpHint, freeplay && !replay);
    if (freeplay) {
      const fp = settings.game.freeplay;
      const pad = info.inputDevice === 'pad' || info.inputDevice === 'gamepad';
      const rk = pad ? padName(settings.bindings.pad.resetBall) : keyList1(settings.bindings.kb.resetBall);
      const pk = pad ? padName(settings.bindings.pad.pause) : keyList1(settings.bindings.kb.pause);
      const k = `${rk}|${pk}|${fp.predictionLine}|${fp.unlimitedBoost}`;
      if (fpHint._k !== k) {
        fpHint._k = k;
        fpHint.innerHTML = `<div class="hd">Free Play</div>`
          + `<div><span class="tp-key">${esc(rk)}</span> Reset ball</div>`
          + `<div>Ball prediction: <span class="${fp.predictionLine ? 'on' : 'offv'}">${fp.predictionLine ? 'ON' : 'OFF'}</span></div>`
          + `<div>Unlimited boost: <span class="${fp.unlimitedBoost ? 'on' : 'offv'}">${fp.unlimitedBoost ? 'ON' : 'OFF'}</span></div>`
          + `<div><span class="tp-key">${esc(pk)}</span> Toggles &amp; menu</div>`;
      }
    }

    // feed aging
    for (let i = feedItems.length - 1; i >= 0; i--) {
      const f = feedItems[i];
      f.t += dt;
      if (f.t > f.life && !f.out) { f.out = true; f.el.classList.add('out'); }
      if (f.t > f.life + 0.7) { f.el.remove(); feedItems.splice(i, 1); }
    }
    for (let i = popItems.length - 1; i >= 0; i--) {
      const p = popItems[i];
      p.t += dt;
      if (p.t > 2.7) { p.el.remove(); popItems.splice(i, 1); }
    }

    // scoreboard overlay
    const sbVisible = sbOn && !!m;
    setShown(sbLayer, sbVisible);
    setClass(el, 'sb-open', sbVisible);
    if (sbVisible) {
      const key = scoreboardKey(m, info.playerCarId) + (m.players && m.players.length ? '' : view.cars.map((c) => c.id).join(','));
      if (key !== sbKey) {
        sbKey = key;
        if (sbHolder) sbHolder.remove();
        sbHolder = buildScoreboard(m, { playerCarId: info.playerCarId, showMvp: false, carsFallback: view.cars });
        sbLayer.appendChild(sbHolder);
      }
    }
  }

  function keyList1(arr) { return keyName(Array.isArray(arr) ? arr[0] : arr); }

  return {
    el,
    update,
    onEvents,
    clearTransient,
    setScoreboard(on) { sbOn = !!on; if (!on) sbKey = ''; },
    setVisible(on) { setShown(el, on); },
  };
}
