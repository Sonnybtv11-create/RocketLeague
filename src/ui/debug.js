// TURBO PITCH — debug overlay (F3) and FPS counter (UI agent).
import { h, setText, setClass } from './dom.js';

const FIELDS = [
  ['fps', 'FPS'], ['tick', 'Tick'], ['speed', 'Car speed (uu/s)'], ['fwd', 'Forward speed'], ['boost', 'Boost'],
  ['wheels', 'Wheels in contact'], ['ground', 'isOnGround'], ['jumped', 'hasJumped'], ['flipped', 'hasFlipped'],
  ['flipping', 'isFlipping'], ['air', 'airTimeSinceJump (s)'], ['ss', 'isSupersonic'], ['hb', 'handbrakeVal'],
  ['ctrl', 'Input T S P Y R'], ['ball', 'Ball speed (uu/s)'], ['ballz', 'Ball height (uu)'], ['state', 'Match state'],
];

function len(v) { return v ? Math.hypot(v.x, v.y, v.z) : 0; }
function yn(b) { return b ? 'yes' : 'no'; }

export function createDebug({ api }) {
  const vals = {};
  const kv = h('div.kv');
  for (const [k, label] of FIELDS) {
    const v = h('span', '—');
    vals[k] = v;
    kv.append(h('span', label), v);
  }
  const resBox = h('div.res');
  const runBtn = h('button', { type: 'button' }, 'RUN SELF-TESTS');
  const el = h('div.tp-debug.tp-hidden', h('div.hd', 'DEBUG · F3'), kv, runBtn, resBox);
  const fpsEl = h('div.tp-fps.tp-hidden', '— fps');
  let on = false, acc = 1, fpsAcc = 1;

  runBtn.addEventListener('click', async (e) => {
    e.preventDefault();
    if (runBtn.disabled) return;
    runBtn.disabled = true;
    runBtn.textContent = 'RUNNING…';
    resBox.innerHTML = '';
    const addLine = (line) => {
      const t = String(line);
      const cls = /^PASS/.test(t) ? 'p' : /^FAIL/.test(t) ? 'f' : 's';
      resBox.appendChild(h('div.' + cls, t));
      resBox.scrollTop = resBox.scrollHeight;
    };
    // let the "running" state paint before the (synchronous) tests block the main thread
    await new Promise((r) => requestAnimationFrame(() => setTimeout(r, 0)));
    try {
      const results = await api.runSelfTests(addLine);
      const lastTxt = resBox.lastChild ? resBox.lastChild.textContent : '';
      if (Array.isArray(results) && !/\d+\/\d+ passed/.test(lastTxt)) {
        const pass = results.filter((r) => r.pass).length;
        addLine(`SUMMARY: ${pass}/${results.length} passed${pass === results.length ? ' ✔' : ''}`);
      }
    } catch (err) {
      addLine(`FAIL  self-tests threw: ${err && err.message ? err.message : err}`);
    }
    runBtn.disabled = false;
    runBtn.textContent = 'RUN SELF-TESTS';
  });

  function setBool(k, b) {
    setText(vals[k], yn(b));
    setClass(vals[k], 'yes', !!b);
    setClass(vals[k], 'no', !b);
  }

  return {
    el, fpsEl,
    setOn(v) { on = !!v; setClass(el, 'tp-hidden', !on); acc = 1; },
    isOn() { return on; },
    update(view, dt, info, showFps) {
      // FPS counter (only when the debug panel, which shows FPS itself, is closed)
      const f = showFps && !on;
      setClass(fpsEl, 'tp-hidden', !f);
      if (f) { fpsAcc += dt; if (fpsAcc > 0.25) { fpsAcc = 0; setText(fpsEl, `${Math.round(info.fps || 0)} fps`); } }
      if (!on) return;
      acc += dt;
      if (acc < 0.1) return; // 10 Hz is plenty for reading numbers
      acc = 0;
      const c = info.playerCar;
      setText(vals.fps, (info.fps || 0).toFixed(0));
      setText(vals.tick, info.tick ?? view.tick ?? 0);
      if (c) {
        setText(vals.speed, len(c.vel).toFixed(0));
        setText(vals.fwd, (c.forwardSpeed || 0).toFixed(0));
        setText(vals.boost, (c.boost || 0).toFixed(1));
        setText(vals.wheels, `${c.numWheelsInContact ?? (c.wheels ? c.wheels.filter((w) => w.contact).length : 0)} / 4`);
        setBool('ground', c.isOnGround);
        setBool('jumped', c.hasJumped);
        setBool('flipped', c.hasFlipped);
        setBool('flipping', c.isFlipping);
        setText(vals.air, (c.airTimeSinceJump || 0).toFixed(2));
        setBool('ss', c.isSupersonic);
        setText(vals.hb, (c.handbrakeVal || 0).toFixed(2));
        const k = c.controls || {};
        const n = (x) => (x || 0).toFixed(2).replace(/^(-?)0\./, '$1.');
        setText(vals.ctrl, `${n(k.throttle)} ${n(k.steer)} ${n(k.pitch)} ${n(k.yaw)} ${n(k.roll)}${k.jump ? ' J' : ''}${k.boost ? ' B' : ''}${k.handbrake ? ' H' : ''}`);
      } else {
        for (const key of ['speed', 'fwd', 'boost', 'wheels', 'ground', 'jumped', 'flipped', 'flipping', 'air', 'ss', 'hb', 'ctrl']) setText(vals[key], '—');
      }
      setText(vals.ball, view.ball ? len(view.ball.vel).toFixed(0) : '—');
      setText(vals.ballz, view.ball ? view.ball.pos.z.toFixed(0) : '—');
      setText(vals.state, view.match ? `${view.match.state}${view.isReplay ? ' (replay)' : ''}` : info.mode);
    },
  };
}
