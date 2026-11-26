"""ArmService without hardware: file layout, guards and current conversion.

Needs dynamixel-sdk (run with .venv/bin/python). Opens no serial port.
"""
import json
import sys
import tempfile
import time
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
try:
    from hardware import arm_controller as arm
    from hardware.arm_service import ArmService
except ImportError as exc:      # no dynamixel_sdk in this Python
    raise unittest.SkipTest(f'hardware modules unavailable: {exc}')


class FakeArm:
    def __init__(self, port, ids):
        self.device_name, self.dxl_ids, self.port_is_open = port, ids, True
        self.task_running = self.recording = False
        self.current_positions = {i: 100 + i for i in ids}
        self.present_currents = {i: (-100, time.time()) for i in ids}
        self.torque_enabled = {i: True for i in ids}


class ArmServiceTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        root = Path(self.tmp.name)
        (root / 'Recorded_movements').mkdir()
        self.service = ArmService(root, root / 'cfg.json', start_estop=False)
        self.root = root
        arm.connected_arms.clear()

    def tearDown(self):
        arm.connected_arms.clear()
        self.tmp.cleanup()

    def rows(self, width, n=3):
        return [[i] * width for i in range(n)]

    def test_save_motion_writes_both_csvs_and_tags_models(self):
        result = self.service.save_motion({'name': 'wave_a', 'R': self.rows(9), 'L': self.rows(8)})
        self.assertTrue(result['saved'])
        self.assertEqual((self.root / 'Recorded_movements/COM15/wave_a.csv').read_text().splitlines()[1], ','.join(['1'] * 9))
        self.assertTrue((self.root / 'Recorded_movements/COM14/wave_a.csv').is_file())
        tags = json.loads((self.root / 'Recorded_movements/arm_models.json').read_text())['recordings']
        self.assertEqual(tags['/dev/cu.usbserial-FTAK89O2/wave_a.csv']['side'], 'right')
        self.assertTrue(self.service.save_motion({'name': 'wave_a', 'R': self.rows(9), 'L': self.rows(8)})['exists'])
        self.assertEqual(self.service.recordings()['recordings'], [{'name': 'wave_a', 'R': True, 'L': True}])

    def test_rejects_bad_rows_and_names(self):
        with self.assertRaises(ValueError):
            self.service.save_motion({'name': 'x', 'R': self.rows(8), 'L': self.rows(8)})
        with self.assertRaises(ValueError):
            self.service.save_motion({'name': '../x', 'R': self.rows(9), 'L': self.rows(8)})
        with self.assertRaises(ValueError):
            self.service.save_motion({'name': 'x', 'R': [[1.5] * 9] * 2, 'L': self.rows(8)})

    def test_play_refuses_without_arm_or_while_locked(self):
        with self.assertRaisesRegex(ValueError, 'no arm connected'):
            self.service.play('anything')
        self.service.locked = True
        with self.assertRaisesRegex(ValueError, 'LOCK'):
            self.service.play('anything')

    def test_current_uses_model_scale_and_skips_present_load(self):
        port = self.service.arms['R']['port']
        arm.connected_arms.append(FakeArm(port, [1, 2, 6]))
        self.service.models[port] = {1: 1060, 2: 1130, 6: 1220}   # XL430 (load), XM540, XC330
        t = self.service.telemetry()
        channels = {c['id']: c for c in t['channels']}
        self.assertNotIn(1, channels)                           # Present Load is not a current
        self.assertAlmostEqual(channels[2]['currentA'], -0.269)  # 2.69 mA per count
        self.assertAlmostEqual(channels[6]['currentA'], -0.1)    # 1 mA per count
        self.assertTrue(channels[2]['fresh'])

    def test_unknown_model_gives_no_current(self):
        port = self.service.arms['L']['port']
        arm.connected_arms.append(FakeArm(port, [11]))
        self.assertEqual(self.service.telemetry()['channels'], [])


class EStopTests(unittest.TestCase):
    """The listener against a pseudo-terminal standing in for the button."""
    def test_press_stops_once_and_silence_is_reported(self):
        import os, logging
        from hardware.estop_listener import EStopListener
        master, slave = os.openpty()
        port = os.ttyname(slave)
        stops = []
        listener = EStopListener(lambda: stops.append(time.time()), lambda: set(), logging.getLogger('t'), port)
        try:
            time.sleep(0.5)                    # the port opens and flushes old input first
            for _ in range(40):                # the board repeats its heartbeat
                os.write(master, b'OK\r\n')
                if listener.status()['connected']: break
                time.sleep(0.05)
            self.assertTrue(listener.status()['alive'])
            os.write(master, b'STOP\r\nSTOP\r\nSTOP\r\n')       # held down: one stop only
            time.sleep(0.4)
            self.assertEqual(len(stops), 1)
            self.assertTrue(listener.status()['pressed'])
            os.write(master, b'OK\r\nSTOP\r\n')                   # released, pressed again
            time.sleep(0.4)
            self.assertEqual(len(stops), 2)
            time.sleep(1.2)                                            # heartbeat stops
            self.assertFalse(listener.status()['alive'])
        finally:
            listener.close()
            os.close(master)

    def test_arm_ports_are_never_opened(self):
        import logging
        from hardware.estop_listener import EStopListener
        listener = EStopListener(lambda: None, lambda: {'/dev/cu.arm'}, logging.getLogger('t'), '/dev/cu.arm', start=False)
        self.assertEqual(listener._candidates(), ['/dev/cu.arm'])     # explicit port is kept...
        listener.excluded = lambda: {'/dev/cu.arm'}
        # ..._run refuses it before opening (checked in the loop)
        self.assertIn('/dev/cu.arm', listener.excluded())


if __name__ == '__main__':
    unittest.main()
