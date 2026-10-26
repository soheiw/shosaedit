import assert from 'node:assert/strict';
import {assessMotorLoads,thresholdExposure,torqueAt,createMotorLoadPanel,validWarningPercent} from '../motor-loads.js';
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
limits.L7=2;r=assessMotorLoads(results,limits,1,100);assert.equal(r.status,'within');assert.equal(r.over.length,0);
delete limits.R1;r=assessMotorLoads(results,limits,0,100);assert.equal(r.status,'incomplete');r=assessMotorLoads(null,limits);assert.equal(r.status,'incomplete');assert.equal(r.motors.filter(m=>m.available).length,0);
// Strict warning boundary, limit boundary, signed loads, current-vs-whole-motion severity.
limits.R1=5;limits.L7=10;
r=assessMotorLoads(results,limits,1,80);assert.equal(r.status,'within');assert.equal(r.warnings.length,0); // Exactly 80%.
r=assessMotorLoads(results,limits,1,79);assert.equal(r.status,'warning');assert.deepEqual(r.warnings.map(m=>m.id),['R1']);assert.deepEqual(r.currentWarnings.map(m=>m.id),['R1']);
r=assessMotorLoads(results,limits,0,79);assert.equal(r.status,'warning');assert.equal(r.currentWarnings.length,0);
limits.R1=4;r=assessMotorLoads(results,limits,1,80);assert.equal(r.status,'warning');assert.equal(r.over.length,0); // Exactly limit is warning, not error.
limits.L7=1;r=assessMotorLoads(results,limits,1,80);assert.equal(r.status,'over');assert.deepEqual(r.warnings.map(m=>m.id),['R1']);
r=assessMotorLoads(results,{R1:5},1,79);assert.equal(r.status,'warning');assert.equal(r.missing.length,13); // Unknown axes stay explicit.
for(const value of [0,-1,101,Infinity,NaN,'80',null]){assert.equal(validWarningPercent(value),false);assert.throws(()=>assessMotorLoads(results,{},0,value),RangeError);}
for(const value of [.001,80,100])assert.equal(validWarningPercent(value),true);
let e=thresholdExposure([0,1],[2,-2],1);near(e.seconds,.5);near(e.first,0);e=thresholdExposure([0,1],[0,2],1);near(e.seconds,.5);near(e.first,.5);e=thresholdExposure([0,1],[1,1],1);near(e.seconds,0);assert.equal(e.first,null);
near(torqueAt(results.L.edited,6,1.75),-1.5);near(torqueAt(results.L.edited,6,20),-2);
// Minimal DOM fixture: persistence, limit clearing, and selecting/seeking worst motor.
class Node{constructor(){this.dataset={};this.value='';this.listeners={};this.disabled=false;}querySelector(s){this.children??=new Map();if(!this.children.has(s))this.children.set(s,new Node());return this.children.get(s);}addEventListener(k,v){this.listeners[k]=v;}setCustomValidity(v){this.error=v;}}
let storage={},selected,seek,changes=0;globalThis.localStorage={getItem:k=>storage[k]??null,setItem:(k,v)=>storage[k]=v};const host=new Node(),panel=createMotorLoadPanel(host,{onSelect:(s,j)=>selected=[s,j],onSeek:t=>seek=t,onLimitsChange:()=>changes++});panel.setResults(results);const input={dataset:{motorLimit:'L7'},value:'1',valueAsNumber:1,setCustomValidity(){}};host.listeners.input({target:input});assert.equal(panel.snapshot().status,'over');host.querySelector('[data-motor="worst"]').onclick();assert.deepEqual(selected,['L',6]);assert.equal(seek,2);
const restored=createMotorLoadPanel(new Node(),{onSelect(){},onSeek(){}});assert.equal(restored.getLimits().L7,1);input.value='';input.valueAsNumber=NaN;host.listeners.input({target:input});assert.equal(panel.getLimits().L7,undefined);assert.equal(panel.snapshot().status,'incomplete');
// Invalid settings must retain saved valid limits, show the error, and notify the export guard.
input.value='0';input.valueAsNumber=0;host.listeners.input({target:input});assert.equal(panel.hasInvalidSettings(),true);assert.equal(panel.getLimits().L7,undefined);assert.equal(host.querySelector('[data-motor="settings-error"]').hidden,false);
input.value='3';input.valueAsNumber=3;host.listeners.input({target:input});assert.equal(panel.hasInvalidSettings(),false);input.value='-1';input.valueAsNumber=-1;host.listeners.input({target:input});assert.equal(panel.getLimits().L7,3);assert.equal(panel.hasInvalidSettings(),true);
const invalidReload=createMotorLoadPanel(new Node(),{onSelect(){},onSeek(){}});assert.equal(invalidReload.getLimits().L7,3); // Last valid persisted value survives.
input.value='';input.valueAsNumber=NaN;input.validity={badInput:true};host.listeners.input({target:input});assert.equal(panel.getLimits().L7,3);assert.equal(panel.hasInvalidSettings(),true);
input.value='3';input.valueAsNumber=3;input.validity={badInput:false};host.listeners.input({target:input});assert.equal(panel.hasInvalidSettings(),false);
const warningInput={dataset:{motorWarning:''},value:'50',valueAsNumber:50,setCustomValidity(v){this.error=v;}};host.listeners.input({target:warningInput});assert.equal(panel.getWarningPercent(),50);assert.equal(panel.snapshot().warningPercent,50);
const warningReload=createMotorLoadPanel(new Node(),{onSelect(){},onSeek(){}});assert.equal(warningReload.getWarningPercent(),50);
for(const value of [0,101,NaN]){warningInput.value=String(value);warningInput.valueAsNumber=value;host.listeners.input({target:warningInput});assert.equal(panel.getWarningPercent(),50);assert.equal(panel.hasInvalidSettings(),true);assert.ok(warningInput.error);}
warningInput.value='100';warningInput.valueAsNumber=100;host.listeners.input({target:warningInput});assert.equal(panel.getWarningPercent(),100);assert.equal(panel.hasInvalidSettings(),false);assert.equal(warningInput.error,'');assert.ok(changes>=10);
console.log('Motor limits: both arms/14axes, one-motor exceedance, missing limits, signed crossings/exposure, worst time, live torque, persistence and clearing passed.');

