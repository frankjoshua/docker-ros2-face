import json
import http.client
import socket
import struct
import time
from types import SimpleNamespace
import urllib.error
import urllib.request

import pytest

from robot_face import face_node
from robot_face.face_node import FaceState


def read_event(resp):
    line = resp.readline()
    assert line.startswith(b'data: ')
    assert resp.readline() == b'\n'
    return json.loads(line[6:])


def test_state_validates_and_keeps_last_value():
    s = FaceState()
    assert s.expression('happy')
    assert not s.expression('bogus')
    s.gaze(2.0, -5.0)
    s.mouth(1.7)
    assert s.values == {'expression': 'happy', 'gaze': [1.0, -1.0], 'mouth': 1.0}


def test_state_diagnostics_merges_by_name():
    # Each /diagnostics publisher reports only its own components, so the display
    # list must accumulate across messages instead of replacing wholesale.
    s = FaceState()
    s.diagnostics([{'name': 'battery', 'level': 0, 'message': 'OK', 'hardware_id': 'bms',
                     'values': [['voltage', '12.1']]}])
    s.diagnostics([{'name': 'motor_left', 'level': 2, 'message': 'overtemp',
                     'hardware_id': 'drive', 'values': []}])
    # a later update to a known name replaces its entry in place, not appends
    s.diagnostics([{'name': 'battery', 'level': 1, 'message': 'low', 'hardware_id': 'bms',
                     'values': []}])
    assert [d['name'] for d in s.values['diagnostics']] == ['battery', 'motor_left']
    assert s.values['diagnostics'][0]['message'] == 'low'


def test_http_replay_live_index_404(http_server):
    state = FaceState()
    state.expression('happy')
    base = http_server(state)

    events = urllib.request.urlopen(f'{base}/events', timeout=5)
    assert events.headers['Content-Type'] == 'text/event-stream'
    assert read_event(events) == {'expression': 'happy'}   # replayed on connect
    state.gaze(0.5, 0.0)
    assert read_event(events) == {'gaze': [0.5, 0.0]}       # live
    events.close()

    index = urllib.request.urlopen(f'{base}/', timeout=5)
    assert index.status == 200
    assert b'<svg' in index.read()

    try:
        urllib.request.urlopen(f'{base}/nope', timeout=5)
        assert False, 'expected 404'
    except urllib.error.HTTPError as e:
        assert e.code == 404


def test_state_map_dedups_identical_pushes():
    s = FaceState()
    q = s.subscribe()
    s.map(0.05, 10, 10, [0.0, 0.0], 'AAA=')
    s.map(0.05, 10, 10, [0.0, 0.0], 'AAA=')   # identical -> no second event
    s.map(0.05, 10, 10, [0.0, 0.0], 'BBB=')   # different -> pushes again
    events = []
    while not q.empty():
        events.append(q.get_nowait())
    assert [key for key, _ in events] == ['map', 'map']


def test_state_pose_passthrough():
    s = FaceState()
    s.pose(1.5, -2.0, 0.78)
    assert s.values['pose'] == [1.5, -2.0, 0.78]


def test_post_goal_calls_publish_and_validates(http_server):
    calls = []
    state = FaceState()
    base = http_server(state, lambda x, y: calls.append((x, y)))

    req = urllib.request.Request(
        base + '/goal', data=json.dumps({'x': 1.5, 'y': -2.0}).encode(),
        headers={'Content-Type': 'application/json'}, method='POST')
    resp = urllib.request.urlopen(req, timeout=5)
    assert resp.status == 204
    assert calls == [(1.5, -2.0)]
    assert state.values['goal'] == [1.5, -2.0]

    for bad_body in (b'not json', b'{"x": 1.5}', b'{"x": "nope", "y": 1}',
                     b'{"x": NaN, "y": 1}', b'{"x": Infinity, "y": 1}'):
        req = urllib.request.Request(
            base + '/goal', data=bad_body,
            headers={'Content-Type': 'application/json'}, method='POST')
        try:
            urllib.request.urlopen(req, timeout=5)
            assert False, 'expected 400'
        except urllib.error.HTTPError as e:
            assert e.code == 400

    req = urllib.request.Request(base + '/goal', data=json.dumps({'x': 1, 'y': 1}).encode(),
                                  method='POST')  # no Content-Type header
    try:
        urllib.request.urlopen(req, timeout=5)
        assert False, 'expected 400'
    except urllib.error.HTTPError as e:
        assert e.code == 400

    assert calls == [(1.5, -2.0)]   # bad requests never reached publish_goal
    assert state.values['goal'] == [1.5, -2.0]


