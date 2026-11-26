import {snapshotConfiguration} from '../arm-calibration.js';
import {calibratedPackage} from '../calibrated-package.js';
import {bindReferenceEnds} from '../reference-ends.js';
import {modelFilename} from '../model-filename.js';
// Execute the app's actual export entry points with a captured download sink.
// No DOM/browser bootstrap and no hardware calls; load guards are stubbed.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {exportRows,toCSV,zipFiles} from '../export-motion.js';
import {defaultPoints} from '../speed-curve.js';
import {parseMotionCSV,validateRecording} from '../motion-files.js';
import {matchingReferenceProfile,interpretedConfiguration} from '../recording-interpretation.js';
import {windowSmoothRows} from '../smoothing.js';
const root=new URL('../',import.meta.url),read=p=>fs.readFileSync(new URL(p,root),'utf8');
const source=read('app.js');
function appFunction(name){
 const re=new RegExp(`(?:async )?function ${name}\\(`),match=re.exec(source);
 assert(match,name);const tail=source.slice(match.index);const end=/\n(?:async )?function /.exec(tail.slice(1));
 return tail.slice(0,end?end.index+1:undefined);
}
function unzipStored(bytes){
 const result={},view=new DataView(bytes.buffer,bytes.byteOffset,bytes.byteLength),decoder=new TextDecoder();let offset=0;
 while(view.getUint32(offset,true)===0x04034b50){
  assert.equal(view.getUint16(offset+8,true),0);
  const length=view.getUint32(offset+18,true),nameLength=view.getUint16(offset+26,true),extra=view.getUint16(offset+28,true);
  const name=decoder.decode(bytes.slice(offset+30,offset+30+nameLength)),start=offset+30+nameLength+extra;
  result[name]=decoder.decode(bytes.slice(start,start+length));offset=start+length;
 }
 return result;
}
const originals=JSON.parse(read('motion-data/motions.json')).clips;
const clips=[...Object.entries(originals).map(([id,m])=>({id,m,stem:'Motion'+id})),
 ...JSON.parse(read('motion-data/generated-motions.json')).map(e=>({id:e.id,m:JSON.parse(read('motion-data/'+e.file)),stem:e.id}))];
