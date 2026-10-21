// TURBO PITCH — menus (UI agent): main menu, play setup, free play, garage, settings (tabs + bindings),
// controls help, lifetime stats, pause menu and end-of-match screen. Mouse-first, with keyboard
// arrows / gamepad spatial navigation (see nav.js).
import { CAR_BODIES, GAME_TITLE, TEAM_COLORS } from '../contracts.js';
import { DEFAULT_SETTINGS, DEFAULT_BINDINGS, CONTROL_PRESETS, applyControlPreset, currentControlPreset } from '../game/settings.js';
import { CAR_CONFIGS } from '../sim/carconfig.js';
import { h, esc, keyName, keyList, padName, TEAM_NAME } from './dom.js';
import { buildScoreboard, mvpPlayer } from './scoreboard.js';
import { createNav } from './nav.js';
import { formatCode, checkCode, lookupCode, validCodes, CODE_EXAMPLE } from '../game/modifiers.js';
import { cleanName, NAME_MAX, formatRewardCode, redeemCode, REWARD_CODE_EXAMPLE, levelInfo } from '../game/profile.js';

const clone = (o) => JSON.parse(JSON.stringify(o));
const cap = (str) => String(str).charAt(0).toUpperCase() + String(str).slice(1).toLowerCase();
export const hitboxLabel = (hb) => `${cap(hb || 'OCTANE')}-class`;

const DIFFS = [['rookie', 'Rookie'], ['pro', 'Pro'], ['allstar', 'All-Star']];
const ACCENTS = ['#e8e8e8', '#1c1c1c', '#ff3b3b', '#ff8a1f', '#ffd23f', '#9cff3b', '#2ee6a8', '#2fd3ff',
  '#2f7bff', '#7a5cff', '#d14cff', '#ff4fa3', '#8b5a2b', '#6f7d8c', '#b8ff00', '#00b3a1'];

const ACTION_LABELS = {
  throttle: 'Throttle', reverse: 'Reverse / brake', steerLeft: 'Steer left', steerRight: 'Steer right',
  pitchUp: 'Air pitch up (nose up)', pitchDown: 'Air pitch down', yawLeft: 'Air yaw left', yawRight: 'Air yaw right',
  jump: 'Jump', boost: 'Boost', powerslide: 'Powerslide / free air roll', airRollLeft: 'Air roll left', airRollRight: 'Air roll right',
  freeLook: 'Free look (hold)', ballCam: 'Ball cam', resetBall: 'Reset ball (free play)', scoreboard: 'Scoreboard', pause: 'Pause',
  steerAxis: 'Steer / yaw (stick axis)', pitchAxis: 'Pitch (stick axis)', lookX: 'Free look X (axis)', lookY: 'Free look Y (axis)',
};

const TIPS = [
  ['Half-flip', 'Backflip, cancel it by pushing the stick forward half way up, then air roll to land facing the other way. The fastest 180° turn in the game.'],
  ['Wavedash', 'Jump slightly, tilt the nose up and dodge just as the back wheels touch the floor. You keep your speed and gain a free burst.'],
  ['Speed-flip', 'Boost, then dodge diagonally forward and immediately pull the stick back while air-rolling the opposite way. Wins kickoffs.'],
  ['Flip reset', 'Touch all four wheels to the ball in the air to regain your dodge — then use it for a powerful second touch.'],
  ['Supersonic', 'Reach 2200 uu/s to go supersonic: hitting an opponent with your front bumper at that speed demolishes them.'],
  ['Zero-second rule', 'When the clock hits 0:00 the match is not over until the ball touches the ground. Keep pushing!'],
];

