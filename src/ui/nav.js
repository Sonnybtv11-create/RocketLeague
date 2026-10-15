// TURBO PITCH — menu navigation (UI agent): keyboard arrows + Enter, and gamepad (d-pad / left stick to move,
// A to activate, B to go back, LB / RB to switch settings tabs, left / right to adjust sliders).
// Focus is spatial: the next element in the pressed direction among [data-nav] elements of the current page.

export function createNav({ getScope, onBack }) {
  let focused = null;
  let active = false;           // keyboard / gamepad navigation in use (mouse movement turns it off)
  let prev = null;              // previous gamepad button snapshot (null = re-arm on next poll)
  const held = {};              // direction -> seconds held (for auto-repeat)

  function candidates() {
    const scope = getScope();
    if (!scope) return [];
    return [...scope.querySelectorAll('[data-nav]')].filter((el) => !el.disabled && el.getClientRects().length > 0);
  }
  function clearFocus() {
    if (focused) {
      focused.classList.remove('tp-focus');
      const row = focused.closest('.tp-row');
      if (row) row.classList.remove('tp-focus-row');
    }
  }
  function setFocus(el) {
    clearFocus();
    focused = el;
    if (!el) return;
    el.classList.add('tp-focus');
    el.dispatchEvent(new CustomEvent('tp-navfocus', { bubbles: true }));
    const row = el.closest('.tp-row');
    if (row) row.classList.add('tp-focus-row');
    try { el.scrollIntoView({ block: 'nearest', inline: 'nearest' }); } catch (e) { /* old browsers */ }
  }
  function ensureFocus() {
    const scope = getScope();
    if (focused && scope && scope.contains(focused) && focused.getClientRects().length) return true;
    const list = candidates();
    setFocus(list[0] || null);
    return false;
  }
  function move(dx, dy) {
    active = true;
    if (!ensureFocus()) return;
    const list = candidates();
    const r0 = focused.getBoundingClientRect();
    const cx = r0.left + r0.width / 2, cy = r0.top + r0.height / 2;
    let best = null, bestScore = Infinity;
    for (const el of list) {
      if (el === focused) continue;
      const r = el.getBoundingClientRect();
      // distance from the focused element's edge in the travel direction
      const ex = dx > 0 ? r.left - r0.right : dx < 0 ? r0.left - r.right : 0;
      const ey = dy > 0 ? r.top - r0.bottom : dy < 0 ? r0.top - r.bottom : 0;
      const along = dx ? ex : ey;
      const ccx = r.left + r.width / 2, ccy = r.top + r.height / 2;
      const centreAlong = dx ? (ccx - cx) * dx : (ccy - cy) * dy;
      if (centreAlong <= 2 || along < -Math.min(r.width, r.height) * 0.5) continue;
      // perpendicular offset (0 when the spans overlap)
      const perp = dx
        ? Math.max(0, Math.max(r.top, r0.top) - Math.min(r.bottom, r0.bottom)) + Math.abs(ccy - cy) * 0.15
        : Math.max(0, Math.max(r.left, r0.left) - Math.min(r.right, r0.right)) + Math.abs(ccx - cx) * 0.15;
      const score = Math.max(0, along) + perp * 3;
      if (score < bestScore) { bestScore = score; best = el; }
    }
    if (best) setFocus(best);
  }
  function adjust(dir) {
    const r = focused;
    if (!r || r.type !== 'range') return false;
    if (dir > 0) r.stepUp(); else r.stepDown();
    r.dispatchEvent(new Event('input', { bubbles: true }));
    r.dispatchEvent(new Event('change', { bubbles: true }));
    return true;
  }
  function activate() {
    active = true;
    if (!ensureFocus()) return;
    const el = focused;
    if (el.tagName === 'INPUT' && (el.type === 'text')) { el.focus(); return; }
    if (el.type === 'range') return;
    el.click();
  }
  function switchTab(dir) {
    const scope = getScope();
    if (!scope) return;
    const tabs = [...scope.querySelectorAll('.tp-tab')];
    if (!tabs.length) return;
    const i = tabs.findIndex((t) => t.classList.contains('sel'));
    const n = tabs[(i + dir + tabs.length) % tabs.length];
    n && n.click();
  }

  addEventListener('mousemove', () => { if (active) { active = false; clearFocus(); } }, { passive: true });

  return {
    reset() { clearFocus(); focused = null; prev = null; },
    focusEl(el) { active = true; setFocus(el); },
    pageChanged() {
      focused = null;
      prev = null;
      if (active) ensureFocus();
    },
    focusKey() { return focused && focused.dataset ? focused.dataset.key : null; },
    restoreFocus(key) {
      if (!key) { if (active) ensureFocus(); return; }
      const scope = getScope();
      const el = scope && [...scope.querySelectorAll('[data-nav]')].find((x) => x.dataset.key === key);
      if (el && active) setFocus(el); else if (el) focused = el; else if (active) ensureFocus();
    },
    onKey(e) {
      const k = e.code;
      if (k === 'ArrowUp' || k === 'ArrowDown') { e.preventDefault(); move(0, k === 'ArrowDown' ? 1 : -1); }
      else if (k === 'ArrowLeft' || k === 'ArrowRight') {
        e.preventDefault();
        const d = k === 'ArrowRight' ? 1 : -1;
        active = true;
        if (!(focused && adjust(d))) move(d, 0);
      } else if ((k === 'Enter' || k === 'NumpadEnter') && active) { e.preventDefault(); activate(); }
    },
    pollGamepad(dt) {
      const pads = navigator.getGamepads ? navigator.getGamepads() : [];
      let gp = null;
      for (const p of pads || []) if (p && p.connected) { gp = p; break; }
      if (!gp) { prev = null; return; }
      const b = (i) => !!(gp.buttons[i] && (gp.buttons[i].pressed || gp.buttons[i].value > 0.6));
      const ax = gp.axes[0] || 0, ay = gp.axes[1] || 0;
      const state = {
        up: b(12) || ay < -0.55, down: b(13) || ay > 0.55, left: b(14) || ax < -0.55, right: b(15) || ax > 0.55,
        a: b(0), b: b(1), lb: b(4), rb: b(5),
      };
      if (!prev) { prev = state; for (const k of Object.keys(held)) held[k] = 0; return; }
      for (const dir of ['up', 'down', 'left', 'right']) {
        if (state[dir]) {
          const t0 = held[dir] || 0;
          const t1 = t0 + dt;
          held[dir] = t1;
          const fire = !prev[dir] || (t1 > 0.38 && Math.floor((t1 - 0.38) / 0.11) !== Math.floor((Math.max(t0, 0.38) - 0.38) / 0.11)) || (t0 <= 0.38 && t1 > 0.38);
          if (fire) {
            if (dir === 'up') move(0, -1);
            else if (dir === 'down') move(0, 1);
            else { active = true; const d = dir === 'right' ? 1 : -1; if (!(focused && adjust(d))) move(d, 0); }
          }
        } else held[dir] = 0;
      }
      if (state.a && !prev.a) activate();
      if (state.b && !prev.b) { active = true; onBack(); }
      if (state.lb && !prev.lb) switchTab(-1);
      if (state.rb && !prev.rb) switchTab(1);
      prev = state;
    },
  };
}
