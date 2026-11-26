// Direct arm control (launch.py --hardware): connect, motor status, live counts,
// play a recording or the edited motion, STOP / LOCK / RELEASE / FIX, record,
// calibrate. Inert unless /api/arm/status reports enabled. The server runs the
// same controller as TouchDesigner (hardware/arm_controller.py), so playback
// keeps its lead-in, start-distance and stall guards.
const SIDES=['R','L'],NAME={R:'右腕 / Right',L:'左腕 / Left'};
const LOOK={ok:['#3b6fa8','OK'],released:['#2a3b52','脱力'],torque_off:['#b03030','停止'],error:['#b03030','エラー'],no_reply:['#2a2c31','応答なし']};
const STATE={connected:'接続中 / connected',connecting:'接続しています…',disconnecting:'切断しています…',failed:'接続失敗 / failed',offline:'未接続 / offline'};

async function api(path,body){
 const r=await fetch('/api/arm/'+path,body===undefined?{cache:'no-store'}:{method:'POST',cache:'no-store',headers:{'Content-Type':'application/json'},body:JSON.stringify(body)});
 const data=await r.json().catch(()=>({error:r.statusText}));
 if(!r.ok||data.error&&data.enabled!==false)throw Error(data.error||r.statusText);
 return data;
}

export async function bindArmControl({getRecording=null,validate=async()=>{},nameFor=r=>r.name,mount=host=>document.querySelector('aside').prepend(host)}={}){
 let status;try{status=await api('status');}catch{return;}
 if(!status.enabled)return;
 const host=document.createElement('section');host.className='arm-control';host.dataset.noTranslate='';
 host.innerHTML=`<span class="eyebrow">HARDWARE</span><h2>実機操作</h2>
<p><a href="monitor.html" target="shosaedit-monitor" class="arm-monitor-link">実機モニターを別タブで開く ↗</a></p><p class="curve-help">TouchDesignerを使わずに実機を動かします。<b>TDと同じポートを同時に開かないでください</b>（TDでDISCONNECTしてから接続）。Escキーで緊急停止します。</p>
<button type="button" class="arm-stop" data-stop>■ 緊急停止 STOP（Esc）</button>
<p class="arm-estop" data-estop>USB STOPボタン：確認中…</p>
<div class="row arm-safety"><button type="button" data-lock>LOCK</button><button type="button" data-release>RELEASE（脱力）</button><button type="button" data-fix>FIX MOTORS</button></div>
${SIDES.map(s=>`<div class="arm-card" data-card="${s}"><div class="row"><b>${NAME[s]}</b><span data-state></span></div>
<div class="row"><input data-port aria-label="${s} port" placeholder="/dev/cu.usbserial-…"><input data-ids aria-label="${s} IDs" placeholder="IDs"></div>
<div class="row"><button type="button" data-connect>接続</button><button type="button" data-calibrate title="脱力して下ろした基準姿勢（肘は後ろ、親指は前）で押す">基準姿勢を保存（CALIBRATE）</button></div>
<div class="arm-motors" data-motors></div><p class="arm-dup" data-dup hidden></p></div>`).join('')}
<hr><label for="arm-recordings">記録を再生（Recorded_movements）</label>
<div class="row"><select id="arm-recordings" data-recordings></select><button type="button" class="primary" data-play>再生</button><button type="button" data-refresh>更新</button></div>
<div class="row"><button type="button" class="primary" data-play-edited>編集後の動きを実機で再生</button></div>
<p class="curve-help">編集後の動きは、校正と推定負荷を確認してから左右CSVとしてRecorded_movementsに保存し、その記録を再生します。開始位置まで自動で移動してから始まり、先頭から半回転以上離れていると再生を拒否します。</p>
<hr><label>記録する</label><div class="row"><input data-rec-name placeholder="記録名"><button type="button" data-rec>● 記録開始</button><span data-rec-timer></span></div>
<hr><details><summary>現在位置（counts）</summary><pre data-live class="arm-live">—</pre></details>
<details><summary>ログ</summary><pre data-log class="arm-log"></pre></details>
<p data-msg class="curve-help" role="status"></p>`;
 mount(host);if(!getRecording)host.querySelector('[data-play-edited]').closest('.row').remove();
 const $=s=>host.querySelector(s),card=s=>host.querySelector(`[data-card="${s}"]`);
 const msg=t=>{$('[data-msg]').textContent=t;};
 let logSeq=0,recStart=null,liveOpen=false;
 for(const s of SIDES){const a=status.arms[s];card(s).querySelector('[data-port]').value=a.port;card(s).querySelector('[data-ids]').value=a.ids.join(' ');}

 async function act(label,fn){try{const r=await fn();if(r?.arms)render(r);return r;}catch(e){msg(label+'：'+e.message);}}
 function render(st){
  status=st;
  for(const s of SIDES){const a=st.arms[s],c=card(s),on=a.state==='connected';
   c.querySelector('[data-state]').textContent=STATE[a.state]||a.state;c.dataset.state=a.state;
   c.querySelector('[data-connect]').textContent=on?'切断':'接続';
   c.querySelector('[data-connect]').disabled=a.state==='connecting'||a.state==='disconnecting';
   for(const k of ['port','ids'])c.querySelector(`[data-${k}]`).disabled=a.state!=='offline'&&a.state!=='failed';
   const dup=Object.entries(a.duplicates||{});c.querySelector('[data-dup]').textContent=dup.map(([id,m])=>`⚠ ID${id}に2台つながっています（${m.join(' と ')}）。ID${id}への指令で両方が動きます。片方のIDを変えてください。`).join(' ');c.querySelector('[data-dup]').hidden=!dup.length;
   c.querySelector('[data-motors]').innerHTML=a.ids.map(id=>{const st=a.motors[id]||'no_reply',[bg,label]=LOOK[st]||LOOK.no_reply;
    return `<span style="background:${bg}" title="ID ${id} · ${label}${a.models[id]?' · '+a.models[id]:''}">${id}</span>`;}).join('');
  }
  const recording=SIDES.some(s=>st.arms[s].recording);
  $('[data-rec]').textContent=recording?'■ 記録停止':'● 記録開始';$('[data-rec]').classList.toggle('arm-recording',recording);
  if(!recording)recStart=null;else recStart??=performance.now();
  $('[data-lock]').classList.toggle('arm-locked',st.locked);$('[data-lock]').textContent=st.locked?'LOCK 中（クリックで解除）':'LOCK';
  $('[data-fix]').textContent=st.fixing?'FIXING…':'FIX MOTORS';
  if(st.log?.length){const pre=$('[data-log]');pre.textContent=(pre.textContent+'\n'+st.log.map(l=>l.line).join('\n')).split('\n').slice(-200).join('\n').trim();pre.scrollTop=pre.scrollHeight;}
  logSeq=st.logSeq??logSeq;
  const e=st.estop||{},el=$('[data-estop]');
  el.textContent=!e.connected?`USB STOPボタン：未接続${e.configuredPort?'（'+e.configuredPort+'）':'（自動検出）'}${e.error?' · '+e.error:''}`:!e.alive?`USB STOPボタン：応答なし（${e.port}）— ケーブルを確認`:e.pressed?`USB STOPボタン：押されています（${e.port}）`:`USB STOPボタン：接続中（${e.port}）· 押した回数 ${e.stops}`;
  el.dataset.state=!e.connected?'off':!e.alive?'lost':e.pressed?'pressed':'ok';
 }
 async function poll(){try{render(await api('status?since='+logSeq));}catch(e){msg('サーバーに接続できません：'+e.message);}
  if(recStart!==null){const s=(performance.now()-recStart)/1000;$('[data-rec-timer]').textContent=`${String(Math.floor(s/60)).padStart(2,'0')}:${(s%60).toFixed(1).padStart(4,'0')}`;}
  setTimeout(poll,500);}
 async function pollLive(){if(liveOpen){try{const p=await api('live');
   $('[data-live]').textContent=SIDES.map(s=>`${NAME[s]}\n`+(p[s]?status.arms[s].ids.map((id,i)=>`  ID ${String(id).padStart(2)} ${String(p[s][i]).padStart(7)}`).join('\n'):'  —')).join('\n');}catch{}}
  setTimeout(pollLive,liveOpen?100:500);}
 async function refreshRecordings(){const sel=$('[data-recordings]'),keep=sel.value;
  try{const {recordings}=await api('recordings');sel.innerHTML=recordings.map(r=>`<option value="${r.name.replace(/"/g,'&quot;')}"${r.R&&r.L?'':' disabled'}>${r.name}${r.R&&r.L?'':r.R?'（右のみ）':'（左のみ）'}</option>`).join('');
   if([...sel.options].some(o=>o.value===keep))sel.value=keep;}catch(e){msg('記録一覧を読めません：'+e.message);}}

 const stop=()=>act('停止',()=>api('stop',{})).then(()=>msg('緊急停止しました（トルクONで保持）。'));
 $('[data-stop]').onclick=stop;
 document.addEventListener('keydown',e=>{if(e.key==='Escape'&&!e.repeat)stop();});
 $('[data-lock]').onclick=()=>act('LOCK',()=>api('lock',{on:!status.locked}));
 $('[data-release]').onclick=()=>{if(confirm('トルクをOFFにして腕を脱力させます。腕が落ちても安全ですか？'))act('RELEASE',()=>api('release',{}));};
 $('[data-fix]').onclick=()=>act('FIX',()=>api('fix',{}));
 for(const s of SIDES){const c=card(s);
  c.querySelector('[data-connect]').onclick=()=>act('接続',async()=>{
   if(status.arms[s].state==='connected')return api('disconnect',{side:s});
   const ids=c.querySelector('[data-ids]').value.replace(/,/g,' ').split(/\s+/).filter(Boolean).map(Number);
   await api('configure',{side:s,port:c.querySelector('[data-port]').value.trim(),ids});
   return api('connect',{side:s});});
  c.querySelector('[data-calibrate]').onclick=()=>{if(!confirm(`${NAME[s]}の現在位置を、選択中の腕モデルの基準姿勢として保存します。腕は脱力して下ろした基準姿勢ですか？`))return;
   act('基準姿勢',async()=>{const r=await api('calibrate',{side:s});msg(`${NAME[s]} ${r.model} の基準姿勢を保存しました（${r.time}）。`);});};
 }
 $('[data-refresh]').onclick=refreshRecordings;
 $('[data-play]').onclick=()=>{const name=$('[data-recordings]').value;if(name)act('再生',async()=>{const r=await api('play',{name});msg(`再生を開始：${name}`);return r;});};
 if(getRecording)$('[data-play-edited]').onclick=()=>act('編集後の再生',async()=>{
  msg('校正と推定負荷を確認中…');
  const recording=getRecording();await validate(recording);
  const name=nameFor(recording),body={name,R:recording.R,L:recording.L,overwrite:false};
  let saved=await api('save-motion',body);
  if(saved.exists){if(!confirm(`「${name}」は既にRecorded_movementsにあります。上書きして再生しますか？`)){msg('中止しました。');return;}
   saved=await api('save-motion',{...body,overwrite:true});}
  await refreshRecordings();
  if(!confirm(`「${name}」を実機で再生します。周囲は安全ですか？`)){msg(`保存のみ：${name}`);return;}
  const r=await api('play',{name});msg(`再生を開始：${name}`);return r;});
 $('[data-rec]').onclick=()=>{const recording=SIDES.some(s=>status.arms[s].recording);
  act('記録',()=>recording?api('record',{on:false}).then(r=>{refreshRecordings();return r;}):api('record',{on:true,name:$('[data-rec-name]').value.trim()}));};
 host.querySelector('details').ontoggle=e=>{liveOpen=e.target.open;};
 render(status);refreshRecordings();poll();pollLive();
}
