import * as THREE from './vendor/three.module.js';
import {simplePrimitives} from './simple-primitives.js';
export const simplePivots=[[-13.0614,-559.9965,0],[-13.0614,-559.9965,-14],[-18.65,-559.9965,36.503],[-13.2884,-480,36.503],[-15.98,-357.8448,36.5615],[-13.207,-244.6,1.1525],[-2.2069,-126.1417,2.65],[-26.2069,-126.1417,1.1525]];
export function createSimpleModel(){
 const bodies=[],geometries=[];
 function add(group,geometry,role='part'){
  if(!geometry.index)geometry.setIndex(Array.from({length:geometry.attributes.position.count},(_,i)=>i));
  const box=new THREE.Box3().setFromBufferAttribute(geometry.attributes.position),i=bodies.length;
  bodies.push({id:`simple-${i}`,name:`Simple part ${i+1}`,component:`link_${group}`,group,solid:true,source:'simplified',role,min:box.min.toArray(),max:box.max.toArray(),vertexCount:geometry.attributes.position.count,indexCount:geometry.index.count});geometries.push(geometry);
 }
 for(const part of simplePrimitives){
  const {group,shape,center,size,basis,axis}=part;let geometry;
  if(shape==='cylinder'){
   const other=[0,1,2].filter(i=>i!==axis),radius=(size[other[0]]+size[other[1]])/4;
   geometry=new THREE.CylinderGeometry(radius,radius,size[axis],10);
   geometry.applyQuaternion(new THREE.Quaternion().setFromUnitVectors(new THREE.Vector3(0,1,0),new THREE.Vector3(basis[axis],basis[3+axis],basis[6+axis]).normalize()));geometry.translate(...center);
  }else{
   geometry=new THREE.BoxGeometry(...size);geometry.applyMatrix4(new THREE.Matrix4().set(basis[0],basis[1],basis[2],center[0],basis[3],basis[4],basis[5],center[1],basis[6],basis[7],basis[8],center[2],0,0,0,1));
  }
  add(group,geometry);
 }
 add(7,new THREE.BoxGeometry(55,60,1).translate(-5,-65,27.5),'palm-marker');
 add(7,new THREE.BoxGeometry(55,60,1).translate(-5,-65,-28),'back-marker');
 for(let group=1;group<=7;group++)add(group,new THREE.SphereGeometry(group>=6?8:11,10,6).translate(...simplePivots[group]),'joint');
 let offset=0;for(const body of bodies){body.positionOffset=offset;offset+=body.vertexCount*3*4;body.indexOffset=offset;offset+=body.indexCount*4;}
 const bin=new ArrayBuffer(offset);bodies.forEach((body,i)=>{new Float32Array(bin,body.positionOffset,body.vertexCount*3).set(geometries[i].attributes.position.array);new Uint32Array(bin,body.indexOffset,body.indexCount).set(geometries[i].index.array);geometries[i].dispose();});
 return {model:{name:'ShosaEdit simple primitives',kind:'simple',units:'mm',bodies,fingersFixed:true},bin};
}
