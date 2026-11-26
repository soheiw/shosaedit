import {modelFilename} from './model-filename.js';

// File delivery only: this never starts playback or sends motor commands.
export function bindComPublish({button,status,getRecording,validate,request=fetch,pause=ms=>new Promise(r=>setTimeout(r,ms))}){
 const en=()=>document.documentElement.lang==='en';
 const label=()=>button.textContent=en()?'Apply to COM14 / 15':'COM14・15へ反映';
 label();document.querySelector('#language')?.addEventListener('change',label);
 async function api(path,body){const r=await request('/api/sync/'+path,body===undefined?{}:{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body)});const data=await r.json();if(!r.ok)throw Error(data.error||r.statusText);return data;}
 button.onclick=async()=>{
  if(button.disabled)return;button.disabled=true;let jobId;
  try{
   status.textContent=en()?'Checking calibration and estimated loads…':'校正と推定負荷を確認中…';
   const recording=getRecording();await validate(recording);
   const config=await api('status');
   if(!config.enabled||config.mode!=='both')throw Error(en()?'Enable bidirectional sync in the Alienware sync panel.':'Alienware自動同期欄で「双方向」と「自動同期を有効にする」を設定してください。');
   const payload={...recording,name:modelFilename(recording.name,recording.calibrationSnapshot)};
   const queued=await api('publish',payload);jobId=queued.jobId;
   status.textContent=(en()?'Transferring: ':'転送中：')+payload.name;
   for(let i=0;i<120;i++){
    await pause(1000);const s=await api('status'),job=s.publishes?.find(j=>j.jobId===jobId);
    if(!job)continue;
    if(['published','unchanged'].includes(job.status)){
     status.textContent=(en()?'Verified in COM14 (left) / COM15 (right): ':'COM14（左）・COM15（右）へ反映・読み戻し確認済み：')+job.name+'.csv';return;
    }
    if(['error','failed','cancelled'].includes(job.status))throw Error(job.error||job.status);
   }
   status.textContent=en()?'Transfer pending. Check Alienware sync status before retrying.':'転送待ちです。再送前にAlienware自動同期欄の状態を確認してください。';
  }catch(e){status.textContent=(en()?'COM delivery not confirmed: ':'COM反映を確認できません：')+e.message+(jobId?(en()?' (Check sync status before retrying.)':'（再送前に同期欄を確認してください）'):'');}
  finally{button.disabled=false;label();}
 };
 return button.onclick;
}
