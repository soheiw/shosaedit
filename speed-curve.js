export const defaultPoints=()=>[0,1/6,1/3,.5,2/3,5/6,1].map(x=>({x,y:1}));
const clamp=(v,a,b)=>Math.max(a,Math.min(b,v));
const cubic=(a,b,c,d,t)=>(1-t)**3*a+3*(1-t)**2*t*b+3*(1-t)*t*t*c+t**3*d;
export function speedAt(points,x){const k=x<=points[3].x?0:3;let lo=0,hi=1;for(let i=0;i<30;i++){const t=(lo+hi)/2;if(cubic(...points.slice(k,k+4).map(p=>p.x),t)<x)lo=t;else hi=t;}return cubic(...points.slice(k,k+4).map(p=>p.y),(lo+hi)/2);}
export function timeMap(points,enabled=true){const n=2048,values=new Float64Array(n+1);for(let i=1;i<=n;i++)values[i]=values[i-1]+1/(n*(enabled?speedAt(points,(i-.5)/n):1));return {total:values[n],time(x){const a=clamp(x,0,1)*n,i=Math.min(n-1,Math.floor(a));return values[i]+(values[i+1]-values[i])*(a-i);},position(t){if(t<=0)return 0;if(t>=values[n])return 1;let lo=0,hi=n;while(hi-lo>1){const m=(hi+lo)>>1;if(values[m]<t)lo=m;else hi=m;}return (lo+(t-values[lo])/(values[hi]-values[lo]))/n;}};}
export function createSpeedEditor(host,onChange=()=>{}){
 const key='augmented-arms-speed-curves-v2',legacyKey='augmented-arms-speed-curves-v1';
 const read=k=>{try{const s=JSON.parse(localStorage.getItem(k));return s&&typeof s==='object'&&!Array.isArray(s)?s:{};}catch{return {};}};
 const legacy=read(legacyKey),saved=read(key);
 const validPoints=ps=>Array.isArray(ps)&&ps.length===7&&ps.every((p,i)=>p&&Number.isFinite(p.x)&&Number.isFinite(p.y)&&p.y>=.1&&p.y<=3&&p.x>=0&&p.x<=1&&(!i||p.x>ps[i-1].x))&&ps[0].x===0&&ps[6].x===1;
 const copy=c=>({points:c.points.map(p=>({...p})),enabled:c.enabled,rate:c.rate});
 const curve=(c,fallback)=>validPoints(c?.points)?{points:c.points.map(p=>({x:p.x,y:p.y})),enabled:c.enabled!==false,rate:Number.isFinite(c.rate)?clamp(c.rate,.25,3):1}:fallback?copy(fallback):{points:defaultPoints(),enabled:true,rate:1};
 const stateFor=id=>{const old=curve(legacy[id]),s=saved[id];return {linked:s?.linked===true,selected:s?.selected==='L'?'L':'R',R:curve(s?.R,old),L:curve(s?.L,old),common:curve(s?.common,old)};};
 let clip='1',state=stateFor(clip),selected=3,durations={R:1,L:1},cursors={R:0,L:0},drag=null,map,maps=new WeakMap();
 const active=()=>state.linked?state.common:state[state.selected];
 const mapFor=c=>{if(!maps.has(c))maps.set(c,timeMap(c.points,c.enabled));return maps.get(c);};
 const effective=side=>state.linked?state.common:state[side==='L'?'L':'R'];
 host.innerHTML=`<div class="section-heading"><h2>速度カーブ</h2><label><input id="speed-link" type="checkbox"> LINK（左右共通）</label></div><div class="row speed-arm-rates" id="speed-independent"><label>右腕 <input id="speed-right" type="number" min="0.25" max="3" step="0.05" aria-label="右腕の再生速度"> ×</label><label>左腕 <input id="speed-left" type="number" min="0.25" max="3" step="0.05" aria-label="左腕の再生速度"> ×</label></div><div class="row" id="speed-common-row" hidden><label>共通速度 <input id="speed-common" type="number" min="0.25" max="3" step="0.05" aria-label="左右共通の再生速度"> ×</label></div><div class="row"><label>編集する腕 <select id="speed-side"><option value="R">右腕</option><option value="L">左腕</option></select></label><span id="speed-mode-note"></span><label><input id="curve-enabled" type="checkbox" checked> 有効</label></div><p class="curve-help">横軸：元データの時間 ／ 縦軸：速度倍率<br>丸い点と小さいハンドルをドラッグ。1×が等速です。</p><svg id="speed-graph" viewBox="0 0 440 230" role="img" aria-label="ベジェ曲線で再生速度を編集"></svg><div class="row"><label>編集点 <select id="curve-point"><option value="0">開始点</option><option value="1">開始側ハンドル</option><option value="2">中央の左ハンドル</option><option value="3" selected>中央点</option><option value="4">中央の右ハンドル</option><option value="5">終了側ハンドル</option><option value="6">終了点</option></select></label></div><div class="row"><label>位置 <input id="curve-x" type="number" min="0" max="100" step="1"> %</label><label>速度 <input id="curve-y" type="number" min="0.1" max="3" step="0.1"> ×</label></div><div class="row"><button id="curve-reset">等速に戻す</button><span id="curve-duration"></span></div><p class="curve-help">Motionごとに左右別で自動保存。速度倍率とカーブを掛け合わせます。連動を解除すると左右別の設定に戻ります。最小0.1×。</p>`;
 const $=id=>host.querySelector('#'+id),svg=$('speed-graph'),X=x=>40+x*380,Y=y=>198-y/3*174;
 function persist(){saved[clip]={linked:state.linked,selected:state.selected,R:copy(state.R),L:copy(state.L),common:copy(state.common)};try{localStorage.setItem(key,JSON.stringify(saved));}catch{/* Playback remains usable if storage is full or unavailable. */}}
 function draw(){const {points,enabled,rate}=active(),duration=durations[state.selected];map=mapFor(active());let s='';
  for(const y of [0,1,2,3])s+=`<line x1="40" x2="420" y1="${Y(y)}" y2="${Y(y)}" stroke="${y===1?'#8aab9c':'#34404d'}" stroke-dasharray="${y===1?'5 4':'0'}"/><text x="6" y="${Y(y)+4}">${y}×</text>`;
  for(const x of [0,.5,1])s+=`<text x="${X(x)}" y="221" text-anchor="middle">${(x*duration).toFixed(1)}秒</text>`;
  for(const [a,b] of [[0,1],[2,3],[3,4],[5,6]])s+=`<line x1="${X(points[a].x)}" y1="${Y(points[a].y)}" x2="${X(points[b].x)}" y2="${Y(points[b].y)}" stroke="#758794"/>`;
  s+=`<path d="M ${X(points[0].x)} ${Y(points[0].y)} C ${points.slice(1,4).map(p=>`${X(p.x)} ${Y(p.y)}`).join(' ')} C ${points.slice(4).map(p=>`${X(p.x)} ${Y(p.y)}`).join(' ')}" fill="none" stroke="${enabled?'#89d6c5':'#707a85'}" stroke-width="3"/>`;
  points.forEach((p,i)=>s+=`<circle data-point="${i}" cx="${X(p.x)}" cy="${Y(p.y)}" r="${i%3===0?8:6}" fill="${i===selected?'#f4cd81':i%3===0?'#89d6c5':'#202b35'}" stroke="#b9ded4" stroke-width="2"/>`);
  const x=X(cursors[state.selected]);s+=`<line id="curve-cursor" x1="${x}" x2="${x}" y1="20" y2="198" stroke="#fff" opacity=".65" pointer-events="none"/>`;svg.innerHTML=s;
  $('curve-x').value=(points[selected].x*100).toFixed(1);$('curve-x').disabled=selected===0||selected===6;$('curve-y').value=points[selected].y.toFixed(2);$('curve-point').value=selected;$('curve-enabled').checked=enabled;
  $('speed-link').checked=state.linked;$('speed-side').value=state.selected;$('speed-side').disabled=state.linked;$('speed-independent').hidden=state.linked;$('speed-common-row').hidden=!state.linked;
  // Inline display also protects these rows from broad existing .row CSS rules.
  $('speed-independent').style.display=state.linked?'none':'';$('speed-common-row').style.display=state.linked?'':'none';
  $('speed-right').value=state.R.rate;$('speed-left').value=state.L.rate;$('speed-common').value=state.common.rate;$('speed-mode-note').textContent=state.linked?'共通カーブを編集中':'左右別の設定';
  $('curve-duration').textContent=`再生時間 約${(duration*map.total/rate).toFixed(2)}秒`;
 }
 function commit(){maps=new WeakMap();persist();draw();onChange();}
 function move(x,y){const c=active(),i=selected,epsilon=i>0&&i<6?Math.min(.001,(c.points[i+1].x-c.points[i-1].x)/3):.001;c.points[i]={x:i===0?0:i===6?1:clamp(x,c.points[i-1].x+epsilon,c.points[i+1].x-epsilon),y:clamp(y,.1,3)};commit();}
 svg.addEventListener('pointerdown',e=>{const p=e.target.dataset.point;if(p===undefined)return;selected=+p;drag=e.pointerId;svg.setPointerCapture(drag);draw();e.preventDefault();});
 svg.addEventListener('pointermove',e=>{if(drag!==e.pointerId)return;const pt=new DOMPoint(e.clientX,e.clientY).matrixTransform(svg.getScreenCTM().inverse());move((pt.x-40)/380,(198-pt.y)*3/174);});
 const stop=()=>{drag=null;};for(const event of ['pointerup','pointercancel','lostpointercapture'])svg.addEventListener(event,stop);
 $('curve-point').onchange=e=>{selected=+e.target.value;draw();};
 for(const id of ['curve-x','curve-y'])$(id).oninput=()=>{const x=$('curve-x').valueAsNumber,y=$('curve-y').valueAsNumber;if(Number.isFinite(x)&&Number.isFinite(y))move(x/100,y);};
 $('curve-enabled').onchange=e=>{active().enabled=e.target.checked;commit();};$('curve-reset').onclick=()=>{active().points=defaultPoints();active().enabled=true;commit();};
 $('speed-link').onchange=e=>{state.linked=e.target.checked;commit();};
 $('speed-side').onchange=e=>{state.selected=e.target.value==='L'?'L':'R';commit();};
 for(const [id,side] of [['speed-right','R'],['speed-left','L'],['speed-common','common']]){
  $(id).oninput=()=>{const raw=$(id).value,rate=$(id).valueAsNumber;if(Number.isFinite(rate)&&rate>=.25&&rate<=3){state[side].rate=rate;commit();$(id).value=raw;}};
  $(id).onchange=()=>{const rate=$(id).valueAsNumber;if(Number.isFinite(rate)){state[side].rate=clamp(rate,.25,3);commit();}else draw();};
 }

 draw();
 return {
  snapshot(side='R'){return copy(effective(side));},selectedSide(){return state.selected;},isLinked(){return state.linked;},
  setClip(id,seconds){clip=String(id);state=stateFor(clip);durations=typeof seconds==='object'?{R:Number(seconds.R)||1,L:Number(seconds.L)||1}:{R:Number(seconds)||1,L:Number(seconds)||1};cursors={R:0,L:0};draw();},
  setRate(rate,side){if(!Number.isFinite(rate))return;const target=side===undefined?active():side==='common'?state.common:effective(side);target.rate=clamp(rate,.25,3);commit();},
  advance(frame,dt,count,side=state.selected){const c=effective(side),m=mapFor(c),t=m.time(frame/count)+dt*c.rate/(count/30);return t>=m.total?count+m.position((t-m.total)%m.total)*count:m.position(t)*count;},
  cursor(frame,count,side=state.selected){side=side==='L'?'L':'R';cursors[side]=clamp(count>0?frame/count:0,0,1);if(side!==state.selected)return;const el=$('curve-cursor'),x=X(cursors[side]);if(el){el.setAttribute('x1',x);el.setAttribute('x2',x);}}
 };
}
