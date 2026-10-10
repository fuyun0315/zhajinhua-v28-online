'use strict';
const express = require('express');
const http = require('http');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { Server } = require('socket.io');

const PORT = Number(process.env.PORT || 3000);
const MAX_PLAYERS = 6;
const ANTE = 20;
const ROOM_IDLE_MS = 10 * 60 * 1000;
const TURN_SECONDS = 20;
const DATA_FILE = process.env.DATA_FILE || process.env.ACCOUNTS_FILE || path.join(__dirname, 'data', 'game-data.json');
const SESSION_SECRET = process.env.SESSION_SECRET || 'change-this-secret-in-railway-v31';
const SESSION_COOKIE = 'zhj_session';
const SESSION_DAYS = 30;

function loadData() {
  try {
    const d = JSON.parse(fs.readFileSync(DATA_FILE, 'utf8'));
    if (d.accounts && typeof d.accounts === 'object') return { accounts: d.accounts, peakOnline: Number(d.peakOnline) || 0, totalGames: Number(d.totalGames) || 0 };
    // Backward-compatible import of the V29/V30 flat accounts.json format.
    const looksLikeLegacyAccounts = d && typeof d === 'object' && Object.values(d).some(v => v && typeof v === 'object' && v.salt && v.hash);
    return { accounts: looksLikeLegacyAccounts ? d : {}, peakOnline: Number(d.peakOnline) || 0, totalGames: Number(d.totalGames) || 0 };
  } catch { return { accounts: {}, peakOnline: 0, totalGames: 0 }; }
}
let data = loadData();
function saveData() {
  try {
    fs.mkdirSync(path.dirname(DATA_FILE), { recursive: true });
    const tmp = DATA_FILE + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(data, null, 2), { mode: 0o600 });
    fs.renameSync(tmp, DATA_FILE);
    return true;
  } catch (e) { console.error('Persistent data save failed:', e.message, 'DATA_FILE=', DATA_FILE); return false; }
}
function safeName(v) { return String(v || '玩家').trim().replace(/[<>\u0000-\u001f]/g, '').slice(0, 12) || '玩家'; }
function usernameOf(v) { return String(v || '').trim().toLowerCase(); }
function hashPassword(password, salt = crypto.randomBytes(16).toString('hex')) {
  return { salt, hash: crypto.scryptSync(String(password), salt, 64).toString('hex') };
}
function verifyPassword(password, account) {
  try { const h = Buffer.from(hashPassword(String(password || ''), account.salt).hash, 'hex'); const expected = Buffer.from(account.hash, 'hex'); return h.length === expected.length && crypto.timingSafeEqual(h, expected); } catch { return false; }
}
function tokenFor(username) {
  const payload = Buffer.from(JSON.stringify({ u: username, exp: Date.now() + SESSION_DAYS * 86400000 })).toString('base64url');
  const sig = crypto.createHmac('sha256', SESSION_SECRET).update(payload).digest('base64url');
  return payload + '.' + sig;
}
function userFromToken(token) {
  try {
    const [payload, sig] = String(token || '').split('.');
    if (!payload || !sig) return null;
    const expected = crypto.createHmac('sha256', SESSION_SECRET).update(payload).digest();
    const actual = Buffer.from(sig, 'base64url');
    if (actual.length !== expected.length || !crypto.timingSafeEqual(actual, expected)) return null;
    const obj = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'));
    if (!obj.u || !obj.exp || obj.exp < Date.now() || !data.accounts[obj.u]) return null;
    return obj.u;
  } catch { return null; }
}
function parseCookies(header = '') {
  const out = {};
  for (const item of String(header).split(';')) {
    const i = item.indexOf('='); if (i < 0) continue;
    const k = item.slice(0, i).trim();
    try { out[k] = decodeURIComponent(item.slice(i + 1).trim()); } catch { out[k] = item.slice(i + 1).trim(); }
  }
  return out;
}
function cookieOptions(req) {
  return { httpOnly: true, sameSite: 'lax', secure: !!(req.secure || req.headers['x-forwarded-proto'] === 'https'), maxAge: SESSION_DAYS * 86400000, path: '/' };
}
function profile(username) {
  const a = data.accounts[username];
  return a ? { username, name: a.name, chips: a.chips, wins: a.wins || 0, games: a.games || 0 } : null;
}
const app = express();
app.set('trust proxy', 1);
app.use(express.json({ limit: '32kb' }));
app.get('/health', (_req, res) => res.json({ ok: true, version: 'V32', rooms: rooms.size, online: onlineCount(), peakOnline: data.peakOnline, totalGames: data.totalGames, uptime: Math.floor(process.uptime()) }));
app.get('/api/stats', (_req, res) => res.json(stats()));
app.get('/api/me', (req, res) => {
  const username = userFromToken(parseCookies(req.headers.cookie)[SESSION_COOKIE]);
  if (!username) return res.json({ ok: true, authenticated: false, stats: stats() });
  res.json({ ok: true, authenticated: true, user: profile(username), stats: stats() });
});
app.post('/api/register', (req, res) => {
  const username = usernameOf(req.body?.username); const password = String(req.body?.password || '');
  const name = safeName(req.body?.name || username);
  if (!/^[a-z0-9_]{3,20}$/.test(username)) return res.status(400).json({ ok: false, message: '用户名需为3-20位英文字母、数字或下划线。' });
  if (password.length < 6 || password.length > 72) return res.status(400).json({ ok: false, message: '密码长度需为6-72位。' });
  if (data.accounts[username]) return res.status(409).json({ ok: false, message: '用户名已存在，请直接登录。' });
  const ph = hashPassword(password);
  data.accounts[username] = { ...ph, name, chips: 1000, wins: 0, games: 0, createdAt: new Date().toISOString() };
  if (!saveData()) { delete data.accounts[username]; return res.status(500).json({ ok: false, message: '账号保存失败。请检查 Railway 持久化存储配置。' }); }
  res.cookie(SESSION_COOKIE, tokenFor(username), cookieOptions(req));
  res.json({ ok: true, user: profile(username), stats: stats() });
});
app.post('/api/login', (req, res) => {
  const username = usernameOf(req.body?.username); const password = String(req.body?.password || '');
  const a = data.accounts[username];
  if (!a || !verifyPassword(password, a)) return res.status(401).json({ ok: false, message: '用户名或密码错误。' });
  res.cookie(SESSION_COOKIE, tokenFor(username), cookieOptions(req));
  res.json({ ok: true, user: profile(username), stats: stats() });
});
app.post('/api/logout', (req, res) => { res.clearCookie(SESSION_COOKIE, { httpOnly: true, sameSite: 'lax', secure: !!(req.secure || req.headers['x-forwarded-proto'] === 'https'), path: '/' }); res.json({ ok: true }); });
app.use(express.static(path.join(__dirname, 'public')));
const server = http.createServer(app);
const io = new Server(server, { cors: { origin: false }, pingInterval: 25000, pingTimeout: 20000 });
const rooms = new Map();
const onlineSockets = new Map(); // username -> Set(socketId)
const suits = ['♠', '♥', '♦', '♣'];
const ranks = ['2','3','4','5','6','7','8','9','10','J','Q','K','A'];
let nextEventId = 1;

