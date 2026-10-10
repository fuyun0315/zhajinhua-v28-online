'use strict';
const $ = id => document.getElementById(id);
const socket = io({ autoConnect: false, transports: ['websocket', 'polling'] });
let loggedIn = false, currentUser = null, roomCode = '', state = null;
let registerMode = false, quickBotPending = false, compareMode = false, returningToLobby = false;
let audioCtx = null, lastEventId = 0, toastTimer = null, authBusy = false;

function showScreen(name) {
  ['authScreen','lobbyScreen','tableScreen'].forEach(id => $(id).classList.toggle('hidden', id !== name));
  window.scrollTo({ top: 0, behavior: 'smooth' });
}
function setText(id, value) { const el = $(id); if (el) el.textContent = String(value ?? ''); }
function escapeHtml(v) { return String(v ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c])); }
function toast(message) { const el = $('toast'); if (!el) return; el.textContent = message; el.classList.remove('hidden'); clearTimeout(toastTimer); toastTimer = setTimeout(() => el.classList.add('hidden'), 3000); }
function authMessage(message, error = false) { setText('authMessage', message); $('authMessage').style.color = error ? '#ffaaa0' : 'var(--gold)'; }
function lobbyMessage(message, error = false) { setText('lobbyMessage', message); $('lobbyMessage').style.color = error ? '#ffaaa0' : 'var(--gold)'; }
function tableMessage(message, error = false) { setText('tableMessage', message); $('tableMessage').style.color = error ? '#ffaaa0' : 'var(--gold)'; }
function setAuthMode(register) {
  registerMode = register;
  $('registerNameWrap').classList.toggle('hidden', !register);
  $('loginBtn').textContent = register ? '创建账号' : '登录';
  $('showRegisterBtn').style.display = register ? 'none' : 'block';
  $('showLoginBtn').style.display = register ? 'block' : 'none';
  setText('authHeading', register ? '创建新账号' : '欢迎回来');
  setText('authCopy', register ? '设置用户名和密码，即可加入牌桌。\n虚拟筹码，仅供娱乐。' : '登录账号，继续你的牌局。\n虚拟筹码，仅供娱乐。');
  $('authPass').setAttribute('autocomplete', register ? 'new-password' : 'current-password');
  authMessage('');
}
async function api(path, body) {
  const res = await fetch(path, { method: body ? 'POST' : 'GET', credentials: 'same-origin', headers: body ? { 'Content-Type': 'application/json' } : {}, body: body ? JSON.stringify(body) : undefined });
  let json; try { json = await res.json(); } catch { json = { ok: false, message: '服务器返回了无法识别的数据。' }; }
  if (!res.ok || json.ok === false) throw new Error(json.message || ('请求失败：' + res.status));
  return json;
}
function connectSocket() { if (socket.connected) socket.disconnect(); socket.connect(); }
async function submitAuth() {
  if (authBusy) return;
  const username = $('authUser').value.trim().toLowerCase(), password = $('authPass').value, name = $('authName').value.trim();
  if (!/^[a-z0-9_]{3,20}$/.test(username)) return authMessage('用户名需为3–20位英文字母、数字或下划线。', true);
  if (password.length < 6 || password.length > 72) return authMessage('密码长度需为6–72位。', true);
  authBusy = true; $('loginBtn').disabled = true; $('showRegisterBtn').disabled = true; $('showLoginBtn').disabled = true;
  authMessage(registerMode ? '正在创建账号…' : '正在验证登录…');
  try {
    const r = await api(registerMode ? '/api/register' : '/api/login', { username, password, name });
    loggedIn = true; currentUser = r.user; setText('welcomeText', currentUser.name || currentUser.username); updateStats(r.stats); authMessage('');
    connectSocket(); showScreen('lobbyScreen'); lobbyMessage('登录成功，正在恢复牌桌和房间列表…');
  } catch (e) { authMessage(e.message || '登录失败，请重试。', true); }
  finally { authBusy = false; $('loginBtn').disabled = false; $('showRegisterBtn').disabled = false; $('showLoginBtn').disabled = false; }
}
$('loginBtn').addEventListener('click', submitAuth);
$('showRegisterBtn').addEventListener('click', () => setAuthMode(true));
$('showLoginBtn').addEventListener('click', () => setAuthMode(false));
$('authPass').addEventListener('keydown', e => { if (e.key === 'Enter') submitAuth(); });
$('authUser').addEventListener('keydown', e => { if (e.key === 'Enter') $('authPass').focus(); });

