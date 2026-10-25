import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
const shared=JSON.parse(await fs.readFile(new URL('../mass-properties.json',import.meta.url)));
assert.equal(shared.links.length,7);
for(const [i,l] of shared.links.entries()){
 assert.equal(l.group,i+1);assert.ok(l.defaultMass>=0);
 for(const v of [l.com,l.nativePivot,...l.unitMassInertia])assert.ok(v.length===3&&v.every(Number.isFinite));
 for(let a=0;a<3;a++){assert.ok(l.unitMassInertia[a][a]>=0);for(let b=0;b<3;b++)assert.equal(l.unitMassInertia[a][b],l.unitMassInertia[b][a]);}
}
const forbidden=['bounds','bodyCount','closedMeshBodyCount','fallbackBodies','sourceBodyIds','excludedMotorBodyIds','shapeOnlyCom','shapeOnlyUnitMassInertia','mesh','vertices','triangles'];
function checkKeys(value){if(Array.isArray(value))value.forEach(checkKeys);else if(value&&typeof value==='object')for(const [key,v]of Object.entries(value)){assert.ok(!forbidden.includes(key),`Private CAD key ${key}`);checkKeys(v);}}
checkKeys(shared);
let original;try{original=JSON.parse(await fs.readFile(new URL('../private-model/mass-shapes.json',import.meta.url)));}catch(e){if(e.code!=='ENOENT')throw e;}
if(original){
 for(const [i,l]of shared.links.entries())for(const key of ['group','defaultMass','com','unitMassInertia','nativePivot','defaultMassBreakdown'])assert.deepEqual(l[key],original.links[i][key],`Exact default link ${i+1} ${key}`);
 for(const key of ['payloadCom','payloadMassDefault','defaultMaterialSettings'])assert.deepEqual(shared[key],original[key],`Exact ${key}`);
 console.log('PASS: default physical properties match private source exactly.');
}
console.log('PASS: seven finite link models; no private CAD identifiers, bounds or meshes.');