def test_navigation_overlays_replay_and_empty_path_clears(http_server):
    state = FaceState()
    state.goal(3, 4)
    state.path([[1, 2], [3, 4]])
    with urllib.request.urlopen(http_server(state) + '/events', timeout=5) as events:
        assert read_event(events) == {'goal': [3, 4]}
        assert read_event(events) == {'path': [[1, 2], [3, 4]]}
        state.path([])
        assert read_event(events) == {'path': []}


def stamped_position(x, y, frame=''):
    return SimpleNamespace(header=SimpleNamespace(frame_id=frame),
                           pose=SimpleNamespace(position=SimpleNamespace(x=x, y=y, z=0)))


def test_navigation_points_transform_and_respect_pose_frames():
    calls = []

    def lookup(target, source):
        calls.append((target, source))
        # 90 degree rotation followed by translation.
        return SimpleNamespace(transform=SimpleNamespace(
            rotation=SimpleNamespace(x=0, y=0, z=2**-0.5, w=2**-0.5),
            translation=SimpleNamespace(x=10, y=20, z=0)))

    points = face_node.navigation_points_to_map(
        [stamped_position(1, 2), stamped_position(2, 3), stamped_position(4, 5, 'map')],
        'odom', 'map', lookup)
    assert points[0] == pytest.approx([8, 21])
    assert points[1] == pytest.approx([7, 22])
    assert points[2] == [4, 5]
    assert calls == [('map', 'odom')]


@pytest.mark.parametrize('pose', [stamped_position(1, 2),
                                  stamped_position(float('nan'), 2, 'map')])
def test_navigation_points_reject_missing_frame_or_invalid_coordinates(pose):
    with pytest.raises(ValueError):
        face_node.navigation_points_to_map([pose], '', 'map', None)


@pytest.mark.parametrize('headers, body, status', [
    ({'Content-Length': 'oops'}, b'', 400),
    ({'Content-Length': '-1'}, b'', 400),
    ({'Content-Length': '10000000'}, b'', 413),
    ({'Transfer-Encoding': 'chunked'}, b'{"x": 1, "y": 2}', 400),
    ({'Content-Type': 'application/json-invalid'}, b'{"x": 1, "y": 2}', 400),
    ({}, b'{"x": true, "y": 2}', 400),
    ({}, b'{"x": ' + b'9' * 400 + b', "y": 2}', 400),
    ({}, b'[]', 400),
    ({}, b'null', 400),
])
def test_goal_rejects_invalid_requests(http_server, headers, body, status):
    calls = []
    base = http_server(FaceState(), lambda x, y: calls.append((x, y)))
    conn = http.client.HTTPConnection(base.removeprefix('http://'), timeout=1)
    try:
        conn.request('POST', '/goal', body,
                     {'Content-Type': 'application/json', **headers})
        assert conn.getresponse().status == status
        assert calls == []
    finally:
        conn.close()


def test_goal_body_read_times_out(http_server, monkeypatch):
    monkeypatch.setattr(face_node, 'SOCKET_TIMEOUT_SECONDS', 0.05)
    calls = []
    base = http_server(FaceState(), lambda x, y: calls.append((x, y)))
    conn = http.client.HTTPConnection(base.removeprefix('http://'), timeout=1)
    try:
        conn.request('POST', '/goal', b'{',
                     {'Content-Type': 'application/json', 'Content-Length': '20'})
        assert conn.getresponse().status == 408
        assert calls == []
    finally:
        conn.close()


def test_slow_subscriber_keeps_latest_state_without_unbounded_backlog():
    state = FaceState()
    slow = state.subscribe()
    fast = state.subscribe()
    state.expression('happy')
    state.map(1, 1, 1, [0, 0], 'AA==')
    for i in range(10000):
        state.pose(i, -i, 0)
        while not fast.empty():
            fast.get_nowait()
    assert slow.qsize() < 100
    latest = {}
    while not slow.empty():
        key, value = slow.get_nowait()
        latest[key] = value
    assert latest == state.values


def test_idle_event_stream_heartbeats_and_reaps_disconnected_client(http_server, monkeypatch):
    monkeypatch.setattr(face_node, 'HEARTBEAT_SECONDS', 0.05, raising=False)
    state = FaceState()
    base = http_server(state)
    conn = http.client.HTTPConnection(base.removeprefix('http://'), timeout=1)
    conn.request('GET', '/events')
    # Keep the socket: HTTP/1.0 transfers its ownership to the response.
    sock = conn.sock
    response = conn.getresponse()
    try:
        assert response.readline().startswith(b':')
        assert response.readline() == b'\n'
        # Reset the TCP connection so the server observes an idle disconnect.
        sock.setsockopt(socket.SOL_SOCKET, socket.SO_LINGER, struct.pack('ii', 1, 0))
    finally:
        response.close()
        conn.close()
    deadline = time.monotonic() + 2
    while state.clients and time.monotonic() < deadline:
        time.sleep(0.01)
    assert not state.clients
