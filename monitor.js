// Live arm monitor tab (monitor.html): measured torque from Present Current next to
// the pose (gravity) estimate the main tab computes and broadcasts. Read-only except
// for the arm control panel, which is the same one the main tab shows.
import {MODEL_CURRENT_SPECS} from './measured-load.js';
import {bindArmControl} from './arm-control.js';
import {poseTorquesFrom,withArmRest} from './load-panel.js';

const KEYS=['R','L'].flatMap(s=>Array.from({length:s==='R'?9:8},(_,j)=>s+(s==='R'?j+1:j+11)));
const SETTINGS='shosaedit-measured-load-settings-v1';   // the main tab's saved coefficients
const STALE_POSE_MS=1500;
const $=id=>document.getElementById(id);
const fmt=(v,d=3)=>Number.isFinite(v)?v.toFixed(d):'—';
const TORQUE={ok:'ON',released:'OFF（脱力）',torque_off:'停止',error:'エラー',no_reply:'応答なし'};
let telemetry=null,arm=null,live=null,pose=null,poseAt=0;
// Time series: one sample per poll (5 Hz) per motor, kept for the longest window.
const MAX_SECONDS=120,history=Object.fromEntries(KEYS.map(k=>[k,[]]));let paused=false;
const COLORS={pose:'#f4b76c',measured:'#89d6c5'};
for(const side of ['R','L'])$('col-'+side).insertAdjacentHTML('beforeend',KEYS.filter(k=>k[0]===side).map((k,i)=>`<div class="chart-card" data-chart="${k}"><div class="ct"><b>${side==='R'?'右':'左'} ID${k.slice(1)} <span class="dim">(${side}${i+1})</span> <span class="dim" data-chart-model></span></b><span class="v"><span style="color:${COLORS.pose}">理論 <span data-chart-pose>—</span></span>　<span style="color:${COLORS.measured}">実電流 <span data-chart-measured>—</span></span> N·m</span></div><canvas></canvas></div>`).join(''));
for(const b of document.querySelectorAll('[data-view]'))b.onclick=()=>{for(const x of document.querySelectorAll('[data-view]'))x.classList.toggle('on',x===b);$('view-charts').hidden=b.dataset.view!=='charts';$('view-table').hidden=b.dataset.view!=='table';};
$('mon-pause').onclick=()=>{paused=!paused;$('mon-pause').textContent=paused?'再開':'一時停止';};
$('mon-clear').onclick=()=>{for(const k of KEYS)history[k]=[];draw();};
$('mon-csv').onclick=()=>{const rows=[['time_ms','motor','theoretical_Nm','current_based_Nm']];for(const k of KEYS)for(const s of history[k])rows.push([s.t,k,Number.isFinite(s.pose)?s.pose:'',Number.isFinite(s.measured)?s.measured:'']);
 const a=document.createElement('a');a.href=URL.createObjectURL(new Blob([rows.map(r=>r.join(',')).join('\n')],{type:'text/csv'}));a.download=`torque-timeseries-${new Date().toISOString().replace(/[:.]/g,'-')}.csv`;a.click();setTimeout(()=>URL.revokeObjectURL(a.href),1000);};
$('mon-window').onchange=$('mon-yaxis').onchange=()=>draw();

function drawChart(k){
 const card=document.querySelector(`[data-chart="${k}"]`),canvas=card.querySelector('canvas'),dpr=devicePixelRatio||1;
 const w=canvas.clientWidth,h=canvas.clientHeight;if(!w)return;
 if(canvas.width!==Math.round(w*dpr)||canvas.height!==Math.round(h*dpr)){canvas.width=Math.round(w*dpr);canvas.height=Math.round(h*dpr);}
 const g=canvas.getContext('2d');g.setTransform(dpr,0,0,dpr,0,0);g.clearRect(0,0,w,h);
 const span=Number($('mon-window').value)*1000,end=Date.now(),start=end-span,data=history[k].filter(s=>s.t>=start);
 let lim=Number($('mon-yaxis').value);
 if(!lim){lim=0.05;for(const s of data)for(const v of [s.pose,s.measured])if(Number.isFinite(v))lim=Math.max(lim,Math.abs(v)*1.15);}
 const L=34,R=4,T=4,B=14,x=t=>L+(t-start)/span*(w-L-R),y=v=>T+(1-(v+lim)/(2*lim))*(h-T-B);
 g.font='10px system-ui';g.fillStyle='#7d889a';g.strokeStyle='#2a313c';g.lineWidth=1;
 for(const v of [lim,0,-lim]){g.beginPath();g.moveTo(L,y(v));g.lineTo(w-R,y(v));g.stroke();g.fillText((Math.abs(v)<1e-9?'0':v.toFixed(lim<1?2:1)),2,y(v)+3);}
 g.fillText(`-${span/1000}s`,L,h-2);g.fillText('今',w-R-12,h-2);
 for(const key of ['pose','measured']){g.strokeStyle=COLORS[key];g.lineWidth=1.6;g.beginPath();let pen=false,prev=null;
  for(const s of data){const v=s[key];if(!Number.isFinite(v)||(prev&&s.t-prev>1500)){pen=false;}if(Number.isFinite(v)){const px=x(s.t),py=y(Math.max(-lim,Math.min(lim,v)));pen?g.lineTo(px,py):g.moveTo(px,py);pen=true;}prev=s.t;}
  g.stroke();}
}
function draw(){for(const k of KEYS)drawChart(k);}

