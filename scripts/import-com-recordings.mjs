// Rebuild paired recordings without modifying the original CSVs.
// User-confirmed mapping: COM14 = left, COM15 = right.
import {readFile,writeFile} from 'node:fs/promises';
import {parseMotionCSV,validateRecording} from '../motion-files.js';
const root=new URL('../motion-data/',import.meta.url);
const libraryURL=new URL('generated-motions.json',root);
const library=JSON.parse(await readFile(libraryURL,'utf8'));
for(const name of ['marka','markb']){
 const recording={format:'augmented-arms-motion',version:1,fps:30,name,description:`記録データ ${name} · 左 COM14 / 右 COM15 · 30 fps`,exportStem:name};
 for(const [side,port,columns] of [['L','COM14',8],['R','COM15',9]])recording[side]=parseMotionCSV(await readFile(new URL(`original-csv/${port}/${name}.csv`,root),'utf8'),columns);
 validateRecording(recording);
 if(recording.R.length!==recording.L.length)throw Error(`${name}: unequal arm lengths; check synchronization`);
 const entry={id:`recorded-${name}`,file:`${name}.motion.json`};
 await writeFile(new URL(entry.file,root),JSON.stringify(recording)+'\n');
 const index=library.findIndex(x=>x.id===entry.id);if(index<0)library.push(entry);else library[index]=entry;
 console.log(`${name}: ${recording.R.length} frames, L=COM14, R=COM15`);
}
await writeFile(libraryURL,JSON.stringify(library,null,2)+'\n');
