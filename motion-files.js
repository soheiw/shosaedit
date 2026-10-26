export function validateRecording(recording){
 if(recording?.format!=='augmented-arms-motion'||recording.version!==1||recording.fps!==30)throw Error('30fpsのMotionファイルを選んでください。');
 const out={};for(const [side,columns] of [['R',9],['L',8]]){const rows=recording[side];if(!Array.isArray(rows)||rows.length<2||rows.length>10000||!rows.every(r=>Array.isArray(r)&&r.length===columns&&r.every(v=>Number.isSafeInteger(v)&&Math.abs(v)<=2147483647)))throw Error('右9列・左8列の整数データが必要です。');out[side]=rows.map(r=>[...r]);}
 return {referenceProfile:typeof recording.referenceProfile==='string'?recording.referenceProfile.slice(0,80):undefined,bakedEdits:recording.bakedEdits===true,previewFrame:Number.isInteger(recording.previewFrame)?Math.max(0,Math.min(Math.max(out.R.length,out.L.length)-1,recording.previewFrame)):null,name:String(recording.name||'Imported motion').slice(0,100),description:String(recording.description||'').slice(0,300),exportStem:/^[A-Za-z0-9_-]{1,64}$/.test(recording.exportStem||'')?recording.exportStem:'ImportedMotion',...out};
}
export function parseMotionCSV(text,columns){const lines=text.replace(/^\uFEFF/,'').trim().split(/\r?\n/);if(lines.length<2||lines.length>10000)throw Error('CSVの行数を確認してください。');return lines.map(line=>{const values=line.split(',').map(s=>s.trim());if(values.length!==columns||values.some(v=>!/^[-+]?\d+$/.test(v)))throw Error('CSVはヘッダーなし、右9列・左8列の整数にしてください。');return values.map(Number);});}
export async function readMotionFiles(files){
 if(!files.length)return null;if(files.some(f=>f.size>6*1024*1024))throw Error('6MB以下のファイルを選んでください。');
 if(files.length===1&&files[0].name.toLowerCase().endsWith('.json'))return validateRecording(JSON.parse(await files[0].text()));
 if(files.length!==2)throw Error('両腕入りのMotion JSON、またはR.csvとL.csvの2ファイルを選んでください。');
 const right=files.find(f=>/R\.csv$/i.test(f.name)),left=files.find(f=>/L\.csv$/i.test(f.name));if(!right||!left||right.name.slice(0,-5)!==left.name.slice(0,-5))throw Error('同じ名前で終わりがR.csvとL.csvのファイルを選んでください。');
 return validateRecording({format:'augmented-arms-motion',version:1,fps:30,name:right.name.slice(0,-5),R:parseMotionCSV(await right.text(),9),L:parseMotionCSV(await left.text(),8)});
}
