"""Publish existing monitor-cache values for ShosaEdit; NO serial access.

Call from the existing monitor owner after it finishes a read, or from code
that reads its cache. Never stamp a cached value with the current time: pass
the original capture timestamp (Unix epoch milliseconds) for each motor.

Example:
    publish_snapshot('D:/B2J_rehersal/telemetry/current.json', [
        cached_channel('R', 1, capture_ms, current_raw=raw_current,
                       current_unit_ma=2.69, voltage_v=voltage,
                       temperature_c=temperature)
    ])

The caller must supply a model-verified current unit. Present Load, Goal
Current, and PWM are not interchangeable with measured Present Current.
"""
import json
import math
import os
from pathlib import Path
import tempfile


def _finite(value):
    return type(value) in (int, float) and math.isfinite(value)


def cached_channel(side, motor_id, captured_at_ms, *, current_a=None,
                   current_raw=None, current_unit_ma=None,
                   temperature_c=None, voltage_v=None, torque_enabled=None):
    ids = range(1, 10) if side == 'R' else range(11, 19) if side == 'L' else ()
    if type(motor_id) is not int or motor_id not in ids:
        raise ValueError('Invalid side/motor ID')
    if not _finite(captured_at_ms) or captured_at_ms <= 0:
        raise ValueError('Original capture timestamp in epoch milliseconds is required')
    if current_a is not None and current_raw is not None:
        raise ValueError('Choose measured current in amperes OR raw Present Current')
    if current_raw is not None:
        if type(current_raw) is not int or not -32768 <= current_raw <= 65535:
            raise ValueError('Present Current must be signed int16 or unsigned register word')
        if not _finite(current_unit_ma) or current_unit_ma <= 0:
            raise ValueError('A verified model-specific mA/count scale is required')
        signed = current_raw - 65536 if current_raw > 32767 else current_raw
        current_a = signed * current_unit_ma / 1000
    if not _finite(current_a):
        raise ValueError('Measured Present Current is required; no value may be inferred')
    row = {'side': side, 'id': motor_id, 'timestampMs': captured_at_ms, 'currentA': current_a}
    for name, value in [('temperatureC', temperature_c), ('voltageV', voltage_v)]:
        if value is not None:
            if not _finite(value):
                raise ValueError(f'Invalid {name}')
            row[name] = value
    if torque_enabled is not None:
        if type(torque_enabled) is not bool:
            raise ValueError('torque_enabled must be boolean')
        row['torqueEnabled'] = torque_enabled
    return row


def publish_snapshot(path, channels):
    """Atomic write; use the helper above to normalize each existing cache row."""
    if not channels:
        raise ValueError('No measured channels to publish')
    keys = [(row['side'], row['id']) for row in channels]
    if len(set(keys)) != len(keys):
        raise ValueError('Duplicate motor channel')
    payload = {'version': 1, 'timestampMs': max(row['timestampMs'] for row in channels), 'channels': channels}
    encoded = json.dumps(payload, allow_nan=False)
    target = Path(path)
    target.parent.mkdir(parents=True, exist_ok=True)
    fd, temporary = tempfile.mkstemp(dir=target.parent, prefix=target.name + '.', suffix='.tmp')
    try:
        with os.fdopen(fd, 'w', encoding='utf-8') as stream:
            stream.write(encoded)
        os.replace(temporary, target)
    finally:
        if os.path.exists(temporary):
            os.unlink(temporary)
