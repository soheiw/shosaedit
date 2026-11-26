// Mechanical/display calibration, independent of the immutable motor samples.
const widths={R:9,L:8},sideNames={R:'right',L:'left'};
const array=(a,n,integer=false)=>Array.isArray(a)&&a.length===n&&a.every(v=>Number.isFinite(v)&&(!integer||Number.isSafeInteger(v))&&Math.abs(v)<=2147483647);
export function validateCalibrationSnapshot(value){
 if(value?.version!==1||!Number.isFinite(value.resolution)||value.resolution<=0||value.resolution>1000000)throw Error('校正スナップショットの形式が違います / Invalid calibration snapshot');
 const out={version:1,resolution:value.resolution,label:String(value.label||'Calibration').slice(0,200),convention:String(value.convention||'explicit').slice(0,100)};
 if(typeof value.sourceHash==='string'&&/^[a-f0-9]{64}$/.test(value.sourceHash))out.sourceHash=value.sourceHash;
 for(const [side,width]of Object.entries(widths)){
  const s=value[side],ids=Array.from({length:width},(_,i)=>i+(side==='R'?1:11));
  if(!array(s?.zero,width)||!array(s?.ids,width,true)||s.ids.some((v,i)=>v!==ids[i])||!Array.isArray(s.joints)||s.joints.length!==8)throw Error('校正のID順・基準値を確認してください / Invalid calibration IDs or zeros');
  const joints=s.joints.map(j=>{
   if(!array(j.pivot,3)||!array(j.axis,3)||Math.hypot(...j.axis)<1e-6||!Number.isFinite(j.gain)||Math.abs(j.gain)>100||!Number.isInteger(j.motor)||j.motor< -1||j.motor>=width)throw Error('校正の関節対応が不正です / Invalid joint calibration');
   return {pivot:[...j.pivot],axis:[...j.axis],motor:j.motor,gain:j.gain};
  });
  out[side]={ids,zero:[...s.zero],joints,model:String(s.model||'').slice(0,100),calibratedAt:String(s.calibratedAt||'').slice(0,100)};
  if(['HA','HB'].includes(s.handProfile))out[side].handProfile=s.handProfile;
  if(s.mount!==undefined){
   const {pitchDeg,outwardDeg}=s.mount;
   if(![pitchDeg,outwardDeg].every(v=>Number.isFinite(v)&&Math.abs(v)<=90))throw Error('Invalid mount angles');
   out[side].mount={pitchDeg,outwardDeg};
  }
  if(s.rest!==undefined){if(!array(s.rest,width,true))throw Error('Invalid rest pose');out[side].rest=[...s.rest];}
 }
 return out;
}
export function snapshotConfiguration(config,metadata={}){
 return validateCalibrationSnapshot({version:1,resolution:config.resolution,...metadata,...Object.fromEntries(Object.entries(widths).map(([side,width])=>[side,{...metadata[side],ids:metadata[side]?.ids||Array.from({length:width},(_,i)=>i+(side==='R'?1:11)),zero:config[side].zero,joints:config[side].joints}]))});
}
export function parseArmModels(value){
 if(value?.version!==1||!Array.isArray(value.models)||!value.models.length||value.models.length>50||!value.models.every(n=>typeof n==='string'&&n.length>0&&n.length<=100)||new Set(value.models).size!==value.models.length)throw Error('arm_models.json の形式が違います / Invalid arm_models.json');
 const out={version:1,models:[...value.models],selected:{},calibrations:{}};
 for(const [side,width]of Object.entries(widths)){
  const key=sideNames[side],entries=[];
  for(const model of out.models){
   const c=Object.hasOwn(value.calibrations?.[key]||{},model)?value.calibrations[key][model]:null;
   if(!c)continue;
   const ids=Array.from({length:width},(_,i)=>i+(side==='R'?1:11));
   if(!array(c.rest,width,true)||!array(c.ids,width,true)||c.ids.some((v,i)=>v!==ids[i]))throw Error(`${key} / ${model}: 校正のID順・列数が対応していません`);
   entries.push([model,{rest:[...c.rest],ids,time:String(c.time||'').slice(0,100),port:String(c.port||'').slice(0,50)}]);
  }
  out.calibrations[key]=Object.fromEntries(entries);
  out.selected[key]=out.models.includes(value.selected?.[key])?value.selected[key]:out.models[0];
 }
 return out;
}
export function armModelsSnapshot(library,selections,config,{convention='rest-arms-down-palms-inward-v1',sourceHash}={}){
 const data=parseArmModels(library),out=structuredClone(config),metadata={label:`${selections.R} / ${selections.L}`,convention,sourceHash};
 if(!['rest-arms-down-palms-inward-v1','td-rest-forearm-quarter-turn-v1','rest-is-cad'].includes(convention))throw Error('Unknown reference convention');
 for(const side of ['R','L']){
  const model=selections[side],c=Object.hasOwn(data.calibrations[sideNames[side]],model)?data.calibrations[sideNames[side]][model]:null;
  if(!c)throw Error(`${side} / ${model}: 校正が未登録です / Calibration missing`);
  out[side].zero=[...c.rest];
  // Single rest-to-CAD conversion: rest means arms down, palms inward.
  // Always derive from immutable rest, never add onto a previous zero.
  // Older snapshot conventions remain readable without rewriting recordings.
  if(convention!=='rest-is-cad')out[side].zero[4]+=out.resolution/4;
  metadata[side]={model,calibratedAt:c.time,ids:c.ids,rest:c.rest};
 }
 return snapshotConfiguration(out,metadata);
}
export async function sha256(bytes){return [...new Uint8Array(await crypto.subtle.digest('SHA-256',typeof bytes==='string'?new TextEncoder().encode(bytes):bytes))].map(v=>v.toString(16).padStart(2,'0')).join('');}
export function validatePlaybackRequirements(p){
 if(p===undefined)return undefined;
 if(p?.version!==1||p.requiresFreshStartCheck!==true||p.requiresScopeAwarePlayer!==true)throw Error('Invalid playback requirements');
 const activeMotorIds={};for(const [side,width]of Object.entries(widths)){
  const ids=p.activeMotorIds?.[side],first=side==='R'?1:11;
  if(!Array.isArray(ids)||!ids.length||new Set(ids).size!==ids.length||ids.some(v=>!Number.isInteger(v)||v<first||v>=first+width))throw Error('Invalid playback motor scope');
  activeMotorIds[side]=[...ids];
 }
 return {version:1,activeMotorIds,requiresFreshStartCheck:true,requiresScopeAwarePlayer:true,hardwareVerified:false};
}
export function sequenceCalibration(clips){
 const snapshots=clips.map(c=>c.calibrationSnapshot?validateCalibrationSnapshot(c.calibrationSnapshot):null);
 const keys=clips.map((c,i)=>JSON.stringify([snapshots[i]||{referenceProfile:c.referenceProfile||'common'},validatePlaybackRequirements(c.playbackRequirements)]));
 if(keys.some(k=>k!==keys[0]))throw Error('異なる校正の動作はそのまま連結できません / Calibration mismatch between motions');
 return {...(snapshots[0]?{calibrationSnapshot:structuredClone(snapshots[0])}:{referenceProfile:clips[0].referenceProfile}),playbackRequirements:validatePlaybackRequirements(clips[0].playbackRequirements)};
}
