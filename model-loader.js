import {createSimpleModel} from './simple-model.js?v=public-hand-20261026';
export const privateModelDirectory='private-model/';
export const missingCADMessage='詳細CADを表示するには private-model/ に model.json と model.bin を配置してください。';
export function validateCAD(model,bin){
 if(!model||!Array.isArray(model.bodies)||!model.bodies.length||model.bodies.length>10000||!(bin instanceof ArrayBuffer))throw Error('Invalid CAD files');
 for(const b of model.bodies){if(!Number.isInteger(b.group)||b.group<0||b.group>7)throw Error('Invalid CAD link group');for(const k of ['positionOffset','indexOffset','vertexCount','indexCount'])if(!Number.isSafeInteger(b[k])||b[k]<0)throw Error('Invalid CAD mesh offset');if(b.positionOffset%4||b.indexOffset%4||b.vertexCount<3||b.indexCount<3||b.indexCount%3||b.positionOffset+b.vertexCount*12>bin.byteLength||b.indexOffset+b.indexCount*4>bin.byteLength)throw Error('Invalid CAD mesh bounds');for(const v of new Float32Array(bin,b.positionOffset,b.vertexCount*3))if(!Number.isFinite(v))throw Error('Invalid CAD vertex');for(const i of new Uint32Array(bin,b.indexOffset,b.indexCount))if(i>=b.vertexCount)throw Error('Invalid CAD vertex index');}
 return {...model,kind:'cad'};
}
export async function loadDisplayModel(mode='auto',fetcher=fetch){
 if(!['auto','simple','cad'].includes(mode))mode='auto';
 if(mode==='simple')return {...createSimpleModel(),notice:''};
 try{
  const [meta,data]=await Promise.all(['model.json','model.bin'].map(name=>fetcher(privateModelDirectory+name,{cache:'no-store'})));
  if(meta.status===404&&data.status===404)return {...createSimpleModel(),notice:mode==='cad'?missingCADMessage:''};
  if(!meta.ok||!data.ok)return {...createSimpleModel(),notice:missingCADMessage};
  const [model,bin]=await Promise.all([meta.json(),data.arrayBuffer()]);return {model:validateCAD(model,bin),bin,notice:''};
 }catch{return {...createSimpleModel(),notice:'詳細CADを読み込めないため簡易モデルを表示しています。private-model/ のファイルを確認してください。'};}
}
export async function loadMassProperties(fetcher=fetch){
 try{const r=await fetcher(privateModelDirectory+'mass-shapes.json',{cache:'no-store'});if(r.ok){const m=await r.json();if(m.links?.length===7&&Array.isArray(m.materialComponents))return {...m,privateMaterials:true};}}catch{}
 const r=await fetcher('mass-properties.json',{cache:'no-store'});if(!r.ok)throw Error('Mass properties could not be loaded');return {...await r.json(),privateMaterials:false};
}
