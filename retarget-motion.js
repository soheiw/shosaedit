import {snapshotConfiguration,validateCalibrationSnapshot} from './arm-calibration.js';
import {validateRecording} from './motion-files.js';

const sides={R:9,L:8},limit=2147483647;
const copy=value=>structuredClone(value);
const fail=(code,message)=>{throw Error(`${code}: ${message}`);};
const numericKey=s=>JSON.stringify([s.resolution,...Object.keys(sides).map(side=>[s[side].zero,s[side].joints])]);
const normalizedSnapshot=config=>config?.version===1&&config.R?.ids?validateCalibrationSnapshot(config):snapshotConfiguration(config);
const normalizedAxis=axis=>{const length=Math.hypot(...axis);return axis.map(v=>v/length);};
const close=(a,b,tolerance=1e-7)=>Math.abs(a-b)<=tolerance;

function armTransforms(source,target,side){
 const transforms=[],sourceMotors=new Set(),targetMotors=new Set();
 for(let i=0;i<8;i++){
  const a=source[side].joints[i],b=target[side].joints[i];
  if(a.pivot.some((v,k)=>!close(v,b.pivot[k])))fail('GEOMETRY_MISMATCH',`${side} joint ${i}: pivot differs; identical link geometry is required`);
  if(i===0){
   if(a.motor!==-1||b.motor!==-1)fail('UNSUPPORTED_JOINT_MAP',`${side}: the base must be fixed`);
   continue;
  }
  if(a.motor<0||a.motor>6||b.motor<0||b.motor>6||sourceMotors.has(a.motor)||targetMotors.has(b.motor)||!a.gain||!b.gain)
   fail('UNSUPPORTED_JOINT_MAP',`${side} joint ${i}: seven independent, invertible arm motors are required`);
  sourceMotors.add(a.motor);targetMotors.add(b.motor);
  const aa=normalizedAxis(a.axis),bb=normalizedAxis(b.axis),dot=aa.reduce((sum,v,k)=>sum+v*bb[k],0);
  if(!close(Math.abs(dot),1,1e-10))fail('AXIS_MISMATCH',`${side} joint ${i}: axes must be parallel or antiparallel`);
  const scale=(dot<0?-1:1)*a.gain/b.gain*target.resolution/source.resolution;
  transforms.push({from:a.motor,to:b.motor,scale,sourceZero:source[side].zero[a.motor],targetZero:target[side].zero[b.motor]});
 }
 return transforms;
}

function fingerTransforms(source,target,side,mappings=[]){
 if(!Array.isArray(mappings))fail('INVALID_FINGER_MAPPING',`${side}: mappings must be an array`);
 const byIndex=new Map();
 for(const mapping of mappings){
  const {index,sourceOpen,sourceClosed,targetOpen,targetClosed}=mapping||{};
  if(!Number.isInteger(index)||index<7||index>=sides[side]||byIndex.has(index)||
   ![sourceOpen,sourceClosed,targetOpen,targetClosed].every(v=>Number.isFinite(v)&&Math.abs(v)<=limit)||sourceOpen===sourceClosed||targetOpen===targetClosed)
   fail('INVALID_FINGER_MAPPING',`${side}: each finger motor needs unique indices and distinct, finite open/closed endpoints`);
  byIndex.set(index,{index,sourceOpen,sourceClosed,targetOpen,targetClosed});
 }
 const transforms=[];
 for(let index=7;index<sides[side];index++){
  const a=source[side],b=target[side];
  const sameBasis=source.resolution===target.resolution&&a.zero[index]===b.zero[index]&&a.model===b.model&&a.rest?.[index]===b.rest?.[index];
  const mapping=byIndex.get(index);
  if(!mapping&&!sameBasis)fail('FINGER_MAPPING_REQUIRED',`${side} ID ${b.ids[index]}: finger open/closed correspondence is unknown; a rest count alone does not establish it`);
  transforms.push(sameBasis?{index,identity:true}:mapping);
 }
 return transforms;
}

/**
 * Convert immutable raw samples through relative joint angles into a target arm.
 * Assumes identical physical link geometry; this is not a hardware safety check.
 * Fingers require explicit endpoint mappings whenever their calibration basis differs.
 * roundCounts:false is for internal calculations, not CSV/export validation.
 */
export function retargetRecording(recording,sourceConfiguration,targetSnapshot,options={}){
 let source=normalizedSnapshot(sourceConfiguration);
 const input=validateRecording({format:'augmented-arms-motion',version:1,fps:30,...recording});
 if(input.calibrationSnapshot&&numericKey(input.calibrationSnapshot)!==numericKey(source))
  fail('SOURCE_CALIBRATION_MISMATCH','The recording snapshot and supplied source interpretation differ');
 // interpretedConfiguration intentionally returns display configuration only.
 // Retain the recording's original model/rest provenance when that numerical
 // interpretation agrees, instead of losing it through configuration conversion.
 if(input.calibrationSnapshot)source=copy(input.calibrationSnapshot);
 const target=targetSnapshot?validateCalibrationSnapshot(targetSnapshot):copy(source);
 const roundCounts=options.roundCounts!==false;
 let maxRoundingErrorCounts=0;
 const rows={},effectiveMappings={};
 for(const side of Object.keys(sides)){
  const arm=armTransforms(source,target,side);
  const fingers=fingerTransforms(source,target,side,options.fingerMappings?.[side]);
  effectiveMappings[side]=fingers.filter(t=>!t.identity);
  rows[side]=input[side].map(row=>{
   const out=[...row];
   for(const t of arm)out[t.to]=t.scale===1&&t.sourceZero===t.targetZero?row[t.from]:t.targetZero+(row[t.from]-t.sourceZero)*t.scale;
   for(const t of fingers){
    if(t.identity)continue;
    const fraction=(row[t.index]-t.sourceOpen)/(t.sourceClosed-t.sourceOpen);
    if(fraction < -1e-9||fraction > 1+1e-9)fail('FINGER_RANGE_UNKNOWN',`${side} ID ${target[side].ids[t.index]}: sample falls outside the explicitly mapped range`);
    out[t.index]=t.targetOpen+fraction*(t.targetClosed-t.targetOpen);
   }
   return out.map(value=>{
    if(!Number.isFinite(value)||Math.abs(value)>limit)fail('COUNT_OUT_OF_RANGE','Retargeted counts must fit signed 32-bit values; no wrapping or clamping is performed');
    const rounded=roundCounts?Math.round(value):value;
    maxRoundingErrorCounts=Math.max(maxRoundingErrorCounts,Math.abs(rounded-value));
    return rounded;
   });
  });
 }
 const result={...copy(recording),...input,format:'augmented-arms-motion',version:1,fps:30,...rows,calibrationSnapshot:target};
 delete result.referenceProfile;
 if(roundCounts)Object.assign(result,validateRecording(result));
 result.retargeting={version:1,method:'relative-joint-angle-v1',sourceCalibrationSnapshot:source,
  sourceReferenceProfile:recording.referenceProfile||null,fingerMappings:copy(effectiveMappings),
  roundCounts,maxRoundingErrorCounts,hardwareVerified:false};
 return result;
}
