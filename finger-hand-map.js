// Alienware HA/HB gesture samples. Display only: never transform motor CSVs.
// Half Fist (legacy key "peace"): all fingers bent; user requested slightly deeper display (60%).
export const handMaps={
 HA:{release:[3676,4189],fist:[-116,7265],point:[4084,6265],half:[884,6265],thumbup:[2884,7265]},
 HB:{release:[-208,3924],fist:[-4000,7000],point:[200,6000],half:[-3000,6000],thumbup:[-1000,7000]}
};
const poses={release:[0,0,0,0],fist:[1,1,1,1],point:[1,0,1,1],half:[.6,.6,.6,.6]};
export function mappedClosures(profile,a,b){
 const map=handMaps[profile];if(!map)return null;
 const scale=[Math.abs(map.fist[0]-map.release[0]),Math.abs(map.fist[1]-map.release[1])];
 const result=[0,0,0,0];let total=0;
 for(const [key,p] of Object.entries(map)){
  if(!poses[key])continue; // Thumb Up finger pose not yet confirmed; do not infer from its label.
  const d=((a-p[0])/scale[0])**2+((b-p[1])/scale[1])**2;
  if(d<1e-14)return [...poses[key]];
  const weight=1/(d*d);total+=weight;poses[key].forEach((v,i)=>result[i]+=weight*v);
 }
 // Smooth display interpolation between measured gesture presets, not a tendon solver.
 return result.map(v=>v/total);
}
