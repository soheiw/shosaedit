import {modelFilename} from './model-filename.js';
import {validateRecording} from './motion-files.js';
import {validateCalibrationSnapshot} from './arm-calibration.js';

// Keep the interchange envelope: persistence validates the recording again.
export function validateSyncedRecording(raw){
 return {format:'augmented-arms-motion',version:1,fps:30,...validateRecording(raw)};
}

// File transfer only. Playback and motor control never call these endpoints.
export function createMotionSyncEditor(host,{getKnown,getCalibration,onReceive,onPending}){
 const key='shosaedit-sync-calibration-v1',seen=new Set(),pending=new Map();
 let status={},busy=false,defaultCalibration=null,timer;
 try{const raw=JSON.parse(localStorage.getItem(key)||'null');if(raw)defaultCalibration=validateCalibrationSnapshot(raw);}catch{}
 host.dataset.noTranslate='';
 host.innerHTML='<h2 data-title></h2><label><span data-path-label></span><input id="motion-sync-root" type="text" value="/Volumes/B2J_rehersal/Recorded_movements" spellcheck="false"></label><div class="row"><label><input id="motion-sync-enabled" type="checkbox"> <span data-enabled-label></span></label><select id="motion-sync-mode" aria-label="Sync direction"><option value="both">双方向 / Both ways</option><option value="pull">取り込みのみ / Import only</option></select><button id="motion-sync-apply" type="button"></button><button id="motion-sync-now" type="button"></button></div><p class="curve-help" data-help></p><p id="motion-sync-status" class="curve-help" role="status"></p><p class="curve-help" data-calibration></p><div class="row"><button id="motion-sync-use-calibration" type="button"></button><button id="motion-sync-clear-calibration" type="button"></button></div><div data-pending hidden><label><span data-pending-label></span><select id="motion-sync-pending" aria-label="Motion awaiting calibration"></select></label><button id="motion-sync-bind" type="button"></button></div><p id="motion-sync-transfer" class="curve-help" role="status"></p>';
 const $=s=>host.querySelector(s),en=()=>document.documentElement.lang==='en',tr=(ja,eng)=>en()?eng:ja;
 async function api(path,body){const response=await fetch('/api/sync/'+path,body===undefined?{cache:'no-store'}:{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body)});const data=await response.json();if(!response.ok)throw Error(data.error||response.statusText);return data;}
 function labels(){
  $('[data-title]').textContent=tr('Alienware 自動同期','Alienware auto sync');$('[data-path-label]').textContent=tr('共有フォルダ','Shared folder');$('[data-enabled-label]').textContent=tr('自動同期を有効にする','Enable auto sync');$('#motion-sync-apply').textContent=tr('設定を適用','Apply');$('#motion-sync-now').textContent=tr('今すぐ確認','Check now');
  $('[data-help]').textContent=tr('COM14＝左、COM15＝右。同名の左右CSVが揃ってから取り込みます。「名前を付けて保存」で左右CSVを送ります。同名の別データは別名で保存し、元ファイルは上書きしません。','COM14 = left; COM15 = right. Imports wait for both CSVs. Named saves send both CSVs. Conflicts receive a new name; existing files are preserved.');
  $('[data-calibration]').textContent=defaultCalibration?tr('新しい記録に使う校正：','Calibration for new recordings: ')+defaultCalibration.label:tr('未指定の校正は自動推定しません。校正のない記録は、このパネルの「校正待ち」にまとめます。','Calibration is not guessed. Recordings without calibration remain in this panel, outside the playback list.');
  $('#motion-sync-use-calibration').textContent=tr('現在の動きの校正を取り込みに使う','Use current motion calibration for imports');$('#motion-sync-clear-calibration').textContent=tr('自動適用を解除','Clear automatic calibration');$('[data-pending-label]').textContent=tr('校正待ちの記録','Recordings awaiting calibration');$('#motion-sync-bind').textContent=tr('現在の動きの校正をこの記録に適用','Apply current motion calibration to this recording');
 }
 function show(){labels();const s=status;$('#motion-sync-status').textContent=s.lastError?tr('同期待ち：','Waiting: ')+s.lastError:!s.enabled?tr('停止中','Stopped'):s.busy?tr('共有フォルダを確認中…','Checking shared folder…'):s.online?tr('接続済み','Connected')+` · ${s.synced??s.motions??0}`:tr('共有フォルダの接続待ち','Waiting for shared folder');
  const jobs=s.publishes||[],job=s.lastPublish||jobs.at?.(-1);if(job)$('#motion-sync-transfer').textContent=(job.name||'')+' · '+({published:tr('配置済み','Published'),unchanged:tr('同じ内容・変更なし','Identical; unchanged'),queued:tr('転送待ち','Queued'),writing:tr('転送中','Transferring'),failed:tr('転送失敗','Transfer failed')}[job.status]||job.status)+(job.error?' · '+job.error:'');
  $('[data-pending]').hidden=!pending.size;const select=$('#motion-sync-pending'),chosen=select.value;select.replaceChildren();for(const [id,m]of pending){const option=document.createElement('option');option.value=id;option.textContent=m.name;select.appendChild(option);}if(pending.has(chosen))select.value=chosen;
 }
 function matchingCalibration(m){const signature=JSON.stringify([m.R,m.L]);for(const known of getKnown())if(known.calibrationSnapshot&&JSON.stringify([known.R,known.L])===signature)return known.calibrationSnapshot;return null;}
 async function refresh(){if(busy)return;busy=true;try{status=await api('status');if(!status.enabled){show();return;}const items=await api('motions');for(const item of (Array.isArray(items)?items:items.motions||[])){
   if(seen.has(item.id))continue;
   let motion;try{motion=validateSyncedRecording(await api('motion/'+encodeURIComponent(item.id)));}catch(error){console.warn('Skipped invalid sync entry',item.name,error.message);continue;}const snapshot=motion.calibrationSnapshot||matchingCalibration(motion)||defaultCalibration;
   try{if(snapshot){motion.calibrationSnapshot=validateCalibrationSnapshot(snapshot);motion.calibrationRequired=false;await onReceive(item.id,motion);}else{pending.set(item.id,motion);await onPending(item.id,motion);}
   seen.add(item.id);
   }catch(error){console.warn('Motion sync import failed',item.name,error);status.lastError=item.name+': '+error.message;}
  }show();}catch(error){$('#motion-sync-status').textContent=tr('同期できません：','Sync unavailable: ')+error.message;}finally{busy=false;}}
 $('#motion-sync-apply').onclick=async()=>{try{status=await api('configure',{root:$('#motion-sync-root').value.trim(),enabled:$('#motion-sync-enabled').checked,mode:$('#motion-sync-mode').value});await refresh();show();}catch(e){$('#motion-sync-status').textContent=e.message;}};
 $('#motion-sync-now').onclick=async()=>{try{await api('scan',{});await refresh();}catch(e){$('#motion-sync-status').textContent=e.message;}};
 $('#motion-sync-use-calibration').onclick=()=>{try{defaultCalibration=validateCalibrationSnapshot(getCalibration());localStorage.setItem(key,JSON.stringify(defaultCalibration));show();}catch(e){$('#motion-sync-status').textContent=e.message;}};
 $('#motion-sync-clear-calibration').onclick=()=>{defaultCalibration=null;localStorage.removeItem(key);show();};
 $('#motion-sync-bind').onclick=async()=>{const id=$('#motion-sync-pending').value,m=pending.get(id);if(!m)return;try{m.calibrationSnapshot=validateCalibrationSnapshot(getCalibration());m.calibrationRequired=false;await onReceive(id,m);pending.delete(id);show();}catch(e){$('#motion-sync-status').textContent=e.message;}};
 async function publish(recording){if(!status.enabled||status.mode!=='both')return null;try{const result=await api('publish',{...recording,name:modelFilename(recording.name,recording.calibrationSnapshot)});$('#motion-sync-transfer').textContent=tr('送信待ち：','Queued: ')+recording.name;return result;}catch(e){$('#motion-sync-transfer').textContent=tr('保存済み・転送失敗：','Saved locally; transfer failed: ')+e.message;return null;}}
 function requestCalibration(id){const serverId=id.replace(/^synced-/,'');if(pending.has(serverId))$('#motion-sync-pending').value=serverId;$('#motion-sync-status').textContent=tr('この記録の校正を指定してください。先に校正済みの動きを選び、「現在の動きの校正をこの記録に適用」を押します。','Choose a calibrated motion first, then apply its calibration to this recording.');host.closest('details')?.setAttribute('open','');host.scrollIntoView({block:'nearest'});}
 const ready=(async()=>{try{status=await api('status');$('#motion-sync-root').value=status.root||$('#motion-sync-root').value;$('#motion-sync-enabled').checked=!!status.enabled;$('#motion-sync-mode').value=status.mode||'both';show();await refresh();}catch(e){$('#motion-sync-status').textContent=tr('同期には起動用サーバーの再起動が必要です。','Restart the launcher to enable sync.');}timer=setInterval(refresh,5000);})();
 document.getElementById('language').addEventListener('change',show);labels();
 return {ready,publish,requestCalibration,refresh,close(){clearInterval(timer);}};
}
