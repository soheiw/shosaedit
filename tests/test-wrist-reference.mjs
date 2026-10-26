import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {applyWristReference,rightWristReference} from '../wrist-reference.js';
const before={R:{zero:[2535,2916,2034,2974,3611,1375,1890,3492,396]},L:{zero:[2035,1112,2258,1166,1895,2003,2164,3213]}};
const after=applyWristReference(before);
assert.equal(after.R.zero[5],3025);assert.equal(before.R.zero[5],1375);
assert.deepEqual(after.L,before.L);assert.deepEqual(after.R.zero.filter((_,i)=>i!==5),before.R.zero.filter((_,i)=>i!==5));
assert.deepEqual(applyWristReference(after),after);
const custom=structuredClone(before);custom.R.zero[5]=2800;
assert.equal(applyWristReference(custom).R.zero[5],2800);
for(const name of ['marka','markb']){
 const m=JSON.parse(await readFile(new URL(`../motion-data/${name}.motion.json`,import.meta.url)));
 const angles=m.R.map(row=>(row[5]-rightWristReference)*360/4096);
 assert(Math.max(...angles.map(Math.abs))<20,`${name}: wrist cannot fold back on itself`);
}
console.log('PASS shared wrist reference, untouched other axes, custom calibration, repeat loading, new recording wrist ranges');
