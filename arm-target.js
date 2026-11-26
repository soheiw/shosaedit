import {retargetRecording} from './retarget-motion.js';
import {validateCalibrationSnapshot} from './arm-calibration.js';

// Originals are never replaced by a transformed view, including repeated switches.
export function createArmTargetBank(sourceConfiguration){
 const originals=new Map();let target=null,mappings={};
 const key=r=>JSON.stringify(r.calibrationSnapshot||sourceConfiguration(r));
 function convert(recording){return target?retargetRecording(recording,sourceConfiguration(recording),target,{fingerMappings:mappings[key(recording)]||{}}):structuredClone(recording);}
 return {
  remember(id,recording){originals.set(id,structuredClone(recording));return convert(recording);},
  original(id){return structuredClone(originals.get(id));},
  preview(id,snapshot,fingers={}){const r=originals.get(id);if(!r)throw Error('Motion source missing');return snapshot?retargetRecording(r,sourceConfiguration(r),snapshot,{fingerMappings:fingers}):structuredClone(r);},
  sourceKey(id){return key(originals.get(id));},
  select(snapshot,fingers={},sourceKey){target=snapshot?validateCalibrationSnapshot(snapshot):null;mappings=sourceKey?{[sourceKey]:structuredClone(fingers)}:{};const result=new Map();for(const [id,r]of originals){try{result.set(id,{recording:convert(r)});}catch(error){result.set(id,{error:error.message});}}return result;},
  selection(){return target?structuredClone(target):null;}
 };
}
