// Display-only tendon interpretation. Never changes recorded/exported counts.
export const defaultFingerSettings={enabled:true,swapRight:false,rightGain:1,leftGain:1};
const clamp=x=>Math.max(0,Math.min(1,x));
const ramp=(x,start,width=.16)=>{const t=clamp((x-start)/width);return t*t*(3-2*t);};
export function fingerClosures(side,row,settings=defaultFingerSettings){
 if(side==='L')return [clamp((row[7]-494)/(2820-494))*settings.leftGain];
 let thumb=clamp((3906-row[7])/(3906-672)),little=clamp((row[8]+433)/(2984+433));
 if(settings.swapRight)[thumb,little]=[little,thumb];
 // Four chains exist in this CAD: thumb, two middle chains, little-side chain.
 // Nonlinear onset thresholds are provisional; not calibrated tendon mechanics.
 const a=[.12,.73,.88,.98],b=[1,.90,.75,.25];
 return a.map((t,i)=>Math.max(ramp(thumb,t),ramp(little,b[i]))*settings.rightGain);
}
