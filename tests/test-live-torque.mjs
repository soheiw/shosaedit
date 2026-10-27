import assert from 'node:assert/strict';
import {torquePlotSamples,torqueChannelStatus} from '../torque-live.js';
const times=Array.from({length:10000},(_,i)=>i/30),rows=times.map(()=>[0,0,0,0,0,0,0]);rows[5001][0]=-17;rows[5002][0]=5;rows[8999][6]=-23;
for(const [j,peak] of [[0,17],[6,23]]){const points=torquePlotSamples(times,rows,j);assert.equal(points[0][0],0);assert.equal(points.at(-1)[0],9999/30);assert.equal(Math.max(...points.map(p=>p[1])),peak);assert.ok(points.length<=902);assert.ok(points.every((p,i)=>!i||p[0]>points[i-1][0]));}
assert.deepEqual(torquePlotSamples([0],[[2,0,0,0,0,0,0]],0),[[0,2]]);
console.log('Live torque graph: absolute signed torques, first/last samples, short-spike preservation and bounded monotonic display paths passed.');

for(const side of ['R','L'])for(let j=0;j<7;j++)assert.equal(torqueChannelStatus(side,j),'estimated');
for(const [side,j]of [['R',7],['R',8],['L',7]]){
 assert.equal(torqueChannelStatus(side,j),'not-estimated');
 assert.deepEqual(torquePlotSamples([0,1],[Array(9).fill(0),Array(9).fill(12)],j),[],'finger counts must never be rendered as torque, including invented zero');
}
assert.equal(torqueChannelStatus('L',8),'unavailable');
assert.equal(torqueChannelStatus('R',9),'unavailable');
assert.deepEqual(torquePlotSamples([],[],0),[]);
console.log('Finger torque channels: R8/R9/L8 explicitly unestimated, L9 unavailable, no fabricated zero/value curves; original14 computed channels retained.');
