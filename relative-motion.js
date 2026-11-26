import {validateCalibrationSnapshot} from './arm-calibration.js';
import {validateRecording} from './motion-files.js';

const widths={R:9,L:8},TAU=2*Math.PI,MAX=2147483647;
export const relativeMotionFormat='shosaedit-relative-motion';
export const inwardRestConvention='arms-down-palms-inward-v1';
const fail=(message)=>{throw Error(message);};
const close=(a,b)=>Math.abs(a-b)<1e-9;

function calibration(value){
 const snapshot=validateCalibrationSnapshot(value);
 if(!['rest-arms-down-palms-inward-v1','td-rest-forearm-quarter-turn-v1'].includes(snapshot.convention))fail('Explicit palms-inward rest convention required; legacy CAD-zero data must be interpreted first');
 for(const side of Object.keys(widths)){
  if(!snapshot[side].rest)fail(`${side}: explicit model rest counts are required`);
  const motors=snapshot[side].joints.slice(1).map(j=>j.motor);
  if(snapshot[side].joints[0].motor!==-1||new Set(motors).size!==7||motors.some(i=>i<0||i>6))fail(`${side}: unsupported arm motor mapping`);
 }
 return snapshot;
}
function compatibleBasis(source,target){
 for(const side of Object.keys(widths)){
  for(let i=0;i<8;i++){
   const a=source[side].joints[i],b=target[side].joints[i];
   if(a.motor!==b.motor||!close(a.gain,b.gain)||a.axis.some((v,k)=>!close(v,b.axis[k]))||a.pivot.some((v,k)=>!close(v,b.pivot[k])))fail(`${side}: arm geometry/direction differs; rest counts alone cannot convert it`);
  }
  for(let i=0;i<7;i++)if(!close((source[side].rest[i]-source[side].zero[i])/source.resolution,(target[side].rest[i]-target[side].zero[i])/target.resolution))fail(`${side}: source and target rest poses have different CAD interpretations`);
 }
}
/** Arm samples are radians in encoder-count direction relative to immutable REST.
 * Finger counts are separate, absolute provisional samples, NOT relative angles.
 * No device writes, filesystem writes, clamping or multi-turn wrapping occur here.
 */
export function toRelativeMotion(recording){
 const input=validateRecording(recording),source=calibration(input.calibrationSnapshot);
 const out={format:relativeMotionFormat,version:1,fps:30,referencePose:inwardRestConvention,angleUnit:'rad',angleDirection:'encoder-count',name:input.name||'Motion',arms:{},fingers:{},sourceCalibrationSnapshot:source,
  fingerProvenance:{kind:'absolute-source-counts',status:'provisional',hardwareVerified:false}};
 for(const [side,width]of Object.entries(widths)){
  out.arms[side]=input[side].map(row=>row.slice(0,7).map((v,i)=>(v-source[side].rest[i])*TAU/source.resolution));
  out.fingers[side]=input[side].map(row=>row.slice(7,width));
 }
 return out;
}
export function validateRelativeMotion(value){
 if(value?.format!==relativeMotionFormat||value.version!==1||value.fps!==30||value.referencePose!==inwardRestConvention||value.angleUnit!=='rad'||value.angleDirection!=='encoder-count')fail('Invalid relative motion convention');
 const source=calibration(value.sourceCalibrationSnapshot);
 if(value.fingerProvenance?.kind!=='absolute-source-counts'||value.fingerProvenance?.status!=='provisional')fail('Explicit provisional finger provenance required');
 for(const [side,width]of Object.entries(widths)){
  const arms=value.arms?.[side],fingers=value.fingers?.[side];
  if(!Array.isArray(arms)||arms.length<2||arms.length>10000||!Array.isArray(fingers)||fingers.length!==arms.length)fail(`${side}: missing or mismatched samples`);
  if(arms.some(row=>!Array.isArray(row)||row.length!==7||row.some(v=>!Number.isFinite(v))))fail(`${side}: invalid relative arm angles`);
  if(fingers.some(row=>!Array.isArray(row)||row.length!==width-7||row.some(v=>!Number.isSafeInteger(v)||Math.abs(v)>MAX)))fail(`${side}: invalid absolute finger counts`);
 }
 return {...structuredClone(value),sourceCalibrationSnapshot:source};
}
/** Explicit opt-in is required to reuse provisional finger values on another
 * model. That opt-in does not assert calibrated finger equivalence or safety.
 */
export function fromRelativeMotion(value,targetSnapshot,{retainProvisionalFingerCounts=false,countRange=[-2147483647,2147483647]}={}){
 const motion=validateRelativeMotion(value),source=motion.sourceCalibrationSnapshot,target=calibration(targetSnapshot);
 compatibleBasis(source,target);
 if(!Array.isArray(countRange)||countRange.length!==2||!countRange.every(Number.isSafeInteger)||countRange[0]<-MAX||countRange[1]>MAX||countRange[0]>countRange[1])fail('Invalid output count range');
 const sameFingerBasis=Object.keys(widths).every(side=>source.resolution===target.resolution&&source[side].model===target[side].model&&source[side].rest.slice(7).every((v,i)=>v===target[side].rest[i+7]));
 if(!sameFingerBasis&&!retainProvisionalFingerCounts)fail('Finger calibration differs; explicitly authorize retaining provisional counts or supply calibrated finger conversion');
 const out={format:'augmented-arms-motion',version:1,fps:30,name:motion.name,calibrationSnapshot:target,relativeMotionProvenance:{method:'rest-relative-radians-v1',referencePose:inwardRestConvention,sourceCalibrationSnapshot:source,fingerProvenance:motion.fingerProvenance,retainedProvisionalFingerCounts:!sameFingerBasis,hardwareVerified:false}};
 for(const side of Object.keys(widths))out[side]=motion.arms[side].map((row,i)=>{
  const result=[...row.map((rad,j)=>target[side].rest[j]+rad*target.resolution/TAU),...motion.fingers[side][i]];
  return result.map(v=>{if(!Number.isFinite(v)||v<countRange[0]-1e-7||v>countRange[1]+1e-7)fail(`${side}: output outside permitted count range; not clamped or wrapped`);return Math.round(v);});
 });
 return {...out,...validateRecording(out)};
}
