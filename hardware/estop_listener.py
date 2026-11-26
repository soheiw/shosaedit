"""USB STOP button: reads hardware/estop/estop.ino's lines and stops the arms.

Runs on its own thread, independent of the browser: a press stops all motion even
when ShosaEdit is not the front window. Only a port that announces itself with
"SHOSA-ESTOP 1" (or already sends OK/STOP) is accepted, and the arms' own ports are
never opened.
"""
from __future__ import annotations
import glob
import threading
import time

import serial

BAUD = 115200
LOST_AFTER_S = 1.0          # no line for this long: the button is shown as lost
CANDIDATES = ('/dev/cu.usbmodem*', '/dev/cu.wchusbserial*', '/dev/cu.SLAB_USBtoUART*')


class EStopListener:
    def __init__(self, on_stop, excluded_ports, log, port='', busy=lambda port: '', start=True):
        self.on_stop = on_stop              # called on the thread when STOP starts
        self.excluded = excluded_ports      # callable -> set of arm ports never to open
        self.log = log
        self.port = port                    # '' = find it automatically
        self.busy = busy                    # callable -> other process holding the port ('' if none)
        self.state = {'port': None, 'connected': False, 'pressed': False,
                      'lastLine': 0.0, 'lastStop': None, 'stops': 0, 'error': None}
        self._lock = threading.Lock()
        self._quit = threading.Event()
        if start:
            threading.Thread(target=self._run, daemon=True, name='shosa-estop').start()

    def status(self):
        with self._lock:
            s = dict(self.state)
        s['alive'] = s['connected'] and time.time() - s['lastLine'] <= LOST_AFTER_S
        s['configuredPort'] = self.port
        return s

    def configure(self, port):
        self.port = str(port or '').strip()
        with self._lock:
            self.state['error'] = None
        return self.status()

    def close(self):
        self._quit.set()

    def _set(self, **kw):
        with self._lock:
            self.state.update(kw)

    def _candidates(self):
        if self.port:
            return [self.port]
        found = []
        for pattern in CANDIDATES:
            found += sorted(glob.glob(pattern))
        return [p for p in found if p not in self.excluded()]

    def _run(self):
        while not self._quit.is_set():
            for port in self._candidates():
                if self._quit.is_set():
                    return
                if port in self.excluded():
                    self._set(error=f'{port} is an arm port; not opened')
                    continue
                holder = self.busy(port)
                if holder:      # e.g. TD's LED / BMI serial: never steal or reset it
                    self._set(error=f'{port} is in use by {holder}; skipped')
                    continue
                try:
                    self._listen(port)
                except (OSError, serial.SerialException) as e:
                    self._set(connected=False, error=f'{port}: {e}')
            self._set(connected=False, port=None, pressed=False)
            self._quit.wait(2.0)

    def _listen(self, port):
        with serial.Serial(port, BAUD, timeout=0.2) as link:
            deadline = time.time() + 3.0       # boards that reset on open need a moment
            accepted = False
            buffer = b''
            while not self._quit.is_set():
                chunk = link.read(64)
                if chunk:
                    buffer += chunk
                while b'\n' in buffer:
                    raw, buffer = buffer.split(b'\n', 1)
                    line = raw.strip().decode('ascii', 'replace')
                    if not accepted:
                        if line.startswith('SHOSA-ESTOP') or line in ('OK', 'STOP'):
                            accepted = True
                            self._set(port=port, connected=True, error=None, lastLine=time.time())
                            self.log.info(f'STOP button connected on {port}')
                        else:
                            continue
                    now = time.time()
                    if line == 'STOP':
                        was = self.state['pressed']
                        self._set(pressed=True, lastLine=now)
                        if not was:
                            self._set(lastStop=now, stops=self.state['stops'] + 1)
                            self.log.warning(f'STOP button pressed ({port})')
                            try:
                                self.on_stop()
                            except Exception as e:      # never let a stop error kill the listener
                                self.log.error(f'STOP button: stop failed: {e}')
                    elif line == 'OK':
                        self._set(pressed=False, lastLine=now)
                    elif line.startswith('SHOSA-ESTOP'):
                        self._set(lastLine=now)
                if not accepted and time.time() > deadline:
                    return                              # not our device: try the next port
                if accepted and time.time() - self.state['lastLine'] > 5.0:
                    self.log.error(f'STOP button on {port} silent for 5 s; reopening')
                    return
