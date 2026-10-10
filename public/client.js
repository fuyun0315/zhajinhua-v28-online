'use strict';
// V30: initialize helpers before binding any controls (fixes the old login ReferenceError).
const $ = id => document.getElementById(id);
const socket = io({ transports: ['websocket', 'polling'] });
let loggedIn = false, currentUser = null, roomCode = '', state = null;
let registerMode = false, quickBotPending = false, compareMode = false;
let audioCtx = null, lastMessage = '', toastTimer = null;

function showScreen(name) {
  ['authScreen','lobbyScreen','tableScreen'].forEach(id => $(id).classList.toggle('hidden', id !== name));
  window.scrollTo({top:0, behavior:'smooth'});
}
function setText(id, value) { const el=$(id); if(el) el.textContent=String(value ?? ''); }
function escapeHtml(v) { return String(v).replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c])); }
function toast(message) {
  const el=$('toast'); el.textContent=message; el.classList.remove('hidden');
  clearTimeout(toastTimer); toastTimer=setTimeout(()=>el.classList.add('hidden'),2800);
}
function authMessage(message, error=false) { setText('authMessage',message); $('authMessage').style.color=error?'#ffaaa0':'var(--gold)'; }
function lobbyMessage(message, error=false) { setText('lobbyMessage',message); $('lobbyMessage').style.color=error?'#ffaaa0':'var(--gold)'; }
function tableMessage(message, error=false) { setText('tableMessage',message); $('tableMessage').style.color=error?'#ffaaa0':'var(--gold)'; }
function setAuthMode(register) {
  registerMode=register;
  $('registerNameWrap').classList.toggle('hidden',!register);
  $('loginBtn').textContent=register?'创建账号':'登录';
  $('showRegisterBtn').style.display=register?'none':'block';
  $('showLoginBtn').style.display=register?'block':'none';
  setText('authHeading',register?'创建新账号':'欢迎回来');
  setText('authCopy',register?'设置用户名和密码，即可加入牌桌。\n虚拟筹码，仅供娱乐。':'登录账号，继续你的牌局。\n虚拟筹码，仅供娱乐。');
  $('authPass').setAttribute('autocomplete',register?'new-password':'current-password');
  authMessage('');
}
function submitAuth() {
  const username=$('authUser').value.trim().toLowerCase();
  const password=$('authPass').value;
  const name=$('authName').value.trim();
  if(!/^[a-z0-9_]{3,20}$/.test(username)) { authMessage('用户名需为3–20位英文字母、数字或下划线。',true); return; }
  if(password.length<6 || password.length>72) { authMessage('密码长度需为6–72位。',true); return; }
  $('loginBtn').disabled=true; $('showRegisterBtn').disabled=true; $('showLoginBtn').disabled=true;
  authMessage(registerMode?'正在创建账号…':'正在验证登录…');
  socket.emit(registerMode?'register':'login',{username,password,name});
  setTimeout(()=>{ $('loginBtn').disabled=false; $('showRegisterBtn').disabled=false; $('showLoginBtn').disabled=false; },1800);
}
$('loginBtn').addEventListener('click',submitAuth);
$('showRegisterBtn').addEventListener('click',()=>setAuthMode(true));
$('showLoginBtn').addEventListener('click',()=>setAuthMode(false));
$('authPass').addEventListener('keydown',e=>{if(e.key==='Enter')submitAuth();});
$('authUser').addEventListener('keydown',e=>{if(e.key==='Enter')$('authPass').focus();});

