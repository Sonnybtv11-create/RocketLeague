// TURBO PITCH — modifier codes.
// Typed into the Play (bots) lobby or the LAN host lobby before a match. They are written like
// Rocket League's training-pack codes: 16 hexadecimal characters in four groups, e.g. A503-264B-E09A-0F2E,
// or a short word code (letters and digits, e.g. JEEP). Profile reward codes (game/profile.js) use the
// same format.
// The accepted codes travel with the match config as cfg.modifiers (array of codes) and each code's
// apply(cfg) runs when the match is set up (newSession), so a modifier can change anything the config
// controls.
//
// To add one, put an entry in MODIFIERS:
//   'A503-264B-E09A-0F2E': { name: 'Moon ball', description: 'Low gravity for the ball', apply(cfg) { ... } },

export const MODIFIERS = {};

export const CODE_EXAMPLE = 'A503-264B-E09A-0F2E';

// Normalise what was typed: upper case, letters and digits only. A code made only of hex digits gets
// a dash every 4 characters (training-pack style); a word code (any other letter) is left as typed.
export function formatCode(raw) {
  const s = String(raw || '').toUpperCase().replace(/[^0-9A-Z]/g, '').slice(0, 16);
  return /^[0-9A-F]+$/.test(s) && s.length > 4 ? s.replace(/(.{4})(?=.)/g, '$1-') : s;
}

export const isComplete = (code) => /^[0-9A-F]{4}(-[0-9A-F]{4}){3}$/.test(code) || /^[0-9A-Z]{3,12}$/.test(code);
export const lookupCode = (code) => MODIFIERS[code] || null;

// -> { ok, code, modifier } or { ok: false, code, error }
export function checkCode(raw, already = []) {
  const code = formatCode(raw);
  if (!code) return { ok: false, code, error: 'Type a code first.' };
  if (!isComplete(code)) return { ok: false, code, error: `That isn’t a code. Codes look like ${CODE_EXAMPLE}.` };
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
