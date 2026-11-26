import assert from 'node:assert/strict';
import fs from 'node:fs';
import {toRelativeMotion,fromRelativeMotion,validateRelativeMotion} from '../relative-motion.js';
import {retargetRecording} from '../retarget-motion.js';
const source=JSON.parse(fs.readFileSync(new URL('../motion-data/video/video-arm-dance-model-c.motion.json',import.meta.url)));
const snapshot=source.calibrationSnapshot,before=JSON.stringify(source),relative=toRelativeMotion(source);
const back=fromRelativeMotion(relative,snapshot);
assert.deepEqual(back.R,source.R);assert.deepEqual(back.L,source.L);
assert.equal(JSON.stringify(source),before);
for(const side of ['R','L']){
 const restMotion=structuredClone(source);restMotion[side]=[snapshot[side].rest,snapshot[side].rest];
 assert.deepEqual(toRelativeMotion(restMotion).arms[side][0],Array(7).fill(0));
}
const target=structuredClone(snapshot);
for(const side of ['R','L']){
 target[side].model='another';
 target[side].rest=target[side].rest.map((v,i)=>i<7?v+23+i:v);
 target[side].zero=target[side].zero.map((v,i)=>i<7?v+23+i:v);
}
assert.throws(()=>fromRelativeMotion(relative,target),/Finger calibration/);
const converted=fromRelativeMotion(relative,target,{retainProvisionalFingerCounts:true});
const identity={R:[7,8].map(index=>({index,sourceOpen:0,sourceClosed:4095,targetOpen:0,targetClosed:4095})),L:[{index:7,sourceOpen:0,sourceClosed:4095,targetOpen:0,targetClosed:4095}]};
const legacy=retargetRecording(source,snapshot,target,{fingerMappings:identity});
assert.deepEqual(converted.R,legacy.R);assert.deepEqual(converted.L,legacy.L);
const bad=structuredClone(target);bad.R.joints[1].axis=bad.R.joints[1].axis.map(v=>-v);
assert.throws(()=>fromRelativeMotion(relative,bad,{retainProvisionalFingerCounts:true}),/geometry\/direction/);
const pose=structuredClone(target);pose.R.zero[4]+=1024;
assert.throws(()=>fromRelativeMotion(relative,pose,{retainProvisionalFingerCounts:true}),/different CAD/);
const missing=structuredClone(source);delete missing.calibrationSnapshot.R.rest;
assert.throws(()=>toRelativeMotion(missing),/explicit model rest/);
const unknown=structuredClone(source);unknown.calibrationSnapshot.convention='rest-is-cad';assert.throws(()=>toRelativeMotion(unknown),/palms-inward rest/);
const malformed=structuredClone(relative);malformed.arms.R[0][0]=NaN;
assert.throws(()=>validateRelativeMotion(malformed),/invalid relative/);
assert.throws(()=>fromRelativeMotion(relative,snapshot,{countRange:[2000,2100]}),/outside permitted/);
console.log('PASS rest-relative zero, exact 916-frame roundtrip, old-retarget equivalence, immutable inputs, explicit finger opt-in, basis/ID/range/finite validation. No hardware verification.');
