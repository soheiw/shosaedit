import {createOSCStream} from './osc-stream.js?v=2';
import {createLiveTorquePlot} from './torque-live.js?v=1';
import {createSequenceEditor} from './sequence-editor.js?v=overlap-2';
import {loadDisplayModel,loadMassProperties} from './model-loader.js?v=public-hand-20261026';
import {listSavedMotions,storeSavedMotion,uniqueMotionName} from './saved-motions.js?v=slots-2';
import {readMotionFiles,validateRecording} from './motion-files.js';
import {initLanguage} from './i18n.js?v=stall-percent-1';
import {exportRows,toCSV,zipFiles,downloadFile} from './export-motion.js';
import {createArmDelayEditor,createPlaybackClock,sampleAtTime} from './arm-delay.js';
import {createSmoothing} from './smoothing.js?v=named-1';
import {createSpeedEditor} from './speed-curve.js?v=arms-2';
import {createLoadPanel} from './load-panel.js?v=stall-percent-1';
import * as THREE from './vendor/three.module.js';
import {OrbitControls} from './vendor/OrbitControls.js';
const $=id=>document.getElementById(id);
initLanguage();
const palette=['#75cbb7','#70b8e7','#b29ce8','#e5b078','#e18f9e','#9ccf80','#dfcf78','#94c9d3','#d5a5ca'];
const names=['link_0 · 固定部','link_1','link_2','link_3','link_4','link_5','link_6 · 手首中間','link_7 · 手・指固定'];
const pivots=[[-13.0614,-559.9965,0],[-13.0614,-559.9965,-14],[-18.65,-559.9965,36.503],[-13.2884,-480,36.503],[-15.98,-357.8448,36.5615],[-13.207,-244.6,1.1525],[-2.2069,-126.1417,2.65],[-26.2069,-126.1417,1.1525]];
const parents=[-1,0,1,2,3,4,5,6];
const axes=[[0,1,0],[0,0,1],[1,0,0],[0,1,0],[-1,0,0],[0,1,0],[0,0,1],[1,0,0]];
const state={solo:-1,clip:'1',frame:0,playing:false,side:'both',chartSide:'R',elapsed:0,loop:true,rigs:{},meshes:[],selected:null,frameFloat:0,originalFrameFloat:0};
let sequenceEditor,sequencePreviewId,sequenceActiveId;
let initialGeometry,modelRevision=0,motions,model,config,renderer,scene,camera,controls,last=0,chartReady=false,speedEditor,delayEditor,timing,smoothing,loadPanel,torquePlot,massShapes,motorSpecs,motorMapping;
const savedKey='augmented-arms-fusion-links-v2';
const modelModeKey='shosaedit-model-mode';
function preferredModelMode(){try{const m=localStorage.getItem(modelModeKey);return ['auto','simple','cad'].includes(m)?m:'auto';}catch{return 'auto';}}
function freshConfig(){const out={version:2,resolution:4096,R:{zero:[...motions.clips['1'].R[0]],joints:[]},L:{zero:[...motions.clips['1'].L[0]],joints:[]},bodyGroups:{}};for(const side of ['R','L'])out[side].joints=pivots.map((p,g)=>({pivot:[...p],axis:(side==='R'&&g===2?[-1,0,0]:side==='L'&&g===4?[1,0,0]:[...axes[g]]),motor:g===0?-1:g-1,gain:1}));return out;}
function validConfig(c){if(c?.version!==2||!Number.isFinite(c.resolution)||c.resolution<=0)throw Error('設定形式が違います');for(const side of ['R','L']){if(c[side]?.zero?.length!==(side==='R'?9:8)||!c[side].zero.every(Number.isFinite)||c[side]?.joints?.length!==8)throw Error('基準値または関節数が違います');for(const j of c[side].joints){if(![j.pivot,j.axis].every(a=>Array.isArray(a)&&a.length===3&&a.every(Number.isFinite))||!Number.isFinite(j.gain)||!Number.isInteger(j.motor)||j.motor< -1||j.motor>=c[side].zero.length||Math.hypot(...j.axis)<1e-6)throw Error('関節設定が不正です');}}return c;}
function persist(){localStorage.setItem(savedKey,JSON.stringify(config));loadPanel?.invalidate();}
function rowFor(side,original=false){
 const rows=!original&&smoothing?smoothing.rows(state.clip,side):motions.clips[state.clip][side];
 if(!original&&timing)return sampleAtTime(rows,state.elapsed,timing.clocks[side],timing.delays[side]);
 const f=Math.min(state.elapsed*30,rows.length-1),i=Math.floor(f),t=f-i;
 return rows[i].map((v,k)=>v+(rows[Math.min(i+1,rows.length-1)][k]-v)*t);
}
function frameCount(){return Math.max(...['R','L'].map(s=>motions.clips[state.clip][s].length));}
function rebuildTiming(){
 const count=frameCount(),curves=Object.fromEntries(['R','L'].map(s=>[s,speedEditor.snapshot(s)])),delays=delayEditor.offsets();
 const clocks=Object.fromEntries(['R','L'].map(s=>[s,createPlaybackClock(count,curves[s],30)]));
 const editedDuration=Math.max(...['R','L'].map(s=>clocks[s].duration+delays[s]));
 timing={curves,delays,clocks,editedDuration,duration:Math.max(count/30,editedDuration)};
 $('timeline').max=Math.max(0,Math.ceil(timing.duration*30-1e-9)-1);$('duration').textContent=timing.duration.toFixed(2);
}
function timingChanged(){if(!motions||!delayEditor||!speedEditor)return;rebuildTiming();setTime(state.elapsed);loadPanel?.invalidate();}
function sourceFrame(side){return timing?Math.min(frameCount()-1,timing.clocks[side].frameAt(Math.max(0,state.elapsed-timing.delays[side]))):state.elapsed*30;}
function initScene(){scene=new THREE.Scene();scene.background=new THREE.Color('#151b24');camera=new THREE.PerspectiveCamera(38,1,1,6000);camera.position.set(950,650,1250);camera.up.set(0,-1,0);renderer=new THREE.WebGLRenderer({antialias:true});renderer.setPixelRatio(Math.min(devicePixelRatio,2));renderer.outputColorSpace=THREE.SRGBColorSpace;renderer.setClearColor('#151b24');$('viewport').appendChild(renderer.domElement);controls=new OrbitControls(camera,renderer.domElement);controls.target.set(0,300,0);controls.enableDamping=true;controls.minDistance=80;controls.maxDistance=6000;scene.add(new THREE.HemisphereLight(0xe8f3ff,0x59616b,2.6));const a=new THREE.DirectionalLight(0xffffff,3.5);a.position.set(300,800,700);scene.add(a);const b=new THREE.DirectionalLight(0x8cacff,1.6);b.position.set(-400,300,-500);scene.add(b);const grid=new THREE.GridHelper(1600,32,0x475362,0x293341);grid.position.y=-28;scene.add(grid);const plane=new THREE.Mesh(new THREE.PlaneGeometry(3500,3500),new THREE.MeshStandardMaterial({color:0x19212b,roughness:1}));plane.rotation.x=-Math.PI/2;plane.position.y=-29;new ResizeObserver(resize).observe($('viewport'));resize();let down;renderer.domElement.addEventListener('pointerdown',e=>down=[e.clientX,e.clientY]);renderer.domElement.addEventListener('pointerup',e=>{if(!down||Math.hypot(e.clientX-down[0],e.clientY-down[1])>5)return;const rect=renderer.domElement.getBoundingClientRect(),ray=new THREE.Raycaster();const original=e.clientX-rect.left<rect.width/2;applyPose(original);scene.updateMatrixWorld(true);ray.setFromCamera(new THREE.Vector2(((e.clientX-rect.left)%(rect.width/2))/(rect.width/2)*2-1,-(e.clientY-rect.top)/rect.height*2+1),camera);const hit=ray.intersectObjects(state.meshes.filter(m=>m.visible&&state.rigs[m.userData.side].root.visible),false)[0];if(hit)selectBody(hit.object);applyPose();});}
function resize(){const v=$('viewport'),w=v.clientWidth,h=v.clientHeight;if(!renderer||!w||!h)return;renderer.setSize(w,h,false);camera.aspect=(w/2)/h;camera.updateProjectionMatrix();if(chartReady){drawChart();if($('autofit').checked)fit();}}
function makeRigs(bin,reuse=false){for(const side of ['R','L']){if(!reuse){const root=new THREE.Group();root.position.x=side==='R'?180:-180;root.scale.x=side==='R'?1:-1;scene.add(root);const groups=pivots.map(()=>new THREE.Group()),helpers=[];groups.forEach((g,i)=>{(parents[i]<0?root:groups[parents[i]]).add(g);if(i>0){const h=new THREE.Group(),ax=new THREE.ArrowHelper(new THREE.Vector3(...axes[i]).normalize(),new THREE.Vector3(),32,0xffd57a,7,3);h.add(ax);const ball=new THREE.Mesh(new THREE.SphereGeometry(3.2,10,8),new THREE.MeshBasicMaterial({color:0xffd57a}));h.add(ball);g.add(h);helpers[i]=h;h.visible=false;}});state.rigs[side]={root,groups,helpers};}for(const body of model.bodies){const geo=new THREE.BufferGeometry();const raw=new Float32Array(bin,body.positionOffset,body.vertexCount*3);geo.setAttribute('position',new THREE.BufferAttribute(raw.slice(),3));geo.setIndex(new THREE.BufferAttribute(new Uint32Array(bin,body.indexOffset,body.indexCount).slice(),1));geo.computeVertexNormals();const material=new THREE.MeshStandardMaterial({color:0x9ca6b3,roughness:.55,metalness:.3,side:THREE.DoubleSide});const mesh=new THREE.Mesh(geo,material);mesh.userData={body,side};mesh.visible=body.solid!==false;state.meshes.push(mesh);}}rebuildRig();}
function rebuildRig(){for(const side of ['R','L']){const rig=state.rigs[side];config[side].joints.forEach((j,g)=>{const p=parents[g]<0?j.pivot:config[side].joints[parents[g]].pivot;rig.groups[g].position.set(...j.pivot.map((v,i)=>v-p[i]));if(rig.helpers[g]){rig.helpers[g].children[0].setDirection(new THREE.Vector3(...j.axis).normalize());}});}for(const mesh of state.meshes){const {body,side}=mesh.userData;const g=body.group;mesh.userData.group=g;state.rigs[side].groups[g].add(mesh);mesh.position.set(...config[side].joints[g].pivot.map(v=>-v));
// Group zero is the base; subtract its native pivot exactly as for all children.
mesh.material.color.set(mesh.userData.body.role==='palm-marker'?'#f4ce77':mesh.userData.body.role==='back-marker'?'#3f506b':$('colors').checked?(g===0?'#77818e':palette[(g-1)%palette.length]):'#9aa6b6');}applyPose();}
function applyPose(original=false){if(!config||!state.rigs.R)return;for(const side of ['R','L']){const row=rowFor(side,original);const rig=state.rigs[side];rig.root.visible=state.side==='both'||state.side===side;rig.root.position.x=state.side==='both'?(side==='R'?180:-180):0;config[side].joints.forEach((j,g)=>{const angle=$('cad').checked||j.motor<0||(state.solo>=0&&j.motor!==state.solo)?0:(row[j.motor]-config[side].zero[j.motor])*2*Math.PI/config.resolution*j.gain;rig.groups[g].quaternion.setFromAxisAngle(new THREE.Vector3(...j.axis).normalize(),angle);});}$('left-label').textContent=`元の動き · ${state.elapsed.toFixed(2)}秒 · 1×`;$('right-label').textContent=`修正後 · ${state.elapsed.toFixed(2)}秒`;}
function setTime(seconds){state.elapsed=Math.max(0,Math.min(timing?.duration??frameCount()/30,seconds));updateReadout();}
function setFrame(f){const side=state.chartSide;setTime(timing?timing.clocks[side].timeAtFrame(f)+timing.delays[side]:f/30);}
function updateReadout(){
 state.originalFrameFloat=Math.min(frameCount()-1,state.elapsed*30);state.frameFloat=sourceFrame(state.chartSide);state.frame=Math.floor(state.frameFloat);
 applyPose();const editorSide=speedEditor?.selectedSide()??'R';speedEditor?.cursor(sourceFrame(editorSide),frameCount(),editorSide);
 const outputFrame=Math.min(+$('timeline').max,Math.floor(state.elapsed*30));$('timeline').value=outputFrame;$('time').textContent=state.elapsed.toFixed(2);$('frame').textContent=`Frame ${outputFrame+1} / ${+$('timeline').max+1}`;
 const row=rowFor(state.chartSide);row.forEach((v,i)=>{const el=$('value-'+i);if(el)el.textContent=Math.round(v);});drawChart();torquePlot?.updateTime(state.elapsed);loadPanel?.updateCursor({originalFrame:state.originalFrameFloat,editedTime:state.elapsed});
}
function setClip(clip){
 sequenceEditor?.markInactive();
 state.clip=clip;$('save-motion-name').value=(motions.metadata?.[clip]?.name||'Motion '+clip)+'（編集）';state.playing=false;$('play').textContent='再生';document.querySelectorAll('[data-clip]').forEach(b=>b.classList.toggle('selected',b.dataset.clip===clip));
 $('custom-motion').value=motions.metadata?.[clip]?clip:'';$('clip-info').textContent=motions.metadata?.[clip]?.description||(clip==='3'?'左右の腕が動く記録':'主に右腕が動く記録');
 smoothing?.setClip(clip);speedEditor.setClip(clip,frameCount()/30);delayEditor.setClip(clip);rebuildTiming();setTime(0);
 if($('autofit').checked){if(Number.isInteger(motions.metadata?.[clip]?.previewFrame)){setFrame(motions.metadata[clip].previewFrame);fit();setTime(0);}else fit();}
 $('status').textContent=`${motions.metadata?.[clip]?.name||'Motion '+clip} · 右 ${motions.clips[clip].R.length} / 左 ${motions.clips[clip].L.length} フレーム`;loadPanel?.invalidate();
}
function makeReadings(){const n=state.chartSide==='R'?9:8,base=state.chartSide==='R'?1:11;$('motor-values').innerHTML=Array.from({length:n},(_,i)=>`<div class="motor"><em><i style="background:${palette[i]}"></i>ID ${base+i}</em><b id="value-${i}">—</b></div>`).join('');updateReadout();}
function drawChart(){if(!motions)return;const canvas=$('chart'),ctx=canvas.getContext('2d'),w=canvas.clientWidth,h=145,dpr=Math.min(devicePixelRatio,2);if(!w)return;if(canvas.width!==Math.round(w*dpr)||canvas.height!==h*dpr){canvas.width=w*dpr;canvas.height=h*dpr;}ctx.setTransform(dpr,0,0,dpr,0,0);ctx.clearRect(0,0,w,h);const rows=smoothing?smoothing.rows(state.clip,state.chartSide):motions.clips[state.clip][state.chartSide],min=Math.floor(Math.min(...rows.flat())/500)*500,max=Math.ceil(Math.max(...rows.flat())/500)*500||1,L=37,R=w-7,T=8,B=h-22;const X=f=>L+f/(frameCount()-1)*(R-L),Y=v=>B-(v-min)/(max-min)*(B-T);ctx.font='10px -apple-system,sans-serif';ctx.textBaseline='middle';for(let k=0;k<=2;k++){const v=min+(max-min)*k/2,y=Y(v);ctx.strokeStyle='#34404d';ctx.beginPath();ctx.moveTo(L,y);ctx.lineTo(R,y);ctx.stroke();ctx.fillStyle='#a4b1c3';ctx.fillText(Math.round(v),0,y);}for(let k=0;k<=3;k++){const f=(frameCount()-1)*k/3;ctx.fillStyle='#a4b1c3';ctx.fillText((f/30).toFixed(1),X(f)-6,h-8);}rows[0].forEach((_,col)=>{ctx.strokeStyle=palette[col];ctx.lineWidth=1.3;ctx.beginPath();rows.forEach((r,i)=>i?ctx.lineTo(X(i),Y(r[col])):ctx.moveTo(X(i),Y(r[col])));ctx.stroke();});ctx.strokeStyle='#ffffff';ctx.lineWidth=1;ctx.beginPath();ctx.moveTo(X(sourceFrame(state.chartSide)),T);ctx.lineTo(X(sourceFrame(state.chartSide)),B);ctx.stroke();}
function buildCalibration(){const side=$('cal-side').value,c=config[side],base=side==='R'?1:11;$('resolution').value=config.resolution;$('zero-inputs').innerHTML=c.zero.map((v,i)=>`<label>ID ${base+i} 基準<input type="number" data-zero="${i}" value="${v}" step="1"></label>`).join('');$('mapping').innerHTML=c.joints.slice(1).map((j,k)=>{const g=k+1;return `<tr><td><span style="color:${palette[k%9]}">●</span> ${names[g]}</td><td><select data-j="${g}" data-field="motor"><option value="-1" ${j.motor===-1?'selected':''}>固定</option>${c.zero.map((_,i)=>`<option value="${i}" ${j.motor===i?'selected':''}>${base+i}</option>`).join('')}</select></td><td><input type="number" step="0.1" data-j="${g}" data-field="gain" value="${j.gain}"></td><td>${j.axis.map((v,i)=>`<input aria-label="${names[g]} 軸 ${'XYZ'[i]}" type="number" step="0.1" data-j="${g}" data-field="axis" data-i="${i}" value="${v}">`).join('')}</td><td>${j.pivot.map((v,i)=>`<input aria-label="${names[g]} 位置 ${'XYZ'[i]}" type="number" step="1" data-j="${g}" data-field="pivot" data-i="${i}" value="${v}">`).join('')}</td></tr>`;}).join('');}
function showModelInfo(notice=''){
 const simple=model.kind==='simple';$('model-status').textContent=simple?'簡易モデル · 関節動作は共通 · 指固定':`${model.bodies.length}部品 · 詳細CAD（ローカル） · 指固定`;
 $('model-notice').textContent=notice|| (simple?'腕は箱・棒・球、手首より先は元のCAD形状で表示しています。関節動作と負荷計算は詳細版と共通です。':'');
 $('hand-shells').disabled=simple;
}
async function switchDisplayModel(){
 const token=++modelRevision,mode=$('model-mode').value;$('reload-model').disabled=true;
 try{try{localStorage.setItem(modelModeKey,mode);}catch{}const next=await loadDisplayModel(mode);if(token!==modelRevision)return;
  if(state.selected)state.selected=null;for(const mesh of state.meshes){mesh.removeFromParent();mesh.geometry.dispose();mesh.material.dispose();}state.meshes=[];model=next.model;loadColorsApplied=false;makeRigs(next.bin,true);updateMeshVisibility();showModelInfo(next.notice);$('body-selection').textContent='部品を選択すると所属リンクを確認できます。';
  massShapes=await loadMassProperties();loadPanel?.dispose();initLoadAnalysis();loadPanel.invalidate();updateReadout();if(window.previewDebug)window.previewDebug.model=model;
 }finally{if(token===modelRevision)$('reload-model').disabled=false;}
}
function updateMeshVisibility(){for(const m of state.meshes){const b=m.userData.body;const shell=['ボディ174','ボディ175'].includes(b.source);m.visible=(b.solid!==false)&&!(shell&&$('hand-shells').checked);if(['ボディ124','ボディ126'].includes(b.source))m.material.emissive.set($('hand-shells').checked?0x994400:0);}}
function selectBody(mesh){if(state.selected)state.selected.material.emissive.set(0);state.selected=mesh;mesh.material.emissive.set(0x524620);const {body,group}=mesh.userData;$('body-selection').textContent=`選択：${body.component} / ${body.name} → ${names[group]}${model.kind==='simple'?'（簡易表示の所属）':'（Fusionの所属を使用）'}`;$('status').textContent=`${body.component} / ${body.name}`;}
function fit(hand=false,front=false){
 if(!camera||!state.rigs.R)return;
 scene.updateMatrixWorld(true);
 const box=new THREE.Box3();
 for(const original of [true,false]){applyPose(original);scene.updateMatrixWorld(true);for(const side of ['R','L']){const rig=state.rigs[side];if(!rig.root.visible)continue;if(hand){if(state.side==='both'&&side==='L')continue;box.union(new THREE.Box3().setFromObject(rig.groups[7]));}else box.union(new THREE.Box3().setFromObject(rig.root));}}
 if(box.isEmpty())return;
 const center=box.getCenter(new THREE.Vector3()),size=box.getSize(new THREE.Vector3());
 const radius=Math.max(size.length()/2,40),halfFov=THREE.MathUtils.degToRad(camera.fov/2),hfov=Math.atan(Math.tan(halfFov)*camera.aspect);
 const distance=radius/Math.sin(Math.min(halfFov,hfov))*1.08;
 const direction=front?new THREE.Vector3(0,.08,1):camera.position.clone().sub(controls.target).normalize();
 controls.target.copy(center);camera.position.copy(center).addScaledVector(direction,distance);controls.update();
}

