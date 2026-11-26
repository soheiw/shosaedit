import functools
import http.client
import threading
from http.server import ThreadingHTTPServer
import importlib.util
import json
from pathlib import Path
import sys
import tempfile
import time
import unittest

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))
from telemetry import TelemetryStore, normalize_snapshot, read_snapshot
spec = importlib.util.spec_from_file_location('export_current', ROOT / 'integrations/export_current_snapshot.py')
exporter = importlib.util.module_from_spec(spec)
spec.loader.exec_module(exporter)

class TelemetryTests(unittest.TestCase):
    def test_units_and_signed_current(self):
        row = exporter.cached_channel('R', 1, 10000, current_raw=65535, current_unit_ma=2.69)
        self.assertAlmostEqual(row['currentA'], -.00269)
        with self.assertRaises(ValueError):
            exporter.cached_channel('R', 1, 10000, current_raw=1)
        with self.assertRaises(ValueError):
            normalize_snapshot({'timestampMs': 10000, 'channels': [{'side':'R','id':1,'load':42}]})

    def test_disconnected_stale_and_per_channel_time(self):
        with tempfile.TemporaryDirectory() as tmp:
            store = TelemetryStore(Path(tmp) / 'config.json', start=False)
            self.assertFalse(store.status()['connected'])
            store._sample = normalize_snapshot({'timestampMs':10000,'channels':[
                {'side':'R','id':1,'currentA':1},
                {'side':'L','id':11,'currentA':0,'timestampMs':5000},
                {'side':'R','id':2,'currentA':5,'valid':False}]})
            fresh = store.status(now_ms=11000)
            self.assertTrue(fresh['fresh'])
            self.assertTrue(fresh['channels'][0]['fresh'])
            self.assertFalse(fresh['channels'][1]['fresh'])
            self.assertFalse(fresh['channels'][2]['fresh'])
            self.assertIs(fresh['channels'][2]['valid'], False)
            self.assertFalse(store.status(now_ms=13000)['fresh'])
            self.assertFalse(store.status(now_ms=9000)['fresh'])
            self.assertEqual(store.status(now_ms=13000)['timestampMs'], 10000)

    def test_round_trip_and_background_reader(self):
        with tempfile.TemporaryDirectory() as tmp:
            path = Path(tmp) / 'current.json'
            now = time.time() * 1000
            exporter.publish_snapshot(path, [exporter.cached_channel('L', 15, now, current_a=-.4)])
            self.assertEqual(read_snapshot(path)['channels'][0]['currentA'], -.4)
            store = TelemetryStore(Path(tmp) / 'config.json')
            try:
                store.configure({'path':str(path)})
                deadline = time.monotonic() + 3
                while time.monotonic() < deadline and not store.status()['connected']:
                    time.sleep(.05)
                self.assertTrue(store.status()['connected'])
                self.assertEqual(store.status()['timestampMs'], now)
                store.configure({'path':''})
                self.assertFalse(store.status()['connected'])
                self.assertEqual(store.status()['channels'], [])
            finally:
                store.close()

    def test_http_read_and_configuration_guards(self):
        from launch import LocalPreviewHandler
        with tempfile.TemporaryDirectory() as tmp:
            server = ThreadingHTTPServer(('127.0.0.1', 0), functools.partial(LocalPreviewHandler, directory=tmp))
            server.telemetry = TelemetryStore(Path(tmp) / 'config.json', start=False)
            thread = threading.Thread(target=server.serve_forever, daemon=True)
            thread.start()
            def request(method, path, payload=None, headers=None):
                client = http.client.HTTPConnection('127.0.0.1', server.server_port, timeout=2)
                client.request(method, path, payload, headers or {})
                response = client.getresponse()
                result = response.status, json.loads(response.read())
                client.close()
                return result
            try:
                status, body = request('GET', '/api/telemetry/status')
                self.assertEqual(status, 200)
                self.assertFalse(body['connected'])
                self.assertEqual(request('GET', '/api/telemetry/status', headers={'Host':'bad.example'})[0], 403)
                self.assertEqual(request('POST', '/api/telemetry/configure', '{}', {'Content-Type':'application/json'})[0], 403)
                headers = {'Origin': f'http://127.0.0.1:{server.server_port}', 'Content-Type':'application/json'}
                status, body = request('POST', '/api/telemetry/configure', json.dumps({'path':str(Path(tmp)/'current.json')}), headers)
                self.assertEqual(status, 200)
                self.assertTrue(body['configured'])
                self.assertEqual(request('POST', '/api/telemetry/configure', json.dumps({'path':'relative.json'}), headers)[0], 400)
            finally:
                server.shutdown()
                server.server_close()
                server.telemetry.close()
                thread.join()

    def test_invalid_identity_and_nonfinite(self):
        for row in [{'side':'L','id':5,'currentA':1}, {'side':'R','id':1,'currentA':float('nan')}]:
            with self.assertRaises(ValueError):
                normalize_snapshot({'timestampMs':10000,'channels':[row]})
        row = {'side':'R','id':1,'currentA':1}
        with self.assertRaises(ValueError):
            normalize_snapshot({'timestampMs':10000,'channels':[row,row]})

if __name__ == '__main__':
    unittest.main()
