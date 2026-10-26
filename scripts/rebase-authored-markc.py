"""Convert legacy authored clips to the accepted markc encoder reference.

Input must be an authored clip (never a recording), after the shared3025 wrist
rebase. Left joints1/7 reverse encoder deltas because their interpreted axes
reversed. Finger columns remain constant at the new reference. No retiming.
"""
import copy
VERSION='markc-authored-v1'
OLD={'R':[2535,2916,2034,2974,3611,3025,1890,3492,396], 'L':[2035,1112,2258,1166,1895,2003,2164,3213]}
NEW={'R':[2541,2947,1022,1892,1524,2017,1814,3891,405], 'L':[2034,1115,2079,1168,1905,1987,2268,2899]}
def convert(m):
 if m.get('generation',{}).get('modelInterpretationVersion')==VERSION:return m
 assert m.get('generation',{}).get('rightWristReference')==3025
 out=copy.deepcopy(m);maximum=0
 for side in ['R','L']:
  for before,after in zip(m[side],out[side]):
   for i,value in enumerate(before):
    delta=value-OLD[side][i]
    if side=='L' and i in (0,6):delta=-delta
    result=NEW[side][i]+delta
    # Legacy -90deg upper-arm target exceeds the new single-turn zero by
    # only2ticks. Saturate this tiny endpoint excess; never wrap4096ticks.
    if side=='R' and i==2 and -2<=result<0:
     maximum=max(maximum,-result);result=0
    assert 0<=result<=4095,(side,i,result)
    after[i]=result
 out['referenceProfile']='markc-video-reference'
 out['generation'].update(modelInterpretationVersion=VERSION,
   encoderReference=copy.deepcopy(NEW),leftAxisDeltaReversals=[1,7],
   singleTurnEndpointAdjustmentTicks=maximum,
   calibrationStatus='Approximate markc video reference; physical calibration unverified')
 # Full rotations agree with legacy intentions except the explicit <=2tick
 # upper-arm endpoint guard. With fixed anchors this bounds all FK changes.
 for side in ['R','L']:
  for before,after in zip(m[side],out[side]):
   for i in range(7):
    expected=before[i]-OLD[side][i]
    actual=(after[i]-NEW[side][i])*(-1 if side=='L' and i in (0,6) else 1)
    assert abs(actual-expected)<=(2 if side=='R' and i==2 else 0)
 return out
