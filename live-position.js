const COLORS=['#8cc8ff','#f4b76c','#bba1ff','#83d9aa','#ff94ae','#e2d174','#8be2e3','#fff06a','#ff65d5'];
// Signed extrema, in chronological order: negative counts and one-frame peaks
// must survive reduction. The caller supplies the already warped/delayed times.
export function plotSamples(times,rows,j,maxBuckets=450){
 const n=Math.min(times?.length??0,rows?.length??0);if(!n)return [];
 const size=Math.max(1,Math.ceil(n/Math.max(1,Math.floor(maxBuckets)||1))),indices=new Set([0,n-1]);
 for(let start=0;start<n;start+=size){let lo=-1,hi=-1;
  for(let k=start;k<Math.min(n,start+size);k++)if(Number.isFinite(times[k])&&Number.isFinite(rows[k]?.[j])){
   if(lo<0||rows[k][j]<rows[lo][j])lo=k;if(hi<0||rows[k][j]>rows[hi][j])hi=k;
  }
  if(lo>=0){indices.add(lo);indices.add(hi);}
 }
 return [...indices].sort((a,b)=>a-b).filter(i=>Number.isFinite(times[i])&&Number.isFinite(rows[i]?.[j])).map(i=>[times[i],rows[i][j]]);
}
// Linear interpolation in playback seconds, with initial/final holds. At an
// exact repeated timestamp the latest sample wins. No angle wrapping or abs().
export function sampleAt(times,rows,j,seconds){
 const n=Math.min(times?.length??0,rows?.length??0);if(!n||!Number.isFinite(seconds))return null;
 if(seconds<times[0])return Number.isFinite(rows[0]?.[j])?rows[0][j]:null;
 let lo=0,hi=n;while(lo<hi){const mid=(lo+hi)>>1;if(times[mid]<=seconds)lo=mid+1;else hi=mid;}
 const a=Math.max(0,lo-1),b=Math.min(n-1,lo),v=rows[a]?.[j],w=rows[b]?.[j];
 if(!Number.isFinite(v)||!Number.isFinite(w))return null;
 const delta=times[b]-times[a];return delta>0?v+(w-v)*Math.max(0,Math.min(1,(seconds-times[a])/delta)):v;
}
export function createLivePositionPlot(host,{getSeries=()=>null,onSeek=()=>{}}={}){
 let results=null,selection='all',showOriginal=false,time=0,duration=1,axes={},lastTime=null;
 const en=()=>document.documentElement.lang==='en',t=(ja,english)=>en()?english:ja;
 host.dataset.noTranslate='';host.classList.add('live-torque');
 host.innerHTML=`<div class="live-torque-heading"><b data-position-title></b><label><select data-position-select></select></label><label><input type="checkbox" data-position-original><span data-position-original-label></span></label><span role="status" data-position-status></span></div><div class="live-torque-panes">${['R','L'].map(side=>`<div class="live-torque-pane"><svg data-position-graph="${side}" viewBox="0 0 500 112" role="img"></svg><div class="live-torque-legend" data-position-legend="${side}"></div></div>`).join('')}</div>`;
 const $=selector=>host.querySelector(selector),width=side=>side==='R'?9:8;
 const selected=side=>Array.from({length:width(side)},(_,j)=>j).filter(j=>selection==='all'||selection==='fingers'&&j>=7||selection===side+(j+1));
 function labels(){
  $('[data-position-title]').textContent=t('モーター位置 · counts','Motor position · counts');
  const options=[['all',t('全モーター（右9・左8）','All motors (R9 / L8)')],['fingers',t('指のみ（R8・R9・L8）','Fingers (R8 / R9 / L8)')],...['R','L'].flatMap(side=>Array.from({length:width(side)},(_,j)=>[side+(j+1),side+(j+1)]))];
  $('[data-position-select]').innerHTML=options.map(([value,label])=>`<option value="${value}">${label}</option>`).join('');$('[data-position-select]').value=selection;
  $('[data-position-select]').setAttribute('aria-label',t('表示する位置チャンネル','Position channels'));
  $('[data-position-original-label]').textContent=t('元も表示（点線）','Original (dotted)');
  for(const side of ['R','L'])$(`[data-position-graph="${side}"]`).setAttribute('aria-label',t(`${side==='R'?'右':'左'}モーター位置。横軸は秒、縦軸はcounts。クリックで再生位置を変更。`,`${side==='R'?'Right':'Left'} motor position. Seconds horizontally, counts vertically. Click to seek.`));
 }
 function rebuild(){
  axes={};lastTime=null;
  const ready=results&&['R','L'].every(side=>results[side]?.edited?.times?.length&&results[side].edited.rows?.length);
  $('[data-position-status]').textContent=ready?t('実線：修正後 · クリックで移動','Solid: edited · click to seek'):t('位置データを準備中…','Preparing position data…');
  duration=ready?Math.max(.001,Number.isFinite(results.duration)?results.duration:0,...['R','L'].flatMap(side=>[results[side].edited.times.at(-1)||0,results[side].original?.times?.at(-1)||0])):1;
  for(const side of ['R','L']){
   const svg=$(`[data-position-graph="${side}"]`),legend=$(`[data-position-legend="${side}"]`);
   if(!ready){svg.innerHTML='';legend.innerHTML='';continue;}
   const joints=selected(side),pair=results[side],series=[pair.edited,...showOriginal&&pair.original?[pair.original]:[]];
   let min=Infinity,max=-Infinity;
   for(const data of series)for(const row of data.rows)for(const j of joints)if(Number.isFinite(row[j])){min=Math.min(min,row[j]);max=Math.max(max,row[j]);}
   if(!Number.isFinite(min)){min=0;max=1;}
   const padding=Math.max(10,(max-min)*.1);min-=padding;max+=padding;
   const X=seconds=>44+seconds/duration*444,Y=value=>88-(value-min)/(max-min)*68;axes[side]={X,Y};
   let markup=`<text x="3" y="12">${side} · counts</text>`;
   for(let k=0;k<3;k++){const value=min+(max-min)*k/2,y=Y(value);markup+=`<line x1="44" x2="488" y1="${y}" y2="${y}" stroke="#34404d"/><text x="1" y="${y+3}">${Math.round(value)}</text>`;}
   for(let k=0;k<5;k++)markup+=`<text x="${X(duration*k/4)}" y="105" text-anchor="middle">${(duration*k/4).toFixed(1)}s</text>`;
   series.forEach((data,index)=>joints.forEach(j=>{
    const samples=plotSamples(data.times,data.rows,j);if(!samples.length)return;
    if(samples[0][0]>0)samples.unshift([0,samples[0][1]]);
    if(samples.at(-1)[0]<duration)samples.push([duration,samples.at(-1)[1]]);
    markup+=`<polyline data-position-path="${side}${j+1}" points="${samples.map(([s,v])=>`${X(s).toFixed(2)},${Y(v).toFixed(2)}`).join(' ')}" fill="none" stroke="${COLORS[j]}" stroke-width="${index?1:j>=7?2.3:1.4}" ${index?'stroke-dasharray="3 3" opacity=".5"':''}/>`;
   }));
   if(!joints.length)markup+=`<text x="264" y="52" text-anchor="middle">${t('この側のチャンネルは未選択','No channel selected on this side')}</text>`;
   markup+='<line data-position-cursor y1="19" y2="88" stroke="#fff" opacity=".85"/>';
   markup+=joints.map(j=>`<circle data-position-dot="${j}" r="2.8" fill="${COLORS[j]}"/>`).join('');svg.innerHTML=markup;
   // Keep every chip available during isolation so users can switch directly.
   legend.innerHTML=Array.from({length:width(side)},(_,j)=>`<button type="button" data-position-channel="${side}${j+1}" aria-label="${side}${j+1}" aria-pressed="${joints.includes(j)}" style="--torque-color:${COLORS[j]};opacity:${joints.includes(j)?1:.5}"><span>${side}${j+1}</span><b data-position-value="${side}${j}">—</b></button>`).join('');
  }
  updateTime(time,true);
 }
 function updateTime(seconds,force=false){
  if(!Number.isFinite(seconds))return;time=seconds;if(!results||!force&&lastTime===seconds)return;lastTime=seconds;
  for(const side of ['R','L']){
   if(!axes[side])continue;const {X,Y}=axes[side],svg=$(`[data-position-graph="${side}"]`),x=X(Math.max(0,Math.min(duration,seconds))),cursor=svg.querySelector('[data-position-cursor]');
   cursor?.setAttribute('x1',x);cursor?.setAttribute('x2',x);
   for(let j=0;j<width(side);j++){
    const data=results[side].edited,value=sampleAt(data.times,data.rows,j,seconds),readout=$(`[data-position-value="${side}${j}"]`),dot=svg.querySelector(`[data-position-dot="${j}"]`);
    if(readout)readout.textContent=value===null?'—':String(Math.round(value));
    if(dot&&value!==null){dot.setAttribute('cx',x);dot.setAttribute('cy',Y(value));}
   }
  }
 }
 function invalidate(){try{results=getSeries();}catch{results=null;}rebuild();}
 $('[data-position-select]').onchange=e=>{selection=e.target.value;rebuild();};
 $('[data-position-original]').onchange=e=>{showOriginal=e.target.checked;rebuild();};
 host.addEventListener('click',e=>{const button=e.target.closest('[data-position-channel]');if(!button||!host.contains(button))return;selection=selection===button.dataset.positionChannel?'all':button.dataset.positionChannel;$('[data-position-select]').value=selection;rebuild();});
 for(const side of ['R','L'])$(`[data-position-graph="${side}"]`).addEventListener('click',e=>{if(!axes[side])return;const r=e.currentTarget.getBoundingClientRect();onSeek(Math.max(0,Math.min(duration,((e.clientX-r.left)/r.width*500-44)/444*duration)));});
 document.getElementById('language')?.addEventListener('change',()=>{labels();rebuild();});labels();invalidate();
 return {invalidate,updateTime};
}