socket.on('connect',()=>{ if(!loggedIn) authMessage('服务器已连接，请登录或注册。'); });
socket.on('connect_error',()=>{ if(!loggedIn) authMessage('暂时无法连接服务器，请刷新页面重试。',true); else toast('连接中断，正在尝试重连…'); });
socket.on('disconnect',()=>{ if(loggedIn) toast('网络连接中断，正在尝试重连…'); });
socket.on('authResult',r=>{
  $('loginBtn').disabled=false; $('showRegisterBtn').disabled=false; $('showLoginBtn').disabled=false;
  if(!r || !r.ok) { authMessage(r?.message || '登录失败，请检查输入后重试。',true); return; }
  loggedIn=true; currentUser={username:r.username,name:r.name||r.username};
  setText('welcomeText',currentUser.name);
  authMessage(''); showScreen('lobbyScreen'); lobbyMessage('登录成功，正在加载房间列表…');
  socket.emit('lobbyRefresh');
});
socket.on('lobbyRooms',rooms=>renderLobbyRooms(Array.isArray(rooms)?rooms:[]));
function renderLobbyRooms(rooms) {
  const box=$('roomList'); setText('roomCount',rooms.length+' 张可加入');
  if(!rooms.length) { box.innerHTML='<div class="empty-state">暂时没有开放牌桌。<br>点击上方「创建房间」开始，或使用「单人练习」。</div>'; return; }
  box.innerHTML=rooms.map(r=>`<div class="room-card"><div class="room-code">${escapeHtml(r.code)}</div><div class="room-meta">房主：${escapeHtml(r.host||'玩家')}<br>人数：${Number(r.players)||0}/${Number(r.maxPlayers)||6}　·　${escapeHtml(r.status||'等待加入')}</div><button data-room="${escapeHtml(r.code)}">加入这张牌桌</button></div>`).join('');
  box.querySelectorAll('button[data-room]').forEach(b=>b.addEventListener('click',()=>joinRoom(b.dataset.room)));
}
function ensureLoggedIn() { if(!loggedIn) { showScreen('authScreen'); authMessage('请先登录或注册。',true); return false; } return true; }
function createRoom() { if(!ensureLoggedIn())return; quickBotPending=false; lobbyMessage('正在创建房间…'); socket.emit('createRoom',{name:currentUser?.name||'玩家'}); }
function createPracticeRoom() { if(!ensureLoggedIn())return; quickBotPending=true; lobbyMessage('正在创建练习房间…'); socket.emit('createRoom',{name:currentUser?.name||'玩家'}); }
function joinRoom(code) {
  if(!ensureLoggedIn())return;
  code=String(code||'').trim();
  if(!/^\d{6}$/.test(code)) { lobbyMessage('请输入完整的6位数字房间号。',true); return; }
  lobbyMessage('正在加入房间 '+code+'…'); socket.emit('joinRoom',{code,name:currentUser?.name||'玩家'});
}
$('createRoom').addEventListener('click',createRoom);
$('quickBot').addEventListener('click',createPracticeRoom);
$('joinRoom').addEventListener('click',()=>joinRoom($('roomCodeInput').value));
$('roomCodeInput').addEventListener('keydown',e=>{if(e.key==='Enter')joinRoom($('roomCodeInput').value);});
$('refreshRooms').addEventListener('click',()=>{socket.emit('lobbyRefresh');lobbyMessage('房间列表已刷新。');});
$('logoutBtn').addEventListener('click',()=>{socket.emit('leaveRoom');socket.emit('logout');loggedIn=false;currentUser=null;state=null;roomCode='';setAuthMode(false);showScreen('authScreen');authMessage('已退出登录。');});
socket.on('roomCreated',d=>{
  roomCode=d.code; setText('tableCode',roomCode); showScreen('tableScreen');
  tableMessage('房间已创建。请复制房间号分享给朋友，或添加机器人练习。');
  socket.emit('lobbyRefresh');
  if(quickBotPending){quickBotPending=false;setTimeout(()=>socket.emit('addBot'),250);}
});
socket.on('roomJoined',d=>{roomCode=d.code;setText('tableCode',roomCode);showScreen('tableScreen');tableMessage('已加入房间 '+roomCode+'，等待房主开始。');socket.emit('lobbyRefresh');});
socket.on('errorMessage',msg=>{
  if($('tableScreen').classList.contains('hidden')) lobbyMessage(msg,true); else tableMessage(msg,true);
  toast(msg);
});
socket.on('botAdded',d=>{tableMessage('机器人已加入牌桌。可以开始游戏。');socket.emit('lobbyRefresh');});
$('backLobbyBtn').addEventListener('click',()=>{
  socket.emit('leaveRoom');roomCode='';state=null;compareMode=false;showScreen('lobbyScreen');lobbyMessage('已返回大厅。');socket.emit('lobbyRefresh');
});
$('copyCodeBtn').addEventListener('click',async()=>{
  const code=roomCode||$('tableCode').textContent;
  try { await navigator.clipboard.writeText(code);toast('房间号 '+code+' 已复制'); }
  catch { toast('请记下房间号：'+code); }
});

