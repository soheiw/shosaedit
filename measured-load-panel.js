import {evaluateSample,getDefaultSettings,MODEL_CURRENT_SPECS} from './measured-load.js';

const STORAGE='shosaedit-measured-load-settings-v1';
const keys=()=>['R','L'].flatMap(side=>Array.from({length:side==='R'?9:8},(_,i)=>side+(i+1+(side==='L'?10:0))));
const finite=v=>typeof v==='number'&&Number.isFinite(v);
const value=(v,digits=2)=>finite(v)?v.toFixed(digits):'—';
const labels={fresh:'受信中',ok:'受信中',live:'受信中',stale:'更新停止',unavailable:'未取得',disconnected:'未接続',missing:'未取得',invalid:'無効な値'};
// One row per quantity, one column per motor (R1-R9, L11-L18): fits under the 3D view.
const FIELDS=[['torque','実測 N·m'],['pose','姿勢推定 N·m'],['current','電流 A'],['state','状態'],['load','負荷 %'],['peak','ピーク N·m'],['over','超過 秒'],['temperature','温度 ℃'],['voltage','電圧 V']];
const escape=s=>String(s??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
export function createMeasuredLoadPanel(host,{fetchJSON=async(url,options)=>{const r=await fetch(url,{cache:'no-store',signal:AbortSignal.timeout(2500),...options});if(!r.ok)throw Error(`HTTP ${r.status}`);return r.json();},getMotionName=()=>'',getPoseTorque=()=>null,pollMs=500}={}){
 if(!host)return null;
 let settings=getDefaultSettings();try{const saved=JSON.parse(localStorage.getItem(STORAGE)||'{}');for(const key of keys())if(saved[key])settings[key]={...settings[key],...saved[key]};}catch{}
 let sample=null,recording=false,history=[],stats={},timer,disposed=false,lastTimestamp=null;
 host.classList.add('measured-load');host.dataset.noTranslate='';
 host.innerHTML=`<h2>実機の電流・推定負荷</h2><p class="measured-note">実測電流からの推定値です。姿勢からの計算とは別に表示します。未取得・古いデータは負荷ゼロとして扱いません。ピークは受信できたサンプル内の値です（約0.5秒間隔の取得では短いピークを取り逃す場合があります）。</p><p data-measured-status role="status">未接続 · 実測値なし</p><div class="measured-actions"><button type="button" data-record>記録開始</button><button type="button" data-export disabled>記録をJSON保存</button><button type="button" data-clear>記録・ピークをクリア</button><span data-record-status></span></div><div class="measured-scroll"><table class="measured-grid"><thead><tr><th>ID</th>${keys().map(key=>`<th data-channel="${key}">${key[0]}${key.slice(1)}</th>`).join('')}</tr></thead><tbody>${FIELDS.map(([field,label])=>`<tr><th>${label}</th>${keys().map(key=>`<td data-channel="${key}" data-field="${field}">—</td>`).join('')}</tr>`).join('')}</tbody></table></div><details><summary>換算係数・許容値を設定</summary><p class="measured-note">既知型番の初期係数は公称停止トルク÷停止電流による概算で、実機校正値ではありません。型番とIDの初期対応は保存済み関節表からの仮定で、実機照合が必要です。未知の型番は未設定です。許容トルクは自動設定しません。最大停止トルクを連続使用の許容値にしないでください。設定変更時は過去の記録を保存してから新しい記録を開始します。</p><div class="measured-scroll"><table><thead><tr><th>モーター</th><th>型番（記録）</th><th>換算 N·m/A</th><th>許容 N·m</th></tr></thead><tbody>${keys().map(key=>`<tr><th>${key[0]} · ID ${key.slice(1)}</th><td><input data-setting="model" data-key="${key}" value="${escape(settings[key]?.model)}" aria-label="${key} 型番"></td>${['torquePerAmpNm','allowableTorqueNm'].map(field=>`<td><input type="number" min="0" step="any" data-setting="${field}" data-key="${key}" value="${finite(settings[key]?.[field])?settings[key][field]:''}" placeholder="未設定" aria-label="${key} ${field==='torquePerAmpNm'?'換算係数':'許容トルク'}"></td>`).join('')}</tr>`).join('')}</tbody></table></div><button type="button" data-save-settings>設定を保存</button><span data-settings-status role="status"></span></details><details><summary>実測データの取得元</summary><p class="measured-note">TDなどが出力する電流モニターJSONを読み取ります。モーターへの指令や再生操作は行いません。</p><label>共有・ローカルJSONのパス <input type="text" data-source-path placeholder="例：/Volumes/共有/telemetry.json"></label><button type="button" data-save-source>取得元を設定</button><p data-source-status role="status"></p></details>`;
 const $=s=>host.querySelector(s);
 function recordLabel(){$('[data-record]').textContent=recording?'記録停止':'記録開始';$('[data-export]').disabled=!history.length;$('[data-record-status]').textContent=`${recording?'記録中 · ':''}${history.length} サンプル`;}
 function render(){
  const report=evaluateSample(sample,settings,Date.now());
  const current=report.channels.filter(c=>finite(c.currentA));
  $('[data-measured-status]').textContent=`${labels[report.status]||report.status||'未接続'} · ${current.length} / 17 軸${sample?.error?' · '+sample.error:''}`;
  if(!current.length)$('[data-measured-status]').textContent+=' · 実測値なし';
  const pose=getPoseTorque()||{};
  for(const key of keys()){
   const c=report.channels.find(c=>`${c.side}${c.id}`===key),cells=host.querySelectorAll(`td[data-channel="${key}"]`),s=stats[key]||{};
   if(c?.status!=='fresh'){s.overSeconds=0;s.previousOver=false;s.last=null;}
   const fields={state:c?(labels[c.status]||c.status):'未取得',current:value(c?.currentA,3),torque:value(c?.torqueNm,3),pose:value(pose[key],3),load:finite(c?.loadPercent)?value(c.loadPercent,1):'—',peak:value(s.peak,3),over:c?.status==='fresh'&&finite(c?.loadPercent)?value(s.overSeconds??0,1):'—',temperature:value(c?.temperatureC,1),voltage:value(c?.voltageV,1)};
   for(const [field,text]of Object.entries(fields)){const cell=host.querySelector(`td[data-channel="${key}"][data-field="${field}"]`);if(cell.textContent!==text)cell.textContent=text;}
   const state=finite(c?.loadPercent)?c.loadPercent>100?'over':c.loadPercent>=80?'warning':'available':'unknown';
   for(const cell of cells)cell.dataset.state=state;
  }
  return report;
 }
 // An axis with no coefficient takes the model the motor reported (--hardware);
 // values the user typed are never replaced. Saved only with 設定を保存.
 function fillFromReportedModels(channels){
  for(const c of channels||[]){const key=`${c.side}${c.id}`,spec=MODEL_CURRENT_SPECS[c.model],s=settings[key];
   if(!spec||!s||finite(s.torquePerAmpNm))continue;
   settings[key]={...s,model:c.model,torquePerAmpNm:spec.torquePerAmpNm};
   const model=host.querySelector(`[data-setting="model"][data-key="${key}"]`),k=host.querySelector(`[data-setting="torquePerAmpNm"][data-key="${key}"]`);
   if(model)model.value=c.model;if(k)k.value=spec.torquePerAmpNm;}
 }
 function ingest(next){
  fillFromReportedModels(next?.channels);
  sample=next;
  const report=evaluateSample(sample,settings,Date.now());
  const stamp=report.timestampMs;
  const token=report.channels.filter(c=>c.status==='fresh').map(c=>`${c.side}${c.id}:${c.timestampMs}`).join('|');
  if(token&&token!==lastTimestamp){
   for(const c of report.channels){const key=`${c.side}${c.id}`,s=stats[key]??={peak:null,overSeconds:0,last:null,previousOver:false};
    if(finite(c.torqueNm))s.peak=Math.max(s.peak??0,Math.abs(c.torqueNm));
    const channelStamp=c.timestampMs;
    if(c.status!=='fresh'){s.overSeconds=0;s.previousOver=false;s.last=null;continue;}
    if(channelStamp===s.last)continue;
    const over=finite(c.loadPercent)&&c.loadPercent>100,dt=finite(s.last)?(channelStamp-s.last)/1000:0;
    s.overSeconds=over?(s.previousOver&&dt>0&&dt<=2?s.overSeconds+dt:0):0;s.previousOver=over;s.last=channelStamp;
   }
   if(recording&&report.channels.some(c=>finite(c.currentA))){history.push({...report,motion:getMotionName()});if(history.length>=50000){recording=false;$('[data-settings-status]').textContent='記録上限に達しました。JSON保存後、クリアして再開してください。';}}
   lastTimestamp=token;
  }
  render();recordLabel();
 }
 async function poll(){
  try{const next=await fetchJSON('/api/telemetry/status');if(disposed)return;ingest(next);if(next.sourcePath&&!$('[data-source-path]').value)$('[data-source-path]').value=next.sourcePath;}
  catch(error){if(disposed)return;sample={connected:false,error:'取得できません：'+error.message,channels:[]};render();}
  if(!disposed)timer=setTimeout(poll,pollMs);
 }
 $('[data-record]').onclick=()=>{recording=!recording;recordLabel();};
 $('[data-clear]').onclick=()=>{history=[];stats={};lastTimestamp=null;recordLabel();render();};
 $('[data-export]').onclick=()=>{const payload={format:'shosaedit-measured-load',version:1,exportedAt:new Date().toISOString(),settings,samples:history,peaks:stats,notes:'Current is measured; torque and load percentage are estimates. Allowable torque is user configured.'};const a=document.createElement('a'),url=URL.createObjectURL(new Blob([JSON.stringify(payload,null,2)],{type:'application/json'}));a.href=url;a.download=`measured-load-${new Date().toISOString().replace(/[:.]/g,'-')}.json`;a.click();setTimeout(()=>URL.revokeObjectURL(url),1000);};
 $('[data-save-settings]').onclick=()=>{if(history.length){$('[data-settings-status]').textContent='先に記録をJSON保存し、記録をクリアしてください。';return;}const next=getDefaultSettings();for(const input of host.querySelectorAll('[data-setting]')){const key=input.dataset.key,field=input.dataset.setting;const v=field==='model'?input.value.trim():input.value.trim()===''?null:Number(input.value);if(field!=='model'&&v!==null&&(!finite(v)||v<=0)){$('[data-settings-status]').textContent='換算係数・許容トルクは正の値、または空欄にしてください。';return;}next[key][field]=v;}settings=next;try{localStorage.setItem(STORAGE,JSON.stringify(settings));$('[data-settings-status]').textContent='保存しました';}catch{$('[data-settings-status]').textContent='このブラウザに保存できませんでした';}stats={};lastTimestamp=null;render();};
 $('[data-save-source]').onclick=async()=>{try{await fetchJSON('/api/telemetry/configure',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({path:$('[data-source-path]').value.trim()})});$('[data-source-status]').textContent='取得元を保存しました';}catch(e){$('[data-source-status]').textContent='設定できません：'+e.message;}};
 render();recordLabel();poll();
 return {ingest,getSettings:()=>structuredClone(settings),dispose(){disposed=true;clearTimeout(timer);}};
}
