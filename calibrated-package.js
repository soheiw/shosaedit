import {sha256,validateCalibrationSnapshot,validatePlaybackRequirements} from './arm-calibration.js';
import {toCSV,zipFiles} from './export-motion.js';
export async function calibratedPackage(recording,stem,side){
 const calibrationSnapshot=validateCalibrationSnapshot(recording.calibrationSnapshot),files={},csv={};
 for(const s of side?[side]:['R','L']){
  const name=`${stem}${s}.csv`,text=toCSV(recording[s]);files[name]=text;
  csv[s]={name,rows:recording[s].length,sha256:await sha256(text)};
 }
 files[`${stem}.calibration.json`]=JSON.stringify({format:'shosa-calibrated-csv',version:1,fps:30,name:recording.name,referenceProfile:recording.referenceProfile,calibrationSnapshot,playbackRequirements:validatePlaybackRequirements(recording.playbackRequirements),csv},null,2)+'\n';
 return zipFiles(files);
}
// Read our stored ZIPs without executing or extracting arbitrary archive paths.
export function readStoredPackage(bytes){
 const view=new DataView(bytes.buffer,bytes.byteOffset,bytes.byteLength),files=[],decoder=new TextDecoder('utf-8',{fatal:true});let offset=0,total=0;
 while(offset+4<=bytes.length&&view.getUint32(offset,true)===0x04034b50){
  if(offset+30>bytes.length)throw Error('Invalid ZIP');
  const flags=view.getUint16(offset+6,true),method=view.getUint16(offset+8,true),length=view.getUint32(offset+18,true),nameLength=view.getUint16(offset+26,true),extra=view.getUint16(offset+28,true);
  if(method!==0||flags&9)throw Error('ShosaEditから書き出したZIPを選んでください / Unsupported ZIP encoding');
  const start=offset+30+nameLength+extra,end=start+length;total+=length;
  if(end>bytes.length||total>18*1024*1024||files.length>=4)throw Error('Invalid ZIP size');
  const name=decoder.decode(bytes.slice(offset+30,offset+30+nameLength));
  if(!/^[A-Za-z0-9_-]+(?:[RL]\.csv|\.calibration\.json)$/.test(name)||files.some(f=>f.name===name))throw Error('Invalid package filename');
  const data=bytes.slice(start,end);files.push({name,size:length,text:async()=>decoder.decode(data),arrayBuffer:async()=>data.buffer});offset=end;
 }
 if(!files.length||offset+4>bytes.length||![0x02014b50,0x06054b50].includes(view.getUint32(offset,true)))throw Error('Invalid ZIP');
 return files;
}
