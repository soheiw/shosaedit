import * as THREE from './vendor/three.module.js';

// Visual workspace boundary, not a collision detector or a hardware interlock.
export function createExclusionBox(scene,host){
 const key='shosaedit-exclusion-box-v1';
 const defaults={enabled:true,x:0,y:300,z:0,width:250,height:550,depth:250};
 let settings={...defaults};
 try{const saved=JSON.parse(localStorage.getItem(key)||'null');if(saved){if(typeof saved.enabled==='boolean')settings.enabled=saved.enabled;for(const k of ['x','y','z','width','height','depth'])if(Number.isFinite(saved[k])&&(k.length===1||saved[k]>0))settings[k]=saved[k];}}catch{}
 const group=new THREE.Group();group.name='exclusion-box';
 const geo=new THREE.BoxGeometry(1,1,1);
 const mesh=new THREE.Mesh(geo,new THREE.MeshBasicMaterial({color:0xff544f,transparent:true,opacity:.12,depthWrite:false,side:THREE.DoubleSide}));
 const edges=new THREE.LineSegments(new THREE.EdgesGeometry(geo),new THREE.LineBasicMaterial({color:0xff655f,transparent:true,opacity:.95}));
 group.add(mesh,edges);scene.add(group);let both=true;
 const en=()=>document.documentElement.lang==='en';
 const fields=[['x','中心・左右（右＋）','Center right (+)'],['y','中心・上下（下＋）','Center down (+)'],['z','中心・前後（前＋）','Center front (+)'],['width','幅','Width'],['height','高さ','Height'],['depth','奥行き','Depth']];
 host.innerHTML='<h2 data-box-title></h2><label><input id="exclusion-box-enabled" type="checkbox"><span data-box-visible></span></label><div style="display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:6px">'+fields.map(([k])=>`<label style="min-width:0"><span data-box-label="${k}"></span> <input id="exclusion-box-${k}" type="number" step="10" ${k.length>1?'min="1"':''} style="width:100%;box-sizing:border-box"></label>`).join('')+'</div><button type="button" id="exclusion-box-reset"></button><p data-box-note class="curve-help"></p>';
 const $=s=>host.querySelector(s);
 function labels(){ $('[data-box-title]').textContent=en()?'Exclusion volume':'侵入禁止領域';$('[data-box-visible]').textContent=en()?'Show box between arms':'腕の間に直方体を表示';for(const [k,ja,eng]of fields)$(`[data-box-label="${k}"]`).textContent=(en()?eng:ja)+' mm';$('#exclusion-box-reset').textContent=en()?'Reset to between arms':'腕の間の初期位置に戻す';$('[data-box-note]').textContent=en()?'Visual guide only; does not block playback or export. Dimensions are provisional. Shown in both-arm view; saved in this browser.':'表示用の目安です。再生・書き出しを自動停止する機能ではありません。初期寸法は仮値です。左右表示時に表示し、設定はこのブラウザに保存します。';}
 function update(){group.position.set(settings.x,settings.y,settings.z);group.scale.set(settings.width,settings.height,settings.depth);group.visible=settings.enabled&&both;}
 function save(){try{localStorage.setItem(key,JSON.stringify(settings));}catch{}update();}
 function fill(){for(const [k]of fields)$('#exclusion-box-'+k).value=settings[k];$('#exclusion-box-enabled').checked=settings.enabled;update();}
 for(const [k]of fields){const input=$('#exclusion-box-'+k);input.addEventListener('input',()=>{const v=input.valueAsNumber;if(!Number.isFinite(v)||(k.length>1&&v<=0)){input.setCustomValidity('有効な寸法・位置を入力してください');return;}input.setCustomValidity('');settings[k]=v;save();});}
 $('#exclusion-box-enabled').onchange=e=>{settings.enabled=e.target.checked;save();};
 $('#exclusion-box-reset').onclick=()=>{settings={...defaults};fill();save();};
 document.querySelector('#language')?.addEventListener('change',labels);labels();fill();
 return {setBoth(value){both=value;update();}};
}