// Loads describe the full recording, independently of display-only input isolation.
function initLoadAnalysis(){
 loadPanel=createLoadPanel($('load-editor'),{shapes:massShapes,motorSpecs,motorMapping,
  getInputs:()=>({clip:state.clip,config,rate:1,curves:timing?.curves,delays:timing?.delays,curve:speedEditor.snapshot(),rows:Object.fromEntries(['R','L'].map(side=>[side,{original:motions.clips[state.clip][side],edited:smoothing.rows(state.clip,side)}]))}),
  onSeek:(frame,details)=>{state.playing=false;$('play').textContent='再生';setTime(details.time);},
  onHeatChange:()=>{},onResults:()=>{updateLoadVerdict();torquePlot?.setResults(loadPanel?.getResults(),loadPanel?.getMotorAssessment());}
 });
}
function updateLoadVerdict(){
 const el=$('load-edit-verdict');if(!el)return;
 const report=loadPanel?.getMotorAssessment(),invalid=loadPanel?.hasInvalidSettings();
 const en=document.documentElement.lang==='en';
 el.dataset.state=invalid?'over':report?.status??'pending';
 el.textContent=invalid?(en?'ERROR: Invalid load settings':'ERROR: 負荷設定の入力を確認してください'):!report?.motors.every(m=>m.available)?(en?'Recalculating estimated loads…':'推定負荷を再計算中…'):report.over.length?`ERROR: ${report.over.map(m=>`${m.id} ${(m.ratio*100).toFixed(0)}%`).join(', ')} · ${en?'Torque limit exceeded; saving/export blocked':'許容負荷超過・保存と書き出し不可'}`:report.warnings?.length?`WARNING: ${report.warnings.map(m=>`${m.id} ${(m.ratio*100).toFixed(0)}%`).join(', ')} · ${en?'Near configured torque limit':'設定した警告割合を超過'}`:report.missing.length?(en?'Unassessed: some motor limits are unset':'未判定：許容負荷が未設定のモーターがあります'):(en?'Estimated loads within configured limits':'推定負荷は設定した許容値内');
}
async function validateOutput(recording){
 if(!loadPanel)throw Error('ERROR: 負荷計算の準備ができていません');
 return loadPanel.assertRecording(recording);
}
const loadLow=new THREE.Color('#6aa5df'),loadMiddle=new THREE.Color('#edc86d'),loadHigh=new THREE.Color('#ec7965');
let loadColorsApplied=false;
function paintLoadColors(original){
 const altered=$('cad').checked||state.solo>=0,ready=!!loadPanel?.getResults(),heat=ready&&!altered&&loadPanel.isHeatEnabled();
 const frame=original?state.originalFrameFloat:state.frameFloat;
 if(heat){
  const colors={};for(const side of ['R','L'])colors[side]=loadPanel.heatAtTime(side,original,state.elapsed).map(t=>new THREE.Color().lerpColors(t<.5?loadLow:loadMiddle,t<.5?loadMiddle:loadHigh,t<.5?t*2:(t-.5)*2));
  for(const mesh of state.meshes){const g=mesh.userData.group;if(g)mesh.material.color.copy(colors[mesh.userData.side][g-1]);}
  loadColorsApplied=true;
 }else if(loadColorsApplied){for(const mesh of state.meshes){const g=mesh.userData.group;mesh.material.color.set(mesh.userData.body.role==='palm-marker'?'#f4ce77':mesh.userData.body.role==='back-marker'?'#3f506b':$('colors').checked?(g===0?'#77818e':palette[(g-1)%palette.length]):'#9aa6b6');}loadColorsApplied=false;}
 const label=$(original?'load-live-original':'load-live-edited');
 if(label){if(altered)label.textContent='表示条件が異なります';else if(!ready)label.textContent='— N·m';else{const sides=state.side==='both'?['R','L']:[state.side];const peak=Math.max(...sides.flatMap(side=>loadPanel.currentAtTime(side,original,state.elapsed).map(Math.abs)));label.textContent=peak.toFixed(2)+' N·m';}}
}

