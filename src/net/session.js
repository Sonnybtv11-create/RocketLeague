// LAN multiplayer sessions (lead-owned). The host computer runs the simulation, match and
// bots; joiners send their controls every tick and render the host's snapshots.
import { Peer } from './rtc.js';
import { encodeFrame, decodeFrame, packControls, unpackControls } from './codec.js';
import { interpolateFrames } from '../game/view.js';
import { Vec3 } from '../sim/math.js';
import { makeControls } from '../contracts.js';

const MAX_QUEUE = 10;       // host-side input queue per joiner (ticks)
const RENDER_DELAY = 5;     // joiner renders this many ticks behind the newest snapshot (~42 ms)

export const NET_PROTOCOL = 1;

// events travel as JSON: {x,y,z} objects come back as Vec3 so renderers can call .clone() / .dist()
const isVec = (v) => v && typeof v === 'object' && !Array.isArray(v) && typeof v.x === 'number' && typeof v.y === 'number' && typeof v.z === 'number' && Object.keys(v).length === 3;

// ------------------------------------------------------------------- host
export function createNetHost({ onChange, onLeave }) {
  const slots = [];
  let nextId = 1;
  const changed = () => onChange && onChange();

  function autoTeam() {
    // host is on blue; alternate joiners orange / blue
    const n = slots.filter((s) => s.status !== 'left').length;
    return n % 2 === 0 ? 1 : 0;
  }
  function wire(s) {
    s.peer.onOpen = () => { s.status = 'connected'; changed(); host.sendLobby(); };
    s.peer.onMessage = (m) => {
      if (m.t === 'hello') {
        s.name = String(m.name || 'Player').slice(0, 16);
        s.bodyId = m.bodyId || 'vector'; s.accent = m.accent || '#e8e8e8';
        if (m.v !== NET_PROTOCOL) { s.peer.send({ t: 'bye', reason: 'Different game versions — use the same TURBO PITCH file on both computers.' }); }
        changed(); host.sendLobby();
      } else if (m.t === 'in' && Array.isArray(m.k)) {
        for (const k of m.k) s.queue.push(k);
        while (s.queue.length > MAX_QUEUE) s.queue.shift();
      }
    };
    s.peer.onClose = () => {
      if (s.status === 'left') return;
      const was = s.status;
      s.status = 'left';
      if (was === 'connected' && onLeave) onLeave(s);
      changed();
      host.sendLobby();
    };
  }

  const host = {
    role: 'host',
    slots,
    lobbyInfo: null, // {mode text} shown to joiners
    async invite() {
      const s = { id: nextId++, peer: new Peer('host'), status: 'creating', team: autoTeam(), name: `Player ${nextId}`,
        bodyId: 'vector', accent: '#e8e8e8', carId: -1, queue: [], last: makeControls(), code: '' };
      slots.push(s);
      wire(s);
      changed();
      try { s.code = await s.peer.createInvite(); s.status = 'waiting'; } catch (e) { s.status = 'error'; s.error = e.message; }
      changed();
      return s;
    },
    async acceptReply(id, code) {
      const s = slots.find((x) => x.id === id);
      if (!s) return;
      try { await s.peer.acceptReply(code); s.status = 'connecting'; s.error = ''; } catch (e) { s.error = e.message; }
      changed();
    },
    remove(id) {
      const i = slots.findIndex((x) => x.id === id);
      if (i < 0) return;
      const s = slots[i];
      if (s.status === 'connected') s.peer.send({ t: 'bye', reason: 'The host removed you from the game.' });
      s.status = 'left';
      s.peer.close();
      slots.splice(i, 1);
      changed();
      host.sendLobby();
    },
    setTeam(id, team) { const s = slots.find((x) => x.id === id); if (s) { s.team = team; changed(); host.sendLobby(); } },
    connected() { return slots.filter((s) => s.status === 'connected'); },
    sendLobby(extra = {}) {
      const players = [{ name: extra.hostName || host.hostName || 'Host', team: host.hostTeam ?? 0, host: true }]
        .concat(host.connected().map((s) => ({ id: s.id, name: s.name, team: s.team })));
      for (const s of host.connected()) s.peer.send({ t: 'lobby', you: s.id, players, info: host.lobbyInfo });
    },
    broadcast(msg) { const str = JSON.stringify(msg); for (const s of host.connected()) if (s.peer.rel && s.peer.rel.readyState === 'open') s.peer.rel.send(str); },
    sendFrame(frame, hint) {
      const conn = host.connected();
      if (!conn.length) return;
      const buf = encodeFrame(frame, hint);
      for (const s of conn) s.peer.sendFast(buf);
    },
    // next control state for a joiner's car (one queued tick per physics tick; holds the last state if none arrived)
    takeControls(carId) {
      const s = slots.find((x) => x.carId === carId && x.status === 'connected');
      if (!s) return null;
      if (s.queue.length) unpackControls(s.queue.shift(), s.last);
      return { ...s.last };
    },
    close(reason = 'The host left the game.') {
      for (const s of slots) { if (s.status === 'connected') s.peer.send({ t: 'bye', reason }); s.status = 'left'; s.peer.close(); }
      slots.length = 0;
    },
  };
  return host;
}

