#!/usr/bin/env python3
"""Run the offline motion viewer. No motor connection is made."""
from http.server import ThreadingHTTPServer, SimpleHTTPRequestHandler
from functools import partial
from pathlib import Path
import webbrowser
import argparse
import urllib.request
import errno

class LocalPreviewHandler(SimpleHTTPRequestHandler):
    """Always serve current local assets rather than a stale browser copy."""
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
