// TURBO PITCH — scoreboard table (UI agent). Used by the in-match Tab overlay and the end-of-match screen.
import { h, TEAM_NAME } from './dom.js';

export const MVP_SVG = `<svg viewBox="0 0 32 32" class="mvp"><defs><radialGradient id="tpMvpG" cx="40%" cy="35%" r="70%"><stop offset="0" stop-color="#fff7c0"/><stop offset=".55" stop-color="#ffc94a"/><stop offset="1" stop-color="#b57a00"/></radialGradient></defs><circle cx="16" cy="16" r="14.5" fill="url(#tpMvpG)" stroke="#5a3c00" stroke-width="1.4"/><path d="M16 6.2l2.9 6.1 6.6.8-4.9 4.6 1.3 6.6L16 21l-5.9 3.3 1.3-6.6-4.9-4.6 6.6-.8z" fill="#5a3c00"/></svg>`;

const COLS = [
  ['score', 'SCORE'], ['goals', 'GOALS'], ['assists', 'ASSISTS'], ['saves', 'SAVES'], ['shots', 'SHOTS'], ['demos', 'DEMOS'],
];

// Stable sort: score desc, then goals, then name
function sortPlayers(list) {
  return [...list].sort((a, b) => (b.score || 0) - (a.score || 0) || (b.goals || 0) - (a.goals || 0) || String(a.name).localeCompare(String(b.name)));
}

export function scoreboardKey(mv, playerCarId) {
  if (!mv) return '';
  const p = (mv.players || []).map((x) => `${x.carId}:${x.name}:${x.team}:${x.score}:${x.goals}:${x.assists}:${x.saves}:${x.shots}:${x.demos}`).join('|');
  return `${mv.scores && mv.scores.join(',')}#${mv.mvpId}#${mv.winner}#${playerCarId}#${p}`;
}

// Build a scoreboard element for a MatchView.
// opts: { playerCarId, showMvp, showWinner, carsFallback (CarView list when players[] is empty) }
export function buildScoreboard(mv, opts = {}) {
  const wrap = h('div.tp-sbwrap');
  let players = (mv && mv.players) || [];
  if (!players.length && opts.carsFallback) {
    players = opts.carsFallback.map((c) => ({ carId: c.id, name: c.name, team: c.team, isBot: c.isBot, score: 0, goals: 0, assists: 0, saves: 0, shots: 0, demos: 0 }));
  }
  const grid = `calc(var(--u) * 5) minmax(0, 1fr) repeat(${COLS.length}, calc(var(--u) * 8.4))`;
  for (const team of [0, 1]) {
    const teamPlayers = sortPlayers(players.filter((p) => p.team === team));
    const score = mv && mv.scores ? mv.scores[team] : 0;
    const isWinner = opts.showWinner && mv && mv.winner === team;
    const sec = h('div.tp-sb-team.t' + team);
    const hd = h('div.tp-sb-hd', { style: { gridTemplateColumns: grid } });
    hd.appendChild(h('div.tn', { style: { gridColumn: '1 / 3', position: 'relative' } },
      isWinner ? h('span.win', 'WINNER') : null,
      h('span.sc', String(score)), h('span', TEAM_NAME[team])));
    for (const [, label] of COLS) hd.appendChild(h('div.ch', label));
    sec.appendChild(hd);
    if (!teamPlayers.length) {
      sec.appendChild(h('div.tp-sb-row', { style: { gridTemplateColumns: grid, opacity: 0.5 } }, h('div'), h('div.pn', '—')));
    }
    for (const p of teamPlayers) {
      const me = p.carId === opts.playerCarId;
      const row = h('div.tp-sb-row' + (me ? '.me' : ''), { style: { gridTemplateColumns: grid } });
      const initials = String(p.name || '?').slice(0, 2).toUpperCase();
      row.appendChild(h('div.av', initials));
      const pn = h('div.pn', h('span', p.name || 'Player'));
      if (p.isBot) pn.appendChild(h('span.bot', 'BOT'));
      if (opts.showMvp && mv && mv.mvpId === p.carId) pn.insertAdjacentHTML('beforeend', MVP_SVG);
      row.appendChild(pn);
      for (const [k] of COLS) row.appendChild(h('div.st', String(p[k] || 0)));
      sec.appendChild(row);
    }
    wrap.appendChild(sec);
  }
  return wrap;
}

export function mvpPlayer(mv) {
  if (!mv || !mv.players) return null;
  let p = mv.players.find((x) => x.carId === mv.mvpId);
  if (!p) {
    // fallback: best score on the winning team (RL's rule), else overall best
    const pool = mv.winner === 0 || mv.winner === 1 ? mv.players.filter((x) => x.team === mv.winner) : mv.players;
    p = sortPlayers(pool)[0] || null;
  }
  return p;
}

