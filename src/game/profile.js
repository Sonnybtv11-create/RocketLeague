// TURBO PITCH — player profile (this device).
// The Profile page shows the player's name, their stats on this device (settings.js keeps those,
// updated at the end of every match) and a "Redeem code" box. A redeemed code unlocks items on
// this profile, such as a car skin. Redeemed codes and unlocked items are kept in localStorage
// under their own key, so resetting settings never removes them.
//
// No codes exist yet. To add one, put an entry in REWARD_CODES (same 16-character style as the
// modifier codes, e.g. 7F3A-0C12-9B44-E5D1):
//   '7F3A-0C12-9B44-E5D1': {
//     name: 'Gold paint',
//     description: 'Unlocks the gold paint finish',
//     items: [{ type: 'skin', id: 'gold', name: 'Gold' }],
//   },
// Each item lands in profile.items (one entry per type + id). Item types the game doesn't use yet
// are still kept, so a code can be added before the item it unlocks is built.

import { formatCode, isComplete, CODE_EXAMPLE } from './modifiers.js';

export const REWARD_CODES = {};

const KEY = 'turbopitch.profile.v1';
export const DEFAULT_PROFILE = { redeemed: [], items: [] };
export const NAME_MAX = 16;
export const REWARD_CODE_EXAMPLE = CODE_EXAMPLE;

export const formatRewardCode = formatCode;
export const lookupReward = (code) => REWARD_CODES[code] || null;

// Player names: letters, digits, space, dot, dash, underscore; 16 characters at most.
export function cleanName(raw) {
  return String(raw || '').replace(/[^\w .\-]/g, '').replace(/\s+/g, ' ').trim().slice(0, NAME_MAX);
}

export function loadProfile() {
  let raw = null;
  try { raw = JSON.parse(localStorage.getItem(KEY) || 'null'); } catch (e) { raw = null; }
  return {
    redeemed: Array.isArray(raw && raw.redeemed) ? raw.redeemed.filter((c) => typeof c === 'string') : [],
    items: Array.isArray(raw && raw.items) ? raw.items.filter((it) => it && it.type && it.id) : [],
  };
}

export function saveProfile(profile) {
  try { localStorage.setItem(KEY, JSON.stringify(profile)); return true; } catch (e) { return false; }
}

export const hasItem = (profile, type, id) => profile.items.some((it) => it.type === type && it.id === id);
export const itemsOfType = (profile, type) => profile.items.filter((it) => it.type === type);

// Check a typed code against this profile -> { ok, code, reward } or { ok: false, code, error }
export function checkRewardCode(raw, profile) {
  const code = formatRewardCode(raw);
  if (!code) return { ok: false, code, error: 'Type a code first.' };
  if (!isComplete(code)) return { ok: false, code, error: `Codes are 16 characters, like ${REWARD_CODE_EXAMPLE}.` };
  if (profile.redeemed.includes(code)) return { ok: false, code, error: 'You’ve already redeemed that code.' };
  const reward = lookupReward(code);
  if (!reward) return { ok: false, code, error: 'Code not recognised.' };
  return { ok: true, code, reward };
}

// Redeem a code: records it and adds its items to the profile. Returns checkRewardCode's result
// plus `added` (the items that were new). Does not save; the caller saves.
export function redeemCode(raw, profile) {
  const r = checkRewardCode(raw, profile);
  if (!r.ok) return r;
  profile.redeemed.push(r.code);
  const added = [];
  for (const it of r.reward.items || []) {
    if (!it || !it.type || !it.id || hasItem(profile, it.type, it.id)) continue;
    const item = { type: String(it.type), id: String(it.id), name: String(it.name || it.id), code: r.code };
    profile.items.push(item);
    added.push(item);
  }
  return { ...r, added };
}

// Level and rank shown on the main menu and the Profile page (from lifetime stats).
const RANKS = [[50, 'Legend'], [40, 'Master'], [30, 'Expert'], [20, 'Veteran'], [10, 'Pro'], [5, 'Semi-Pro'], [0, 'Rookie']];
export function levelInfo(st = {}) {
  const xp = (st.matches || 0) * 40 + (st.wins || 0) * 60 + (st.goals || 0) * 25 + (st.saves || 0) * 15 + (st.assists || 0) * 15;
  const level = 1 + Math.floor(Math.sqrt(xp / 30));
  const next = 30 * level * level;           // xp where the next level starts
  const prev = 30 * (level - 1) * (level - 1);
  return { xp, level, rank: RANKS.find(([lv]) => level >= lv)[1], progress: next > prev ? (xp - prev) / (next - prev) : 0, toNext: Math.max(0, next - xp) };
}
