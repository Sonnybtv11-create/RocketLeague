// LAN multiplayer transport: WebRTC data channels between the computers (lead-owned).
// Two ways to set a connection up:
//  * 6-digit game code (relay.js): offer / answer / ICE candidates pass through a public relay;
//    the joiner makes the offer (new Peer('join', { offerer: true })):
//      join: desc = await peer.makeOffer() ... await peer.takeAnswer(desc); peer.addCandidate(c)
//      host: desc = await peer.takeOffer(offer) (new Peer('host', { offerer: false }))
//  * offline fallback, copy/paste "long codes" holding the whole session description:
//      host: code = await peer.createInvite(); ... await peer.acceptReply(reply)
//      join: reply = await peer.acceptInvite(code)
// Two channels: 'rel' (reliable, ordered: lobby, inputs, events, match info) and
// 'fast' (unordered, no retransmits: world snapshots).

const ICE = [{ urls: 'stun:stun.l.google.com:19302' }]; // optional; LAN host candidates work without it
const GATHER_TIMEOUT_MS = 2500;
const PREFIX = 'TP1';

// ---- code <-> session description --------------------------------------------
function b64urlEncode(bytes) {
  let s = '';
  for (let i = 0; i < bytes.length; i++) s += String.fromCharCode(bytes[i]);
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}
function b64urlDecode(str) {
  const s = str.replace(/-/g, '+').replace(/_/g, '/');
  const bin = atob(s + '==='.slice((s.length + 3) % 4));
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}
async function pipe(bytes, stream) {
  const res = new Response(new Blob([bytes]).stream().pipeThrough(stream));
  return new Uint8Array(await res.arrayBuffer());
}
// Keep only what a data-channel connection needs (drops media/extmap noise)
function slimSdp(sdp) {
  return sdp.split(/\r?\n/).filter((l) => l && !/^a=(extmap|rtcp-fb|ssrc|msid)/.test(l)).join('\r\n') + '\r\n';
}

export async function encodeCode(desc) {
  const json = JSON.stringify({ t: desc.type === 'offer' ? 'o' : 'a', s: slimSdp(desc.sdp) });
  const raw = new TextEncoder().encode(json);
  if (typeof CompressionStream !== 'undefined') {
    try { return `${PREFIX}z.${b64urlEncode(await pipe(raw, new CompressionStream('deflate-raw')))}`; } catch (e) { /* fall through */ }
  }
  return `${PREFIX}p.${b64urlEncode(raw)}`;
}

export async function decodeCode(code) {
  const c = String(code || '').replace(/\s+/g, '');
  const m = /^TP1([zp])\.([A-Za-z0-9_-]+)$/.exec(c);
  if (!m) throw new Error('That doesn’t look like a TURBO PITCH connection code. Copy the whole code, starting with “TP1”.');
  let bytes = b64urlDecode(m[2]);
  if (m[1] === 'z') {
    if (typeof DecompressionStream === 'undefined') throw new Error('This browser can’t read compressed codes. Update the browser and try again.');
    bytes = await pipe(bytes, new DecompressionStream('deflate-raw'));
  }
  const o = JSON.parse(new TextDecoder().decode(bytes));
  return { type: o.t === 'o' ? 'offer' : 'answer', sdp: o.s };
}

function waitForGathering(pc) {
  if (pc.iceGatheringState === 'complete') return Promise.resolve();
  return new Promise((resolve) => {
    const t = setTimeout(done, GATHER_TIMEOUT_MS);
    function done() { clearTimeout(t); pc.removeEventListener('icegatheringstatechange', check); resolve(); }
    function check() { if (pc.iceGatheringState === 'complete') done(); }
    pc.addEventListener('icegatheringstatechange', check);
  });
}

export function webrtcSupported() { return typeof RTCPeerConnection !== 'undefined'; }

