import * as THREE from './vendor/three.module.js';
import {fingerClosures} from './finger-drive.js';
const v=a=>new THREE.Vector3(...a),angle=(a,b,n)=>Math.atan2(n.dot(a.clone().cross(b)),a.dot(b));
const rot=(p,n,a)=>new THREE.Matrix4().makeTranslation(...p.toArray()).multiply(new THREE.Matrix4().makeRotationAxis(n,a)).multiply(new THREE.Matrix4().makeTranslation(...p.clone().negate().toArray()));
export function solveFourBar(def,q){
 const [A,B,C,D]=['A','B','C','D'].map(k=>v(def[k])),n=v(def.axis).normalize();
 const nextC=C.clone().applyMatrix4(rot(A,n,q));
 const restE=C.clone().sub(B),restDistance=restE.length();restE.normalize();
 const lengthBD=D.distanceTo(B),lengthCD=D.distanceTo(C);
 const signed= D.clone().sub(B).dot(n.clone().cross(restE));
 const e=nextC.clone().sub(B),distance=e.length();e.normalize();
 const x=(lengthBD**2-lengthCD**2+distance**2)/(2*distance),h2=lengthBD**2-x*x;
 if(!Number.isFinite(h2)||h2<-.001)throw Error('Four-bar closure outside geometric range');
 const nextD=B.clone().addScaledVector(e,x).addScaledVector(n.clone().cross(e),Math.sign(signed||1)*Math.sqrt(Math.max(0,h2)));
 const rB=angle(D.clone().sub(B),nextD.clone().sub(B),n),rTip=angle(D.clone().sub(C),nextD.clone().sub(nextC),n);
 const tip=new THREE.Matrix4().makeTranslation(...nextC.toArray()).multiply(new THREE.Matrix4().makeRotationAxis(n,rTip)).multiply(new THREE.Matrix4().makeTranslation(...C.clone().negate().toArray()));
 return {outer:rot(A,n,q),inner:rot(B,n,rB),tip,points:{C:nextC.toArray(),D:nextD.toArray()},closureError:Math.abs(nextD.distanceTo(B)-lengthBD)};
}
function matches(body,selector){
 const ids=[body.id,body.nativeId,body.publicHandId],names=[body.name];
 return ids.some(id=>selector.publicIds?.includes(id)||selector.privateIds?.includes(id))||names.some(name=>selector.privateNames?.includes(name));
}
export function createFingerRig(side,meshes,handPivot,definition){
 const targets=[];
 if(side==='R')for(const chain of definition.R.chains){
  for(const part of ['outer','inner','tip'])for(const mesh of meshes.filter(m=>m.userData.side===side&&m.userData.body.group===7&&matches(m.userData.body,chain.parts[part])))targets.push({mesh,chain,part});
 }else for(const joint of definition.L.moving){
  for(const mesh of meshes.filter(m=>m.userData.side===side&&m.userData.body.group===7&&matches(m.userData.body,joint)))targets.push({mesh,joint});
 }
 const normalizer=side==='L'?new THREE.Matrix4().set(1,0,0,0,0,1,0,0,0,0,-1,1.152505961149,0,0,0,1):new THREE.Matrix4();
 const inverse=normalizer.clone().invert(),offset=new THREE.Matrix4().makeTranslation(...handPivot.map(x=>-x));
 return {targetCount:targets.length,apply(row,settings,{cad=false,solo=-1}={}){
  const active=settings.enabled&&!cad&&(solo<0||solo>=7),closure=fingerClosures(side,row,settings),cache=new Map();
  for(const item of targets){
   let transform=new THREE.Matrix4();
   if(active){
    if(item.chain){
     const chain=item.chain,idx=chain.order;
     // Optional input isolation works for the finger columns too.
     const isolated=solo<0?row:row.map((x,i)=>i===solo?x:i===7?3906:i===8?-433:x);
     const amount=solo<0?closure[idx]:fingerClosures(side,isolated,settings)[idx];
     if(!cache.has(chain)){
      const requested=amount*chain.maxDriverDegrees*Math.PI/180;
      let solved;
      for(let attempt=0;attempt<12;attempt++){try{solved=solveFourBar(chain.fourBar,requested*(1-attempt/12));break;}catch{}}
      cache.set(chain,solved||solveFourBar(chain.fourBar,0));
     }
     transform=cache.get(chain)[item.part];
    }else{
     const j=item.joint,opening=1-Math.max(0,Math.min(1,closure[0]));
     transform=rot(v(j.pivot),v(j.axis).normalize(),(j.closedAngleDeg+opening*(j.openAngleDeg-j.closedAngleDeg))*Math.PI/180);
    }
   }
   offset.clone().multiply(normalizer).multiply(transform).multiply(inverse).decompose(item.mesh.position,item.mesh.quaternion,item.mesh.scale);
  }
 }};
}
