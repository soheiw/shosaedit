import {simpleGeometry} from './simple-shapes.js';
export const simplePivots=[[-13.0614,-559.9965,0],[-13.0614,-559.9965,-14],[-18.65,-559.9965,36.503],[-13.2884,-480,36.503],[-15.98,-357.8448,36.5615],[-13.207,-244.6,1.1525],[-2.2069,-126.1417,2.65],[-26.2069,-126.1417,1.1525]];
let cachedBin;
export function createSimpleModel(){
 if(!cachedBin){const raw=atob(simpleGeometry.base64),bytes=new Uint8Array(raw.length);for(let i=0;i<raw.length;i++)bytes[i]=raw.charCodeAt(i);cachedBin=bytes.buffer;}
 return {model:{name:'ShosaEdit simplified model',kind:'simple',units:'mm',bodies:simpleGeometry.bodies,fingersFixed:true},bin:cachedBin};
}
