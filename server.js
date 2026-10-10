'use strict';
/*
 * IRONVEIL: HOLD THE YARD — LAN co-op server
 *
 * - Serves the game from ./public (so the game and the Socket.IO connection share one host and port).
 * - Owns room membership, player identities and the shared shooting-range target state.
 * - Validates and relays the small amount of per-player state the clients need to draw each other.
 *   Clients keep full control of their own camera and movement (no server round-trip on input).
 *
 * Run:  npm install  &&  npm start          (PORT=3000 HOST=0.0.0.0 MAX_PLAYERS=2 by default)
 */
const path = require('path');
const http = require('http');
const os = require('os');
const crypto = require('crypto');
const express = require('express');
const { Server } = require('socket.io');

// ---------------------------------------------------------------- configuration
const PORT = parseInt(process.env.PORT || '3000', 10);
const HOST = process.env.HOST || '0.0.0.0';                 // all interfaces, so other devices on the LAN can connect
const MAX_PLAYERS = clampInt(parseInt(process.env.MAX_PLAYERS || '2', 10), 2, 8);
const GAME_VERSION = 'ironveil-lan-1';                       // clients must send the same protocol version
const RECONNECT_GRACE_MS = 30000;                            // a dropped player keeps their slot (and model) this long
const SWEEP_MS = 5000;
const CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ';            // no I / O: easy to read out loud
const CODE_LEN = 4;
const WORLD = { x0: 55, x1: 105, y0: -3, y1: 14, z0: -90, z1: 55 };   // shooting range (+ margin), game units = metres
const SPAWN = { x: 80, z: 42.2, r: 8 };
const MAX_SPEED = 16;                                        // m/s; sprint + slide in the game stays well under this
const HISTORY_SHOTS = 32;

function clampInt(v, lo, hi) { return Number.isFinite(v) ? Math.max(lo, Math.min(hi, v)) : lo; }

// ---------------------------------------------------------------- small validation helpers
const isObj = v => v !== null && typeof v === 'object' && !Array.isArray(v);
const isNum = (v, lo = -Infinity, hi = Infinity) => typeof v === 'number' && Number.isFinite(v) && v >= lo && v <= hi;
const isInt = (v, lo, hi) => Number.isInteger(v) && v >= lo && v <= hi;
const inBox = (p, b) => p[0] >= b.x0 && p[0] <= b.x1 && p[1] >= b.y0 && p[1] <= b.y1 && p[2] >= b.z0 && p[2] <= b.z1;
const isVec3 = (a, box) => Array.isArray(a) && a.length === 3 && a.every(x => isNum(x)) && (!box || inBox(a, box));
const r3 = v => Math.round(v * 1000) / 1000;
const r2 = v => Math.round(v * 100) / 100;
const dist3 = (a, b) => Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);
const wrapA = a => { a = (a + Math.PI) % (Math.PI * 2); if (a < 0) a += Math.PI * 2; return a - Math.PI; };
const bit = v => (v ? 1 : 0);
const cleanName = s => (typeof s === 'string' ? s.toUpperCase().replace(/[^A-Z0-9 _-]/g, '').replace(/\s+/g, ' ').trim().slice(0, 12) : '');
const PARTS = new Set(['head', 'body', 'arm', 'leg', 'steel']);
const KINDS = new Set(['paper', 'popper', 'mover', 'dummy', 'plate']);

// token bucket rate limiter
function bucket(rate, burst) { return { rate, burst, tokens: burst, t: Date.now() }; }
function take(b, n = 1) {
  const now = Date.now();
  b.tokens = Math.min(b.burst, b.tokens + ((now - b.t) / 1000) * b.rate); b.t = now;
  if (b.tokens < n) return false;
  b.tokens -= n; return true;
}
const LIMITS = { state: [40, 20], fire: [30, 12], hit: [160, 48], weapon: [8, 4], reload: [4, 3], range: [2, 3], ping: [6, 6], room: [3, 5] };
const newBuckets = () => Object.fromEntries(Object.entries(LIMITS).map(([k, [r, b]]) => [k, bucket(r, b)]));

