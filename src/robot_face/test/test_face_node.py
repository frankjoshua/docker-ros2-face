import json
import urllib.error
import urllib.request

import pytest

from robot_face.face_node import FaceState, serve


def read_event(resp):
    line = resp.readline()
    assert line.startswith(b'data: ')
    assert resp.readline() == b'\n'
    return json.loads(line[6:])


def test_state_validates_and_keeps_last_value():
    s = FaceState()
    assert s.expression('joy')
    assert not s.expression('bogus')
    assert s.look('hologram')
    assert not s.look('bogus')
    s.gaze(2.0, -5.0)
    s.mouth(1.7)
    s.affect(-3.0, 0.5)
    assert s.values == {
        'expression': 'joy', 'look': 'hologram', 'gaze': [1.0, -1.0], 'mouth': 1.0, 'affect': [-1.0, 0.5],
    }


def test_channels_expand_sides_clamp_and_reject_bad_input():
    s = FaceState()
    assert s.channels(['mouthSmile', 'browInnerUp', 'tears'], [0.5, 2.0, -1.0])
    assert s.values['channels'] == {'mouthSmileLeft': 0.5, 'mouthSmileRight': 0.5, 'browInnerUp': 1.0, 'tears': 0.0}
    assert not s.channels(['mouthGrin'], [1.0])
    assert not s.channels(['jawOpen'], [])
    assert s.values['channels']['browInnerUp'] == 1.0   # rejected input leaves the override in place
    assert s.channels([], [])
    assert s.values['channels'] == {}                   # an empty message clears the override


def test_replay_order_is_recency_order():
    s = FaceState()
    s.expression('happy')
    s.affect(0.2, 0.3)
    s.expression('sad')     # newer than the affect, so it must replay after it
    q = s.subscribe()
    assert [q.get_nowait()[0] for _ in range(2)] == ['affect', 'expression']


def get(base, path):
    return urllib.request.urlopen(f'{base}{path}', timeout=5)


def test_http_events_and_static_files():
    state = FaceState()
    state.expression('happy')
    base = f'http://127.0.0.1:{serve(state, 0)}'

    events = get(base, '/events')
    assert events.headers['Content-Type'] == 'text/event-stream'
    assert read_event(events) == {'expression': 'happy'}   # replayed on connect
    state.gaze(0.5, 0.0)
    assert read_event(events) == {'gaze': [0.5, 0.0]}       # live

    index = get(base, '/?look=hologram')
    assert index.headers['Content-Type'].startswith('text/html')
    assert b'face/main.js' in index.read()
    assert get(base, '/face/vocabulary.json').headers['Content-Type'] == 'application/json'
    assert get(base, '/vendor/three.module.min.js').headers['Content-Type'].startswith('text/javascript')

    for path in ['/nope', '/../face_node.py', '/face/../../face_node.py', '/face/', '/.hidden']:
        with pytest.raises(urllib.error.HTTPError) as e:
            get(base, path)
        assert e.value.code == 404, path
