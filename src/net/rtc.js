// LAN multiplayer direct transport: WebRTC data channels between the computers (lead-owned).
// Set up through the game's room on the website (relay.js); the host makes the offer:
//   host: desc = await peer.makeOffer() ... await peer.takeAnswer(desc); peer.addCandidate(c)
//   join: desc = await peer.takeOffer(offer); peer.onCandidate = (c) => send it through the room
// Two channels: 'rel' (reliable, ordered: lobby, inputs, events, match info) and
// 'fast' (unordered, no retransmits: world snapshots).

const ICE = [{ urls: 'stun:stun.l.google.com:19302' }]; // optional; LAN host candidates work without it

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