// ---------------------------------------------------------------- game configuration sent by the host (layout + weapon table)
// Both players run the same game build, so the host describes the range it built (target kinds/positions) and the weapon
// table; the server sanity-checks it, uses it to validate hits, and a joining player must present an identical copy.
function normalizeCfg(cfg) {
  if (!isObj(cfg) || !Array.isArray(cfg.layout) || !isObj(cfg.weapons)) return null;
  if (cfg.layout.length < 1 || cfg.layout.length > 64) return null;
  const layout = [];
  for (const t of cfg.layout) {
    if (!isObj(t) || !KINDS.has(t.k) || !isVec3(t.p, WORLD)) return null;
    const e = { k: t.k, p: t.p.map(r2) };
    if (t.k === 'dummy') { if (!isNum(t.hp, 1, 5000)) return null; e.hp = r2(t.hp); e.heavy = bit(t.heavy); }
    if (t.k === 'mover') { if (!Array.isArray(t.rail) || t.rail.length !== 2 || !t.rail.every(v => isNum(v, WORLD.x0, WORLD.x1))) return null; e.rail = t.rail.map(r2); }
    layout.push(e);
  }
  const ids = Object.keys(cfg.weapons);
  if (ids.length < 1 || ids.length > 16) return null;
  const weapons = {};
  for (const id of ids) {
    const w = cfg.weapons[id];
    if (!/^[a-z]{2,12}$/.test(id) || !isObj(w)) return null;
    if (!isNum(w.dmg, 1, 500) || !isNum(w.head, 1, 10) || !isInt(w.pellets, 1, 16) || !isNum(w.rate, 0.02, 3)) return null;
    weapons[id] = { dmg: r2(w.dmg), head: r2(w.head), pellets: w.pellets, rate: r3(w.rate), snd: typeof w.snd === 'string' ? w.snd.slice(0, 12) : id };
  }
  return { layout, weapons };
}
const cfgHash = cfg => crypto.createHash('sha1').update(JSON.stringify(cfg)).digest('hex').slice(0, 16);

// ---------------------------------------------------------------- rooms
const rooms = new Map();          // code -> room
const tokens = new Map();         // reconnect token -> { code, id }

function newCode() {
  for (let i = 0; i < 5000; i++) {
    let c = '';
    for (let k = 0; k < CODE_LEN; k++) c += CODE_ALPHABET[crypto.randomInt(CODE_ALPHABET.length)];
    if (!rooms.has(c)) return c;
  }
  throw new Error('out of room codes');
}
const newId = () => crypto.randomBytes(4).toString('hex');
const newToken = () => crypto.randomBytes(16).toString('hex');

function initTargets(layout) {
  return layout.map(t => {
    if (t.k === 'paper') return { holes: [] };
    if (t.k === 'popper' || t.k === 'mover') return { downAt: 0 };
    if (t.k === 'dummy') return { hp: t.hp, alive: true, downAt: 0 };
    return {};
  });
}
function createRoom(cfg) {
  const code = newCode(), now = Date.now();
  const room = { code, createdAt: now, cfg, hash: cfgHash(cfg), players: new Map(), targets: initTargets(cfg.layout),
    mover: { moving: true, ph0: Math.random() * Math.PI * 2, t0: now } };
  rooms.set(code, room);
  return room;
}
function moverPhase(room, now) { const m = room.mover; return m.ph0 + (m.moving ? ((now - m.t0) / 1000) * 0.42 : 0); }

