// Read-only telemetry analysis. Never treats a command, PWM or percent-load as current.
export const MODEL_CURRENT_SPECS = {
 'XM540-W150-R': {rawUnitMa:2.69, torquePerAmpNm:7.3/4.4, source:'https://emanual.robotis.com/docs/en/dxl/x/xm540-w150/'},
 'XM430-W350-R': {rawUnitMa:2.69, torquePerAmpNm:4.1/2.3, source:'https://emanual.robotis.com/docs/en/dxl/x/xm430-w350/'},
 'XC330-T288-T': {rawUnitMa:1, torquePerAmpNm:1/.88, source:'https://emanual.robotis.com/docs/en/dxl/x/xc330-t288/'},
 'XC330-T181-T': {rawUnitMa:1, torquePerAmpNm:.8/.88, source:'https://emanual.robotis.com/docs/en/dxl/x/xc330-t181/'}
};
export const CHANNELS=['R','L'].flatMap(side=>Array.from({length:side==='R'?9:8},(_,j)=>({side,id:side==='R'?j+1:j+11,joint:j+1,key:`${side}${side==='R'?j+1:j+11}`,label:`${side}${j+1} (ID${side==='R'?j+1:j+11})`})));
const knownModels={1:'XM540-W150-R',2:'XM540-W150-R',3:'XM430-W350-R',4:'XM540-W150-R',6:'XC330-T288-T',7:'XC330-T288-T'};
export function getDefaultSettings(){return Object.fromEntries(CHANNELS.map(c=>{const model=knownModels[c.joint]??'';return [c.key,{model,torquePerAmpNm:MODEL_CURRENT_SPECS[model]?.torquePerAmpNm??null,allowableTorqueNm:null}];}));}
const finite=value=>typeof value==='number'&&Number.isFinite(value);
const positive=value=>finite(value)&&value>0;
export function decodePresentCurrent(raw,model){
 const unit=MODEL_CURRENT_SPECS[model]?.rawUnitMa;
 if(!unit||!Number.isInteger(raw)||raw < -32768||raw>65535)return null;
 return (raw>32767?raw-65536:raw)*unit/1000;
}
export function evaluateSample(sample,settings=getDefaultSettings(),nowMs=Date.now()){
 const timestampMs=finite(sample?.timestampMs)?sample.timestampMs:null;
 const channels=CHANNELS.map(c=>{
  const candidates=(Array.isArray(sample?.channels)?sample.channels:[]).filter(x=>x.side===c.side&&x.id===c.id);
  const source=candidates.length===1?candidates[0]:null,config=settings[c.key]??{};
  const stamp=finite(source?.timestampMs)?source.timestampMs:timestampMs;
  const age=stamp===null?Infinity:nowMs-stamp;
  const status=!source||sample?.connected===false||!finite(source.currentA)||source.valid===false?'unavailable':sample?.fresh===false||source.fresh===false||age>2000||age < 0?'stale':'fresh';
  const currentA=status==='fresh'?source.currentA:null;
  const coefficient=positive(config.torquePerAmpNm)?config.torquePerAmpNm:null;
  const torqueNm=currentA!==null&&coefficient!==null?currentA*coefficient:null;
  const limit=positive(config.allowableTorqueNm)?config.allowableTorqueNm:null;
  return {...c,status,timestampMs:stamp,model:config.model??'',coefficientSource:'仕様表の停止点比による概算／係数編集可・未校正',currentA,torqueNm,loadPercent:torqueNm!==null&&limit!==null?Math.abs(torqueNm)/limit*100:null,allowableTorqueNm:limit,temperatureC:status==='fresh'&&finite(source.temperatureC)?source.temperatureC:null,voltageV:status==='fresh'&&finite(source.voltageV)?source.voltageV:null,torqueEnabled:status==='fresh'&&typeof source.torqueEnabled==='boolean'?source.torqueEnabled:null};
 });
 return {timestampMs,status:channels.some(c=>c.status==='fresh')?'fresh':channels.some(c=>c.status==='stale')?'stale':'unavailable',channels};
}
