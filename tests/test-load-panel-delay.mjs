import assert from 'node:assert/strict';
import {createLoadPanel} from '../load-panel.js';
const near=(a,b,t=1e-8)=>assert.ok(Math.abs(a-b)<t,`${a} != ${b}`);
class Node {constructor(){this.listeners={};this.attrs={};this.classList={add(){},remove(){}};this.checked=false;}querySelector(s){return this.nodes??=new Map(),this.nodes.has(s)||this.nodes.set(s,new Node()),this.nodes.get(s);}querySelectorAll(){return [];}addEventListener(k,f){this.listeners[k]=f;}setAttribute(k,v){this.attrs[k]=v;}getBoundingClientRect(){return {left:0,width:440};}}
globalThis.localStorage={getItem:()=>null,setItem(){}};
const host=new Node(),I=[[0,0,0],[0,0,0],[0,0,.001]],links=Array.from({length:7},()=>({defaultMass:.1,com:[.1,0,0],unitMassInertia:I})),joints=Array.from({length:8},(_,i)=>({pivot:[i*10,0,0],axis:[0,0,1],gain:1,motor:i-1})),rows=Array.from({length:61},(_,i)=>Array(7).fill(i*10));
let profile={rows:{R:{original:rows,edited:rows},L:{original:rows,edited:rows}},rate:1,curve:null,delays:{R:1,L:0},config:{resolution:4096,R:{zero:Array(7).fill(0),joints},L:{zero:Array(7).fill(0),joints}}};
let seek,done;const completion=new Promise(r=>done=r);const panel=createLoadPanel(host,{shapes:{links},getInputs:()=>profile,onSeek:(f,meta)=>seek={f,meta},onResults:r=>{if(r)done(r);}});
panel.invalidate();const result=await completion;
near(result.R.edited.duration,61/30+1);near(result.L.edited.duration,result.R.edited.duration);near(result.R.original.duration,result.R.edited.duration);near(result.R.original.baseDuration,61/30);near(result.R.edited.delaySeconds,1);near(result.L.edited.delaySeconds,0);
// Flat source-frame holds do not make time-based torque lookup ambiguous.
const t=1.5,a=result.R.edited,idx=a.times.findIndex(v=>v>=t),lo=idx-1,p=(t-a.times[lo])/(a.times[idx]-a.times[lo]);panel.currentAtTime('R',false,t).forEach((v,j)=>near(v,a.total[lo][j]*(1-p)+a.total[idx][j]*p));assert.equal(panel.heatAtTime('R',false,t).length,7);
panel.updateCursor({originalFrame:0,editedFrame:0,editedTime:.5});const graph=host.querySelector('[data-load="graph"]'),cursor=graph.querySelector('[data-cursor="edited"]');near(cursor.attrs.x1,40+.5/a.duration*386);near(graph.querySelector('[data-cursor="original"]').attrs.x1,cursor.attrs.x1);
// Seek reports the shared elapsed time as well as selected arm's source frame.
graph.listeners.pointerdown({clientX:40+.5/a.duration*386,shiftKey:false});near(seek.meta.time,.5);assert.equal(seek.meta.original,false);near(seek.f,0);
graph.listeners.pointerdown({clientX:40+1.2/a.duration*386,shiftKey:true});near(seek.meta.time,1.2);assert.equal(seek.meta.original,true);near(seek.f,36);
console.log('Load panel delay integration: shared edited duration, original clock, time lookup/heat, hold cursor and seek metadata passed.');

// Independent per-arm clocks: edited arms share the longest actual end time,
// while both original arms remain the untouched1x reference.
const points=y=>[0,1/6,1/3,.5,2/3,5/6,1].map(x=>({x,y}));
profile={...profile,rate:1,curves:{R:{points:points(1),enabled:true,rate:2},L:{points:points(1),enabled:true,rate:.5}},delays:{R:0,L:.3}};
const independentReady=new Promise(r=>done=r);panel.invalidate();const independent=await independentReady,T=61/30;
near(independent.R.original.baseDuration,T);near(independent.L.original.baseDuration,T);near(independent.R.original.duration,T/.5+.3);near(independent.L.original.duration,T/.5+.3);near(independent.R.edited.baseDuration,T/2);near(independent.L.edited.baseDuration,T/.5);near(independent.R.edited.duration,T/.5+.3);near(independent.L.edited.duration,T/.5+.3);
for(const side of ['R','L']){const a=independent[side].edited,rate=side==='R'?2:.5,delay=side==='R'?0:.3;for(let i=0;i<a.times.length;i++){const frame=Math.max(0,Math.min(60,(a.times[i]-delay)*30*rate));near(a.sourceFrames[i],frame);near(a.q[i][0],frame*10*2*Math.PI/4096);}}
// Independent Bezier multipliers and rate multiply exactly once.
profile.curves={R:{points:points(2),enabled:true,rate:2},L:{points:points(.5),enabled:true,rate:.5}};const warpedReady=new Promise(r=>done=r);panel.invalidate();const warped=await warpedReady;near(warped.R.edited.baseDuration,T/4);near(warped.L.edited.baseDuration,T*4);near(warped.R.edited.duration,T*4+.3);near(warped.L.edited.duration,T*4+.3);near(warped.R.original.baseDuration,T);near(warped.R.original.duration,T*4+.3);
console.log('Independent load clocks: R2x/L0.5x plus left0.3s delay, common end, unchanged1x originals, exact row sampling and separate Bezier multipliers passed.');

// Finished originals remain physically static while a slow edited side continues.
for(const side of ['R','L']){const a=warped[side].original;for(let i=0;i<a.times.length;i++){near(a.sourceFrames[i],Math.min(60,a.times[i]*30));if(a.times[i]>T+1e-8){near(a.qd[i][0],0);near(a.qdd[i][0],0);a.dynamic[i].forEach(v=>near(v,0));a.total[i].forEach((v,j)=>near(v,a.gravity[i][j]));}}near(a.duration,warped[side].edited.duration);}
// And fast edited arms hold through the original1x comparison end.
profile={...profile,curves:{R:{points:points(1),enabled:true,rate:2},L:{points:points(1),enabled:true,rate:3}},delays:{R:0,L:0}};const fastReady=new Promise(r=>done=r);panel.invalidate();const fast=await fastReady;near(fast.R.edited.duration,T);near(fast.R.edited.baseDuration,T/2);near(fast.L.edited.duration,T);near(fast.L.edited.baseDuration,T/3);for(const side of ['R','L']){const a=fast[side].edited;for(let i=0;i<a.times.length;i++)if(a.times[i]>a.baseDuration+1e-8){a.dynamic[i].forEach(v=>near(v,0));a.total[i].forEach((v,j)=>near(v,a.gravity[i][j]));}}
console.log('Comparison holds: original1x row clock retained with final gravity-only holds, fast edited arms held to original end, common stats duration passed.');
