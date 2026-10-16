// LAN multiplayer sessions (lead-owned). The host computer runs the simulation, match and
// bots; joiners send their controls every tick and render the host's snapshots.
//
// Connecting: the host opens a room on the game's website under a 6-digit code (relay.js); a joiner
// opens the same room. Through the room the host first tries a direct WebRTC connection (fastest);
// if that doesn't open within P2P_WAIT_MS (school / office Wi-Fi often blocks it) the game traffic
// goes through the room instead. Either way each joiner gets a "link" with the same interface:
//   send(msg) JSON, sendFast(buf) snapshots, onMessage(msg), onFast(buf), onClose(), close(), mode.
import { Peer, webrtcSupported } from './rtc.js';
import { openRoom, checkServer, randomGameCode } from './relay.js';
import { encodeFrame, decodeFrame, packControls, unpackControls } from './codec.js';
import { interpolateFrames } from '../game/view.js';
import { Vec3 } from '../sim/math.js';
import { makeControls } from '../contracts.js';

const MAX_QUEUE = 12;          // host-side input queue per joiner (ticks)
const P2P_WAIT_MS = 4000;      // how long to try a direct connection before relaying through the website
const RELAY_SNAP_MS = 30;       // relayed snapshots ~33 Hz (one room message for every relayed joiner); direct ones 60 Hz
const RELAY_INPUT_MS = 30;     // relayed joiner inputs are batched (~33 Hz)
const RENDER_DELAY = { p2p: 5, relay: 10 }; // joiner renders this many ticks behind the newest snapshot
const JOIN_TIMEOUT_MS = 15000;

export const NET_PROTOCOL = 2;

// events travel as JSON: {x,y,z} objects come back as Vec3 so renderers can call .clone() / .dist()
const isVec = (v) => v && typeof v === 'object' && !Array.isArray(v) && typeof v.x === 'number' && typeof v.y === 'number' && typeof v.z === 'number' && Object.keys(v).length === 3;
// ?net=relay skips the direct attempt (testing)
const forceRelay = () => { try { return new URLSearchParams(location.search).get('net') === 'relay' || !webrtcSupported(); } catch (e) { return true; } };

