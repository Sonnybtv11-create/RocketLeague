// TURBO PITCH website worker (Cloudflare Workers + Durable Objects).
// Serves the game (static assets in ./public) and runs LAN-play rooms: one Durable Object per
// 6-digit game code. The room passes connection setup between the host and joiners and, when the
// network won't let the computers talk directly (school / office Wi-Fi), relays the game itself.
//
// Wire format (WebSocket /api/room/<code>?role=host|join):
//   host -> room   text  "<peerId>|<json>"  (or "*|<json>" for every joiner); binary = world snapshot for all
//   room -> host   text  "<peerId>|<json>"  from a joiner, or "#|<json>" room notices (_ok, peer-join, peer-leave)
//   join -> room   text  "<json>"           (forwarded to the host)
//   room -> join   text  "<json>" from the host or a room notice (_ok, _nohost, _host-left); binary = snapshot
import { DurableObject } from 'cloudflare:workers';

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const m = /^\/api\/room\/(\d{6})$/.exec(url.pathname);
    if (m) {
      if (request.headers.get('Upgrade') !== 'websocket') return new Response('Expected a WebSocket', { status: 426 });
      return env.ROOMS.get(env.ROOMS.idFromName(m[1])).fetch(request);
    }
    if (url.pathname === '/api/health') return Response.json({ ok: true, service: 'turbo-pitch', v: 1 }, { headers: { 'cache-control': 'no-store' } });
    if (url.pathname.startsWith('/api/')) return new Response('Not found', { status: 404 });
    return env.ASSETS.fetch(request);
  },
};

const notice = (o) => JSON.stringify(o);

export class Room extends DurableObject {
  async fetch(request) {
    const role = new URL(request.url).searchParams.get('role');
    const { 0: client, 1: server } = new WebSocketPair();
    const host = this.ctx.getWebSockets('host')[0];
    if (role === 'host') {
      if (host) {
        this.ctx.acceptWebSocket(server, ['refused']);
        server.send('#|' + notice({ t: '_taken' }));
        server.close(4001, 'code in use');
      } else {
        this.ctx.acceptWebSocket(server, ['host']);
        server.send('#|' + notice({ t: '_ok' }));
      }
    } else if (!host) {
      this.ctx.acceptWebSocket(server, ['refused']);
      server.send(notice({ t: '_nohost' }));
      server.close(4004, 'no game with that code');
    } else {
      const pid = crypto.randomUUID().replace(/-/g, '').slice(0, 10);
      this.ctx.acceptWebSocket(server, ['join', 'p:' + pid]);
      server.serializeAttachment({ pid });
      server.send(notice({ t: '_ok' }));
      safeSend(host, '#|' + notice({ t: 'peer-join', id: pid }));
    }
    return new Response(null, { status: 101, webSocket: client });
  }

  webSocketMessage(ws, msg) {
    const tags = this.ctx.getTags(ws);
    if (tags.includes('host')) {
      if (typeof msg !== 'string') { for (const j of this.ctx.getWebSockets('join')) safeSend(j, msg); return; }
      const bar = msg.indexOf('|');
      if (bar < 1) return;
      const to = msg.slice(0, bar), body = msg.slice(bar + 1);
      for (const j of this.ctx.getWebSockets(to === '*' ? 'join' : 'p:' + to)) safeSend(j, body);
    } else if (tags.includes('join') && typeof msg === 'string') {
      const host = this.ctx.getWebSockets('host')[0];
      const att = ws.deserializeAttachment();
      if (host && att) safeSend(host, att.pid + '|' + msg);
    }
  }

  webSocketClose(ws, code) { this.left(ws); try { ws.close(code === 1005 ? 1000 : code, 'bye'); } catch (e) { /* already closed */ } }
  webSocketError(ws) { this.left(ws); }

  left(ws) {
    const tags = this.ctx.getTags(ws);
    if (tags.includes('host')) {
      for (const j of this.ctx.getWebSockets('join')) { safeSend(j, notice({ t: '_host-left' })); try { j.close(1000, 'host left'); } catch (e) { /* ignore */ } }
    } else if (tags.includes('join')) {
      const host = this.ctx.getWebSockets('host')[0];
      const att = ws.deserializeAttachment();
      if (host && att) safeSend(host, '#|' + notice({ t: 'peer-leave', id: att.pid }));
    }
  }
}

function safeSend(ws, data) { try { ws.send(data); } catch (e) { /* socket closing */ } }
