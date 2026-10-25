import assert from 'node:assert/strict';
import {assessMotorLoads,thresholdExposure,torqueAt,createMotorLoadPanel} from '../motor-loads.js';
const near=(a,b)=>assert.ok(Math.abs(a-b)<1e-9,`${a} != ${b}`);
const times=[0,1,2],blank=()=>({times,total:times.map(()=>Array(7).fill(0)),stats:Array.from({length:7},()=>({rms:0}))});
const results={R:{original:blank(),edited:blank()},L:{original:blank(),edited:blank()}};
results.R.edited.total[1][0]=4;results.L.edited.total[2][6]=-2;results.R.original.total[1][0]=6;
let r=assessMotorLoads(results,{},1);assert.equal(r.status,'incomplete');assert.equal(r.missing.length,14);assert.equal(r.worst,null);
const limits=Object.fromEntries(['R','L'].flatMap(s=>Array.from({length:7},(_,i)=>[s+(i+1),10])));limits.R1=5;limits.L7=1;
r=assessMotorLoads(results,limits,1);assert.equal(r.status,'over');assert.deepEqual(r.over.map(m=>m.id),['L7']);assert.equal(r.worst.id,'L7');near(r.worst.ratio,2);assert.equal(r.worst.peakTime,2);assert.equal(r.currentOver.length,0);near(r.motors[0].originalPeak,6);near(r.worst.exposure.seconds,.5);near(r.worst.exposure.first,1.5);
r=assessMotorLoads(results,limits,2);assert.deepEqual(r.currentOver.map(m=>m.id),['L7']);
// Any single exceeded axis overrides unknown limits elsewhere: no aggregate cancellation.
r=assessMotorLoads(results,{L7:1},2);assert.equal(r.status,'over');assert.equal(r.missing.length,13);
limits.L7=2;r=assessMotorLoads(results,limits,1);assert.equal(r.status,'within');assert.equal(r.over.length,0);
delete limits.R1;r=assessMotorLoads(results,limits);assert.equal(r.status,'incomplete');r=assessMotorLoads(null,limits);assert.equal(r.status,'incomplete');assert.equal(r.motors.filter(m=>m.available).length,0);
let e=thresholdExposure([0,1],[2,-2],1);near(e.seconds,.5);near(e.first,0);e=thresholdExposure([0,1],[0,2],1);near(e.seconds,.5);near(e.first,.5);e=thresholdExposure([0,1],[1,1],1);near(e.seconds,0);assert.equal(e.first,null);
near(torqueAt(results.L.edited,6,1.75),-1.5);near(torqueAt(results.L.edited,6,20),-2);
// Minimal DOM fixture: persistence, limit clearing, and selecting/seeking worst motor.
class Node{constructor(){this.dataset={};this.value='';this.listeners={};this.disabled=false;}querySelector(s){this.children??=new Map();if(!this.children.has(s))this.children.set(s,new Node());return this.children.get(s);}addEventListener(k,v){this.listeners[k]=v;}setCustomValidity(v){this.error=v;}}
let storage={},selected,seek;globalThis.localStorage={getItem:k=>storage[k]??null,setItem:(k,v)=>storage[k]=v};const host=new Node(),panel=createMotorLoadPanel(host,{onSelect:(s,j)=>selected=[s,j],onSeek:t=>seek=t});panel.setResults(results);const input={dataset:{motorLimit:'L7'},value:'1',valueAsNumber:1,setCustomValidity(){}};host.listeners.input({target:input});assert.equal(panel.snapshot().status,'over');host.querySelector('[data-motor="worst"]').onclick();assert.deepEqual(selected,['L',6]);assert.equal(seek,2);
const restored=createMotorLoadPanel(new Node(),{onSelect(){},onSeek(){}});assert.equal(restored.getLimits().L7,1);input.value='';input.valueAsNumber=NaN;host.listeners.input({target:input});assert.equal(panel.getLimits().L7,undefined);assert.equal(panel.snapshot().status,'incomplete');
console.log('Motor limits: both arms/14axes, one-motor exceedance, missing limits, signed crossings/exposure, worst time, live torque, persistence and clearing passed.');
