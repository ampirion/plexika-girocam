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
      return json(request, {service: 'Plexika Girocam relay', protocol: 4, ready: !!env.ALLOCATOR&&!!env.ROOMS, public: !!env.ALLOCATOR&&!!env.ROOMS, legacyKeyReady: configured, limit: Math.max(1,Math.min(100,Number(env.MAX_SESSIONS)||100))});
    }
    if (request.method === 'GET' && u.pathname === '/') {
      const text = !!env.ALLOCATOR&&!!env.ROOMS
        ? 'Сервер гирокама v4 готов. Открытый доступ: до 100 сеансов и очередь. Основной PAIRING_KEY пользователям не нужен. Бесплатные квоты Cloudflare остаются ограничением.'
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

// All v3 packets remain scoped to the authenticated host/phone WebSocket role.
const arr=(a,n,limit=1e9)=>Array.isArray(a)&&a.length===n&&a.every(x=>Number.isFinite(x)&&Math.abs(x)<=limit);
const uuid=s=>typeof s==='string'&&/^[a-f0-9-]{36}$/.test(s);
function validHost3(p){switch(p.type){
case 'full_begin':return uuid(p.id)&&Number.isInteger(p.length)&&p.length>0&&p.length<=64*1024*1024&&p.chunks===Math.ceil(p.length/40000)&&typeof p.hash==='string'&&/^[0-9a-f]{64}$/.test(p.hash)&&typeof p.media==='boolean';
case 'full_chunk':return uuid(p.id)&&Number.isInteger(p.index)&&p.index>=0&&p.index<1678&&typeof p.data==='string'&&p.data.length<=40000;
case 'full_end':case 'full_cancel':return uuid(p.id);
case 'clock_pong':return uuid(p.id)&&Number.isFinite(p.t)&&Number.isFinite(p.host);
case 'scene_begin':return uuid(p.id)&&Number.isInteger(p.total)&&p.total>=0&&p.total<=500;
case 'scene_chunk':return uuid(p.id)&&Array.isArray(p.objects)&&p.objects.length<=12&&p.objects.every(o=>o&&['box','sphere','plane'].includes(o.kind)&&typeof o.name==='string'&&o.name.length<=96&&arr(o.p,3)&&arr(o.s,3)&&o.s.every(x=>x>=0)&&arr(o.q,4,1.01)&&Math.abs(Math.hypot(...o.q)-1)<.01);
case 'scene_end':return uuid(p.id);
case 'pose_sync':return p.pose&&arr(p.pose.p,3)&&arr(p.pose.target,3)&&arr(p.pose.q,4,1.01)&&Math.abs(Math.hypot(...p.pose.q)-1)<.01&&Number.isFinite(p.pose.fov)&&p.pose.fov>=5&&p.pose.fov<=150&&typeof p.enabled==='boolean'&&Number.isFinite(p.gain)&&p.gain>=.1&&p.gain<=2&&Number.isFinite(p.smoothing)&&p.smoothing>=0&&p.smoothing<=.95;
case 'settings':return typeof p.enabled==='boolean'&&Number.isFinite(p.gain)&&p.gain>=.1&&p.gain<=2&&Number.isFinite(p.smoothing)&&p.smoothing>=0&&p.smoothing<=.95;
case 'record_start':return uuid(p.id)&&Number.isFinite(p.t0);
case 'record_stop':return uuid(p.id)&&Number.isFinite(p.end);
case 'record_ack':return uuid(p.id)&&Number.isInteger(p.index)&&p.index>=-1&&p.index<=1252;
case 'record_saved':return uuid(p.id);
case 'record_rejected':return uuid(p.id)&&typeof p.message==='string'&&p.message.length<=200;
default:return false;}}
function validPhone3(p){switch(p.type){
case 'full_ack':return uuid(p.id)&&Number.isInteger(p.index)&&p.index>=-1&&p.index<1678;
case 'full_loaded':return uuid(p.id);
case 'full_error':return uuid(p.id)&&typeof p.message==='string'&&p.message.length<=200;
case 'hello':return p.capabilities===3;
case 'camera_pose':return arr(p.p,3)&&arr(p.target,3)&&Number.isFinite(p.at)&&Math.hypot(...p.p.map((x,i)=>x-p.target[i]))>.01;
case 'sensor_state':return typeof p.active==='boolean';
case 'clock_ping':return uuid(p.id)&&Number.isFinite(p.t);
case 'record_mode':return typeof p.exact==='boolean';
case 'calibrate_request':case 'finish_request':case 'disconnect_notice':return true;
case 'record_ready':return uuid(p.id)&&Number.isFinite(p.uncertainty)&&p.uncertainty>=0&&p.uncertainty<10000;
case 'record_error':return uuid(p.id)&&typeof p.message==='string'&&p.message.length<=200;
case 'record_begin':return uuid(p.id)&&Number.isInteger(p.total)&&p.total>=1&&p.total<=60004&&Number.isInteger(p.chunks)&&p.chunks===Math.ceil(p.total/48)&&Number.isFinite(p.duration)&&p.duration>=0&&p.duration<=1000001&&Number.isFinite(p.uncertainty)&&p.uncertainty>=0&&p.uncertainty<10000;
case 'record_chunk':return uuid(p.id)&&Number.isInteger(p.index)&&p.index>=0&&p.index<1251&&Array.isArray(p.frames)&&p.frames.length>=1&&p.frames.length<=48&&p.frames.every((f,i)=>arr(f,7)&&f[0]>=0&&f[0]<=1000001&&(!i||f[0]>=p.frames[i-1][0]));
case 'record_end':case 'record_resume':case 'saved_ack':return uuid(p.id);
default:return false;}}

export class PlexikaRoom {
 constructor(ctx,env){this.ctx=ctx;this.env=env;}
 sockets(role){return this.ctx.getWebSockets(role).filter(w=>w.readyState===1);}
 send(ws,p){try{ws.send(JSON.stringify(p));}catch{}}
 async notify(meta,type,active){if(!meta?.publicMode)return;try{await this.env.ALLOCATOR.get(this.env.ALLOCATOR.idFromName('global')).fetch(new Request('https://allocator.internal/state',{method:'POST',body:JSON.stringify({room:meta.room,type,active})}));}catch{}}
 async revoke(){await this.ctx.storage.deleteAll();await this.ctx.storage.deleteAlarm();for(const w of this.ctx.getWebSockets())try{w.close(1000,'Session ended');}catch{}}
 async fetch(request){const u=new URL(request.url);if(u.hostname==='room.internal'){
 if(u.pathname==='/revoke'&&request.method==='POST'){await this.revoke();return new Response('Revoked');}
 if(u.pathname==='/init'&&request.method==='POST'){if(await this.ctx.storage.get('meta'))return new Response('Already initialized',{status:409});const meta=await request.json();await this.ctx.storage.put('meta',meta);await this.ctx.storage.setAlarm(meta.expiresAt);return new Response('Created',{status:201});}}
 const meta=await this.ctx.storage.get('meta');if(!meta||meta.expiresAt<=Date.now()||(meta.pendingUntil&&meta.pendingUntil<=Date.now()))return new Response('Session expired',{status:410});if(request.headers.get('Upgrade')?.toLowerCase()!=='websocket')return new Response('WebSocket required',{status:426});const role=u.searchParams.get('role');if(!['host','phone'].includes(role)||!same(u.searchParams.get('token'),meta[role+'Token']))return new Response('Invalid token',{status:401});const previous=this.sockets(role);if(previous.length&&role==='host')return new Response('Role already connected',{status:409});const pair=new WebSocketPair(),server=pair[1];meta.pendingUntil=role==='host'&&!this.sockets('phone').length?Date.now()+180000:null;await this.ctx.storage.put('meta',meta);await this.ctx.storage.setAlarm(Math.min(meta.expiresAt,meta.pendingUntil||meta.expiresAt));this.ctx.acceptWebSocket(server,[role]);server.serializeAttachment({role,second:0,count:0});for(const old of previous)try{old.close(1000,'Phone reconnected');}catch{}const other=role==='host'?'phone':'host';this.send(server,{type:'peer',connected:this.sockets(other).length>0});for(const w of this.sockets(other))this.send(w,{type:'peer',connected:true});if(role==='host')await this.notify(meta,'claimed');return new Response(null,{status:101,webSocket:pair[0]});}
 async webSocketMessage(ws,message){if(ws.readyState!==1)return;const a=ws.deserializeAttachment(),meta=await this.ctx.storage.get('meta');if(!a||!meta||meta.expiresAt<=Date.now()){ws.close(1008,'Session expired');return;}if(typeof message!=='string'||message.length>65536){ws.close(1009,'Too large');return;}const second=Math.floor(Date.now()/1000);if(a.second!==second){a.second=second;a.count=0;}a.count++;ws.serializeAttachment(a);if(a.count>(a.role==='host'?30:60)){ws.close(1008,'Rate exceeded');return;}let p;try{p=JSON.parse(message);}catch{ws.close(1008,'Invalid JSON');return;}if(!p||typeof p!=='object'){ws.close(1008,'Invalid packet');return;}if(p.type==='ping'){this.send(ws,{type:'pong'});return;}
 if(a.role==='host'){
 if(validHost3(p)){for(const phone of this.sockets('phone'))this.send(phone,p);return;}
 if(p.type==='recording'&&typeof p.active==='boolean'){await this.notify(meta,'recording',p.active);return;}
 if(p.type==='preview'&&typeof p.data==='string'&&p.data.startsWith('data:image/jpeg;base64,')&&p.data.length<=60000&&p.w===320&&p.h===180){for(const phone of this.sockets('phone'))this.send(phone,{type:'preview',v:2,data:p.data,w:320,h:180});return;}
 if(p.type==='freeze_ack'&&typeof p.held==='boolean'){for(const phone of this.sockets('phone'))this.send(phone,{type:'freeze_ack',held:p.held});return;}
 ws.close(1008,'Invalid host command');return;}
 if(!same(p.token,meta.phoneToken)){ws.close(1008,'Invalid packet token');return;}
 if(p.v===3&&validPhone3(p)){for(const host of this.sockets('host'))this.send(host,p);return;}
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
