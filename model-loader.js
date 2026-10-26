import {createSimpleModel} from './simple-model.js?v=public-hand-20261026';
export const privateModelDirectory='private-model/';
export const missingCADMessage='詳細CADを表示するには private-model/ に model.json と model.bin を配置してください。';
export function validateCAD(model,bin){
 if(!model||!Array.isArray(model.bodies)||!model.bodies.length||model.bodies.length>10000||!(bin instanceof ArrayBuffer))throw Error('Invalid CAD files');
 for(const b of model.bodies){if(!Number.isInteger(b.group)||b.group<0||b.group>7)throw Error('Invalid CAD link group');for(const k of ['positionOffset','indexOffset','vertexCount','indexCount'])if(!Number.isSafeInteger(b[k])||b[k]<0)throw Error('Invalid CAD mesh offset');if(b.positionOffset%4||b.indexOffset%4||b.vertexCount<3||b.indexCount<3||b.indexCount%3||b.positionOffset+b.vertexCount*12>bin.byteLength||b.indexOffset+b.indexCount*4>bin.byteLength)throw Error('Invalid CAD mesh bounds');for(const v of new Float32Array(bin,b.positionOffset,b.vertexCount*3))if(!Number.isFinite(v))throw Error('Invalid CAD vertex');for(const i of new Uint32Array(bin,b.indexOffset,b.indexCount))if(i>=b.vertexCount)throw Error('Invalid CAD vertex index');}
 return {...model,kind:'cad'};
}
export const leftCADOffsetMM=1.152505961149;
export const mirroredLeftMessage='左腕CADを読み込めないため、左腕は右腕の鏡像で代用しています。';
export function normalizeLeftCAD(model,bin){
 validateCAD(model,bin);
 // Convert native left CAD to the existing rig's template coordinates.
 // Its later X reflection makes the full native-to-display transform a proper
 // 180-degree Y rotation, preserving the actual left hand's handedness.
 const normalized=bin.slice(0),bodies=model.bodies.map(body=>{
  const v=new Float32Array(normalized,body.positionOffset,body.vertexCount*3),ix=new Uint32Array(normalized,body.indexOffset,body.indexCount);
  for(let i=2;i<v.length;i+=3)v[i]=leftCADOffsetMM-v[i];
  for(let i=0;i<ix.length;i+=3)[ix[i+1],ix[i+2]]=[ix[i+2],ix[i+1]];
  return {...body,id:body.id===undefined?undefined:'left/'+body.id,nativeId:body.id,min:body.min?[body.min[0],body.min[1],leftCADOffsetMM-body.max[2]]:undefined,max:body.max?[body.max[0],body.max[1],leftCADOffsetMM-body.min[2]]:undefined};
 });
 return {model:{...model,bodies,leftCoordinates:'right-template-normalized'},bin:normalized};
}
export function combineSides(right,left,{simple=false}={}){
 const bin=new ArrayBuffer(right.bin.byteLength+left.bin.byteLength);new Uint8Array(bin).set(new Uint8Array(right.bin));new Uint8Array(bin).set(new Uint8Array(left.bin),right.bin.byteLength);
 const shift=b=>({...b,positionOffset:b.positionOffset+right.bin.byteLength,indexOffset:b.indexOffset+right.bin.byteLength,side:'L'});
 const bodies=[...right.model.bodies.map(b=>({...b,side:'R'})),...(simple?right.model.bodies.filter(b=>b.group!==7).map(b=>({...b,id:b.id===undefined?undefined:'left/'+b.id,nativeId:b.id,side:'L'})):[]),...left.model.bodies.map(shift)];
 return {model:{...right.model,bodies,leftCAD:true,leftHandActual:true},bin};
}
async function simpleDisplay(notice=''){
 const right=createSimpleModel();
 try{
  const {publicLeftHand}=await import('./public-left-hand.js?v=left-native-20261026');
  if(!publicLeftHand||!publicLeftHand.bodies?.length||publicLeftHand.bodies.some(b=>b.group!==7))throw Error('Invalid public left hand');
  const bytes=Uint8Array.from(atob(publicLeftHand.base64),c=>c.charCodeAt(0));
  const left=normalizeLeftCAD({bodies:publicLeftHand.bodies,units:'mm'},bytes.buffer);
  return {...combineSides(right,left,{simple:true}),notice};
 }catch{return {...right,notice:[notice,mirroredLeftMessage].filter(Boolean).join(' ')};}
}
async function readCADPair(prefix,fetcher){
 const [meta,data]=await Promise.all([prefix+'model.json',prefix+'model.bin'].map(name=>fetcher(privateModelDirectory+name,{cache:'no-store'})));
 if(meta.status===404&&data.status===404)return null;
 if(!meta.ok||!data.ok)throw Error('Incomplete CAD files');
 const [model,bin]=await Promise.all([meta.json(),data.arrayBuffer()]);return {model:validateCAD(model,bin),bin};
}
export async function loadDisplayModel(mode='auto',fetcher=fetch){
 if(!['auto','simple','cad'].includes(mode))mode='auto';
 if(mode==='simple')return simpleDisplay();
 try{
  const right=await readCADPair('',fetcher);
  if(!right)return simpleDisplay(mode==='cad'?missingCADMessage:'');
  try{
   const left=await readCADPair('left-',fetcher);
   if(left)return {...combineSides(right,normalizeLeftCAD(left.model,left.bin)),notice:''};
  }catch{}
  return {...right,notice:mirroredLeftMessage};
 }catch{return simpleDisplay(missingCADMessage);}
}
export async function loadMassProperties(fetcher=fetch){
 try{const r=await fetcher(privateModelDirectory+'mass-shapes.json',{cache:'no-store'});if(r.ok){const m=await r.json();if(m.links?.length===7&&Array.isArray(m.materialComponents))return {...m,privateMaterials:true};}}catch{}
 const r=await fetcher('mass-properties.json',{cache:'no-store'});if(!r.ok)throw Error('Mass properties could not be loaded');return {...await r.json(),privateMaterials:false};
}
