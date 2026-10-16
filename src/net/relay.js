// LAN-play rooms on the game's own website (lead-owned). The Cloudflare Worker in worker/index.js
// gives every 6-digit game code a room; both computers connect to it over a WebSocket on the same
// site that serves the game, so a school or office network that lets the game load also lets it
// connect. The room carries the connection setup and, if the computers can't reach each other
// directly, the game traffic too.
const NO_SERVER = 'Network play isn’t set up on this website yet: it needs the TURBO PITCH Cloudflare Worker (see README). It won’t work from a downloaded file.';
const UNREACHABLE = 'Couldn’t reach the game’s website to set up the game. Check this computer is online and try again.';

export function randomGameCode() { return String(100000 + Math.floor(Math.random() * 900000)); }

// Is the room service there? (same origin as the page)
export async function checkServer() {
  if (!/^https?:$/.test(location.protocol)) throw new Error(NO_SERVER);
  let res;
  try { res = await fetch('/api/health', { cache: 'no-store' }); } catch (e) { throw new Error(UNREACHABLE); }
  let body = null;
  try { body = res.ok ? await res.json() : null; } catch (e) { body = null; }
  if (!body || body.service !== 'turbo-pitch') throw new Error(NO_SERVER);
}

// Open a room socket. Resolves once the room says _ok; rejects with {code: 'taken'|'nohost'|'unreachable'}.
export function openRoom(code, role, { timeoutMs = 10000 } = {}) {
  return new Promise((resolve, reject) => {
    const url = `${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/api/room/${code}?role=${role}`;
    let ws;
    try { ws = new WebSocket(url); } catch (e) { reject(Object.assign(new Error(UNREACHABLE), { code: 'unreachable' })); return; }
    ws.binaryType = 'arraybuffer';
    let settled = false;
    const room = {
      code, role, closed: false, onText: null, onBin: null, onClose: null,
      get buffered() { return ws.bufferedAmount; },
      send(text) { if (ws.readyState === 1) ws.send(text); },
      sendBin(buf) { if (ws.readyState === 1 && ws.bufferedAmount < 1 << 20) ws.send(buf); },
      close() { if (room.closed) return; room.closed = true; try { ws.close(1000); } catch (e) { /* ignore */ } },
    };
    const fail = (err) => { if (settled) return; settled = true; clearTimeout(to); room.closed = true; try { ws.close(); } catch (e) { /* ignore */ } reject(err); };
    const to = setTimeout(() => fail(Object.assign(new Error(UNREACHABLE), { code: 'unreachable' })), timeoutMs);
    ws.onmessage = (e) => {
      if (typeof e.data !== 'string') { if (settled && room.onBin) room.onBin(e.data); return; }
      const text = role === 'host' && e.data.startsWith('#|') ? e.data.slice(2) : e.data;
      if (!settled) {
        let m = null;
        try { m = JSON.parse(text); } catch (err) { /* ignore */ }
        if (m && m.t === '_ok') { settled = true; clearTimeout(to); resolve(room); return; }
        if (m && m.t === '_taken') { fail(Object.assign(new Error('That game code is in use.'), { code: 'taken' })); return; }
        if (m && m.t === '_nohost') { fail(Object.assign(new Error('No game with that code.'), { code: 'nohost' })); return; }
        return;
      }
      room.onText && room.onText(e.data);
    };
    ws.onerror = () => {};
    ws.onclose = () => {
      if (!settled) { fail(Object.assign(new Error(UNREACHABLE), { code: 'unreachable' })); return; }
      if (!room.closed) { room.closed = true; room.onClose && room.onClose(); }
    };
  });
}
