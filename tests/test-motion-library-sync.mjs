import assert from 'node:assert/strict';
import {validateSyncedRecording} from '../motion-sync-editor.js';
import {validateRecording} from '../motion-files.js';
import {watchMotionLibrary} from '../motion-library-watch.js';
const raw={format:'augmented-arms-motion',version:1,fps:30,name:'new recording',R:[Array(9).fill(1),Array(9).fill(2)],L:[Array(8).fill(1),Array(8).fill(2)]};
const recording=validateSyncedRecording(raw);
assert.doesNotThrow(()=>validateRecording(recording)); // storeSavedMotion's second validation
assert.deepEqual(recording.R,raw.R);
assert.throws(()=>validateSyncedRecording({...raw,fps:25}));
let entries=[],added=[],fail=true;
const watcher=watchMotionLibrary({initial:[],interval:100000,fetchJSON:async path=>path.endsWith('generated-motions.json')?entries:raw,onAdd:async id=>{if(id==='bad'&&fail)throw Error('temporary');added.push(id)},onError:()=>{}});
await new Promise(r=>setTimeout(r,0));
entries=[{id:'bad',file:'bad.json'},{id:'new',file:'new.json'}];
await watcher.refresh();assert.deepEqual(added,['new']);
fail=false;await watcher.refresh();assert.deepEqual(added,['new','bad']);
await watcher.refresh();assert.equal(added.length,2);watcher.close();
console.log('Motion sync envelope + live library discovery/retry passed');
