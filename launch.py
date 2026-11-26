#!/usr/bin/env python3
"""Run the motion viewer. No motor connection is made unless started with --hardware
(then hardware/arm_service.py drives the arms directly, without TouchDesigner)."""
from http.server import ThreadingHTTPServer, SimpleHTTPRequestHandler
from functools import partial
from pathlib import Path
import webbrowser
import argparse
import urllib.request
import errno
import json
from urllib.parse import urlparse
from osc_bridge import send_frame
from motion_sync import MotionSync
from telemetry import TelemetryStore

class LocalPreviewHandler(SimpleHTTPRequestHandler):
    """Always serve current local assets rather than a stale browser copy."""
    def do_GET(self):
        if urlparse(self.path).path.startswith('/api/arm/'):
            if not self._local_host():
                self._json(403, {'error': 'Local host required'})
                return
            self._arm_get(urlparse(self.path))
        elif urlparse(self.path).path == '/api/telemetry/status':
            if not self._local_host():
                self._json(403, {'error': 'Local host required'})
                return
            telemetry = self.server.telemetry.status()
            # With --hardware and no file source set, show the arms' own readings.
            if getattr(self.server, 'arms', None) and not telemetry['configured']:
                telemetry = getattr(self.server, 'arms', None).telemetry()
            self._json(200, telemetry)
        elif self.path.startswith('/api/sync/'):
            if not self._local_host():
                self._json(403, {'error': 'Local host required'})
                return
            path = urlparse(self.path).path
            sync = self.server.motion_sync
            try:
                if path == '/api/sync/status': self._json(200, sync.get_status())
                elif path == '/api/sync/motions': self._json(200, sync.list_motions())
                elif path.startswith('/api/sync/motion/'):
                    from urllib.parse import unquote
                    self._json(200, sync.read_motion(unquote(path[len('/api/sync/motion/'):])) )
                else: self._json(404, {'error': 'Unknown endpoint'})
            except KeyError:
                self._json(404, {'error': 'Motion not found'})
        elif self.path == '/api/osc/status':
            self._json(200, {'ok': True, 'protocol': 'OSC/UDP', 'version': 1})
        else:
            super().do_GET()

    def _arm_get(self, url):
        from urllib.parse import parse_qs
        arms = getattr(self.server, 'arms', None)
        if arms is None:
            self._json(200 if url.path == '/api/arm/status' else 404,
                       {'enabled': False, 'error': 'Start with python launch.py --hardware to control the arms'})
            return
        try:
            if url.path == '/api/arm/status':
                since = int((parse_qs(url.query).get('since') or ['0'])[0])
                self._json(200, arms.status(since))
            elif url.path == '/api/arm/live': self._json(200, arms.live())
            elif url.path == '/api/arm/recordings': self._json(200, arms.recordings())
            elif url.path == '/api/arm/calibration': self._json(200, arms.calibration())
            else: self._json(404, {'error': 'Unknown endpoint'})
        except (ValueError, OSError) as error:
            self._json(400, {'error': str(error)})

    def _arm_post(self, path, body):
        arms = getattr(self.server, 'arms', None)
        if arms is None:
            raise ValueError('Start with python launch.py --hardware to control the arms')
        action = path[len('/api/arm/'):]
        if action == 'connect': return arms.connect(body.get('side'))
        if action == 'disconnect': return arms.disconnect(body.get('side'))
        if action == 'configure': return arms.configure(body)
        if action == 'stop': return arms.stop()
        if action == 'lock': return arms.lock(body.get('on', True))
        if action == 'release': return arms.release()
        if action == 'fix': return arms.fix()
        if action == 'play': return arms.play(body.get('name'))
        if action == 'save-motion': return arms.save_motion(body)
        if action == 'record': return arms.record(bool(body.get('on')), body.get('name'))
        if action == 'calibrate': return arms.calibrate(body.get('side'))
        if action == 'estop': return arms.configure_estop(body.get('port'))
        if action == 'nudge': return arms.nudge(body.get('side'), body.get('id'), body.get('degrees'))
        raise KeyError(action)

    def _json(self, status, payload):
        data = json.dumps(payload).encode('utf-8')
        self.send_response(status)
        self.send_header('Content-Type', 'application/json')
        self.send_header('Content-Length', str(len(data)))
        self.end_headers()
        self.wfile.write(data)

    def do_POST(self):
        sync_request = self.path in ('/api/sync/configure', '/api/sync/scan', '/api/sync/publish', '/api/sync/retry')
        telemetry_request = self.path == '/api/telemetry/configure'
        arm_request = self.path.startswith('/api/arm/')
        if self.path != '/api/osc/frame' and not sync_request and not telemetry_request and not arm_request:
            self._json(404, {'error': 'Unknown endpoint'})
            return
        origin = urlparse(self.headers.get('Origin', ''))
        try:
            same_origin = origin.scheme == 'http' and origin.hostname in ('127.0.0.1', 'localhost', '::1') and origin.port == self.server.server_port
        except ValueError:
            same_origin = False
        if not same_origin or not self._local_host() or self.headers.get_content_type() != 'application/json':
            self._json(403, {'error': 'Same-origin JSON request required'})
            return
        try:
            length = int(self.headers.get('Content-Length', '0'))
            if not 0 < length <= (5 * 1024 * 1024 if sync_request or arm_request else 20000):
                raise ValueError('Invalid frame size')
            frame = json.loads(self.rfile.read(length))
            if not isinstance(frame, dict):
                raise ValueError('Expected an object')
            if arm_request:
                try:
                    self._json(200, self._arm_post(self.path, frame))
                except KeyError:
                    self._json(404, {'error': 'Unknown endpoint'})
                return
            if telemetry_request:
                self._json(200, self.server.telemetry.configure(frame))
            elif sync_request:
                sync = self.server.motion_sync
                if self.path.endswith('/configure'): result = sync.configure(frame)
                elif self.path.endswith('/scan'): result = sync.scan_now()
                elif self.path.endswith('/retry'): result = sync.retry_publish(frame['jobId'])
                else: result = sync.publish(frame)
                self._json(200, result)
            else:
                self._json(200, send_frame(frame))
        except (ValueError, TypeError, KeyError, OverflowError) as error:
            self._json(400, {'error': str(error)})
        except OSError as error:
            self._json(502, {'error': str(error)})

    def log_request(self, code='-', size='-'):
        if self.path.startswith(('/api/osc/', '/api/sync/', '/api/telemetry/', '/api/arm/')) and code == 200:
            return
        super().log_request(code, size)

    def _local_host(self):
        try:
            host = urlparse('http://' + self.headers.get('Host', ''))
            return host.hostname in ('localhost', '127.0.0.1', '::1') and host.port == self.server.server_port
        except ValueError:
            return False

    def translate_path(self, path):
        # Local transfer cache and outbox are accessible only through the API.
        from urllib.parse import unquote
        if any(part == '.motion-sync' for part in unquote(urlparse(path).path).split('/')):
            return str(Path(self.directory) / '__private_sync_cache_not_served__')
        return super().translate_path(path)

    def send_head(self):
        if 'If-Modified-Since' in self.headers:
            del self.headers['If-Modified-Since']
        return super().send_head()

    def end_headers(self):
        self.send_header('Cache-Control', 'no-store')
        super().end_headers()

