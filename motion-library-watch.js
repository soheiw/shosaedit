// Discover additions without replacing the selected motion or its editing state.
export function watchMotionLibrary({initial=[],fetchJSON,onAdd,interval=5000,onError=console.warn}){
 const seen=new Set(initial.map(e=>e.id));let busy=false,closed=false;
 async function refresh(){
  if(busy||closed)return;busy=true;
  try{
   const entries=await fetchJSON('motion-data/generated-motions.json');
   for(const entry of entries){
    if(closed)break;
    if(seen.has(entry.id))continue;
    try{const motion=await fetchJSON('motion-data/'+entry.file);if(closed)break;await onAdd(entry.id,motion);seen.add(entry.id);}catch(error){onError('Motion library: '+entry.id,error);}
   }
  }catch(error){onError('Motion library refresh',error);}finally{busy=false;}
 }
 const timer=setInterval(refresh,interval);
 const focus=()=>{void refresh();};globalThis.addEventListener?.('focus',focus);
 const visible=()=>{if(globalThis.document?.visibilityState==='visible')void refresh();};globalThis.document?.addEventListener('visibilitychange',visible);
 void refresh();
 return {refresh,close(){closed=true;clearInterval(timer);globalThis.removeEventListener?.('focus',focus);globalThis.document?.removeEventListener('visibilitychange',visible);}};
}
