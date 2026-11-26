// Reference movies follow the original elapsed clock, never motor output.
export function createReferenceVideo(){
 const viewport=document.getElementById('viewport');
 const toolbar=document.createElement('div');toolbar.className='reference-toolbar';toolbar.dataset.noTranslate='';
 toolbar.innerHTML=`<b>参考動画 / Reference</b><select id="reference-source" aria-label="参考動画"><option value="">非表示 / Hidden</option><option value="both">正面＋別角度 / Both</option><option value="front">正面 / Front</option><option value="angle">別角度 / Angle</option></select><label class="file-label">動画を開く / Open<input id="reference-file" type="file" accept="video/*"></label><label>開始秒 / Start <input id="reference-offset" type="number" min="0" step="0.1" value="2.1"></label><label id="reference-angle-setting">別角度の差 / Angle offset <input id="reference-angle-offset" type="number" step="0.1" value="0"></label><small id="reference-status">元の動きと同期 / Original timing</small>`;
 viewport.before(toolbar);
 const visuals=document.createElement('div');visuals.className='stage-visuals';viewport.before(visuals);visuals.append(viewport);
 const pane=document.createElement('div');pane.className='reference-pane';pane.hidden=true;
 pane.innerHTML='<div class="reference-slot"><video id="reference-video" muted playsinline preload="auto"></video><div class="reference-caption"></div></div><div class="reference-slot"><video id="reference-video-angle" muted playsinline preload="auto"></video><div class="reference-caption">別角度 / Angle</div></div>';visuals.append(pane);
 const select=toolbar.querySelector('select'),offset=toolbar.querySelector('#reference-offset'),angleOffset=toolbar.querySelector('#reference-angle-offset'),status=toolbar.querySelector('#reference-status');
 const slots=[...pane.querySelectorAll('.reference-slot')].map(el=>({el,video:el.querySelector('video'),url:null,force:true,pending:false,failed:false,source:''}));
 let blob=null,lastClip=null,lastTime=0,lastPlaying=false,lastTick=0,loadId=0;
 const force=()=>slots.forEach(s=>s.force=true);
 async function load(){
  const id=++loadId,sources=select.value==='both'?['front','angle']:select.value?[select.value]:[];
  pane.hidden=!sources.length;pane.classList.toggle('reference-dual',sources.length===2);
  toolbar.querySelector('#reference-angle-setting').hidden=!sources.includes('angle');
  status.textContent=sources.length?'読み込み中 / Loading…':'元の動きと同期 / Original timing';
  await Promise.all(slots.map(async(s,i)=>{
   s.video.pause();s.failed=false;s.force=true;s.source=sources[i]||'';s.el.hidden=!s.source;
   s.video.removeAttribute('src');s.video.load();if(s.url){URL.revokeObjectURL(s.url);s.url=null;}
   if(!s.source)return;
   s.el.querySelector('.reference-caption').textContent=s.source==='front'?'正面 / Front':s.source==='angle'?'別角度 / Angle':'参考映像 / Reference';
   try{
    if(s.source==='local')s.video.src=blob;
    else{const r=await fetch(`reference-videos/${s.source}.mp4`);if(!r.ok)throw Error('Missing video');const data=await r.blob();if(id!==loadId)return;s.url=URL.createObjectURL(data);s.video.src=s.url;}
    s.video.load();
   }catch{if(id===loadId){s.failed=true;status.textContent='動画が見つかりません / Video unavailable';}}
  }));
 }
 function save(){if(!lastClip||select.value==='local')return;try{localStorage.setItem('shosaedit-reference-v1:'+lastClip,JSON.stringify({source:select.value,offset:offset.value,angleOffset:angleOffset.value}));}catch{}}
 select.onchange=()=>{save();load();};offset.oninput=()=>{save();force();};angleOffset.oninput=()=>{save();force();};
 toolbar.querySelector('#reference-file').onchange=e=>{const file=e.target.files[0];if(!file)return;if(blob)URL.revokeObjectURL(blob);blob=URL.createObjectURL(file);let option=select.querySelector('[value="local"]');if(!option){option=new Option('','local');select.add(option);}option.textContent=file.name;select.value='local';offset.value='0';load();};
 for(const s of slots){s.video.muted=true;s.video.onloadedmetadata=()=>{s.force=true;if(slots.every(x=>!x.source||(!x.failed&&Number.isFinite(x.video.duration))))status.textContent='元の動きと同期 / Original timing';};s.video.onerror=()=>{s.failed=true;status.textContent='動画を読み込めません / Video unavailable';};}
 return {update(time,playing,clip){
  if(clip!==lastClip){
   lastClip=clip;let saved;try{saved=JSON.parse(localStorage.getItem('shosaedit-reference-v1:'+clip));}catch{}
   if(saved&&['','both','front','angle'].includes(saved.source)){select.value=saved.source;offset.value=Number.isFinite(+saved.offset)?String(Math.max(0,+saved.offset)):'2.1';angleOffset.value=Number.isFinite(+saved.angleOffset)?String(+saved.angleOffset):'0';load();}
   else if(['video-arm-dance-model-c','dance-straight','dancehalf-straight','full_straight','full2_straight','full2_soft','soft1587_straight','smooth_end_straight','follow_straight'].includes(clip)){select.value='both';offset.value='2.1';angleOffset.value='0';load();}
   else if(['front','angle','both'].includes(select.value)){select.value='';load();}
  }
  const now=performance.now();
  const elapsedWall=lastTick?(now-lastTick)/1000:0;
  const jump=time<lastTime-.01 || Math.abs(time-lastTime-(lastPlaying?elapsedWall:0))>.4;
  const movieTime=time;
  const nominalRate=1;
  for(const s of slots){
   const v=s.video;if(pane.hidden||!s.source||s.failed||!Number.isFinite(v.duration))continue;
   const raw=movieTime+Math.max(0,Number(offset.value)||0)+(s.source==='angle'?(Number(angleOffset.value)||0):0);
   const desired=Math.min(v.duration,Math.max(0,raw));
   const drift=desired-v.currentTime;
   const run=playing&&raw>=0&&raw<v.duration&&nominalRate>.001;
   // Seeking flushes the decoder. During normal playback converge gently on
   // the motion clock; seek only on a discontinuity or a substantial drift.
   if(!v.seeking){
    const explicit=s.force||jump||!run;
    if((explicit&&Math.abs(drift)>.025)||(!explicit&&Math.abs(drift)>.65&&(now-(s.lastSeek??-Infinity)>1000))){
     v.currentTime=desired;s.lastSeek=now;
    }
    s.force=false;
    if(run){
     const correction=Math.abs(drift)<.045?0:Math.max(-.12,Math.min(.12,drift*.5));
     const rate=Math.max(.25,Math.min(2,nominalRate+correction));
     if(Math.abs(v.playbackRate-rate)>.01)v.playbackRate=rate;
    }
   }
   if(run&&v.paused&&!s.pending){s.pending=true;v.play().catch(()=>{status.textContent='動画を再選択して再生 / Reselect video';}).finally(()=>s.pending=false);}
   if(!run&&!v.paused)v.pause();
  }
  lastTime=time;lastPlaying=playing;lastTick=now;
 }};
}