if __name__ == '__main__':
    parser=argparse.ArgumentParser()
    parser.add_argument('--no-browser',action='store_true')
    parser.add_argument('--port',type=int,default=8765)
    parser.add_argument('--hardware',action='store_true',help='drive the arms directly (needs .venv with dynamixel-sdk and pyserial)')
    parser.add_argument('--data-dir',default=str(Path.home()/'Library/CloudStorage/Dropbox-EmbodiedMedia/Wakisaka Sohei/B2J_rehersal'),
                        help='folder holding Recorded_movements (B2J_rehersal)')
    args=parser.parse_args()
    directory=Path(__file__).resolve().parent
    handler=partial(LocalPreviewHandler,directory=str(directory))
    try:
        server=ThreadingHTTPServer(('127.0.0.1',args.port),handler)
    except OSError as exc:
        if exc.errno != errno.EADDRINUSE: raise
        url=f'http://127.0.0.1:{args.port}/'
        try:
            existing=urllib.request.urlopen(url,timeout=2).read(4000).decode('utf-8')
        except Exception:
            existing=''
        if 'ShosaEdit · Motion Preview' in existing and not args.no_browser:
            webbrowser.open(url)
            print('既に起動しているプレビューを開きました。')
            raise SystemExit(0)
        server=ThreadingHTTPServer(('127.0.0.1',0),handler)
    url=f'http://127.0.0.1:{server.server_port}/'
    server.motion_sync = MotionSync()
    server.telemetry = TelemetryStore()
    server.arms = None
    if args.hardware:
        from hardware.arm_service import ArmService
        server.arms = ArmService(args.data_dir, directory / '.motion-sync' / 'hardware-config.json')
        import threading
        def _arm_tick():
            import time
            while True:
                time.sleep(0.5)
                server.arms.tick()
        threading.Thread(target=_arm_tick, daemon=True, name='shosa-arm-tick').start()
    print(f'Motion Preview: {url}',flush=True)
    if server.arms:
        print(f'実機制御: ON（{server.arms.data_dir}）。TDと同じポートを同時に開かないでください。終了するには Ctrl+C。',flush=True)
    else:
        print('終了するには Ctrl+C。実機への通信は行いません。',flush=True)
    if not args.no_browser:webbrowser.open(url)
    try:server.serve_forever()
    except KeyboardInterrupt:pass
    finally:
        if server.arms: server.arms.close()
        server.motion_sync.close()
        server.telemetry.close()
        server.server_close()