function startAudio(){try{audioCtx=audioCtx||new(window.AudioContext||window.webkitAudioContext)();if(audioCtx.state==='suspended')audioCtx.resume();}catch{}}
function beep(freq=500,duration=100){try{startAudio();if(!audioCtx)return;const o=audioCtx.createOscillator(),g=audioCtx.createGain();o.type='triangle';o.frequency.value=freq;g.gain.setValueAtTime(.045,audioCtx.currentTime);g.gain.exponentialRampToValueAtTime(.001,audioCtx.currentTime+duration/1000);o.connect(g);g.connect(audioCtx.destination);o.start();o.stop(audioCtx.currentTime+duration/1000);}catch{}}
function speak(text){try{if(!('speechSynthesis'in window))return;speechSynthesis.cancel();const u=new SpeechSynthesisUtterance(text);u.lang='zh-CN';u.rate=.92;speechSynthesis.speak(u);}catch{}}
document.addEventListener('pointerdown',startAudio,{once:true});
function emitAction(action,data={}){socket.emit('action',{action,data});}
function cardText(c){return c?c.s+c.r:'?';}
function renderChips(){const box=$('chipPile');if(!box||!state)return;box.innerHTML='';const count=Math.min(18,Math.floor((state.pot||0)/20));for(let i=0;i<count;i++){const c=document.createElement('div');c.className='chip c'+(i%4+1);c.style.left=(35+((i*17)%31))+'%';c.style.top=(18+((i*23)%59))+'%';c.style.transform='translate(-50%,-50%) rotate('+(((i*29)%51)-25)+'deg)';box.appendChild(c);}}
function render(s){
  state=s; roomCode=s.code; setText('tableCode',s.code);
  const players=s.players||[], me=players.find(p=>p.id===s.me); if(!me)return;
  const current=players.find(p=>p.id===s.turn);
  setText('tableSubtitle',s.ended?'本局已结束 · 可开始下一局':!s.started?'等待玩家加入或开始':`第 ${s.round} 局 · ${current?'轮到 '+current.name:'等待操作'}`);
  setText('pot','底池：'+s.pot);
  if(s.ended)setText('deal',s.message||'本局结束');else if(!s.started)setText('deal',players.length<2?'等待另一位玩家加入，或添加机器人':'玩家已就位，点击「准备好了」开始');else setText('deal',s.turn===s.me?(me.trustee?'托管中：自动跟注':'轮到你操作'):(current?'等待 '+current.name+' 操作':'等待对手操作'));
  const box=$('seats');box.innerHTML='';box.className='seats count-'+players.length;
  const ordered=[...players.filter(p=>p.id!==s.me),me];
  const layouts={1:[[50,82]],2:[[50,18],[50,82]],3:[[25,27],[75,27],[50,82]],4:[[22,30],[78,30],[22,72],[50,82]],5:[[18,30],[50,16],[82,30],[78,72],[50,84]],6:[[17,28],[50,15],[83,28],[83,70],[50,84],[17,70]]};
  const coords=layouts[ordered.length]||layouts[6];
  ordered.forEach((p,idx)=>{
    const isMe=p.id===s.me,el=document.createElement('div');el.style.left=coords[idx][0]+'%';el.style.top=coords[idx][1]+'%';
    el.className='seat '+(isMe?'me ':'')+(p.out?'out ':'')+(p.id===s.turn&&!s.ended?'active':'');el.dataset.playerIndex=p.id;
    if(players.length>4)el.style.width='clamp(72px,20vw,105px)';
    const cards=p.cards||[],visible=isMe||s.ended||cards.some(c=>c!==null);
    el.innerHTML=`<div class="name">${escapeHtml(p.name)}${isMe?'（你）':''}${p.out?' · 已弃牌':''}${!p.connected?' · 断线':''}</div><div class="chips">筹码 ${Number(p.chips)||0}</div><div class="timer">${p.id===s.turn&&!s.ended?'轮到操作':''}</div><div class="cards">${cards.map(c=>`<div class="card ${!c?'back':((c.s==='♥'||c.s==='♦')?'red':'black')}">${!c?'★':escapeHtml(cardText(c))}</div>`).join('')}</div>`;
    if(!isMe&&compareMode&&s.started&&!s.ended&&!p.out&&s.turn===s.me){el.classList.add('compare-target');el.addEventListener('click',()=>{compareMode=false;emitAction('compare',{targetId:p.id});});}
    box.appendChild(el);
  });
  const myTurn=s.started&&!s.ended&&s.turn===s.me&&!me.out&&!me.allIn;
  $('look').disabled=!myTurn||me.seen;$('look').textContent=me.seen?'已看牌':'看牌';$('fold').disabled=!myTurn;$('compare').disabled=!myTurn||me.trustee;
  $('trustee').disabled=!s.started||s.ended||me.out;$('trustee').textContent=me.trustee?'取消托管':'托管';$('trustee').classList.toggle('trustee-on',!!me.trustee);
  const ready=!s.started||s.ended;$('centerReady').classList.toggle('hidden',!ready);$('centerReady').disabled=!ready||players.length<2;$('centerReady').textContent=s.ended?'再来一局':'准备好了';
  const betShow=myTurn&&!compareMode;['centerBet20','centerBet40','centerBet60','customBetBtn'].forEach(id=>{$(id).classList.toggle('hidden',!betShow);$(id).disabled=!betShow;});
  $('centerBet20').disabled=!betShow||20<s.requiredBet||me.chips<20;$('centerBet40').disabled=!betShow||40<s.requiredBet||me.chips<40;$('centerBet60').disabled=!betShow||60<s.requiredBet||me.chips<60;
  if(!betShow)$('customBetWrap').classList.add('hidden');
  const logs=$('log');logs.innerHTML='';(s.log||[]).forEach(line=>{const d=document.createElement('div');d.textContent=line;logs.appendChild(d);});
  renderChips();
  if(s.message&&s.message!==lastMessage){if(/下注|投注/.test(s.message))beep(540,100);else if(/弃牌|比牌/.test(s.message))beep(320,130);else if(/开始|发牌/.test(s.message)){beep(760,170);speak(s.message);}else if(/获胜|本局结束/.test(s.message)){beep(880,260);speak(s.message);}lastMessage=s.message;}
  tableMessage('房间号：'+s.code+' ｜ '+players.length+'/'+(s.players.length>0?6:6)+' 人 ｜ '+(players.length<2?'等待其他玩家加入':s.ended?'本局结束，可再来一局':s.started?'多人对战进行中':'可以开始游戏'));
}
socket.on('state',render);
$('centerReady').addEventListener('click',()=>socket.emit('startRound'));
$('look').addEventListener('click',()=>emitAction('look'));
$('fold').addEventListener('click',()=>emitAction('fold'));
$('compare').addEventListener('click',()=>{compareMode=true;if(state)render(state);setText('deal','请选择一名对手进行比牌');});
$('trustee').addEventListener('click',()=>emitAction('trustee'));
$('addBot').addEventListener('click',()=>socket.emit('addBot'));
$('restart').addEventListener('click',()=>emitAction('restart'));
$('centerBet20').addEventListener('click',()=>emitAction('bet',{amount:20}));
$('centerBet40').addEventListener('click',()=>emitAction('bet',{amount:40}));
$('centerBet60').addEventListener('click',()=>emitAction('bet',{amount:60}));
$('customBetBtn').addEventListener('click',()=>$('customBetWrap').classList.toggle('hidden'));
$('customBetConfirm').addEventListener('click',()=>{const amount=Number($('customBetInput').value);if(!Number.isInteger(amount)||amount<=0){tableMessage('请输入有效的整数下注金额。',true);return;}emitAction('bet',{amount});$('customBetWrap').classList.add('hidden');});
$('customBetInput').addEventListener('keydown',e=>{if(e.key==='Enter')$('customBetConfirm').click();});