// shared target state, evaluated lazily against wall-clock time (dummies stand back up 3 s after going down, poppers ~2.9 s)
const DUMMY_RESET_MS = 3000, POPPER_CYCLE_MS = 2900;
function refreshTarget(room, i, now) {
  const L = room.cfg.layout[i], s = room.targets[i];
  if (L.k === 'dummy' && !s.alive && now - s.downAt > DUMMY_RESET_MS) { s.alive = true; s.hp = L.hp; s.downAt = 0; }
  if ((L.k === 'popper' || L.k === 'mover') && s.downAt && now - s.downAt > POPPER_CYCLE_MS) s.downAt = 0;
}
function targetSnapshot(room, now) {
  return room.cfg.layout.map((L, i) => {
    refreshTarget(room, i, now);
    const s = room.targets[i];
    if (L.k === 'paper') return { k: L.k, holes: s.holes };
    if (L.k === 'popper' || L.k === 'mover') return { k: L.k, downAgo: s.downAt ? now - s.downAt : -1 };
    if (L.k === 'dummy') return { k: L.k, hp: r2(s.hp), alive: s.alive, downAgo: s.alive ? -1 : now - s.downAt };
    return { k: L.k };
  });
}
function resetTargets(room) { room.targets = initTargets(room.cfg.layout); }

function publicPlayer(p) {
  return { id: p.id, slot: p.slot, name: p.name, host: p.host, connected: p.connected, w: p.w, sup: p.sup, state: p.state };
}
function roomSnapshot(room) {
  const now = Date.now();
  return { code: room.code, maxPlayers: MAX_PLAYERS, serverNow: now, players: [...room.players.values()].map(publicPlayer),
    targets: targetSnapshot(room, now), mover: room.mover };
}
function freeSlot(room) { const used = new Set([...room.players.values()].map(p => p.slot)); for (let s = 0; s < MAX_PLAYERS; s++) if (!used.has(s)) return s; return -1; }

function addPlayer(room, socket, name, host) {
  const p = { id: newId(), slot: freeSlot(room), name: name || (host ? 'HOST' : 'PLAYER ' + (room.players.size + 1)), host, token: newToken(),
    socketId: socket.id, connected: true, joinedAt: Date.now(), state: null, stateAt: 0, pos: null, w: 'ar', sup: 0,
    lastSeq: 0, lastFireAt: 0, shots: [], buckets: newBuckets(), graceTimer: null };
  room.players.set(p.id, p);
  tokens.set(p.token, { code: room.code, id: p.id });
  bindSocket(socket, room, p);
  return p;
}
function bindSocket(socket, room, p) {
  if (p.graceTimer) { clearTimeout(p.graceTimer); p.graceTimer = null; }
  p.socketId = socket.id; p.connected = true;
  socket.data.code = room.code; socket.data.pid = p.id;
  socket.join(room.code);
}
function removePlayer(room, pid, reason) {
  const p = room.players.get(pid);
  if (!p) return;
  if (p.graceTimer) clearTimeout(p.graceTimer);
  room.players.delete(pid);
  tokens.delete(p.token);
  const sock = io.sockets.sockets.get(p.socketId);
  if (sock && sock.data.pid === pid) { sock.leave(room.code); sock.data.code = null; sock.data.pid = null; }
  let newHost = null;
  if (p.host && room.players.size) {                       // hand the "host" badge to whoever is left
    const next = [...room.players.values()].sort((a, b) => a.slot - b.slot)[0];
    next.host = true; newHost = next.id;
  }
  io.to(room.code).emit('player:left', { id: pid, name: p.name, reason, newHost });
  if (!room.players.size) rooms.delete(room.code);
  log(`room ${room.code}: ${p.name} left (${reason}); ${room.players.size} player(s) remain`);
}

// ---------------------------------------------------------------- server
const app = express();
app.disable('x-powered-by');
app.use(express.static(path.join(__dirname, 'public'), { extensions: ['html'] }));
// connection test: open http://<host-ip>:3000/status on any device to see the rooms and who is in them
app.get('/status', (req, res) => {
  res.json({ ok: true, game: 'IRONVEIL LAN', version: GAME_VERSION, maxPlayers: MAX_PLAYERS, uptimeS: Math.round(process.uptime()),
    rooms: [...rooms.values()].map(r => ({ code: r.code, ageS: Math.round((Date.now() - r.createdAt) / 1000),
      players: [...r.players.values()].map(p => ({ name: p.name, slot: p.slot, host: p.host, connected: p.connected })) })) });
});

