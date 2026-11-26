import {parseArmModels,armModelsSnapshot,validateCalibrationSnapshot,sha256} from './arm-calibration.js';
export function createCalibrationEditor(host,{getCurrent,getConfiguration,onApply,onTarget,getTarget}){
 const libraryKey='shosaedit-arm-models-v1',bindingKey='shosaedit-motion-calibrations-v1';let library=null,sourceHash='',bindings={};const targetKey='shosaedit-target-arm-v1';
 const en=()=>document.documentElement.lang==='en',tr=(a,b)=>en()?b:a;
 host.dataset.noTranslate='';host.innerHTML='<h2 data-title></h2><label class="file-label"><span data-open></span><input id="arm-models-file" type="file" accept=".json"></label><p class="curve-help" data-source></p><div class="row"><label>R <select id="arm-model-right" aria-label="Right arm calibration model"></select></label><label>L <select id="arm-model-left" aria-label="Left arm calibration model"></select></label></div><p data-convention-label></p><p class="curve-help" data-help></p><button id="apply-arm-calibration" type="button"></button><button id="clear-target-arm" type="button">記録時のアームに戻す / Use source arm</button><p class="curve-help">指の開閉対応が未確認のアームへの切替は停止します。 / Switching is blocked when finger calibration differs and correspondence is unknown.</p><p id="arm-calibration-status" class="curve-help" role="status"></p>';
 const $=s=>host.querySelector(s),right=$('#arm-model-right'),left=$('#arm-model-left'),status=$('#arm-calibration-status');
 function labels(){
  $('[data-title]').textContent=tr('アーム校正ファイル','Arm calibration file');$('[data-open]').textContent=tr('arm_models.jsonを開く','Open arm_models.json');
  $('[data-convention-label]').textContent=tr('基準姿勢：腕を下ろし、両手のひらを内側へ','Reference pose: arms down, palms inward');
  $('[data-help]').textContent=tr('右の手のひらは左向き、左は右向き。保存されたrestをこの姿勢として読み込みます。校正JSONと元CSVは変更しません。','Right palm faces left; left palm faces right. Saved rest values represent this pose. Calibration JSON and original CSVs stay unchanged.');
  $('#apply-arm-calibration').textContent=tr('使用するアームを切り替え（全ジェスチャー）','Switch target arm (all gestures)');
  $('[data-source]').textContent=library?`${sourceHash.slice(0,12)} · ${library.models.join(' / ')}`:tr('未読込。左右CSVには校正JSONをセットにしてください。','No file loaded. Pair CSVs with calibration JSON.');
 }
 function options(){for(const [el,key]of [[right,'right'],[left,'left']]){
  el.replaceChildren();for(const name of library?.models||[]){const o=document.createElement('option');o.value=name;const c=library.calibrations[key][name];o.textContent=name+(c?` · ${c.time}`:tr(' · 未校正',' · not calibrated'));el.appendChild(o);}if(library)el.value=library.selected[key];
 }$('#apply-arm-calibration').disabled=!library;labels();}
 function selectionSnapshot(){if(!library)return undefined;return armModelsSnapshot(library,{R:right.value,L:left.value},getConfiguration(),{sourceHash});}
 async function fingerprint(c){return sha256(JSON.stringify([c.R,c.L]));}
 async function bind(snapshot){
  const {id,clip}=getCurrent(),s=validateCalibrationSnapshot(snapshot);
  bindings[id]={hash:await fingerprint(clip),snapshot:s};
  localStorage.setItem(bindingKey,JSON.stringify(bindings));
  clip.calibrationSnapshot=structuredClone(s);onApply();refresh();
 }
 async function restore(clips){
  for(const [id,b]of Object.entries(bindings))try{if(clips[id]&&await fingerprint(clips[id])===b.hash)clips[id].calibrationSnapshot=validateCalibrationSnapshot(b.snapshot);}catch{}
 }
 function refresh(){labels();const s=getTarget?.();status.textContent=s?tr(`使用するアーム：${s.label}。記録元を保持し、相対関節角から変換します。`,`Target arm: ${s.label}. Converted from immutable source joint angles.`):tr('記録時のアームを使用。別アームへの切替は、校正と指の対応が必要です。','Using the recorded arm. Switching requires calibration and finger correspondence.');}
 function fingerMappings(){return {};}
 $('#arm-models-file').onchange=async e=>{try{const f=e.target.files[0];if(!f)return;if(f.size>1024*1024)throw Error('Calibration file exceeds 1MB');const raw=await f.text(),parsed=parseArmModels(JSON.parse(raw)),hash=await sha256(raw);localStorage.setItem(libraryKey,JSON.stringify({library:parsed,sourceHash:hash}));library=parsed;sourceHash=hash;options();status.textContent=tr('読込済み。左右モデルを選び、現在の動きに適用してください。','Loaded. Select the two arm models and apply to the current motion.');}catch(error){status.textContent='ERROR: '+error.message;}finally{e.target.value='';}};
 $('#apply-arm-calibration').onclick=async()=>{try{const snapshot=selectionSnapshot(),fingers=fingerMappings();const sourceKey=await onTarget(snapshot,fingers);localStorage.setItem(targetKey,JSON.stringify({snapshot,fingers,sourceKey}));refresh();}catch(error){status.textContent='ERROR: '+error.message;}};
 try{const saved=JSON.parse(localStorage.getItem(libraryKey)||'null');if(saved){library=parseArmModels(saved.library);sourceHash=saved.sourceHash||'';}bindings=JSON.parse(localStorage.getItem(bindingKey)||'{}');if(!bindings||typeof bindings!=='object'||Array.isArray(bindings))bindings={};}catch{bindings={};}
 $('#clear-target-arm').onclick=()=>{try{onTarget(null);localStorage.removeItem(targetKey);refresh();}catch(e){status.textContent='ERROR: '+e.message;}};
 document.getElementById('language').addEventListener('change',refresh);options();
 return {restore,refresh,selectionSnapshot,restoreTarget(){try{const saved=JSON.parse(localStorage.getItem(targetKey)||'null');if(saved){onTarget(saved.snapshot,saved.fingers,saved.sourceKey);refresh();}}catch(e){status.textContent='ERROR: '+e.message;}}};
}
