"""Drive the arms from ShosaEdit without TouchDesigner (launch.py --hardware).

Wraps hardware/arm_controller.py, the same controller TD runs, so playback,
stop, lock, release, recording and FIX keep TD's safety rules. Shares TD's data:
Recorded_movements/<COM name>/<name>.csv and Recorded_movements/arm_models.json
under the B2J_rehersal folder. TD and ShosaEdit must never open the same port
at once: DISCONNECT in TD (or quit TD) before CONNECT here.

Every method returns quickly: serial work runs on the controller's own threads.
"""
from __future__ import annotations
import csv
import json
import os
import re
import threading
import time
from pathlib import Path

from . import arm_controller as arm

SIDES = ('R', 'L')
SIDE_NAMES = {'R': 'right', 'L': 'left'}
COLUMNS = {'R': 9, 'L': 8}
DEFAULT_ARMS = {
    'R': {'port': '/dev/cu.usbserial-FTAK89O2', 'ids': list(range(1, 10))},
    'L': {'port': '/dev/cu.usbserial-FTAK89K4', 'ids': list(range(11, 19))},
}
NAME = re.compile(r'^[\w .-]{1,64}$')     # \w: also Japanese letters (model filenames keep them)
MAX_ROWS = 10000
LIVE_HOLD_S = 1.0          # fast reads stay on this long after a /live poll
STALE_MS = 2000

# Register 126 per model number (ROBOTIS e-manual control tables, read
# 2026-11-26): Present Current in mA per count, or None where 126 is Present
# Load (XL430-W250, 0.1 % per count), which is not a current.
CURRENT_MA_PER_COUNT = {
    1020: 2.69,   # XM430-W350
    1130: 2.69,   # XM540-W150
    1220: 1.0,    # XC330-T288
    1210: 1.0,    # XC330-T181
}
LOAD_MODELS = {1060: 'XL430-W250'}
# Names measured-load.js uses for its stall-torque / stall-current coefficients.
SPEC_NAMES = {1020: 'XM430-W350-R', 1130: 'XM540-W150-R', 1220: 'XC330-T288-T', 1210: 'XC330-T181-T'}
MODEL_NAMES = {1020: 'XM430-W350', 1130: 'XM540-W150', 1220: 'XC330-T288', 1210: 'XC330-T181', 1060: 'XL430-W250'}


def _signed32(value):
    return arm._signed32(value)


