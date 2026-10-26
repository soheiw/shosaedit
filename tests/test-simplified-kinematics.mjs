import {interpretedConfiguration} from '../recording-interpretation.js';
import {rightWristReference} from '../wrist-reference.js';
/** Regression baseline captured before replacing the private CAD mesh.
 * Runs the app's actual rig/pose functions headlessly with Three.js; the
 * reference chain below is deliberately frozen independently of app constants.
 * This is a numerical regression check, not a visual or hardware check.
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {createHash} from 'node:crypto';
import * as THREE from '../vendor/three.module.js';
import {exportRows} from '../export-motion.js';
import {createPlaybackClock} from '../arm-delay.js';
import {defaultPoints} from '../speed-curve.js';
import {loadDisplayModel} from '../model-loader.js';
import {createSimpleModel,simplePivots} from '../simple-model.js';

const root=new URL('../',import.meta.url),read=name=>fs.readFileSync(new URL(name,root),'utf8');
const motions=JSON.parse(read('motion-data/motions.json'));
const clips=[...Object.entries(motions.clips),...JSON.parse(read('motion-data/generated-motions.json')).map(e=>[e.id,JSON.parse(read('motion-data/'+e.file))])];
assert.equal(clips.length,23,'3 original, 17 authored and 3 additional recordings must be covered');
const legacyClips=clips.filter(([id])=>!id.startsWith('recorded-')).map(([id,c])=>[id,{...c,R:c.R.map(row=>row.map((v,i)=>v-(c.generation?.rightWristReference===3025&&i===5?1650:0)))}]);
const hash=value=>createHash('sha256').update(value).digest('hex');
assert.equal(hash(JSON.stringify(legacyClips.map(([id,c])=>[id,c.R,c.L]))),'47df1282f1718586f272f74606669980fea575248c7feb542aaef23c6b5acb37','recorded/generated joint data changed during geometry replacement');

const P=[[-13.0614,-559.9965,0],[-13.0614,-559.9965,-14],[-18.65,-559.9965,36.503],[-13.2884,-480,36.503],[-15.98,-357.8448,36.5615],[-13.207,-244.6,1.1525],[-2.2069,-126.1417,2.65],[-26.2069,-126.1417,1.1525]];
const A={R:[[0,1,0],[0,0,1],[-1,0,0],[0,1,0],[-1,0,0],[0,1,0],[0,0,1],[1,0,0]],L:[[0,1,0],[0,0,-1],[1,0,0],[0,1,0],[1,0,0],[0,1,0],[0,0,1],[-1,0,0]]};
const Z={R:[2535,2916,2034,2974,3611,3025,1890,3492,396],L:[2035,1112,2258,1166,1895,2003,2164,3213]};
const recordingReferences=JSON.parse(read('recording-references.json'));
for(const [id,c] of clips)motions.clips[id]=c;
const C={R:[2541,2947,1022,1892,1524,2017,1814,3891,405],L:[2034,1115,2079,1168,1905,1987,2268,2899]};
const source=read('app.js');
const declaration=name=>{const match=source.match(new RegExp(`const ${name}=([^;]+);`));assert.ok(match,`app ${name} declaration`);return `const ${name}=${match[1]};`;};
// Extract named top-level functions without executing the browser bootstrap.
const fn=name=>{const begin=source.indexOf(`function ${name}(`);assert.ok(begin>=0,`app ${name} function`);const rest=source.slice(begin),end=rest.indexOf('\nfunction ',1);return rest.slice(0,end<0?undefined:end);};
const state={clip:'1',rigs:{},meshes:[],side:'both',solo:-1,elapsed:0};
const nodes=new Map(),$=id=>{if(!nodes.has(id))nodes.set(id,{checked:id==='colors',textContent:''});return nodes.get(id);};
let rows;
// Tiny native-coordinate markers exercise the unchanged mesh attachment path.
const data=new ArrayBuffer(48),vertices=new Float32Array(data,0,9);vertices.set([1,2,3,2,2,3,1,3,3]);new Uint32Array(data,36,3).set([0,1,2]);
const fixture={bodies:P.map((_,group)=>({group,solid:true,positionOffset:0,vertexCount:3,indexOffset:36,indexCount:3}))};
const createRuntime=new Function('THREE','motions','model','state','scene','$','rowFor','interpretedConfiguration','recordingReferences',[
 `const rightWristReference=${rightWristReference};`,declaration('pivots'),declaration('parents'),declaration('axes'),declaration('palette'),
 fn('freshConfig'),'const config=freshConfig();',fn('activeConfiguration'),fn('makeRigs'),fn('rebuildRig'),fn('applyPose'),
 'return {config,makeRigs,rebuildRig,applyPose};'
].join('\n'));
const runtime=createRuntime(THREE,motions,fixture,state,new THREE.Scene(),$,side=>rows?.[side]??motions.clips['1'][side][0],interpretedConfiguration,recordingReferences);
runtime.makeRigs(data);
for(const side of ['R','L'])assert.deepEqual(runtime.config[side],{zero:Z[side],joints:P.map((pivot,g)=>({pivot,axis:A[side][g],motor:g-1,gain:1}))},`${side}: pivot/axis/motor/gain/zero baseline`);

let matrices=0,maxError=0;
const nearMatrix=(actual,expected,label)=>{for(let k=0;k<16;k++){const error=Math.abs(actual.elements[k]-expected.elements[k]);maxError=Math.max(maxError,error);assert.ok(error<2e-9,`${label}, element ${k}: ${error}`);}matrices++;};
function reference(side,row,config=null){
 const chain=[];let parent=new THREE.Matrix4().compose(new THREE.Vector3(side==='R'?180:-180,0,0),new THREE.Quaternion(),new THREE.Vector3(side==='R'?1:-1,1,1));
 for(let g=0;g<8;g++){
  const p=config?.joints?.[g]?.pivot??P[g],previous=g?(config?.joints?.[g-1]?.pivot??P[g-1]):p;
  const axis=config?.joints?.[g]?.axis??A[side][g],motor=config?.joints?.[g]?.motor??g-1,gain=config?.joints?.[g]?.gain??1,zero=config?.zero??Z[side];
  const angle=motor<0?0:(row[motor]-zero[motor])*Math.PI/2048*gain;
  parent=parent.clone().multiply(new THREE.Matrix4().compose(new THREE.Vector3(...p.map((v,k)=>v-previous[k])),new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(...axis).normalize(),angle),new THREE.Vector3(1,1,1)));
  chain.push(parent);
 }
 return chain;
}
function checkPose(label,targetRuntime=runtime,targetState=state){
 targetRuntime.applyPose();
 for(const side of ['R','L']){
  const rig=targetState.rigs[side];rig.root.updateMatrixWorld(true);const expected=reference(side,rows[side],{zero:targetState.clip==='recorded-markc'?C[side]:Z[side]});
  for(let g=0;g<8;g++)nearMatrix(rig.groups[g].matrixWorld,expected[g],`${label} ${side} link ${g}`);
  // Full matrix comparison includes handedness and all three hand basis axes,
  // not just a palm normal; neither rotation around that normal nor mirror can hide.
  for(const mesh of targetState.meshes.filter(m=>m.userData.side===side)){
   const g=mesh.userData.group;
   nearMatrix(mesh.matrixWorld,expected[g].clone().multiply(new THREE.Matrix4().makeTranslation(...P[g].map(v=>-v))),`${label} ${side} mesh ${g}`);
  }
 }
}
let poses=0;
for(const [id,clip]of clips){
 state.clip=id;
 const count=Math.max(clip.R.length,clip.L.length);
 for(let frame=0;frame<count;frame++){
  rows=Object.fromEntries(['R','L'].map(s=>[s,clip[s][Math.min(frame,clip[s].length-1)]]));checkPose(`${id}:${frame}`);poses++;
 }
}

// Exercise the actual public simplified geometry, not only marker triangles.
assert.deepEqual(simplePivots,P,'simplified model uses the same native anchors');
const simple=await loadDisplayModel('simple',async()=>{throw Error('simple display must not fetch private CAD');});
assert.equal(simple.model.kind,'simple');
assert.equal(simple.model.fingersFixed,true);
assert.ok(simple.model.bodies.filter(b=>!['public-hand','public-left-hand'].includes(b.source)).reduce((n,b)=>n+b.indexCount/3,0)<5000,'simplified display must remain lightweight primitive geometry');
assert.deepEqual([...new Set(simple.model.bodies.map(b=>b.group))].sort(),[0,1,2,3,4,5,6,7]);
for(const body of simple.model.bodies){
 assert.ok(['simplified','public-hand','public-left-hand'].includes(body.source));
 if(['public-hand','public-left-hand'].includes(body.source))assert.equal(body.group,7,'only wrist-distal CAD is publicly included');
 const positions=new Float32Array(simple.bin,body.positionOffset,body.vertexCount*3),indices=new Uint32Array(simple.bin,body.indexOffset,body.indexCount);
 assert.ok(positions.every(Number.isFinite));
 assert.ok(indices.every(i=>i<body.vertexCount));
 assert.ok(body.vertexCount>0&&body.indexCount>0);
 if(['hand','finger','thumb','palm-marker','back-marker'].includes(body.role))assert.equal(body.group,7,'hand/finger primitives must remain fixed to link 7');
}
const simpleState={clip:'1',rigs:{},meshes:[],side:'both',solo:-1,elapsed:0};
const simpleRuntime=createRuntime(THREE,motions,simple.model,simpleState,new THREE.Scene(),$,side=>rows?.[side]??motions.clips['1'][side][0],interpretedConfiguration,recordingReferences);
simpleRuntime.makeRigs(simple.bin);
assert.equal(simpleState.meshes.length,simple.model.bodies.reduce((n,b)=>n+(b.side?1:2),0),'side-specific CAD is attached to its own arm');
if(simple.model.leftHandActual){assert.ok(simpleState.meshes.filter(m=>m.userData.side==='L'&&m.userData.group===7).every(m=>m.userData.body.side==='L'));assert.ok(simpleState.meshes.filter(m=>m.userData.side==='R'&&m.userData.group===7).every(m=>m.userData.body.side==='R'));}
for(const [id,clip]of clips)for(let frame=0;frame<Math.max(clip.R.length,clip.L.length);frame++){
 simpleState.clip=id;
 rows=Object.fromEntries(['R','L'].map(s=>[s,clip[s][Math.min(frame,clip[s].length-1)]]));
 checkPose(`simplified ${id}:${frame}`,simpleRuntime,simpleState);
}

// Confirm exports are bit-identical to the pre-replacement app with both the
// original timing and independent nonlinear speed curves + a left-arm delay.
const exportedHash=createHash('sha256');
for(const [id,clip]of clips){
 const count=Math.max(clip.R.length,clip.L.length);
 for(const mode of [0,1]){
  const curves=Object.fromEntries(['R','L'].map(side=>[side,{rate:mode?(side==='R'?.7:1.4):1,enabled:!!mode,points:defaultPoints().map((p,i)=>({...p,y:mode?[.35,.55,1.6,1.1,2.4,.8,.6][i]:1}))}]));
  const delays={R:0,L:mode?.23:0},duration=Math.max(...['R','L'].map(s=>createPlaybackClock(count,curves[s],30).duration+delays[s]));
  if(!id.startsWith('recorded-'))for(const side of ['R','L']){const legacyRows=legacyClips.find(([key])=>key===id)[1][side];exportedHash.update(JSON.stringify([id,mode,side,exportRows(legacyRows,count,curves[side],30,{delaySeconds:delays[side],durationSeconds:duration})]));}
 }
}
assert.equal(exportedHash.digest('hex'),'09c1cdcd8b6935210fda3530e75a6a1961c8d39a0a8bc4f35f902298658499ff','CSV samples/timing changed during geometry replacement');
console.log(`PASS: ${clips.length} motions, ${poses} complete poses across both arms for markers and actual simplified meshes, ${matrices} full link/mesh matrices, max error ${maxError}; full hand transforms and original/edited CSV fingerprints retained after explicit authored reference rebase. Numerical check only; visual/hardware checks are separate.`);
