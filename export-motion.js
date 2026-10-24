import {createPlaybackClock,sampleAtTime} from './arm-delay.js';
// Resample the edited recording onto the original 30 Hz output clock.
export function exportRows(rows,fullCount,curve,fps=30,timing={}){
 const clock=createPlaybackClock(fullCount,curve,fps),delay=timing.delaySeconds??0;
 if(!Number.isFinite(delay)||delay<0)throw Error('時間差が不正です');
 const duration=timing.durationSeconds??(clock.timeAtFrame(rows.length)+delay);
 if(!Number.isFinite(duration)||duration<0||duration+1e-9<delay)throw Error('書き出し時間が不正です');
 const count=Math.max(1,Math.ceil(duration*fps-1e-9));
 return Array.from({length:count},(_,i)=>sampleAtTime(rows,i/fps,clock,delay).map(v=>{if(!Number.isFinite(v))throw Error('記録に不正な値があります');return Math.round(v);}));
}
export const toCSV=rows=>rows.map(r=>r.join(',')).join('\r\n')+'\r\n';
const crcTable=Array.from({length:256},(_,n)=>{for(let k=0;k<8;k++)n=n&1?0xedb88320^(n>>>1):n>>>1;return n>>>0;});
const crc32=bytes=>{let crc=0xffffffff;for(const b of bytes)crc=crcTable[(crc^b)&255]^(crc>>>8);return (crc^0xffffffff)>>>0;};
// Uncompressed ZIP: one download preserves both original filenames.
export function zipFiles(files){const enc=new TextEncoder(),chunks=[],directory=[];let offset=0;
 for(const [name,text] of Object.entries(files)){const filename=enc.encode(name),data=enc.encode(text),crc=crc32(data),head=new Uint8Array(30+filename.length),v=new DataView(head.buffer);v.setUint32(0,0x04034b50,true);v.setUint16(4,20,true);v.setUint16(6,0x800,true);v.setUint32(14,crc,true);v.setUint32(18,data.length,true);v.setUint32(22,data.length,true);v.setUint16(26,filename.length,true);head.set(filename,30);chunks.push(head,data);const central=new Uint8Array(46+filename.length),c=new DataView(central.buffer);c.setUint32(0,0x02014b50,true);c.setUint16(4,20,true);c.setUint16(6,20,true);c.setUint16(8,0x800,true);c.setUint32(16,crc,true);c.setUint32(20,data.length,true);c.setUint32(24,data.length,true);c.setUint16(28,filename.length,true);c.setUint32(42,offset,true);central.set(filename,46);directory.push(central);offset+=head.length+data.length;}
 const size=directory.reduce((n,b)=>n+b.length,0),end=new Uint8Array(22),e=new DataView(end.buffer);e.setUint32(0,0x06054b50,true);e.setUint16(8,directory.length,true);e.setUint16(10,directory.length,true);e.setUint32(12,size,true);e.setUint32(16,offset,true);const result=new Uint8Array(offset+size+22);let p=0;for(const b of [...chunks,...directory,end]){result.set(b,p);p+=b.length;}return result;
}
export function downloadFile(name,data,type){const url=URL.createObjectURL(new Blob([data],{type})),a=document.createElement('a');a.href=url;a.download=name;a.click();setTimeout(()=>URL.revokeObjectURL(url),60000);}
