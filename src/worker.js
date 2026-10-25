import phoneHTML from './phone.html';

// Only ephemeral pairing credentials are stored. Sensor readings are forwarded,
// never written to storage. WSS is TLS to Cloudflare, not end-to-end encryption.
const TTL = 2 * 60 * 60 * 1000;
const randomKey = () => {
  const b = crypto.getRandomValues(new Uint8Array(32));
  return btoa(String.fromCharCode(...b)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
};
function same(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string' || a.length !== b.length) return false;
  let n = 0;
  for (let i = 0; i < a.length; i++) n |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return n === 0;
}
function originAllowed(request, env) {
  const origin = request.headers.get('Origin');
  if (!origin || origin === 'null') return true; // Native clients / local file main.
  const allowed = new Set([new URL(request.url).origin, 'https://ampirion.github.io']);
  for (const value of (env.ALLOWED_ORIGINS || '').split(',')) if (value.trim()) allowed.add(value.trim());
  return allowed.has(origin);
}
function cors(request) {
  return {
    'Access-Control-Allow-Origin': request.headers.get('Origin') || '*',
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Authorization, Content-Type',
    'Access-Control-Max-Age': '600',
    'Cache-Control': 'no-store',
    'Vary': 'Origin',
  };
}
function json(request, data, status = 200) {
  return new Response(JSON.stringify(data), {status, headers: {...cors(request), 'Content-Type': 'application/json; charset=utf-8'}});
}
export default {
  async fetch(request, env) {
    const u = new URL(request.url);
    if (!originAllowed(request, env)) return new Response('Origin not allowed', {status: 403});
    if (request.method === 'OPTIONS') return new Response(null, {status: 204, headers: cors(request)});
    const configured = typeof env.PAIRING_KEY === 'string' && env.PAIRING_KEY.length >= 24;
    if (request.method === 'GET' && u.pathname === '/health') {
      return json(request, {service: 'Plexika Girocam relay', protocol: 1, ready: configured});
    }
    if (request.method === 'GET' && u.pathname === '/') {
      const text = configured
        ? 'Сервер готов. Скопируйте адрес этой страницы для настройки Plexika. Секрет PAIRING_KEY никому не отправляйте.'
        : 'Сервер опубликован. В Cloudflare откройте этот Worker → Settings → Variables and Secrets → Add. Выберите Secret, имя PAIRING_KEY, значение не менее 24 символов, затем Deploy.';
      return new Response('<!doctype html><html lang="ru"><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>Plexika Girocam relay</title><body style="background:#102632;color:#deeff7;font:18px system-ui;max-width:700px;margin:12vh auto;padding:24px"><h1>Plexika Girocam relay</h1><p>' + text + '</p><p>Телефон подключается по QR из редактора. Сеанс действует два часа.</p><a style="color:#8ce0ff" href="/health">Проверка состояния</a></body></html>', {headers: {'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store'}});
    }
    if (request.method === 'GET' && u.pathname === '/phone') {
      return new Response(phoneHTML, {headers: {'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store', 'Referrer-Policy': 'no-referrer', 'X-Content-Type-Options': 'nosniff'}});
    }
    if (request.method === 'POST' && u.pathname === '/v1/sessions') {
      if (!configured) return json(request, {error: 'Set PAIRING_KEY first'}, 503);
      if (!same(request.headers.get('Authorization'), 'Bearer ' + env.PAIRING_KEY)) return json(request, {error: 'Wrong pairing key'}, 401);
      const room = crypto.randomUUID();
      const meta = {v: 1, room, hostToken: randomKey(), phoneToken: randomKey(), expiresAt: Date.now() + TTL};
      const stub = env.ROOMS.get(env.ROOMS.idFromName(room));
      // This internal endpoint cannot be reached through the public router.
      const result = await stub.fetch(new Request('https://room.internal/init', {method: 'POST', body: JSON.stringify(meta)}));
      if (!result.ok) return json(request, {error: 'Cannot create session'}, 503);
      return json(request, meta, 201);
    }
    const match = u.pathname.match(/^\/v1\/sessions\/([a-f0-9-]{36})\/ws$/);
    if (request.method === 'GET' && match) {
      const stub = env.ROOMS.get(env.ROOMS.idFromName(match[1]));
      return stub.fetch(request);
    }
    return json(request, {error: 'Not found'}, 404);
  },
};

export class PlexikaRoom {
  constructor(ctx, env) { this.ctx = ctx; this.env = env; }
  sockets(role) { return this.ctx.getWebSockets(role).filter(ws => ws.readyState === 1); }
  send(ws, object) { try { ws.send(JSON.stringify(object)); } catch {} }
  async fetch(request) {
    const url = new URL(request.url);
    if (url.hostname === 'room.internal' && url.pathname === '/init' && request.method === 'POST') {
      if (await this.ctx.storage.get('meta')) return new Response('Already initialized', {status: 409});
      const meta = await request.json();
      await this.ctx.storage.put('meta', meta);
      await this.ctx.storage.setAlarm(meta.expiresAt);
      return new Response('Created', {status: 201});
    }
    const meta = await this.ctx.storage.get('meta');
    if (!meta || meta.expiresAt <= Date.now()) return new Response('Session expired', {status: 410});
    if (request.headers.get('Upgrade')?.toLowerCase() !== 'websocket') return new Response('WebSocket required', {status: 426});
    const role = url.searchParams.get('role');
    if (!['host', 'phone'].includes(role) || !same(url.searchParams.get('token'), meta[role + 'Token'])) return new Response('Invalid session token', {status: 401});
    if (this.sockets(role).length) return new Response('This role is already connected', {status: 409});
    const pair = new WebSocketPair();
    const client = pair[0], server = pair[1];
    this.ctx.acceptWebSocket(server, [role]);
    server.serializeAttachment({role, second: 0, count: 0});
    const other = role === 'host' ? 'phone' : 'host';
    this.send(server, {type: 'peer', connected: this.sockets(other).length > 0});
    for (const ws of this.sockets(other)) this.send(ws, {type: 'peer', connected: true});
    return new Response(null, {status: 101, webSocket: client});
  }
  async webSocketMessage(ws, message) {
    const a = ws.deserializeAttachment();
    if (!a) { ws.close(1008, 'Unknown role'); return; }
    const meta = await this.ctx.storage.get('meta');
    if (!meta || meta.expiresAt <= Date.now()) { ws.close(1008, 'Session expired'); return; }
    if (typeof message !== 'string' || message.length > 2048) { ws.close(1009, 'Message too large'); return; }
    const second = Math.floor(Date.now() / 1000);
    if (a.second !== second) { a.second = second; a.count = 0; }
    a.count++; ws.serializeAttachment(a);
    if (a.count > 60) { ws.close(1008, 'Too many messages'); return; }
    let p;
    try { p = JSON.parse(message); } catch { ws.close(1008, 'Invalid JSON'); return; }
    if (p.type === 'ping') { this.send(ws, {type: 'pong'}); return; }
    if (a.role !== 'phone' || p.v !== 1 || p.type !== 'orientation' || !same(p.token, meta.phoneToken) || !['alpha', 'beta', 'gamma', 'screen', 'at'].every(k => Number.isFinite(p[k]))) {
      ws.close(1008, 'Invalid sensor packet'); return;
    }
    // Rebuild the packet so unknown fields cannot be used as a generic relay.
    const data = JSON.stringify({v: 1, type: 'orientation', token: meta.phoneToken, alpha: p.alpha, beta: p.beta, gamma: p.gamma, screen: p.screen, at: p.at});
    for (const host of this.sockets('host')) { try { host.send(data); } catch {} }
  }
  webSocketClose(ws, code, reason, wasClean) {
    const role = ws.deserializeAttachment()?.role;
    try { ws.close(code === 1005 || code === 1006 ? 1000 : code, 'Disconnected'); } catch {}
    if (role) for (const peer of this.sockets(role === 'phone' ? 'host' : 'phone')) this.send(peer, {type: 'peer', connected: false});
  }
  webSocketError(ws) { this.webSocketClose(ws, 1011, 'Connection error', false); }
  async alarm() {
    for (const ws of this.ctx.getWebSockets()) { try { ws.close(1000, 'Session expired'); } catch {} }
    await this.ctx.storage.deleteAll();
  }
}