// ------------------------------------------------------------------- joiner
export function createNetClient({ onChange, onStart, onEvents, onLeave }) {
  const peer = new Peer('join');
  let roster = null, padsStatic = null;
  let snaps = [];            // live frames, ascending tick
  let lastRecv = 0;
  let replay = null, replayAt = -1e9;
  let pendingInputs = [];
  const client = {
    role: 'client',
    peer,
    status: 'idle',           // idle | creating | waiting | connected | playing | closed
    error: '', reason: '',
    lobby: null,              // {you, players, info}
    matchView: null,
    you: -1,                  // my car id once a match starts
    replyCode: '',
    async join(code, profile) {
      client.status = 'creating'; client.error = ''; onChange && onChange();
      try {
        client.replyCode = await peer.acceptInvite(code);
        client.status = 'waiting';
      } catch (e) { client.status = 'idle'; client.error = e.message; }
      onChange && onChange();
      peer.onOpen = () => {
        client.status = 'connected';
        peer.send({ t: 'hello', v: NET_PROTOCOL, name: profile.name, bodyId: profile.bodyId, accent: profile.accent });
        onChange && onChange();
      };
      return client.replyCode;
    },
    // called by main after building the local copy of the world for a match
    setStatic(r, pads) { roster = r; padsStatic = pads; snaps = []; replay = null; },
    sendInputs(controlsList) {
      for (const c of controlsList) pendingInputs.push(packControls(c));
      if (pendingInputs.length) { peer.send({ t: 'in', k: pendingInputs }); pendingInputs = []; }
    },
    // interpolated view for rendering (or null before the first snapshot)
    buildView(now) {
      if (replay && now - replayAt < 400) {
        const v = interpolateFrames(replay.frame, replay.frame, 1);
        v.isReplay = true;
        return { view: v, hint: replay.hint };
      }
      if (!snaps.length) return null;
      const last = snaps[snaps.length - 1];
      const est = last.tick + Math.min(((now - lastRecv) / 1000) * 120, 3);
      const rt = est - RENDER_DELAY;
      let a = snaps[0], b = snaps[0];
      for (let i = 0; i < snaps.length; i++) {
        if (snaps[i].tick <= rt) a = snaps[i];
        if (snaps[i].tick >= rt) { b = snaps[i]; break; }
        b = snaps[i];
      }
      const span = b.tick - a.tick;
      const t = span > 0 ? Math.min(Math.max((rt - a.tick) / span, 0), 1) : 1;
      return { view: interpolateFrames(a, b, t), hint: null };
    },
    close() { try { peer.send({ t: 'bye' }); } catch (e) { /* ignore */ } peer.close(); client.status = 'closed'; },
  };
  peer.onMessage = (m) => {
    if (m.t === 'lobby') { client.lobby = m; onChange && onChange(); }
    else if (m.t === 'start') { client.you = m.you; client.status = 'playing'; snaps = []; replay = null; onStart && onStart(m); }
    else if (m.t === 'mv') client.matchView = m.v;
    else if (m.t === 'ev') {
      for (const e of m.e) for (const k in e) if (isVec(e[k])) e[k] = new Vec3(e[k].x, e[k].y, e[k].z);
      onEvents && onEvents(m.e);
    } else if (m.t === 'bye') { client.reason = m.reason || 'The host ended the game.'; peer.close(); }
  };
  peer.onFast = (buf) => {
    if (!roster) return;
    const { frame, hint } = decodeFrame(buf, roster, padsStatic);
    const now = performance.now();
    if (hint) { replay = { frame, hint }; replayAt = now; return; }
    if (snaps.length && frame.tick <= snaps[snaps.length - 1].tick) {
      if (frame.tick < snaps[snaps.length - 1].tick - 240) snaps = []; // host restarted (new match / kickoff reset)
      else return;
    }
    snaps.push(frame);
    if (snaps.length > 40) snaps.shift();
    lastRecv = now;
  };
  peer.onClose = () => {
    if (client.status === 'closed') return;
    const wasPlaying = client.status === 'playing' || client.status === 'connected';
    client.status = 'closed';
    if (!client.reason) client.reason = wasPlaying ? 'Lost the connection to the host.' : 'The connection failed. Both computers must be on the same network.';
    onLeave && onLeave(client.reason);
    onChange && onChange();
  };
  return client;
}
