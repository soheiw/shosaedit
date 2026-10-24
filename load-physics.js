/** SI-unit rigid-body load estimate. joints include a fixed base at index 0;
 * pivots are native CAD mm; link COMs are metres relative to their joint pivot,
 * in the CAD axes at zero angle. Inertias are about the COM, kg m², same axes.
 * q is physical joint rotation in radians, not motor counts. Gravity is +Y.
 * Mirroring the entire chain in X leaves joint-coordinate torque invariant
 * under +Y gravity: use each side's actual axes, then no mirror is necessary.
 * This estimates rigid-body torque, excluding friction, cables and gearing.
 */
import {timeMap} from './speed-curve.js';
const add=(a,b)=>a.map((v,i)=>v+b[i]), sub=(a,b)=>a.map((v,i)=>v-b[i]);
const mul=(a,s)=>a.map(v=>v*s), dot=(a,b)=>a.reduce((s,v,i)=>s+v*b[i],0);
const cross=(a,b)=>[a[1]*b[2]-a[2]*b[1],a[2]*b[0]-a[0]*b[2],a[0]*b[1]-a[1]*b[0]];
const eye=()=>[[1,0,0],[0,1,0],[0,0,1]], zero=()=>[0,0,0];
const mv=(A,v)=>A.map(r=>dot(r,v)), tr=A=>A[0].map((_,i)=>A.map(r=>r[i]));
const mm=(A,B)=>{const T=tr(B);return A.map(r=>T.map(c=>dot(r,c)));};
function vector(v,name){if(!Array.isArray(v)||v.length!==3||!v.every(Number.isFinite))throw Error(`${name}: finite 3-vector required`);return v;}
function nonnegative(v,name){if(!Number.isFinite(v)||v<0)throw Error(`${name}: finite nonnegative value required`);return v;}
function rotation(a,q){const [x,y,z]=a,c=Math.cos(q),s=Math.sin(q),d=1-c;return [[c+x*x*d,x*y*d-z*s,x*z*d+y*s],[y*x*d+z*s,c+y*y*d,y*z*d-x*s],[z*x*d-y*s,z*y*d+x*s,c+z*z*d]];}
function validate({joints,links,gravity,payload}){
 if(!Array.isArray(joints)||joints.length<2||!Array.isArray(links)||links.length!==joints.length-1)throw Error('One link per non-base joint required');
 vector(gravity,'gravity');for(const j of joints){vector(j.pivot,'pivot');vector(j.axis,'axis');if(Math.hypot(...j.axis)<1e-10)throw Error('Nonzero joint axis required');}
 for(const l of links){nonnegative(l.mass,'mass');vector(l.com,'COM');if(!Array.isArray(l.inertia)||l.inertia.length!==3)throw Error('COM inertia matrix required');l.inertia.forEach(r=>vector(r,'inertia'));for(let i=0;i<3;i++){nonnegative(l.inertia[i][i],'inertia diagonal');for(let j=0;j<3;j++)if(Math.abs(l.inertia[i][j]-l.inertia[j][i])>1e-9)throw Error('Symmetric inertia required');}for(let i=0;i<3;i++)for(let j=i+1;j<3;j++)if(l.inertia[i][i]*l.inertia[j][j]-l.inertia[i][j]**2< -1e-12)throw Error('Nonnegative inertia required');const I=l.inertia,det=I[0][0]*(I[1][1]*I[2][2]-I[1][2]*I[2][1])-I[0][1]*(I[1][0]*I[2][2]-I[1][2]*I[2][0])+I[0][2]*(I[1][0]*I[2][1]-I[1][1]*I[2][0]);if(det< -1e-12)throw Error('Nonnegative inertia required');}
 if(payload){nonnegative(payload.mass,'payload mass');vector(payload.com,'payload COM');}
}
function compute(joints,links,q,qd,qdd,gravity,payload){
 let A=eye(),w=zero(),alpha=zero(),acc=zero();const bodies=[];
 for(let i=0;i<links.length;i++){
  const joint=joints[i+1],r=mv(A,mul(sub(joint.pivot,joints[i].pivot),.001));
  acc=add(acc,add(cross(alpha,r),cross(w,cross(w,r))));
  const axis=mv(A,mul(joint.axis,1/Math.hypot(...joint.axis))),v=mul(axis,qd[i]);
  alpha=add(alpha,add(mul(axis,qdd[i]),cross(w,v)));w=add(w,v);A=mm(A,rotation(mul(joint.axis,1/Math.hypot(...joint.axis)),q[i]));
  const link=links[i],c=mv(A,link.com),ac=add(acc,add(cross(alpha,c),cross(w,cross(w,c))));
  const I=mm(mm(A,link.inertia),tr(A)),F=mul(sub(ac,gravity),link.mass),N=add(add(mv(I,alpha),cross(w,mv(I,w))),cross(c,F));
  if(i===links.length-1&&payload&&payload.mass){const p=mv(A,payload.com),pa=add(acc,add(cross(alpha,p),cross(w,cross(w,p)))),pf=mul(sub(pa,gravity),payload.mass);bodies.push({axis,r,F:add(F,pf),N:add(N,cross(p,pf))});}else bodies.push({axis,r,F,N});
 }
 let F=zero(),N=zero();const torques=Array(links.length);
 for(let i=bodies.length-1;i>=0;i--){const b=bodies[i];N=add(b.N,add(N,i+1<bodies.length?cross(bodies[i+1].r,F):zero()));F=add(b.F,F);torques[i]=dot(b.axis,N);}
 return torques;
}
export function inverseDynamics({joints,links,q,qd,qdd,gravity=[0,9.80665,0],payload=null}){
 validate({joints,links,gravity,payload});const n=links.length;for(const [name,a] of Object.entries({q,qd,qdd}))if(!Array.isArray(a)||a.length!==n||!a.every(Number.isFinite))throw Error(`${name}: finite joint values required`);
 const total=compute(joints,links,q,qd,qdd,gravity,payload),g=compute(joints,links,q,Array(n).fill(0),Array(n).fill(0),gravity,payload);return {total,gravity:g,dynamic:total.map((v,i)=>v-g[i])};
}
function solve(A,b){A=A.map((r,i)=>[...r,b[i]]);for(let c=0;c<b.length;c++){let p=c;for(let i=c+1;i<b.length;i++)if(Math.abs(A[i][c])>Math.abs(A[p][c]))p=i;[A[c],A[p]]=[A[p],A[c]];const d=A[c][c];if(Math.abs(d)<1e-14)throw Error('Derivative fit is singular');for(let j=c;j<=b.length;j++)A[c][j]/=d;for(let i=0;i<b.length;i++)if(i!==c){const m=A[i][c];for(let j=c;j<=b.length;j++)A[i][j]-=m*A[c][j];}}return A.map(r=>r[b.length]);}
/** Local cubic fit over up to 7 samples, one-sided at boundaries. No angle
 * wrapping: preserving multi-turn motion avoids fictitious discontinuities. */
