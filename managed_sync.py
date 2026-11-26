"""Mirror the explicitly managed motion files while bidirectional sync is on."""
import hashlib
import json
from pathlib import Path
from uuid import uuid4

SOURCES = {'front1_straight': 'alienware', 'front2_straight': 'alienware',
           'dancehalf_straight': 'video', 'dance_straight': 'video',
           'dance_lite_straight': 'video', 'test_straight': 'video'}


def sync_managed(root, cache, encode, validate):
    root, cache = Path(root), Path(cache)
    config_file = cache / 'settings.json'
    if not config_file.exists():
        return
    config = json.loads(config_file.read_bytes())
    if not (config.get('enabled') and config.get('mode') == 'both' and config.get('root') == str(root)):
        return
    if not all((root / port).is_dir() for port in ('COM14','COM15')):
        raise OSError('COM14 / COM15 unavailable')
    state = cache / 'managed'
    state.mkdir(exist_ok=True)
    for stem, folder in SOURCES.items():
        src = Path(__file__).parent / 'motion-data' / folder / (stem + '.motion.json')
        if not src.exists():
            continue
        raw = src.read_bytes()
        digest = hashlib.sha256(raw).hexdigest()
        receipt = state / (stem + '.json')
        previous = json.loads(receipt.read_bytes()) if receipt.exists() else {}
        if previous.get('root') == str(root) and previous.get('source') == digest:
            targets = [root / port / (stem + '.csv') for port in ('COM14', 'COM15')]
            if all(path.is_file() for path in targets) and (root / (stem + '.shosa-sync.json')).is_file():
                continue
        motion = json.loads(raw)
        snapshot = motion['calibrationSnapshot']
        validate(snapshot)
        files, hashes = {}, {}
        for side, port, width in [('L','COM14',8), ('R','COM15',9)]:
            rows = motion[side]
            if rows[0] != snapshot[side]['rest'] or rows[-1] != snapshot[side]['rest']:
                raise ValueError(stem + ': reference endpoints differ')
            data = encode(rows,width)
            files[root / port / (stem+'.csv')] = data
            hashes[side] = hashlib.sha256(data).hexdigest()
        sidecar = dict(format='shosa-sync-csv',version=1,name=stem,fps=30,hashes=hashes,calibrationSnapshot=snapshot)
        files[root / (stem+'.shosa-sync.json')] = json.dumps(sidecar,ensure_ascii=False).encode()
        paired = root / 'ShosaEdit_calibrations' / stem
        paired.mkdir(parents=True,exist_ok=True)
        files[paired / 'motion.json'] = raw
        files[paired / 'position.json'] = json.dumps(dict(time=snapshot['R']['calibratedAt'],R=snapshot['R']['rest'],L=snapshot['L']['rest']),ensure_ascii=False).encode()
        staged, originals, applied = {}, {}, []
        try:
            for dest, data in files.items():
                old = dest.read_bytes() if dest.exists() else None
                if old == data:
                    continue
                originals[dest] = old
                if old is not None:
                    backup = state / 'backups' / dest.parent.name / stem / hashlib.sha256(old).hexdigest()
                    backup.parent.mkdir(parents=True,exist_ok=True)
                    if not backup.exists():
                        backup.write_bytes(old)
                temp = dest.with_name('.'+uuid4().hex+'.tmp')
                staged[dest] = temp
                temp.write_bytes(data)
                if temp.read_bytes() != data:
                    raise OSError('Failed to stage '+str(dest))
            for dest,temp in staged.items():
                temp.replace(dest)
                applied.append(dest)
            for dest,data in files.items():
                if dest.read_bytes() != data:
                    raise OSError('Verification failed: '+str(dest))
            temp = receipt.with_suffix('.tmp')
            temp.write_text(json.dumps(dict(source=digest,root=str(root),hashes=hashes)))
            temp.replace(receipt)
        except Exception:
            for dest in reversed(applied):
                if originals[dest] is None:
                    dest.unlink(missing_ok=True)
                else:
                    dest.write_bytes(originals[dest])
            raise
        finally:
            for temp in staged.values():
                temp.unlink(missing_ok=True)
