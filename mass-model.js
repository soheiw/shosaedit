/** Material-based estimate, SI units. PLA shell volume is a surface-area/wall
 * approximation, not a slicer's toolpath or a measurement of the print.
 * Component inertias are about their COM; aggregation includes the full
 * parallel-axis tensor. Uniform density within each component is assumed.
 */
const matrix=()=>Array.from({length:3},()=>[0,0,0]);
function finite(v,name){if(!Number.isFinite(v))throw Error(`${name} must be finite`);return v;}
function vector(v,name){if(!Array.isArray(v)||v.length!==3||!v.every(Number.isFinite))throw Error(`${name} must be a finite SI 3-vector`);return [...v];}
function nonnegative(v,name){finite(v,name);if(v<0)throw Error(`${name} must be nonnegative`);return v;}
export function modelFromMaterials(shapes,settings={}){
 const infill=settings.infill??.2,density=settings.density??1240,wall=settings.wall??.0012;
 finite(infill,'PLA infill');if(infill<0||infill>1)throw Error('PLA infill must be 0..1');finite(density,'PLA density');if(density<=0)throw Error('PLA density must be positive');nonnegative(wall,'PLA wall thickness');
 if(!shapes||!Array.isArray(shapes.materialComponents))throw Error('Material component shapes required');
 const groups=Array.from({length:7},()=>[]);
 for(const c of shapes.materialComponents){
  if(!Number.isInteger(c.group)||c.group<0||c.group>7)throw Error('Component group must be 0..7');if(c.group===0)continue;
  const com=vector(c.com??c.comLocal??c.comlocalm,'Component COM'),U=c.unitMassInertia??c.unitMassInertiaM2;
  if(!Array.isArray(U)||U.length!==3)throw Error('Component unit-mass inertia required');U.forEach(r=>vector(r,'Component inertia'));for(let i=0;i<3;i++){nonnegative(U[i][i],'Inertia diagonal');for(let j=0;j<3;j++)if(Math.abs(U[i][j]-U[j][i])>1e-9)throw Error('Symmetric inertia required');}
  let mass;
  if(c.kind==='PLA'){
   const V=nonnegative(c.volumeM3,'PLA volume'),area=nonnegative(c.areaM2,'PLA area'),shell=Math.min(V,area*wall);mass=density*(infill*V+(1-infill)*shell);
  }else if(c.massKg!==undefined){mass=nonnegative(c.massKg,'Fixed component mass');}
  else if(c.kind==='aluminum'||c.kind==='steel'){
   const rho=c.densityKgM3??(c.kind==='aluminum'?2700:7850);finite(rho,'Metal density');if(rho<=0)throw Error('Metal density must be positive');mass=nonnegative(c.volumeM3,'Metal volume')*rho;
  }else throw Error('Unknown material or missing motor mass');
  groups[c.group-1].push({mass,com,U,kind:c.kind});
 }
 return groups.map((parts,index)=>{
  const mass=parts.reduce((sum,p)=>sum+p.mass,0),fallback=shapes.links?.find(l=>l.group===index+1)?.com??[0,0,0];
  const com=mass?parts.reduce((sum,p)=>sum.map((v,i)=>v+p.mass*p.com[i]/mass),[0,0,0]):vector(fallback,'Fallback COM'),inertia=matrix(),massBreakdown={};
  for(const p of parts){massBreakdown[p.kind]=(massBreakdown[p.kind]??0)+p.mass;const d=p.com.map((v,i)=>v-com[i]),r2=d.reduce((sum,v)=>sum+v*v,0);for(let i=0;i<3;i++)for(let j=0;j<3;j++)inertia[i][j]+=p.mass*(p.U[i][j]+(i===j?r2:0)-d[i]*d[j]);}
  if(!Number.isFinite(mass)||!com.every(Number.isFinite)||!inertia.flat().every(Number.isFinite))throw Error('Material calculation overflow');
  return {mass,com,inertia,massBreakdown};
 });
}
