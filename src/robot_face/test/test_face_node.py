import json
import urllib.error
import urllib.request

from robot_face.face_node import FaceState, serve


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


def test_http_replay_live_index_404():
    state = FaceState()
    state.expression('happy')
    base = f'http://127.0.0.1:{serve(state, 0, lambda x, y: None)}'

    events = urllib.request.urlopen(f'{base}/events', timeout=5)
    assert events.headers['Content-Type'] == 'text/event-stream'
    assert read_event(events) == {'expression': 'happy'}   # replayed on connect
    state.gaze(0.5, 0.0)
    assert read_event(events) == {'gaze': [0.5, 0.0]}       # live

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


def test_post_goal_calls_publish_and_validates():
    calls = []
    state = FaceState()
    base = f'http://127.0.0.1:{serve(state, 0, lambda x, y: calls.append((x, y)))}'

    req = urllib.request.Request(
        base + '/goal', data=json.dumps({'x': 1.5, 'y': -2.0}).encode(),
        headers={'Content-Type': 'application/json'}, method='POST')
    resp = urllib.request.urlopen(req, timeout=5)
    assert resp.status == 204
    assert calls == [(1.5, -2.0)]

    for bad_body in (b'not json', b'{"x": 1.5}', b'{"x": "nope", "y": 1}'):
        req = urllib.request.Request(base + '/goal', data=bad_body, method='POST')
        try:
            urllib.request.urlopen(req, timeout=5)
            assert False, 'expected 400'
        except urllib.error.HTTPError as e:
            assert e.code == 400
    assert calls == [(1.5, -2.0)]   # bad requests never reached publish_goal
