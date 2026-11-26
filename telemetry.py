"""Read-only current telemetry bridge. Never opens a motor serial port.

A producer writes an atomic JSON snapshot. Source timestamps, not filesystem
mtime or HTTP receipt time, determine freshness. Slow SMB reads run off-thread
in a bounded subprocess so they cannot stall the editor.
"""
from __future__ import annotations
import json
import math
from pathlib import Path
import subprocess
import sys
import threading
import time

MAX_BYTES = 128 * 1024
STALE_MS = 2000


def number(value):
    return type(value) in (int, float) and math.isfinite(value)


def normalize_snapshot(payload):
    if not isinstance(payload, dict) or not number(payload.get('timestampMs')) or payload['timestampMs'] <= 0:
        raise ValueError('timestampMs must be the source capture time in epoch milliseconds')
    rows = payload.get('channels')
    if not isinstance(rows, list) or len(rows) > 17:
        raise ValueError('channels must contain at most 17 motors')
    channels, seen = [], set()
    for row in rows:
        if not isinstance(row, dict):
            raise ValueError('Invalid channel')
        side, motor_id = row.get('side'), row.get('id')
        allowed = range(1, 10) if side == 'R' else range(11, 19) if side == 'L' else ()
        if type(motor_id) is not int or motor_id not in allowed or (side, motor_id) in seen:
            raise ValueError('Invalid or duplicate side/motor ID')
        seen.add((side, motor_id))
        if not number(row.get('currentA')):
            raise ValueError('Every channel requires measured currentA in amperes; raw/load values are not accepted')
        timestamp = row.get('timestampMs', payload['timestampMs'])
        if not number(timestamp) or timestamp <= 0:
            raise ValueError('Invalid channel source timestampMs')
        result = {'side': side, 'id': motor_id, 'currentA': row['currentA'], 'timestampMs': timestamp}
        if 'valid' in row:
            if type(row['valid']) is not bool:
                raise ValueError('valid must be boolean')
            result['valid'] = row['valid']
        for key in ('voltageV', 'temperatureC', 'positionCounts'):
            if key in row and row[key] is not None:
                if not number(row[key]):
                    raise ValueError(f'Invalid {key}')
                result[key] = row[key]
        if 'torqueEnabled' in row:
            if type(row['torqueEnabled']) is not bool:
                raise ValueError('torqueEnabled must be boolean')
            result['torqueEnabled'] = row['torqueEnabled']
        channels.append(result)
    return {'version': 1, 'timestampMs': payload['timestampMs'], 'channels': channels}


def read_snapshot(path):
    with open(path, 'rb') as stream:
        raw = stream.read(MAX_BYTES + 1)
    if len(raw) > MAX_BYTES:
        raise ValueError('Telemetry snapshot exceeds 128 KiB')
    return normalize_snapshot(json.loads(raw))


class TelemetryStore:
    def __init__(self, config_path=None, start=True):
        self.config_path = Path(config_path or Path(__file__).parent / '.motion-sync' / 'telemetry-config.json')
        self._lock = threading.Lock()
        self._stop = threading.Event()
        self._path = ''
        self._sample = None
        self._error = None
        self._received_at = None
        try:
            config = json.loads(self.config_path.read_text())
            self._path = config.get('path', '')
        except (OSError, ValueError):
            pass
        if start:
            self._thread = threading.Thread(target=self._loop, daemon=True, name='shosa-telemetry-file-reader')
            self._thread.start()

    def configure(self, config):
        path = config.get('path')
        if not isinstance(path, str) or len(path) > 4096 or '\x00' in path:
            raise ValueError('path must be a file path string, or empty to disconnect')
        path = path.strip()
        if path and not Path(path).expanduser().is_absolute():
            raise ValueError('Use an absolute telemetry JSON file path')
        path = str(Path(path).expanduser()) if path else ''
        self.config_path.parent.mkdir(parents=True, exist_ok=True)
        tmp = self.config_path.with_suffix('.tmp')
        tmp.write_text(json.dumps({'path': path}))
        tmp.replace(self.config_path)
        with self._lock:
            self._path, self._sample, self._error, self._received_at = path, None, None, None
        return self.status()

    def _loop(self):
        while not self._stop.is_set():
            with self._lock:
                path = self._path
            if path:
                sample, error = None, None
                try:
                    process = subprocess.run([sys.executable, str(Path(__file__).resolve()), '--read', path], capture_output=True, text=True, timeout=2)
                    if process.returncode:
                        raise ValueError(process.stderr.strip()[-500:] or 'Cannot read telemetry file')
                    sample = normalize_snapshot(json.loads(process.stdout))
                except (OSError, ValueError, subprocess.TimeoutExpired) as exc:
                    error = str(exc)
                with self._lock:
                    if path == self._path:
                        self._sample, self._error = sample, error
                        self._received_at = time.time() * 1000 if sample else None
            self._stop.wait(.5)

    def status(self, now_ms=None):
        now_ms = time.time() * 1000 if now_ms is None else now_ms
        with self._lock:
            sample, path, error, received = self._sample, self._path, self._error, self._received_at
        age = now_ms - sample['timestampMs'] if sample else None
        # Negative age is a clock mismatch, never considered fresh.
        fresh = age is not None and 0 <= age <= STALE_MS
        channels = []
        for row in sample['channels'] if sample else []:
            channel_age = now_ms - row['timestampMs']
            channels.append({**row, 'ageMs': channel_age, 'fresh': fresh and row.get('valid', True) and 0 <= channel_age <= STALE_MS})
        return {'version': 1, 'configured': bool(path), 'connected': bool(sample), 'fresh': fresh,
                'timestampMs': sample['timestampMs'] if sample else None, 'ageMs': age,
                'receivedAtMs': received, 'staleAfterMs': STALE_MS, 'sourcePath': path,
                'channels': channels, 'error': error}

    def close(self):
        self._stop.set()


if __name__ == '__main__':
    try:
        if len(sys.argv) != 3 or sys.argv[1] != '--read':
            raise ValueError('Usage: telemetry.py --read PATH')
        print(json.dumps(read_snapshot(sys.argv[2])))
    except Exception as exc:
        print(str(exc), file=sys.stderr)
        sys.exit(1)
