import functools
import http.client
import json
from pathlib import Path
import sys
import tempfile
import threading
import unittest
from http.server import ThreadingHTTPServer
sys.path.insert(0,str(Path(__file__).resolve().parents[1]))
from launch import LocalPreviewHandler
from motion_sync import MotionSync
class API(unittest.TestCase):
 def test_guards(self):
  with tempfile.TemporaryDirectory() as directory:
   p=Path(directory)/'.motion-sync';p.mkdir();(p/'secret').write_text('private')
   server=ThreadingHTTPServer(('127.0.0.1',0),functools.partial(LocalPreviewHandler,directory=directory));server.motion_sync=MotionSync(cache_dir=p)
   thread=threading.Thread(target=server.serve_forever,daemon=True);thread.start()
   def request(method,path,body=None,headers=None):
    conn=http.client.HTTPConnection('127.0.0.1',server.server_port,timeout=3)
    conn.request(method,path,body,headers or {});r=conn.getresponse();result=(r.status,r.read());conn.close();return result
   try:
    code,body=request('GET','/api/sync/status');self.assertEqual(code,200);self.assertFalse(json.loads(body)['enabled'])
    self.assertEqual(request('GET','/.motion-sync/secret')[0],404)
    self.assertEqual(request('GET','/%2emotion-sync/secret')[0],404)
    self.assertEqual(request('GET','/api/sync/status',headers={'Host':'evil.example'})[0],403)
    self.assertEqual(request('POST','/api/sync/configure','{}',{'Content-Type':'application/json'})[0],403)
    h={'Origin':f'http://127.0.0.1:{server.server_port}','Content-Type':'application/json'}
    self.assertEqual(request('POST','/api/sync/configure',json.dumps({'enabled':False,'mode':'pull'}),h)[0],200)
    self.assertEqual(request('POST','/api/sync/publish',json.dumps({'name':'invalid'}),h)[0],400)
   finally:server.shutdown();server.motion_sync.close();server.server_close();thread.join()
if __name__=='__main__':unittest.main()