const recordingReferences=JSON.parse(read('recording-references.json'));
function snapshotFor(m){const joints=Array.from({length:8},(_,g)=>({motor:g-1,gain:1,axis:[1,0,0],pivot:[0,0,0]}));const config={resolution:4096,R:{zero:[2535,2916,2034,2974,3611,3025,1890,3492,396],joints},L:{zero:[2035,1112,2258,1166,1895,2003,2164,3213],joints}};const resolved=interpretedConfiguration(config,m,recordingReferences);return snapshotConfiguration(resolved,{R:{rest:[...(m.calibrationSnapshot?.R?.rest??resolved.R.zero)],model:m.calibrationSnapshot?.R?.model||'test'},L:{rest:[...(m.calibrationSnapshot?.L?.rest??resolved.L.zero)],model:m.calibrationSnapshot?.L?.model||'test'}});}
for(const {id,m,stem} of clips)for(const enabled of [false,true]){
 const immutable=JSON.stringify(m),downloads=[],nodes={};
 const state={clip:id},motions={fps:30,clips:{[id]:m},metadata:{[id]:{name:id,exportStem:stem}}};
 const count=Math.max(m.R.length,m.L.length),curve={rate:1,enabled,points:defaultPoints()};
 const timing={editedDuration:count/30,curves:{R:curve,L:curve},delays:{R:0,L:0}};
 const build=new Function('state','motions','smoothing','timing','frameCount','exportRows','toCSV','zipFiles','downloadFile','validateOutput','$','matchingReferenceProfile','recordingReferences','currentCalibrationSnapshot','calibratedPackage','bindReferenceEnds','modelFilename',
  'const sharedCalibration={sync(){}};\n'+appFunction('editedSequenceSource')+'\n'+appFunction('exportMotion')+'\nreturn {exportMotion,editedSequenceSource};');
 const api=build(state,motions,{rows:(_,side)=>m[side]},timing,()=>count,exportRows,toCSV,zipFiles,
  (name,data)=>downloads.push({name,data}),async()=>{},id=>nodes[id]??=( {} ),matchingReferenceProfile,recordingReferences,()=>snapshotFor(m),calibratedPackage,bindReferenceEnds,modelFilename);
 const unbound=api.editedSequenceSource().clip;
 await api.exportMotion();assert.equal(downloads.length,1,nodes['export-status']?.textContent);
 const files=unzipStored(downloads.pop().data);
 for(const [side,width] of [['R',9],['L',8]]){
  const filename=modelFilename(stem,snapshotFor(m))+side+'.csv';
  const rows=parseMotionCSV(files[filename],width);
  const expected=Array.from({length:count},(_,i)=>m[side][Math.min(i,m[side].length-1)]);
  assert.deepEqual(unbound[side],expected,`${id}/${side}: unchanged edited 1x samples; shorter arm holds tail`);
  assert.equal(rows.length,count,'endpoint binding retains duration');
  const rest=snapshotFor(m)[side].rest,window=Math.min(30,Math.floor((count-1)/2));
  assert.deepEqual(rows[0],rest,`${id}/${side}: export begins at explicit rest`);
  assert.deepEqual(rows.at(-1),rest,`${id}/${side}: export ends at explicit rest`);
  assert.deepEqual(rows.slice(window,count-window),expected.slice(window,count-window),`${id}/${side}: endpoint binding preserves all interior samples`);
  if(['recorded-marka','recorded-markb'].includes(id)){
   const original=read(`motion-data/original-csv/${side==='R'?'COM15':'COM14'}/${id.replace('recorded-','')}.csv`);
   assert.deepEqual(unbound[side],parseMotionCSV(original,width));
   console.log(`PASS ${id} ${side}: ${rows.length} rows × ${width} columns, every original CSV value identical; before endpoint binding, flat curve ${enabled?'on':'off'}`);
  }
 }
 assert.equal(JSON.stringify(m),immutable,'source mutation');
}
console.log('PASS actual app export entry → ZIP → CSV, all registered motions, identity before reference binding; exact rest endpoints, interior/time/source unchanged');

// Edited JSON must retain the reference when averaging changes its first row.
// A raw CSV has no metadata; its explicit import selector is a separate UI path.
const base={R:{zero:[2535,2916,2034,2974,3611,3025,1890,3492,396]},L:{zero:[2035,1112,2258,1166,1895,2003,2164,3213]}};
for(const {id,m}of clips.filter(({m})=>m.generation?.modelInterpretationVersion==='markc-authored-v1')){
 const state={clip:id},motions={fps:30,clips:{[id]:m},metadata:{[id]:{name:id}}},count=Math.max(m.R.length,m.L.length);
 const curve={rate:1,enabled:false,points:defaultPoints()},timing={editedDuration:count/30,curves:{R:curve,L:curve},delays:{R:0,L:0}};
 const edited=new Function('state','motions','smoothing','timing','frameCount','exportRows','matchingReferenceProfile','recordingReferences','currentCalibrationSnapshot','calibratedPackage',appFunction('editedSequenceSource')+';return editedSequenceSource().clip;')
  (state,motions,{rows:(_,side)=>windowSmoothRows(m[side],3)},timing,()=>count,exportRows,matchingReferenceProfile,recordingReferences,()=>snapshotFor(m),calibratedPackage);
 assert.equal(edited.referenceProfile,'markc-video-reference');
 assert.notDeepEqual(edited.R[0],m.R[0],`${id} averaging actually changes initial pose`);
 const imported=validateRecording(JSON.parse(JSON.stringify(edited)));
 assert.equal(imported.referenceProfile,'markc-video-reference',`${id} JSON parser keeps reference`);
 assert.equal(matchingReferenceProfile(imported,recordingReferences)?.id,'markc-video-reference');
 const cfg=interpretedConfiguration(base,imported,recordingReferences);
 for(const side of ['R','L'])assert.deepEqual(cfg[side].zero,recordingReferences[0].zero[side]);
}
console.log('PASS all17 averaged JSON exports preserve model reference despite different first rows');