function onlineCount() { return [...onlineSockets.values()].filter(set => set.size > 0).length; }
function stats() { return { online: onlineCount(), peakOnline: data.peakOnline, totalGames: data.totalGames }; }
function broadcastStats() { io.emit('stats', stats()); }
function updatePeak() {
  const n = onlineCount();
  if (n > data.peakOnline) { data.peakOnline = n; saveData(); }
  broadcastStats();
}
function code() { let s; do { s = String(Math.floor(100000 + Math.random() * 900000)); } while (rooms.has(s)); return s; }
function shuffledDeck() {
  const d = []; for (const s of suits) for (const r of ranks) d.push({ s, r });
  for (let i = d.length - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1)); [d[i], d[j]] = [d[j], d[i]]; }
  return d;
}
function freshPlayer({ id = crypto.randomUUID(), accountId = null, name, isBot = false, chips = 1000 } = {}) {
  return { id, accountId, leftRoom: false, name: safeName(name), isBot, chips: Number(chips) || 0, cards: [], out: false, reveal: false, seen: false, bet: 0, totalBet: 0, allIn: false, connected: !!isBot, socketId: null, ready: !!isBot, trustee: false, timeLeft: TURN_SECONDS };
}
function roomOf(socket) { const c = socket.data.room; return c && rooms.get(c); }
function roomPlayer(room, socket) { return room?.players.find(p => p.id === socket.data.player) || null; }
function findPlayerRoom(username) {
  for (const room of rooms.values()) { const p = room.players.find(x => x.accountId === username && !x.leftRoom); if (p) return { room, player: p }; }
  return null;
}
function setEvent(room, type, text, meta = {}) { room.event = { id: nextEventId++, type, text: String(text || ''), ...meta }; room.message = String(text || ''); }
function touchRoom(room) {
  if (!room || !rooms.has(room.code)) return;
  if (room.inactivityTimer) clearTimeout(room.inactivityTimer);
  room.lastActivityAt = Date.now();
  room.inactivityTimer = setTimeout(() => {
    if (!rooms.has(room.code)) return;
    clearTurnTimers(room);
    for (const p of room.players) {
      if (!p.socketId) continue;
      const s = io.sockets.sockets.get(p.socketId);
      if (s) { s.emit('roomExpired', '房间连续10分钟没有活动，已自动删除。'); s.emit('leftRoom'); s.data.room = null; s.data.player = null; }
    }
    rooms.delete(room.code); io.emit('lobbyRooms', lobby());
  }, ROOM_IDLE_MS);
  if (room.inactivityTimer.unref) room.inactivityTimer.unref();
}
function addLog(room, text) { room.log.unshift(String(text)); room.log = room.log.slice(0, 80); room.message = String(text); }
function publicState(room, forId) {
  const pair = room.lastCompare || [];
  const ps = room.players.map(p => {
    const compareMaySee = pair.includes(forId) && pair.includes(p.id);
    const canSee = (p.id === forId && p.seen) || compareMaySee || room.ended;
    return { id: p.id, name: p.name, chips: p.chips, out: p.out, reveal: room.ended || compareMaySee, seen: p.seen, bet: p.bet, totalBet: p.totalBet, allIn: p.allIn, connected: p.connected, trustee: p.trustee, isBot: !!p.isBot, ready: !!p.ready, timeLeft: p.timeLeft, cards: canSee ? p.cards : p.cards.map(() => null) };
  });
  return { code: room.code, players: ps, me: forId, phase: room.phase, round: room.round, turn: room.turn, pot: room.pot, requiredBet: room.requiredBet, previousBet: room.previousBet, started: room.started, dealing: room.dealing, ended: room.ended, compareMode: room.compareMode, readyCount: room.players.filter(p => p.ready).length, minPlayers: 2, maxPlayers: MAX_PLAYERS, log: room.log.slice(0, 45), message: room.message, event: room.event, lastSettlement: room.lastSettlement || null, stats: stats() };
}
function emitRoom(room) {
  for (const p of room.players) if (p.socketId) io.to(p.socketId).emit('state', publicState(room, p.id));
  io.emit('lobbyRooms', lobby());
}
function lobby() {
  return [...rooms.values()].filter(r => r.players.length < MAX_PLAYERS && (!r.started || r.ended)).map(r => ({ code: r.code, players: r.players.length, maxPlayers: MAX_PLAYERS, ready: r.players.filter(p => p.ready).length, host: r.players[0]?.name || '玩家', status: r.started && !r.ended ? '游戏中' : r.ended ? '本局结束' : '等待准备' }));
}
function persistRoomChips(room) {
  for (const p of room.players) if (p.accountId && data.accounts[p.accountId]) data.accounts[p.accountId].chips = p.chips;
  saveData();
}
function rank(cards) {
  const vm = {2:2,3:3,4:4,5:5,6:6,7:7,8:8,9:9,10:10,J:11,Q:12,K:13,A:14};
  const vals = cards.map(c => vm[c.r]).sort((a,b) => b-a);
  const flush = cards.length === 3 && cards.every(c => c.s === cards[0].s);
  const counts = {}; vals.forEach(v => counts[v] = (counts[v] || 0) + 1);
  let sh = 0;
  if (new Set(vals).size === 3) { if (vals[0]-vals[1] === 1 && vals[1]-vals[2] === 1) sh = vals[0]; else if (vals[0] === 14 && vals[1] === 3 && vals[2] === 2) sh = 3; }
  if (vals[0] === vals[2]) return [6, vals[0]];
  if (flush && sh) return [5, sh];
  if (flush) return [4, vals[0], vals[1], vals[2]];
  if (sh) return [3, sh];
  const pair = Object.keys(counts).map(Number).find(v => counts[v] === 2);
  if (pair !== undefined) return [2, pair, vals.find(v => v !== pair)];
  return [1, vals[0], vals[1], vals[2]];
}
function compareRanks(a, b) { const n = Math.max(a.length, b.length); for (let i=0;i<n;i++) { if ((a[i]||0) > (b[i]||0)) return 1; if ((a[i]||0) < (b[i]||0)) return -1; } return 0; }
function alive(room) { return room.players.filter(p => !p.out); }
function clearTurnTimers(room) { if (room.timer) clearTimeout(room.timer); if (room.tick) clearInterval(room.tick); room.timer = room.tick = null; }
function beginTurnTimer(room) {
  clearTurnTimers(room);
  const p = room.players.find(x => x.id === room.turn);
  if (!p || room.ended || !room.started) return;
  p.timeLeft = TURN_SECONDS;
  if (p.isBot) {
    room.timer = setTimeout(() => botAct(room, p), 900 + Math.random() * 700);
  } else if (p.trustee) {
    room.timer = setTimeout(() => trusteeAct(room, p), 350);
  } else {
    room.tick = setInterval(() => {
      if (room.ended || room.turn !== p.id) return clearTurnTimers(room);
      p.timeLeft = Math.max(0, p.timeLeft - 1);
      if (p.timeLeft > 0 && p.timeLeft <= 5) setEvent(room, 'tick', '还剩' + p.timeLeft + '秒');
      emitRoom(room);
    }, 1000);
    room.timer = setTimeout(() => {
      clearTurnTimers(room);
      if (!room.ended && room.started && room.turn === p.id && !p.out) { p.out = true; p.ready = false; addLog(room, p.name + '超时，自动弃牌'); setEvent(room, 'fold', p.name + '超时，自动弃牌'); emitRoom(room); checkEnd(room); }
    }, TURN_SECONDS * 1000);
  }
  emitRoom(room);
}
function chooseNext(room) {
  if (room.ended) return;
  const a = alive(room);
  const actionable = a.filter(p => !p.allIn && p.chips > 0);
  if (a.length <= 1 || actionable.length <= 1) { finishRound(room); return; }
  const idx = room.players.findIndex(p => p.id === room.turn);
  for (let n=1; n<=room.players.length; n++) {
    const p = room.players[(idx+n)%room.players.length];
    if (!p.out && !p.allIn && p.chips > 0) { room.turn = p.id; room.compareMode = false; p.timeLeft = TURN_SECONDS; addLog(room, '轮到 ' + p.name + ' 操作'); setEvent(room, 'turn', '轮到' + p.name + '操作'); emitRoom(room); beginTurnTimer(room); return; }
  }
  finishRound(room);
}
function checkEnd(room) {
  const a = alive(room);
  if (a.length <= 1 || a.filter(p => !p.allIn && p.chips > 0).length <= 1) finishRound(room);
  else chooseNext(room);
}
function payIn(room, p, amount) {
  const n = Math.max(0, Math.min(p.chips, Math.floor(Number(amount) || 0)));
  p.chips -= n; p.bet = n; p.totalBet = (p.totalBet || 0) + n; room.pot += n;
  if (p.chips === 0) p.allIn = true;
  persistRoomChips(room);
  return n;
}
function trusteeAct(room, p) {
  if (!room.started || room.ended || room.turn !== p.id || p.out || p.allIn) return;
  clearTurnTimers(room);
  if (p.chips < room.requiredBet) {
    const amount = payIn(room, p, p.chips); room.previousBet = Math.max(room.previousBet, amount); room.requiredBet = Math.max(room.requiredBet, amount);
    addLog(room, p.name + '筹码不足，托管时已全部投注'); setEvent(room, 'allin', p.name + '筹码不足，已全部投注', { playerId:p.id, amount }); emitRoom(room); checkEnd(room); return;
  }
  const amount = payIn(room, p, room.requiredBet);
  room.previousBet = amount; room.requiredBet = amount;
  addLog(room, p.name + '投注' + amount + '（托管跟注），剩余筹码' + p.chips + '，当前奖池' + room.pot);
  setEvent(room, 'bet', '自动跟注' + amount, { playerId:p.id, amount }); emitRoom(room); chooseNext(room);
}
function aiStrength(p) {
  if (!p.cards || p.cards.length < 3) return 1;
  const r = rank(p.cards); let score = r[0]*20 + (r[1]||0);
  if (r[0] === 1) score += ((r[1]||0)+(r[2]||0)+(r[3]||0))/20;
  return score;
}
function botAct(room, p) {
  if (!room || room.ended || !room.started || room.turn !== p.id || p.out || p.allIn) return;
  clearTurnTimers(room);
  const strength = aiStrength(p), roll = Math.random();
  if (p.chips < room.requiredBet) {
    const amount = payIn(room, p, p.chips); room.previousBet = Math.max(room.previousBet, amount); room.requiredBet = Math.max(room.requiredBet, amount);
    addLog(room, p.name + '筹码不足，已全部投注，等待比牌结束'); setEvent(room, 'allin', p.name + '筹码不足，已全部投注', { playerId:p.id, amount }); emitRoom(room); checkEnd(room); return;
  }
  const legal = [20,40,60].filter(x => x >= room.requiredBet && x <= p.chips);
  if (!legal.length) {
    const amount = payIn(room, p, p.chips); room.previousBet = Math.max(room.previousBet, amount); room.requiredBet = Math.max(room.requiredBet, amount);
    addLog(room, p.name + '筹码不足，已全部投注'); setEvent(room, 'allin', p.name + '已全部投注', { playerId:p.id, amount }); emitRoom(room); checkEnd(room); return;
  }
  let action = 'bet', amount = legal[0];
  if (strength < 25) { action = roll < .68 ? 'fold' : 'bet'; amount = legal[0]; }
  else if (strength < 45) { action = roll < .18 ? 'fold' : 'bet'; amount = roll < .78 ? legal[0] : legal[Math.min(1, legal.length-1)]; }
  else if (strength < 70) { action = roll < .07 ? 'fold' : 'bet'; amount = roll < .60 ? legal[0] : legal[Math.min(1, legal.length-1)]; }
  else { action = 'bet'; amount = legal[roll < .45 ? 0 : Math.floor(Math.random()*legal.length)]; }
  if (action === 'fold') { p.out = true; addLog(room, p.name + '弃牌'); setEvent(room, 'fold', p.name + '弃牌'); emitRoom(room); checkEnd(room); return; }
  amount = payIn(room, p, amount); room.previousBet = amount; room.requiredBet = amount;
  addLog(room, p.name + '投注' + amount + '，剩余筹码' + p.chips + '，当前奖池' + room.pot + (p.allIn ? '，已全部投注' : '') + '；下一位最低下注' + amount);
  setEvent(room, p.allIn ? 'allin' : 'bet', p.name + '下注' + amount, { playerId:p.id, amount }); emitRoom(room); chooseNext(room);
}
function startRound(room) {
  if (room.started || room.players.length < 2 || !room.players.every(p => p.ready)) return;
  if (room.players.some(p => p.chips < ANTE)) {
    const poor = room.players.filter(p => p.chips < ANTE).map(p => p.name).join('、');
    room.players.forEach(p => p.ready = false);
    addLog(room, '筹码不足20无法缴纳底注：' + poor + '。请充值后再准备。'); setEvent(room, 'warning', '有玩家筹码不足20，无法开始本局'); emitRoom(room); return;
  }
  clearTurnTimers(room);
  room.round += 1; room.deck = shuffledDeck(); room.pot = 0; room.lastCompare = []; room.lastSettlement = null; room.requiredBet = ANTE; room.previousBet = ANTE; room.ended = false; room.started = true; room.dealing = true; room.phase = 'playing'; room.compareMode = false; room.log = [];
  for (const p of room.players) {
    p.cards = []; p.out = false; p.reveal = false; p.seen = false; p.bet = 0; p.totalBet = 0; p.allIn = false; p.timeLeft = TURN_SECONDS; p.ready = false;
    p.chips -= ANTE; p.totalBet = ANTE; p.allIn = p.chips === 0; room.pot += ANTE;
  }
  persistRoomChips(room);
  const order = [...room.players]; const startIndex = Math.floor(Math.random()*order.length); const dealOrder = order.map((_,k)=>order[(startIndex+k)%order.length]);
  room.turn = null; addLog(room, '第' + room.round + '局开始，每人缴纳20底注，正在发牌'); setEvent(room, 'start', '发牌开始'); emitRoom(room);
  const total = dealOrder.length * 3; let pos = 0;
  const one = () => {
    if (!rooms.has(room.code) || !room.started || room.ended) return;
    if (pos >= total) {
      room.dealing = false;
      room.players.forEach(p => { p.timeLeft = TURN_SECONDS; p.reveal = false; });
      room.turn = room.players[Math.floor(Math.random()*room.players.length)].id;
      const first = room.players.find(p => p.id === room.turn);
      addLog(room, '发牌完成，共' + room.players.length + '人，每人3张；随机指定' + first.name + '首先开始'); setEvent(room, 'deal-done', '发牌完成，' + first.name + '首先开始本局游戏'); emitRoom(room);
      setTimeout(() => { if (!rooms.has(room.code) || room.ended || !room.started) return; if (alive(room).filter(p => !p.allIn && p.chips > 0).length <= 1) finishRound(room); else if (first.allIn || first.chips <= 0) chooseNext(room); else beginTurnTimer(room); }, 1800); return;
    }
    const p = dealOrder[pos % dealOrder.length]; p.cards.push(room.deck.pop()); pos++;
    addLog(room, '发牌：' + p.name + '收到第' + p.cards.length + '张牌'); setEvent(room, 'deal-card', '发牌'); emitRoom(room);
    setTimeout(one, 260);
  };
  one();
}
function finishRound(room) {
  if (room.ended) return;
  clearTurnTimers(room); room.ended = true; room.started = false; room.dealing = false; room.phase = 'ready'; room.compareMode = false; room.turn = null;
  const participants = room.players, potBefore = room.pot;
  const levels = [...new Set(participants.map(p => p.totalBet || 0).filter(v => v > 0))].sort((a,b)=>a-b);
  let prev = 0; const payouts = new Map(), payoutWinners = [], layers = [];
  const handEligible = participants.filter(p => !p.out);
  for (const level of levels) {
    const contributors = participants.filter(p => (p.totalBet || 0) >= level);
    const potLayer = (level - prev) * contributors.length;
    if (potLayer <= 0) { prev = level; continue; }
    let eligible = contributors.filter(p => !p.out);
    if (!eligible.length) eligible = handEligible; // dead money must not disappear from the game
    if (!eligible.length) { prev = level; continue; }
    let best = eligible[0], tied = [best];
    for (const p of eligible.slice(1)) {
      const c = compareRanks(rank(p.cards), rank(best.cards));
      if (c > 0) { best = p; tied = [p]; } else if (c === 0) tied.push(p);
    }
    const each = Math.floor(potLayer / tied.length), rem = potLayer % tied.length;
    tied.forEach((p, i) => { const pay = each + (i === 0 ? rem : 0); payouts.set(p.id, (payouts.get(p.id)||0)+pay); if (pay > 0 && !payoutWinners.some(w => w.id === p.id)) payoutWinners.push(p); });
    layers.push({ from:prev, to:level, amount:potLayer, contributors:contributors.map(p=>p.id), eligible:tied.map(p=>p.id) });
    prev = level;
  }
  payouts.forEach((amount, id) => { const p = participants.find(x => x.id === id); if (p) p.chips += amount; });
  const payoutList = [...payouts.entries()].map(([playerId, amount]) => ({ playerId, amount }));
  for (const p of participants) {
    p.reveal = true; p.ready = !!p.isBot;
    if (p.accountId && data.accounts[p.accountId]) {
      const a = data.accounts[p.accountId]; a.chips = p.chips; a.games = (a.games || 0) + 1;
      if ((payouts.get(p.id)||0) > 0) a.wins = (a.wins || 0) + 1;
    }
  }
  data.totalGames = (data.totalGames || 0) + 1; saveData();
  const resultText = payoutWinners.length ? payoutWinners.map(p => p.name + '获得 ' + payouts.get(p.id) + ' 筹码').join('；') : '本局结束，没有获胜者';
  const summary = participants.map(p => p.name + '：+' + (payouts.get(p.id)||0) + '筹码').join('　');
  room.lastSettlement = { pot:potBefore, payouts:payoutList, layers, id:nextEventId };
  room.pot = 0;
  addLog(room, '第' + room.round + '局结算：' + summary); addLog(room, resultText);
  setEvent(room, 'winner', resultText, { settlement:room.lastSettlement });
  for (const p of participants) {
    if (p.chips < ANTE) {
      p.leftRoom = true; p.ready = false;
      if (p.socketId) {
        const sock = io.sockets.sockets.get(p.socketId);
        if (sock) { sock.emit('roomNotice', '你的剩余筹码低于最低底注20，已自动退出牌桌。'); sock.emit('leftRoom'); sock.data.room = null; sock.data.player = null; }
      }
    }
  }
  room.players = room.players.filter(p => !p.leftRoom);
  if (room.players.length === 0) { if (room.inactivityTimer) clearTimeout(room.inactivityTimer); rooms.delete(room.code); }
  emitRoom(room);
}
function requireUser(socket) {
  const username = socket.data.username;
  if (!username || !data.accounts[username]) { socket.emit('errorMessage', '登录状态已失效，请重新登录。'); return null; }
  return username;
}
function findExistingRoom(username) {
  const found = findPlayerRoom(username);
  if (!found) return false;
  const { room, player } = found;
  if (player.socketId && player.socketId !== '') { const old = io.sockets.sockets.get(player.socketId); if (old && old.id !== undefined) old.emit('sessionReplaced', '该账号已在其他页面连接，当前页面已接管牌桌。'); }
  player.socketId = null; player.connected = false;
  return { room, player };
}

