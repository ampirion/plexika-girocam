import phoneHTML from './phone.html';
export {GirocamAllocator} from './allocator.js';

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
    const publicRoute = u.pathname === '/health' || u.pathname === '/v2/lobby' || /^\/v1\/sessions\/[a-f0-9-]{36}\/ws$/.test(u.pathname);
    if (!publicRoute && !originAllowed(request, env)) return new Response('Origin not allowed', {status: 403});
    if (request.method === 'OPTIONS') return new Response(null, {status: 204, headers: cors(request)});
    const configured = typeof env.PAIRING_KEY === 'string' && env.PAIRING_KEY.length >= 24;
    if (request.method === 'GET' && u.pathname === '/health') {
      return json(request, {service: 'Plexika Girocam relay', protocol: 2, ready: !!env.ALLOCATOR&&!!env.ROOMS, public: !!env.ALLOCATOR&&!!env.ROOMS, legacyKeyReady: configured, limit: Math.max(1,Math.min(100,Number(env.MAX_SESSIONS)||100))});
    }
    if (request.method === 'GET' && u.pathname === '/') {
      const text = !!env.ALLOCATOR&&!!env.ROOMS
        ? 'Сервер гирокама v2 готов. Открытый доступ: до 100 сеансов и очередь. Основной PAIRING_KEY пользователям не нужен. Бесплатные квоты Cloudflare остаются ограничением.'
        : 'Не хватает привязок сервера v2. Загрузите весь пакет обновления, включая wrangler.jsonc и src/allocator.js. Для публичного режима PAIRING_KEY не требуется.';
      return new Response('<!doctype html><html lang="ru"><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>Plexika Girocam relay</title><body style="background:#102632;color:#deeff7;font:18px system-ui;max-width:700px;margin:12vh auto;padding:24px"><h1>Plexika Girocam relay</h1><p>' + text + '</p><p>Телефон подключается по QR из редактора. Сеанс действует два часа.</p><a style="color:#8ce0ff" href="/health">Проверка состояния</a></body></html>', {headers: {'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store'}});
    }
    if (request.method === 'GET' && u.pathname === '/phone') {
      return new Response(phoneHTML, {headers: {'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store', 'Referrer-Policy': 'no-referrer', 'X-Content-Type-Options': 'nosniff'}});
    }
    if (request.method === 'GET' && u.pathname === '/v2/lobby') {
      return env.ALLOCATOR.get(env.ALLOCATOR.idFromName('global')).fetch(request);
    }
    if (request.method === 'POST' && u.pathname === '/v1/sessions') {
      if (!configured) return json(request, {error: 'Set PAIRING_KEY first'}, 503);
      if (!same(request.headers.get('Authorization'), 'Bearer ' + env.PAIRING_KEY)) return json(request, {error: 'Wrong pairing key'}, 401);
      if (env.ALLOCATOR) {
        const r = await env.ALLOCATOR.get(env.ALLOCATOR.idFromName('global')).fetch(new Request('https://allocator.internal/state', {method:'POST', body:JSON.stringify({type:'legacyRequest'})}));
        return json(request, await r.json(), r.status);
      }
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
 constructor(ctx,env){this.ctx=ctx;this.env=env;}
 sockets(role){return this.ctx.getWebSockets(role).filter(w=>w.readyState===1);}
 send(ws,p){try{ws.send(JSON.stringify(p));}catch{}}
 async notify(meta,type,active){if(!meta?.publicMode)return;try{await this.env.ALLOCATOR.get(this.env.ALLOCATOR.idFromName('global')).fetch(new Request('https://allocator.internal/state',{method:'POST',body:JSON.stringify({room:meta.room,type,active})}));}catch{}}
 async revoke(){await this.ctx.storage.deleteAll();await this.ctx.storage.deleteAlarm();for(const w of this.ctx.getWebSockets())try{w.close(1000,'Session ended');}catch{}}
 async fetch(request){const u=new URL(request.url);if(u.hostname==='room.internal'){
 if(u.pathname==='/revoke'&&request.method==='POST'){await this.revoke();return new Response('Revoked');}
 if(u.pathname==='/init'&&request.method==='POST'){if(await this.ctx.storage.get('meta'))return new Response('Already initialized',{status:409});const meta=await request.json();await this.ctx.storage.put('meta',meta);await this.ctx.storage.setAlarm(meta.expiresAt);return new Response('Created',{status:201});}}
 const meta=await this.ctx.storage.get('meta');if(!meta||meta.expiresAt<=Date.now()||(meta.pendingUntil&&meta.pendingUntil<=Date.now()))return new Response('Session expired',{status:410});if(request.headers.get('Upgrade')?.toLowerCase()!=='websocket')return new Response('WebSocket required',{status:426});const role=u.searchParams.get('role');if(!['host','phone'].includes(role)||!same(u.searchParams.get('token'),meta[role+'Token']))return new Response('Invalid token',{status:401});if(this.sockets(role).length)return new Response('Role already connected',{status:409});const pair=new WebSocketPair(),server=pair[1];meta.pendingUntil=role==='host'&&!this.sockets('phone').length?Date.now()+180000:null;await this.ctx.storage.put('meta',meta);await this.ctx.storage.setAlarm(Math.min(meta.expiresAt,meta.pendingUntil||meta.expiresAt));this.ctx.acceptWebSocket(server,[role]);server.serializeAttachment({role,second:0,count:0});const other=role==='host'?'phone':'host';this.send(server,{type:'peer',connected:this.sockets(other).length>0});for(const w of this.sockets(other))this.send(w,{type:'peer',connected:true});if(role==='host')await this.notify(meta,'claimed');return new Response(null,{status:101,webSocket:pair[0]});}
 async webSocketMessage(ws,message){const a=ws.deserializeAttachment(),meta=await this.ctx.storage.get('meta');if(!a||!meta||meta.expiresAt<=Date.now()){ws.close(1008,'Session expired');return;}if(typeof message!=='string'||message.length>(a.role==='host'?65536:2048)){ws.close(1009,'Too large');return;}const second=Math.floor(Date.now()/1000);if(a.second!==second){a.second=second;a.count=0;}a.count++;ws.serializeAttachment(a);if(a.count>(a.role==='host'?12:60)){ws.close(1008,'Rate exceeded');return;}let p;try{p=JSON.parse(message);}catch{ws.close(1008,'Invalid JSON');return;}if(!p||typeof p!=='object'){ws.close(1008,'Invalid packet');return;}if(p.type==='ping'){this.send(ws,{type:'pong'});return;}
 if(a.role==='host'){
 if(p.type==='recording'&&typeof p.active==='boolean'){await this.notify(meta,'recording',p.active);return;}
 if(p.type==='preview'&&typeof p.data==='string'&&p.data.startsWith('data:image/jpeg;base64,')&&p.data.length<=60000&&p.w===320&&p.h===180){for(const phone of this.sockets('phone'))this.send(phone,{type:'preview',v:2,data:p.data,w:320,h:180});return;}
 if(p.type==='freeze_ack'&&typeof p.held==='boolean'){for(const phone of this.sockets('phone'))this.send(phone,{type:'freeze_ack',held:p.held});return;}
 ws.close(1008,'Invalid host command');return;}
 if(!same(p.token,meta.phoneToken)){ws.close(1008,'Invalid packet token');return;}
 let data=null;
 if(p.type==='orientation'&&p.v===1&&['alpha','beta','gamma','screen','at'].every(k=>Number.isFinite(p[k]))&&Math.abs(p.alpha)<=720&&Math.abs(p.beta)<=360&&Math.abs(p.gamma)<=360&&Math.abs(p.screen)<=720)data={v:1,type:'orientation',token:meta.phoneToken,alpha:p.alpha,beta:p.beta,gamma:p.gamma,screen:p.screen,at:p.at};
 else if(p.type==='zoom'&&p.v===2&&Number.isFinite(p.delta))data={v:2,type:'zoom',token:meta.phoneToken,delta:Math.max(-.25,Math.min(.25,p.delta))};
 else if(p.type==='freeze'&&p.v===2&&typeof p.held==='boolean')data={v:2,type:'freeze',token:meta.phoneToken,held:p.held};
 if(data?.type==='freeze'&&!data.held&&p.basis&&['alpha','beta','gamma','screen'].every(k=>Number.isFinite(p.basis[k]))&&Math.abs(p.basis.alpha)<=720&&Math.abs(p.basis.beta)<=360&&Math.abs(p.basis.gamma)<=360&&Math.abs(p.basis.screen)<=720)data.basis={alpha:p.basis.alpha,beta:p.basis.beta,gamma:p.basis.gamma,screen:p.basis.screen};
 if(!data){ws.close(1008,'Invalid sensor packet');return;}for(const host of this.sockets('host'))this.send(host,data);}
 async webSocketClose(ws,code){const role=ws.deserializeAttachment()?.role;try{ws.close(code===1005||code===1006?1000:code,'Disconnected');}catch{}const meta=await this.ctx.storage.get('meta');if(!meta)return;if(role==='host'){if(this.sockets('host').length)return;await this.revoke();await this.notify(meta,'ended');}else if(role==='phone'){if(this.sockets('phone').length)return;meta.pendingUntil=Date.now()+120000;await this.ctx.storage.put('meta',meta);await this.ctx.storage.setAlarm(Math.min(meta.expiresAt,meta.pendingUntil));for(const host of this.sockets('host'))this.send(host,{type:'peer',connected:false});await this.notify(meta,'recording',false);}}
 webSocketError(ws){return this.webSocketClose(ws,1011);}
 async alarm(){const meta=await this.ctx.storage.get('meta');if(!meta)return;const next=Math.min(meta.expiresAt,meta.pendingUntil||meta.expiresAt);if(Date.now()+500<next){await this.ctx.storage.setAlarm(next);return;}await this.revoke();await this.notify(meta,'ended');}
}
