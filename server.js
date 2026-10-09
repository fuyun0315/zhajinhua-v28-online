const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const path = require('path');
const app = express();
const server = http.createServer(app);
const io = new Server(server);
const PORT = process.env.PORT || 3000;
app.use(express.static(path.join(__dirname, 'public')));
app.get('/health', (_req,res)=>res.json({ok:true, service:'zhajinhua-v28-online-web'}));
const rooms = new Map();
const MAX_PLAYERS = 6, START_CHIPS = 1000, ANTE = 20;
function newCode(){let c;do{c=String(Math.floor(100000+Math.random()*900000));}while(rooms.has(c));return c;}
function cleanName(v){return String(v||'玩家').trim().slice(0,12)||'玩家';}
function getRoom(s){return rooms.get(s.data.roomCode);}
function getPlayer(r,id){return r.players.find(p=>p.id===id);}
function alive(r){return r.players.filter(p=>p.connected&&!p.folded);}
function deck(){const suits=['♠','♥','♦','♣'],a=[];for(const s of suits)for(let v=2;v<=14;v++)a.push({s,v,label:({11:'J',12:'Q',13:'K',14:'A'}[v]||String(v))+s});for(let i=a.length-1;i>0;i--){const j=Math.floor(Math.random()*(i+1));[a[i],a[j]]=[a[j],a[i]];}return a;}
// Ranking matches the common order used in the V28 source: 豹子 > 顺金 > 金花 > 顺子 > 对子 > 散牌.
function rank(cards){const vals=cards.map(c=>c.v).sort((a,b)=>b-a), counts={};vals.forEach(v=>counts[v]=(counts[v]||0)+1);const groups=Object.entries(counts).map(([v,n])=>({v:+v,n})).sort((a,b)=>b.n-a.n||b.v-a.v);const flush=cards.every(c=>c.s===cards[0].s),u=[...new Set(vals)].sort((a,b)=>b-a);let sh=0;if(u.length===3){if(u[0]-u[1]===1&&u[1]-u[2]===1)sh=u[0];else if(u.join(',')==='14,3,2')sh=3;}if(groups[0].n===3)return [6,groups[0].v];if(flush&&sh)return [5,sh];if(flush)return [4,...vals];if(sh)return [3,sh];if(groups[0].n===2)return [2,groups[0].v,groups.find(g=>g.n===1).v];return [1,...vals];}
function compare(a,b){const x=rank(a),y=rank(b);for(let i=0;i<Math.max(x.length,y.length);i++){if((x[i]||0)!==(y[i]||0))return (x[i]||0)>(y[i]||0)?1:-1;}return 0;}
function nextTurn(r,from){const ix=r.players.findIndex(p=>p.id===from);for(let n=1;n<=r.players.length;n++){const p=r.players[(ix+n+r.players.length)%r.players.length];if(p&&p.connected&&!p.folded&&p.chips>0)return p;}return null;}
function publicState(r){return {code:r.code,hostId:r.hostId,started:r.started,pot:r.pot,currentBet:r.currentBet,turnId:r.turnId,message:r.message,players:r.players.map(p=>({id:p.id,name:p.name,chips:p.chips,bet:p.bet,folded:p.folded,connected:p.connected,isHost:p.id===r.hostId,hasCards:!!p.cards}))};}
function publish(r){io.to(r.code).emit('room:state',publicState(r));}
function finish(r,winner,msg){if(winner)winner.chips+=r.pot;r.message=msg;r.pot=0;r.currentBet=0;r.turnId=null;r.started=false;r.acted.clear();r.players.forEach(p=>{p.cards=null;p.bet=0;p.folded=false;});publish(r);}
function showdown(r){const a=alive(r);if(!a.length)return finish(r,null,'本局结束，没有获胜者。');let best=[a[0]],bestRank=rank(a[0].cards);for(let i=1;i<a.length;i++){const rr=rank(a[i].cards),cmp=compare(a[i].cards,best[0].cards);if(cmp>0){best=[a[i]];bestRank=rr;}else if(cmp===0)best.push(a[i]);}const total=r.pot,each=Math.floor(total/best.length),remainder=total%best.length;best.forEach((p,i)=>p.chips+=each+(i===0?remainder:0));const msg=best.length===1?best[0].name+' 摊牌获胜，获得 '+total+' 筹码。':'摊牌平手：'+best.map(p=>p.name).join('、')+' 平分底池 '+total+' 筹码。';r.message=msg;r.pot=0;r.currentBet=0;r.turnId=null;r.started=false;r.acted.clear();r.players.forEach(p=>{p.cards=null;p.bet=0;p.folded=false;});publish(r);}
function bettingComplete(r){const a=alive(r);return a.length>=2&&a.every(p=>p.bet>=r.currentBet&&r.acted.has(p.id));}
function startRound(r,s){if(s.id!==r.hostId)return s.emit('notice','只有房主可以开始新一局。');if(r.started)return s.emit('notice','当前一局还没有结束。');const ready=r.players.filter(p=>p.connected&&p.chips>=ANTE);if(ready.length<2)return s.emit('notice','至少需要两名在线且有足够筹码的玩家。');const d=deck();r.started=true;r.pot=0;r.currentBet=ANTE;r.acted.clear();r.message='新一局开始，每人已投入20虚拟筹码。';for(const p of r.players){p.bet=0;p.folded=!p.connected||p.chips<ANTE;p.cards=null;if(!p.folded){p.chips-=ANTE;p.bet=ANTE;r.pot+=ANTE;p.cards=[d.pop(),d.pop(),d.pop()];}}r.turnId=(r.players.find(p=>p.connected&&!p.folded)||{}).id||null;for(const p of r.players)if(p.connected&&p.cards)io.to(p.id).emit('cards:private',p.cards);publish(r);}
io.on('connection',s=>{
 s.on('room:create',({name}={},cb=()=>{})=>{const code=newCode(),p={id:s.id,name:cleanName(name),chips:START_CHIPS,bet:0,folded:false,connected:true,cards:null};const r={code,hostId:s.id,players:[p],started:false,pot:0,currentBet:0,turnId:null,message:'房间已创建，把6位房间号发给好友即可。',acted:new Set()};rooms.set(code,r);s.join(code);s.data.roomCode=code;cb({ok:true,code});publish(r);});
 s.on('room:join',({code,name}={},cb=()=>{})=>{code=String(code||'').trim();const r=rooms.get(code);if(!r)return cb({ok:false,error:'房间号不存在。'});if(r.started)return cb({ok:false,error:'本局正在进行，请等本局结束后再加入。'});if(r.players.length>=MAX_PLAYERS)return cb({ok:false,error:'房间最多6人。'});const p={id:s.id,name:cleanName(name),chips:START_CHIPS,bet:0,folded:false,connected:true,cards:null};r.players.push(p);s.join(code);s.data.roomCode=code;r.message=p.name+' 加入了房间。';cb({ok:true,code});publish(r);});
 s.on('game:start',()=>{const r=getRoom(s);if(r)startRound(r,s);});
 s.on('game:action',({action,amount,targetId}={})=>{const r=getRoom(s);if(!r||!r.started)return;const p=getPlayer(r,s.id);if(!p||p.folded||r.turnId!==s.id)return s.emit('notice','现在还没轮到你操作。');
  if(action==='fold'){p.folded=true;r.message=p.name+' 弃牌。';const a=alive(r);if(a.length<=1)return finish(r,a[0],(a[0]?.name||'无人')+' 获胜！');r.turnId=(nextTurn(r,p.id)||{}).id||null;publish(r);return;}
  if(action==='call'){const due=Math.max(0,r.currentBet-p.bet);if(due>p.chips)return s.emit('notice','虚拟筹码不足，不能跟注。');p.chips-=due;p.bet+=due;r.pot+=due;r.acted.add(p.id);r.message=p.name+' 跟注 '+due+'。';}
  else if(action==='raise'){const target=Math.max(r.currentBet+20,Math.floor(Number(amount)||r.currentBet+20));const due=target-p.bet;if(due<=0||due>p.chips)return s.emit('notice','加注金额不合法或虚拟筹码不足。');p.chips-=due;p.bet=target;r.pot+=due;r.currentBet=target;r.acted.clear();r.acted.add(p.id);r.message=p.name+' 加注到 '+target+'。';}
  else if(action==='compare'){const t=getPlayer(r,targetId);if(!t||t.folded||!t.cards||t.id===p.id)return s.emit('notice','请选择仍在场的有效对手。');if(p.chips<20)return s.emit('notice','比牌需要至少20虚拟筹码。');p.chips-=20;r.pot+=20;const result=compare(p.cards,t.cards);if(result>0){t.folded=true;r.message=p.name+' 比牌胜过 '+t.name+'，对方弃牌。';}else{p.folded=true;r.message=p.name+' 比牌未胜过 '+t.name+'，自己弃牌。';}const a=alive(r);if(a.length<=1)return finish(r,a[0],(a[0]?.name||'无人')+' 获胜！');}
  else return s.emit('notice','未知操作。');if(bettingComplete(r))return showdown(r);const n=nextTurn(r,p.id);if(!n){const a=alive(r);return finish(r,a[0],(a[0]?.name||'无人')+' 获胜！');}r.turnId=n.id;publish(r);
 });
 s.on('disconnect',()=>{const r=getRoom(s);if(!r)return;const p=getPlayer(r,s.id);if(p){p.connected=false;if(r.started)p.folded=true;}r.players=r.players.filter(x=>x.connected);if(!r.players.length){rooms.delete(r.code);return;}if(!r.players.some(x=>x.id===r.hostId))r.hostId=r.players[0].id;if(r.started){const a=alive(r);if(a.length<=1)return finish(r,a[0],(a[0]?.name||'无人')+' 获胜！');if(r.turnId===s.id)r.turnId=(nextTurn(r,s.id)||{}).id||null;}publish(r);});
});
server.listen(PORT,'0.0.0.0',()=>console.log('ZhaJinHua V28 online web listening on '+PORT));