io.use((socket, next) => {
  const username = userFromToken(parseCookies(socket.handshake.headers.cookie)[SESSION_COOKIE]);
  socket.data.username = username || null;
  next();
});
io.on('connection', socket => {
  const username = socket.data.username;
  if (username) {
    if (!onlineSockets.has(username)) onlineSockets.set(username, new Set());
    onlineSockets.get(username).add(socket.id);
    updatePeak();
    socket.emit('sessionInfo', { user: profile(username), stats: stats() });
    const found = findPlayerRoom(username);
    if (found) {
      const { room, player } = found;
      const oldSocketId = player.socketId;
      player.socketId = socket.id; player.connected = true; socket.data.room = room.code; socket.data.player = player.id;
      if (oldSocketId && oldSocketId !== socket.id) { const oldSocket = io.sockets.sockets.get(oldSocketId); if (oldSocket) oldSocket.disconnect(true); }
      touchRoom(room); addLog(room, player.name + '重新连接，已恢复牌桌'); setEvent(room, 'reconnect', player.name + '已重新连接'); emitRoom(room);
    }
  }
  socket.emit('stats', stats()); socket.emit('lobbyRooms', lobby());
  socket.on('lobbyRefresh', () => { socket.emit('lobbyRooms', lobby()); socket.emit('stats', stats()); });
  socket.on('createRoom', () => {
    const u = requireUser(socket); if (!u) return;
    const existing = findPlayerRoom(u);
    if (existing) { const {room, player} = existing; player.socketId = socket.id; player.connected = true; socket.data.room = room.code; socket.data.player = player.id; socket.emit('roomCreated', { code: room.code, resumed: true }); emitRoom(room); return; }
    const a = data.accounts[u]; const p = freshPlayer({ accountId: u, name: a.name, chips: a.chips }); p.socketId = socket.id; p.connected = true;
    const c = code(); const room = { code:c, players:[p], phase:'ready', round:0, turn:null, pot:0, requiredBet:ANTE, previousBet:ANTE, started:false, dealing:false, ended:false, compareMode:false, log:[], message:'房间已创建，等待其他玩家加入。所有玩家准备后自动开始。', event:{id:nextEventId++,type:'lobby',text:'房间已创建'}, timer:null, tick:null, deck:[], lastCompare:[], lastSettlement:null, inactivityTimer:null };
    rooms.set(c, room); touchRoom(room); socket.data.room = c; socket.data.player = p.id; socket.emit('roomCreated', { code:c }); emitRoom(room);
  });
  socket.on('joinRoom', ({code:roomCode}={}) => {
    const u = requireUser(socket); if (!u) return;
    const existing = findPlayerRoom(u);
    if (existing) { const {room, player} = existing; player.socketId = socket.id; player.connected = true; socket.data.room = room.code; socket.data.player = player.id; socket.emit('roomJoined', {code:room.code,resumed:true}); emitRoom(room); return; }
    const room = rooms.get(String(roomCode||'').trim());
    if (!room) { socket.emit('errorMessage', '房间不存在，请检查6位房间号。'); return; }
    if (room.started && !room.ended) { socket.emit('errorMessage', '该房间正在进行牌局，请选择等待中的房间。'); return; }
    if (room.players.length >= MAX_PLAYERS) { socket.emit('errorMessage', '房间已满，每桌最多6名玩家。'); return; }
    const a = data.accounts[u]; const p = freshPlayer({ accountId:u, name:a.name, chips:a.chips }); p.socketId = socket.id; p.connected = true;
    room.players.push(p); touchRoom(room); socket.data.room = room.code; socket.data.player = p.id; addLog(room, p.name + '加入房间'); setEvent(room,'join',p.name+'加入房间'); socket.emit('roomJoined',{code:room.code}); emitRoom(room);
  });
  socket.on('addBot', () => {
    const u = requireUser(socket); if (!u) return; const room = roomOf(socket); if (!room) return socket.emit('errorMessage','请先进入牌桌。');
    if (room.started && !room.ended) return socket.emit('errorMessage','本局进行中，暂时不能添加机器人。');
    if (room.players.length >= MAX_PLAYERS) return socket.emit('errorMessage','房间已满，每桌最多6名玩家。');
    const names = ['墨染江南','清风入弦','孤舟听雨','长安故里','云水禅心','牌神阿强'];
    const name = names.find(n => !room.players.some(p => p.name === n)) || ('机器人' + Math.floor(100+Math.random()*900));
    room.players.push(freshPlayer({ name, isBot:true, chips:1000 })); touchRoom(room); addLog(room,name+'加入房间（机器人已准备）'); setEvent(room,'join',name+'加入房间'); socket.emit('botAdded',{code:room.code}); emitRoom(room);
  });
  socket.on('toggleReady', ({ready}={}) => {
    const u = requireUser(socket); if (!u) return; const room = roomOf(socket); const p = roomPlayer(room,socket); if (!room||!p) return;
    if (room.started && !room.ended) return socket.emit('errorMessage','本局正在进行中，不能修改准备状态。');
    if (room.players.length < 2) return socket.emit('errorMessage','至少需要2名玩家才能开始。');
    touchRoom(room); p.ready = typeof ready === 'boolean' ? ready : !p.ready;
    addLog(room,p.name+(p.ready?'已准备':'取消准备')); setEvent(room,'ready',p.name+(p.ready?'已准备':'取消准备'));
    if (room.players.every(x=>x.ready)) {
      if (room.players.length < 2) { emitRoom(room); return; }
      startRound(room);
    } else emitRoom(room);
  });
  socket.on('action', ({action,data:payload={}}={}) => {
    const u = requireUser(socket); if (!u) return; const room = roomOf(socket); const p = roomPlayer(room,socket); if (!room||!p) return; touchRoom(room);
    if (action === 'restart') {
      if (room.started && !room.ended) return socket.emit('errorMessage','本局正在进行中，不能重置牌局。');
      p.ready = false; addLog(room,p.name+'取消准备'); setEvent(room,'ready',p.name+'取消准备'); emitRoom(room); return;
    }
    if (action === 'trustee') {
      if (!room.started || room.ended || p.out || p.allIn) return;
      p.trustee = !p.trustee; addLog(room,p.name+(p.trustee?'开启托管':'取消托管')); setEvent(room,'trustee',p.name+(p.trustee?'开启托管':'取消托管')); emitRoom(room);
      if (p.trustee && room.turn === p.id) trusteeAct(room,p); return;
    }
    if (!room.started || room.ended || room.dealing || room.turn !== p.id || p.out || p.allIn) return;
    if (action === 'look') {
      if (p.seen) return; p.seen = true; addLog(room,p.name+'看牌，底牌已翻开'); setEvent(room,'look',p.name+'看牌，底牌已经翻开'); emitRoom(room); return;
    }
    if (action === 'fold') {
      clearTurnTimers(room); p.out = true; addLog(room,p.name+'弃牌，退出本场比赛'); setEvent(room,'fold',p.name+'弃牌'); emitRoom(room); checkEnd(room); return;
    }
    if (action === 'bet') {
      const mode = payload.mode === 'raise' ? 'raise' : payload.mode === 'call' ? 'call' : 'legacy';
      const input = Math.floor(Number(payload.amount));
      if (mode === 'raise' && (!Number.isSafeInteger(input) || input <= 0)) return socket.emit('errorMessage','加注金额必须是大于0的整数。');
      if (mode === 'legacy' && (!Number.isSafeInteger(input) || input <= 0)) return socket.emit('errorMessage','请输入有效的整数下注金额。');
      if (p.chips <= 0) return socket.emit('errorMessage','你的筹码不足，无法继续下注。');
      if (p.chips < room.requiredBet) {
        const all = payIn(room,p,p.chips); room.previousBet = Math.max(room.previousBet,all); room.requiredBet = Math.max(room.requiredBet,all); clearTurnTimers(room);
        addLog(room,p.name+'筹码不足，已全部投注，请等待比牌结束'); setEvent(room,'allin',p.name+'筹码不足，已全部投注',{ playerId:p.id, amount:all }); emitRoom(room); checkEnd(room); return;
      }
      let amount = mode === 'call' ? room.requiredBet : mode === 'raise' ? room.requiredBet + input : input;
      if (amount < room.requiredBet) return socket.emit('errorMessage','下注不能低于当前跟注金额 '+room.requiredBet+'。');
      if (mode === 'raise' && amount <= room.requiredBet) return socket.emit('errorMessage','加注后的总额必须高于当前跟注金额。');
      if (amount > p.chips) return socket.emit('errorMessage','本次应支付 '+amount+'，超过你当前筹码 '+p.chips+'。');
      clearTurnTimers(room); const actual = payIn(room,p,amount); room.previousBet = actual; room.requiredBet = actual;
      const actionText = mode === 'call' ? '跟注' : mode === 'raise' ? '加注后投入' : '投注';
      addLog(room,p.name+actionText+actual+'，剩余筹码'+p.chips+'，当前奖池'+room.pot+(p.allIn?'，已全部投注':'')+'；下一位最低跟注'+actual);
      setEvent(room,p.allIn?'allin':'bet',p.name+actionText+actual,{ playerId:p.id, amount:actual, mode }); emitRoom(room); chooseNext(room); return;
    }
    if (action === 'compare') {
      const target = room.players.find(x=>x.id===payload.targetId);
      if (!target || target.id===p.id || target.out) return socket.emit('errorMessage','请选择一名仍在场的对手进行比牌。');
      clearTurnTimers(room); room.lastCompare = [p.id, target.id]; p.reveal = true; target.reveal = true;
      const c = compareRanks(rank(p.cards),rank(target.cards));
      // 与上传的 V28 文件一致：平手时走 else 分支，被选择的对手出局。
      if (c < 0) p.out = true; else target.out = true;
      const text = c > 0 ? '你比牌获胜' : c < 0 ? target.name+'比牌获胜' : '比牌平手，你留在场上';
      addLog(room, c > 0 ? p.name+'比牌获胜' : c < 0 ? target.name+'比牌获胜' : '比牌平手，'+target.name+'出局'); setEvent(room,'compare',text); emitRoom(room); checkEnd(room); return;
    }
  });
  socket.on('leaveRoom', () => {
    const room = roomOf(socket); const p = roomPlayer(room,socket); if (!room || !p) { socket.data.room = null; socket.data.player = null; return; }
    touchRoom(room);
    if (room.started && !room.ended) {
      const wasTurn = room.turn === p.id;
      if (wasTurn) clearTurnTimers(room);
      p.out = true; p.ready = false; p.connected = false; p.socketId = null; p.leftRoom = true;
      addLog(room,p.name+'离开牌桌并弃牌'); setEvent(room,'fold',p.name+'离开牌桌'); emitRoom(room);
      if (wasTurn) checkEnd(room);
      else { const aliveNow = alive(room); if (aliveNow.length <= 1 || aliveNow.filter(x=>!x.allIn&&x.chips>0).length <= 1) finishRound(room); }
    } else { room.players = room.players.filter(x=>x.id!==p.id); if (!room.players.length) { clearTurnTimers(room); if (room.inactivityTimer) clearTimeout(room.inactivityTimer); rooms.delete(room.code); } else { addLog(room,p.name+'离开房间'); emitRoom(room); } }
    socket.data.room = null; socket.data.player = null; socket.emit('leftRoom'); io.emit('lobbyRooms',lobby());
  });
  socket.on('logout', () => { socket.data.username = null; });
  socket.on('disconnect', () => {
    if (username && onlineSockets.has(username)) {
      const set = onlineSockets.get(username); set.delete(socket.id); if (!set.size) onlineSockets.delete(username);
    }
    const room = roomOf(socket); const p = roomPlayer(room,socket);
    if (p && p.socketId === socket.id) { p.connected = false; p.socketId = null; addLog(room,p.name+'连接中断，等待重新连接'); setEvent(room,'disconnect',p.name+'连接中断'); emitRoom(room); }
    updatePeak(); io.emit('lobbyRooms',lobby());
  });
});

server.listen(PORT, '0.0.0.0', () => {
  console.log('ZhaJinHua V32 listening on port ' + PORT);
  console.log('Persistent data file: ' + DATA_FILE);
  if (SESSION_SECRET === 'change-this-secret-in-railway-v31') console.warn('WARNING: set SESSION_SECRET in Railway variables for production.');
});
