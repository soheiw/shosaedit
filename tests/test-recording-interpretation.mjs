import {createHash} from 'node:crypto';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {applyAxisInterpretation,interpretedConfiguration,matchingReferenceProfile,setRecordingReference} from '../recording-interpretation.js';
const read=p=>JSON.parse(fs.readFileSync(new URL('../'+p,import.meta.url)));
const recording=read('motion-data/markc.motion.json'),profiles=read('recording-references.json'),unchanged=JSON.stringify(recording);
const base={resolution:4096,R:{zero:[2535,2916,2034,2974,3611,3025,1890,3492,396],joints:Array.from({length:8},(_,i)=>({motor:i-1,gain:1,axis:[1,0,0]}))},L:{zero:[2035,1112,2258,1166,1895,2003,2164,3213],joints:Array.from({length:8},(_,i)=>({motor:i-1,gain:1,axis:[1,0,0]}))}};
base.L.joints[1].axis=[0,0,1];
const migrated=applyAxisInterpretation(base);assert.deepEqual(migrated.L.joints[1].axis,[0,0,-1]);assert.deepEqual(migrated.L.joints[7].axis,[-1,0,0]);assert.deepEqual(base.L.joints[7].axis,[1,0,0]);assert.deepEqual(applyAxisInterpretation(migrated),migrated);
const custom=structuredClone(base);custom.L.joints[7].gain=-1;assert.equal(applyAxisInterpretation(custom).L.joints[7].gain,-1);
const actual=interpretedConfiguration(migrated,recording,profiles);
assert.deepEqual(actual.R.zero,[2541,2947,1022,1892,1524,2017,1814,3891,405]);assert.deepEqual(actual.L.zero,[2034,1115,2079,1168,1905,1987,2268,2899]);
assert.equal(actual.R.joints,migrated.R.joints);assert.equal(actual.L.joints,migrated.L.joints);
assert.equal(matchingReferenceProfile(read('motion-data/marka.motion.json'),profiles),null);
assert.equal(interpretedConfiguration(migrated,read('motion-data/marka.motion.json'),profiles),migrated);
const exportedCopy=JSON.parse(JSON.stringify(recording));assert.equal(matchingReferenceProfile(exportedCopy,profiles).id,'markc-video-reference');
const zero=[...actual.R.zero];zero[5]+=2;setRecordingReference(migrated,recording,profiles,'R',zero);
assert.equal(interpretedConfiguration(migrated,recording,profiles).R.zero[5],2019);assert.equal(migrated.R.zero[5],3025);
assert.equal(JSON.stringify(recording),unchanged,'CSV-equivalent counts must remain immutable');
assert.throws(()=>setRecordingReference(migrated,recording,profiles,'R',[1,2]));
console.log('PASS record-specific origins, immutable counts/time, CSV reimport matching, user overrides, isolated common reference and left-wrist axis migration');

const explicit=structuredClone(recording);explicit.R[0][0]+=400;explicit.referenceProfile='markc-video-reference';
assert.equal(matchingReferenceProfile(explicit,profiles).id,'markc-video-reference');
explicit.referenceProfile='common';assert.equal(matchingReferenceProfile(explicit,profiles),null);
explicit.referenceProfile='unknown';assert.equal(matchingReferenceProfile(explicit,profiles),null);

// Frozen before authoring finger motion. Original recorded bytes must never be
// changed by a generator or geometry/interpretation correction.
const originalHashes=JSON.parse(fs.readFileSync(new URL('./original-recording-sha256.json',import.meta.url)));
for(const [file,expected] of Object.entries(originalHashes)){
 const actual=createHash('sha256').update(fs.readFileSync(new URL('../'+file,import.meta.url))).digest('hex');
 assert.equal(actual,expected,`${file}: original recording bytes changed`);
}
console.log(`PASS ${Object.keys(originalHashes).length} frozen original recording files remain byte-identical`);

// A duplicate robot's saved mechanical reference must not leak into legacy
// recordings. Its near-straight elbow used to render approximately 94° bent.
const alienware=read('motion-data/alienware/marka-20261102-175844.motion.json');
const alienwareBefore=JSON.stringify(alienware),baseBefore=JSON.stringify(base);
const duplicate=interpretedConfiguration(base,alienware,profiles);
assert.equal(duplicate.R.zero[3],1909);
assert.equal(base.R.zero[3],2974);
assert(Math.max(...alienware.R.map(r=>Math.abs((r[3]-duplicate.R.zero[3])*360/4096)))<.4);
assert(Math.abs((alienware.R[0][3]-base.R.zero[3])*360/4096)>90);
assert.equal(interpretedConfiguration(base,read('motion-data/marka.motion.json'),profiles),base);
const editedDuplicate=structuredClone(alienware);editedDuplicate.R[0][3]+=10;
assert.equal(interpretedConfiguration(base,editedDuplicate,profiles).R.zero[3],1909,'explicit calibration survives edits to first row');
assert.equal(JSON.stringify(alienware),alienwareBefore);
assert.equal(JSON.stringify(base),baseBefore);
console.log('PASS Alienware saved elbow reference, immutable counts, legacy isolation and edited first-row handling');

// Mounted left arm: preserve the elbow bend and change its upstream rotation plane.
const front2=read('motion-data/alienware/front2-191733.motion.json');
const capture=JSON.stringify(front2);
const mounted=interpretedConfiguration(base,front2);
assert.deepEqual(mounted.L.joints[3].axis,[0,-1,0]);
assert.deepEqual(mounted.L.joints[4],front2.calibrationSnapshot.L.joints[4]);
assert.deepEqual(mounted.L.joints[5],front2.calibrationSnapshot.L.joints[5]);
assert.deepEqual(mounted.R.joints,front2.calibrationSnapshot.R.joints);
assert.equal(JSON.stringify(front2),capture);
