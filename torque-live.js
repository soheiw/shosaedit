import {torqueAt} from './motor-loads.js?v=stall-percent-1';
const colors=['#8cc8ff','#f4b76c','#bba1ff','#83d9aa','#ff94ae','#e2d174','#8be2e3','#fff06a','#ff65d5'];
export function torqueChannelStatus(side,j){
 if(!['R','L'].includes(side)||!Number.isInteger(j)||j<0||j>=(side==='R'?9:8))return 'unavailable';
 return j<7?'estimated':'not-estimated';
}
const channels=(side,joint)=>joint<0?Array.from({length:side==='R'?9:8},(_,j)=>j):[joint];
const computed=(side,joint)=>channels(side,joint).filter(j=>torqueChannelStatus(side,j)==='estimated');
// Retain both extrema in each bucket, so short spikes survive display reduction.
export function torquePlotSamples(times,rows,j,maxBuckets=450){
 if(j<0||j>=7||!times.length)return [];
 const indices=new Set([0,times.length-1]),size=Math.max(1,Math.ceil(times.length/maxBuckets));
 for(let start=0;start<times.length;start+=size){let lo=start,hi=start;for(let k=start+1;k<Math.min(start+size,times.length);k++){if(Math.abs(rows[k][j])<Math.abs(rows[lo][j]))lo=k;if(Math.abs(rows[k][j])>Math.abs(rows[hi][j]))hi=k;}indices.add(lo);indices.add(hi);}
 return [...indices].sort((a,b)=>a-b).filter(i=>i>=0).map(i=>[times[i],Math.abs(rows[i][j])]);
}
export function createLiveTorquePlot(host,{onSeek=()=>{}}={}){
 let results=null,assessment=null,time=0,joint=-1,original=false,duration=1,axes={},lastReadout='';
 const en=()=>document.documentElement.lang==='en',t=(ja,english)=>en()?english:ja;
 host.dataset.noTranslate='';host.className='live-torque';
 host.innerHTML=`<div class="live-torque-heading"><b data-torque-title></b><label><select data-torque-joint aria-label="Torque joint"></select></label><label><input data-torque-original type="checkbox"><span data-torque-original-label></span></label><span data-torque-status role="status"></span></div><div class="live-torque-panes">${['R','L'].map(side=>`<div class="live-torque-pane"><svg data-torque-graph="${side}" viewBox="0 0 500 112" role="img"></svg><div data-torque-legend="${side}" class="live-torque-legend"></div></div>`).join('')}</div>`;
 const $=selector=>host.querySelector(selector);
 function labels(){
  $('[data-torque-title]').textContent=t('推定トルク |N·m|','Estimated torque |N·m|');
  const select=$('[data-torque-joint]');select.innerHTML=`<option value="-1">${t('全モーター','All motors')}</option>${Array.from({length:7},(_,j)=>`<option value="${j}">${t('第','Joint ')}${j+1}${en()?'':'関節'}</option>`).join('')}<option value="7">R8 / L8 · ${t('指・未推定','Fingers · not estimated')}</option><option value="8">R9 · ${t('指・未推定','Finger · not estimated')}</option>`;select.value=joint;
  select.setAttribute('aria-label',t('グラフの関節','Graph joint'));
  $('[data-torque-original-label]').textContent=t('元も表示（点線）','Original (dotted)');
  for(const side of ['R','L'])$(`[data-torque-graph="${side}"]`).setAttribute('aria-label',t(`${side==='R'?'右':'左'}腕の推定トルク。横軸は秒、縦軸はN·m。クリックで再生位置を変更。`,`${side==='R'?'Right':'Left'} arm estimated torque. Seconds horizontally, N·m vertically. Click to seek.`));
 }
 function rebuild(){
  axes={};lastReadout='';const ready=results&&['R','L'].every(s=>results[s]?.edited?.times?.length);
  $('[data-torque-status]').textContent=joint>=7?t('指：腱の張力・摩擦が未校正のため未推定','Finger torque not estimated: tendon tension/friction uncalibrated'):ready?t('R8・R9・L8：未推定（腱の張力・摩擦が未校正）','R8 / R9 / L8: not estimated (tendon tension/friction uncalibrated)'):t('再計算中…','Recalculating…');
  duration=ready?Math.max(...['R','L'].flatMap(s=>[results[s].edited.duration,results[s].original?.duration??0]),.001):1;
  for(const side of ['R','L']){
   const svg=$(`[data-torque-graph="${side}"]`),legend=$(`[data-torque-legend="${side}"]`);
   if(!ready){svg.innerHTML='';legend.innerHTML='';continue;}
   const joints=computed(side,joint),legendJoints=channels(side,joint),pair=results[side],series=[pair.edited,...original&&pair.original?[pair.original]:[]];
   legend.innerHTML=legendJoints.map(j=>{
    const status=torqueChannelStatus(side,j),unknown=status!=='estimated';
    const explanation=status==='unavailable'?t('左手にL9はありません','There is no L9 motor'):t('腱の張力・摩擦が未校正のため、指トルクは未推定です','Finger torque is not estimated: tendon tension and friction are uncalibrated');
    return `<button type="button" data-live-joint="${j}" aria-label="${side}${j+1}" ${status==='unavailable'?'disabled':''} ${unknown?`title="${explanation}"`:''} style="--torque-color:${colors[j]}"><span>${side}${j+1}</span><b data-live-value="${side}${j}" ${unknown?'style="font-size:8px;white-space:normal;overflow-wrap:anywhere"':''}>${status==='unavailable'?t('なし','N/A'):unknown?t('未推定','Not estimated'):'—'}</b></button>`;
   }).join('');
   if(!joints.length){
    const missing=torqueChannelStatus(side,joint)==='unavailable';
    svg.innerHTML=`<text x="3" y="12">${side} · N·m</text><text x="250" y="45" text-anchor="middle">${missing?t('L9はありません','There is no L9 motor'):`${side}${joint+1} · ${t('未推定','Not estimated')}`}</text><text x="250" y="65" text-anchor="middle">${missing?t('左手のモーターはL1〜L8です','Left motors are L1–L8'):t('腱の張力・摩擦が未校正です','Tendon tension and friction are uncalibrated')}</text>`;
    continue;
   }
   const motor=assessment?.motors.find(m=>m.side===side&&m.j===joint),limit=motor?.limit,warning=limit?limit*(assessment.warningPercent/100):null;
   const maximum=Math.max(.01,...series.flatMap(a=>joints.map(j=>a.stats[j].peak)),limit??0)*1.12,X=seconds=>38+seconds/duration*450,Y=value=>88-value/maximum*68;
   axes[side]={X,Y};let markup=`<text x="3" y="12">${side} · N·m</text>`;
   for(let k=0;k<3;k++){const value=maximum*k/2,y=Y(value);markup+=`<line x1="38" x2="488" y1="${y}" y2="${y}" stroke="#34404d"/><text x="1" y="${y+3}">${value.toFixed(2)}</text>`;}
   for(let k=0;k<5;k++)markup+=`<text x="${X(duration*k/4)}" y="105" text-anchor="middle">${(duration*k/4).toFixed(1)}s</text>`;
   series.forEach((a,index)=>joints.forEach(j=>{const points=torquePlotSamples(a.times,a.total,j).map(([seconds,value])=>`${X(seconds)},${Y(value)}`).join(' ');markup+=`<polyline points="${points}" fill="none" stroke="${colors[j]}" stroke-width="${index?1:1.7}" ${index?'stroke-dasharray="3 3" opacity=".5"':''}/>`;}));
   if(limit)for(const [value,color,label] of [[limit,'#ff9292',t('許容','Limit')],[warning,'#ffcf7d',`${t('警告','Warn')} ${assessment.warningPercent}%`]])markup+=`<line x1="38" x2="488" y1="${Y(value)}" y2="${Y(value)}" stroke="${color}" stroke-dasharray="5 3"/><text x="486" y="${Y(value)-3}" text-anchor="end" fill="${color}">${label} ${value.toFixed(2)}</text>`;
   markup+='<line data-live-cursor y1="19" y2="88" stroke="#fff" opacity=".85"/>';
   markup+=joints.map(j=>`<circle data-live-dot="${j}" r="2.8" fill="${colors[j]}"/>`).join('');svg.innerHTML=markup;
  }
  updateTime(time,true);
 }
 function updateTime(seconds,force=false){
  time=seconds;if(!results)return;const key=Math.floor(seconds*30);if(!force&&lastReadout===key)return;lastReadout=key;
  for(const side of ['R','L']){
   if(!axes[side])continue;const a=results[side].edited,{X,Y}=axes[side],svg=$(`[data-torque-graph="${side}"]`),x=X(Math.max(0,Math.min(duration,seconds))),cursor=svg.querySelector('[data-live-cursor]');cursor.setAttribute('x1',x);cursor.setAttribute('x2',x);
   for(const j of computed(side,joint)){
    const value=Math.abs(torqueAt(a,j,seconds)),el=$(`[data-live-value="${side}${j}"]`),motor=assessment?.motors.find(m=>m.side===side&&m.j===j),ratio=motor?.limit?value/motor.limit:null;
    el.textContent=value.toFixed(2);el.parentElement.dataset.state=ratio>1?'over':ratio!==null&&ratio>assessment.warningPercent/100?'warning':'within';
    const dot=svg.querySelector(`[data-live-dot="${j}"]`);dot.setAttribute('cx',x);dot.setAttribute('cy',Y(value));
   }
  }
 }
 $('[data-torque-joint]').onchange=e=>{joint=+e.target.value;rebuild();};$('[data-torque-original]').onchange=e=>{original=e.target.checked;rebuild();};
 host.addEventListener('click',e=>{const button=e.target.closest('[data-live-joint]');if(button){joint=+button.dataset.liveJoint;$('[data-torque-joint]').value=joint;rebuild();}});
 for(const side of ['R','L'])$(`[data-torque-graph="${side}"]`).addEventListener('click',e=>{if(!results)return;const rect=e.currentTarget.getBoundingClientRect(),seconds=(((e.clientX-rect.left)/rect.width)*500-38)/450*duration;onSeek(Math.max(0,Math.min(duration,seconds)));});
 document.getElementById('language').addEventListener('change',()=>{labels();rebuild();});labels();rebuild();
 return {setResults(next,report){results=next;assessment=report;rebuild();},updateTime};
}
