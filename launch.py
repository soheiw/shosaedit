#!/usr/bin/env python3
"""Run the offline motion viewer. No motor connection is made."""
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

class LocalPreviewHandler(SimpleHTTPRequestHandler):
    """Always serve current local assets rather than a stale browser copy."""
    def do_GET(self):
        if self.path == '/api/osc/status':
            self._json(200, {'ok': True, 'protocol': 'OSC/UDP', 'version': 1})
        else:
            super().do_GET()

    def _json(self, status, payload):
        data = json.dumps(payload).encode('utf-8')
        self.send_response(status)
        self.send_header('Content-Type', 'application/json')
        self.send_header('Content-Length', str(len(data)))
        self.end_headers()
        self.wfile.write(data)

    def do_POST(self):
        if self.path != '/api/osc/frame':
            self._json(404, {'error': 'Unknown endpoint'})
            return
        origin = urlparse(self.headers.get('Origin', ''))
        try:
            same_origin = origin.scheme == 'http' and origin.hostname in ('127.0.0.1', 'localhost', '::1') and origin.port == self.server.server_port
        except ValueError:
            same_origin = False
        if not same_origin or self.headers.get_content_type() != 'application/json':
            self._json(403, {'error': 'Same-origin JSON request required'})
            return
        try:
            length = int(self.headers.get('Content-Length', '0'))
            if not 0 < length <= 20000:
                raise ValueError('Invalid frame size')
            frame = json.loads(self.rfile.read(length))
            if not isinstance(frame, dict):
                raise ValueError('Expected an object')
            self._json(200, send_frame(frame))
        except (ValueError, TypeError, KeyError, OverflowError) as error:
            self._json(400, {'error': str(error)})
        except OSError as error:
            self._json(502, {'error': str(error)})

    def log_request(self, code='-', size='-'):
        if self.path.startswith('/api/osc/') and code == 200:
            return
        super().log_request(code, size)

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
    print(f'Motion Preview: {url}',flush=True)
    print('終了するには Ctrl+C。実機への通信は行いません。',flush=True)
    if not args.no_browser:webbrowser.open(url)
    try:server.serve_forever()
    except KeyboardInterrupt:pass
    finally:server.server_close()
