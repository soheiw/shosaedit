const SIDES=['R','L'],key='shosaedit-motor-torque-limits-v1',warningKey='shosaedit-motor-warning-percent-v1';
export function validWarningPercent(value){return Number.isFinite(value)&&value>0&&value<=100;}
const finite=n=>Number.isFinite(n),fmt=n=>finite(n)?n.toFixed(2):'—';
export function torqueAt(a,j,time){let lo=0,hi=a.times.length-1;const t=Math.max(0,Math.min(time,a.times[hi]));while(hi-lo>1){const m=(hi+lo)>>1;if(a.times[m]<t)lo=m;else hi=m;}const p=(t-a.times[lo])/(a.times[hi]-a.times[lo]||1);return a.total[lo][j]*(1-p)+a.total[hi][j]*p;}
// Piecewise-linear |torque| crossings, including a change of sign in an interval.
export function thresholdExposure(times,values,limit){let seconds=0,first=null;for(let i=1;i<times.length;i++){const a=values[i-1],b=values[i],cuts=[0,1];if(a!==b)for(const level of [-limit,limit]){const p=(level-a)/(b-a);if(p>0&&p<1)cuts.push(p);}cuts.sort((a,b)=>a-b);for(let k=1;k<cuts.length;k++){const left=cuts[k-1],right=cuts[k];if(Math.abs(a+(b-a)*(left+right)/2)>limit){const t=times[i-1]+left*(times[i]-times[i-1]);first??=t;seconds+=(right-left)*(times[i]-times[i-1]);}}}return {seconds,first};}
export function assessMotorLoads(results,limits={},time=0,warningPercent=80){
 if(!validWarningPercent(warningPercent))throw new RangeError('Warning percentage must be greater than 0 and at most 100');
 const motors=[];for(const side of SIDES)for(let j=0;j<7;j++){
  const id=side+(j+1),a=results?.[side]?.edited,original=results?.[side]?.original,limit=finite(limits[id])&&limits[id]>0?limits[id]:null;
  if(!a?.times?.length||!a.total.every(r=>finite(r[j]))){motors.push({id,side,j,limit,available:false});continue;}
  const values=a.total.map(r=>r[j]);let peak=0,peakIndex=0;values.forEach((v,i)=>{if(Math.abs(v)>peak){peak=Math.abs(v);peakIndex=i;}});
  const current=Math.abs(torqueAt(a,j,time)),exposure=limit?thresholdExposure(a.times,values,limit):null;
  motors.push({id,side,j,limit,available:true,current,peak,peakTime:a.times[peakIndex],originalPeak:original?Math.max(...original.total.map(r=>Math.abs(r[j]))):null,rms:a.stats[j].rms,ratio:limit?peak/limit:null,currentRatio:limit?current/limit:null,exposure,over:limit!==null&&peak>limit,currentOver:limit!==null&&current>limit,warning:limit!==null&&peak<=limit&&peak/limit>warningPercent/100,currentWarning:limit!==null&&current<=limit&&current/limit>warningPercent/100});
 }
 const missing=motors.filter(m=>!m.available||m.limit===null),over=motors.filter(m=>m.over),currentOver=motors.filter(m=>m.currentOver),ranked=motors.filter(m=>m.ratio!==null&&m.ratio!==undefined).sort((a,b)=>b.ratio-a.ratio);
 const warnings=motors.filter(m=>m.warning),currentWarnings=motors.filter(m=>m.currentWarning);
 return {motors,missing,over,currentOver,warnings,currentWarnings,warningPercent,worst:ranked[0]??null,status:over.length?'over':warnings.length?'warning':missing.length?'incomplete':'within'};
}
export function createMotorLoadPanel(host,{onSelect,onSeek,motorMapping,onLimitsChange=()=>{}}){
 let limits={};try{const saved=JSON.parse(localStorage.getItem(key));for(const side of SIDES)for(let j=1;j<=7;j++){const id=side+j;if(finite(saved?.[id])&&saved[id]>0)limits[id]=saved[id];}}catch{}
 let warningPercent=80;try{const saved=JSON.parse(localStorage.getItem(warningKey));if(validWarningPercent(saved))warningPercent=saved;}catch{}
 const invalid=new Set();
 let results=null,time=0,report;
 host.innerHTML=`<h3>モーター別の上限比較</h3><p class="load-help">R1〜R7／L1〜L7は肩からの関節番号です。実機IDとは未照合。指駆動は計算対象外です。</p><label class="motor-warning-setting">WARNING表示のしきい値（許容値の%） <input aria-label="WARNING表示のしきい値（%）" data-motor-warning type="number" min="0" max="100" step="any" value="${warningPercent}"></label><p data-motor="settings-error" class="motor-verdict" role="alert" hidden></p><p data-motor="verdict" class="motor-verdict" role="status"></p><p data-motor="now" class="load-help" aria-live="off"></p><button type="button" data-motor="worst">最大比の時刻へ</button><details open><summary>左右14軸の一覧・許容値</summary><p class="load-help">各軸の重力＋動作トルクの絶対値。現在値は修正後、最大値は元 → 修正です。各許容値は運用条件に合わせてN·mで入力してください。ストールトルクを連続許容値として自動設定しません。</p><table class="motor-limit-table"><thead><tr><th>モーター</th><th>現在／最大 N·m</th><th>許容 N·m／最大比</th></tr></thead><tbody>${SIDES.flatMap(side=>Array.from({length:7},(_,j)=>{const id=side+(j+1),model=motorMapping?.confirmed?.[String(j+1)]??'型番未確定';return `<tr data-motor-row="${id}"><th><button type="button" data-motor-select="${id}" title="${model}">${id}</button><small data-motor-state="${id}"></small></th><td><b data-motor-current="${id}">—</b><small data-motor-peak="${id}">—</small><small data-motor-extra="${id}"></small></td><td><input aria-label="${id} 許容トルク N·m" type="number" min="0" step="any" placeholder="未設定" data-motor-limit="${id}" value="${limits[id]??''}"><small data-motor-ratio="${id}">—</small></td></tr>`;})).join('')}</tbody></table></details><p class="load-help">許容値は両腕それぞれに保存し、すべてのMotionで共通です。1軸でも超過すれば全体を「超過あり」と表示します。これは推定トルクの比較で、実機の電流・温度・停止判定を再現したものではありません。</p>`;
 const $=name=>host.querySelector(`[data-motor="${name}"]`);
 const text=(element,value)=>{if(element.textContent!==value)element.textContent=value;};
 function update(recalculate=true){
  if(recalculate)report=assessMotorLoads(results,limits,time,warningPercent);
  else{for(const m of report.motors)if(m.available){m.current=Math.abs(torqueAt(results[m.side].edited,m.j,time));m.currentRatio=m.limit?m.current/m.limit:null;m.currentOver=m.limit!==null&&m.current>m.limit;m.currentWarning=m.limit!==null&&m.current<=m.limit&&m.current/m.limit>warningPercent/100;}report.currentOver=report.motors.filter(m=>m.currentOver);report.currentWarnings=report.motors.filter(m=>m.currentWarning);}
  const ready=report.motors.every(m=>m.available);
  if(recalculate){
   $('verdict').dataset.state=invalid.size?'invalid':ready?report.status:'pending';
   $('settings-error').hidden=!invalid.size;text($('settings-error'),invalid.size?'設定エラー：許容トルクは0より大きい値、WARNINGは0より大きく100以下で入力してください。':'');
   let verdict=!ready?'再計算待ち':report.over.length?`ERROR · 超過あり：${report.over.map(m=>m.id).join('、')}（14軸中${report.over.length}軸）`:report.warnings.length?`WARNING · ${report.warnings.map(m=>m.id).join('、')}（許容値の${warningPercent}%超）`:report.missing.length?`未判定：許容値未設定 ${report.missing.length} / 14軸`:'対象14軸は設定値内（推定）';
   if(ready&&report.worst){const w=report.worst;verdict+=` · 最大比 ${w.id} ${(w.ratio*100).toFixed(1)}% · ${w.peakTime.toFixed(2)}秒`;}
   if(ready&&(report.over.length||report.warnings.length)&&report.missing.length)verdict+=` · 未設定 ${report.missing.length}軸`;
   text($('verdict'),verdict);$('worst').disabled=!ready||!report.worst;
  }
  const configured=report.motors.filter(m=>m.available&&m.limit!==null).length;
  text($('now'),!ready?'—':!configured?'現在値を表示中（許容値未設定）':report.currentOver.length?`現在の超過：${report.currentOver.map(m=>m.id).join('、')}`:report.currentWarnings.length?`現在のWARNING：${report.currentWarnings.map(m=>m.id).join('、')}`:'現在の超過なし（設定済みの軸のみ）');
  for(const m of report.motors){
   text(host.querySelector(`[data-motor-current="${m.id}"]`),m.available?fmt(m.current):'—');
   if(recalculate){
    host.querySelector(`[data-motor-row="${m.id}"]`).dataset.state=!m.available?'pending':m.over?'over':m.warning?'warning':m.limit?'within':'incomplete';
    text(host.querySelector(`[data-motor-peak="${m.id}"]`),m.available?`${fmt(m.originalPeak)} → ${fmt(m.peak)}`:'—');
    text(host.querySelector(`[data-motor-extra="${m.id}"]`),m.available?`実効 ${fmt(m.rms)}`:'');
    text(host.querySelector(`[data-motor-state="${m.id}"]`),!m.available?'—':m.over?'ERROR':m.warning?'WARNING':m.limit?'設定値内':'未設定');
    text(host.querySelector(`[data-motor-ratio="${m.id}"]`),m.available&&m.limit?`${(m.ratio*100).toFixed(1)}% · 超過${m.exposure.seconds.toFixed(2)}秒`:'—');
   }
  }
 }
 host.addEventListener('input',e=>{
  const input=e.target,id=input.dataset.motorLimit,isWarning=Object.hasOwn(input.dataset,'motorWarning');if(!id&&!isWarning)return;
  const raw=input.value,v=input.valueAsNumber,field=isWarning?'warning':id;
  // An empty torque limit is deliberately unset; malformed/invalid entries retain the last valid value.
  const valid=isWarning?validWarningPercent(v):(raw===''&&!input.validity?.badInput)||finite(v)&&v>0;
  if(!valid){invalid.add(field);input.setCustomValidity(isWarning?'WARNINGは0より大きく100以下で入力してください':'0より大きい許容トルクを入力してください');}
  else{invalid.delete(field);input.setCustomValidity('');if(isWarning)warningPercent=v;else if(raw==='')delete limits[id];else limits[id]=v;try{localStorage.setItem(isWarning?warningKey:key,JSON.stringify(isWarning?warningPercent:limits));}catch{}}
  input.dataset.invalid=String(!valid);update();onLimitsChange();
 });
 host.addEventListener('click',e=>{const target=e.target.closest('[data-motor-select]');if(target){const id=target.dataset.motorSelect;onSelect(id[0],Number(id.slice(1))-1);}});
 $('worst').onclick=()=>{const w=report?.worst;if(w){onSelect(w.side,w.j);onSeek(w.peakTime);}};update();
 return {setResults(value){results=value;update();},updateTime(value){if(value===time&&report)return;time=value;update(false);},snapshot:()=>report,getLimits:()=>({...limits}),getWarningPercent:()=>warningPercent,hasInvalidSettings:()=>invalid.size>0};
}