// ------------------------------------------------------------------- host
export function createNetHost({ onChange, onLeave }) {
  const slots = [];
  let nextId = 1;
  let room = null;
  let lastRelayAt = -1e9;
  const changed = () => onChange && onChange();

  function autoTeam() {
    // host is on blue; alternate joiners orange / blue
    const n = slots.filter((s) => s.status !== 'left').length;
    return n % 2 === 0 ? 1 : 0;
  }
  function dropSlot(s, notify) {
    if (s.status === 'left') return;
    const was = s.status;
    s.status = 'left';
    if (s.peer) { s.peer.onClose = null; s.peer.close(); }
    const i = slots.indexOf(s); if (i >= 0) slots.splice(i, 1);
    if (was === 'connected' && notify && onLeave) onLeave(s);
    changed();
    host.sendLobby();
  }
  // a link that sends through the room to one joiner
  function relayLink(rid) {
    return {
      mode: 'relay', onMessage: null, onFast: null, onClose: null,
      send(msg) { if (room) room.send(rid + '|' + JSON.stringify(msg)); },
      sendFast() { /* snapshots go to the whole room at once (sendFrame) */ },
      close() { /* the joiner leaves the room itself */ },
    };
  }
  function useLink(s, link) {
    s.link = link;
    s.mode = link.mode;
    link.onMessage = (m) => {
      if (m.t === 'hello') {
        s.name = String(m.name || 'Player').slice(0, 16);
        s.bodyId = m.bodyId || 'vector'; s.accent = m.accent || '#e8e8e8';
        if (m.v !== NET_PROTOCOL) link.send({ t: 'bye', reason: 'Different game versions — reload the game page on both computers.' });
        s.status = 'connected';
        changed(); host.sendLobby();
      } else if (m.t === 'in' && Array.isArray(m.k)) {
        for (const k of m.k) s.queue.push(k);
        while (s.queue.length > MAX_QUEUE) s.queue.shift();
      } else if (m.t === 'bye') dropSlot(s, true);
    };
    link.onClose = () => dropSlot(s, true);
  }
  // pick the transport for a joiner and tell them
  function decide(s, mode) {
    if (s.decided || s.status === 'left') return;
    s.decided = true;
    clearTimeout(s.timer);
    if (room) room.send(s.rid + '|' + JSON.stringify({ t: '_use', mode }));
    if (mode === 'p2p') {
      const peer = s.peer;
      const link = {
        mode: 'p2p', onMessage: null, onFast: null, onClose: null,
        send: (msg) => peer.send(msg), sendFast: (buf) => peer.sendFast(buf), close: () => peer.close(),
      };
      peer.onMessage = (m) => link.onMessage && link.onMessage(m);
      peer.onClose = () => link.onClose && link.onClose();
      useLink(s, link);
    } else {
      if (s.peer) { s.peer.onClose = null; s.peer.close(); s.peer = null; }
      useLink(s, relayLink(s.rid));
    }
    s.status = 'joining'; // until their hello arrives
    changed();
  }
  // a joiner entered our code
  async function onPeerJoin(rid) {
    if (slots.some((x) => x.rid === rid)) return;
    const s = { id: nextId++, rid, peer: null, link: null, mode: '', decided: false, status: 'connecting', team: autoTeam(), name: 'Player',
      bodyId: 'vector', accent: '#e8e8e8', carId: -1, queue: [], last: makeControls(), timer: 0 };
    slots.push(s);
    changed();
    if (forceRelay()) { decide(s, 'relay'); return; }
    s.peer = new Peer('host');
    s.peer.onCandidate = (c) => room && room.send(rid + '|' + JSON.stringify({ t: '_rtc', c }));
    s.peer.onOpen = () => decide(s, 'p2p');
    s.timer = setTimeout(() => decide(s, s.peer && s.peer.open ? 'p2p' : 'relay'), P2P_WAIT_MS);
    try { room.send(rid + '|' + JSON.stringify({ t: '_rtc', sdp: await s.peer.makeOffer() })); } catch (e) { decide(s, 'relay'); }
  }
  function onRoomText(text) {
    const bar = text.indexOf('|');
    const from = text.slice(0, bar);
    let m;
    try { m = JSON.parse(text.slice(bar + 1)); } catch (e) { return; }
    if (from === '#') {
      if (m.t === 'peer-join') onPeerJoin(m.id);
      else if (m.t === 'peer-leave') {
        const s = slots.find((x) => x.rid === m.id);
        if (s && s.mode !== 'p2p') dropSlot(s, true); // direct links notice on their own
      }
      return;
    }
    const s = slots.find((x) => x.rid === from);
    if (!s) return;
    if (m.t === '_rtc') {
      if (!s.peer || s.decided) return;
      if (m.sdp) s.peer.takeAnswer(m.sdp).catch(() => decide(s, 'relay'));
      if (m.c) s.peer.addCandidate(m.c);
    } else if (s.link && s.link.mode === 'relay' && s.link.onMessage) s.link.onMessage(m);
  }

  const host = {
    role: 'host',
    slots,
    lobbyInfo: null,       // mode text shown to joiners
    code: '',              // 6-digit game code
    relayStatus: 'off',    // off | opening | online | offline
    relayError: '',
    closed: false,
    // get a 6-digit game code: open a room for it on the website (retries on the rare clash)
    async openLobby() {
      if (room && !room.closed) return host.code;
      host.relayStatus = 'opening'; host.relayError = ''; changed();
      try { await checkServer(); } catch (e) { host.relayStatus = 'offline'; host.relayError = e.message; changed(); return ''; }
      for (let attempt = 0; attempt < 6; attempt++) {
        const code = randomGameCode();
        try {
          room = await openRoom(code, 'host');
          if (host.closed) { room.close(); return ''; }
          room.onText = onRoomText;
          room.onClose = () => {
            if (host.closed) return;
            host.relayStatus = 'offline'; host.relayError = 'Lost the connection to the game’s website.';
            for (const s of [...slots]) if (s.mode !== 'p2p') dropSlot(s, true);
            changed();
          };
          host.code = code; host.relayStatus = 'online'; changed();
          return code;
        } catch (e) {
          if (e.code === 'taken') continue;
          host.relayStatus = 'offline'; host.relayError = e.message; changed();
          return '';
        }
      }
      host.relayStatus = 'offline'; host.relayError = 'Couldn’t get a free game code. Try again.'; changed();
      return '';
    },
    remove(id) {
      const s = slots.find((x) => x.id === id);
      if (!s) return;
      if (s.link) s.link.send({ t: 'bye', reason: 'The host removed you from the game.' });
      else if (room) room.send(s.rid + '|' + JSON.stringify({ t: 'bye', reason: 'The host removed you from the game.' }));
      clearTimeout(s.timer);
      dropSlot(s, false);
    },
    setTeam(id, team) { const s = slots.find((x) => x.id === id); if (s) { s.team = team; changed(); host.sendLobby(); } },
    connected() { return slots.filter((s) => s.status === 'connected'); },
    sendLobby() {
      const players = [{ name: host.hostName || 'Host', team: host.hostTeam ?? 0, host: true }]
        .concat(host.connected().map((s) => ({ id: s.id, name: s.name, team: s.team })));
      for (const s of host.connected()) s.link.send({ t: 'lobby', you: s.id, players, info: host.lobbyInfo });
    },
    broadcast(msg) { for (const s of host.connected()) s.link.send(msg); },
    // world snapshot to every joiner: direct links each get it, relayed ones share one room message
    sendFrame(frame, hint) {
      const conn = host.connected();
      if (!conn.length) return;
      const buf = encodeFrame(frame, hint);
      let relayed = false;
      for (const s of conn) { if (s.mode === 'p2p') s.link.sendFast(buf); else relayed = true; }
      const now = performance.now();
      if (relayed && room && now - lastRelayAt >= RELAY_SNAP_MS) { lastRelayAt = now; room.sendBin(buf); }
    },
    // next control state for a joiner's car (one queued tick per physics tick; holds the last state if none arrived)
    takeControls(carId) {
      const s = slots.find((x) => x.carId === carId && x.status === 'connected');
      if (!s) return null;
      if (s.queue.length) unpackControls(s.queue.shift(), s.last);
      return { ...s.last };
    },
    close(reason = 'The host left the game.') {
      host.closed = true;
      for (const s of [...slots]) {
        clearTimeout(s.timer);
        if (s.link) s.link.send({ t: 'bye', reason });
        if (s.peer) { s.peer.onClose = null; s.peer.close(); }
        s.status = 'left';
      }
      slots.length = 0;
      if (room) { room.close(); room = null; }
      host.relayStatus = 'off';
    },
  };
  return host;
}

