// TURBO PITCH — modifier codes.
// Typed into the Play (bots) lobby or the LAN host lobby before a match. They are written like
// Rocket League's training-pack codes: 16 hexadecimal characters in four groups, e.g. A503-264B-E09A-0F2E.
// The accepted codes travel with the match config as cfg.modifiers (array of codes) and each code's
// apply(cfg) runs when the match is set up (newSession), so a modifier can change anything the config
// controls.
//
// No codes exist yet. To add one, put an entry in MODIFIERS:
//   'A503-264B-E09A-0F2E': { name: 'Moon ball', description: 'Low gravity for the ball', apply(cfg) { ... } },

export const MODIFIERS = {};

const HEX = /[^0-9A-F]/g;
export const CODE_EXAMPLE = 'A503-264B-E09A-0F2E';

// Normalise what was typed: upper case, hex digits only (O -> 0 for convenience), dashes every 4 characters.
export function formatCode(raw) {
  const hex = String(raw || '').toUpperCase().replace(/O/g, '0').replace(HEX, '').slice(0, 16);
  return hex.replace(/(.{4})(?=.)/g, '$1-');
}

export const isComplete = (code) => /^[0-9A-F]{4}(-[0-9A-F]{4}){3}$/.test(code);
export const lookupCode = (code) => MODIFIERS[code] || null;

// -> { ok, code, modifier } or { ok: false, code, error }
export function checkCode(raw, already = []) {
  const code = formatCode(raw);
  if (!code) return { ok: false, code, error: 'Type a code first.' };
  if (!isComplete(code)) return { ok: false, code, error: `Codes are 16 characters, like ${CODE_EXAMPLE}.` };
  if (already.includes(code)) return { ok: false, code, error: 'That code is already added.' };
  const modifier = lookupCode(code);
  if (!modifier) return { ok: false, code, error: 'Code not recognised.' };
  return { ok: true, code, modifier };
}

// Codes from an older config that are still valid (codes can be removed from MODIFIERS over time).
export const validCodes = (codes) => (Array.isArray(codes) ? codes.filter((c) => lookupCode(c)) : []);

// Run every modifier on a match config (called once when the match is set up). Returns the config.
export function applyModifiers(cfg) {
  for (const code of validCodes(cfg.modifiers)) {
    const m = lookupCode(code);
    if (m.apply) m.apply(cfg);
  }
  return cfg;
}
