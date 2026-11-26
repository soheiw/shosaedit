import assert from 'node:assert/strict';
import {Matrix4,Vector3} from '../vendor/three.module.js';
import {retargetRecording} from '../retarget-motion.js';

const clone=structuredClone;
function snapshot(){
 const out={version:1,resolution:4096,label:'source',convention:'test'};
 for(const [side,width,start]of [['R',9,1],['L',8,11]])out[side]={
  ids:Array.from({length:width},(_,i)=>start+i),zero:Array(width).fill(2048),model:'same-hand',calibratedAt:'test',
  joints:Array.from({length:8},(_,i)=>({pivot:[i*11,i*29,i*7],axis:[[1,0,0],[0,1,0],[0,0,1]][i%3],motor:i-1,gain:i===0?0:(side==='R'?1:-1)}))};
 return out;
}
function recording(s){return {format:'augmented-arms-motion',version:1,fps:30,name:'test',calibrationSnapshot:clone(s),referenceProfile:'legacy',
 R:Array.from({length:5},(_,f)=>s.R.zero.map((v,i)=>v+(i<7?50+f*(i+1):f*8))),
 L:Array.from({length:4},(_,f)=>s.L.zero.map((v,i)=>v+(i<7?-40+f*(i+1):f*7)))};}
function fk(s,side,row){
 const matrices=[],world=new Matrix4();
 s[side].joints.forEach((joint,i)=>{
  const prev=i?s[side].joints[i-1].pivot:[0,0,0];
  world.multiply(new Matrix4().makeTranslation(...joint.pivot.map((v,k)=>v-prev[k])));
  if(joint.motor>=0)world.multiply(new Matrix4().makeRotationAxis(new Vector3(...joint.axis).normalize(),(row[joint.motor]-s[side].zero[joint.motor])*joint.gain*2*Math.PI/s.resolution));
  matrices.push(world.clone());
 });
 return matrices;
}
function sameFK(a,b,source,target,tol=1e-10){for(const side of ['R','L'])a[side].forEach((row,f)=>{
 const x=fk(source,side,row),y=fk(target,side,b[side][f]);
 x.forEach((m,i)=>m.elements.forEach((v,k)=>assert.ok(Math.abs(v-y[i].elements[k])<tol,`${side} frame${f} joint${i} element${k}`)));
});}

const source=snapshot(),motion=recording(source),before=JSON.stringify({source,motion});
for(const target of [undefined,clone(source)]){
 const result=retargetRecording(motion,source,target);
 assert.deepEqual(result.R,motion.R);assert.deepEqual(result.L,motion.L);
 assert.notEqual(result.R,motion.R);assert.notEqual(result.R[0],motion.R[0]);
 sameFK(motion,result,source,result.calibrationSnapshot);
}
const target=clone(source);target.label='second arm';
for(const side of ['R','L']){
 target[side].zero=target[side].zero.map((v,i)=>v+(i<7?700+i*20:0));
 target[side].joints[2].axis=target[side].joints[2].axis.map(v=>-v);
 target[side].joints[4].gain*=-1;
 // Different physical motor assignment remains invertible.
 [target[side].joints[5].motor,target[side].joints[6].motor]=[target[side].joints[6].motor,target[side].joints[5].motor];
}
const moved=retargetRecording(motion,source,target);
sameFK(motion,moved,source,target);
assert.equal(moved.R[0][0],target.R.zero[0]+50,'the first sample must not become the neutral pose');
const restored=retargetRecording(moved,target,source);
assert.deepEqual(restored.R,motion.R);assert.deepEqual(restored.L,motion.L);
assert.deepEqual(moved.retargeting.sourceCalibrationSnapshot.R.zero,source.R.zero);
assert.equal(moved.retargeting.hardwareVerified,false);
assert.equal(JSON.stringify({source,motion}),before,'source arrays and JSON must remain immutable');