// ------------------------------------------------------------------- joiner
export function createNetClient({ onChange, onStart, onEvents, onLeave }) {
  let room = null, peer = null, link = null;
  let roster = null, padsStatic = null;
  let snaps = [];            // live frames, ascending tick
  let lastRecv = 0;
  let replay = null, replayAt = -1e9;
  let pendingInputs = [], lastInputSend = 0;
  let joinTimer = 0;
  const changedC = () => onChange && onChange();

  function handle(m) {
    if (m.t === 'lobby') { client.lobby = m; changedC(); }
    else if (m.t === 'start') { client.you = m.you; client.status = 'playing'; snaps = []; replay = null; onStart && onStart(m); }
    else if (m.t === 'mv') client.matchView = m.v;
    else if (m.t === 'ev') {
      for (const e of m.e) for (const k in e) if (isVec(e[k])) e[k] = new Vec3(e[k].x, e[k].y, e[k].z);
      onEvents && onEvents(m.e);
    } else if (m.t === 'bye') { client.reason = m.reason || 'The host ended the game.'; ended(); }
  }
  function onFrame(buf) {
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
  }
  // connection to the host is gone (or never made)
  function ended(msg) {
    if (client.status === 'closed' || client.status === 'idle') return;
    clearTimeout(joinTimer);
    const was = client.status;
    if (room) { room.onClose = null; room.close(); room = null; }
    if (peer) { peer.onClose = null; peer.close(); peer = null; }
    if (was === 'finding' || was === 'connecting') {
      client.status = 'idle'; client.error = msg || 'Couldn’t join the game.'; changedC();
      return;
    }
    client.status = 'closed';
    if (!client.reason) client.reason = msg || 'Lost the connection to the host.';
    onLeave && onLeave(client.reason);
    changedC();
  }
  function opened(l) {
    clearTimeout(joinTimer);
    link = l;
    client.mode = l.mode;
    client.status = 'connected';
    l.send({ t: 'hello', v: NET_PROTOCOL, name: client.profile.name, bodyId: client.profile.bodyId, accent: client.profile.accent });
    changedC();
  }

  const client = {
    role: 'client',
    status: 'idle',           // idle | finding | connecting | connected | playing | closed
    mode: '',                 // 'p2p' (direct) | 'relay' (through the website)
    error: '', reason: '',
    lobby: null,              // {you, players, info}
    matchView: null,
    you: -1,                  // my car id once a match starts
    profile: null,
    // join with the host's 6-digit game code
    async joinCode(code, profile) {
      client.profile = profile;
      client.status = 'finding'; client.error = ''; changedC();
      try { await checkServer(); room = await openRoom(code, 'join'); } catch (e) {
        client.status = 'idle';
        client.error = e.code === 'nohost' ? `No game found with code ${code}. Check the number, and that the host still has the LAN lobby open.` : e.message;
        changedC();
        return;
      }
      if (client.status !== 'finding') { room.close(); return; }
      client.status = 'connecting'; changedC();
      joinTimer = setTimeout(() => { if (client.status === 'connecting') ended('The host didn’t answer. Try again.'); }, JOIN_TIMEOUT_MS);
      room.onClose = () => { if (!link || link.mode === 'relay') ended(client.status === 'connecting' ? 'Lost the connection to the game’s website.' : undefined); };
      room.onBin = (buf) => { if (link && link.mode === 'relay') onFrame(buf); };
      room.onText = async (text) => {
        let m;
        try { m = JSON.parse(text); } catch (e) { return; }
        if (m.t === '_host-left') { client.reason = client.reason || 'The host left the game.'; ended(); return; }
        if (m.t === '_rtc') {
          if (!peer) {
            peer = new Peer('join');
            peer.onCandidate = (c) => room && room.send(JSON.stringify({ t: '_rtc', c }));
          }
          try {
            if (m.sdp) room.send(JSON.stringify({ t: '_rtc', sdp: await peer.takeOffer(m.sdp) }));
            if (m.c) peer.addCandidate(m.c);
          } catch (e) { /* the host falls back to relaying */ }
          return;
        }
        if (m.t === '_use') {
          if (m.mode === 'p2p' && peer) {
            const p = peer;
            const l = { mode: 'p2p', send: (msg) => p.send(msg), close: () => p.close() };
            p.onMessage = handle; p.onFast = onFrame;
            p.onClose = () => ended();
            const go = () => { opened(l); if (room) { room.onClose = null; room.close(); room = null; } };
            if (p.open) go(); else p.onOpen = go;
          } else {
            if (peer) { peer.onClose = null; peer.close(); peer = null; }
            opened({ mode: 'relay', send: (msg) => room && room.send(JSON.stringify(msg)), close: () => room && room.close() });
          }
          return;
        }
        if (link && link.mode === 'relay') handle(m);
      };
    },
    // called by main after building the local copy of the world for a match
    setStatic(r, pads) { roster = r; padsStatic = pads; snaps = []; replay = null; },
    sendInputs(controlsList) {
      for (const c of controlsList) pendingInputs.push(packControls(c));
      if (!link || !pendingInputs.length) return;
      const now = performance.now();
      if (link.mode === 'relay' && now - lastInputSend < RELAY_INPUT_MS && pendingInputs.length < 8) return;
      lastInputSend = now;
      link.send({ t: 'in', k: pendingInputs });
      pendingInputs = [];
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
      const est = last.tick + Math.min(((now - lastRecv) / 1000) * 120, 4);
      const rt = est - (RENDER_DELAY[client.mode] || RENDER_DELAY.relay);
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
    close() {
      clearTimeout(joinTimer);
      if (link) { try { link.send({ t: 'bye' }); } catch (e) { /* ignore */ } }
      client.status = 'closed';
      if (peer) { peer.onClose = null; peer.close(); peer = null; }
      if (room) { room.onClose = null; room.close(); room = null; }
    },
  };
  return client;
}