// Presets use confirmed models and exact published voltages, never a guessed model or extrapolation.
const {stallTorquePreset}=await import('../motor-loads.js');
const {readFile}=await import('node:fs/promises');
const specs=JSON.parse(await readFile(new URL('../motor-specs.json',import.meta.url))),mapping=JSON.parse(await readFile(new URL('../motor-models.json',import.meta.url)));
const preset=stallTorquePreset(specs,mapping);assert.equal(Object.keys(preset).length,12);
for(const side of ['R','L']){for(const j of [1,2,4])assert.equal(preset[side+j].value,7.3);assert.equal(preset[side+'3'].value,4.1);assert.equal(preset[side+'5'],undefined);for(const j of [6,7]){assert.equal(preset[side+j].value,.92);assert.equal(preset[side+j].voltage,11.1);}}
assert.equal(stallTorquePreset(specs,mapping,{'XC330-T288-T':12}).R6.value,1);assert.equal(stallTorquePreset(specs,mapping,{'XC330-T288-T':10}).R6,undefined);
const presetHost=new Node(),presetPanel=createMotorLoadPanel(presetHost,{motorMapping:mapping,motorSpecs:specs,onSelect(){},onSeek(){}});presetHost.querySelector('[data-motor="stall"]').onclick();assert.equal(presetPanel.getLimits().R1,7.3);assert.equal(presetPanel.getLimits().L7,.92);assert.equal(presetPanel.getLimits().L5,undefined);
assert.equal(createMotorLoadPanel(new Node(),{onSelect(){},onSeek(){}}).getLimits().L7,.92);
assert.match(presetHost.querySelector('[data-motor-reference="R6"]').textContent,/11.1 V/);
console.log('Stall preset: all confirmed axes, published voltage selection, unknown-model exclusion, no interpolation, UI fill and persisted provisional references passed.');

const {limitFromStallPercent}=await import('../motor-loads.js');near(limitFromStallPercent(7.3,50),3.65);near(limitFromStallPercent(.92,80),.736);
for(const value of [0,-1,NaN,Infinity])assert.throws(()=>limitFromStallPercent(7.3,value));
const percentInput={dataset:{motorPercent:'R1'},value:'50',valueAsNumber:50,setCustomValidity(v){this.error=v;}};
presetHost.listeners.input({target:percentInput});near(presetPanel.getLimits().R1,3.65);assert.equal(presetHost.querySelector('[data-motor-limit="R1"]').value,3.65);
let percentRestored=createMotorLoadPanel(new Node(),{motorSpecs:specs,motorMapping:mapping,onSelect(){},onSeek(){}});near(percentRestored.getLimits().R1,3.65);
percentInput.value='-1';percentInput.valueAsNumber=-1;presetHost.listeners.input({target:percentInput});assert.equal(presetPanel.hasInvalidSettings(),true);near(presetPanel.getLimits().R1,3.65);
percentInput.value='80';percentInput.valueAsNumber=80;presetHost.listeners.input({target:percentInput});near(presetPanel.getLimits().R1,5.84);assert.equal(presetPanel.hasInvalidSettings(),false);
const nmInput={dataset:{motorLimit:'R1'},value:'3.65',valueAsNumber:3.65,setCustomValidity(){}};presetHost.listeners.input({target:nmInput});assert.equal(presetHost.querySelector('[data-motor-percent="R1"]').value,'50');
assert.equal(presetHost.querySelector('[data-motor-percent="R5"]').disabled,true);
// Warning remains relative to the configured limit, rather than the manufacturer stall value.
const relative=assessMotorLoads(results,{R1:limitFromStallPercent(7.3,60)},1,80);assert.equal(relative.motors[0].warning,true);assert.equal(relative.motors[0].over,false);
// A non-default voltage basis survives a reload with the same Nm/percentage relationship.
const voltageHost=new Node(),voltagePanel=createMotorLoadPanel(voltageHost,{motorSpecs:specs,motorMapping:mapping,getVoltages:()=>({'XC330-T288-T':12}),onSelect(){},onSeek(){}});voltageHost.querySelector('[data-motor="stall"]').onclick();voltageHost.listeners.input({target:{dataset:{motorPercent:'R6'},value:'50',valueAsNumber:50,setCustomValidity(){}}});near(voltagePanel.getLimits().R6,.5);
const voltageRestoredHost=new Node();createMotorLoadPanel(voltageRestoredHost,{motorSpecs:specs,motorMapping:mapping,onSelect(){},onSeek(){}});assert.equal(voltageRestoredHost.querySelector('[data-motor-percent="R6"]').value,'50');assert.match(voltageRestoredHost.querySelector('[data-motor-reference="R6"]').textContent,/12 V/);
console.log('Stall percentages: direct conversion, linked Nm fields, invalid-edit recovery, unknown axes, nested warning threshold and voltage-basis persistence passed.');
