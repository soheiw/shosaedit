import assert from 'node:assert/strict';
import {createSimpleModel} from '../simple-model.js';
import {loadDisplayModel,loadMassProperties,missingCADMessage,mirroredLeftMessage,normalizeLeftCAD,combineSides,leftCADOffsetMM,validateCAD} from '../model-loader.js';
const missing=async()=>({status:404,ok:false});
let requests=0;const noFetch=async()=>{requests++;throw Error('must not fetch')};
let a=await loadDisplayModel('simple',noFetch);assert.equal(a.model.kind,'simple');assert.equal(requests,0);
a=await loadDisplayModel('auto',missing);assert.equal(a.model.kind,'simple');assert.ok(a.notice===''||a.notice===mirroredLeftMessage);
a=await loadDisplayModel('cad',missing);assert.equal(a.model.kind,'simple');assert.ok(a.notice.includes(missingCADMessage));
const fixture=createSimpleModel(),cadFetch=async url=>url.endsWith('model.json')?{status:200,ok:true,json:async()=>fixture.model}:{status:200,ok:true,arrayBuffer:async()=>fixture.bin};
a=await loadDisplayModel('cad',cadFetch);assert.equal(a.model.kind,'cad');assert.equal(a.model.leftHandActual,true);assert.equal(a.bin.byteLength,fixture.bin.byteLength*2);assert.deepEqual(new Uint8Array(a.bin,0,fixture.bin.byteLength),new Uint8Array(fixture.bin));assert.equal(a.model.bodies.filter(b=>b.side==='L').length,fixture.model.bodies.length);
const partial=async url=>url.endsWith('model.json')?cadFetch(url):missing();a=await loadDisplayModel('auto',partial);assert.equal(a.model.kind,'simple');assert.ok(a.notice.includes(missingCADMessage));
const broken={...fixture.model,bodies:[{...fixture.model.bodies[0],positionOffset:3}]};assert.throws(()=>validateCAD(broken,fixture.bin));
const badIndex=fixture.bin.slice(0);new Uint32Array(badIndex,fixture.model.bodies[0].indexOffset,1)[0]=999999;assert.throws(()=>validateCAD(fixture.model,badIndex));
a=await loadDisplayModel('cad',async()=>{throw Error('network')});assert.equal(a.model.kind,'simple');assert.ok(a.notice);
const publicProps={links:Array(7).fill({}),materialComponents:undefined};let paths=[];const sharedMass=await loadMassProperties(async url=>{paths.push(url);return url.startsWith('private-model/')?missing():{ok:true,json:async()=>publicProps}});assert.equal(sharedMass.privateMaterials,false);assert.deepEqual(paths,['private-model/mass-shapes.json','mass-properties.json']);
const privateProps={links:Array(7).fill({}),materialComponents:[]};const privateMass=await loadMassProperties(async()=>({ok:true,json:async()=>privateProps}));assert.equal(privateMass.privateMaterials,true);
console.log('Model loader: public simple without private fetch, auto/detail fallback message, optional CAD pair, malformed data, and optional private mass data passed.');

// The native-left normalization must reflect positions, reverse winding and
// preserve source buffers; the subsequent rig X mirror is a proper rotation.
const markerBin=new ArrayBuffer(48);new Float32Array(markerBin,0,9).set([1,2,3,4,2,3,1,5,3]);new Uint32Array(markerBin,36,3).set([0,1,2]);
const marker={bodies:[{group:7,solid:true,vertexCount:3,indexCount:3,positionOffset:0,indexOffset:36,min:[1,2,3],max:[4,5,3]}]};
marker.bodies[0].id='link_7:1/part';
const normalized=normalizeLeftCAD(marker,markerBin);
assert.equal(normalized.model.bodies[0].id,'left/link_7:1/part');assert.equal(marker.bodies[0].id,'link_7:1/part');
assert.deepEqual([...new Uint32Array(normalized.bin,36,3)],[0,2,1]);
const expected=[1,2,leftCADOffsetMM-3,4,2,leftCADOffsetMM-3,1,5,leftCADOffsetMM-3];
new Float32Array(normalized.bin,0,9).forEach((v,i)=>assert.ok(Math.abs(v-expected[i])<1e-6));
assert.equal(new Float32Array(markerBin,0,9)[2],3,'native geometry remains unchanged');
const oneSide=await loadDisplayModel('cad',async url=>url.includes('left-')?missing():cadFetch(url));assert.equal(oneSide.notice,mirroredLeftMessage);assert.equal(oneSide.bin,fixture.bin);
const mixed=combineSides(fixture,normalized,{simple:true});
assert.equal(mixed.model.bodies.filter(b=>b.side==='L'&&b.group===7).length,1);
assert.equal(mixed.model.bodies.filter(b=>b.side==='L'&&b.group!==7).length,fixture.model.bodies.filter(b=>b.group!==7).length);
console.log('Dual models: right bytes unchanged, side-specific meshes, native left normalization/winding, and missing-left visible fallback passed.');

assert.deepEqual(mixed.model.bodies.filter(b=>b.side==='R').map(b=>b.id),fixture.model.bodies.map(b=>b.id));
