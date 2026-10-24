import {timeMap} from './speed-curve.js';
const clamp=(v,a,b)=>Math.max(a,Math.min(b,v));
export function delayOffsets(setting={}){const seconds=Number(setting.seconds??0);if(!Number.isFinite(seconds)||seconds<0||seconds>5)throw Error('時間差は0〜5秒で指定してください');return {R:setting.side==='R'?seconds:0,L:setting.side==='L'?seconds:0};}
// A delay is measured in output seconds, after the global rate and speed curve.
export function createPlaybackClock(fullCount,curve,fps=30){
 if(!Number.isInteger(fullCount)||fullCount<1||!Number.isFinite(fps)||fps<=0)throw Error('記録の時間が不正です');
 const rate=curve.rate;if(!Number.isFinite(rate)||rate<=0)throw Error('再生速度が不正です');
 const map=timeMap(curve.points,curve.enabled),sourceDuration=fullCount/fps;
 return {duration:sourceDuration*map.total/rate,frameAt(seconds){return map.position(Math.max(0,seconds)*rate/sourceDuration)*fullCount;},timeAtFrame(frame){return sourceDuration*map.time(clamp(frame/fullCount,0,1))/rate;}};
}
export function sampleAtTime(rows,seconds,clock,delay=0){
 const f=clamp(clock.frameAt(Math.max(0,seconds-delay)),0,rows.length-1),i=Math.floor(f),t=f-i;
 return rows[i].map((v,k)=>v+(rows[Math.min(i+1,rows.length-1)][k]-v)*t);
}
export function createArmDelayEditor(host,onChange){
 const key='augmented-arms-side-delays-v1';let saved={};try{const s=JSON.parse(localStorage.getItem(key));if(s&&typeof s==='object'&&!Array.isArray(s))saved=s;}catch{}
 let clip='1',setting={side:'L',seconds:0};
 host.innerHTML=`<div class="section-heading"><h2>左右の時間差</h2><button id="delay-reset" type="button">時間差をなくす</button></div><div class="row"><label>遅らせる腕 <select id="delay-side"><option value="L">左腕</option><option value="R">右腕</option></select></label><label>時間差 <input id="delay-seconds" aria-label="左右の時間差（秒）" type="number" min="0" max="5" step="0.01" value="0"> 秒</label></div><input id="delay-slider" aria-label="左右の時間差の調整" type="range" min="0" max="5" step="0.01" value="0"><p id="delay-status" class="curve-help" aria-live="polite"></p><p class="curve-help">修正後の動きに適用。時間差は速度カーブ適用後の秒数です。待機中は先頭・末尾の姿勢を保ちます。Motionごとに自動保存。</p>`;
 const $=id=>host.querySelector('#'+id);
 function draw(){ $('delay-side').value=setting.side;$('delay-seconds').value=setting.seconds.toFixed(2);$('delay-slider').value=setting.seconds;$('delay-status').textContent=setting.seconds?`${setting.side==='R'?'右腕':'左腕'}を${setting.seconds.toFixed(2)}秒遅らせる`:'時間差なし'; }
 function commit(){saved[clip]={...setting};try{localStorage.setItem(key,JSON.stringify(saved));}catch{}draw();onChange();}
 for(const id of ['delay-seconds','delay-slider'])$(id).oninput=e=>{const raw=e.target.value,v=e.target.valueAsNumber;if(!Number.isFinite(v))return;setting.seconds=Math.round(clamp(v,0,5)*100)/100;commit();if(id==='delay-seconds')$(id).value=raw;};
 $('delay-seconds').onblur=draw;$('delay-side').onchange=e=>{setting.side=e.target.value;commit();};$('delay-reset').onclick=()=>{setting.seconds=0;commit();};
 return {snapshot:()=>({...setting}),offsets:()=>delayOffsets(setting),setClip(id){clip=id;setting={side:'L',seconds:0};const s=saved[id];if(s&&['R','L'].includes(s.side)&&Number.isFinite(s.seconds)&&s.seconds>=0&&s.seconds<=5)setting={side:s.side,seconds:s.seconds};draw();}};
}