export function createMenus({ api, settings, stats, onOpenChange }) {
  const el = h('div.tp-layer.tp-menus');
  const nav = createNav({ getScope: () => modal || pageEl, onBack: () => back(true) });
  let ctx = null;          // 'main' | 'pause' | 'end' | null
  let stack = [];          // page names
  let pageEl = null;
  let modal = null;        // rebind modal element
  let rebinding = null;    // {action, device}
  let endView = null;
  let tipIdx = 0, tipT = 0, tipEl = null;
  let settingsTab = 'camera';
  let rebindEndT = -1e9;
  let backHandledAt = -1e9;
  let modalKind = null;      // 'rebind' | 'conflict'

  const input = () => (api.getInput ? api.getInput() : null);
  const changed = () => { api.settingsChanged && api.settingsChanged(); };

  // ------------------------------------------------------------------ page plumbing
  function open(context, page) {
    const wasOpen = ctx !== null;
    ctx = context; stack = [page];
    render(true);
    if (!wasOpen) onOpenChange && onOpenChange(true);
  }
  function push(page) {
    if (page === 'profile') profState = { draft: '', error: '', ok: '', nameMsg: '' };
    stack.push(page); render(true);
  }
  function back(fromNav) {
    if (modal) { cancelRebind(); return; }
    if (stack.length > 1) { stack.pop(); render(true); return; }
    if (fromNav && ctx === 'pause') api.resumeGame();
  }
  function hide() {
    if (modal) cancelRebind();
    const wasOpen = ctx !== null;
    ctx = null; stack = []; endView = null;
    el.innerHTML = ''; pageEl = null; tipEl = null;
    nav.reset();
    if (wasOpen) onOpenChange && onOpenChange(false);
  }
  function render(anim) {
    el.innerHTML = '';
    tipEl = null;
    const name = stack[stack.length - 1];
    const builder = PAGES[name];
    pageEl = h('div.tp-page' + (anim ? '.anim' : ''));
    builder(pageEl);
    el.appendChild(pageEl);
    nav.pageChanged();
  }
  // Re-render the current page in place without the entrance animation (after a value change)
  function refresh() {
    const keepScroll = pageEl && pageEl.querySelector('.tp-scroll');
    const st = keepScroll ? keepScroll.scrollTop : 0;
    const focusKey = nav.focusKey();
    render(false);
    const sc = pageEl.querySelector('.tp-scroll');
    if (sc) sc.scrollTop = st;
    nav.restoreFocus(focusKey);
  }

  // ------------------------------------------------------------------ widgets
  const btn = (label, onClick, opts = {}) => h('button.tp-btn' + (opts.cls ? '.' + opts.cls : ''), {
    type: 'button', 'data-nav': '', 'data-key': opts.key || label, onclick: (e) => { e.preventDefault(); onClick(); },
  }, h('span', label), opts.sub ? h('span.sub', opts.sub) : null);

  function seg(options, value, onPick, opts = {}) {
    const wrap = h('div.tp-seg');
    for (const [v, label, small] of options) {
      const sel = v === value;
      const b = h('button.tp-opt' + (sel ? '.sel' : '') + (sel && opts.orangeFor === v ? '.or' : ''), {
        type: 'button', 'data-nav': '', 'data-key': `${opts.key || ''}:${v}`,
        onclick: (e) => { e.preventDefault(); onPick(v); },
      }, h(opts.swatch ? 'span.sw-wrap' : 'span', opts.swatch ? h('i.sw', { style: { background: opts.swatch[v] } }) : null, h('span', label), small ? h('small', small) : null));
      wrap.appendChild(b);
    }
    return wrap;
  }
  function group(label, ...children) { return h('div.tp-group', h('div.lbl', label), ...children); }

  function sliderRow(label, obj, key, min, max, step, fmt, hint) {
    const val = h('div.val', fmt(obj[key]));
    const r = h('input.tp-range', { type: 'range', min, max, step, value: String(obj[key]), 'data-nav': '', 'data-key': 'r:' + label });
    const paint = () => r.style.setProperty('--p', `${((Number(r.value) - min) / (max - min)) * 100}%`);
    paint();
    r.addEventListener('input', () => { obj[key] = Number(r.value); val.textContent = fmt(obj[key]); paint(); });
    r.addEventListener('change', () => { obj[key] = Number(r.value); changed(); });
    return h('div.tp-row', h('div.nm', label, hint ? h('small', hint) : null), r, val);
  }
  function toggleRow(label, obj, key, hint, after) {
    if (obj[key] === undefined) obj[key] = key === 'kbThrottlePitch'; // settings added after older saves: RL default is on
    const t = h('button.tp-toggle' + (obj[key] ? '.on' : ''), { type: 'button', 'data-nav': '', 'data-key': 't:' + label, 'aria-pressed': String(!!obj[key]) });
    const val = h('div.val', obj[key] ? 'ON' : 'OFF');
    t.addEventListener('click', (e) => {
      e.preventDefault();
      obj[key] = !obj[key];
      t.classList.toggle('on', obj[key]); t.setAttribute('aria-pressed', String(!!obj[key]));
      val.textContent = obj[key] ? 'ON' : 'OFF';
      changed();
      after && after();
    });
    return h('div.tp-row', h('div.nm', label, hint ? h('small', hint) : null), t, val);
  }
  // Control layout picker: Keyboard & mouse / MacBook (keyboard only)
  function presetRow() {
    const cur = currentControlPreset(settings);
    const opts = Object.entries(CONTROL_PRESETS).map(([id, p]) => [id, p.name]);
    const hint = cur === 'custom' ? 'Custom bindings — pick a layout to reset the keyboard' : CONTROL_PRESETS[cur].hint;
    return h('div.tp-row', h('div.nm', 'Control layout', h('small', hint)),
      seg(opts, cur, (v) => { applyControlPreset(settings, v); changed(); refresh(); }, { key: 's:control-layout' }), h('div.val'));
  }
  function segRow(label, obj, key, options, hint) {
    return h('div.tp-row', h('div.nm', label, hint ? h('small', hint) : null),
      seg(options, obj[key], (v) => { obj[key] = v; changed(); refresh(); }, { key: 's:' + label }), h('div.val'));
  }
  // page header: dark band across the top so titles never sit on busy stadium boards
  // Modifier codes box (Play and LAN host lobbies): type a code in Rocket League's training-pack style
  // (XXXX-XXXX-XXXX-XXXX), Add / Enter checks it; accepted codes are listed and go into the match config.
  function modifierBox(st, key) {
    const inp = h('input.tp-input.tp-modin', { type: 'text', autocomplete: 'off', spellcheck: 'false', maxlength: '19', placeholder: CODE_EXAMPLE, 'data-nav': '', 'data-key': key + '-in' });
    inp.value = st.draft || '';
    const add = () => {
      const r = checkCode(inp.value, st.codes);
      if (r.ok) { st.codes.push(r.code); st.draft = ''; st.error = ''; }
      else { st.draft = r.code; st.error = r.error; }
      refresh();
    };
    inp.addEventListener('input', () => {
      const f = formatCode(inp.value);
      if (f !== inp.value) inp.value = f;
      st.draft = f;
      if (st.error) { st.error = ''; err.textContent = ''; err.style.display = 'none'; }
    });
    inp.addEventListener('keydown', (e) => { e.stopPropagation(); if (e.key === 'Enter') add(); else if (e.key === 'Escape') inp.blur(); });
    const err = h('div.tp-note.err.tp-moderr', st.error || '');
    if (!st.error) err.style.display = 'none';
    const list = h('div.tp-modlist');
    for (const code of st.codes) {
      const m = lookupCode(code);
      list.appendChild(h('div.tp-modchip',
        h('span.cd', code), h('span.nm', m ? m.name : ''),
        h('button.x', { type: 'button', 'data-nav': '', 'data-key': key + '-rm-' + code, title: 'Remove', onclick: (e) => { e.preventDefault(); st.codes = st.codes.filter((c) => c !== code); refresh(); } }, '×')));
    }
    return group('Modifier codes', h('div.tp-modrow', inp, btn('Add', add, { key: key + '-add', cls: 'tp-modadd' })), err,
      st.codes.length ? list : h('div.tp-note.tp-modhint', 'Optional. Codes change how the match plays.'));
  }

  function title(main, crumb) { return h('div.tp-head', h('div.tp-title', h('span.main', main), crumb ? h('span.crumb', crumb) : null)); }
  function footer(...extra) {
    const f = h('div.tp-footer');
    if (stack.length > 1) f.appendChild(btn('Back', () => back(true), { key: 'footer-back' }));
    for (const x of extra) if (x) f.appendChild(x);
    f.appendChild(h('div.hint', ctx === 'end' ? null : h('span', 'Esc / ', h('span.tp-key.pad', 'B'), ' back'), h('span', h('span.tp-key.pad', 'A'), ' select')));
    return f;
  }
  function playerCard() {
    const body = CAR_BODIES.find((b) => b.id === settings.game.carBody) || CAR_BODIES[0];
    const team = settings.game.team === 1 ? 1 : 0;
    return h('div.tp-card',
      h('div.av', { style: { background: TEAM_COLORS[team].css } }, String(settings.game.playerName || 'P').slice(0, 1).toUpperCase()),
      h('div', h('div.nm', settings.game.playerName || 'Player'), h('div.sub', `${body.name} · ${hitboxLabel(body.hitbox)}`)));
  }

  // ------------------------------------------------------------------ logo
  function logo() {
    const svg = `<svg viewBox="0 0 460 160" style="font-family:var(--f)">
<defs>
 <linearGradient id="tpLgW" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#ffffff"/><stop offset="1" stop-color="#bcd2ff"/></linearGradient>
 <linearGradient id="tpLgO" x1="0" y1="0" x2="1" y2="0"><stop offset="0" stop-color="#ffb347"/><stop offset="1" stop-color="#ff6a00"/></linearGradient>
 <linearGradient id="tpLgS" x1="0" y1="0" x2="1" y2="0"><stop offset="0" stop-color="#2f7bff" stop-opacity="0"/><stop offset="1" stop-color="#6fa8ff"/></linearGradient>
 <radialGradient id="tpLgB" cx="38%" cy="32%" r="70%"><stop offset="0" stop-color="#ffffff"/><stop offset=".6" stop-color="#c9d6ee"/><stop offset="1" stop-color="#6b7a99"/></radialGradient>
</defs>
<g transform="skewX(-12)">
 <rect x="18" y="20" width="96" height="9" fill="url(#tpLgS)"/>
 <rect x="0" y="44" width="104" height="9" fill="url(#tpLgS)"/>
 <rect x="26" y="68" width="82" height="9" fill="url(#tpLgS)"/>
 <path d="M150 128 L452 128 L444 146 L142 146 Z" fill="#2f7bff"/>
 <path d="M300 128 L452 128 L444 146 L292 146 Z" fill="url(#tpLgO)"/>
</g>
<circle cx="132" cy="50" r="38" fill="url(#tpLgB)" stroke="#0a1430" stroke-width="3"/>
<path d="M132 34 l14 10 -5.5 16.5 h-17 l-5.5 -16.5 z" fill="#1a2440"/>
<path d="M132 12 v22 M146 44 l21 -7 M140.5 60.5 l12 17 M123.5 60.5 l-12 17 M118 44 l-21 -7" stroke="#1a2440" stroke-width="3"/>
<text x="178" y="80" font-size="76" font-weight="900" font-style="italic" fill="url(#tpLgW)" stroke="#0a1430" stroke-width="2" paint-order="stroke" textLength="268" lengthAdjust="spacingAndGlyphs">TURBO</text>
<text x="176" y="123" font-size="46" font-weight="900" font-style="italic" fill="url(#tpLgO)" stroke="#2a1000" stroke-width="1.5" paint-order="stroke" textLength="266" lengthAdjust="spacingAndGlyphs" letter-spacing="6">PITCH</text>
</svg>`;
    return h('div.tp-logo', { html: svg, 'aria-label': GAME_TITLE });
  }
  function logoSvg() { return logo().innerHTML; }

  // ------------------------------------------------------------------ pages
  const PAGES = {
    main(p) {
      // Classic stadium main menu: slanted list bottom-left with a submenu opening to the right,
      // a description line, a news panel on the right and the player band along the bottom.
      const lanHost = () => { api.lanHost(); push('lanhost'); };
      const ITEMS = [
        { key: 'lan', label: 'Play LAN', desc: 'Play with friends on the same network.',
          sub: [['Host game', lanHost], ['Join game', () => push('lanjoin')], ['How it works', () => push('lan')]] },
        { key: 'exh', label: 'Exhibition', desc: 'Play an offline match against bots.', go: () => push('play') },
        { key: 'train', label: 'Training', desc: 'Practice on your own with the ball prediction line and unlimited boost.',
          sub: [['Free play', () => api.startFreePlay({ bodyId: settings.game.carBody, accent: settings.game.accent, playerTeam: settings.game.team })],
            ['Free play options', () => push('freeplay')]] },
        { key: 'garage', label: 'Garage', desc: 'Change your car body and paint.', go: () => push('garage') },
        { key: 'profile', label: 'Profile', desc: 'Your name, your stats on this device and reward codes.', go: () => push('profile') },
        { key: 'extras', label: 'Extras', desc: 'The full controls guide.',
          sub: [['Controls guide', () => push('controls')]] },
        { key: 'opt', label: 'Options', desc: 'Camera, controls, video and audio settings.', go: () => push('settings') },
      ];
      p.append(h('div.tp-mm-shade'));
      const list = h('div.tp-mm-list');
      const subWrap = h('div.tp-mm-sub');
      const desc = h('div.tp-mm-desc');
      const rows = [];
      const setActive = (it, row) => {
        if (mmActive === it.key && subWrap.dataset.key === it.key) return;
        mmActive = it.key;
        for (const r of rows) r.classList.toggle('active', r === row);
        desc.textContent = it.desc;
        subWrap.dataset.key = it.key;
        subWrap.innerHTML = '';
        if (it.sub) {
          subWrap.style.top = `${row.offsetTop}px`;
          it.sub.forEach(([label, fn], k) => subWrap.appendChild(h('button.tp-mm-item.subi', {
            type: 'button', 'data-nav': '', 'data-key': `mm-${it.key}-${k}`, onclick: (e) => { e.preventDefault(); fn(); },
          }, h('span', label))));
        }
      };
      for (const it of ITEMS) {
        const row = h('button.tp-mm-item', { type: 'button', 'data-nav': '', 'data-key': 'mm-' + it.key, 'data-mm': it.key,
          onclick: (e) => {
            e.preventDefault();
            setActive(it, row);
            if (it.go) { it.go(); return; }
            const first = subWrap.querySelector('[data-nav]');
            if (first) nav.focusEl ? nav.focusEl(first) : first.focus();
          } }, h('i.ab', 'A'), h('span', it.label));
        row.addEventListener('mouseenter', () => setActive(it, row));
        row.addEventListener('tp-navfocus', () => setActive(it, row));
        rows.push(row);
        list.appendChild(row);
      }
      list.appendChild(subWrap);
      const listWrap = h('div.tp-mm', list, desc);
      p.appendChild(listWrap);
      mmSetActive = (key) => { const k = ITEMS.findIndex((x) => x.key === key); if (k >= 0) setActive(ITEMS[k], rows[k]); };
      // needs layout for offsetTop
      requestAnimationFrame(() => mmSetActive(mmActive && ITEMS.some((x) => x.key === mmActive) ? mmActive : 'lan'));
      mmSetActive(mmActive || 'lan');

      // news panel
      const news = h('div.tp-mm-news',
        h('div.art',
          h('div.lg', { html: logoSvg() }),
          h('div.ready', '‹ GET READY ›'),
          h('div.big', 'SEASON 1'),
          h('div.big2', 'LAN PLAY IS HERE.'),
          h('div.chips', h('span', '6-DIGIT CODES'), h('span', 'NO INSTALL'), h('span', 'UP TO 6 PLAYERS'))),
        h('div.txt',
          h('h4', 'How to play together:'),
          h('p', 'On one computer choose ', h('b', 'Play LAN › Host game'), ' to get a 6-digit game code. Everyone else on the same Wi-Fi picks ',
            h('b', 'Join game'), ' and types it in. The host runs the match and bots can fill any empty spots.'),
          (tipEl = h('div.tip'))));
      renderTip();
      p.appendChild(news);

      // bottom band: player card + hints, then the ticker
      const { level, rank } = levelInfo((api.getStats ? api.getStats() : stats) || {});
      const team = settings.game.team === 1 ? 1 : 0;
      p.append(
        h('div.tp-mm-band',
          h('div.tp-mm-player',
            h('div.av', { style: { background: TEAM_COLORS[team].css } }, String(settings.game.playerName || 'P').slice(0, 1).toUpperCase()),
            h('div.who', h('div.nm', settings.game.playerName || 'Player'),
              h('div.rk', h('span.lv', String(level)), h('span', rank.toUpperCase()))),
            btn('Profile', () => push('profile'), { key: 'mm-band-profile', cls: 'tp-mm-mini' }),
            btn('Garage', () => push('garage'), { key: 'mm-band-garage', cls: 'tp-mm-mini' })),
          h('div.tp-mm-hints', h('span', h('span.tp-key', '↑↓'), ' / mouse to choose'), h('span', h('span.tp-key', 'Enter'), ' or ', h('span.tp-key.pad', 'A'), ' to select'))),
        h('div.tp-mm-ticker', h('span.l', `WELCOME TO ${GAME_TITLE.toUpperCase()}!`), h('span.r', 'Host a LAN game and share the 6-digit code')));
    },

    play(p) {
      const lm = settings.game.lastMode || {};
      const cfg = playCfg || (playCfg = {
        teamSize: lm.teamSize || 1,
        difficulty: lm.difficulty || 'pro',
        teammateDifficulty: lm.teammateDifficulty || lm.difficulty || 'pro',
        opponentDifficulty: lm.opponentDifficulty || lm.difficulty || 'pro',
        split: !!(lm.teammateDifficulty && lm.opponentDifficulty && (lm.teammateDifficulty !== lm.difficulty || lm.opponentDifficulty !== lm.difficulty)),
        playerTeam: settings.game.team === 1 ? 1 : 0,
        durationSec: lm.durationSec || 300,
        custom: !!(lm.blueSize && lm.orangeSize && lm.blueSize !== lm.orangeSize),
        blueSize: lm.blueSize || lm.teamSize || 1,
        orangeSize: lm.orangeSize || lm.teamSize || 1,
        mods: { codes: validCodes(lm.modifiers), draft: '', error: '' },
      });
      const mySize = () => (cfg.custom ? (cfg.playerTeam === 1 ? cfg.orangeSize : cfg.blueSize) : cfg.teamSize);
      const body = CAR_BODIES.find((b) => b.id === settings.game.carBody) || CAR_BODIES[0];
      p.append(h('div.tp-shade-r'), title('Play', 'Exhibition vs bots'));
      const panel = h('div.tp-panel.tp-scroll', { style: { right: 'calc(var(--u) * 3)', top: 'calc(var(--u) * 13)', width: 'min(calc(var(--u) * 70), 44vw)', maxHeight: 'calc(100% - var(--u) * 21)', padding: 'calc(var(--u) * 2.2) calc(var(--u) * 2.8)' } });
      panel.append(
        group('Mode', seg([[1, '1v1', 'Duel'], [2, '2v2', 'Doubles'], [3, '3v3', 'Standard'], ['custom', 'Custom', 'Any mix']], cfg.custom ? 'custom' : cfg.teamSize, (v) => {
          if (v === 'custom') { if (!cfg.custom) { cfg.custom = true; cfg.blueSize = cfg.teamSize; cfg.orangeSize = cfg.teamSize; } }
          else { cfg.custom = false; cfg.teamSize = v; }
          refresh();
        }, { key: 'mode' })));
      if (cfg.custom) {
        const sizes = [[1, '1'], [2, '2'], [3, '3']];
        panel.appendChild(h('div', { style: { display: 'flex', gap: 'calc(var(--u) * 2)' } },
          h('div', { style: { flex: '1' } }, group('Blue size', seg(sizes, cfg.blueSize, (v) => { cfg.blueSize = v; refresh(); }, { key: 'bsize' }))),
          h('div', { style: { flex: '1' } }, group('Orange size', seg(sizes, cfg.orangeSize, (v) => { cfg.orangeSize = v; refresh(); }, { key: 'osize', orangeFor: cfg.orangeSize })))));
      }
      panel.append(
        group('Bot difficulty', seg(DIFFS, cfg.difficulty, (v) => { cfg.difficulty = v; if (!cfg.split) { cfg.teammateDifficulty = v; cfg.opponentDifficulty = v; } refresh(); }, { key: 'diff' })),
      );
      const splitRow = h('div.tp-row', { style: { padding: 0, borderBottom: 0, gridTemplateColumns: '1fr auto' } },
        h('div.nm', 'Separate teammate / opponent difficulty'));
      const tg = h('button.tp-toggle' + (cfg.split ? '.on' : ''), { type: 'button', 'data-nav': '', 'data-key': 'split', onclick: (e) => { e.preventDefault(); cfg.split = !cfg.split; if (!cfg.split) { cfg.teammateDifficulty = cfg.difficulty; cfg.opponentDifficulty = cfg.difficulty; } refresh(); } });
      splitRow.appendChild(tg);
      panel.appendChild(h('div.tp-group', splitRow));
      if (cfg.split) {
        if (mySize() > 1) panel.appendChild(group('Teammates', seg(DIFFS, cfg.teammateDifficulty, (v) => { cfg.teammateDifficulty = v; refresh(); }, { key: 'tdiff' })));
        panel.appendChild(group('Opponents', seg(DIFFS, cfg.opponentDifficulty, (v) => { cfg.opponentDifficulty = v; refresh(); }, { key: 'odiff' })));
      }
      panel.append(
        group('Your team', seg([[0, 'Blue'], [1, 'Orange']], cfg.playerTeam, (v) => { cfg.playerTeam = v; refresh(); },
          { key: 'team', orangeFor: 1, swatch: { 0: TEAM_COLORS[0].css, 1: TEAM_COLORS[1].css } })),
        group('Match length', seg([[180, '3:00'], [300, '5:00'], [600, '10:00']], cfg.durationSec, (v) => { cfg.durationSec = v; refresh(); }, { key: 'len' })),
        group('Car', h('div.tp-row', { style: { padding: 0, borderBottom: 0, gridTemplateColumns: '1fr auto' } },
          h('div.nm', `${body.name}`, h('small', `Hitbox: ${hitboxLabel(body.hitbox)}`)),
          btn('Garage', () => push('garage'), { cls: 'ital', key: 'to-garage' }))),
        modifierBox(cfg.mods, 'play-mod'),
        btn('Start match', () => {
          const c = {
            teamSize: cfg.custom ? Math.max(cfg.blueSize, cfg.orangeSize) : cfg.teamSize, difficulty: cfg.difficulty,
            blueSize: cfg.custom ? cfg.blueSize : cfg.teamSize, orangeSize: cfg.custom ? cfg.orangeSize : cfg.teamSize,
            teammateDifficulty: cfg.split ? cfg.teammateDifficulty : cfg.difficulty,
            opponentDifficulty: cfg.split ? cfg.opponentDifficulty : cfg.difficulty,
            playerTeam: cfg.playerTeam, bodyId: settings.game.carBody, accent: settings.game.accent, durationSec: cfg.durationSec,
            modifiers: cfg.mods.codes.slice(),
          };
          if (settings.game.team !== cfg.playerTeam) { settings.game.team = cfg.playerTeam; api.saveSettings && api.saveSettings(); }
          api.startMatch(c);
        }, { cls: 'primary', key: 'start' }),
      );
      p.append(panel, footer());
    },

    freeplay(p) {
      const fp = settings.game.freeplay;
      const inPause = ctx === 'pause';
      p.append(h(inPause ? 'div.tp-shade-full' : 'div.tp-shade-r'), title('Free Play', inPause ? 'Options' : 'Training'));
      const panel = h('div.tp-panel.accent-o', { style: inPause
        ? { left: 'calc(var(--u) * 4)', top: 'calc(var(--u) * 13)', width: 'calc(var(--u) * 74)', padding: 'calc(var(--u) * 2) 0' }
        : { right: 'calc(var(--u) * 3)', top: 'calc(var(--u) * 13)', width: 'min(calc(var(--u) * 70), 44vw)', padding: 'calc(var(--u) * 2) 0' } });
      const rows = h('div.tp-rows',
        toggleRow('Ball prediction line', fp, 'predictionLine', 'Shows where the ball will travel over the next few seconds'),
        toggleRow('Unlimited boost', fp, 'unlimitedBoost', 'Boost never runs out'),
        h('div.tp-row', h('div.nm', 'Reset ball', h('small', 'Puts the ball back at centre and your car at the blue half')),
          h('div', h('span.tp-key', keyList(settings.bindings.kb.resetBall)), ' ', h('span.tp-key.pad', padName(settings.bindings.pad.resetBall))), h('div.val')));
      panel.appendChild(rows);
      const actions = h('div', { style: { padding: 'calc(var(--u) * 2) calc(var(--u) * 3) calc(var(--u) * 1)', display: 'flex', gap: 'calc(var(--u) * 1)' } });
      if (inPause) {
        actions.append(btn('Reset ball now', () => { api.resetBall(); api.resumeGame(); }, { key: 'fp-reset' }), btn('Resume', () => api.resumeGame(), { cls: 'primary', key: 'fp-resume' }));
      } else {
        actions.append(btn('Start free play', () => api.startFreePlay({ bodyId: settings.game.carBody, accent: settings.game.accent, playerTeam: settings.game.team }), { cls: 'primary', key: 'fp-start' }));
      }
      actions.querySelectorAll('.tp-btn').forEach((b) => { b.style.flex = '1'; });
      panel.appendChild(actions);
      p.append(panel, footer());
    },

    garage(p) {
      const g = settings.game;
      const team = g.team === 1 ? 1 : 0;
      const body = CAR_BODIES.find((b) => b.id === g.carBody) || CAR_BODIES[0];
      const apply = (bodyId, accent, t) => {
        api.setPreviewCar(bodyId, accent, t);
        g.carBody = bodyId; g.accent = accent; g.team = t;
        if (playCfg) playCfg.playerTeam = t;
        api.saveSettings && api.saveSettings();
        refresh();
      };
      p.append(title('Garage', 'Body · hitbox · paint'));
      const panel = h('div.tp-panel.tp-scroll', { style: { right: 'calc(var(--u) * 3)', top: 'calc(var(--u) * 4)', width: 'calc(var(--u) * 52)', maxHeight: 'calc(100% - var(--u) * 12)', padding: 'calc(var(--u) * 2.4) calc(var(--u) * 2.6)' } });
      const nameIn = h('input.tp-input', { type: 'text', maxlength: '16', value: g.playerName || 'Player', 'data-nav': '', 'data-key': 'name', spellcheck: 'false' });
      nameIn.addEventListener('input', () => { g.playerName = nameIn.value.replace(/[^\w .\-]/g, '').slice(0, 16) || 'Player'; });
      nameIn.addEventListener('change', () => { api.saveSettings && api.saveSettings(); });
      nameIn.addEventListener('keydown', (e) => { if (e.key === 'Enter') nameIn.blur(); e.stopPropagation(); });
      panel.appendChild(group('Player name', nameIn));

      const cars = h('div.tp-cars');
      for (const b of CAR_BODIES) {
        cars.appendChild(h('button.tp-carbtn' + (b.id === body.id ? '.sel' : ''), {
          type: 'button', 'data-nav': '', 'data-key': 'car:' + b.id, onclick: (e) => { e.preventDefault(); apply(b.id, g.accent, team); },
        }, h('span.n', b.name), h('span.hb', `Hitbox: ${hitboxLabel(b.hitbox)}`)));
      }
      panel.appendChild(group('Body', cars));
      const hb = CAR_CONFIGS[body.hitbox];
      if (hb) {
        panel.appendChild(h('div.tp-hbinfo', { style: { marginTop: 'calc(var(--u) * -1.2)', marginBottom: 'calc(var(--u) * 2.2)' } },
          h('b', `${body.name}`), ` uses the ${hitboxLabel(body.hitbox)} hitbox — `,
          h('b', `${hb.hitboxSize.x.toFixed(1)} × ${hb.hitboxSize.y.toFixed(1)} × ${hb.hitboxSize.z.toFixed(1)}`), ' uu (L × W × H).'));
      }
      const sw = h('div.tp-swatches');
      const acc = String(g.accent || '#e8e8e8').toLowerCase();
      for (const c of ACCENTS) {
        sw.appendChild(h('button.tp-sw' + (c === acc ? '.sel' : ''), {
          type: 'button', title: c, 'data-nav': '', 'data-key': 'sw:' + c, style: { background: c },
          onclick: (e) => { e.preventDefault(); apply(body.id, c, team); },
        }));
      }
      const picker = h('input', { type: 'color', value: /^#[0-9a-f]{6}$/i.test(acc) ? acc : '#e8e8e8', 'data-nav': '', 'data-key': 'picker' });
      picker.addEventListener('change', () => apply(body.id, picker.value, team));
      panel.appendChild(group('Accent colour', sw, h('div.tp-color', picker, h('span.hex', acc.toUpperCase()), h('span.hex', 'Custom'))));
      panel.appendChild(group('Team preview', seg([[0, 'Blue'], [1, 'Orange']], team, (v) => apply(body.id, g.accent, v),
        { key: 'gteam', orangeFor: 1, swatch: { 0: TEAM_COLORS[0].css, 1: TEAM_COLORS[1].css } })));
      p.append(panel, footer(playerCard()));
    },

    settings(p) {
      p.append(h(ctx === 'pause' ? 'div.tp-shade-full' : 'div.tp-shade-l'), title('Settings', TABS.find((t) => t[0] === settingsTab)[1]));
      const panel = h('div.tp-panel', { style: { left: 'calc(var(--u) * 4)', top: 'calc(var(--u) * 12.5)', width: 'min(calc(var(--u) * 118), calc(100% - var(--u) * 8))', maxHeight: 'calc(100% - var(--u) * 20.5)', display: 'flex', flexDirection: 'column' } });
      const tabs = h('div.tp-tabs');
      for (const [id, label] of TABS) {
        tabs.appendChild(h('button.tp-tab' + (id === settingsTab ? '.sel' : ''), { type: 'button', 'data-nav': '', 'data-key': 'tab:' + id, onclick: (e) => { e.preventDefault(); settingsTab = id; refresh(); } }, label));
      }
      const body = h('div.tp-scroll.tp-rows', { style: { flex: '1 1 auto', minHeight: '0' } });
      TAB_BUILDERS[settingsTab](body);
      panel.append(tabs, body);
      p.append(panel, footer(btn('Reset tab to defaults', () => resetTab(settingsTab), { key: 'reset-tab', cls: 'ital' })));
    },

    controls(p) {
      p.append(h(ctx === 'pause' ? 'div.tp-shade-full' : 'div.tp-shade-l'), title('Controls', 'Keyboard & mouse · gamepad · mechanics'));
      const panel = h('div.tp-panel.tp-scroll', { style: { left: 'calc(var(--u) * 4)', top: 'calc(var(--u) * 12.5)', width: 'min(calc(var(--u) * 140), calc(100% - var(--u) * 8))', bottom: 'calc(var(--u) * 8)', padding: 'calc(var(--u) * 2.4) calc(var(--u) * 3)' }, 'data-nav': '', 'data-key': 'help-scroll' });
      const kb = settings.bindings.kb, pad = settings.bindings.pad;
      const kt = h('table.tp-ktable');
      const KB_ROWS = ['throttle', 'reverse', 'steerLeft', 'steerRight', 'jump', 'boost', 'powerslide', 'airRollLeft', 'airRollRight', 'pitchUp', 'pitchDown', 'ballCam', 'freeLook', 'scoreboard', 'resetBall', 'pause'];
      for (const a of KB_ROWS) {
        const keys = (kb[a] || []).map((k) => h('span.tp-key', keyName(k)));
        kt.appendChild(h('tr', h('td', ACTION_LABELS[a] || a), h('td', keys.length ? keys : '—')));
      }
      kt.appendChild(h('tr', h('td', 'Mouse air control'), h('td', settings.controls.mouseAirPitch ? 'On (move mouse)' : 'Off — enable in Settings › Controls')));
      kt.appendChild(h('tr', h('td', 'Debug overlay'), h('td', h('span.tp-key', 'F3'))));
      const pt = h('table.tp-ktable');
      const PAD_ROWS = ['throttle', 'reverse', 'steerAxis', 'pitchAxis', 'jump', 'boost', 'powerslide', 'airRollLeft', 'airRollRight', 'ballCam', 'scoreboard', 'resetBall', 'pause', 'lookX'];
      for (const a of PAD_ROWS) pt.appendChild(h('tr', h('td', ACTION_LABELS[a] || a), h('td', h('span.tp-key', padName(pad[a])))));
      const help = h('div.tp-help',
        h('div', h('div.tp-sect', 'Keyboard & mouse'), kt),
        h('div', h('div.tp-sect', 'Gamepad'), padDiagram(pad), pt));
      const jumpK = keyName((kb.jump || [])[0]), boostK = keyName((kb.boost || [])[0]);
      const tips = h('div.tp-tips',
        tip('Half-flip', [`Drive backwards, press ${jumpK} then ${jumpK} + back (S / stick down) to backflip.`, 'Immediately push forward (W / stick up) to cancel the flip.', 'Hold air roll (Q / E or powerslide + steer) to roll upright, land and drive away.']),
        tip('Wavedash', [`Tap ${jumpK} to hop, tilt the nose slightly up.`, 'As the back wheels are about to touch, dodge forward or sideways.', 'Landing during the dodge keeps the speed boost — great for recoveries.']),
        tip('Speed-flip', [`Hold ${boostK} and steer slightly toward the ball.`, 'Jump, then dodge diagonally forward (W + A or W + D).', 'Instantly pull back and air-roll the opposite way to flatten out — fastest kickoff.']),
        tip('Fast aerial', [`Jump, hold ${boostK} and pull back on pitch at the same time.`, `Tap ${jumpK} again within ~0.2 s while still pulling back.`, 'Keep boosting toward the ball and fine-tune with air control.']),
        tip('Flip reset', ['Fly into the ball with all four wheels facing it.', 'When the wheels touch, your flip is restored — even without a jump.', 'Use the dodge for a powerful, unexpected shot.']),
        tip('Powerslide & air roll', ['Hold powerslide while turning for a tight drift.', 'In the air, powerslide + steer rolls freely (free air roll).', 'Q / E (LB / RB) roll left / right directionally.']));
      panel.append(help, h('div.tp-sect', 'Mechanics'), tips);
      p.append(panel, footer());
    },

    // Profile: player name, level, stats on this device (updated after every match) and the
    // redeem-code box that unlocks items such as skins (codes live in game/profile.js).
    profile(p) {
      const st = (api.getStats ? api.getStats() : stats) || {};
      const prof = (api.getProfile ? api.getProfile() : null) || { redeemed: [], items: [] };
      const g = settings.game;
      const team = g.team === 1 ? 1 : 0;
      const lv = levelInfo(st);
      p.append(h('div.tp-shade-l'), title('Profile', 'Saved on this device'));
      const panel = h('div.tp-panel.tp-scroll.tp-prof', { style: { left: 'calc(var(--u) * 4)', top: 'calc(var(--u) * 12.5)', width: 'min(calc(var(--u) * 120), calc(100% - var(--u) * 8))', maxHeight: 'calc(100% - var(--u) * 20.5)', padding: 'calc(var(--u) * 2.6) calc(var(--u) * 3)' } });

      // header: avatar, editable name, level + rank with progress to the next level
      const av = h('div.av', { style: { background: TEAM_COLORS[team].css } }, String(g.playerName || 'P').slice(0, 1).toUpperCase());
      const nameIn = h('input.tp-input.tp-prof-name', { type: 'text', maxlength: String(NAME_MAX), value: g.playerName || 'Player', placeholder: 'Player', 'data-nav': '', 'data-key': 'prof-name', spellcheck: 'false', autocomplete: 'off', 'aria-label': 'Player name' });
      const nameMsg = h('div.tp-note.tp-prof-msg', profState.nameMsg || `Up to ${NAME_MAX} letters, numbers, spaces, dots or dashes.`);
      const saveName = () => {
        const n = cleanName(nameIn.value) || 'Player';
        nameIn.value = n;
        if (n === g.playerName) return;
        g.playerName = n;
        api.saveSettings && api.saveSettings();
        profState.nameMsg = `Name saved as “${n}”.`;
        refresh();
      };
      nameIn.addEventListener('input', () => {
        const c = nameIn.value.replace(/[^\w .\-]/g, '').slice(0, NAME_MAX);
        if (c !== nameIn.value) nameIn.value = c;
        av.textContent = (c.trim() || 'P').slice(0, 1).toUpperCase();
      });
      nameIn.addEventListener('change', saveName);
      nameIn.addEventListener('keydown', (e) => { e.stopPropagation(); if (e.key === 'Enter') nameIn.blur(); else if (e.key === 'Escape') { nameIn.value = g.playerName || 'Player'; nameIn.blur(); } });
      const bar = h('div.tp-prof-bar', h('i', { style: { width: `${Math.round(lv.progress * 100)}%` } }));
      panel.appendChild(h('div.tp-prof-head', av,
        h('div.tp-prof-id',
          h('div.lbl', 'Player name'),
          h('div.tp-modrow', nameIn, btn('Save', saveName, { key: 'prof-name-save', cls: 'tp-modadd' })),
          nameMsg),
        h('div.tp-prof-lv',
          h('div.rk', h('span.lv', String(lv.level)), h('span', lv.rank.toUpperCase())),
          bar, h('div.nx', `${lv.toNext} XP to level ${lv.level + 1}`))));

      // stats on this device
      const matches = st.matches || 0, wins = st.wins || 0, shots = st.shots || 0, goals = st.goals || 0;
      const tiles = h('div.tp-tiles');
      const tile = (v, k) => tiles.appendChild(h('div.tp-tile', h('div.v', String(v)), h('div.k', k)));
      tile(matches, 'Games played'); tile(wins, 'Wins'); tile(Math.max(0, matches - wins), 'Losses');
      tile(matches ? `${Math.round((wins / matches) * 100)}%` : '—', 'Win rate');
      tile(st.streak || 0, 'Win streak'); tile(st.bestStreak || 0, 'Best streak'); tile(st.mvps || 0, 'MVPs'); tile(goals, 'Goals');
      tile(st.assists || 0, 'Assists'); tile(st.saves || 0, 'Saves'); tile(shots, 'Shots'); tile(st.demos || 0, 'Demolitions');
      tile(shots ? `${Math.round((goals / shots) * 100)}%` : '—', 'Shooting %');
      tile(matches ? (goals / matches).toFixed(2) : '—', 'Goals / game');
      tile(matches ? ((st.saves || 0) / matches).toFixed(2) : '—', 'Saves / game');
      tile(st.firstPlayed ? new Date(st.firstPlayed).toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric' }) : '—', 'Playing since');
      panel.append(h('div.tp-sect', 'Stats on this device'), tiles,
        h('div.tp-note.tp-prof-small', 'Exhibition and LAN matches count. Free play doesn’t. Stats stay in this browser on this device.'));

      // redeem code -> unlocks items on this profile
      const codeIn = h('input.tp-input.tp-modin', { type: 'text', autocomplete: 'off', spellcheck: 'false', maxlength: '19', placeholder: REWARD_CODE_EXAMPLE, 'data-nav': '', 'data-key': 'prof-code-in', 'aria-label': 'Reward code' });
      codeIn.value = profState.draft || '';
      const redeem = () => {
        const r = redeemCode(codeIn.value, prof);
        if (r.ok) {
          api.saveProfile && api.saveProfile();
          profState.draft = ''; profState.error = '';
          profState.ok = r.added.length ? `Unlocked: ${r.added.map((it) => it.name).join(', ')}` : `Redeemed ${r.reward.name || r.code}.`;
        } else { profState.draft = r.code; profState.error = r.error; profState.ok = ''; }
        refresh();
      };
      codeIn.addEventListener('input', () => {
        const f = formatRewardCode(codeIn.value);
        if (f !== codeIn.value) codeIn.value = f;
        profState.draft = f;
        if (profState.error || profState.ok) { profState.error = ''; profState.ok = ''; msg.textContent = ''; msg.style.display = 'none'; }
      });
      codeIn.addEventListener('keydown', (e) => { e.stopPropagation(); if (e.key === 'Enter') redeem(); else if (e.key === 'Escape') codeIn.blur(); });
      const msg = h('div.tp-note.tp-moderr' + (profState.error ? '.err' : '.tp-prof-ok'), profState.error || profState.ok || '');
      if (!profState.error && !profState.ok) msg.style.display = 'none';
      const items = h('div.tp-modlist');
      for (const it of prof.items) items.appendChild(h('div.tp-modchip.tp-prof-item', h('span.it', it.name), h('span.nm', cap(it.type))));
      panel.append(h('div.tp-sect', 'Redeem a code'),
        h('div.tp-modrow', codeIn, btn('Redeem', redeem, { key: 'prof-code-redeem', cls: 'tp-modadd' })), msg,
        h('div.tp-note.tp-modhint', 'Codes unlock things for your profile, like car skins.'),
        h('div.tp-sect', 'Unlocked items'),
        prof.items.length ? items : h('div.tp-note.tp-modhint', 'Nothing unlocked yet.'));
      p.append(panel, footer());
    },
    // older name for the page (Extras › Career stats) — shows the Profile page
    stats(p) { PAGES.profile(p); },

    lan(p) {
      api.lanLeave && api.lanLeave(); // coming back here closes any lobby that isn't playing
      const st = api.lanState ? api.lanState() : { notice: '' };
      p.append(h('div.tp-shade-r'), title('LAN Play', 'Same network'));
      const panel = h('div.tp-panel', { style: { right: 'calc(var(--u) * 3)', top: 'calc(var(--u) * 13)', width: 'min(calc(var(--u) * 70), 44vw)', padding: 'calc(var(--u) * 2.4) calc(var(--u) * 2.8)' } });
      if (st.notice) panel.appendChild(h('div.tp-note.err', st.notice));
      if (api.lanSupported && !api.lanSupported()) panel.appendChild(h('div.tp-note.err', 'This browser can’t do network play. Use Chrome, Edge or Firefox.'));
      panel.append(
        h('div.tp-note', 'Play with friends: open this same TURBO PITCH website on each computer. ',
          'One computer hosts and gets a ', h('b', '6-digit game code'), '; everyone else joins by typing it in. ',
          'It connects directly when the network allows it, otherwise through the website — so it works on school Wi-Fi too.'),
        h('div.tp-nav', { style: { position: 'static', width: '100%' } },
          btn('Host a game', () => { api.lanHost(); push('lanhost'); }, { sub: 'Get a game code', key: 'lan-host' }),
          btn('Join a game', () => push('lanjoin'), { sub: 'Type the host’s code', key: 'lan-join' })),
      );
      p.append(panel, footer());
    },

    lanhost(p) {
      let st = api.lanState();
      if (st.role !== 'host') { api.lanHost(); st = api.lanState(); }
      const last = settings.game.lastLan || {};
      const cfg = lanCfg || (lanCfg = { teamSize: last.teamSize || 2, bots: last.noBots ? false : true, difficulty: last.difficulty || 'pro', durationSec: last.durationSec || 300,
        mods: { codes: validCodes(last.modifiers), draft: '', error: '' } });
      const slots = st.slots;
      const live = slots.filter((s) => s.status !== 'left');
      api.lanSetInfo(`${cfg.teamSize}v${cfg.teamSize} · ${cfg.bots ? 'bots fill empty spots' : 'no bots'} · ${Math.round(cfg.durationSec / 60)} min`
        + (cfg.mods.codes.length ? ` · modifiers: ${cfg.mods.codes.map((c) => lookupCode(c).name).join(', ')}` : ''));
      p.append(h('div.tp-shade-r'), title('Host', 'LAN lobby'));
      const panel = h('div.tp-panel.tp-scroll', { style: { right: 'calc(var(--u) * 3)', top: 'calc(var(--u) * 13)', width: 'min(calc(var(--u) * 78), 50vw)', maxHeight: 'calc(100% - var(--u) * 21)', padding: 'calc(var(--u) * 2.2) calc(var(--u) * 2.8)' } });
      const teamSeg = (team, onPick, key) => seg([[0, 'Blue'], [1, 'Orange']], team, onPick, { key, orangeFor: 1, swatch: { 0: TEAM_COLORS[0].css, 1: TEAM_COLORS[1].css } });

      // game code
      const codeCard = h('div.tp-gamecode');
      if (st.relayStatus === 'online' && st.code) {
        codeCard.append(h('div.lbl', 'Game code'), h('div.num', `${st.code.slice(0, 3)} ${st.code.slice(3)}`),
          h('div.sub', 'On the other computers open this same website, choose ', h('b', 'Play LAN › Join game'), ' and type this code.'));
      } else if (st.relayStatus === 'offline') {
        codeCard.append(h('div.lbl', 'Game code'), h('div.tp-note.err', { style: { margin: 'calc(var(--u) * 0.6) 0' } }, st.relayError || 'No game code.'),
          h('div.act', btn('Try again', async () => { await api.lanRetryCode(); refresh(); }, { key: 'code-retry', cls: 'primary' })));
      } else {
        codeCard.append(h('div.lbl', 'Game code'), h('div.num.wait', '··· ···'), h('div.sub', 'Getting a code…'));
      }
      panel.appendChild(codeCard);

      const list = h('div');
      const myTeam = settings.game.team === 1 ? 1 : 0;
      list.appendChild(h('div.tp-lan-slot' + (myTeam ? '.t1' : ''),
        h('div.top', h('div.nm', `${settings.game.playerName || 'Player'} (you, host)`), teamSeg(myTeam, (v) => { api.lanSetTeam('host', v); refresh(); }, 'team-host'))));
      for (const s of slots) {
        const [label, cls] = STATUS[s.status] || [s.status, ''];
        const card = h('div.tp-lan-slot' + (s.team ? '.t1' : ''));
        const name = s.status === 'connected' ? s.name : 'New player';
        card.appendChild(h('div.top', h('div.nm', name),
          h('div.st' + (cls ? '.' + cls : ''), s.status === 'connected' ? (s.mode === 'p2p' ? 'Direct' : 'Via website') : label),
          s.status === 'connected' ? teamSeg(s.team, (v) => { api.lanSetTeam(s.id, v); refresh(); }, 'team-' + s.id) : null,
          btn(s.status === 'connected' ? 'Kick' : 'Cancel', () => { api.lanRemove(s.id); refresh(); }, { key: 'rm-' + s.id })));
        if (s.error) card.appendChild(h('div.tp-note.err', { style: { margin: 'calc(var(--u) * 0.8) 0 0' } }, s.error));
        list.appendChild(card);
      }
      panel.append(group(`Players (${1 + live.filter((s) => s.status === 'connected').length})`, list));
      panel.append(
        group('Team size', seg([[1, '1v1'], [2, '2v2'], [3, '3v3']], cfg.teamSize, (v) => { cfg.teamSize = v; refresh(); }, { key: 'lan-size' })),
        group('Empty spots', seg([[true, 'Bots'], [false, 'Leave empty']], cfg.bots, (v) => { cfg.bots = v; refresh(); }, { key: 'lan-bots' })));
      if (cfg.bots) panel.appendChild(group('Bot difficulty', seg(DIFFS, cfg.difficulty, (v) => { cfg.difficulty = v; refresh(); }, { key: 'lan-diff' })));
      panel.append(
        group('Match length', seg([[180, '3:00'], [300, '5:00'], [600, '10:00']], cfg.durationSec, (v) => { cfg.durationSec = v; refresh(); }, { key: 'lan-len' })),
        modifierBox(cfg.mods, 'lan-mod'),
        btn('Start match', () => {
          api.lanStart({ teamSize: cfg.teamSize, blueSize: cfg.teamSize, orangeSize: cfg.teamSize, noBots: !cfg.bots, difficulty: cfg.difficulty,
            teammateDifficulty: cfg.difficulty, opponentDifficulty: cfg.difficulty, durationSec: cfg.durationSec, modifiers: cfg.mods.codes.slice() });
        }, { cls: 'primary', key: 'lan-start', sub: live.some((s) => s.status !== 'connected') ? 'Players still joining will miss this match' : '' }));
      p.append(panel, footer());
    },

    lanjoin(p) {
      const st = api.lanState();
      const c = st.role === 'client' ? st.client : null;
      p.append(h('div.tp-shade-r'), title('Join', 'LAN game'));
      const panel = h('div.tp-panel.tp-scroll', { style: { right: 'calc(var(--u) * 3)', top: 'calc(var(--u) * 13)', width: 'min(calc(var(--u) * 70), 46vw)', maxHeight: 'calc(100% - var(--u) * 21)', padding: 'calc(var(--u) * 2.4) calc(var(--u) * 2.8)' } });
      const status = c ? c.status : 'idle';
      const go = async () => {
        if (lanBusy.join) return;
        lanBusy.join = true;
        try { await api.lanJoin(lanDrafts.join || ''); } finally { lanBusy.join = false; }
        refresh();
      };
      if (!c || status === 'idle') {
        const inp = h('input.tp-input.tp-codein', { type: 'text', inputmode: 'numeric', autocomplete: 'off', spellcheck: 'false', maxlength: '7', placeholder: '000000', 'data-nav': '', 'data-key': 'join-code' });
        inp.value = lanDrafts.join || '';
        inp.addEventListener('input', () => { lanDrafts.join = inp.value; });
        inp.addEventListener('keydown', (e) => { e.stopPropagation(); if (e.key === 'Enter') go(); else if (e.key === 'Escape') inp.blur(); });
        panel.append(
          h('div.tp-note', 'Type the ', h('b', '6-digit game code'), ' shown on the host’s screen:'),
          inp,
          h('div', { style: { height: 'calc(var(--u) * 1.4)' } }),
          btn('Join', go, { cls: 'primary', key: 'join-go' }));
        if (c && c.error) panel.appendChild(h('div.tp-note.err', { style: { marginTop: 'calc(var(--u) * 1.4)' } }, c.error));
      } else if (status === 'finding' || status === 'connecting') {
        panel.append(h('div.tp-gamecode', h('div.lbl', 'Game code'), h('div.num', String(lanDrafts.join || '').replace(/\D/g, '').replace(/^(\d{3})(\d{3})$/, '$1 $2')),
          h('div.sub', status === 'finding' ? 'Looking for the game…' : 'Found it — connecting…')));
      } else if (status === 'connected' || status === 'playing') {
        const lob = c.lobby;
        panel.appendChild(h('div.tp-note', h('b', 'Connected! '), 'Waiting for the host to start the match.',
          c.mode ? h('span', { style: { opacity: 0.75 } }, c.mode === 'p2p' ? ' (direct connection)' : ' (connected through the website)') : null));
        if (lob) {
          if (lob.info) panel.appendChild(h('div.tp-note', lob.info));
          const list = h('div');
          for (const pl of lob.players) {
            list.appendChild(h('div.tp-lan-slot' + (pl.team ? '.t1' : ''),
              h('div.top', h('div.nm', pl.name + (pl.host ? ' (host)' : pl.id === lob.you ? ' (you)' : '')), h('div.st', TEAM_NAME[pl.team] || ''))));
          }
          panel.appendChild(group('Players', list));
        }
      } else {
        panel.append(h('div.tp-note.err', c.reason || 'Disconnected.'),
          btn('Try again', () => { api.lanLeave(); lanDrafts.join = ''; refresh(); }, { cls: 'primary', key: 'join-retry' }));
      }
      p.append(panel, footer());
    },
    pause(p) {
      const game = api.getGame ? api.getGame() : null;
      const fp = api.isFreePlay ? api.isFreePlay() : false;
      let sub = 'Free play';
      if (!fp && game) sub = `${game.lan ? 'LAN match' : 'Exhibition'} ${(game.cfg && game.cfg.teamSize) || 1}v${(game.cfg && game.cfg.teamSize) || 1}`;
      if (game && game.lan) sub += ' · the match keeps running';
      p.append(h('div.tp-shade-full'), h('div.tp-paused-title', 'PAUSED', h('small', sub)));
      const items = [btn('Resume', () => api.resumeGame())];
      if (fp) {
        items.push(btn('Reset ball', () => { api.resetBall(); api.resumeGame(); }, { sub: keyList(settings.bindings.kb.resetBall) }));
        items.push(btn('Free play options', () => push('freeplay'), { sub: 'Toggles' }));
      }
      items.push(btn('Settings', () => push('settings')), btn('Controls', () => push('controls'), { sub: 'Help' }),
        btn(game && game.lan ? 'Leave LAN match' : 'Quit to menu', () => api.quitToMenu(), { sub: game && game.lan === 'host' ? 'Ends it for everyone' : '' }));
      p.append(h('div.tp-nav', ...items), footer());
    },

    end(p) {
      const mv = endView || {};
      const game = api.getGame ? api.getGame() : null;
      const pid = game ? game.playerCarId : -1;
      const me = (mv.players || []).find((x) => x.carId === pid);
      const w = mv.winner === 0 || mv.winner === 1 ? mv.winner : (mv.scores ? (mv.scores[0] > mv.scores[1] ? 0 : mv.scores[1] > mv.scores[0] ? 1 : null) : null);
      let res = 'Match complete';
      if (me && w !== null) res = me.team === w ? 'Victory' : 'Defeat';
      p.append(h('div.tp-end-shade'));
      const banner = h('div.tp-end-banner',
        h('div.res', res),
        h('div.tp-goal-band.' + (w === 1 ? 't1' : 't0'), h('div.tp-goal-title', w === null ? 'DRAW' : `${TEAM_NAME[w]} WINS`)));
      const acc = h('div.tp-acc');
      const mvp = mvpPlayer({ ...mv, winner: w });
      if (mvp) acc.appendChild(h('div.a', h('div.k', 'MVP'), h('div.v', `${mvp.name} · ${mvp.score || 0} pts`)));
      if (me) acc.appendChild(h('div.a', h('div.k', 'Your score'), h('div.v', `${me.score || 0} pts · ${me.goals || 0} G · ${me.saves || 0} SV`)));
      if (mv.scores) acc.appendChild(h('div.a', h('div.k', 'Final'), h('div.v', `${mv.scores[0]} – ${mv.scores[1]}${mv.isOvertime ? ' (OT)' : ''}`)));
      banner.appendChild(acc);
      p.appendChild(banner);
      const sb = buildScoreboard({ ...mv, winner: w, mvpId: mvp ? mvp.carId : mv.mvpId }, { playerCarId: pid, showMvp: true, showWinner: true });
      const endWrap = h('div.tp-end', sb);
      p.appendChild(endWrap);
      const lanClient = game && game.lan === 'client';
      endWrap.appendChild(h('div.tp-nav',
        lanClient ? h('div.tp-note', { style: { margin: 0 } }, 'Waiting for the host to start a rematch…') : btn('Rematch', () => api.rematch(), { sub: 'Same teams' }),
        btn('Main menu', () => api.quitToMenu())));
      p.appendChild(footer());
    },
  };
  let playCfg = null;
  let lanCfg = null;
  let profState = { draft: '', error: '', ok: '', nameMsg: '' };  // Profile page: typed code + messages
  let mmActive = null;          // main menu: highlighted item key
  let mmSetActive = null;
  const lanDrafts = {};       // slot id / 'join' -> pasted code being typed
  const lanBusy = {};

  const STATUS = {
    connecting: ['Connecting…', ''], joining: ['Joining…', ''],
    connected: ['Connected', 'ok'], left: ['Left', 'bad'], error: ['Error', 'bad'],
  };

  function tip(head, steps) { return h('div.tp-tip', h('h4', head), h('ol', steps.map((x) => h('li', x)))); }

  function renderTip() {
    if (!tipEl) return;
    const [t, b] = TIPS[tipIdx % TIPS.length];
    tipEl.innerHTML = '';
    tipEl.append(h('h4', `Pro tip: ${t}`), h('p', b),
      h('div.dots', TIPS.map((_, i) => h('i' + (i === tipIdx % TIPS.length ? '.on' : '')))));
  }

  function padDiagram(pad) {
    const A = (code) => esc(actionFor(pad, code));
    const lbl = (x, y, anchor, key, act, lx, ly) => `<line x1="${lx}" y1="${ly}" x2="${anchor === 'end' ? x + 6 : x - 6}" y2="${y - 4}" stroke="rgba(160,190,255,.45)" stroke-width="1"/>`
      + `<text x="${x}" y="${y}" text-anchor="${anchor}"><tspan fill="#ffc94a" font-weight="700">${key}</tspan> ${act}</text>`;
    const svg = `<svg class="tp-pad" viewBox="0 0 640 230" style="font-family:var(--f)">
<path d="M230 70 C250 60 390 60 410 70 C450 78 480 150 476 190 C472 222 444 226 426 204 L396 168 L244 168 L214 204 C196 226 168 222 164 190 C160 150 190 78 230 70 Z" fill="rgba(255,255,255,0.06)" stroke="rgba(255,255,255,0.5)" stroke-width="2"/>
<rect x="222" y="50" width="52" height="11" rx="5" fill="rgba(47,123,255,.55)"/><rect x="366" y="50" width="52" height="11" rx="5" fill="rgba(47,123,255,.55)"/>
<circle cx="250" cy="105" r="16" fill="rgba(0,0,0,.35)" stroke="#9fb7ff" stroke-width="2"/>
<circle cx="360" cy="142" r="15" fill="rgba(0,0,0,.35)" stroke="#9fb7ff" stroke-width="2"/>
<path d="M277 136 h8 v-8 h8 v8 h8 v8 h-8 v8 h-8 v-8 h-8z" fill="rgba(255,255,255,.4)"/>
<circle cx="303" cy="96" r="4" fill="rgba(255,255,255,.45)"/><circle cx="337" cy="96" r="4" fill="rgba(255,255,255,.45)"/>
<circle cx="398" cy="123" r="9" fill="#3ec46d"/><circle cx="416" cy="105" r="9" fill="#e04848"/><circle cx="380" cy="105" r="9" fill="#3f86ff"/><circle cx="398" cy="87" r="9" fill="#f0c419"/>
<g font-size="10" font-weight="800" fill="#08101e" text-anchor="middle"><text x="398" y="127">A</text><text x="416" y="109">B</text><text x="380" y="109">X</text><text x="398" y="91">Y</text></g>
<g font-size="14" fill="#e8eeff">
 ${lbl(150, 34, 'end', 'LB', A('b4'), 240, 50)}
 ${lbl(150, 58, 'end', 'LT', A('b6'), 226, 58)}
 ${lbl(150, 108, 'end', 'L-STICK', 'Steer / air', 234, 105)}
 ${lbl(150, 150, 'end', 'D-PAD ↑', A('b12'), 277, 140)}
 ${lbl(150, 192, 'end', 'VIEW', A('b8'), 300, 98)}
 ${lbl(490, 34, 'start', 'RB', A('b5'), 400, 50)}
 ${lbl(490, 58, 'start', 'RT', A('b7'), 414, 58)}
 ${lbl(490, 86, 'start', 'Y', A('b3'), 407, 85)}
 ${lbl(490, 108, 'start', 'B', A('b1'), 425, 105)}
 ${lbl(490, 130, 'start', 'A', A('b0'), 407, 125)}
 ${lbl(490, 152, 'start', 'X', A('b2'), 380, 114)}
 ${lbl(490, 174, 'start', 'R-STICK', 'Free look', 375, 142)}
 ${lbl(490, 196, 'start', 'MENU', A('b9'), 340, 98)}
</g></svg>`;
    return h('div', { html: svg });
  }
  function actionFor(pad, code) {
    const a = Object.keys(pad).find((k) => pad[k] === code);
    return a ? (ACTION_LABELS[a] || a).replace(/ \(.*\)$/, '').replace(' / free air roll', '').replace(' / brake', '') : '—';
  }

  // ------------------------------------------------------------------ settings tabs
  const TABS = [['camera', 'Camera'], ['controls', 'Controls'], ['bindings', 'Bindings'], ['graphics', 'Graphics'], ['audio', 'Audio']];
  const f0 = (v) => String(Math.round(v));
  const f2 = (v) => Number(v).toFixed(2);
  const f1 = (v) => Number(v).toFixed(1);
  const pct = (v) => `${Math.round(v * 100)}%`;
  const TAB_BUILDERS = {
    camera(b) {
      const c = settings.camera;
      b.append(h('div.tp-sect', 'Camera'),
        sliderRow('Field of view', c, 'fov', 60, 110, 1, (v) => `${Math.round(v)}°`),
        sliderRow('Distance', c, 'distance', 100, 400, 10, f0),
        sliderRow('Height', c, 'height', 40, 200, 10, f0),
        sliderRow('Angle', c, 'angle', -15, 0, 1, (v) => `${Math.round(v)}°`),
        sliderRow('Stiffness', c, 'stiffness', 0, 1, 0.05, f2),
        sliderRow('Swivel speed', c, 'swivelSpeed', 1, 10, 0.5, f1),
        sliderRow('Transition speed', c, 'transitionSpeed', 1, 2, 0.1, f1),
        toggleRow('Camera shake', c, 'shake'),
        toggleRow('Invert swivel', c, 'invertSwivel'),
        h('div.tp-sect', 'Ball cam'),
        toggleRow('Ball cam on at spawn', c, 'ballCamDefault'),
        segRow('Ball cam button', c, 'ballCamMode', [['toggle', 'Toggle'], ['hold', 'Hold']]));
    },
    controls(b) {
      const c = settings.controls;
      if (c.deadzoneShape === 'circle') { c.deadzoneShape = 'radial'; changed(); } // older saves
      b.append(h('div.tp-sect', 'Layout'),
        presetRow(),
        h('div.tp-sect', 'Gamepad'),
        sliderRow('Controller deadzone', c, 'deadzone', 0, 0.5, 0.01, f2),
        segRow('Deadzone shape', c, 'deadzoneShape', [['cross', 'Cross'], ['radial', 'Circle']]),
        sliderRow('Dodge deadzone', c, 'dodgeDeadzone', 0.1, 0.9, 0.01, f2),
        sliderRow('Aerial sensitivity', c, 'aerialSensitivity', 0.5, 3, 0.05, f2),
        sliderRow('Steering sensitivity', c, 'steeringSensitivity', 0.5, 3, 0.05, f2),
        h('div.tp-sect', 'Keyboard & mouse'),
        toggleRow('W / S pitch in the air', c, 'kbThrottlePitch', 'Throttle keys also pitch the car while airborne'),
        toggleRow('Mouse air pitch / yaw', c, 'mouseAirPitch', 'Move the mouse to pitch and yaw in the air'),
        sliderRow('Mouse sensitivity', c, 'mouseSensitivity', 0.1, 3, 0.05, f2),
        segRow('A / D in the air', c, 'kbAirRollMode', [['yaw', 'Yaw'], ['roll', 'Roll']]),
        toggleRow('Invert pitch', c, 'invertPitch'));
    },
    bindings(b) {
      const kb = settings.bindings.kb, pad = settings.bindings.pad;
      const actions = [...Object.keys(DEFAULT_BINDINGS.kb)];
      for (const k of [...Object.keys(DEFAULT_BINDINGS.pad), ...Object.keys(kb), ...Object.keys(pad)]) if (!actions.includes(k)) actions.push(k);
      const grid = h('div.tp-bind', h('div.hd', 'Action'), h('div.hd', 'Keyboard / mouse'), h('div.hd', 'Gamepad'));
      for (const a of actions) {
        grid.appendChild(h('div.an', ACTION_LABELS[a] || a));
        grid.appendChild(bindCell(a, 'kb', a in kb ? keyList(kb[a]) : null));
        grid.appendChild(bindCell(a, 'pad', a in pad ? padName(pad[a]) : null));
      }
      b.append(h('div.tp-sect', 'Layout'), presetRow(), h('div.tp-sect', 'Click a binding, then press the new key / button'), grid);
    },
    graphics(b) {
      const g = settings.graphics;
      b.append(h('div.tp-sect', 'Quality'),
        segRow('Quality preset', g, 'quality', [['low', 'Low'], ['medium', 'Medium'], ['high', 'High'], ['ultra', 'Ultra']], 'Shadows, particles, post-processing, crowd'),
        sliderRow('Render scale', g, 'renderScale', 0.5, 1.5, 0.05, pct),
        toggleRow('Motion blur', g, 'motionBlur'),
        toggleRow('Grass', g, 'grass', '3D grass blades on the pitch. Turn off for more FPS on slower computers'),
        h('div.tp-sect', 'Interface'),
        toggleRow('Nameplates', g, 'nameplates', 'Player names above cars'),
        toggleRow('Show FPS', g, 'showFps'));
    },
    audio(b) {
      const a = settings.audio;
      b.append(h('div.tp-sect', 'Volume'),
        sliderRow('Master', a, 'master', 0, 1, 0.01, pct),
        sliderRow('Effects', a, 'sfx', 0, 1, 0.01, pct),
        sliderRow('Crowd', a, 'crowd', 0, 1, 0.01, pct));
    },
  };

  function resetTab(tab) {
    if (tab === 'bindings') {
      for (const dev of ['kb', 'pad']) {
        for (const k of Object.keys(DEFAULT_BINDINGS[dev])) settings.bindings[dev][k] = clone(DEFAULT_BINDINGS[dev][k]);
      }
    } else {
      const src = DEFAULT_SETTINGS[tab];
      if (src) for (const k of Object.keys(src)) settings[tab][k] = clone(src[k]);
    }
    changed();
    refresh();
  }

  // ------------------------------------------------------------------ rebinding
  function bindCell(action, device, label) {
    if (label === null) return h('button.tp-bindbtn.na', { type: 'button', disabled: true }, '—');
    return h('button.tp-bindbtn', {
      type: 'button', 'data-nav': '', 'data-key': `bind:${device}:${action}`, title: 'Click to rebind',
      onclick: (e) => { e.preventDefault(); startRebind(action, device); },
    }, label);
  }
  function startRebind(action, device) {
    const inp = input();
    if (!inp || !inp.startRebind) return;
    rebinding = { action, device };
    const prevBinding = clone(settings.bindings[device][action] ?? (device === 'kb' ? [] : ''));
    const cancelBtn = h('button.tp-btn', { type: 'button', 'data-nav': '', 'data-key': 'rb-cancel' }, h('span', 'Cancel'));
    // cancel on press (not click) so the input module never sees this mouse press as the new binding
    const stop = (e) => { e.preventDefault(); e.stopPropagation(); cancelRebind(); };
    cancelBtn.addEventListener('pointerdown', stop);
    cancelBtn.addEventListener('mousedown', stop);
    cancelBtn.addEventListener('click', (e) => { e.preventDefault(); e.stopPropagation(); cancelRebind(); });
    modalKind = 'rebind';
    modal = h('div.tp-modal', h('div.box',
      h('div.t1', `Rebind · ${device === 'kb' ? 'Keyboard / mouse' : 'Gamepad'}`),
      h('div.t2', ACTION_LABELS[action] || action),
      h('div.t3', device === 'kb' ? 'Press a key or mouse button…' : 'Press a button or move a stick…'),
      h('div', { style: { marginTop: 'calc(var(--u) * 1.4)', fontSize: 'calc(var(--u) * 1.6)', color: 'var(--dim)', letterSpacing: '.1em' } }, 'ESC TO CANCEL'),
      cancelBtn));
    el.appendChild(modal);
    nav.pageChanged();
    try {
      inp.startRebind(action, device, (res) => {
        if (!rebinding || rebinding.action !== action || rebinding.device !== device) return;
        rebindEndT = performance.now();
        const code = applyRebindResult(action, device, res);
        closeModal();
        changed();
        refresh();
        const conflicts = code ? findConflicts(action, device, code) : [];
        if (conflicts.length) showConflict(action, device, code, prevBinding, conflicts);
      });
    } catch (err) {
      closeModal();
      console.warn('[ui] rebind failed', err);
    }
  }
  // The input module normally writes settings.bindings itself; if it only reports the new code, store it here.
  function applyRebindResult(action, device, res) {
    let code = res;
    if (res && typeof res === 'object') code = res.code ?? res.binding ?? res.value ?? null;
    if (code === null || code === undefined || code === false || code === true || code === '' || typeof code !== 'string') return null;
    if (device === 'kb') {
      const cur = settings.bindings.kb[action];
      if (!(Array.isArray(cur) ? cur.includes(code) : cur === code)) settings.bindings.kb[action] = [code];
    } else if (settings.bindings.pad[action] !== code) settings.bindings.pad[action] = code;
    return code;
  }
  // ---- binding conflicts: the same key / button on two actions
  function findConflicts(action, device, code) {
    const map = settings.bindings[device] || {};
    return Object.keys(map).filter((a) => a !== action && (Array.isArray(map[a]) ? map[a].includes(code) : map[a] === code));
  }
  function showConflict(action, device, code, prev, others) {
    const map = settings.bindings[device];
    const name = device === 'kb' ? keyName(code) : padName(code);
    const prevList = device === 'kb' ? (Array.isArray(prev) ? prev : [prev]).filter((c) => c && c !== code) : (prev && prev !== code ? prev : '');
    const hasPrev = device === 'kb' ? prevList.length > 0 : !!prevList;
    const done = () => { rebindEndT = performance.now(); closeModal(); changed(); refresh(); };
    const swap = () => {
      for (const a of others) {
        if (device === 'kb') {
          const rest = (map[a] || []).filter((c) => c !== code);
          map[a] = [...rest, ...prevList.filter((c) => !rest.includes(c))];
        } else map[a] = prevList;
      }
      done();
    };
    const clearOther = () => {
      for (const a of others) {
        if (device === 'kb') map[a] = (map[a] || []).filter((c) => c !== code);
        else map[a] = '';
      }
      done();
    };
    const label = (a) => ACTION_LABELS[a] || a;
    const prevName = hasPrev ? (device === 'kb' ? keyList(prevList) : padName(prevList)) : '';
    const b1 = hasPrev ? btn(`Swap (${prevName} → ${others.map(label).join(', ')})`, swap, { key: 'cf-swap' }) : null;
    const b2 = btn(`Unbind from ${others.length > 1 ? 'others' : label(others[0])}`, clearOther, { key: 'cf-clear' });
    const b3 = btn('Keep both', done, { key: 'cf-keep' });
    modalKind = 'conflict';
    modal = h('div.tp-modal', h('div.box',
      h('div.t1', 'Binding conflict'),
      h('div.t2', name),
      h('div.t3.static', `is now bound to ${label(action)} and also to ${others.map(label).join(', ')}`),
      h('div.row', b1, b2, b3)));
    modal._keep = done;
    el.appendChild(modal);
    nav.pageChanged();
  }
  function closeModal() {
    modalKind = null;
    rebinding = null;
    if (modal) { modal.remove(); modal = null; }
    nav.pageChanged();
  }
  function cancelRebind() {
    rebindEndT = performance.now();
    if (modalKind === 'conflict' && modal) { modal._keep(); return; }
    const inp = input();
    if (rebinding && inp && inp.cancelRebind) { try { inp.cancelRebind(); } catch (e) { /* ignore */ } }
    closeModal();
  }

  // ------------------------------------------------------------------ keyboard (Esc = back, arrows = navigate)
  function onKeyDown(e) {
    if (ctx === null) return;
    // the key that just finished / cancelled a rebind must not also navigate the menu
    if (performance.now() - rebindEndT < 200) { e.preventDefault(); return; }
    if (modal) {
      if (e.code === 'Escape' || e.key === 'Escape') { e.preventDefault(); e.stopImmediatePropagation(); cancelRebind(); return; }
      if (modalKind === 'conflict') nav.onKey(e);
      return; // everything else belongs to the rebind capture
    }
    const tgt = e.target;
    const typing = tgt && ((tgt.tagName === 'INPUT' && tgt.type === 'text') || tgt.tagName === 'TEXTAREA');
    if (e.code === 'Escape') {
      if (performance.now() - backHandledAt < 50) { e.preventDefault(); return; } // main already routed it via handleBack()
      if (typing) { e.preventDefault(); e.stopImmediatePropagation(); tgt.blur(); return; }
      // root of the pause menu: let the game's own pause toggle resume play
      if (ctx === 'pause' && stack.length <= 1) return;
      if (ctx === 'end') { e.stopImmediatePropagation(); return; }
      e.preventDefault(); e.stopImmediatePropagation();
      back(false);
      return;
    }
    if (typing) return;
    nav.onKey(e);
  }
  addEventListener('keydown', onKeyDown, true);

  // ------------------------------------------------------------------ public
  return {
    el,
    showMain() { playCfg = null; open('main', 'main'); },
    showPause() { open('pause', 'pause'); },
    showLan() { playCfg = null; open('main', 'main'); push('lan'); },
    // re-render if one of these pages is on top (LAN session updates); keeps typed codes
    refreshIf(names) { if (ctx !== null && !modal && names.includes(stack[stack.length - 1])) refresh(); },
    showEnd(mv) { endView = mv; open('end', 'end'); },
    hide,
    // "Back" request routed from the game (Esc / pause action). Returns true when consumed
    // (rebind cancelled, sub-page popped, end screen) and false when the caller should act (e.g. resume).
    handleBack() {
      if (ctx === null) return false;
      backHandledAt = performance.now();
      if (modal) { cancelRebind(); return true; }
      if (stack.length > 1) { back(false); return true; }
      if (ctx === 'end' || ctx === 'main') return true;
      backHandledAt = -1e9;
      return false;
    },
    isOpen() { return ctx !== null; },
    context() { return ctx; },
    update(dt) {
      if (ctx === null) return;
      if (tipEl) { tipT += dt; if (tipT > 7) { tipT = 0; tipIdx++; renderTip(); } }
      if (!modal || modalKind === 'conflict') nav.pollGamepad(dt);
    },
    dispose() { removeEventListener('keydown', onKeyDown, true); hide(); },
  };
}