// ---- peer ------------------------------------------------------------------------
export class Peer {
  constructor(role, { offerer = role === 'host' } = {}) {
    this.role = role;
    this.pc = new RTCPeerConnection({ iceServers: ICE });
    this.rel = null; this.fast = null;
    this.open = false; this.closed = false;
    this.onOpen = null; this.onClose = null; this.onMessage = null; this.onFast = null;
    this.onCandidate = null; this._pending = [];
    this.pc.onicecandidate = (e) => { if (e.candidate && this.onCandidate) this.onCandidate(e.candidate.toJSON()); };
    if (offerer) {
      this._attach(this.pc.createDataChannel('rel', { ordered: true }));
      this._attach(this.pc.createDataChannel('fast', { ordered: false, maxRetransmits: 0 }));
    } else {
      this.pc.ondatachannel = (e) => this._attach(e.channel);
    }
    this.pc.onconnectionstatechange = () => {
      const s = this.pc.connectionState;
      if (s === 'failed' || s === 'closed' || s === 'disconnected') this._closed();
    };
  }
  _attach(ch) {
    ch.binaryType = 'arraybuffer';
    if (ch.label === 'rel') this.rel = ch; else this.fast = ch;
    ch.onopen = () => {
      if (!this.open && this.rel && this.fast && this.rel.readyState === 'open' && this.fast.readyState === 'open') {
        this.open = true;
        this.onOpen && this.onOpen();
      }
    };
    ch.onclose = () => this._closed();
    ch.onmessage = (e) => {
      if (ch.label === 'rel') {
        let msg; try { msg = JSON.parse(e.data); } catch (err) { return; }
        this.onMessage && this.onMessage(msg);
      } else this.onFast && this.onFast(e.data);
    };
  }
  _closed() {
    if (this.closed) return;
    this.closed = true; this.open = false;
    this.onClose && this.onClose();
  }
  async createInvite() {
    await this.pc.setLocalDescription(await this.pc.createOffer());
    await waitForGathering(this.pc);
    return encodeCode(this.pc.localDescription);
  }
  async acceptInvite(code) {
    const desc = await decodeCode(code);
    if (desc.type !== 'offer') throw new Error('That’s a reply code. Paste the invite code from the host instead.');
    await this.pc.setRemoteDescription(desc);
    await this.pc.setLocalDescription(await this.pc.createAnswer());
    await waitForGathering(this.pc);
    return encodeCode(this.pc.localDescription);
  }
  async acceptReply(code) {
    const desc = await decodeCode(code);
    if (desc.type !== 'answer') throw new Error('That’s an invite code. Paste the reply code from the player who is joining.');
    await this.pc.setRemoteDescription(desc);
  }
  // ---- trickle signalling (6-digit codes)
  async makeOffer() {
    await this.pc.setLocalDescription(await this.pc.createOffer());
    return { type: 'offer', sdp: this.pc.localDescription.sdp };
  }
  async takeOffer(desc) {
    await this.pc.setRemoteDescription(desc);
    this._flush();
    await this.pc.setLocalDescription(await this.pc.createAnswer());
    return { type: 'answer', sdp: this.pc.localDescription.sdp };
  }
  async takeAnswer(desc) {
    await this.pc.setRemoteDescription(desc);
    this._flush();
  }
  addCandidate(c) {
    if (!c) return;
    if (!this.pc.remoteDescription) this._pending.push(c);
    else this.pc.addIceCandidate(c).catch(() => {});
  }
  _flush() { for (const c of this._pending.splice(0)) this.pc.addIceCandidate(c).catch(() => {}); }

  send(msg) { if (this.rel && this.rel.readyState === 'open') this.rel.send(JSON.stringify(msg)); }
  sendFast(buf) { if (this.fast && this.fast.readyState === 'open' && this.fast.bufferedAmount < 1 << 20) this.fast.send(buf); }
  close() {
    try { this.rel && this.rel.close(); } catch (e) { /* ignore */ }
    try { this.fast && this.fast.close(); } catch (e) { /* ignore */ }
    try { this.pc.close(); } catch (e) { /* ignore */ }
    this._closed();
  }
}
