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
    base = f'http://127.0.0.1:{serve(state, 0)}'

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
