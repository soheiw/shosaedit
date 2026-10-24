import fs from 'node:fs';
import assert from 'node:assert/strict';
const source=fs.readFileSync('speed-curve.js','utf8');
const {createSpeedEditor,defaultPoints,speedAt,timeMap}=await import('data:text/javascript;base64,'+Buffer.from(source).toString('base64'));
class Element {
 constructor(id){this.id=id;this.value='';this.checked=false;this.disabled=false;this.hidden=false;this.style={};this.dataset={};this.events={};this.attributes={};}
 get valueAsNumber(){return this.value===''?NaN:Number(this.value)}
 addEventListener(name,fn){this.events[name]=fn}
 setAttribute(k,v){this.attributes[k]=v}
 setPointerCapture(){}
 getScreenCTM(){return {inverse:()=>({})}}
}
class Host{constructor(){this.nodes=new Map()}set innerHTML(s){this.html=s;for(const [,id]of s.matchAll(/id="([^"]+)"/g))this.nodes.set(id,new Element(id))}querySelector(selector){const id=selector.slice(1);if(!this.nodes.has(id))this.nodes.set(id,new Element(id));return this.nodes.get(id)}}
let storage=new Map();globalThis.localStorage={getItem:k=>storage.get(k)??null,setItem:(k,v)=>storage.set(k,v)};
const old={1:{points:defaultPoints().map(p=>({...p,y:1.4})),enabled:false},2:{points:defaultPoints().map(p=>({...p,y:.8})),enabled:true}};storage.set('augmented-arms-speed-curves-v1',JSON.stringify(old));
const host=new Host();let changes=0;const editor=createSpeedEditor(host,()=>changes++),el=id=>host.querySelector('#'+id);
const change=(id,value)=>{el(id).value=String(value);el(id).onchange({target:el(id)})};const check=(id,value)=>{el(id).checked=value;el(id).onchange({target:el(id)})};
editor.setClip('1',10,3);assert.equal(changes,0);assert.equal(editor.isLinked(),false);assert.equal(editor.snapshot('R').rate,1);assert.equal(editor.snapshot('R').enabled,false);assert.deepEqual(editor.snapshot('R'),editor.snapshot('L'));assert.equal(el('speed-common-row').hidden,true);
change('speed-right',1.8);change('speed-left',.6);assert.equal(editor.snapshot('R').rate,1.8);assert.equal(editor.snapshot('L').rate,.6);
check('curve-enabled',true);change('curve-point',3);el('curve-y').value='2.4';el('curve-x').value='50';el('curve-y').oninput();assert.equal(editor.snapshot('R').points[3].y,2.4);assert.equal(editor.snapshot('L').points[3].y,1.4);
const right=editor.snapshot('R'),left=editor.snapshot('L');check('speed-link',true);assert.equal(editor.snapshot('R').rate,1);assert.equal(editor.snapshot('R').enabled,false);assert.equal(el('speed-side').disabled,true);assert.equal(el('speed-independent').hidden,true);
change('speed-common',1.35);check('curve-enabled',true);el('curve-reset').onclick();assert.equal(editor.snapshot('R').rate,1.35);assert.deepEqual(editor.snapshot('R'),editor.snapshot('L'));check('speed-link',false);assert.deepEqual(editor.snapshot('R'),right);assert.deepEqual(editor.snapshot('L'),left);
change('speed-side','L');assert.equal(editor.selectedSide(),'L');assert.equal(editor.snapshot().rate,1.8);assert.equal(el('curve-y').value,'1.40');assert.equal(el('speed-left').value,.6);
editor.cursor(25,100,'L');assert.equal(el('curve-cursor').attributes.x1,135);editor.cursor(90,100,'R');assert.equal(el('curve-cursor').attributes.x1,135);
const count=changes;editor.setClip('2',12);assert.equal(changes,count);assert.equal(editor.snapshot('R').points[3].y,.8);assert.equal(editor.snapshot('R').rate,1);change('speed-right',2.25);editor.setClip('1',10);assert.deepEqual(editor.snapshot('R'),right);assert.deepEqual(editor.snapshot('L'),left);assert.equal(editor.selectedSide(),'L');editor.setClip('2',12);assert.equal(editor.snapshot('R').rate,2.25);
const host2=new Host(),editor2=createSpeedEditor(host2,()=>{});editor2.setClip('1',10);assert.deepEqual(editor2.snapshot('R'),right);assert.deepEqual(editor2.snapshot('L'),left);assert.equal(storage.get('augmented-arms-speed-curves-v1'),JSON.stringify(old));
const escaped=editor2.snapshot('R');escaped.points[0].y=99;assert.notEqual(editor2.snapshot('R').points[0].y,99);
change('speed-right',100);assert.equal(editor.snapshot('R').rate,3);change('speed-left',0);assert.equal(editor.snapshot('L').rate,.25);change('speed-right','');assert.equal(editor.snapshot('R').rate,3);
assert.ok(Math.abs(speedAt(defaultPoints(),.6)-1)<1e-9);assert.ok(Math.abs(timeMap(defaultPoints()).total-1)<1e-9);
// Different independent rates must produce different source clocks.
editor.setClip('fresh',10);editor.setRate(2,'R');editor.setRate(.5,'L');assert.ok(Math.abs(editor.advance(0,1,300,'R')-60)<1e-6);assert.ok(Math.abs(editor.advance(0,1,300,'L')-15)<1e-6);
// Malformed v2 data falls back per arm to valid legacy data without touching v1.
const broken={1:{linked:false,selected:'L',R:{points:[{x:0,y:1}],rate:NaN},L:{points:defaultPoints(),rate:2,enabled:false}}};storage.set('augmented-arms-speed-curves-v2',JSON.stringify(broken));const e3=createSpeedEditor(new Host());e3.setClip('1',10);assert.equal(e3.snapshot('R').points[3].y,1.4);assert.equal(e3.snapshot('L').rate,2);assert.equal(e3.snapshot('L').enabled,false);
console.log('PASS: legacy migration, independent rates/curves, LINK restoration, per-clip persistence, editing target, cursor isolation, fresh instance, defensive snapshots, range checks, independent clocks, malformed storage fallback');