export function derivatives(q,dt){
 if(!Number.isFinite(dt)||dt<=0)throw Error('Positive sample interval required');if(!q.length)return {qd:[],qdd:[]};const n=q.length,m=q[0].length,qd=q.map(()=>Array(m).fill(0)),qdd=q.map(()=>Array(m).fill(0));if(n===1)return {qd,qdd};
 const width=Math.min(7,n),degree=Math.min(3,width-1);
 for(let i=0;i<n;i++){const start=Math.max(0,Math.min(n-width,i-Math.floor(width/2))),xs=Array.from({length:width},(_,j)=>start+j-i),A=Array.from({length:degree+1},(_,a)=>Array.from({length:degree+1},(_,b)=>xs.reduce((s,x)=>s+x**(a+b),0)));
  for(let k=0;k<m;k++){const b=Array.from({length:degree+1},(_,a)=>xs.reduce((s,x,j)=>s+x**a*(q[start+j][k]-q[i][k]),0)),c=solve(A,b);qd[i][k]=c[1]/dt;qdd[i][k]=degree>=2?2*c[2]/dt**2:0;}}
 return {qd,qdd};
}
/** rows may contain floating point filtered counts. All time metrics refer to
 * actual playback seconds, including global rate and optional Bezier warp.
 * Like the preview/export clock, N frames span N/fps seconds. The final sample
 * is held for its last frame interval. fullCount sets the shared playback
 * clock for unequal R/L recordings; shorter sides hold their final sample.
 * delaySeconds adds a first-pose hold after the speed/rate mapping. Optional
 * durationSeconds shares a clock ending after every delayed arm has finished.
 * Loop seams are intentionally excluded. */