const server = http.createServer(app);
const io = new Server(server, { pingInterval: 10000, pingTimeout: 8000, maxHttpBufferSize: 64 * 1024, serveClient: true });

const QUIET = process.env.QUIET === '1';
function log(...a) { if (!QUIET) console.log(new Date().toISOString().slice(11, 19), ...a); }
function sendError(socket, code, message) { socket.emit('multiplayer:error', { code, message }); }

// every handler runs inside try/catch so a malformed message can never take the server down
function on(socket, ev, fn) {
  socket.on(ev, (...args) => {
    try { fn(...args); } catch (e) { log(`handler ${ev} failed:`, e && e.message); }
  });
}

io.on('connection', socket => {
  socket.data.code = null; socket.data.pid = null; socket.data.buckets = newBuckets();
  const member = () => {
    const room = socket.data.code && rooms.get(socket.data.code);
    const p = room && room.players.get(socket.data.pid);
    return room && p && p.socketId === socket.id ? { room, p } : null;
  };
  const leaveCurrent = reason => { const m = member(); if (m) removePlayer(m.room, m.p.id, reason); };

  // ---- room:create  { name, ver, cfg }  ->  room:created | multiplayer:error
  on(socket, 'room:create', msg => {
    if (!take(socket.data.buckets.room)) return sendError(socket, 'RATE_LIMIT', 'Slow down — try again in a moment.');
    if (!isObj(msg)) return sendError(socket, 'BAD_REQUEST', 'Malformed request.');
    if (msg.ver !== GAME_VERSION) return sendError(socket, 'VERSION_MISMATCH', 'This game build does not match the server. Reload the page.');
    const cfg = normalizeCfg(msg.cfg);
    if (!cfg) return sendError(socket, 'BAD_REQUEST', 'The game sent an invalid range description.');
    leaveCurrent('left');
    const room = createRoom(cfg), p = addPlayer(room, socket, cleanName(msg.name), true);
    socket.emit('room:created', { code: room.code, you: { id: p.id, slot: p.slot, token: p.token, host: true }, room: roomSnapshot(room) });
    log(`room ${room.code} created by ${p.name}`);
  });

  // ---- room:join  { code, name, ver, cfg, token? }  ->  room:joined (+ player:joined to the others) | multiplayer:error
  on(socket, 'room:join', msg => {
    if (!take(socket.data.buckets.room)) return sendError(socket, 'RATE_LIMIT', 'Slow down — try again in a moment.');
    if (!isObj(msg) || typeof msg.code !== 'string') return sendError(socket, 'BAD_REQUEST', 'Enter a room code.');
    const code = msg.code.toUpperCase().replace(/[^A-Z]/g, '');
    if (code.length !== CODE_LEN) return sendError(socket, 'INVALID_CODE', `Room codes are ${CODE_LEN} letters.`);
    if (msg.ver !== GAME_VERSION) return sendError(socket, 'VERSION_MISMATCH', 'This game build does not match the server. Reload the page.');
    const room = rooms.get(code);
    if (!room) return sendError(socket, 'ROOM_NOT_FOUND', `No room ${code} on this server. Check the code with the host.`);
    const cfg = normalizeCfg(msg.cfg);
    if (!cfg || cfgHash(cfg) !== room.hash) return sendError(socket, 'VERSION_MISMATCH', 'Your copy of the game differs from the host\'s. Open the game from the host\'s address.');
    // a valid reconnect token for this room takes the player's old slot back (no duplicate player)
    const tk = typeof msg.token === 'string' && tokens.get(msg.token);
    if (tk && tk.code === code && room.players.has(tk.id)) {
      const p = room.players.get(tk.id);
      const old = io.sockets.sockets.get(p.socketId); if (old && old.id !== socket.id) { old.leave(code); old.data.code = null; old.data.pid = null; }
      leaveCurrent('left');
      bindSocket(socket, room, p);
      socket.emit('room:joined', { code, rejoin: true, you: { id: p.id, slot: p.slot, token: p.token, host: p.host }, room: roomSnapshot(room) });
      socket.to(code).emit('player:status', { id: p.id, connected: true });
      log(`room ${code}: ${p.name} rejoined`);
      return;
    }
    if (room.players.size >= MAX_PLAYERS) {
      const waiting = [...room.players.values()].some(p => !p.connected);
      return sendError(socket, 'ROOM_FULL', `Room ${code} is full (${MAX_PLAYERS}/${MAX_PLAYERS}).` + (waiting ? ' A player who dropped is holding a slot — try again in 30 s.' : ''));
    }
    leaveCurrent('left');
    const p = addPlayer(room, socket, cleanName(msg.name), false);
    socket.emit('room:joined', { code, you: { id: p.id, slot: p.slot, token: p.token, host: false }, room: roomSnapshot(room) });
    socket.to(code).emit('player:joined', publicPlayer(p));
    log(`room ${code}: ${p.name} joined (${room.players.size}/${MAX_PLAYERS})`);
  });

  // ---- room:rejoin  { code, token }  (automatic after a dropped connection)
  on(socket, 'room:rejoin', msg => {
    if (!take(socket.data.buckets.room)) return;
    if (!isObj(msg) || typeof msg.token !== 'string') return;
    const tk = tokens.get(msg.token), room = tk && rooms.get(tk.code), p = room && room.players.get(tk.id);
    if (!p || tk.code !== msg.code) return sendError(socket, 'REJOIN_FAILED', 'Your seat in the room expired. Join again from the menu.');
    const old = io.sockets.sockets.get(p.socketId); if (old && old.id !== socket.id) { old.leave(room.code); old.data.code = null; old.data.pid = null; }
    bindSocket(socket, room, p);
    socket.emit('room:joined', { code: room.code, rejoin: true, you: { id: p.id, slot: p.slot, token: p.token, host: p.host }, room: roomSnapshot(room) });
    socket.to(room.code).emit('player:status', { id: p.id, connected: true });
    log(`room ${room.code}: ${p.name} reconnected`);
  });

  // ---- room:leave
  on(socket, 'room:leave', () => leaveCurrent('left'));

  // ---- player:state  { p:[x,y,z], y:yaw, pi:pitch, cr, sp, ad, w, rl, gr, pa, tp }  (~20 Hz, relayed volatile)
  on(socket, 'player:state', s => {
    const m = member(); if (!m || !isObj(s)) return;
    const { room, p } = m;
    if (!take(p.buckets.state)) return;
    if (!isVec3(s.p, WORLD) || !isNum(s.y) || !isNum(s.pi, -2, 2)) return;
    const now = Date.now();
    if (p.pos && p.stateAt) {
      const dt = Math.max(0.05, (now - p.stateAt) / 1000), d = dist3(s.p, p.pos);
      const nearSpawn = Math.hypot(s.p[0] - SPAWN.x, s.p[2] - SPAWN.z) < SPAWN.r;
      if (d > MAX_SPEED * dt + 1.5 && !(s.tp && nearSpawn)) return;          // ignore impossible jumps (teleports only to the spawn)
    }
    const w = typeof s.w === 'string' && room.cfg.weapons[s.w] ? s.w : p.w;
    const st = { p: s.p.map(r3), y: r3(wrapA(s.y)), pi: r3(Math.max(-1.5, Math.min(1.5, s.pi))), cr: bit(s.cr), sp: bit(s.sp), ad: bit(s.ad),
      w, rl: bit(s.rl), gr: s.gr === undefined ? 1 : bit(s.gr), pa: bit(s.pa), tp: bit(s.tp) };
    p.state = st; p.pos = st.p; p.stateAt = now; p.w = w;
    socket.to(room.code).volatile.emit('player:state', Object.assign({ id: p.id, t: now }, st));
  });

  // ---- player:fire  { seq, w, o:[x,y,z], e:[[x,y,z],…], sup }
  on(socket, 'player:fire', f => {
    const m = member(); if (!m || !isObj(f)) return;
    const { room, p } = m, W = room.cfg.weapons[f.w], now = Date.now();
    if (!W || !isInt(f.seq, 1, 1e9) || f.seq <= p.lastSeq || !isVec3(f.o, WORLD) || !Array.isArray(f.e) || f.e.length > W.pellets) return;
    if (now - p.lastFireAt < W.rate * 1000 * 0.45 || !take(p.buckets.fire)) return;
    const big = { x0: f.o[0] - 420, x1: f.o[0] + 420, y0: f.o[1] - 420, y1: f.o[1] + 420, z0: f.o[2] - 420, z1: f.o[2] + 420 };
    if (!f.e.every(e => isVec3(e, big))) return;
    if (p.pos && dist3(f.o, p.pos) > 4) return;                               // must fire from where they stand (eye ≈ feet + 1.6 m)
    p.lastSeq = f.seq; p.lastFireAt = now; p.w = f.w;
    p.shots.push({ seq: f.seq, w: f.w, t: now, used: new Set() }); if (p.shots.length > HISTORY_SHOTS) p.shots.shift();
    socket.to(room.code).emit('player:fire', { id: p.id, seq: f.seq, w: f.w, o: f.o.map(r3), e: f.e.map(e => e.map(r2)), sup: bit(f.sup) });
  });

  // ---- player:reload  { w, dur, e }
  on(socket, 'player:reload', r => {
    const m = member(); if (!m || !isObj(r)) return;
    const { room, p } = m;
    if (!room.cfg.weapons[r.w] || !isNum(r.dur, 0.2, 8) || !take(p.buckets.reload)) return;
    socket.to(room.code).emit('player:reload', { id: p.id, w: r.w, dur: r2(r.dur), e: bit(r.e) });
  });

  // ---- player:weapon  { w, sup }
  on(socket, 'player:weapon', r => {
    const m = member(); if (!m || !isObj(r)) return;
    const { room, p } = m;
    if (!room.cfg.weapons[r.w] || !take(p.buckets.weapon)) return;
    p.w = r.w; p.sup = bit(r.sup);
    socket.to(room.code).emit('player:weapon', { id: p.id, w: p.w, sup: p.sup });
  });

  // ---- target:hit  { tid, seq, k, part, dmg, pt:[x,y,z], d:[x,y,z] }   (server-validated, then shared)
  on(socket, 'target:hit', h => {
    const m = member(); if (!m || !isObj(h)) return;
    const { room, p } = m, now = Date.now();
    if (!take(p.buckets.hit)) return;
    const L = isInt(h.tid, 0, room.cfg.layout.length - 1) && room.cfg.layout[h.tid];
    if (!L || !isInt(h.seq, 1, 1e9) || !PARTS.has(h.part) || !isVec3(h.pt) || !isVec3(h.d)) return;
    const shot = p.shots.find(s => s.seq === h.seq);
    if (!shot || now - shot.t > 1500) return;                                 // a hit must belong to a shot we just relayed
    const W = room.cfg.weapons[shot.w];
    if (!isInt(h.k, 0, W.pellets - 1) || shot.used.has(h.k)) return;          // one target per pellet, no duplicates
    if (!isNum(h.dmg, 0.01, W.dmg * 1.25 * W.head + 0.01)) return;            // hollow points (x1.25) and headshot multiplier at most
    const dl = Math.hypot(h.d[0], h.d[1], h.d[2]); if (dl < 0.9 || dl > 1.1) return;
    const T = L.p;
    const near = L.k === 'mover'
      ? h.pt[0] >= L.rail[0] - 2 && h.pt[0] <= L.rail[1] + 2 && Math.abs(h.pt[2] - T[2]) < 2.5 && h.pt[1] > T[1] - 0.5 && h.pt[1] < T[1] + 3
      : dist3(h.pt, T) < 3.5;
    if (!near || !p.pos || dist3(p.pos, T) > 360) return;
    shot.used.add(h.k);
    // update the authoritative range state
    refreshTarget(room, h.tid, now);
    const s = room.targets[h.tid];
    if (L.k === 'paper') { s.holes.push({ pt: h.pt.map(r3), d: h.d.map(r3), part: h.part }); if (s.holes.length > 60) s.holes.shift(); }
    else if ((L.k === 'popper' || L.k === 'mover') && !s.downAt) s.downAt = now;
    else if (L.k === 'dummy' && s.alive) { s.hp -= L.heavy && h.part !== 'head' ? h.dmg * 0.85 : h.dmg; if (s.hp <= 0) { s.alive = false; s.downAt = now; } }
    socket.to(room.code).emit('target:hit', { by: p.id, hid: h.seq * 32 + h.k, tid: h.tid, part: h.part, dmg: r2(h.dmg), pt: h.pt.map(r3), d: h.d.map(r3) });
  });

  // ---- range:reset  {}   (T key)  -> everyone resets the targets
  on(socket, 'range:reset', () => {
    const m = member(); if (!m || !take(m.p.buckets.range)) return;
    resetTargets(m.room);
    socket.to(m.room.code).emit('range:reset', { by: m.p.id, name: m.p.name });
  });

  // ---- range:mover  { moving }   (armory toggle for the moving popper) -> shared phase for everyone
  on(socket, 'range:mover', r => {
    const m = member(); if (!m || !isObj(r) || !take(m.p.buckets.range)) return;
    const now = Date.now(), room = m.room;
    room.mover = { moving: !!r.moving, ph0: moverPhase(room, now), t0: now };
    io.to(room.code).emit('range:mover', Object.assign({ by: m.p.id }, room.mover));
  });

  // ---- time:ping  (ack with server clock, used for interpolation timing)
  on(socket, 'time:ping', ack => { if (typeof ack === 'function' && take(socket.data.buckets.ping)) ack(Date.now()); });

  on(socket, 'disconnect', () => {
    const m = member(); if (!m) return;
    const { room, p } = m;
    p.connected = false;
    io.to(room.code).emit('player:status', { id: p.id, connected: false });
    log(`room ${room.code}: ${p.name} lost connection (holding slot ${RECONNECT_GRACE_MS / 1000}s)`);
    p.graceTimer = setTimeout(() => { if (rooms.get(room.code) === room && !p.connected) removePlayer(room, p.id, 'timeout'); }, RECONNECT_GRACE_MS);
  });
});

