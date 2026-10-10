const socket = io();
let loggedIn = false;
function authMsg(s){ $('authMessage').textContent=s; }
function sendAuth(kind){const username=$('authUser').value.trim(),password=$('authPass').value,name=$('authName').value.trim();if(!username||!password){authMsg('请填写用户名和密码。');return;}socket.emit(kind,{username,password,name});}
$('loginBtn').onclick=()=>sendAuth('login');$('registerBtn').onclick=()=>sendAuth('register');
$('authPass').addEventListener('keydown',e=>{if(e.key==='Enter')sendAuth('login')});
socket.on('authResult',r=>{authMsg(r.message||'');if(!r.ok)return;loggedIn=true;$('authPanel').style.display='none';$('roomPanel').style.display='flex';$('gameArea').style.display='flex';$('playerName').value=r.name||r.username;roomMsg('已登录：'+r.username+'。可以创建房间、加入真人房间或添加机器人。');socket.emit('lobbyRefresh');});
socket.on('lobbyRooms',rooms=>{const box=$('roomList');if(!box)return;if(!rooms.length){box.textContent='当前没有等待加入的房间。';return;}box.innerHTML='<b>可加入的房间：</b> '+rooms.map(r=>'<button data-code="'+r.code+'" style="margin:3px;padding:5px 8px;border:1px solid #476454;border-radius:7px;background:#10251d;color:#e7d16b">'+r.code+' · '+r.players+'/'+(r.maxPlayers||6)+' · '+escapeHtml(r.host)+'</button>').join('');box.querySelectorAll('button').forEach(b=>b.onclick=()=>{$('roomCodeInput').value=b.dataset.code;$('joinRoom').click();});});
$('addBot').onclick=()=>socket.emit('addBot');$('refreshRooms').onclick=()=>socket.emit('lobbyRefresh');$('logoutBtn').onclick=()=>{loggedIn=false;socket.emit('logout');$('authPanel').style.display='block';$('roomPanel').style.display='none';$('gameArea').style.display='none';roomMsg('已退出登录。');};

