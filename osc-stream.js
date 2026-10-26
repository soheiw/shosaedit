export function createOSCStream(host,{getFrame}){
 const key='shosaedit-osc-destination-v1';let destination={host:'',port:9000};try{const saved=JSON.parse(localStorage.getItem(key));if(typeof saved?.host==='string'&&Number.isInteger(saved.port))destination=saved;}catch{}
 let enabled=false,busy=false,timer=null,count=0,sequence=0,lastStatus='',hasStopped=false,controller=null,revision=0;
 const en=()=>document.documentElement.lang==='en',t=(ja,english)=>en()?english:ja;
 host.innerHTML='<h2>OSC / UDP</h2><p class="curve-help" data-osc-help></p><div class="osc-fields"><label>IP <input data-osc-host type="text" placeholder="192.168.1.20" aria-label="OSC destination IP"></label><label>Port <input data-osc-port type="number" min="1" max="65535" step="1" aria-label="OSC destination port"></label></div><button type="button" data-osc-toggle></button><p data-osc-status class="curve-help" role="status"></p>';
 const $=selector=>host.querySelector(selector),ip=$('[data-osc-host]'),port=$('[data-osc-port]'),button=$('[data-osc-toggle]'),status=$('[data-osc-status]');ip.value=destination.host;port.value=destination.port;
 function labels(){host.querySelector('h2').textContent='OSC / UDP';$('[data-osc-help]').textContent=t('修正後の左右モーター値・関節角（rad）・推定トルク（N·m）を約30fpsで送信します。一時停止中も現在の値を送ります。TDではOSC In CHOPで受信します。','Streams edited counts, joint angles (rad), and estimated torque (N·m) for both arms at approximately 30 fps, including held poses when paused. Receive with OSC In CHOP in TD.');button.textContent=enabled?t('送信を停止','Stop streaming'):t('送信を開始','Start streaming');if(!enabled&&!lastStatus)status.textContent=hasStopped?t('停止中','Stopped'):t('停止中 · 送信先を設定してください','Stopped · set destination');}
 function stop(message=''){revision++;enabled=false;clearInterval(timer);timer=null;controller?.abort();controller=null;ip.disabled=false;port.disabled=false;hasStopped=true;lastStatus=message;status.textContent=message;labels();}
 async function pump(){
  if(!enabled||busy)return;busy=true;const version=revision,token=controller=new AbortController(),timeout=setTimeout(()=>token.abort(),3000);
  try{const frame=getFrame();if(!frame)return;const response=await fetch('/api/osc/frame',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({...frame,host:destination.host,port:destination.port,sequence:sequence++%2147483647}),signal:token.signal});
   if(!response.ok){let message=t('送信に失敗しました','Send failed');try{message=(await response.json()).error||message;}catch{}throw Error(message);}
   if(enabled&&version===revision){count++;status.textContent=t(`UDP送信 ${count}フレーム → ${destination.host}:${destination.port}（受信は未確認）`,`UDP sent ${count} frames → ${destination.host}:${destination.port} (receipt unconfirmed)`);}
  }catch(error){if(enabled&&version===revision)stop(t('送信停止：','Streaming stopped: ')+error.message);}finally{clearTimeout(timeout);busy=false;if(controller===token)controller=null;}
 }
 button.onclick=async()=>{
  if(enabled){stop();return;}
  destination={host:ip.value.trim(),port:port.valueAsNumber};
  if(!destination.host||!Number.isInteger(destination.port)||destination.port<1||destination.port>65535){status.textContent=t('送信先IPと1〜65535のポートを入力してください','Enter an IP address and a port from 1–65535');return;}
  button.disabled=true;
  try{const response=await fetch('/api/osc/status',{cache:'no-store'});if(!response.ok)throw Error(t('Pythonサーバーを最新版のlaunch.pyで再起動してください','Restart the Python server using the updated launch.py'));const result=await response.json();if(result.protocol!=='OSC/UDP')throw Error('OSC relay unavailable');
   try{localStorage.setItem(key,JSON.stringify(destination));}catch{}revision++;enabled=true;lastStatus='';count=0;ip.disabled=true;port.disabled=true;labels();timer=setInterval(pump,1000/30);await pump();
  }catch(error){stop(error.message);}finally{button.disabled=false;}
 };
 document.getElementById('language').addEventListener('change',labels);window.addEventListener('pagehide',()=>stop());host.dataset.noTranslate='';labels();
 return {stop};
}
