// Matchmaking relay for 6-digit game codes (lead-owned). The host registers as
// "turbopitch-v1-<code>" on the free public PeerJS server and joiners message that name; only
// the connection setup (offer / answer / ICE candidates) goes through it. Game traffic then flows
// directly between the computers over WebRTC. Needs an internet connection for the setup only.
//
// PeerJS server protocol: wss://<host>/peerjs?key=&id=&token=, server sends {type:'OPEN'} once
// registered ('ID-TAKEN' / 'ERROR' otherwise), relays {type, dst, payload} to dst as {type, src, payload},
// sends 'EXPIRE' back when dst isn't connected, and wants {type:'HEARTBEAT'} every few seconds.
const SERVER = 'wss://0.peerjs.com:443/peerjs?key=peerjs';
export const HOST_PREFIX = 'turbopitch-v1-';
const UNREACHABLE = 'Couldn’t reach the matchmaking service. Game codes need an internet connection to connect (the game itself runs over your network).';

// The public server only relays messages shaped like PeerJS's own data-connection signalling,
// so offers / answers / candidates are wrapped exactly that way.
export const wrapOffer = (connectionId, sdp, metadata) => ({ sdp, type: 'data', connectionId, label: connectionId, reliable: true, serialization: 'binary', metadata, browser: 'chrome' });
export const wrapAnswer = (connectionId, sdp) => ({ sdp, type: 'data', connectionId, browser: 'chrome' });
export const wrapCandidate = (connectionId, candidate) => ({ candidate, type: 'data', connectionId });

export function randomGameCode() { return String(100000 + Math.floor(Math.random() * 900000)); }
export const hostIdFor = (code) => HOST_PREFIX + code;

export function openRelay(id, { timeoutMs = 10000 } = {}) {
  return new Promise((resolve, reject) => {
    const token = Math.random().toString(36).slice(2, 12);
    let ws;
    try { ws = new WebSocket(`${SERVER}&id=${encodeURIComponent(id)}&token=${token}&version=1.5.4`); } catch (e) { reject(new Error(UNREACHABLE)); return; }
    let opened = false;
    const r = {
      id, closed: false, onMessage: null, onClose: null,
      send(type, dst, payload) { if (ws.readyState === 1) ws.send(JSON.stringify({ type, dst, payload })); },
      close() {
        if (r.closed) return;
        r.closed = true; clearInterval(hb); clearTimeout(to);
        try { ws.close(); } catch (e) { /* ignore */ }
      },
    };
    const fail = (err) => { if (!opened) { opened = true; r.close(); reject(err); } };
    const to = setTimeout(() => fail(new Error(UNREACHABLE)), timeoutMs);
    const hb = setInterval(() => { if (ws.readyState === 1) ws.send('{"type":"HEARTBEAT"}'); }, 5000);
    ws.onmessage = (e) => {
      let m;
      try { m = JSON.parse(e.data); } catch (err) { return; }
      if (m.type === 'OPEN') { if (!opened) { opened = true; clearTimeout(to); resolve(r); } }
      else if (m.type === 'ID-TAKEN') fail(Object.assign(new Error('That game code is in use.'), { taken: true }));
      else if (m.type === 'ERROR' && !opened) fail(new Error(UNREACHABLE));
      else if (m.type !== 'HEARTBEAT' && r.onMessage) r.onMessage(m);
    };
    ws.onerror = () => {};
    ws.onclose = () => {
      clearInterval(hb);
      if (!opened) { fail(new Error(UNREACHABLE)); return; }
      if (!r.closed) { r.closed = true; r.onClose && r.onClose(); }
    };
  });
}
