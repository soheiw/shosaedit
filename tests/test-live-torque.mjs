import assert from 'node:assert/strict';
import {torquePlotSamples} from '../torque-live.js';
const times=Array.from({length:10000},(_,i)=>i/30),rows=times.map(()=>[0,0,0,0,0,0,0]);rows[5001][0]=-17;rows[5002][0]=5;rows[8999][6]=-23;
for(const [j,peak] of [[0,17],[6,23]]){const points=torquePlotSamples(times,rows,j);assert.equal(points[0][0],0);assert.equal(points.at(-1)[0],9999/30);assert.equal(Math.max(...points.map(p=>p[1])),peak);assert.ok(points.length<=902);assert.ok(points.every((p,i)=>!i||p[0]>points[i-1][0]));}
assert.deepEqual(torquePlotSamples([0],[[2,0,0,0,0,0,0]],0),[[0,2]]);
console.log('Live torque graph: absolute signed torques, first/last samples, short-spike preservation and bounded monotonic display paths passed.');