const $ = id => document.getElementById(id);
let roomCode = '', myId = '', state = null, compareMode = false, audioCtx = null, lastLogCount = 0, lastMessage = '';
function roomMsg(s){ $('roomMessage').textContent=s; }
function speak(s){ try { if(!('speechSynthesis' in window)) return; speechSynthesis.cancel(); const u=new SpeechSynthesisUtterance(s);u.lang='zh-CN';u.rate=.9;speechSynthesis.speak(u); } catch(e){} }
function startMusic(){try{audioCtx=audioCtx||new(window.AudioContext||window.webkitAudioContext)();if(audioCtx.state==='suspended')audioCtx.resume();}catch(e){}}
function beep(freq=500,d=100){try{audioCtx=audioCtx||new(window.AudioContext||window.webkitAudioContext)();const o=audioCtx.createOscillator(),g=audioCtx.createGain();o.frequency.value=freq;o.connect(g);g.connect(audioCtx.destination);g.gain.value=.04;o.start();o.stop(audioCtx.currentTime+d/1000)}catch(e){}}
document.addEventListener('pointerdown',startMusic,{once:true});
function emitAction(action,data={}){socket.emit('action',{action,data});}
$('createRoom').onclick=()=>{if(!loggedIn){roomMsg('请先登录。');return;}const name=$('playerName').value.trim()||'玩家';socket.emit('createRoom',{name});};
$('joinRoom').onclick=()=>{if(!loggedIn){roomMsg('请先登录。');return;}const code=$('roomCodeInput').value.trim();if(!/^\d{6}$/.test(code)){roomMsg('请输入6位数字房间号。');return;}socket.emit('joinRoom',{code,name:$('playerName').value.trim()||'玩家'});};
socket.on('roomCreated',d=>{socket.emit('lobbyRefresh');roomCode=d.code;$('roomCodeInput').value=d.code;roomMsg('房间已创建，房间号：'+d.code+'。把这6位数字发给另一位玩家，让对方输入后点击“加入房间”。');});
socket.on('roomJoined',d=>{socket.emit('lobbyRefresh');roomCode=d.code;$('roomCodeInput').value=d.code;roomMsg('已加入房间 '+d.code+'，等待房主开始游戏。');});
socket.on('errorMessage',s=>roomMsg(s));
socket.on('connect',()=>{roomMsg('服务器已连接。请先登录或注册。');});
socket.on('botAdded',d=>{roomMsg('已添加机器人，房间号：'+d.code);});
socket.on('disconnect',()=>{roomMsg('与服务器断开连接，正在尝试重连……');});
socket.on('state',s=>{state=s;myId=s.me;roomCode=s.code;render(s);});
function cardText(c){return c?c.s+c.r:'?';}
function renderChips(){const box=$('chipPile');if(!box||!state)return;box.innerHTML='';const count=Math.min(18,Math.floor(state.pot/20));for(let i=0;i<count;i++){const c=document.createElement('div');c.className='chip c'+(i%4+1);c.style.left=(35+((i*17)%31))+'%';c.style.top=(18+((i*23)%59))+'%';c.style.transform='translate(-50%,-50%) rotate('+(((i*29)%51)-25)+'deg)';box.appendChild(c);}}
function render(s){
 const players=s.players||[], my=players.find(p=>p.id===s.me), opponent=players.find(p=>p.id!==s.me); if(!my)return;
 $('status').textContent=s.ended?'本局结束':s.dealing?'正在发牌':!s.started?'等待开始':(players.find(p=>p.id===s.turn)?.name?'轮到：'+players.find(p=>p.id===s.turn).name:'等待中');
 $('pot').textContent='底池：'+s.pot;
 if(s.ended)$('deal').textContent=s.message||'本局结束';else if(!s.started)$('deal').textContent=players.length<2?'等待另一位玩家加入':'双方已就位，点击“准备好了”开始';else if(s.turn===s.me)$('deal').textContent=my.trustee?'托管中：自动跟注':'轮到你操作';else $('deal').textContent='等待对手操作';
 const box=$('seats');box.innerHTML='';box.className='seats count-'+players.length;
 // 保留 V28 牌桌视觉风格；多人时围绕椭圆牌桌排列，自己固定在下方。
 const ordered=[...players.filter(p=>p.id!==s.me),my].filter(Boolean);
 const layouts={2:[[50,18],[50,82]],3:[[25,27],[75,27],[50,82]],4:[[22,30],[78,30],[22,72],[50,82]],5:[[18,30],[50,16],[82,30],[78,72],[50,84]],6:[[17,28],[50,15],[83,28],[83,70],[50,84],[17,70]]};
 const coords=layouts[ordered.length]||layouts[6];
 ordered.forEach((p,idx)=>{const isMe=p.id===s.me;const el=document.createElement('div');el.style.left=coords[idx][0]+'%';el.style.top=coords[idx][1]+'%';el.className='seat '+(isMe?'me ':'')+(p.out?'out ':'')+(p.id===s.turn&&!s.ended?'active':'');el.dataset.playerIndex=p.id;el.style.width=players.length>4?'clamp(78px,22vw,112px)':players.length>2?'clamp(88px,25vw,125px)':'clamp(105px,30vw,145px)';const cards=p.cards||[];const visible=isMe||s.ended||cards.some(c=>c!==null);el.innerHTML='<div class="name">'+escapeHtml(p.name)+(isMe?'（你）':'')+(p.out?' · 已弃牌':'')+(!p.connected?' · 断线':'')+'</div><div class="chips">筹码 '+p.chips+'</div><div class="timer">'+(p.id===s.turn&&!s.ended?'轮到操作':'')+'</div><div class="cards">'+cards.map(c=>'<div class="card '+(!c?'back':((c.s==='♥'||c.s==='♦')?'red':'black'))+'">'+(!c?'★':cardText(c))+'</div>').join('')+'</div>';
 if(!isMe&&compareMode&&s.started&&!s.ended&&!p.out&&s.turn===s.me){el.classList.add('compare-target');el.style.cursor='pointer';el.onclick=()=>{compareMode=false;emitAction('compare',{targetId:p.id});};}box.appendChild(el);});
 const myTurn=s.started&&!s.ended&&s.turn===s.me&&!my.out&&!my.allIn;
 $('look').disabled=!myTurn||my.seen;$('look').textContent=my.seen?'已看牌':'看牌';$('fold').disabled=!myTurn;$('compare').disabled=!myTurn||my.trustee;
 $('trustee').disabled=!s.started||s.ended||my.out;$('trustee').textContent=my.trustee?'取消托管':'托管';$('trustee').classList.toggle('trustee-on',!!my.trustee);
 const ready=!s.started||s.ended;$('centerReady').style.display=ready?'inline-block':'none';$('centerReady').disabled=!ready||players.length<2;$('centerReady').textContent=s.ended?'再来一局':'准备好了';
 $('restart').style.display='block';$('restart').textContent='重置/重开';
 const betShow=myTurn&&!compareMode;['centerBet20','centerBet40','centerBet60','customBetBtn'].forEach(id=>{const el=$(id);el.style.display=betShow?'inline-block':'none';el.disabled=!betShow;});$('centerBet20').disabled=!betShow||20<s.requiredBet||my.chips<20;$('centerBet40').disabled=!betShow||40<s.requiredBet||my.chips<40;$('centerBet60').disabled=!betShow||60<s.requiredBet||my.chips<60;
 if(!betShow)$('customBetWrap').style.display='none';
 const logs=$('log');logs.innerHTML='';(s.log||[]).forEach(line=>{const d=document.createElement('div');d.textContent=line;logs.appendChild(d);});
 renderChips();
 const names=players.map(p=>p.name).join('、');roomMsg('房间号：'+s.code+'｜玩家：'+names+'｜'+(players.length<2?'等待其他玩家加入':s.ended?'本局结束，可再来一局':s.started?'多人对战进行中':'玩家已就位，可以开始'));
 if(s.message&&s.message!==lastMessage){if(/下注/.test(s.message))beep(540,100);else if(/弃牌|比牌/.test(s.message))beep(320,130);else if(/开始/.test(s.message))speak(s.message);lastMessage=s.message;}
}
function escapeHtml(v){return String(v).replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));}
$('centerReady').onclick=()=>socket.emit('startRound');$('start').onclick=()=>socket.emit('startRound');$('restart').onclick=()=>emitAction('restart');$('look').onclick=()=>emitAction('look');$('fold').onclick=()=>emitAction('fold');$('compare').onclick=()=>{compareMode=true;if(state)render(state);$('deal').textContent='请选择对手进行比牌';};$('trustee').onclick=()=>emitAction('trustee');
$('centerBet20').onclick=()=>emitAction('bet',{amount:20});$('centerBet40').onclick=()=>emitAction('bet',{amount:40});$('centerBet60').onclick=()=>emitAction('bet',{amount:60});$('customBetBtn').onclick=()=>{$('customBetWrap').style.display=$('customBetWrap').style.display==='grid'?'none':'grid';};$('customBetConfirm').onclick=()=>{const amount=Number($('customBetInput').value);if(!Number.isInteger(amount)||amount<=0){roomMsg('请输入有效的整数下注金额。');return;}emitAction('bet',{amount});$('customBetWrap').style.display='none';};$('customBetInput').addEventListener('keydown',e=>{if(e.key==='Enter')$('customBetConfirm').click();});