async function exportMotion(side){
 try{const candidate=editedSequenceSource().clip,clip=state.clip;await validateOutput(candidate);const files={},summary=[];
 for(const arm of side?[side]:['R','L']){const rows=candidate[arm];files[`${motions.metadata?.[clip]?.exportStem||'Motion'+clip}${arm}.csv`]=toCSV(rows);summary.push(`${arm==='R'?'右':'左'} ${rows.length}行・${(rows.length/motions.fps).toFixed(2)}秒`);}
 if(side)downloadFile(`${motions.metadata?.[clip]?.exportStem||'Motion'+clip}${side}.csv`,Object.values(files)[0],'text/csv;charset=utf-8');else downloadFile(`${motions.metadata?.[clip]?.exportStem||'Motion'+clip}_edited.zip`,zipFiles(files),'application/zip');
 $('export-status').textContent=`書き出しました：${summary.join(' ／ ')}`;
 }catch(e){$('export-status').textContent='書き出せません：'+e.message;}
}
function registerMotion(id,motion){const slot=document.querySelector(`[data-clip="${id}"]`);if(slot){slot.disabled=false;slot.textContent='Motion '+id.split('-').at(-1);slot.title=motion.name;}motions.clips[id]={R:motion.R,L:motion.L};motions.metadata??={};motions.metadata[id]={name:motion.name,description:motion.description,exportStem:motion.exportStem,previewFrame:motion.previewFrame,bakedEdits:motion.bakedEdits};let option=[...$('custom-motion').options].find(o=>o.value===id);if(!option){option=document.createElement('option');option.value=id;$('custom-motion').appendChild(option);}option.textContent=motion.name;if(id.startsWith('saved-')||id.startsWith('sequence-'))option.dataset.noTranslate='';sequenceEditor?.refreshSources();}
function editedSequenceSource(){
 if(Math.ceil(timing.editedDuration*30-1e-9)>10000)throw Error('保存できる動きは約333秒までです。速度設定を見直してください。');
 const name=(motions.metadata?.[state.clip]?.name||'Motion '+state.clip)+'（編集）',clip={format:'augmented-arms-motion',version:1,fps:30,name,bakedEdits:true};
 for(const side of ['R','L'])clip[side]=exportRows(smoothing.rows(state.clip,side),frameCount(),timing.curves[side],30,{delaySeconds:timing.delays[side],durationSeconds:timing.editedDuration});
 return {name,clip};
}
async function initializeSequenceEditor(){
 sequenceEditor=await createSequenceEditor($('sequence-editor'),{
  getSources:()=>Object.entries(motions.clips).filter(([id])=>!id.startsWith('sequence-preview-')).map(([id,clip])=>({id,clip,name:motions.metadata?.[id]?.name||'Motion '+id})),
  getEdited:editedSequenceSource,
  onPreview(recording){
   if(sequencePreviewId){delete motions.clips[sequencePreviewId];delete motions.metadata[sequencePreviewId];[...$('custom-motion').options].find(o=>o.value===sequencePreviewId)?.remove();}
   const id='sequence-preview-'+crypto.randomUUID();registerMotion(id,validateRecording(recording));sequencePreviewId=id;sequenceActiveId=id;setClip(id);
  },
  async onSave(recording){
   await validateOutput(recording);
   recording.name=uniqueMotionName(recording.name,Object.entries(motions.metadata??{}).filter(([id])=>!id.startsWith('sequence-preview-')).map(([,m])=>m.name));
   recording.exportStem='Sequence_'+Date.now();const id='saved-'+crypto.randomUUID();
   await storeSavedMotion({id,createdAt:Date.now(),recording});registerMotion(id,validateRecording(recording));sequenceActiveId=id;setClip(id);
   downloadFile(recording.name.replace(/[\\/:*?"<>|\x00-\x1f]/g,'_')+'.motion.json',JSON.stringify(recording),'application/json');
  },
  onSeek(seconds){if(sequenceActiveId&&motions.clips[sequenceActiveId]){state.playing=false;$('play').textContent='再生';setTime(seconds);}}
 });
}
async function saveNamedMotion(){
 const button=$('save-motion'),status=$('save-motion-status');if(button.disabled)return;button.disabled=true;
 try{
  const name=uniqueMotionName($('save-motion-name').value,Object.values(motions.metadata??{}).map(m=>m.name));
  if(Math.ceil(timing.editedDuration*30-1e-9)>10000)throw Error('保存できる動きは約333秒までです。速度設定を見直してください。');
  const id='saved-'+crypto.randomUUID(),stem='SavedMotion_'+new Date().toISOString().replace(/[^0-9]/g,'').slice(0,17);
  const recording={format:'augmented-arms-motion',version:1,fps:30,name,description:'速度・時間差・平滑化を反映して保存した動き',exportStem:stem,bakedEdits:true};
  for(const side of ['R','L'])recording[side]=exportRows(smoothing.rows(state.clip,side),frameCount(),timing.curves[side],30,{delaySeconds:timing.delays[side],durationSeconds:timing.editedDuration});
  const validated=validateRecording(recording);await validateOutput(recording);await storeSavedMotion({id,createdAt:Date.now(),recording});registerMotion(id,validated);setClip(id);
  downloadFile(name.replace(/[\\/:*?"<>|\x00-\x1f]/g,'_')+'.motion.json',JSON.stringify(recording),'application/json');
  status.textContent='保存してリストに追加しました：'+name;
 }catch(error){status.textContent='保存できません：'+error.message;}finally{button.disabled=false;}
}
async function importMotion(){const input=$('motion-file');try{const motion=await readMotionFiles([...input.files]);if(!motion)return;let hash=2166136261;for(const ch of JSON.stringify([motion.R,motion.L]))hash=Math.imul(hash^ch.charCodeAt(0),16777619);const matching=Object.keys(motions.clips).find(key=>JSON.stringify([motions.clips[key].R,motions.clips[key].L])===JSON.stringify([motion.R,motion.L]));const target=$('record-target').value,id=target||matching||'file-'+(hash>>>0).toString(16);if(target){await storeSavedMotion({id,createdAt:Date.now(),recording:{format:'augmented-arms-motion',version:1,fps:30,...motion}},{replace:true});registerMotion(id,motion);}else if(!motions.clips[id])registerMotion(id,motion);setClip(id);$('motion-file-status').textContent='読み込みました：'+motion.name;}catch(e){$('motion-file-status').textContent='読み込めません：'+e.message;}finally{input.value='';}}
function oscFrame(){
 const ready=!!loadPanel?.getResults(),arms={};
 for(const side of ['R','L']){const row=rowFor(side);arms[side]={counts:row.map(Math.round),angles:config[side].joints.slice(1).map(j=>j.motor<0?0:(row[j.motor]-config[side].zero[j.motor])*2*Math.PI/config.resolution*j.gain),torque:ready?loadPanel.currentAtTime(side,false,state.elapsed):null};}
 return {time:state.elapsed,playing:state.playing,arms};
}
function initializePanelFolds(){
 let saved={};try{saved=JSON.parse(localStorage.getItem('shosaedit-panel-folds-v1'))||{};}catch{}
 document.querySelectorAll('aside>section').forEach((section,index)=>{
  const heading=section.querySelector('h2');if(!heading)return;
  const id=section.id||'panel-'+index,details=document.createElement('details'),summary=document.createElement('summary');
  details.className='panel-fold';details.open=saved[id]!==false;summary.textContent=heading.textContent;
  section.before(details);details.append(summary,section);
  details.addEventListener('toggle',()=>{saved[id]=details.open;try{localStorage.setItem('shosaedit-panel-folds-v1',JSON.stringify(saved));}catch{}});
 });
}
function bind(){$('model-mode').onchange=switchDisplayModel;$('reload-model').onclick=switchDisplayModel;$('save-motion').onclick=saveNamedMotion;$('save-motion-name').onkeydown=e=>{if(e.key==='Enter'){e.preventDefault();saveNamedMotion();}};$('motion-file').onchange=importMotion;$('custom-motion').onchange=e=>{if(e.target.value)setClip(e.target.value);};$('export-pair').onclick=()=>exportMotion();$('export-right').onclick=()=>exportMotion('R');$('export-left').onclick=()=>exportMotion('L');document.querySelectorAll('[data-clip]').forEach(b=>b.onclick=()=>setClip(b.dataset.clip));$('play').onclick=()=>{if(!state.playing&&state.elapsed>=timing.duration)setTime(0);state.playing=!state.playing;$('play').textContent=state.playing?'一時停止':'再生';};$('timeline').oninput=e=>{state.playing=false;$('play').textContent='再生';setTime(+e.target.value/30);};for(const [id,delta] of [['prev',-1],['next',1]])$(id).onclick=()=>{state.playing=false;$('play').textContent='再生';setTime(state.elapsed+delta/30);};$('rewind').onclick=()=>setTime(0);$('loop').onchange=e=>state.loop=e.target.checked;$('side').onchange=e=>{state.side=e.target.value;applyPose();fit();};$('chart-side').onchange=e=>{state.chartSide=e.target.value;makeReadings();};$('cad').onchange=()=>{applyPose();if($('autofit').checked)fit();};$('autofit').onchange=()=>{if($('autofit').checked)fit();};$('solo').onchange=e=>{state.solo=+e.target.value;applyPose();};$('colors').onchange=rebuildRig;$('hand-shells').onchange=updateMeshVisibility;$('axes').onchange=e=>Object.values(state.rigs).forEach(r=>r.helpers.forEach(h=>{if(h)h.visible=e.target.checked;}));$('fit').onclick=()=>{$('autofit').checked=true;fit();};$('hand').onclick=()=>{$('autofit').checked=false;fit(true);};$('front').onclick=()=>fit(false,true);$('cal-side').onchange=buildCalibration;$('resolution').onchange=e=>{const v=+e.target.value;if(v>0){config.resolution=v;persist();applyPose();}};$('zero-inputs').onchange=e=>{if(e.target.dataset.zero!==undefined){const v=+e.target.value;if(Number.isFinite(v)){config[$('cal-side').value].zero[+e.target.dataset.zero]=v;persist();applyPose();}}};$('mapping').onchange=e=>{const t=e.target;if(!t.dataset.field)return;const side=$('cal-side').value,j=config[side].joints[+t.dataset.j],v=+t.value;if(!Number.isFinite(v))return;if(t.dataset.i!==undefined){j[t.dataset.field][+t.dataset.i]=v;if(t.dataset.field==='axis'&&Math.hypot(...j.axis)<1e-6){j.axis=[1,0,0];buildCalibration();}}else j[t.dataset.field]=v;persist();rebuildRig();};$('set-zero').onclick=()=>{const side=$('cal-side').value;config[side].zero=[...rowFor(side)];persist();buildCalibration();applyPose();};$('reset').onclick=()=>{config=freshConfig();persist();buildCalibration();rebuildRig();};$('save-config').onclick=()=>{const a=document.createElement('a');a.href=URL.createObjectURL(new Blob([JSON.stringify(config,null,2)],{type:'application/json'}));a.download='arm-calibration.json';a.click();setTimeout(()=>URL.revokeObjectURL(a.href),1000);};$('import-config').onchange=async e=>{try{config=validConfig(JSON.parse(await e.target.files[0].text()));config.bodyGroups??={};for(const g of Object.values(config.bodyGroups))if(!Number.isInteger(g)||g<0||g>7)throw Error('部品対応が不正です');persist();buildCalibration();rebuildRig();$('status').textContent='設定を読み込みました';}catch(err){$('status').textContent='読み込めません：'+err.message;}};window.addEventListener('keydown',e=>{if(['INPUT','SELECT','TEXTAREA'].includes(document.activeElement.tagName))return;if(e.code==='Space'){e.preventDefault();$('play').click();}if(e.code==='ArrowRight')$('next').click();if(e.code==='ArrowLeft')$('prev').click();});$('chart').onclick=e=>{const r=e.target.getBoundingClientRect();state.playing=false;$('play').textContent='再生';setFrame((e.clientX-r.left-37)/(r.width-44)*(frameCount()-1));};}
function renderComparison(){
 const w=$('viewport').clientWidth,h=$('viewport').clientHeight,half=Math.floor(w/2);
 renderer.setScissorTest(true);
 for(const original of [true,false]){const x=original?0:half,width=original?half:w-half;renderer.setViewport(x,0,width,h);renderer.setScissor(x,0,width,h);applyPose(original);paintLoadColors(original);renderer.render(scene,camera);}
 renderer.setScissorTest(false);renderer.setViewport(0,0,w,h);
 renderer.domElement.dataset.renderedPose=[state.clip,state.frame,state.side].join(':');
}
function animate(t){requestAnimationFrame(animate);const dt=last?Math.min((t-last)/1000,.1):0;last=t;if(state.playing){state.elapsed+=dt;if(state.elapsed>=timing.duration){if(state.loop)state.elapsed%=timing.duration;else{state.elapsed=timing.duration;state.playing=false;$('play').textContent='再生';}}updateReadout();}controls.update();renderComparison();}
async function load(url,type='json'){const r=await fetch(url,{cache:'no-store'});if(!r.ok)throw Error(`${url} (${r.status})`);return type==='json'?r.json():r.arrayBuffer();}
try{[motions,initialGeometry,massShapes,motorSpecs,motorMapping]=await Promise.all([load('motions.json'),loadDisplayModel(preferredModelMode()),loadMassProperties(),load('motor-specs.json'),load('motor-models.json')]);model=initialGeometry.model;config=freshConfig();try{const s=localStorage.getItem(savedKey);if(s)config=validConfig(JSON.parse(s));}catch{}// Correct the untouched right elbow convention: the main horn faces -X.
// Preserve custom calibration and leave the unverified mirrored left arm alone.
if(!config.rightElbowDirectionV1){const j=config.R.joints[4];if(j.motor===3&&j.gain===1&&j.axis.join(',')==='1,0,0')j.axis=[-1,0,0];config.rightElbowDirectionV1=true;persist();}
// Joint 2 holds the output shaft in link_1 and moves the case with link_2.
// Reverse the case motion relative to the original output-shaft convention.
if(!config.rightShoulderDirectionV1){const j=config.R.joints[2];if(j.motor===1&&j.gain===1&&j.axis.join(',')==='1,0,0')j.axis=[-1,0,0];config.rightShoulderDirectionV1=true;persist();}
const bin=initialGeometry.bin;initScene();makeRigs(bin);speedEditor=createSpeedEditor($('speed-editor'),timingChanged);delayEditor=createArmDelayEditor($('delay-editor'),timingChanged);smoothing=createSmoothing($('smoothing-editor'),motions,()=>{updateReadout();loadPanel?.invalidate();});smoothing.setClip(state.clip);const library=await load('generated-motions.json');const loadedLibrary=await Promise.all(library.map(async entry=>({id:entry.id,motion:validateRecording(await load(entry.file))})));for(const entry of loadedLibrary)registerMotion(entry.id,entry.motion);
try{for(const entry of await listSavedMotions()){try{registerMotion(entry.id,validateRecording(entry.recording));}catch{}}}catch{$('save-motion-status').textContent='保存済みの動きを読み込めませんでした。再読み込みしてください。';}
torquePlot=createLiveTorquePlot($('torque-live'),{onSeek:seconds=>{state.playing=false;$('play').textContent='再生';setTime(seconds);}});bind();$('language').addEventListener('change',updateLoadVerdict);buildCalibration();chartReady=true;initLoadAnalysis();makeReadings();setClip('1');await initializeSequenceEditor();createOSCStream($('udp-editor'),{getFrame:oscFrame});initializePanelFolds();$('loading').remove();$('model-mode').value=preferredModelMode();showModelInfo(initialGeometry.notice);window.previewDebug={state,config:()=>config,model,motions,scene,renderer};requestAnimationFrame(animate);}catch(e){$('loading').textContent='読み込みに失敗しました：'+e.message;$('status').textContent='起動用ファイルから開いてください';console.error(e);}
