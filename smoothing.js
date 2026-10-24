// Symmetric Gaussian filtering in source-recording time, before time warping.
// Truncated, renormalized edges avoid zero padding and never mix the two ends.
export function smoothRows(rows,strength,fps=30){
 if(!strength||rows.length<2)return rows;
 const sigma=Math.max(.01,strength*.005)*fps,radius=Math.ceil(3*sigma);
 const weights=Array.from({length:2*radius+1},(_,i)=>Math.exp(-.5*((i-radius)/sigma)**2));
 return rows.map((row,i)=>{const out=row.map(()=>0);let sum=0;for(let k=Math.max(0,i-radius);k<=Math.min(rows.length-1,i+radius);k++){const w=weights[k-i+radius];sum+=w;for(let c=0;c<out.length;c++)out[c]+=rows[k][c]*w;}return out.map(v=>v/sum);});
}
// Total window width in source seconds; discrete support is nearest 30 fps sample.
export function windowSmoothRows(rows,seconds,fps=30){
 const radius=Math.round(Math.max(0,seconds)*fps/2);
 if(!radius||rows.length<2)return rows;
 const sigma=radius/3,weights=Array.from({length:radius*2+1},(_,i)=>Math.exp(-.5*((i-radius)/sigma)**2));
 return rows.map((r,i)=>{const out=r.map(()=>0);let total=0;for(let j=Math.max(0,i-radius);j<=Math.min(rows.length-1,i+radius);j++){const w=weights[j-i+radius];total+=w;for(let c=0;c<out.length;c++)out[c]+=rows[j][c]*w;}return out.map(v=>v/total);});
}
const median=a=>{const s=[...a].sort((a,b)=>a-b);return s.length?s[Math.floor(s.length/2)]:0;};
const bound=(x,a=0,b=1)=>Math.max(a,Math.min(b,x));
export function adaptiveSmooth(rows,strength,fps=30,protectedRanges=[]){
 const n=rows.length,cols=rows[0]?.length||0,protection=Array(n).fill(0);
 if(!strength||n<5)return {rows,protection};
 const clean=rows.map(r=>[...r]),confidence=rows.map(r=>r.map(()=>0)),noise=[];
 // A robust noise estimate from curvature, without assuming a motor's range.
 for(let c=0;c<cols;c++){
  const d2=[];for(let i=1;i<n-1;i++)d2.push(rows[i+1][c]-2*rows[i][c]+rows[i-1][c]);
  const sigma=Math.max(.5,median(d2.map(v=>Math.abs(v)))*1.4826/Math.sqrt(6));noise[c]=sigma;
  // Remove only isolated excursions whose neighbours agree. Sustained steps stay.
  for(let i=2;i<n-2;i++){
   const a=rows[i-1][c],b=rows[i+1][c],v=rows[i][c];
   const neighbours=[rows[i-2][c],a,b,rows[i+2][c]],m=median(neighbours);
   if(Math.abs(a-b)<2*sigma&&Math.max(...neighbours)-Math.min(...neighbours)<4*sigma&&Math.abs(v-m)>8*sigma)clean[i][c]=m;
  }
 }
 for(let c=0;c<cols;c++)for(let i=0;i<n;i++){
  const a=Math.max(0,i-3),b=Math.min(n-1,i+3);let travel=0;for(let j=a+1;j<=b;j++)travel+=Math.abs(clean[j][c]-clean[j-1][c]);
  const net=Math.abs(clean[b][c]-clean[a][c]),coherence=net/(travel+1e-9);
  let p=bound((coherence-.45)/.45)*bound((net/noise[c]-3)/9);
  // Preserve a decisive step, even with a flat plateau on both sides.
  if(i>0&&i<n-1){const jump=Math.abs(clean[i][c]-clean[i-1][c]);if(jump>6*noise[c])p=Math.max(p,bound((jump/noise[c]-6)/6));}
  // A sustained approach and departure of opposite signs indicate a turn.
  if(i>=3&&i+3<n){const l=clean[i][c]-clean[i-3][c],r=clean[i+3][c]-clean[i][c];let lt=0,rt=0;for(let j=i-2;j<=i;j++)lt+=Math.abs(clean[j][c]-clean[j-1][c]);for(let j=i+1;j<=i+3;j++)rt+=Math.abs(clean[j][c]-clean[j-1][c]);if(l*r<0&&Math.abs(l)/(lt+1e-9)>.8&&Math.abs(r)/(rt+1e-9)>.8)p=Math.max(p,bound((Math.min(Math.abs(l),Math.abs(r))/noise[c]-4)/8));}
  confidence[i][c]=p;
 }
 // Adjacent frames share protection; coordinated joints reinforce weak evidence.
 const dilated=confidence.map((r,i)=>r.map((p,c)=>{for(let j=Math.max(0,i-2);j<=Math.min(n-1,i+2);j++)p=Math.max(p,confidence[j][c]*(1-.15*Math.abs(j-i)));const peers=confidence[i].filter(v=>v>.7).length;return peers>=2&&p>.25?Math.max(p,.75):p;}));
 const sigmaT=Math.max(.5,strength*.005*fps),radius=Math.ceil(3*sigmaT),blend=strength/100;
 const output=clean.map((r,i)=>r.map((v,c)=>{
  const manual=protectedRanges.some(([a,b])=>i/fps>=a&&i/fps<=b);if(manual){protection[i]=1;return rows[i][c];}
  const p=dilated[i][c];protection[i]=Math.max(protection[i],p);
  // Range weighting prevents a sharp transition from bleeding into a plateau.
  const sigmaValue=Math.max(2,3*noise[c]);let sum=0,total=0;
  for(let j=Math.max(0,i-radius);j<=Math.min(n-1,i+radius);j++){const w=Math.exp(-.5*((j-i)/sigmaT)**2-.5*((clean[j][c]-v)/sigmaValue)**2);sum+=w*clean[j][c];total+=w;}
  return v+(sum/total-v)*blend*(1-p);
 }));
 return {rows:output,protection};
}
export function createSmoothing(host,motions,onChange){
 const key='augmented-arms-smoothing-v1';let saved={};try{saved=JSON.parse(localStorage.getItem(key))||{};}catch{}
 let clip='1',enabled=true,strength=30,mode='adaptive',windowSeconds=.9,ranges=[];const cache=new Map();
 host.innerHTML=`<div class="section-heading"><h2>スムージング</h2><label><input id="smooth-enabled" type="checkbox" checked> 有効</label></div><div class="row"><label>方式 <select id="smooth-mode"><option value="adaptive">自動判別（鋭い動きを残す）</option><option value="average">従来の時間平均</option></select></label></div><p class="curve-help" id="smooth-help"></p><div id="adaptive-controls"><label for="smooth-strength">効き具合 <output id="smooth-value">30%</output></label><input id="smooth-strength" type="range" min="0" max="100" step="1" value="30" aria-label="スムージングの効き具合"><div class="chart-caption"><span>0：元の動き</span><span>100：強く滑らかに</span></div></div><div id="average-controls"><label for="smooth-window">時間窓（全幅）</label><div class="row"><input id="smooth-window-number" aria-label="時間窓（秒）" type="number" min="0" max="3" step="0.1" value="0.9"><span>秒</span></div><input id="smooth-window" aria-label="時間窓の調整" type="range" min="0" max="3" step="0.1" value="0.9"><p id="window-detail" class="curve-help"></p></div><p id="smooth-status" class="curve-help"></p><svg id="smooth-detection" viewBox="0 0 300 34" role="img" aria-label="動きを優先する区間"></svg><p class="curve-help">明るい区間：いずれかの関節で元の動きを優先。自動判別は推定です。</p><details><summary>残したい区間を指定</summary><div class="row"><label>開始秒 <input id="protect-start" type="number" min="0" value="0" step="0.1"></label><label>終了秒 <input id="protect-end" type="number" min="0" value="1" step="0.1"></label></div><div class="row"><button id="protect-add">区間を保護</button><button id="protect-clear">保護を解除</button></div><p id="protect-list" class="curve-help"></p></details><p class="curve-help">Motionごとに自動保存。元データは変更しません。</p>`;
 const $=id=>host.querySelector('#'+id);
 function result(id,side){const k=id+side+strength+mode+windowSeconds+JSON.stringify(ranges);if(!cache.has(k)){const raw=motions.clips[id][side];cache.set(k,mode==='adaptive'?adaptiveSmooth(raw,strength,30,ranges):{rows:windowSmoothRows(raw,windowSeconds).map((r,i)=>ranges.some(([a,b])=>i/30>=a&&i/30<=b)?raw[i]:r),protection:raw.map(()=>0)});}return cache.get(k);}
 function draw(){$('adaptive-controls').hidden=mode!=='adaptive';$('average-controls').hidden=mode!=='average';$('smooth-help').textContent=mode==='adaptive'?'自動判別は動きの継続・切り返し・関節の連動を手がかりに、平滑化を弱めます。':'指定した時間窓で、前後の値をガウス重み付き平均します。時間は元データ基準です。';$('smooth-window').value=windowSeconds;$('smooth-window-number').value=windowSeconds;$('window-detail').textContent=windowSeconds?`前後各${(windowSeconds/2).toFixed(2)}秒 · 30fpsで前後各${Math.round(windowSeconds*15)}コマ（端は利用できる範囲）`:'0秒：元の動き';$('smooth-detection').hidden=mode!=='adaptive';$('smooth-detection').nextElementSibling.hidden=mode!=='adaptive';$('smooth-enabled').checked=enabled;$('smooth-strength').value=strength;$('smooth-value').textContent=strength+'%';$('smooth-mode').value=mode;$('smooth-status').textContent=enabled&&(mode==='adaptive'?strength:windowSeconds)?(mode==='adaptive'?'自動判別を適用中 · 急動作を優先して揺れを抑制':'従来の時間平均を適用中'):'オフ · 元の動きを表示';$('protect-list').textContent=ranges.length?ranges.map(([a,b])=>a.toFixed(2)+'〜'+b.toFixed(2)+'秒').join(' / '):'保護区間なし';const r=result(clip,'R').protection,l=result(clip,'L').protection,n=Math.max(r.length,l.length);$('smooth-detection').innerHTML=Array.from({length:n},(_,i)=>`<rect x="${i*300/n}" y="2" width="${300/n+.1}" height="20" fill="#89d6c5" opacity="${enabled&&strength ? .12+.88*Math.max(r[i]||0,l[i]||0):.12}"/>`).join('')+`<text x="0" y="33" fill="#a0acbd" font-size="9">0秒</text><text x="300" y="33" text-anchor="end" fill="#a0acbd" font-size="9">${(n/30).toFixed(2)}秒</text>`;}
 function change(){saved[clip]={enabled,strength,mode,windowSeconds,ranges};localStorage.setItem(key,JSON.stringify(saved));cache.clear();draw();onChange();}
 for(const id of ['smooth-window','smooth-window-number'])$(id).oninput=e=>{const v=e.target.valueAsNumber;if(Number.isFinite(v)&&v>=0&&v<=3){windowSeconds=v;change();}};
 $('smooth-mode').onchange=e=>{mode=e.target.value;change();};$('protect-add').onclick=()=>{const a=$('protect-start').valueAsNumber,b=$('protect-end').valueAsNumber,end=Math.max(motions.clips[clip].R.length,motions.clips[clip].L.length)/30;if(!Number.isFinite(a)||!Number.isFinite(b)||a<0||b<=a||b>end){$('protect-list').textContent='開始 < 終了になるよう、記録の範囲内で指定してください。';return;}ranges.push([a,b]);change();};$('protect-clear').onclick=()=>{ranges=[];change();};
 $('smooth-strength').oninput=e=>{strength=+e.target.value;change();};$('smooth-enabled').onchange=e=>{enabled=e.target.checked;change();};
 return {setClip(id){clip=id;const s=saved[id];enabled=s?s.enabled!==false:!motions.metadata?.[clip]?.bakedEdits;strength=Number.isFinite(s?.strength)?Math.max(0,Math.min(100,s.strength)):30;mode=s?.mode==='average'?'average':'adaptive';windowSeconds=Number.isFinite(s?.windowSeconds)?bound(s.windowSeconds,0,3):Math.round(strength*.3)/10;ranges=Array.isArray(s?.ranges)?s.ranges.filter(r=>Array.isArray(r)&&r.length===2&&r.every(Number.isFinite)&&r[0]>=0&&r[1]>r[0]).map(r=>[...r]):[];cache.clear();draw();},rows(id,side){const raw=motions.clips[id][side];if(!enabled||(mode==='adaptive'?!strength:!windowSeconds))return raw;return result(id,side).rows;}};
}
