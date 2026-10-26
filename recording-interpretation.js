// Recording counts are immutable. This layer maps a known recording's encoder
// origin onto the CAD reference pose, independently of the CSV data.
export function applyAxisInterpretation(config){
 const out=structuredClone(config);
 if(!out.leftLateralDirectionV1){
  const j=out.L.joints[1];
  if(j.motor===0&&j.gain===1&&j.axis.join(',')==='0,0,1')j.axis=[0,0,-1];
  out.leftLateralDirectionV1=true;
 }
 if(!out.leftWristDirectionV1){
  const j=out.L.joints[7];
  if(j.motor===6&&j.gain===1&&j.axis.join(',')==='1,0,0')j.axis=[-1,0,0];
  out.leftWristDirectionV1=true;
 }
 return out;
}
export function matchingReferenceProfile(recording,profiles=[]){
 if(recording?.referenceProfile==='common')return null;
 const explicit=profiles.find(p=>p.id===recording?.referenceProfile);if(explicit)return explicit;
 return profiles.find(p=>['R','L'].every(side=>Array.isArray(p.match?.[side])&&p.match[side].length===7&&p.match[side].every((v,i)=>recording?.[side]?.[0]?.[i]===v)))??null;
}
export function interpretedConfiguration(base,recording,profiles=[]){
 const profile=matchingReferenceProfile(recording,profiles);if(!profile)return base;
 const out={...base};
 for(const [side,width] of [['R',9],['L',8]]){
  const custom=base.recordingReferences?.[profile.id]?.[side];
  const zero=Array.isArray(custom)&&custom.length===width&&custom.every(Number.isFinite)?custom:profile.zero?.[side];
  if(!Array.isArray(zero)||zero.length!==width||!zero.every(Number.isFinite))throw Error('Invalid recording reference');
  out[side]={...base[side],zero:[...zero]};
 }
 return out;
}
export function setRecordingReference(base,recording,profiles,side,zero){
 const width=side==='R'?9:8;if(!Array.isArray(zero)||zero.length!==width||!zero.every(Number.isFinite))throw Error('Invalid recording reference');
 const profile=matchingReferenceProfile(recording,profiles);
 if(profile){base.recordingReferences??={};base.recordingReferences[profile.id]??={};base.recordingReferences[profile.id][side]=[...zero];}
 else base[side].zero=[...zero];
}
