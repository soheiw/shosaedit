import csv
import hashlib
import io
import json
from pathlib import Path
import subprocess
import sys
import tempfile
import threading
import time
import unittest
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
import motion_sync as syncmod
from motion_sync import MotionSync, _scan, _publish, _parse


class MotionSyncTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.base = Path(self.tmp.name)
        self.root = self.base / 'share'
        for side in ('COM14', 'COM15'):
            (self.root / side).mkdir(parents=True)
        self.syncs = []

    def tearDown(self):
        for sync in self.syncs:
            sync.close()
        self.tmp.cleanup()

    def make_sync(self, **kwargs):
        s = MotionSync(self.base / ('cache-' + str(len(self.syncs))), **kwargs)
        self.syncs.append(s)
        return s

    def csv(self, side, name='記録', value=100, rows=4, newline='\n'):
        width = 8 if side == 'COM14' else 9
        raw = (newline.join(','.join(str(value + i + j) for j in range(width)) for i in range(rows)) + newline).encode()
        path = self.root / side / (name + '.csv')
        path.write_bytes(raw)
        return path, raw

    def pair(self, name='記録'):
        return [self.csv(side, name) for side in ('COM14', 'COM15')]

    def ingest_twice(self, sync):
        sync._config.update(root=str(self.root), enabled=True)
        sync._ingest(_scan(self.root), str(self.root), sync._epoch)
        self.assertEqual(sync.list_motions(), [])
        sync._ingest(_scan(self.root), str(self.root), sync._epoch)
        return sync.list_motions()[0]

    def test_pair_stability_raw_bytes_and_unknown_calibration(self):
        originals = self.pair()
        s = self.make_sync(poll_interval=100)
        item = self.ingest_twice(s)
        motion = s.read_motion(item['id'])
        self.assertEqual(motion['fps'], 30)
        self.assertTrue(motion['calibrationRequired'])
        self.assertNotIn('calibrationSnapshot', motion)
        for port, raw in zip(('COM14', 'COM15'), [v[1] for v in originals]):
            self.assertEqual((s.cache_dir / item['id'] / (port + '.csv')).read_bytes(), raw)
        self.assertEqual([p.read_bytes() for p, _ in originals], [raw for _, raw in originals])

    def test_missing_side_and_incomplete_write_are_not_imported(self):
        self.csv('COM14')
        result = _scan(self.root)
        self.assertEqual(result['pairs'], [])
        self.assertEqual(len(result['pending']), 1)
        p, _ = self.csv('COM15')
        p.write_text('1,2,3\n')
        self.assertEqual(_scan(self.root)['pairs'], [])
        self.csv('COM15')
        s = self.make_sync(poll_interval=100)
        s._config.update(root=str(self.root), enabled=True)
        s._ingest(_scan(self.root), str(self.root), s._epoch)
        self.csv('COM15', value=150)
        s._ingest(_scan(self.root), str(self.root), s._epoch)
        self.assertEqual(s.list_motions(), [])
        s._ingest(_scan(self.root), str(self.root), s._epoch)
        self.assertEqual(len(s.list_motions()), 1)

    def payload(self, name='新しい動き'):
        snapshot = {'version': 1, 'resolution': 4096, 'label': 'unchanged test snapshot'}
        for side, width, start in [('R', 9, 1), ('L', 8, 11)]:
            snapshot[side] = {'ids': list(range(start, start + width)), 'zero': [0] * width,
                'joints': [{'motor': i - 1, 'gain': 1, 'pivot': [0, i * 10, 0], 'axis': [0, 0, 1]} for i in range(8)]}
        return {'name': name, 'R': [[1] * 9, [2] * 9], 'L': [[3] * 8, [4] * 8],
                'calibrationSnapshot': snapshot}

    def test_publish_unicode_conflict_no_overwrite_and_exact_noop(self):
        original = self.pair('新しい動き')
        result = _publish(self.root, self.payload())
        self.assertEqual(result['name'], '新しい動き (2)')
        self.assertEqual(result['status'], 'published')
        self.assertEqual(_publish(self.root, self.payload())['status'], 'unchanged')
        for path, raw in original:
            self.assertEqual(path.read_bytes(), raw)
        sidecar = json.loads((self.root / '新しい動き (2).shosa-sync.json').read_text())
        self.assertEqual(sidecar['calibrationSnapshot'], self.payload()['calibrationSnapshot'])
        result = _scan(self.root)
        imported = next(p for p in result['pairs'] if p['name'] == '新しい動き (2)')
        self.assertEqual(imported['capturedCalibrationSnapshot'], self.payload()['calibrationSnapshot'])
        (self.root / 'COM14' / '新しい動き (2).csv').write_text('5,5,5,5,5,5,5,5\n')
        pair = next(p for p in _scan(self.root)['pairs'] if p['name'] == '新しい動き (2)')
        self.assertNotIn('capturedCalibrationSnapshot', pair)

    def test_partial_publish_failure_cleans_only_own_new_files(self):
        old = self.pair('existing')
        real_open = Path.open
        def fail_second(path, *args, **kwargs):
            if path.parent.name == 'COM15' and path.name == 'new.csv' and args and args[0] == 'xb':
                raise OSError('simulated disconnected share')
            return real_open(path, *args, **kwargs)
        with patch.object(Path, 'open', fail_second):
            with self.assertRaises(OSError):
                _publish(self.root, self.payload('new'))
        self.assertFalse((self.root / 'COM14' / 'new.csv').exists())
        self.assertFalse((self.root / 'COM15' / 'new.csv').exists())
        for path, raw in old:
            self.assertEqual(path.read_bytes(), raw)

    def test_reject_path_traversal_nonintegers_and_bad_width(self):
        for name in ('../x', '..', 'A/B', 'A\\B', 'NUL', ''):
            with self.assertRaises(ValueError):
                _publish(self.root, self.payload(name))
        for raw in (b'a,b,c\n', b'1.5,' + b'1,' * 6 + b'1\n', b'1,2\n'):
            with self.assertRaises(ValueError):
                _parse(raw, 8)
        payload = self.payload()
        payload['R'][0][0] = float('nan')
        with self.assertRaises(ValueError):
            _publish(self.root, payload)

    def test_invalid_calibration_snapshots_rejected(self):
        for change in ('empty', 'nan', 'ids', 'zero', 'axis', 'motor'):
            payload = self.payload()
            snapshot = payload['calibrationSnapshot']
            if change == 'empty':
                payload['calibrationSnapshot'] = {}
            elif change == 'nan':
                snapshot['R']['joints'][1]['gain'] = float('nan')
            elif change == 'ids':
                snapshot['L']['ids'][0] = 1
            elif change == 'zero':
                snapshot['R']['zero'].pop()
            elif change == 'axis':
                snapshot['R']['joints'][0]['axis'] = [0, 0, 0]
            elif change == 'motor':
                snapshot['R']['joints'][0]['motor'] = 100
            with self.subTest(change=change), self.assertRaises(ValueError):
                _publish(self.root, payload)

    def test_replaced_same_name_preserves_old_revision_and_raw_cache(self):
        old_files = self.pair()
        s = self.make_sync(poll_interval=100)
        old_item = self.ingest_twice(s)
        old_motion = s.read_motion(old_item['id'])
        for port in ('COM14', 'COM15'):
            self.csv(port, value=200)
        s._ingest(_scan(self.root), str(self.root), s._epoch)
        self.assertEqual(len(s.list_motions()), 1)
        s._ingest(_scan(self.root), str(self.root), s._epoch)
        self.assertEqual(len(s.list_motions()), 2)
        self.assertEqual(s.read_motion(old_item['id']), old_motion)
        for port, (_, raw) in zip(('COM14', 'COM15'), old_files):
            self.assertEqual((s.cache_dir / old_item['id'] / (port + '.csv')).read_bytes(), raw)
        # Touching without changing content does not create a third revision.
        import os
        for port in ('COM14', 'COM15'):
            os.utime(self.root / port / '記録.csv', None)
        for _ in range(2):
            s._ingest(_scan(self.root), str(self.root), s._epoch)
        self.assertEqual(len(s.list_motions()), 2)

    def test_casefold_conflict_and_symlink_escape(self):
        self.pair('OLD')
        result = _publish(self.root, self.payload('old'))
        self.assertEqual(result['name'], 'old (2)')
        outside = self.base / 'outside.csv'
        outside.write_text('1,2,3,4,5,6,7,8\n')
        (self.root / 'COM14' / 'escape.csv').symlink_to(outside)
        self.csv('COM15', 'escape')
        self.assertNotIn('escape', [p['name'] for p in _scan(self.root)['pairs']])

    def test_disabled_by_default_and_config_validation(self):
        s = self.make_sync(poll_interval=100)
        self.assertFalse(s.get_status()['enabled'])
        with self.assertRaises(ValueError):
            s.publish(self.payload())
        with self.assertRaises(ValueError):
            s.configure({'root': 'relative'})
        with self.assertRaises(ValueError):
            s.configure({'mode': 'unsafe'})

    def test_worker_timeout_is_bounded(self):
        s = self.make_sync(worker_timeout=0.04, poll_interval=100)
        real_popen = subprocess.Popen
        def delayed(*args, **kwargs):
            return real_popen([sys.executable, '-c', 'import time; time.sleep(10)'], **kwargs)
        started = time.monotonic()
        with patch.object(syncmod.subprocess, 'Popen', delayed):
            with self.assertRaises(TimeoutError):
                s._call_worker({'operation': 'scan', 'root': str(self.root)})
        self.assertLess(time.monotonic() - started, 1)

    def test_real_async_worker_pair_import_and_disconnect(self):
        self.pair()
        s = self.make_sync(poll_interval=0.04)
        before = time.monotonic()
        s.configure({'root': str(self.root), 'enabled': True, 'mode': 'pull'})
        self.assertLess(time.monotonic() - before, .2)
        deadline = time.monotonic() + 5
        while time.monotonic() < deadline and not s.list_motions():
            time.sleep(.02)
        self.assertEqual(len(s.list_motions()), 1)
        self.assertTrue(s.get_status()['online'])
        s.configure({'root': str(self.base / 'missing'), 'enabled': True})
        deadline = time.monotonic() + 3
        while time.monotonic() < deadline and not s.get_status()['lastError']:
            time.sleep(.02)
        self.assertFalse(s.get_status()['online'])
        self.assertTrue(s.get_status()['lastError'])
        self.assertEqual(len(s.list_motions()), 1)  # Last local cache survives disconnect.

    def test_config_persists_and_failed_outbox_can_retry_after_restart(self):
        s = self.make_sync(poll_interval=100)
        missing = self.base / 'offline'
        s.configure({'root': str(missing), 'enabled': True, 'mode': 'both'})
        queued = s.publish(self.payload())
        deadline = time.monotonic() + 3
        while time.monotonic() < deadline and not any(j['status'] == 'error' for j in s.get_status()['publishes']):
            time.sleep(.01)
        self.assertTrue(any(j['status'] == 'error' for j in s.get_status()['publishes']))
        s.close()
        restored = MotionSync(s.cache_dir, poll_interval=100)
        self.syncs.append(restored)
        self.assertEqual(restored.get_status()['root'], str(missing))
        self.assertTrue(restored.get_status()['enabled'])
        self.assertEqual(restored.get_status()['mode'], 'both')
        self.assertFalse(missing.exists())
        for port in ('COM14', 'COM15'):
            (missing / port).mkdir(parents=True)
        restored.retry_publish(queued['jobId'])
        deadline = time.monotonic() + 3
        while time.monotonic() < deadline and not (missing / 'COM15' / '新しい動き.csv').exists():
            time.sleep(.01)
        self.assertTrue((missing / 'COM15' / '新しい動き.csv').exists())
        self.assertTrue((missing / 'COM14' / '新しい動き.csv').exists())

    def test_retry_rejects_different_share_and_disabled(self):
        s = self.make_sync(poll_interval=100)
        s.configure({'root': str(self.base / 'offline'), 'enabled': True, 'mode': 'both'})
        job = s.publish(self.payload())
        deadline = time.monotonic() + 3
        while time.monotonic() < deadline and not any(j['status'] == 'error' for j in s.get_status()['publishes']):
            time.sleep(.01)
        s.configure({'enabled': False})
        with self.assertRaises(ValueError):
            s.retry_publish(job['jobId'])
        s.configure({'enabled': True, 'root': str(self.root)})
        with self.assertRaises(ValueError):
            s.retry_publish(job['jobId'])
        self.assertEqual(list((self.root / 'COM14').iterdir()), [])


if __name__ == '__main__':
    unittest.main()
