import {composeSequence} from './motion-sequence.js';
import {validateRecording} from './motion-files.js';

const labels={
 title:['動作をつなぐ','Motion sequence'],source:['追加する動作','Source motion'],add:['元データを追加','Add original'],
 edited:['現在の修正後を追加','Add current edited motion'],name:['連結後の名前','Sequence name'],
 start:['開始（秒）','Start (s)'],end:['終了（秒）','End (s)'],join:['次へのつなぎ（秒）','Transition to next (s)'],
 up:['上へ','Move up'],down:['下へ','Move down'],remove:['削除','Remove'],clear:['すべて外す','Remove all'],
 preview:['連結してプレビュー','Preview sequence'],save:['連結して保存','Save sequence'],
 jump:['つなぎ目前へ（元の時間）','Before join (original)'],empty:['動作を追加すると、ここに順番が並びます。','Add motions to arrange them here.'],
 help:['JSONや左右CSVを「ファイルを開く」で読み込み、ここに追加できます。元データの追加は速度・平滑化を適用しません。修正を含める場合は「現在の修正後を追加」を使います。','Import JSON or paired CSVs with Open motion file, then add them here. Add original uses raw data; use Add current edited motion to include your edits.'],
 trimHelp:['終了時刻の直前までを使用します。つなぎ時間は間に追加されます。0秒なら直接切り替えます。最後の動作に後続のつなぎはありません。','End is exclusive. Transition time is inserted between clips; zero makes a direct cut. No transition follows the last clip.'],
 basis:['同じモーター列・基準姿勢の記録を使ってください。つなぎは関節値の補間で、撮影間の基準合わせは自動では行いません。','Use recordings with matching motor columns and reference poses. Joins interpolate motor values; recording calibration is not aligned automatically.'],
 draft:['並べ方と切り出し範囲は、このブラウザに下書き保存されます。完成した動きはJSONや左右CSVで書き出せます。','The arrangement and trim ranges are saved as a draft in this browser. Export the completed motion as JSON or paired CSVs.'],
 ready:['連結結果をリストに追加して表示しました。','Sequence added to the list and displayed.'],
 saved:['連結結果を保存し、リストに追加しました。','Sequence saved and added to the list.'],
 invalid:['入力値を確認してください。','Check the input values.'],
 draftError:['下書きを保存できません。完成した動きはJSONで保存してください。','Could not save the draft. Save the completed motion as JSON.'],
 loadError:['下書きを復元できませんでした。','Could not restore the draft.'],
 EMPTY_SEQUENCE:['動作を1つ以上追加してください。','Add at least one motion.'],
 INVALID_SEGMENT:['動作の設定を確認してください。','Check the segment settings.'],
 INVALID_DATA:['右9列・左8列の整数データが必要です。','Motion data must have 9 right and 8 left integer columns.'],
 INVALID_TRIM:['開始・終了時刻を確認してください。','Check the start and end times.'],
 INVALID_TRANSITION:['つなぎ時間は0〜10秒にしてください。','Transition time must be between 0 and 10 seconds.'],
 TOO_LONG:['全体を10,000フレーム（約333秒）以内にしてください。','Keep the sequence within 10,000 frames (about 333 seconds).'],
 TOO_SHORT:['全体で2フレーム以上必要です。','The sequence needs at least two frames.']
};
async function draftDB(){
 return new Promise((resolve,reject)=>{const request=indexedDB.open('shosaedit-sequence-drafts',1);
 request.onupgradeneeded=()=>request.result.createObjectStore('drafts',{keyPath:'id'});
 request.onsuccess=()=>resolve(request.result);request.onerror=()=>reject(request.error);
 request.onblocked=()=>reject(Error('Draft storage blocked'));});
}
async function draftIO(value){
 const db=await draftDB();try{return await new Promise((resolve,reject)=>{
 const tx=db.transaction('drafts',value?'readwrite':'readonly'),store=tx.objectStore('drafts');
 const request=value?store.put({id:'current',...value}):store.get('current');
 tx.oncomplete=()=>resolve(value??request.result);tx.onerror=()=>reject(tx.error);tx.onabort=()=>reject(tx.error);
 });}finally{db.close();}
}
function element(tag,props={},...children){
 const node=document.createElement(tag);for(const [key,value]of Object.entries(props)){
 if(key==='text')node.textContent=value;else if(key==='className')node.className=value;
 else if(key.startsWith('on'))node.addEventListener(key.slice(2),value);else if(key==='disabled')node.disabled=value;else node.setAttribute(key,String(value));
 }for(const child of children)node.append(child);return node;
}
export async function createSequenceEditor(host,{getSources,getEdited,onPreview,onSave,onSeek}){
 host.dataset.noTranslate='';let segments=[],name='Sequence',selected='',timer,queue=Promise.resolve(),busy=false,status='',failed=false,dirty=true;
 const en=()=>document.documentElement.lang==='en',t=key=>labels[key]?.[en()?1:0]??key;
 const errorText=error=>labels[error?.code]?t(error.code):(error?.message||t('invalid'));
 const seconds=frames=>(frames/30).toFixed(3);
 let restorationError=false;
 try{const saved=await draftIO();if(saved){
 if(!Array.isArray(saved.segments)||saved.segments.length>50)throw Error('Invalid draft');
 segments=saved.segments.map(s=>({...s,clip:validateRecording({format:'augmented-arms-motion',version:1,fps:30,...s.clip}),sourceName:String(s.sourceName||'Motion').slice(0,120)}));
 for(const s of segments){if(!Number.isInteger(s.startFrame)||!Number.isInteger(s.endFrame)||s.startFrame<0||s.endFrame<=s.startFrame||s.endFrame>Math.max(s.clip.R.length,s.clip.L.length)||!Number.isInteger(s.transitionFrames)||s.transitionFrames<0||s.transitionFrames>300)throw Error('Invalid draft selection');}
 name=String(saved.name||'Sequence').slice(0,100);
 }}catch{segments=[];restorationError=true;}
 function persist(){
  clearTimeout(timer);timer=setTimeout(()=>{const snapshot=structuredClone({name,segments});
   queue=queue.catch(()=>{}).then(()=>draftIO(snapshot)).catch(()=>{status=t('draftError');failed=true;updateStatus();});
  },200);
 }
 const list=element('div',{className:'sequence-list','data-sequence':'list'});
 const report=element('p',{className:'curve-help',role:'status','data-sequence':'status'});
 function updateStatus(){report.textContent=status;report.classList.toggle('sequence-error',failed);}
 function build(){return composeSequence(segments,{name:name.trim()||(en()?'Sequence':'連結モーション')});}
 function sourceOptions(select){
  const sources=getSources();for(const source of sources)select.append(element('option',{value:source.id,text:source.name}));
  if(sources.some(s=>s.id===selected))select.value=selected;else{selected=sources[0]?.id??'';select.value=selected;}
 }
 function add(source){
  if(segments.length>=50){status=en()?'Use at most 50 clips.':'動作は50個までです。';failed=true;updateStatus();return;}
  const clip=validateRecording({format:'augmented-arms-motion',version:1,fps:30,...structuredClone(source.clip)});
  segments.push({sourceName:source.name,clip,startFrame:0,endFrame:Math.max(clip.R.length,clip.L.length),transitionFrames:15});
  dirty=true;status='';failed=false;persist();render();
 }
 function edit(index,field,value,input){
  const s=segments[index],previous=s[field],frame=String(value).trim()===''?NaN:Math.round(Number(value)*30);
  s[field]=frame;
  try{
   if(!Number.isFinite(frame))throw Error(t('invalid'));
   if(field==='transitionFrames'){if(frame<0||frame>300)throw Error(t('INVALID_TRANSITION'));}
   else if(s.startFrame<0||s.endFrame<=s.startFrame||s.endFrame>Math.max(s.clip.R.length,s.clip.L.length))throw Error(t('INVALID_TRIM'));
   delete input.dataset.invalid;status='';failed=false;dirty=true;persist();
  }catch(error){s[field]=previous;input.dataset.invalid='';status=error.message;failed=true;}refreshFooter();updateStatus();
 }
 function refreshFooter(){
  let recording,error;try{recording=build();}catch(e){error=e;}
  const invalid=!!host.querySelector('[data-invalid]'),summary=host.querySelector('[data-sequence=total]');
  if(summary)summary.textContent=invalid?t('invalid'):recording?(en()?'Total: ':'合計：')+segments.length+(en()?' clips · ':'動作 · ')+(recording.R.length/30).toFixed(2)+(en()?' s · ':'秒 · ')+recording.R.length+(en()?' frames':'フレーム'):(segments.length?errorText(error):'');
  for(const control of host.querySelectorAll('[data-sequence=preview],[data-sequence=save]'))control.disabled=busy||invalid||!recording;
  for(const control of host.querySelectorAll('[data-sequence-join]'))control.disabled=busy||invalid||dirty||!recording;
 }
 function move(index,offset){[segments[index],segments[index+offset]]=[segments[index+offset],segments[index]];dirty=true;status='';persist();render();}
 async function act(save){
  try{const recording=build();busy=true;status='';render();
   if(save)await onSave(recording);else await onPreview(recording);
   status=t(save?'saved':'ready');failed=false;dirty=false;
  }catch(error){status=errorText(error);failed=true;}finally{busy=false;render();}
 }
 function render(){
  host.replaceChildren();host.append(element('h2',{text:t('title')}),element('p',{className:'curve-help',text:t('help')}));
  const select=element('select',{'data-sequence':'source','aria-label':t('source'),onchange:e=>{selected=e.target.value;}});sourceOptions(select);
  host.append(element('label',{text:t('source')},select));
  host.append(element('div',{className:'sequence-actions'},
   element('button',{text:t('add'),'data-sequence':'add',disabled:busy||!selected,onclick:()=>{try{const source=getSources().find(s=>s.id===selected);if(source)add(source);}catch(e){status=errorText(e);failed=true;updateStatus();}}}),
   element('button',{text:t('edited'),'data-sequence':'add-edited',disabled:busy,onclick:()=>{try{add(getEdited());}catch(e){status=errorText(e);failed=true;updateStatus();}}})));
  list.replaceChildren();let recording,error;
  try{recording=build();}catch(e){error=e;}
  segments.forEach((s,index)=>{
   const row=element('div',{className:'sequence-clip','data-sequence-index':index});
   row.append(element('strong',{text:(index+1)+'. '+s.sourceName}));
   const controls=element('div',{className:'sequence-actions'});
   controls.append(element('button',{text:'↑','aria-label':t('up'),disabled:busy||index===0,onclick:()=>move(index,-1)}),
    element('button',{text:'↓','aria-label':t('down'),disabled:busy||index===segments.length-1,onclick:()=>move(index,1)}),
    element('button',{text:t('remove'),disabled:busy,onclick:()=>{segments.splice(index,1);dirty=true;status='';persist();render();}}));
   row.append(controls);
   const fields=element('div',{className:'sequence-fields'});
   for(const [field,key]of [['startFrame','start'],['endFrame','end'],['transitionFrames','join']]){
    const input=element('input',{type:'number',value:seconds(field==='transitionFrames'&&index===segments.length-1?0:s[field]),min:0,max:field==='transitionFrames'?10:seconds(Math.max(s.clip.R.length,s.clip.L.length)),step:field==='transitionFrames'?.1:.0333333333,'aria-label':t(key),'data-field':field,disabled:busy||(field==='transitionFrames'&&index===segments.length-1),oninput:e=>edit(index,field,e.target.value,e.target),onchange:e=>{edit(index,field,e.target.value,e.target);if(!e.target.hasAttribute('data-invalid'))e.target.value=seconds(s[field]);}});
    fields.append(element('label',{text:t(key)},input));
   }
   row.append(fields);
   if(index<segments.length-1){
    row.append(element('button',{text:t('jump'),'data-sequence-join':'',disabled:busy||dirty||!recording||!onSeek,onclick:()=>onSeek(Math.max(0,(recording.composition.segments[index].outputEndFrame-15)/30))}));
   }
   list.append(row);
  });
  if(!segments.length)list.append(element('p',{className:'curve-help',text:t('empty')}));
  host.append(list,element('p',{className:'curve-help',text:t('trimHelp')}));
  const summary=element('p',{className:'sequence-total','data-sequence':'total'});
  summary.textContent=recording?(en()?'Total: ':'合計：')+segments.length+(en()?' clips · ':'動作 · ')+(recording.R.length/30).toFixed(2)+(en()?' s · ':'秒 · ')+recording.R.length+(en()?' frames':'フレーム'):(segments.length?errorText(error):'');
  host.append(summary,element('label',{text:t('name')},element('input',{type:'text',value:name,maxlength:100,'data-sequence':'name','aria-label':t('name'),oninput:e=>{name=e.target.value;persist();}})));
  host.append(element('div',{className:'sequence-actions'},
   element('button',{text:t('preview'),'data-sequence':'preview',className:'primary',disabled:busy||!recording,onclick:()=>act(false)}),
   element('button',{text:t('save'),'data-sequence':'save',disabled:busy||!recording,onclick:()=>act(true)}),
   element('button',{text:t('clear'),disabled:busy||!segments.length,onclick:()=>{segments=[];dirty=true;status='';persist();render();}})));
  host.append(report,element('p',{className:'curve-help',text:t('basis')}),element('p',{className:'curve-help',text:t('draft')}));updateStatus();
 }
 if(restorationError){status=t('loadError');failed=true;}
 render();
 document.getElementById('language').addEventListener('change',()=>{status='';render();});
 return {refreshSources(){const select=host.querySelector('[data-sequence=source]');if(select){select.replaceChildren();sourceOptions(select);}},markInactive(){dirty=true;render();}};
}
