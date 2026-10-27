import assert from 'node:assert/strict';
import {plotSamples,sampleAt} from '../live-position.js';
// Distinct 9th/8th channels catch off-by-one omissions and side-width assumptions.
const times=[.5,1,2,4],R=times.map((_,i)=>Array.from({length:9},(_,j)=>j===8?[-433,0,1200,2984][i]:100*j+i*10)),L=times.map((_,i)=>Array.from({length:8},(_,j)=>j===7?[494,800,2200,2820][i]:100*j-i*10));
const before=JSON.stringify({times,R,L});
assert.equal(sampleAt(times,R,8,0),-433,'right9 holds signed initial count during delay');
assert.equal(sampleAt(times,R,8,.75),-216.5);
assert.equal(sampleAt(times,R,8,1.5),600);
assert.equal(sampleAt(times,R,8,5),2984,'short arm holds final count');
assert.equal(sampleAt(times,R,7,1.5),715,'right8 independently sampled');
assert.equal(sampleAt(times,L,7,1.5),1500,'left8 independently sampled');
assert.equal(sampleAt([0,1,1,2],[[0],[10],[20],[40]],0,1),20,'latest repeated time wins');
assert.equal(sampleAt([],[],0,1),null);assert.equal(sampleAt([0],[[12]],0,100),12);assert.equal(sampleAt([0],[[12]],2,0),null);
assert.equal(sampleAt(times,R,8,NaN),null);
assert.deepEqual(plotSamples([],[],8),[]);assert.deepEqual(plotSamples([2],[[7]],0),[[2,7]]);
const longTimes=Array.from({length:10001},(_,i)=>i*.003),rows=longTimes.map(()=>Array(9).fill(0));rows[101][8]=-777;rows[102][8]=3980;rows[103][8]=-100;rows[9900][8]=-888;
const reduced=plotSamples(longTimes,rows,8,60);
assert.ok(reduced.some(([t,v])=>t===longTimes[101]&&v===-777),'negative spike retained');
assert.ok(reduced.some(([t,v])=>t===longTimes[102]&&v===3980),'positive spike retained in same bucket');
assert.ok(reduced.some(([t,v])=>t===longTimes[9900]&&v===-888));
assert.equal(reduced[0][0],0);assert.equal(reduced.at(-1)[0],longTimes.at(-1));assert.ok(reduced.length<=122);
assert.ok(reduced.every(([t,v],i)=>Number.isFinite(t)&&Number.isFinite(v)&&(!i||t>=reduced[i-1][0])));
assert.equal(JSON.stringify({times,R,L}),before,'plotting does not mutate recordings');
// Warped times are authoritative: the cursor must not assume30Hz or re-warp.
assert.equal(sampleAt([0,.1,3.7],[[0],[100],[460]],0,1.9),280);
console.log('Live position: all9R/8L channels, signed counts, delayed/tail holds, warped-time interpolation, duplicate times, immutable rows and positive/negative spike preservation passed.');