// The theoretical torque is computed here from the live positions, with the mass /
// calibration model the main tab publishes (kept in localStorage, so the main tab
// may sit in the background or be closed once it has published it).
let poseModel=null;try{poseModel=JSON.parse(localStorage.getItem('shosaedit-pose-model')||'null');}catch{}
try{new BroadcastChannel('shosaedit-live-pose').onmessage=e=>{if(e.data?.model)poseModel=JSON.parse(e.data.model);};}catch{}
let armRest=null;
function updatePose(){if(!poseModel||!live)return;const t=poseTorquesFrom(withArmRest(poseModel,armRest),{R:live.R,L:live.L});
 pose=Object.fromEntries(Object.entries(t).flatMap(([side,cols])=>Object.entries(cols).map(([col,v])=>[`${side}${Number(col)+(side==='R'?1:11)}`,v])));poseAt=Date.now();}

function coefficient(key,model){
 try{const saved=JSON.parse(localStorage.getItem(SETTINGS)||'{}')[key]?.torquePerAmpNm;if(Number.isFinite(saved))return saved;}catch{}
 return MODEL_CURRENT_SPECS[model]?.torquePerAmpNm;
}

$('mon-rows').innerHTML=KEYS.map((k,i)=>`<tr data-key="${k}" class="${k==='L11'?'side-start':''}"><td><b>${k[0]==='R'?'右':'左'} ID${k.slice(1)}</b> <span class="dim">(${k[0]}${k[0]==='R'?i+1:i-8})</span></td><td data-f="pose" class="big" style="color:#f4b76c">—</td><td data-f="measured" class="big" style="color:#89d6c5">—</td><td data-f="diff">—</td><td><div class="bar"><span class="zero"></span><span class="p"></span><span class="m"></span></div></td><td data-f="current" class="dim">—</td><td class="model dim" data-f="model">—</td><td data-f="torqueOn" class="dim">—</td><td data-f="state" class="dim">—</td><td data-f="position" class="dim">—</td></tr>`).join('');

function bar(el,cls,v,scale){const b=el.querySelector('.'+cls);if(!Number.isFinite(v)){b.style.width='0';return;}
 const w=Math.min(Math.abs(v)/scale,1)*50;b.style.width=w+'%';b.style.left=(v<0?50-w:50)+'%';}

function render(){
 const scale=Number($('mon-scale').value)||1,now=Date.now(),poseFresh=pose&&now-poseAt<STALE_POSE_MS;
 const channels=Object.fromEntries((telemetry?.channels||[]).map(c=>[c.side+c.id,c]));
 for(const k of KEYS){
  const row=document.querySelector(`tr[data-key="${k}"]`),c=channels[k],side=k[0],id=k.slice(1);
  const a=arm?.arms?.[side],model=a?.models?.[id]||'—',status=a?.motors?.[id];
  const k2=c?.model||'';const coef=coefficient(k,k2);
  const measured=c&&c.fresh&&Number.isFinite(coef)?c.currentA*coef:NaN;
  const p=poseFresh?pose[k]:undefined;
  const idx=side==='R'?Number(id)-1:Number(id)-11,pos=live?.[side]?.[idx];
  const set=(f,t)=>{const el=row.querySelector(`[data-f="${f}"]`);if(el.textContent!==t)el.textContent=t;};
  set('model',model);set('torqueOn',TORQUE[status]||'—');
  set('state',!c?(model==='XL430-W250'?'電流なし（XL430）':'未取得'):c.fresh?'受信中':'更新停止');
  set('current',fmt(c?.fresh?c.currentA:NaN));set('measured',fmt(measured));set('pose',fmt(p));
  set('diff',Number.isFinite(measured)&&Number.isFinite(p)?fmt(measured-p):'—');
  set('position',Number.isFinite(pos)?String(pos):'—');
  const barEl=row.querySelector('.bar');bar(barEl,'m',measured,scale);bar(barEl,'p',p,scale);
  if(!paused){const h=history[k];h.push({t:now,pose:Number.isFinite(p)?p:NaN,measured});while(h.length&&h[0].t<now-MAX_SECONDS*1000)h.shift();}
  const card=document.querySelector(`[data-chart="${k}"]`);card.querySelector('[data-chart-pose]').textContent=fmt(p);card.querySelector('[data-chart-measured]').textContent=fmt(measured);card.querySelector('[data-chart-model]').textContent=model==='—'?'':model;
 }
 const n=Object.values(channels).filter(c=>c.fresh).length;
 if(!paused&&!$('view-charts').hidden)draw();
 $('mon-status').textContent=`実電流 ${n} / 17 軸受信中 · 理論値 ${poseFresh?'計算中':poseModel?'位置待ち':'モデル未受信（メインタブを一度開いてください）'} · 基準姿勢 ${['R','L'].map(s=>armRest?.[s]?.rest?`${s} ${armRest[s].model}（${armRest[s].time}）`:`${s} 未校正`).join(' / ')}`;
}

async function get(url){const r=await fetch(url,{cache:'no-store'});if(!r.ok)throw Error(r.status);return r.json();}
async function poll(){
 try{[telemetry,live]=await Promise.all([get('/api/telemetry/status'),get('/api/arm/live')]);updatePose();}catch{telemetry=null;}
 render();setTimeout(poll,200);
}
async function pollArm(){try{arm=await get('/api/arm/status?since=999999999');armRest=await get('/api/arm/calibration');}catch{arm=null;}setTimeout(pollArm,1000);}
$('mon-scale').onchange=render;
bindArmControl({mount:host=>document.querySelector('.mon-side').append(host)});
poll();pollArm();
