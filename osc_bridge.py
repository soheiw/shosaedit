"""Small OSC/UDP relay for the local preview server; standard library only."""
import ipaddress
import math
import socket
import struct


def osc_message(address, value, integer=False):
    def padded(text):
        data = text.encode('utf-8') + b'\0'
        return data + b'\0' * (-len(data) % 4)
    return padded(address) + padded(',i' if integer else ',f') + struct.pack('>i' if integer else '>f', value)


def frame_packets(frame):
    def number(value):
        if isinstance(value, bool) or not isinstance(value, (int, float)) or not math.isfinite(value) or abs(value) > 1e30:
            raise ValueError('Expected finite numeric values')
        return value
    def array(values, count, integer=False):
        if not isinstance(values, list) or len(values) != count:
            raise ValueError(f'Expected {count} channels')
        for value in values:
            number(value)
            if integer and (not isinstance(value, int) or not -2147483648 <= value <= 2147483647):
                raise ValueError('Expected int32 motor counts')
        return values
    host = frame.get('host')
    if host == 'localhost':
        host = '127.0.0.1'
    try:
        address = ipaddress.ip_address(host)
    except ValueError:
        raise ValueError('Enter a destination IP address') from None
    if address.is_multicast or address.is_unspecified or str(address) == '255.255.255.255':
        raise ValueError('Enter a unicast destination IP address')
    port = frame.get('port')
    if type(port) is not int or not 1 <= port <= 65535:
        raise ValueError('Port must be 1-65535')
    sequence = frame.get('sequence')
    if type(sequence) is not int or not 0 <= sequence <= 2147483647:
        raise ValueError('Invalid sequence number')
    seconds = number(frame.get('time'))
    if seconds < 0 or type(frame.get('playing')) is not bool:
        raise ValueError('Invalid playback state')
    arms = frame.get('arms')
    if not isinstance(arms, dict):
        raise ValueError('Both arms required')
    packets = []
    # Validate both sides before any packet is sent. Split by arm to stay below typical MTU.
    for side, count in [('R', 9), ('L', 8)]:
        arm = arms.get(side, {})
        counts = array(arm.get('counts'), count, True)
        angles = array(arm.get('angles'), 7)
        torque = arm.get('torque')
        if torque is not None:
            array(torque, 7)
        messages = [osc_message('/shosaedit/time', seconds), osc_message('/shosaedit/playing', int(frame['playing']), True), osc_message('/shosaedit/sequence', sequence, True), osc_message(f'/shosaedit/{side}/load_valid', int(torque is not None), True)]
        for name, values, integer in [('count', counts, True), ('angle', angles, False), ('torque', torque or [], False)]:
            messages.extend(osc_message(f'/shosaedit/{side}/{name}/{j+1}', value, integer) for j, value in enumerate(values))
        packet = b'#bundle\0' + struct.pack('>Q', 1) + b''.join(struct.pack('>I', len(m)) + m for m in messages)
        if len(packet) > 1400:
            raise ValueError('OSC packet too large')
        packets.append(packet)
    return str(address), port, packets


def send_frame(frame):
    host, port, packets = frame_packets(frame)
    family = socket.AF_INET6 if ':' in host else socket.AF_INET
    with socket.socket(family, socket.SOCK_DGRAM) as connection:
        for packet in packets:
            connection.sendto(packet, (host, port))
    return {'ok': True, 'packets': len(packets), 'sequence': frame['sequence']}