function updateStats(s = {}) {
  const text = '在线 ' + (Number(s.online) || 0) + ' · 峰值 ' + (Number(s.peakOnline) || 0);
  if ($('lobbyStats')) setText('lobbyStats', text);
  if ($('tableStats')) setText('tableStats', '当前在线 ' + (Number(s.online) || 0) + ' 人 · 历史峰值 ' + (Number(s.peakOnline) || 0) + ' 人 · 累计牌局 ' + (Number(s.totalGames) || 0));
}
async function restoreSession() {
  try {
    const r = await api('/api/me'); updateStats(r.stats);
    if (r.authenticated && r.user) {
      loggedIn = true; currentUser = r.user; setText('welcomeText', currentUser.name || currentUser.username); showScreen('lobbyScreen'); lobbyMessage('正在恢复登录状态…'); connectSocket();
    } else { loggedIn = false; currentUser = null; showScreen('authScreen'); socket.connect(); authMessage('请登录或注册。'); }
  } catch { showScreen('authScreen'); socket.connect(); authMessage('无法连接服务器，请刷新后重试。', true); }
}
socket.on('connect', () => { if (loggedIn) { socket.emit('lobbyRefresh'); } else authMessage('请登录或注册。'); });
socket.on('connect_error', () => { if (loggedIn) toast('网络暂时中断，正在自动重连…'); });
socket.on('disconnect', () => { if (loggedIn) toast('连接中断，正在尝试恢复…'); });
socket.on('sessionInfo', d => { if (d?.user) { loggedIn = true; currentUser = d.user; setText('welcomeText', currentUser.name || currentUser.username); updateStats(d.stats); showScreen('lobbyScreen'); } });
socket.on('stats', updateStats);
socket.on('lobbyRooms', rooms => renderLobbyRooms(Array.isArray(rooms) ? rooms : []));
socket.on('sessionReplaced', msg => toast(msg || '此账号已在另一个页面连接。'));
function renderLobbyRooms(rooms) {
  const box = $('roomList'); if (!box) return;
  setText('roomCount', rooms.length + ' 张可加入');
  if (!rooms.length) { box.innerHTML = '<div class="empty-state">暂时没有开放牌桌。<br>点击上方「创建房间」开始，或使用「单人练习」。</div>'; return; }
  box.innerHTML = rooms.map(r => `<div class="room-card"><div class="room-code">${escapeHtml(r.code)}</div><div class="room-meta">房主：${escapeHtml(r.host || '玩家')}<br>人数：${Number(r.players)||0}/${Number(r.maxPlayers)||6}　·　准备：${Number(r.ready)||0} 人<br>${escapeHtml(r.status || '等待加入')}</div><button data-room="${escapeHtml(r.code)}">加入这张牌桌</button></div>`).join('');
  box.querySelectorAll('button[data-room]').forEach(b => b.addEventListener('click', () => joinRoom(b.dataset.room)));
}
function ensureLoggedIn() { if (!loggedIn || !socket.connected) { showScreen('authScreen'); authMessage('登录连接正在恢复，请稍后再操作。', true); return false; } return true; }
function createRoom() { if (!ensureLoggedIn()) return; quickBotPending = false; lobbyMessage('正在创建房间…'); socket.emit('createRoom'); }
function createPracticeRoom() { if (!ensureLoggedIn()) return; quickBotPending = true; lobbyMessage('正在创建练习房间…'); socket.emit('createRoom'); }
function joinRoom(code) {
  if (!ensureLoggedIn()) return;
  code = String(code || '').trim(); if (!/^\d{6}$/.test(code)) return lobbyMessage('请输入完整的6位数字房间号。', true);
  lobbyMessage('正在加入房间 ' + code + '…'); socket.emit('joinRoom', { code });
}
$('createRoom').addEventListener('click', createRoom);
$('quickBot').addEventListener('click', createPracticeRoom);
$('joinRoom').addEventListener('click', () => joinRoom($('roomCodeInput').value));
$('roomCodeInput').addEventListener('keydown', e => { if (e.key === 'Enter') joinRoom($('roomCodeInput').value); });
$('refreshRooms').addEventListener('click', () => { socket.emit('lobbyRefresh'); lobbyMessage('房间列表已刷新。'); });
$('logoutBtn').addEventListener('click', async () => {
  if (socket.connected && roomCode) socket.emit('leaveRoom');
  try { await api('/api/logout', {}); } catch {}
  socket.disconnect(); loggedIn = false; currentUser = null; state = null; roomCode = ''; quickBotPending = false;
  showScreen('authScreen'); setAuthMode(false); authMessage('已退出登录。');
});
socket.on('roomCreated', d => {
  roomCode = d.code; setText('tableCode', roomCode); showScreen('tableScreen');
  tableMessage(d.resumed ? '已恢复原来的牌桌。' : '房间已创建。请分享房间号，所有玩家准备后才会开始。');
  socket.emit('lobbyRefresh');
  if (quickBotPending && !d.resumed) { quickBotPending = false; setTimeout(() => socket.emit('addBot'), 250); }
});
socket.on('roomJoined', d => { roomCode = d.code; setText('tableCode', roomCode); showScreen('tableScreen'); tableMessage(d.resumed ? '已恢复原来的牌桌。' : '已加入房间 ' + roomCode + '，等待所有玩家准备。'); socket.emit('lobbyRefresh'); });
socket.on('errorMessage', msg => { if ($('tableScreen').classList.contains('hidden')) lobbyMessage(msg, true); else tableMessage(msg, true); toast(msg); });
socket.on('roomNotice', msg => toast(msg));
socket.on('roomExpired', msg => toast(msg));
socket.on('botAdded', () => { tableMessage('机器人已加入牌桌并自动准备。'); socket.emit('lobbyRefresh'); });
socket.on('leftRoom', () => { returningToLobby = false; state = null; compareMode = false; showScreen('lobbyScreen'); socket.emit('lobbyRefresh'); });
$('backLobbyBtn').addEventListener('click', () => {
  returningToLobby = true; socket.emit('leaveRoom'); roomCode = ''; state = null; compareMode = false; showScreen('lobbyScreen'); lobbyMessage('正在返回大厅…');
});
$('copyCodeBtn').addEventListener('click', async () => {
  const code = roomCode || $('tableCode').textContent;
  try { await navigator.clipboard.writeText(code); toast('房间号 ' + code + ' 已复制'); } catch { toast('请记下房间号：' + code); }
});

