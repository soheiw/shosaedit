import assert from 'node:assert/strict';
import {analyzeMotion} from '../load-physics.js';
const near=(a,b,tol=1e-7)=>assert.ok(Math.abs(a-b)<tol,`${a} != ${b}`);
const base={pivot:[0,0,0],axis:[0,0,1],motor:-1,gain:1},joint={...base,motor:0};
const links=[{mass:1,com:[.5,0,0],inertia:[[0,0,0],[0,0,0],[0,0,.2]]}];
const args={joints:[base,joint],zero:[0],links,rows:Array.from({length:61},()=>[0])};
const normal=analyzeMotion(args),delayed=analyzeMotion({...args,delaySeconds:1,durationSeconds:normal.duration+2});
near(delayed.duration,normal.duration+2);near(delayed.baseDuration,normal.duration);near(delayed.delaySeconds,1);
// Constant position adds static load time, with no manufactured velocity or acceleration.
for(const r of delayed.qd)near(r[0],0);for(const r of delayed.qdd)near(r[0],0);
for(const r of delayed.dynamic)near(r[0],0);near(delayed.stats[0].rms,normal.stats[0].rms);near(delayed.stats[0].peak,normal.stats[0].peak);
near(delayed.stats[0].effort,normal.stats[0].effort*(delayed.duration/normal.duration));
for(let i=0;i<delayed.times.length;i++)if(delayed.times[i]<=1)near(delayed.sourceFrames[i],0);
near(delayed.sourceFrames.at(-1),60);
// Quadratic motion's interior torque/position is exactly shifted, rather than slowed.
const rows=Array.from({length:61},(_,i)=>[.5*(i/30)**2*4096/(2*Math.PI)]),move=analyzeMotion({...args,rows,gravity:[0,0,0]}),shift=analyzeMotion({...args,rows,gravity:[0,0,0],delaySeconds:1,durationSeconds:move.duration+2});
for(const i of [10,20,30,40]){near(shift.sourceFrames[i+30],move.sourceFrames[i]);near(shift.q[i+30][0],move.q[i][0]);near(shift.qdd[i+30][0],move.qdd[i][0]);near(shift.total[i+30][0],move.total[i][0]);}
for(let i=0;i<shift.times.length;i++)if(shift.times[i]<1-1e-8||shift.times[i]>1+move.duration+1e-8){near(shift.qd[i][0],0);near(shift.qdd[i][0],0);near(shift.dynamic[i][0],0);}
// The delay is final wall clock seconds, unaffected by global rate or Bezier speed.
const curve={enabled:true,points:[0,1/6,1/3,.5,2/3,5/6,1].map(x=>({x,y:2}))};
const fast=analyzeMotion({...args,rows,rate:2,curve,sampleHz:120}),fastDelayed=analyzeMotion({...args,rows,rate:2,curve,sampleHz:120,delaySeconds:.5});
near(fast.duration,args.rows.length/30/4);near(fastDelayed.duration,fast.duration+.5);
for(const i of [10,20,30,40]){near(fastDelayed.times[i+60]-fast.times[i],.5);near(fastDelayed.sourceFrames[i+60],fast.sourceFrames[i]);near(fastDelayed.total[i+60][0],fast.total[i][0],1e-6);}
// Both arms have one shared edited end even when only one is delayed.
const right=analyzeMotion({...args,rows,delaySeconds:0,durationSeconds:move.duration+1}),left=analyzeMotion({...args,rows,delaySeconds:1,durationSeconds:move.duration+1});near(right.duration,left.duration);near(right.sourceFrames.at(-1),60);near(left.sourceFrames.at(-1),60);
// Zero-delay compatibility remains byte-for-byte numeric compatible.
const explicitZero=analyzeMotion({...args,delaySeconds:0});assert.deepEqual(explicitZero.total,normal.total);assert.deepEqual(explicitZero.sourceFrames,normal.sourceFrames);
assert.throws(()=>analyzeMotion({...args,delaySeconds:-1}));assert.throws(()=>analyzeMotion({...args,delaySeconds:NaN}));assert.throws(()=>analyzeMotion({...args,delaySeconds:1,durationSeconds:normal.duration+.5}));assert.throws(()=>analyzeMotion({...args,durationSeconds:Infinity}));
console.log('Delayed load: exact after-warp clock, shared end, initial/tail holds, torque shift, constant-gravity RMS/effort, zero-delay compatibility and input validation passed.');
