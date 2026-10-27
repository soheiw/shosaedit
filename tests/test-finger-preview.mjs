import assert from 'node:assert/strict';
import fs from 'node:fs';
import * as THREE from '../vendor/three.module.js';
import {solveFourBar,createFingerRig} from '../finger-rig.js';
import {fingerClosures,defaultFingerSettings as settings} from '../finger-drive.js';
import {loadDisplayModel} from '../model-loader.js';
const def=JSON.parse(fs.readFileSync(new URL('../finger-rig-definition.json',import.meta.url))),pivot=[-26.2069,-126.1417,1.1525];
assert.equal(def.R.chains.length,4);
let peakError=0;
for(const chain of def.R.chains){
 let previous;
 for(let degrees=0;degrees<=chain.maxDriverDegrees;degrees+=.1){
  const solved=solveFourBar(chain.fourBar,degrees*Math.PI/180);peakError=Math.max(peakError,solved.closureError);assert.ok(solved.closureError<1e-7);
  const C=new THREE.Vector3(...chain.fourBar.C),D=new THREE.Vector3(...chain.fourBar.D);
  const c1=C.clone().applyMatrix4(solved.outer),c2=C.clone().applyMatrix4(solved.tip),d1=D.clone().applyMatrix4(solved.inner),d2=D.clone().applyMatrix4(solved.tip);
  assert.ok(c1.distanceTo(c2)<1e-7);assert.ok(d1.distanceTo(d2)<1e-7,'rigid linkage endpoints remain connected');
  if(previous)for(let k=0;k<16;k++)assert.ok(Math.abs(solved.tip.elements[k]-previous.elements[k])<1,'no branch jumps');
  previous=solved.tip;
 }
}
const recording=JSON.parse(fs.readFileSync(new URL('../motion-data/markb.motion.json',import.meta.url))),before=JSON.stringify(recording);
const model=await loadDisplayModel('simple',async()=>{throw Error('public display must work without private files');});
const meshes=model.model.bodies.map(body=>{const mesh=new THREE.Object3D();mesh.userData={body,side:body.side};return mesh;});
const rigs={};for(const side of ['R','L']){rigs[side]=createFingerRig(side,meshes,pivot,def);assert.equal(rigs[side].targetCount,side==='R'?19:3);}
let poses=0;
for(let i=0;i<recording.R.length;i++)for(const side of ['R','L']){
 rigs[side].apply(recording[side][i],settings);for(const m of meshes){m.updateMatrix();assert.ok(m.matrix.elements.every(Number.isFinite));}poses++;
}
assert.equal(JSON.stringify(recording),before,'display must leave source counts immutable');
const getRight=()=>meshes.filter(m=>m.userData.side==='R').map(m=>[m.position.toArray(),m.quaternion.toArray()]);
rigs.R.apply(recording.R[0],settings);const open=JSON.stringify(getRight());rigs.R.apply(recording.R[135],settings);assert.notEqual(JSON.stringify(getRight()),open,'right fingers visibly articulate');
rigs.R.apply(recording.R[135],{...settings,enabled:false});for(const mesh of meshes.filter(m=>m.userData.side==='R'&&m.userData.body.group===7)){mesh.updateMatrix();if(mesh.position.length()>0)assert.ok(mesh.position.distanceTo(new THREE.Vector3(...pivot.map(x=>-x)))<1e-7);}
assert.deepEqual(fingerClosures('L',[0,0,0,0,0,0,0,494]),[0]);assert.deepEqual(fingerClosures('L',[0,0,0,0,0,0,0,2820]),[1]);
const left=()=>meshes.filter(m=>m.userData.side==='L').map(m=>[m.position.toArray(),m.quaternion.toArray()]);rigs.L.apply(recording.L[570],settings);const leftOpen=JSON.stringify(left());rigs.L.apply(recording.L[750],settings);assert.notEqual(JSON.stringify(left()),leftOpen);
console.log(`Finger preview: four connected CAD four-bars, public right19/left3 moving meshes, ${poses} immutable recording poses, max hinge error ${peakError}; left low=open/high=closed; provisional tendon response, no physical calibration.`);