function startAudio() { try { audioCtx = audioCtx || new (window.AudioContext || window.webkitAudioContext)(); if (audioCtx.state === 'suspended') audioCtx.resume(); } catch {} }
function beep(freq = 500, duration = 100) {
  try { startAudio(); if (!audioCtx) return; const o = audioCtx.createOscillator(), g = audioCtx.createGain(); o.type = 'triangle'; o.frequency.value = freq; g.gain.setValueAtTime(.045, audioCtx.currentTime); g.gain.exponentialRampToValueAtTime(.001, audioCtx.currentTime + duration/1000); o.connect(g); g.connect(audioCtx.destination); o.start(); o.stop(audioCtx.currentTime + duration/1000); } catch {}
}
function speak(text) { try { if (!('speechSynthesis' in window) || !text) return; speechSynthesis.cancel(); const u = new SpeechSynthesisUtterance(text); u.lang = 'zh-CN'; u.rate = .9; u.pitch = 1; speechSynthesis.speak(u); } catch {} }
document.addEventListener('pointerdown', startAudio, { once: true });
function emitAction(action, data = {}) { socket.emit('action', { action, data }); }
function cardText(c) { return c ? c.s + c.r : '?'; }
function renderChips() {
  const box = $('chipPile'); if (!box || !state) return; box.innerHTML = '';
  const count = Math.min(18, Math.floor((state.pot || 0) / 20));
  for (let i=0;i<count;i++) { const c=document.createElement('div'); c.className='chip c'+(i%4+1); c.style.left=(35+((i*17)%31))+'%'; c.style.top=(18+((i*23)%59))+'%'; c.style.transform='translate(-50%,-50%) rotate('+(((i*29)%51)-25)+'deg)'; box.appendChild(c); }
}
function flyChips(fromEl, toEl, count = 4, colorSeed = 0) {
  if (!fromEl || !toEl) return;
  const a = fromEl.getBoundingClientRect(), b = toEl.getBoundingClientRect();
  const sx = a.left + a.width / 2, sy = a.top + a.height / 2;
  const tx = b.left + b.width / 2, ty = b.top + b.height / 2;
  const colors = ['#b83b3b','#376db0','#d0a532','#e8e8e8'];
  const n = Math.max(1, Math.min(12, Math.floor(count)));
  for (let i=0;i<n;i++) {
    const chip = document.createElement('div'); chip.className = 'flying-chip'; chip.style.background = colors[(colorSeed+i)%colors.length];
    chip.style.left = (sx + (Math.random()*24-12)) + 'px'; chip.style.top = (sy + (Math.random()*18-9)) + 'px';
    chip.style.transform = 'scale(.7) rotate(' + (i*37) + 'deg)'; document.body.appendChild(chip);
    requestAnimationFrame(() => requestAnimationFrame(() => { chip.style.left = (tx + (Math.random()*10-5)) + 'px'; chip.style.top = (ty + (Math.random()*10-5)) + 'px'; chip.style.transform = 'scale(1) rotate(' + (i*97) + 'deg)'; }));
    setTimeout(() => { chip.style.opacity = '0'; setTimeout(() => chip.remove(), 180); }, 720);
  }
}
function animateChipEvent(ev, s) {
  const pile = $('chipPile');
  if (ev.type === 'bet' || ev.type === 'allin') {
    const seat = [...document.querySelectorAll('.seat')].find(el => el.dataset.playerIndex === ev.playerId);
    const amount = Number(ev.amount) || 20;
    flyChips(seat, pile, Math.min(12, Math.max(2, Math.ceil(amount/80))), 0);
  } else if (ev.type === 'winner' && ev.settlement) {
    const entries = ev.settlement.payouts || [];
    entries.forEach((item, idx) => {
      const seat = [...document.querySelectorAll('.seat')].find(el => el.dataset.playerIndex === item.playerId);
      if (seat) flyChips(pile, seat, Math.min(12, Math.max(2, Math.ceil((Number(item.amount)||0)/Math.max(1, Number(ev.settlement.pot)||1)*14))), idx);
    });
  }
}
function playEvent(ev) {
  if (!ev || !ev.id || ev.id === lastEventId) return; lastEventId = ev.id;
  animateChipEvent(ev, state);
  switch (ev.type) {
    case 'start': beep(600,110); setTimeout(()=>beep(760,120),130); speak('发牌开始'); break;
    case 'deal-card': beep(380,90); break;
    case 'deal-done': beep(760,170); speak(ev.text); break;
    case 'bet': beep(540,100); speak(ev.text); break;
    case 'allin': beep(610,180); speak(ev.text); break;
    case 'fold': beep(320,130); speak(ev.text); break;
    case 'compare': beep(480,100); setTimeout(()=>beep(760,180),120); speak(ev.text); break;
    case 'winner': beep(880,260); speak(ev.text); break;
    case 'tick': if (/还剩[1-5]秒/.test(ev.text)) { beep(720,80); if (state && state.turn === state.me) speak(ev.text); } break;
    case 'warning': beep(260,220); speak(ev.text); break;
    case 'reconnect': speak(ev.text); break;
    case 'ready': beep(500,80); break;
    case 'look': beep(700,100); speak(ev.text); break;
    case 'trustee': beep(450,90); break;
    case 'turn': if (state && state.turn === state.me) beep(650,120); break;
    default: break;
  }
}
function render(s) {
  state = s; roomCode = s.code; setText('tableCode', s.code); updateStats(s.stats || {});
  if (!returningToLobby) showScreen('tableScreen');
  const players = s.players || [], me = players.find(p => p.id === s.me); if (!me) return;
  const current = players.find(p => p.id === s.turn);
  const readyCount = Number(s.readyCount) || players.filter(p=>p.ready).length;
  setText('tableSubtitle', s.started ? `第 ${s.round} 局 · ${current ? '轮到 '+current.name : '等待操作'}` : s.ended ? '本局已结束 · 等待所有玩家准备下一局' : `等待开始 · 已准备 ${readyCount}/${players.length} 人`);
  setText('pot', '底池：' + (Number(s.pot) || 0));
  if (s.started && s.dealing) setText('deal', '正在发牌，请稍候…');
  else if (s.started) setText('deal', s.turn === s.me ? (me.trustee ? '托管中：自动跟注' : '轮到你操作') : (current ? '等待 ' + current.name + ' 操作' : '等待对手操作'));
  else if (s.ended) setText('deal', s.message || '本局结束，点击准备下一局');
  else setText('deal', players.length < 2 ? '等待另一位玩家加入，至少需要2人' : '所有玩家都准备好后，系统才会发牌');
  const box = $('seats'); box.innerHTML = ''; box.className = 'seats count-' + players.length;
  const ordered = [...players.filter(p => p.id !== s.me), me];
  const layouts = {1:[[50,82]],2:[[50,18],[50,82]],3:[[25,27],[75,27],[50,82]],4:[[22,30],[78,30],[22,72],[50,82]],5:[[18,30],[50,16],[82,30],[78,72],[50,84]],6:[[17,28],[50,15],[83,28],[83,70],[50,84],[17,70]]};
  const coords = layouts[ordered.length] || layouts[6];
  ordered.forEach((p, idx) => {
    const isMe = p.id === s.me, el = document.createElement('div'); el.style.left = coords[idx][0]+'%'; el.style.top = coords[idx][1]+'%';
    el.className = 'seat '+(isMe?'me ':'')+(p.out?'out ':'')+(p.id===s.turn&&s.started?'active':''); el.dataset.playerIndex = p.id;
    if (players.length > 4) el.style.width = 'clamp(72px,20vw,105px)';
    const cards = p.cards || [];
    let playerStatus = '';
    if (!s.started) playerStatus = p.ready ? '已准备' : '未准备';
    else if (p.out) playerStatus = '已弃牌';
    else if (p.allIn) playerStatus = '已全押';
    else if (p.id === s.turn) playerStatus = '剩余 '+(Number(p.timeLeft) || 0)+' 秒';
    else playerStatus = p.trustee ? '托管中' : (p.connected ? '在线' : '断线');
    el.innerHTML = `<div class="name">${escapeHtml(p.name)}${isMe?'（你）':''}${p.isBot?' · 机器人':''}</div><div class="chips">筹码 ${Number(p.chips)||0}</div><div class="timer">${escapeHtml(playerStatus)}</div><div class="cards">${cards.map(c=>`<div class="card ${!c?'back':((c.s==='♥'||c.s==='♦')?'red':'black')} ">${!c?'★':escapeHtml(cardText(c))}</div>`).join('')}</div>`;
    if (!isMe && compareMode && s.started && !s.ended && !p.out && s.turn === s.me) { el.classList.add('compare-target'); el.addEventListener('click', () => { compareMode=false; emitAction('compare',{targetId:p.id}); }); }
    box.appendChild(el);
  });
  const myTurn = s.started && !s.dealing && !s.ended && s.turn === s.me && !me.out && !me.allIn;
  $('look').disabled = !myTurn || me.seen; $('look').textContent = me.seen ? '已看牌' : '看牌';
  $('fold').disabled = !myTurn; $('compare').disabled = !myTurn || me.trustee;
  $('trustee').disabled = !s.started || s.ended || me.out || me.allIn; $('trustee').textContent = me.trustee ? '取消托管' : '托管'; $('trustee').classList.toggle('trustee-on', !!me.trustee);
  const readyScreen = !s.started; $('centerReady').classList.toggle('hidden', !readyScreen); $('centerReady').disabled = !readyScreen || players.length < 2;
  $('centerReady').textContent = me.ready ? '取消准备' : (s.ended ? '准备下一局' : '准备好了');
  $('addBot').disabled = s.started || players.length >= (s.maxPlayers || 6); $('addBot').classList.toggle('hidden', s.started || players.length >= (s.maxPlayers || 6));
  $('restart').classList.toggle('hidden', s.started || !me.ready); $('restart').disabled = s.started || !me.ready;
  const betShow = myTurn && !compareMode; ['centerBet20','centerBet40','centerBet60','customBetBtn'].forEach(id=>{$(id).classList.toggle('hidden',!betShow);$(id).disabled=!betShow;});
  const callAmount = Number(s.requiredBet) || 20;
  $('centerBet20').textContent = me.chips < callAmount ? '全下跟注 ' + me.chips : '跟注 ' + callAmount;
  $('centerBet40').textContent = '加注 +20'; $('centerBet60').textContent = '加注 +40'; $('customBetBtn').textContent = '自定义加注';
  $('centerBet20').disabled = !betShow || me.chips <= 0;
  $('centerBet40').disabled = !betShow || callAmount + 20 > me.chips;
  $('centerBet60').disabled = !betShow || callAmount + 40 > me.chips;
  $('customBetBtn').disabled = !betShow || me.chips <= callAmount;
  if (!betShow) $('customBetWrap').classList.add('hidden');
  const logs = $('log'); logs.innerHTML = ''; (s.log || []).forEach(line=>{ const d=document.createElement('div'); d.textContent=line; logs.appendChild(d); });
  renderChips(); playEvent(s.event);
  tableMessage('房间号：'+s.code+' ｜ '+players.length+'/'+(s.maxPlayers||6)+' 人 ｜ 已准备 '+readyCount+'/'+players.length+' ｜ '+(s.started?'多人对战进行中':s.ended?'本局结束，等待准备':players.length<2?'等待其他玩家加入':'等待所有玩家准备'));
}
socket.on('state', render);
$('centerReady').addEventListener('click', () => { if (!state) return; socket.emit('toggleReady',{ready:!((state.players||[]).find(p=>p.id===state.me)?.ready)}); });
$('look').addEventListener('click', () => emitAction('look'));
$('fold').addEventListener('click', () => emitAction('fold'));
$('compare').addEventListener('click', () => { compareMode=true; if(state)render(state); setText('deal','请选择一名对手进行比牌'); });
$('trustee').addEventListener('click', () => emitAction('trustee'));
$('addBot').addEventListener('click', () => socket.emit('addBot'));
$('restart').addEventListener('click', () => emitAction('restart'));
$('centerBet20').addEventListener('click', () => emitAction('bet',{mode:'call',amount:state?.requiredBet||20}));
$('centerBet40').addEventListener('click', () => emitAction('bet',{mode:'raise',amount:20}));
$('centerBet60').addEventListener('click', () => emitAction('bet',{mode:'raise',amount:40}));
$('customBetBtn').addEventListener('click', () => $('customBetWrap').classList.toggle('hidden'));
$('customBetConfirm').addEventListener('click', () => { const amount=Number($('customBetInput').value); if(!Number.isSafeInteger(amount)||amount<=0) return tableMessage('请输入大于0的整数加注金额。',true); emitAction('bet',{mode:'raise',amount}); $('customBetWrap').classList.add('hidden'); });
$('customBetInput').addEventListener('keydown',e=>{if(e.key==='Enter')$('customBetConfirm').click();});

restoreSession();
