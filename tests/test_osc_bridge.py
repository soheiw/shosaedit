import copy
import importlib.util
import json
from pathlib import Path
import socket
import struct
import sys
import threading
import unittest
import urllib.request
import urllib.error
sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from osc_bridge import frame_packets, send_frame
from launch import LocalPreviewHandler
from http.server import ThreadingHTTPServer


def frame(port=9000):
    return {'host': '127.0.0.1', 'port': port, 'sequence': 12, 'time': 1.25, 'playing': True,
            'arms': {s: {'counts': list(range(n)), 'angles': [.2]*7, 'torque': [-.3]*7} for s,n in [('R',9),('L',8)]}}


def unpack(packet):
    assert packet[:16] == b'#bundle\0' + struct.pack('>Q', 1)
    result = {}
    offset = 16
    while offset < len(packet):
        size, = struct.unpack('>I', packet[offset:offset+4]);offset += 4
        data = packet[offset:offset+size];offset += size
        address = data.split(b'\0', 1)[0];start=(len(address)+4)//4*4
        tag = data[start:start+2];value=struct.unpack('>i' if tag == b',i' else '>f', data[start+4:start+8])[0]
        result[address.decode()] = value
    return result


class OSCBridgeTests(unittest.TestCase):
    def test_packet_channels_and_units(self):
        host,port,packets=frame_packets(frame())
        self.assertEqual((host,port),('127.0.0.1',9000))
        for side,packet in zip(('R','L'),packets):
            self.assertLessEqual(len(packet),1400)
            data=unpack(packet);self.assertEqual(data['/shosaedit/time'],1.25)
            self.assertEqual(data[f'/shosaedit/{side}/count/7'],6)
            self.assertAlmostEqual(data[f'/shosaedit/{side}/angle/1'],.2,places=6)
            self.assertAlmostEqual(data[f'/shosaedit/{side}/torque/1'],-.3,places=6)
            self.assertEqual(data[f'/shosaedit/{side}/load_valid'],1)
            self.assertEqual(data['/shosaedit/sequence'],12)
        pending=frame();pending['arms']['R']['torque']=None
        data=unpack(frame_packets(pending)[2][0]);self.assertEqual(data['/shosaedit/R/load_valid'],0);self.assertNotIn('/shosaedit/R/torque/1',data)

    def test_invalid_values(self):
        for key,value in [('host','224.0.0.1'),('host','0.0.0.0'),('host','255.255.255.255'),('host','bad'),('port',0),('port',1.5),('sequence',-1),('time',float('nan'))]:
            bad=frame();bad[key]=value
            with self.assertRaises((ValueError,TypeError)):frame_packets(bad)
        bad=frame();bad['arms']['L']['counts']=[1]
        with self.assertRaises(ValueError):frame_packets(bad)

    def test_http_to_udp_and_origin_rejection(self):
        server=ThreadingHTTPServer(('127.0.0.1',0),LocalPreviewHandler)
        threading.Thread(target=server.serve_forever,daemon=True).start()
        try:
            base=f'http://127.0.0.1:{server.server_port}'
            with socket.socket(socket.AF_INET,socket.SOCK_DGRAM) as receiver:
                receiver.bind(('127.0.0.1',0));receiver.settimeout(2)
                payload=frame(receiver.getsockname()[1])
                request=urllib.request.Request(base+'/api/osc/frame',data=json.dumps(payload).encode(),headers={'Content-Type':'application/json','Origin':base})
                with urllib.request.urlopen(request) as response:self.assertTrue(json.load(response)['ok'])
                data=[unpack(receiver.recv(2048)) for _ in range(2)]
                self.assertIn('/shosaedit/R/count/9',data[0]);self.assertIn('/shosaedit/L/count/8',data[1])
                request.add_header('Origin','https://example.invalid')
                with self.assertRaises(urllib.error.HTTPError) as error:urllib.request.urlopen(request)
                self.assertEqual(error.exception.code,403)
            with urllib.request.urlopen(base+'/api/osc/status') as response:self.assertEqual(json.load(response)['protocol'],'OSC/UDP')
        finally:
            server.shutdown();server.server_close()

if __name__=='__main__':unittest.main()
