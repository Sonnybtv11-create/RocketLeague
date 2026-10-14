// TURBO PITCH — UI DOM helpers (UI agent).
// Tiny element builder + key/button name prettifiers shared by the HUD and menus.

// h('div.cls1.cls2', {attrs/props/on*}, ...children)
export function h(tag, props, ...children) {
  const parts = tag.split('.');
  const el = document.createElement(parts[0] || 'div');
  if (parts.length > 1) el.className = parts.slice(1).join(' ');
  if (props && (typeof props !== 'object' || props instanceof Node || Array.isArray(props))) { children.unshift(props); props = null; }
  if (props) {
    for (const [k, v] of Object.entries(props)) {
      if (v === undefined || v === null || v === false) continue;
      if (k.startsWith('on') && typeof v === 'function') el.addEventListener(k.slice(2).toLowerCase(), v);
      else if (k === 'style' && typeof v === 'object') Object.assign(el.style, v);
      else if (k === 'html') el.innerHTML = v;
      else if (k === 'text') el.textContent = v;
      else if (k === 'dataset') Object.assign(el.dataset, v);
      else if (k in el && k !== 'list' && typeof v !== 'string') el[k] = v;
      else el.setAttribute(k, v === true ? '' : String(v));
    }
  }
  appendChildren(el, children);
  return el;
}

function appendChildren(el, children) {
  for (const c of children) {
    if (c === null || c === undefined || c === false) continue;
    if (Array.isArray(c)) appendChildren(el, c);
    else el.appendChild(c instanceof Node ? c : document.createTextNode(String(c)));
  }
}

// SVG element builder
const SVGNS = 'http://www.w3.org/2000/svg';
export function s(tag, attrs, ...children) {
  const el = document.createElementNS(SVGNS, tag);
  if (attrs) for (const [k, v] of Object.entries(attrs)) if (v !== undefined && v !== null) el.setAttribute(k, String(v));
  for (const c of children) if (c) el.appendChild(c instanceof Node ? c : document.createTextNode(String(c)));
  return el;
}

// Set text only when it changed (avoids layout work in per-frame HUD updates)
export function setText(el, txt) {
  txt = String(txt);
  if (el._t !== txt) { el._t = txt; el.textContent = txt; }
}
export function setClass(el, cls, on) {
  on = !!on;
  const k = '_c_' + cls;
  if (el[k] !== on) { el[k] = on; el.classList.toggle(cls, on); }
}
export function setShown(el, on) { setClass(el, 'tp-hidden', !on); }

export function esc(str) {
  return String(str).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

// ---- key / button names --------------------------------------------------
const KEY_NAMES = {
  Mouse0: 'LMB', Mouse1: 'MMB', Mouse2: 'RMB', Mouse3: 'Mouse 4', Mouse4: 'Mouse 5',
  ShiftLeft: 'L-Shift', ShiftRight: 'R-Shift', ControlLeft: 'L-Ctrl', ControlRight: 'R-Ctrl',
  AltLeft: 'L-Alt', AltRight: 'R-Alt', MetaLeft: 'L-Cmd', MetaRight: 'R-Cmd',
  ArrowUp: '↑', ArrowDown: '↓', ArrowLeft: '←', ArrowRight: '→',
  Space: 'Space', Escape: 'Esc', Enter: 'Enter', Tab: 'Tab', Backspace: 'Backspace', CapsLock: 'Caps',
  Backquote: '`', Minus: '-', Equal: '=', BracketLeft: '[', BracketRight: ']', Backslash: '\\',
  Semicolon: ';', Quote: "'", Comma: ',', Period: '.', Slash: '/',
  WheelUp: 'Wheel ↑', WheelDown: 'Wheel ↓',
};
export function keyName(code) {
  if (code === undefined || code === null || code === '') return '—';
  if (KEY_NAMES[code]) return KEY_NAMES[code];
  let m;
  if ((m = /^Key([A-Z])$/.exec(code))) return m[1];
  if ((m = /^Digit(\d)$/.exec(code))) return m[1];
  if ((m = /^Numpad(.+)$/.exec(code))) return 'Num ' + m[1];
  if ((m = /^Mouse(\d+)$/.exec(code))) return 'Mouse ' + (Number(m[1]) + 1);
  return code;
}
export function keyList(arr) {
  if (!arr) return '—';
  if (!Array.isArray(arr)) arr = [arr];
  return arr.length ? arr.map(keyName).join(' / ') : '—';
}

const PAD_BUTTONS = ['A', 'B', 'X', 'Y', 'LB', 'RB', 'LT', 'RT', 'View', 'Menu', 'L-Stick', 'R-Stick', 'D-Pad ↑', 'D-Pad ↓', 'D-Pad ←', 'D-Pad →', 'Home'];
const PAD_AXES = ['Left Stick X', 'Left Stick Y', 'Right Stick X', 'Right Stick Y'];
export function padName(code) {
  if (code === undefined || code === null || code === '') return '—';
  if (Array.isArray(code)) return code.map(padName).join(' / ');
  const str = String(code);
  let m;
  if ((m = /^b(\d+)$/.exec(str))) return PAD_BUTTONS[Number(m[1])] || 'Button ' + m[1];
  if ((m = /^([+-]?)a(\d+)([+-]?)$/.exec(str))) {
    const sign = m[1] || m[3];
    return (PAD_AXES[Number(m[2])] || 'Axis ' + m[2]) + (sign ? ' ' + sign : '');
  }
  return str;
}

export const TEAM_CSS = ['#2f7bff', '#ff8a1f'];
export const TEAM_NAME = ['BLUE', 'ORANGE'];

export function fmtClock(sec) {
  const s = Math.max(0, Math.ceil(sec - 1e-6));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
}
export function fmtOvertime(sec) {
  const s = Math.max(0, Math.floor(sec));
  return `+${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
}