export function analyzeMotion({rows,joints,zero:neutral,resolution=4096,links,fps=30,rate=1,curve=null,sampleHz=30,fullCount=rows?.length,gravity=[0,9.80665,0],payload=null,delaySeconds=0,durationSeconds}){
 validate({joints,links,gravity,payload});for(const [name,v] of Object.entries({resolution,fps,rate,sampleHz}))if(!Number.isFinite(v)||v<=0)throw Error(`Positive ${name} required`);
 if(!Array.isArray(rows)||!rows.length||!Array.isArray(neutral)||!neutral.every(Number.isFinite)||rows.some(r=>!Array.isArray(r)||r.length!==neutral.length||!r.every(Number.isFinite)))throw Error('Finite recording rows and neutral counts required');
 if(!Number.isInteger(fullCount)||fullCount<rows.length)throw Error('Full preview frame count must cover recording rows');
 for(const j of joints.slice(1))if(!Number.isInteger(j.motor)||j.motor< -1||j.motor>=neutral.length||!Number.isFinite(j.gain))throw Error('Invalid motor mapping');
 let map=null;if(curve&&curve.enabled!==false){const p=curve.points;if(!Array.isArray(p)||p.length!==7||p.some((v,i)=>!Number.isFinite(v.x)||!Number.isFinite(v.y)||v.y<=0||v.x<0||v.x>1||(i&&v.x<=p[i-1].x))||p[0].x!==0||p[6].x!==1)throw Error('Invalid positive speed curve');map=timeMap(p,true);}
 nonnegative(delaySeconds,'delaySeconds');
 const sourceDuration=fullCount/fps,baseDuration=sourceDuration*(map?.total??1)/rate;
 if(durationSeconds!==undefined&&(!Number.isFinite(durationSeconds)||durationSeconds<baseDuration+delaySeconds-1e-9))throw Error('Shared duration must cover the delayed playback');
 const duration=durationSeconds??baseDuration+delaySeconds,intervals=duration?Math.max(1,Math.min(19999,Math.ceil(duration*sampleHz))):0,dt=intervals?duration/intervals:1/sampleHz,times=[],sourceFrames=[],q=[];
 for(let k=0;k<=intervals;k++){const t=k*dt,localTime=Math.max(0,Math.min(baseDuration,t-delaySeconds)),frame=intervals?Math.min(rows.length-1,(map?map.position(localTime*rate/sourceDuration):localTime*rate/sourceDuration)*fullCount):0,i=Math.min(rows.length-1,Math.floor(frame)),f=frame-i;times.push(t);sourceFrames.push(frame);q.push(joints.slice(1).map(j=>{if(j.motor<0)return 0;const value=rows[i][j.motor]*(1-f)+rows[Math.min(rows.length-1,i+1)][j.motor]*f;return (value-neutral[j.motor])*2*Math.PI/resolution*j.gain;}));}
 const {qd,qdd}=derivatives(q,dt),total=[],g=[],dynamic=[];
 // Delays are seconds on the final playback clock, after rate/Bezier. Explicit
 // holds have exactly zero speed/acceleration; cubic fits near a boundary must
 // not invent anticipatory motion in the initial or extended final hold.
 if(delaySeconds>0||duration>baseDuration+1e-10)for(let i=0;i<times.length;i++)if(times[i]<delaySeconds-1e-10||times[i]>delaySeconds+baseDuration+1e-10){qd[i].fill(0);qdd[i].fill(0);}
 for(let i=0;i<q.length;i++){const all=compute(joints,links,q[i],qd[i],qdd[i],gravity,payload),gg=compute(joints,links,q[i],Array(links.length).fill(0),Array(links.length).fill(0),gravity,payload);total.push(all);g.push(gg);dynamic.push(all.map((v,j)=>v-gg[j]));}
 const stats=links.map((_,j)=>{let effort=0;for(let i=1;i<times.length;i++)effort+=(total[i-1][j]**2+total[i][j]**2)*.5*dt;return {peak:Math.max(...total.map(r=>Math.abs(r[j]))),rms:duration?Math.sqrt(effort/duration):Math.abs(total[0][j]),effort};});
 return {duration,baseDuration,delaySeconds,times,sourceFrames,q,qd,qdd,total,gravity:g,dynamic,stats,sampleHz:1/dt,derivativeWindow:Math.min(7,q.length),derivativeMethod:'local cubic fit; up to 7 samples'};
}
