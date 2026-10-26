// Visual calibration from the user's 2026-10-26 video: right wrist nearly
// straight at the start of marka (COM15 column 6 = 3025). Not hardware calibration.
export const rightWristReference=3025;
export const previousRightWristReference=1375;
export function applyWristReference(config){
 const next=structuredClone(config);
 if(!next.rightWristVideoReferenceV1){
  if(next.R.zero[5]===previousRightWristReference)next.R.zero[5]=rightWristReference;
  next.rightWristVideoReferenceV1=true;
 }
 return next;
}
