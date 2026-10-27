"""Author display-compatible finger commands without changing arm channels.

Right hand: two provisional tendon controls. Left: one coupled hook control.
Original recordings are not accepted. Re-run is deterministic and idempotent.
Canonical full rebuild calls add_fingers after the markc coordinate conversion.
"""
import copy,math,json,argparse,hashlib,tempfile,os
from pathlib import Path
VERSION='authored-fingers-v1'
PROFILES={
 'bird-flap':('flutter',3450,650,650),
 'hand-waves':('flutter',3400,680,800),
 'alternating-waves':('alternating',3400,680,800),
 'bird-flap-back-up':('flutter',3450,650,650),
 'hand-waves-back-up':('flutter',3400,680,800),
 'alternating-waves-back-up':('alternating',3400,680,800),
 'dab-pose':('soft',3250,800,650),
 'dab-pose-back-up':('soft',3250,800,650),
 'banzai':('open',3891,405,530),
 'banzai-natural':('natural-open',3700,550,650),
 'surrender':('open',3891,405,530),
 'present':('open',3891,405,1450),
 'shrug':('soft',3500,650,650),
 'victory':('fist',672,2984,2820),
 'guard':('fist',672,2984,2820),
 'bow-draw':('bow-string',1000,2700,2700),
 'hug':('soft-grasp',1250,2500,1600),
}
def smooth(x):
 x=max(0.,min(1.,x));return x*x*x*(10+x*(-15+6*x))
def pulse(u,start,end):
 if not start<u<end:return 0.
 return math.sin(math.pi*(u-start)/(end-start))**2

def add_fingers(m,ident):
 assert ident in PROFILES and not ident.startswith('recorded-')
 assert m.get('generation',{}).get('modelInterpretationVersion')=='markc-authored-v1'
 out=copy.deepcopy(m);kind,target8,target9,targetL=PROFILES[ident]
 base={'R':[3891,405],'L':[2899]}
 for side in ['R','L']:
  n=len(out[side])
  for i,row in enumerate(out[side]):
   u=i/(n-1);envelope=smooth((u-.02)/.30)*(1-smooth((u-.69)/.29))
   preparation=pulse(u,0,.30)
   if side=='R':
    r8=3891+envelope*(target8-3891);r9=405+envelope*(target9-405)
    if kind in ('open','natural-open'):
     r8-=850*preparation;r9+=350*preparation
    if kind in ('flutter','alternating','natural-open'):
     period=2.6 if ident.startswith('bird-flap') else 3.1
     phase=2*math.pi*(i/30)/period
     # Independent tendon modulation; generated values remain in raw CSV units.
     r8-=envelope*110*(.5+.5*math.sin(phase))
     r9+=envelope*100*(.5+.5*math.sin(phase+.65))
    if kind=='bow-string':
     seconds=i/30;release=1-smooth((seconds-6.7)/2.3)
     catch=smooth(seconds/1.8)*release;tighten=smooth((seconds-1.8)/1.0)*release
     r8=3891+(1400-3891)*catch+(1000-1400)*tighten
     r9=405+(2400-405)*catch+(2700-2400)*tighten
    row[7:9]=[round(max(0,min(4095,r8))),round(max(0,min(4095,r9)))]
   else:
    count=2899+envelope*(targetL-2899)
    if kind in ('fist','grasp'):
     # Release before grasping; a closed initial left hand must not remain static.
     count-=1600*preparation+750*pulse(u,.70,1.)
    elif kind in ('flutter','alternating','natural-open'):
     phase=2*math.pi*(i/30)/3.1+(math.pi if kind=='alternating' else .25)
     count+=envelope*100*(.5+.5*math.sin(phase))
    if kind=='bow-string':
     seconds=i/30;grip=smooth(seconds/1.6)*(1-smooth((seconds-8.7)/1.3))
     count=2899+(2700-2899)*grip-900*pulse(seconds,0,1.5)
    row[7]=round(max(494,min(2899,count)))
  out[side][0][7:]=base[side];out[side][-1][7:]=base[side]
  assert [r[:7] for r in m[side]]==[r[:7] for r in out[side]],'Arm trajectory changed'
  assert all(0<=v<=4095 for row in out[side] for v in row[7:])
  assert max(abs(b[j]-a[j]) for a,b in zip(out[side],out[side][1:]) for j in range(7,len(a)))<100,'Finger step exceeds numeric continuity guard'
 out.setdefault('generation',{}).update(fingerMotionVersion=VERSION,fingerProfile=kind,
  fingerTargets={'R':[target8,target9],'L':[targetL]},
  fingerCalibration='Provisional two-tendon right / coupled left-hook display model; physical limits, slack, cable forces, finger torque and hardware playback not verified')
 if kind=='bow-string':out['generation']['fingerPhasesSeconds']={'catchBy':1.8,'tightenBy':2.8,'holdUntil':6.7,'releaseBy':9.0}
 return out

def main():
 ap=argparse.ArgumentParser(description=__doc__);ap.add_argument('--directory',type=Path,default=Path(__file__).resolve().parents[1]/'motion-data');ap.add_argument('--apply',action='store_true');args=ap.parse_args()
 entries=json.loads((args.directory/'generated-motions.json').read_text());prepared={}
 for e in entries:
  if e['id'] not in PROFILES:continue
  p=args.directory/e['file'];m=add_fingers(json.loads(p.read_text()),e['id']);prepared[p]=json.dumps(m,ensure_ascii=False,separators=(',',':')).encode()
 assert len(prepared)==17
 backup=None
 if args.apply:
  backup=Path(tempfile.mkdtemp(prefix='shosaedit-before-authored-fingers-'));prior={p:p.read_bytes() for p in prepared}
  for p,raw in prior.items():(backup/p.name).write_bytes(raw)
  try:
   for p,raw in prepared.items():
    fd,tmp=tempfile.mkstemp(dir=p.parent,prefix=p.name+'.')
    with os.fdopen(fd,'wb') as f:f.write(raw)
    os.replace(tmp,p)
  except BaseException:
   for p,raw in prior.items():p.write_bytes(raw)
   raise
 print(json.dumps({'applied':args.apply,'motions':len(prepared),'backup':str(backup) if backup else None,'sha256':{p.name:hashlib.sha256(raw).hexdigest() for p,raw in prepared.items()}},indent=2))
if __name__=='__main__':main()
