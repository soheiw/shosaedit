// Local, silent MP4 recording of the visible comparison and reference movies.
export function createSceneVideoExport({getCanvas,getTime,getDuration,getName,prepare,restore}){
 const bar=document.createElement('div');bar.className='reference-toolbar';bar.dataset.noTranslate='';
 bar.innerHTML='<button id="export-scene-mp4">シーンをMP4保存 / Save scene MP4</button><button id="cancel-scene-mp4" hidden>中止 / Cancel</button><small id="scene-mp4-status" role="status">表示中の画面構成で先頭から最後まで録画・音声なし</small>';
 document.querySelector('.stage-visuals').after(bar);
 const start=bar.querySelector('#export-scene-mp4'),cancel=bar.querySelector('#cancel-scene-mp4'),status=bar.querySelector('small');
 let active=false,recorder=null,stream=null,chunks=[],aborted=false,canvas,ctx,layout,disabled=[],previous;
 function draw(){
  const stage=document.querySelector('.stage-visuals').getBoundingClientRect();
  ctx.fillStyle='#151b24';ctx.fillRect(0,0,canvas.width,canvas.height);
  const scale=canvas.width/stage.width;
  for(const item of layout){
   const r=item.el.getBoundingClientRect(),x=(r.left-stage.left)*scale,y=(r.top-stage.top)*scale,w=r.width*scale,h=r.height*scale;
   if(item.video){const v=item.el;if(v.error)throw Error('参考動画の再生エラー');if(v.readyState>=2){item.lastFrame??=document.createElement('canvas');item.lastFrame.width=v.videoWidth;item.lastFrame.height=v.videoHeight;item.lastFrame.getContext('2d').drawImage(v,0,0);}if(!item.lastFrame)continue;const s=Math.min(w/v.videoWidth,h/v.videoHeight);ctx.drawImage(item.lastFrame,x+(w-v.videoWidth*s)/2,y+(h-v.videoHeight*s)/2,v.videoWidth*s,v.videoHeight*s);}
   else ctx.drawImage(item.el,x,y,w,h);
  }
  ctx.font=`${Math.max(14,canvas.width/95)}px sans-serif`;ctx.textBaseline='top';
  for(const item of layout){const r=item.el.getBoundingClientRect(),x=(r.left-stage.left)*scale,w=r.width*scale;const labels=item.video?[item.label]:['Original','Edited'];labels.forEach((label,i)=>{const left=x+w*i/labels.length+8;ctx.fillStyle='#151b24dd';ctx.fillRect(left-4,5,w/labels.length-12,27);ctx.fillStyle='#ffffff';ctx.fillText(label,left,10);});}
 }
 function cleanup(){active=false;stream?.getTracks().forEach(t=>t.stop());for(const el of disabled)el.disabled=false;disabled=[];cancel.hidden=true;restore(previous);recorder=null;}
 function stop(failure){if(!active)return;aborted=!!failure;if(failure)status.textContent=failure;active=false;if(recorder?.state==='recording')recorder.stop();else cleanup();}
 start.onclick=async()=>{
  const mime=['video/mp4;codecs=avc1.42001f','video/mp4'].find(t=>window.MediaRecorder?.isTypeSupported(t));
  if(!mime){status.textContent='このブラウザはMP4録画に未対応です。最新版のChromeまたはSafariで開いてください。';return;}
  if(document.hidden){status.textContent='このタブを表示してから録画してください。';return;}
  aborted=false;chunks=[];active=true;previous=undefined;
  try{
   previous=prepare();
   layout=[{el:getCanvas(),video:false},...[...document.querySelectorAll('.reference-pane video')].filter(v=>v.getClientRects().length&&v.closest('.reference-slot')&&!v.closest('.reference-pane').hidden&&!v.closest('.reference-slot').hidden).map(v=>({el:v,video:true,label:v.parentElement.querySelector('.reference-caption').textContent}))];
   status.textContent='参考動画を準備中…';cancel.hidden=false;
   disabled=[...document.querySelectorAll('button,input,select,textarea')].filter(el=>el!==cancel&&!el.disabled);for(const el of disabled)el.disabled=true;
   const until=performance.now()+20000;let stable=0;
   while(stable<3){if(!active)return;if(performance.now()>until)throw Error('参考動画の読み込みが完了しません');await new Promise(r=>setTimeout(r,100));stable=layout.filter(x=>x.video).every(x=>x.el.readyState>=2&&!x.el.seeking)?stable+1:0;}
   const rect=document.querySelector('.stage-visuals').getBoundingClientRect();canvas=document.createElement('canvas');canvas.width=Math.min(1920,Math.round(rect.width/2)*2);canvas.height=Math.round(rect.height*canvas.width/rect.width/2)*2;ctx=canvas.getContext('2d');draw();
   stream=canvas.captureStream(30);recorder=new MediaRecorder(stream,{mimeType:mime,videoBitsPerSecond:8000000});
   recorder.ondataavailable=e=>{if(e.data.size)chunks.push(e.data);};
   recorder.onerror=()=>stop('録画に失敗しました');
   recorder.onstop=()=>{if(!aborted){const blob=new Blob(chunks,{type:'video/mp4'}),url=URL.createObjectURL(blob),a=document.createElement('a');a.href=url;a.download=(getName()||'ShosaEdit').replace(/[\\/:*?"<>|]/g,'_')+'-scene.mp4';a.click();setTimeout(()=>URL.revokeObjectURL(url),60000);status.textContent='MP4を保存しました / MP4 saved';}cleanup();};
   recorder.start(1000);previous.run();
  }catch(e){stop('保存できません：'+e.message);}
 };
 cancel.onclick=()=>stop('録画を中止しました');
 document.addEventListener('visibilitychange',()=>{if(active&&document.hidden)stop('タブが非表示になったため録画を中止しました。タブを表示したまま再実行してください。');});
 return {get active(){return active;},capture(){if(!active||recorder?.state!=='recording')return;try{draw();status.textContent=`MP4録画中 ${getTime().toFixed(1)} / ${getDuration().toFixed(1)}秒（タブを表示したままお待ちください）`;if(getTime()>=getDuration())stop();}catch(e){stop('録画失敗：'+e.message);}}};
}