const fractional=clone(source);fractional.R.zero[0]+=.3;
const floatResult=retargetRecording(motion,source,fractional,{roundCounts:false});
sameFK(motion,floatResult,source,fractional);
const rounded=retargetRecording(motion,source,fractional);
assert.ok(Math.abs(rounded.R[0][0]-floatResult.R[0][0])<=.5);
assert.ok(rounded.retargeting.maxRoundingErrorCounts<=.5);

const changedFingers=clone(source);changedFingers.R.model='other-hand';changedFingers.R.zero[7]+=100;
assert.throws(()=>retargetRecording(motion,source,changedFingers),/FINGER_MAPPING_REQUIRED/);
const fixed=clone(motion);fixed.R=fixed.R.map(row=>row.map((v,i)=>i>=7?2048:v));
assert.throws(()=>retargetRecording(fixed,source,changedFingers),/FINGER_MAPPING_REQUIRED/,'fixed fingers must not silently become target rest');
const fingerMappings={R:[7,8].map(index=>({index,sourceOpen:2048,sourceClosed:2200,targetOpen:2100,targetClosed:1900}))};
const mapBefore=JSON.stringify(fingerMappings);
const fingerResult=retargetRecording(motion,source,changedFingers,{fingerMappings,roundCounts:false});
assert.equal(fingerResult.R[0][7],2100);assert.ok(fingerResult.R[4][7]<2100);
assert.equal(JSON.stringify(fingerMappings),mapBefore);
assert.throws(()=>retargetRecording(motion,source,changedFingers,{fingerMappings:{R:[{...fingerMappings.R[0],sourceClosed:2049},fingerMappings.R[1]]}}),/FINGER_RANGE_UNKNOWN/);
assert.throws(()=>retargetRecording(motion,source,changedFingers,{fingerMappings:{R:[fingerMappings.R[0],fingerMappings.R[0]]}}),/INVALID_FINGER_MAPPING/);

const resolutionTarget=clone(source);resolutionTarget.resolution=8192;
const allFingerMappings=Object.fromEntries(['R','L'].map(side=>[side,source[side].zero.slice(7).map((_,i)=>({index:i+7,sourceOpen:2048,sourceClosed:2200,targetOpen:2048,targetClosed:2352}))]));
const doubled=retargetRecording(motion,source,resolutionTarget,{fingerMappings:allFingerMappings});
sameFK(motion,doubled,source,resolutionTarget);
assert.equal(doubled.R[0][0],2148);

for(const [mutate,pattern]of [
 [s=>{s.R.joints[1].axis=[0,0,1];},/AXIS_MISMATCH/],
 [s=>{s.L.joints[4].pivot[0]+=1;},/GEOMETRY_MISMATCH/],
 [s=>{s.R.joints[2].gain=0;},/UNSUPPORTED_JOINT_MAP/],
 [s=>{s.R.joints[2].motor=0;},/UNSUPPORTED_JOINT_MAP/],
 [s=>{s.R.ids.reverse();},/Invalid calibration IDs/],
]){const bad=clone(source);mutate(bad);assert.throws(()=>retargetRecording(motion,source,bad),pattern);}
const mismatch=clone(source);mismatch.R.zero[0]++;
assert.throws(()=>retargetRecording(motion,mismatch,target),/SOURCE_CALIBRATION_MISMATCH/);
const multiturn=clone(motion);multiturn.R[0][0]=20000;
assert.equal(retargetRecording(multiturn,source,target).R[0][0],20700);
const overflow=clone(source);overflow.R.zero[0]=2147483647;
assert.throws(()=>retargetRecording(motion,source,overflow),/COUNT_OUT_OF_RANGE/);
assert.throws(()=>retargetRecording({...motion,fps:60},source,target),/30fps/);
const legacyConfig={resolution:source.resolution,R:{zero:source.R.zero,joints:source.R.joints},L:{zero:source.L.zero,joints:source.L.joints}};
assert.deepEqual(retargetRecording({...motion,calibrationSnapshot:undefined},legacyConfig).R,motion.R);
console.log('Retarget motion: FK, inverse, immutable source, count precision, explicit finger mappings and incompatibility checks passed. Hardware and CAD visual verification are not covered.');
