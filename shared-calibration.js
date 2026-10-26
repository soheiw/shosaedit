// Calibration is shared by tabs on the same origin. Reconcile on storage events
// and return-to-tab, without changing motion selection, playback time or camera.
export function watchSharedCalibration({key,read,current,validate,apply,target,documentTarget}){
 function sync(raw){
  try{
   const text=typeof raw==='string'?raw:read();if(!text)return false;
   const next=validate(JSON.parse(text));
   if(JSON.stringify(next)===JSON.stringify(current()))return false;
   apply(next);return true;
  }catch{return false;} // Invalid or incomplete settings never replace a live rig.
 }
 const storage=event=>{if(event.key===key)sync(event.newValue);};
 const focus=()=>sync();
 const visible=()=>{if(documentTarget.visibilityState==='visible')sync();};
 target.addEventListener('storage',storage);target.addEventListener('focus',focus);
 documentTarget.addEventListener('visibilitychange',visible);
 return {sync,destroy(){target.removeEventListener('storage',storage);target.removeEventListener('focus',focus);documentTarget.removeEventListener('visibilitychange',visible);}};
}
