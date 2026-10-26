import assert from 'node:assert/strict';
import {watchSharedCalibration} from '../shared-calibration.js';
import {applyWristReference} from '../wrist-reference.js';
class Events{
 constructor(){this.handlers=new Map();this.visibilityState='visible';}
 addEventListener(name,fn){if(!this.handlers.has(name))this.handlers.set(name,new Set());this.handlers.get(name).add(fn);}
 removeEventListener(name,fn){this.handlers.get(name)?.delete(fn);}
 emit(name,event={}){for(const fn of this.handlers.get(name)??[])fn(event);}
}
const target=new Events(),documentTarget=new Events(),key='calibration';
let live={R:{zero:[1,2,3,4,5,1375]},L:{zero:[6,7]}},stored=JSON.stringify({...live,rightWristVideoReferenceV1:false}),applied=0;
const frame=117,camera={x:20,y:30};
const sync=watchSharedCalibration({key,target,documentTarget,read:()=>stored,current:()=>live,
 validate:raw=>{if(!raw.R?.zero||!raw.L?.zero)throw Error('invalid');return applyWristReference(raw);},
 apply:next=>{live=next;applied++;}});
assert(sync.sync());assert.equal(live.R.zero[5],3025);assert.equal(frame,117);assert.deepEqual(camera,{x:20,y:30});
assert.equal(sync.sync(),false);assert.equal(applied,1);
const custom={...live,R:{zero:[1,2,3,4,5,2999]}};
target.emit('storage',{key:'other',newValue:JSON.stringify(custom)});assert.equal(applied,1);
stored=JSON.stringify(custom);target.emit('storage',{key,newValue:stored});assert.equal(live.R.zero[5],2999);
target.emit('storage',{key,newValue:'{"R":'});assert.equal(live.R.zero[5],2999);
target.emit('storage',{key,newValue:'{}'});assert.equal(live.R.zero[5],2999);
stored=JSON.stringify({...live,R:{zero:[1,2,3,4,5,3025]}});target.emit('focus');assert.equal(live.R.zero[5],3025);
stored=JSON.stringify(custom);documentTarget.visibilityState='hidden';documentTarget.emit('visibilitychange');assert.equal(live.R.zero[5],3025);
documentTarget.visibilityState='visible';documentTarget.emit('visibilitychange');assert.equal(live.R.zero[5],2999);
sync.destroy();stored=JSON.stringify({...live,R:{zero:[1,2,3,4,5,2800]}});target.emit('focus');assert.equal(live.R.zero[5],2999);
console.log('PASS stale 1375→3025 migration, storage/focus/visibility sync, custom values, invalid data, stable playback/camera, cleanup');
