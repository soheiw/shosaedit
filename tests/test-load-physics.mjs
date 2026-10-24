import assert from 'node:assert/strict';
import {inverseDynamics,analyzeMotion,derivatives} from '../load-physics.js';
const near=(a,b,tol=1e-7)=>assert.ok(Math.abs(a-b)<tol,`${a} != ${b}`),z=[0,0,0],I0=[[0,0,0],[0,0,0],[0,0,0]],Izz=[[0,0,0],[0,0,0],[0,0,.2]];
const base={pivot:z,axis:[0,0,1],motor:-1,gain:1},joint={pivot:z,axis:[0,0,1],motor:0,gain:1};
const args={joints:[base,joint],links:[{mass:1,com:[.5,0,0],inertia:I0}],q:[0],qd:[0],qdd:[0]};
near(inverseDynamics(args).total[0],-4.903325);near(inverseDynamics({...args,q:[Math.PI/2]}).total[0],0);
// Both centre-of-mass translation and rotational inertia contribute to acceleration.
near(inverseDynamics({...args,links:[{mass:1,com:[.5,0,0],inertia:Izz}],qdd:[2],gravity:z}).total[0],.9);
// Distal force propagates to its own joint and the shoulder.
const two={joints:[base,joint,{...joint,pivot:[500,0,0],motor:1}],links:[{mass:0,com:z,inertia:I0},{mass:1,com:[.5,0,0],inertia:I0}],q:[0,0],qd:[0,0],qdd:[0,0]};
const t=inverseDynamics(two);near(t.total[0],-9.80665);near(t.total[1],-4.903325);
const payload=inverseDynamics({...args,links:[{mass:0,com:z,inertia:I0}],payload:{mass:1,com:[.5,0,0]}});near(payload.total[0],-4.903325);
// Left reflection: polar positions reverse X, axial axes reverse Y/Z.
const reflV=v=>[-v[0],v[1],v[2]],reflA=v=>[v[0],-v[1],-v[2]];
const mirrored={...two,joints:two.joints.map(j=>({...j,pivot:reflV(j.pivot),axis:reflA(j.axis)})),links:two.links.map(l=>({...l,com:reflV(l.com)}))};
mirrored.q=[.4,-.2];mirrored.qd=[.3,.2];mirrored.qdd=[.2,-.5];const normal={...two,q:mirrored.q,qd:mirrored.qd,qdd:mirrored.qdd};inverseDynamics(normal).total.forEach((v,i)=>near(v,inverseDynamics(mirrored).total[i]));
// Two moving planar links: closed-form mass matrix and Coriolis terms.
const qa=[.7,-.8],va=[.9,-.6],aa=[-.3,.5],c=Math.cos(qa[1]),ss=Math.sin(qa[1]);
const analytic={...two,links:[{mass:1,com:[.5,0,0],inertia:[[0,0,0],[0,0,0],[0,0,.1]]},{mass:1,com:[.5,0,0],inertia:Izz}],q:qa,qd:va,qdd:aa};
const M11=.1+.2+.25+.25+.25+.5*c,M12=.2+.25+.25*c,M22=.2+.25;
const C1=-.25*ss*(2*va[0]*va[1]+va[1]**2),C2=.25*ss*va[0]**2;
const G1=-9.80665*(Math.cos(qa[0])+.5*Math.cos(qa[0]+qa[1])),G2=-9.80665*.5*Math.cos(qa[0]+qa[1]);
const ana=inverseDynamics(analytic);near(ana.total[0],M11*aa[0]+M12*aa[1]+C1+G1);near(ana.total[1],M12*aa[0]+M22*aa[1]+C2+G2);
const make=(rows,extra={})=>analyzeMotion({...args,zero:[0],rows,...extra});
const hold=make(Array.from({length:61},()=>[0])),slowhold=make(Array.from({length:61},()=>[0]),{rate:.5});near(slowhold.duration,hold.duration*2);near(slowhold.stats[0].effort,hold.stats[0].effort*2);near(slowhold.stats[0].peak,hold.stats[0].peak);
// Prescribed quadratic counts produce analytic acceleration, and speed² torque.
const rows=Array.from({length:61},(_,i)=>[.5*(i/30)**2*4096/(2*Math.PI)]);
const dyn=make(rows,{gravity:z}),dyn2=make(rows,{gravity:z,rate:2});near(dyn.total[20][0],.25);near(dyn2.total[10][0],1,.003);// Boundary derivatives include the preview clock’s final held frame.
near(dyn2.total[15][0],4*dyn.total[30][0],.003);
const speedExact=inverseDynamics({...analytic,gravity:z}),speedExact2=inverseDynamics({...analytic,gravity:z,qd:va.map(v=>v*2),qdd:aa.map(v=>v*4)});speedExact.total.forEach((v,i)=>near(speedExact2.total[i],v*4));
const warp=make(rows,{curve:{enabled:true,points:[0,1/6,1/3,.5,2/3,5/6,1].map(x=>({x,y:1+x}))}});assert.ok(warp.duration<61/30);assert.ok(warp.total.flat().every(Number.isFinite));near(warp.sourceFrames.at(-1),60);
const split=inverseDynamics({...normal,qdd:[.7,-.4]});split.total.forEach((v,i)=>near(v,split.gravity[i]+split.dynamic[i]));
for(const n of [1,2,3,4]){const s=make(Array.from({length:n},(_,i)=>[i]));assert.ok(s.total.flat().every(Number.isFinite));assert.equal(s.duration,n/30);}
// Unequal R/L clips share the full preview clock and clamp the short side.
const short=make([[0],[100],[200]],{fullCount:9});near(short.duration,9/30);near(short.sourceFrames.at(-1),2);assert.ok(short.sourceFrames.every(f=>f<=2));assert.ok(short.q.slice(-4).every(q=>q[0]===short.q.at(-1)[0]));
const shortWarp=make([[0],[100],[200]],{fullCount:9,curve:{enabled:true,points:[0,1/6,1/3,.5,2/3,5/6,1].map(x=>({x,y:2}))}});near(shortWarp.duration,.15);near(shortWarp.sourceFrames.at(-1),2);assert.throws(()=>make([[0],[1]],{fullCount:1}));
// Polynomial derivatives including endpoints; continuous > 1 turn has no wrapping.
const poly=Array.from({length:31},(_,i)=>[8+(i/30)**2]);const d=derivatives(poly,1/30);d.qdd.forEach(r=>near(r[0],2));near(d.qd.at(-1)[0],2);
assert.throws(()=>inverseDynamics({...args,links:[{mass:NaN,com:z,inertia:I0}]}));assert.throws(()=>make([[0]],{rate:0}));assert.throws(()=>make([[0]],{links:[{mass:1,com:z,inertia:[[1,3,0],[3,1,0],[0,0,1]]}]}));
console.log('Load physics: analytic gravity, COM inertia, distal propagation, payload, mirror symmetry, speed² dynamics, hold effort, warp, short clips, no-wrap derivatives and invalid-input checks passed.');