// housekeeping: drop rooms whose every player is gone or disconnected for too long (timers normally handle this)
setInterval(() => {
  const now = Date.now();
  for (const room of rooms.values()) {
    if (!room.players.size) { rooms.delete(room.code); continue; }
    for (const p of [...room.players.values()]) if (!p.connected && !p.graceTimer) removePlayer(room, p.id, 'timeout');
    for (let i = 0; i < room.targets.length; i++) refreshTarget(room, i, now);
  }
}, SWEEP_MS).unref();

process.on('uncaughtException', e => log('uncaught:', e && e.stack || e));

function lanAddresses() {
  const out = [];
  for (const [name, list] of Object.entries(os.networkInterfaces())) for (const a of list || []) if (a.family === 'IPv4' && !a.internal) out.push({ name, address: a.address });
  return out;
}

server.on('error', e => {
  if (e.code === 'EADDRINUSE') console.error(`Port ${PORT} is already in use. Close the other program or start with another port, e.g.  PORT=3100 npm start`);
  else console.error('Server error:', e.message);
  process.exit(1);
});

if (require.main === module) {
  server.listen(PORT, HOST, () => {
    console.log('\n  IRONVEIL LAN server is running');
    console.log(`  On this computer:      http://localhost:${PORT}`);
    const lan = lanAddresses();
    if (lan.length) for (const a of lan) console.log(`  Other devices (Wi-Fi): http://${a.address}:${PORT}    (${a.name})`);
    else console.log('  No LAN address found — is this computer connected to Wi-Fi / Ethernet?');
    console.log(`  Connection test:       http://<address above>:${PORT}/status`);
    console.log(`  Max players per room:  ${MAX_PLAYERS}\n`);
  });
}

module.exports = { server, io, rooms, GAME_VERSION, MAX_PLAYERS, PORT };