class ArmService:
    def __init__(self, data_dir, config_path):
        self.data_dir = Path(data_dir).expanduser().resolve()
        if not (self.data_dir / 'Recorded_movements').is_dir():
            raise ValueError(f'{self.data_dir} has no Recorded_movements folder')
        arm.DATA_DIR = str(self.data_dir)
        self.config_path = Path(config_path)
        self.arms = json.loads(json.dumps(DEFAULT_ARMS))
        try:
            saved = json.loads(self.config_path.read_text())
            for side in SIDES:
                if isinstance(saved.get(side), dict):
                    self.arms[side].update({k: saved[side][k] for k in ('port', 'ids') if k in saved[side]})
        except (OSError, ValueError):
            pass
        self.locked = False
        self.models = {}            # port -> {id: model number}
        self._live_until = 0.0
        self._log_seq = 0
        self._log = []              # (seq, line), last 300
        self._lock = threading.Lock()

    # ----- configuration -----
    def configure(self, body):
        side = body.get('side')
        if side not in SIDES:
            raise ValueError('side must be R or L')
        port = str(body.get('port', '')).strip()
        ids = body.get('ids')
        if not port or len(port) > 256:
            raise ValueError('port required')
        if not isinstance(ids, list) or not ids or not all(type(i) is int and 0 <= i <= 252 for i in ids):
            raise ValueError('ids must be a list of motor IDs')
        if self._port_open(self.arms[side]['port']):
            raise ValueError('disconnect this arm before changing its port or IDs')
        self.arms[side] = {'port': port, 'ids': ids}
        self.config_path.parent.mkdir(parents=True, exist_ok=True)
        tmp = self.config_path.with_suffix('.tmp')
        tmp.write_text(json.dumps(self.arms))
        tmp.replace(self.config_path)
        return self.status()

    # ----- state -----
    def _open_arm(self, port):
        for a in list(arm.connected_arms):
            if a.device_name == port and a.port_is_open:
                return a
        return None

    def _port_open(self, port):
        return self._open_arm(port) is not None

    def _arm_state(self, port):
        if self._port_open(port):
            return 'disconnecting' if arm.arm_states.get(port) == 'disconnecting' else 'connected'
        state = arm.arm_states.get(port)
        return state if state in ('connecting', 'failed') else 'offline'

    def _drain(self):
        with self._lock:
            while True:
                try:
                    line = arm._log_lines.popleft()
                except IndexError:
                    break
                self._log_seq += 1
                self._log.append((self._log_seq, line))
            del self._log[:-300]

    def status(self, since=0):
        self._drain()
        arms = {}
        for side in SIDES:
            port = self.arms[side]['port']
            a = self._open_arm(port)
            arms[side] = {
                'port': port, 'ids': self.arms[side]['ids'], 'state': self._arm_state(port),
                'playing': bool(a and a.task_running), 'recording': bool(a and a.recording),
                'motors': {str(k): v for k, v in arm.motor_statuses(port).items()},
                'models': {str(k): MODEL_NAMES.get(v, v) for k, v in self.models.get(port, {}).items()},
                'recordingFolder': arm.recording_folder(port),
            }
        with self._lock:
            log = [{'seq': s, 'line': l} for s, l in self._log if s > since]
        return {'enabled': True, 'dataDir': str(self.data_dir), 'locked': self.locked,
                'fixing': bool(arm.fix_state.get('busy')), 'arms': arms, 'log': log, 'logSeq': self._log_seq}

    # ----- connection -----
    def connect(self, side):
        cfg = self.arms[self._side(side)]
        holders = self._other_holders(cfg['port'])
        if holders:
            # macOS lets two processes open one serial port; both would then talk on the bus.
            raise ValueError(f'{cfg["port"]} is open in another app ({holders}); DISCONNECT it in TouchDesigner first')
        arm.setup_arm(cfg['port'], cfg['ids'])
        arm._submit('read model numbers ' + cfg['port'], self._read_models, cfg['port'])
        return self.status()

    def disconnect(self, side):
        arm.disconnect_arm(self.arms[self._side(side)]['port'])
        return self.status()

    @staticmethod
    def _other_holders(port):
        """Names of other processes that have this serial device open ('' if none or unknown)."""
        import subprocess
        try:
            out = subprocess.run(['lsof', '-Fpc', port], capture_output=True, text=True, timeout=3).stdout
        except (OSError, subprocess.TimeoutExpired):
            return ''
        names, pid = [], None
        for line in out.splitlines():
            if line.startswith('p'):
                pid = int(line[1:])
            elif line.startswith('c') and pid != os.getpid():
                names.append(f'{line[1:]} pid {pid}')
        return ', '.join(names)

    def _read_models(self, port):
        """Ping each motor once after connecting; the reply carries its model number."""
        a = self._open_arm(port)
        if a is None:
            return
        found = {}
        for dxl_id in a.dxl_ids:
            try:
                model, comm, err = a.bus_action(
                    lambda dxl_id=dxl_id: a.packetHandler.ping(a.portHandler, dxl_id),
                    label=f'ID {dxl_id} model', retries=1, log_failures=False)
                if comm == a.COMM_SUCCESS:
                    found[dxl_id] = int(model)
            except Exception as e:
                arm.log.warning(f'{port} ID {dxl_id}: model read failed: {e}')
        self.models[port] = found
        arm.log.info(f'{port}: models ' + ', '.join(f'{k}={MODEL_NAMES.get(v, v)}' for k, v in found.items()))

    # ----- live values -----
    def live(self):
        """Positions (signed counts) and register-126 values; keeps 30 Hz idle reads on briefly."""
        self._live_until = time.time() + LIVE_HOLD_S
        arm.set_live_view(True)
        positions = arm.live_positions()
        out = {'t': time.time()}
        for side in SIDES:
            rows = positions.get(self.arms[side]['port'])
            values = [v for _, v in rows] if rows else None
            ok = values and None not in values and len(values) == COLUMNS[side]
            out[side] = [_signed32(v) for v in values] if ok else None
        return out

    def tick(self):
        """Called about twice a second: drop fast reads once nobody polls /live."""
        if self._live_until and time.time() > self._live_until:
            self._live_until = 0.0
            arm.set_live_view(False)
        self._drain()

    def telemetry(self):
        """Measured current in the /api/telemetry/status shape (measured-load-panel.js)."""
        # The controller skips idle reads while stopped unless live view is on, so a
        # panel polling this keeps the reads (and so the current) coming, like /live.
        self._live_until = time.time() + LIVE_HOLD_S
        arm.set_live_view(True)
        now_ms = time.time() * 1000
        currents = arm.live_currents()
        channels = []
        for side in SIDES:
            port = self.arms[side]['port']
            models = self.models.get(port, {})
            a = self._open_arm(port)
            torque = dict(getattr(a, 'torque_enabled', {}) or {}) if a else {}
            for dxl_id, (raw, read_s) in sorted(currents.get(port, {}).items()):
                scale = CURRENT_MA_PER_COUNT.get(models.get(dxl_id))
                if scale is None:
                    continue    # unknown model or Present Load (XL430): not a current
                row = {'side': side, 'id': dxl_id, 'currentA': raw * scale / 1000, 'timestampMs': read_s * 1000,
                       'model': SPEC_NAMES[models[dxl_id]]}
                if a and dxl_id in a.current_positions:
                    row['positionCounts'] = _signed32(a.current_positions[dxl_id])
                if torque.get(dxl_id) in (True, False):
                    row['torqueEnabled'] = torque[dxl_id]
                channels.append(row)
        newest = max((c['timestampMs'] for c in channels), default=None)
        fresh = newest is not None and 0 <= now_ms - newest <= STALE_MS
        for c in channels:
            c['ageMs'] = now_ms - c['timestampMs']
            c['fresh'] = 0 <= c['ageMs'] <= STALE_MS
        playing = any(self._open_arm(self.arms[s]['port']) and self._open_arm(self.arms[s]['port']).task_running for s in SIDES)
        return {'version': 1, 'configured': True, 'connected': bool(channels), 'fresh': fresh,
                'timestampMs': newest, 'ageMs': now_ms - newest if newest else None, 'receivedAtMs': newest,
                'staleAfterMs': STALE_MS, 'sourcePath': 'ShosaEdit hardware (direct)', 'channels': channels,
                'error': 'not read during playback or recording' if playing and not fresh else None}

    # ----- motion -----
    def stop(self):
        arm.emergency_stop()
        return self.status()

    def lock(self, on):
        self.locked = bool(on)
        if self.locked:
            arm.lock_arms()
        return self.status()

    def release(self):
        arm.release_arm()
        self.locked = False     # a limp arm is not held
        return self.status()

    def fix(self):
        arm.fix_motors()
        return self.status()

    def play(self, name):
        name = self._name(name)
        if self.locked:
            raise ValueError('LOCK is on')
        if not any(self._port_open(self.arms[s]['port']) for s in SIDES):
            raise ValueError('no arm connected')
        missing = [SIDE_NAMES[s] for s in SIDES if self._port_open(self.arms[s]['port'])
                   and not self._csv_path(s, name).is_file()]
        if missing:
            raise ValueError(f'{name}.csv missing for the {", ".join(missing)} arm')
        arm.play_recorded_movement(filename=name)
        return self.status()

    MAX_NUDGE_DEG = 30

    def nudge(self, side, motor_id, degrees):
        """Turn one motor by a few degrees from where it is now, slowly (~2 s). Torque turns on
        for that motor only and stays on, holding the new position."""
        side = self._side(side)
        a = self._open_arm(self.arms[side]['port'])
        if a is None:
            raise ValueError('not connected')
        if a.task_running or a.recording:
            raise ValueError('stop playback or recording first')
        if motor_id not in a.dxl_ids:
            raise ValueError(f'ID {motor_id} is not on the {SIDE_NAMES[side]} arm')
        if not isinstance(degrees, (int, float)) or not 0 < abs(degrees) <= self.MAX_NUDGE_DEG:
            raise ValueError(f'degrees must be within ±{self.MAX_NUDGE_DEG}')
        now = a.current_positions.get(motor_id)
        if now is None:
            raise ValueError('position not read yet')
        start = _signed32(now)
        target = start + round(degrees * 4096 / 360)
        arm.move_motors(a.device_name, {motor_id: target}, speed=0)
        arm.log.info(f'{a.device_name} ID {motor_id}: nudge {degrees:+g} deg, {start} -> {target}')
        return {'side': side, 'id': motor_id, 'from': start, 'to': target}

    def save_motion(self, body):
        """Write an edited motion as the two CSVs that play() reads."""
        name = self._name(body.get('name'))
        rows = {s: body.get(s) for s in SIDES}
        for s in SIDES:
            r = rows[s]
            if not isinstance(r, list) or not 2 <= len(r) <= MAX_ROWS or not all(
                    isinstance(x, list) and len(x) == COLUMNS[s] and all(type(v) is int and abs(v) < (1 << 31) for v in x) for x in r):
                raise ValueError(f'{SIDE_NAMES[s]} arm needs 2-{MAX_ROWS} rows of {COLUMNS[s]} whole numbers')
        paths = {s: self._csv_path(s, name) for s in SIDES}
        if not body.get('overwrite') and any(p.exists() for p in paths.values()):
            return {'exists': True, 'name': name}
        temps = {}
        for s, p in paths.items():
            p.parent.mkdir(parents=True, exist_ok=True)
            temps[s] = p.with_name(p.name + '.tmp')
            with open(temps[s], 'w', newline='') as f:
                csv.writer(f).writerows(rows[s])
        for s, p in paths.items():
            os.replace(temps[s], p)
        self._tag(name, body.get('models'))
        return {'saved': True, 'name': name, 'paths': {s: str(p) for s, p in paths.items()}}

    def recordings(self):
        names = {}
        for s in SIDES:
            folder = self._folder(s)
            if folder.is_dir():
                for e in os.scandir(folder):
                    if e.is_file() and e.name.lower().endswith('.csv'):
                        names.setdefault(e.name[:-4], set()).add(s)
        return {'recordings': [{'name': n, 'R': 'R' in v, 'L': 'L' in v} for n, v in sorted(names.items(), key=lambda x: x[0].lower())]}

    def record(self, on, name=None):
        if on:
            name = self._name(name)
            if not any(self._port_open(self.arms[s]['port']) for s in SIDES):
                raise ValueError('no arm connected')
            if any(self._csv_path(s, name).exists() for s in SIDES if self._port_open(self.arms[s]['port'])):
                raise ValueError(f'{name} already exists; choose another name')
            arm.start_record_movement(frequency=30, filename=name)
            self._tag(name, None, only_open=True)
        else:
            arm.end_record_movement()
        return self.status()

    def calibrate(self, side):
        """Store this side's live positions as the selected model's rest pose (TD's CALIBRATE)."""
        side = self._side(side)
        port = self.arms[side]['port']
        a = self._open_arm(port)
        if a is None:
            raise ValueError('not connected')
        if a.recording or a.task_running:
            raise ValueError('stop recording or playback first')
        values = [a.current_positions.get(i) for i in a.dxl_ids]
        if None in values or len(values) != COLUMNS[side]:
            raise ValueError('motors not read yet')
        data = self._models_file()
        name = SIDE_NAMES[side]
        model = data['selected'][name]
        entry = {'rest': [_signed32(v) for v in values], 'ids': list(a.dxl_ids), 'port': port,
                 'time': time.strftime('%Y-%m-%d %H:%M:%S')}
        previous = data['calibrations'][name].get(model)
        if previous:
            entry['previous'] = {k: v for k, v in previous.items() if k != 'previous'}
        data['calibrations'][name][model] = entry
        self._save_models_file(data)
        return {'saved': True, 'side': side, 'model': model, 'rest': entry['rest'], 'time': entry['time']}

    def calibration(self):
        """Rest pose of the arm model selected on each side now (arm_models.json)."""
        data = self._models_file()
        out = {}
        for s in SIDES:
            name = SIDE_NAMES[s]
            model = data['selected'][name]
            entry = data['calibrations'][name].get(model)
            out[s] = {'model': model, 'rest': entry['rest'], 'time': entry['time']} if entry else {'model': model, 'rest': None}
        return out

    # ----- arm_models.json (same file and rules as TD's arm_models DAT) -----
    def _models_path(self):
        return self.data_dir / 'Recorded_movements' / 'arm_models.json'

    def _models_file(self):
        path = self._models_path()
        data = {}
        if path.exists():
            data = json.loads(path.read_text(encoding='utf-8'))   # a bad file raises; never overwritten
            if not isinstance(data, dict):
                raise ValueError('arm_models.json top level is not an object')
        data.setdefault('version', 1)
        data['models'] = [m for m in data.get('models') or [] if isinstance(m, str)] or ['Model A', 'Model B']
        data.setdefault('selected', {})
        for name in SIDE_NAMES.values():
            if data['selected'].get(name) not in data['models']:
                data['selected'][name] = data['models'][0]
        for key in ('calibrations', 'gestures'):
            data.setdefault(key, {})
            for name in SIDE_NAMES.values():
                data[key].setdefault(name, {})
        data.setdefault('recordings', {})
        return data

    def _save_models_file(self, data):
        path = self._models_path()
        tmp = path.with_name(path.name + '.tmp')
        with open(tmp, 'w', encoding='utf-8') as f:
            json.dump(data, f, indent=1)
        os.replace(tmp, path)

    def _tag(self, name, models, only_open=False):
        data = self._models_file()
        for s in SIDES:
            port = self.arms[s]['port']
            if only_open and not self._port_open(port):
                continue
            model = (models or {}).get(s) or data['selected'][SIDE_NAMES[s]]
            data['recordings'][f'{port}/{name}.csv'] = {'side': SIDE_NAMES[s], 'model': model,
                                                        'time': time.strftime('%Y-%m-%d %H:%M:%S')}
        self._save_models_file(data)

    # ----- helpers -----
    def _side(self, side):
        if side not in SIDES:
            raise ValueError('side must be R or L')
        return side

    def _name(self, name):
        name = str(name or '').strip()
        if not NAME.match(name) or name.startswith('.'):
            raise ValueError('名前は1〜64文字の文字・数字・空白・_ - . で指定してください')
        return name

    def _folder(self, side):
        return self.data_dir / 'Recorded_movements' / arm.recording_folder(self.arms[side]['port'])

    def _csv_path(self, side, name):
        return self._folder(side) / f'{name}.csv'

    def close(self):
        """Stop motion and close the ports when the server exits; torque is left as it is (TD's DISCONNECT)."""
        try:
            for a in list(arm.connected_arms):
                a.set_is_stop(True)
                a.close_port()
        except Exception:
            pass
