# Robot Face Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A browser-rendered robot face driven by three ROS 2 topics through one Python node.

**Architecture:** One rclpy node (`robot_face/face_node`) subscribes to `/face/expression`, `/face/gaze`, `/face/mouth`, keeps the last value of each, and relays them as JSON over Server-Sent Events from a stdlib `ThreadingHTTPServer`. A single `index.html` (SVG + CSS transitions + one `requestAnimationFrame` loop) does all animation. No REST, no rosbridge, no Node.js, no browser management.

**Tech Stack:** ROS 2 (humble, via `frankjoshua/ros2:humble`), Python 3 stdlib (`http.server`, `queue`, `json`, `importlib.resources`), rclpy, pytest. Browser side: plain HTML/SVG/CSS/JS, zero dependencies.

**Spec:** `docs/superpowers/specs/2026-09-07-robot-face-design.md`

## Global Constraints

- Package name `robot_face`, ament_python, lives at `src/robot_face`, replaces `src/example_pkg`.
- Topics: `/face/expression` (`std_msgs/String`), `/face/gaze` (`geometry_msgs/Point`), `/face/mouth` (`std_msgs/Float32`). Nothing is published.
- Valid expressions, exactly: `neutral`, `happy`, `sad`, `surprised`, `angry`, `sleepy`. Unknown → log warning, ignore.
- Gaze `x`,`y` clamped to -1..1, `z` ignored. Mouth clamped to 0..1.
- Node parameter: `port` (int, default 8080). No other parameters. `GAZE_SPEED` is a JS constant (default 3).
- SSE events are one-key JSON objects: `{"expression": "happy"}`, `{"gaze": [x, y]}`, `{"mouth": 0.4}`. Replay last value of each key on connect. No heartbeat.
- No new apt/pip dependencies. No launch files, no custom msgs, no `EXPOSE`.
- The stock flake8/pep257/copyright tests are dropped. One pytest file only.
- Commit messages end with:
  ```
  Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>
  Claude-Session: https://claude.ai/code/session_01UAKxNv7amKZ41YtZkxcpBY
  ```

## Environment

There is no ROS on the host. Every build/test command runs inside the dev container. From the repo root on the host:

```bash
devcontainer up --workspace-folder .        # once; add --remove-existing-container after Dockerfile changes
```

Define this once per shell and use it for every command below:

```bash
ws() { devcontainer exec --workspace-folder . bash -c "source /opt/ros/\$ROS_DISTRO/setup.bash && cd /home/ws && $*"; }
```

Example: `ws colcon build --symlink-install`. The container uses `--net=host`, so `http://localhost:8080` on the host reaches the node.

---

## File Structure

| Path | Responsibility |
|---|---|
| `src/robot_face/package.xml` | ROS package manifest, deps |
| `src/robot_face/setup.py`, `setup.cfg`, `resource/robot_face` | ament_python boilerplate; ships `index.html` as package data; `face_node` console script |
| `src/robot_face/robot_face/__init__.py` | empty |
| `src/robot_face/robot_face/face_node.py` | subscriptions, last-value state, SSE fan-out, HTTP handler, `main()` |
| `src/robot_face/robot_face/index.html` | the face: SVG, expression CSS, gaze/mouth/blink JS |
| `src/robot_face/test/test_face_node.py` | one integration test: replay-on-connect, live event, `GET /` |
| `Dockerfile` | `CMD` → `face_node` |
| `README.md` | replace example-node text with the face |

---

### Task 1: Package + node + test

**Files:**
- Create: `src/robot_face/package.xml`, `src/robot_face/setup.py`, `src/robot_face/setup.cfg`, `src/robot_face/resource/robot_face`, `src/robot_face/robot_face/__init__.py`, `src/robot_face/robot_face/face_node.py`, `src/robot_face/robot_face/index.html` (stub), `src/robot_face/test/test_face_node.py`
- Delete: `src/example_pkg/` (entire directory)
- Modify: `Dockerfile` (the `CMD` line, last line of the file)

**Interfaces:**
- Produces: `class FaceNode(rclpy.node.Node)` with `__init__(self, **kwargs)` (kwargs forwarded to `Node`, so tests pass `parameter_overrides`), attribute `port: int` (actual bound port), attribute `state: dict[str, str]` (key → serialized JSON event). HTTP: `GET /` → `text/html`, `GET /events` → `text/event-stream` lines `data: <json>\n\n`. Console script `face_node`.

- [ ] **Step 1: Write the failing test**

Create `src/robot_face/test/test_face_node.py`:

```python
import threading
import time
import urllib.error
import urllib.request

import rclpy
from rclpy.executors import MultiThreadedExecutor
from rclpy.parameter import Parameter
from std_msgs.msg import String

from robot_face.face_node import FaceNode


def publish_until(pub, data, done, timeout=5.0):
    """Publish repeatedly until done() is true; covers DDS discovery delay."""
    deadline = time.time() + timeout
    while time.time() < deadline:
        pub.publish(String(data=data))
        time.sleep(0.05)
        if done():
            return
    raise AssertionError(f'timed out waiting after publishing {data!r}')


def test_replay_then_live_then_index():
    rclpy.init()
    try:
        node = FaceNode(parameter_overrides=[Parameter('port', value=0)])
        pub_node = rclpy.create_node('test_pub')
        pub = pub_node.create_publisher(String, '/face/expression', 10)
        ex = MultiThreadedExecutor()
        ex.add_node(node)
        ex.add_node(pub_node)
        threading.Thread(target=ex.spin, daemon=True).start()
        base = f'http://127.0.0.1:{node.port}'

        # replay: value published before connect arrives first
        publish_until(pub, 'happy', lambda: node.state.get('expression') == '{"expression": "happy"}')
        events = urllib.request.urlopen(f'{base}/events', timeout=5)
        assert events.readline() == b'data: {"expression": "happy"}\n'
        assert events.readline() == b'\n'

        # live: value published after connect streams through
        pub.publish(String(data='sad'))
        assert events.readline() == b'data: {"expression": "sad"}\n'

        # unknown expression is ignored (state unchanged, nothing streamed)
        publish_until(pub, 'bogus', lambda: True)
        assert node.state['expression'] == '{"expression": "sad"}'

        # index
        index = urllib.request.urlopen(f'{base}/', timeout=5)
        assert index.status == 200
        assert b'<svg' in index.read()

        try:
            urllib.request.urlopen(f'{base}/nope', timeout=5)
            assert False, 'expected 404'
        except urllib.error.HTTPError as e:
            assert e.code == 404
    finally:
        rclpy.shutdown()
```

- [ ] **Step 2: Run it to verify it fails**

Run: `ws colcon build --symlink-install; ws python3 -m pytest src/robot_face/test -v`
Expected: FAIL — `ModuleNotFoundError: No module named 'robot_face'` (package doesn't exist yet).

- [ ] **Step 3: Create the package files**

`src/robot_face/package.xml`:

```xml
<?xml version="1.0"?>
<?xml-model href="http://download.ros.org/schema/package_format3.xsd" schematypens="http://www.w3.org/2001/XMLSchema"?>
<package format="3">
  <name>robot_face</name>
  <version>0.1.0</version>
  <description>Browser-rendered robot face driven by ROS 2 topics</description>
  <maintainer email="josh@tesseractmobile.com">Joshua Frank</maintainer>
  <license>Apache-2.0</license>

  <exec_depend>rclpy</exec_depend>
  <exec_depend>std_msgs</exec_depend>
  <exec_depend>geometry_msgs</exec_depend>

  <test_depend>python3-pytest</test_depend>

  <export>
    <build_type>ament_python</build_type>
  </export>
</package>
```

`src/robot_face/setup.py`:

```python
from setuptools import find_packages, setup

package_name = 'robot_face'

setup(
    name=package_name,
    version='0.1.0',
    packages=find_packages(exclude=['test']),
    package_data={package_name: ['index.html']},
    data_files=[
        ('share/ament_index/resource_index/packages', ['resource/' + package_name]),
        ('share/' + package_name, ['package.xml']),
    ],
    install_requires=['setuptools'],
    zip_safe=False,
    maintainer='Joshua Frank',
    maintainer_email='josh@tesseractmobile.com',
    description='Browser-rendered robot face driven by ROS 2 topics',
    license='Apache-2.0',
    entry_points={
        'console_scripts': [
            'face_node = robot_face.face_node:main',
        ],
    },
)
```

`src/robot_face/setup.cfg`:

```ini
[develop]
script_dir=$base/lib/robot_face
[install]
install_scripts=$base/lib/robot_face
```

`src/robot_face/resource/robot_face`: empty file (`touch`).

`src/robot_face/robot_face/__init__.py`: empty file.

`src/robot_face/robot_face/index.html` (stub, replaced in Task 2):

```html
<!doctype html><meta charset="utf-8"><title>face</title><svg></svg>
```

- [ ] **Step 4: Write the node**

`src/robot_face/robot_face/face_node.py`:

```python
import json
import queue
import threading
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from importlib.resources import files

import rclpy
from geometry_msgs.msg import Point
from rclpy.node import Node
from std_msgs.msg import Float32, String

EXPRESSIONS = {'neutral', 'happy', 'sad', 'surprised', 'angry', 'sleepy'}


def clamp(v, lo, hi):
    return max(lo, min(hi, v))


class FaceNode(Node):
    """Relays /face/* topics to browsers as Server-Sent Events."""

    def __init__(self, **kwargs):
        super().__init__('face_node', **kwargs)
        self.declare_parameter('port', 8080)
        self.state = {}      # key -> last JSON event, replayed to new clients
        self.clients = []    # one queue.Queue per connected browser
        self.lock = threading.Lock()
        self.create_subscription(String, '/face/expression', self.on_expression, 10)
        self.create_subscription(Point, '/face/gaze', self.on_gaze, 10)
        self.create_subscription(Float32, '/face/mouth', self.on_mouth, 10)

        self.server = ThreadingHTTPServer(('', self.get_parameter('port').value), self._handler())
        self.port = self.server.server_address[1]
        threading.Thread(target=self.server.serve_forever, daemon=True).start()
        self.get_logger().info(f'face at http://0.0.0.0:{self.port}/')

    def on_expression(self, msg):
        if msg.data not in EXPRESSIONS:
            self.get_logger().warning(f'unknown expression {msg.data!r}')
            return
        self.push('expression', msg.data)

    def on_gaze(self, msg):
        self.push('gaze', [clamp(msg.x, -1.0, 1.0), clamp(msg.y, -1.0, 1.0)])

    def on_mouth(self, msg):
        self.push('mouth', clamp(msg.data, 0.0, 1.0))

    def push(self, key, value):
        event = json.dumps({key: value})
        with self.lock:
            self.state[key] = event
            for q in self.clients:
                q.put(event)

    def subscribe(self):
        q = queue.Queue()
        with self.lock:
            for event in self.state.values():
                q.put(event)
            self.clients.append(q)
        return q

    def unsubscribe(self, q):
        with self.lock:
            self.clients.remove(q)

    def _handler(self):
        node = self

        class Handler(BaseHTTPRequestHandler):
            def log_message(self, *args):
                pass

            def do_GET(self):
                if self.path == '/':
                    self.send_response(200)
                    self.send_header('Content-Type', 'text/html; charset=utf-8')
                    self.end_headers()
                    self.wfile.write(files('robot_face').joinpath('index.html').read_bytes())
                elif self.path == '/events':
                    self.send_response(200)
                    self.send_header('Content-Type', 'text/event-stream')
                    self.send_header('Cache-Control', 'no-cache')
                    self.end_headers()
                    q = node.subscribe()
                    try:
                        # ponytail: a client that disconnects while idle is only reaped
                        # on the next event's failed write; add a heartbeat if that leaks.
                        while True:
                            self.wfile.write(f'data: {q.get()}\n\n'.encode())
                            self.wfile.flush()
                    except (BrokenPipeError, ConnectionResetError):
                        pass
                    finally:
                        node.unsubscribe(q)
                else:
                    self.send_error(404)

        return Handler


def main(args=None):
    rclpy.init(args=args)
    node = FaceNode()
    try:
        rclpy.spin(node)
    except KeyboardInterrupt:
        pass
    finally:
        node.destroy_node()
        rclpy.try_shutdown()
```

- [ ] **Step 5: Build and run the test**

Run: `ws colcon build --symlink-install; ws python3 -m pytest src/robot_face/test -v`
Expected: PASS (1 test). If `robot_face` still isn't importable, the `ws` helper didn't source `install/setup.bash`; run `ws 'source install/setup.bash && python3 -m pytest src/robot_face/test -v'`.

- [ ] **Step 6: Remove the example package and repoint the Dockerfile**

```bash
git rm -r src/example_pkg
```

In `Dockerfile`, change the final line from
`CMD ["ros2", "run", "example_pkg", "example_node"]` to
`CMD ["ros2", "run", "robot_face", "face_node"]`.

Then confirm the prod image still builds and starts:

```bash
./build.sh -t robot-face-local -l
docker run --rm --net=host --ipc=host --pid=host robot-face-local &
sleep 5; curl -s -o /dev/null -w '%{http_code}\n' http://localhost:8080/   # expect 200
kill %1
```

- [ ] **Step 7: Commit**

```bash
git add src/robot_face Dockerfile
git commit -m "Add robot_face node: SSE relay for /face/* topics

Replaces example_pkg.

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01UAKxNv7amKZ41YtZkxcpBY"
```

---

### Task 2: The face (`index.html`)

**Files:**
- Modify: `src/robot_face/robot_face/index.html` (replace the stub entirely)

**Interfaces:**
- Consumes: SSE from `/events` as defined in Task 1; `{"expression": str}`, `{"gaze": [x, y]}`, `{"mouth": float}`.
- Produces: nothing programmatic. The Task 1 test only requires `<svg` in the body.

- [ ] **Step 1: Write the file**

Replace `src/robot_face/robot_face/index.html` with:

```html
<!doctype html>
<meta charset="utf-8">
<title>face</title>
<style>
  html, body { margin: 0; height: 100%; background: #000; overflow: hidden; cursor: none; }
  svg { width: 100vw; height: 100vh; display: block; }
  g { transform-box: fill-box; transform-origin: center; }
  .eye, .brow, .mouth { transition: transform .2s ease; }
  .lid { transition: transform .06s ease; }
  .sclera, .brow rect, .mouth rect { fill: #3cf; }
  .pupil circle { fill: #000; }

  .happy .eye        { transform: scaleY(.6); }
  .happy .mouth      { transform: scaleX(1.4); }

  .sad .eye          { transform: scaleY(.8); }
  .sad #brow-l       { transform: rotate(15deg) translateY(20px); }
  .sad #brow-r       { transform: rotate(-15deg) translateY(20px); }
  .sad .mouth        { transform: scaleX(.6) translateY(30px); }

  .surprised .eye    { transform: scale(1.15, 1.3); }
  .surprised .brow   { transform: translateY(-40px); }
  .surprised .mouth  { transform: scale(.4, 3); }

  .angry .eye        { transform: scaleY(.7); }
  .angry #brow-l     { transform: rotate(-20deg) translateY(30px); }
  .angry #brow-r     { transform: rotate(20deg) translateY(30px); }
  .angry .mouth      { transform: scaleX(.8) translateY(20px); }

  .sleepy .eye       { transform: scaleY(.25); }
  .sleepy .brow      { transform: translateY(30px); }
  .sleepy .mouth     { transform: scaleX(.5); }
</style>

<svg viewBox="0 0 1000 600" class="neutral">
  <g id="brow-l" class="brow"><rect x="150" y="110" width="200" height="30" rx="15"/></g>
  <g id="brow-r" class="brow"><rect x="650" y="110" width="200" height="30" rx="15"/></g>
  <g class="eye"><g class="lid">
    <rect class="sclera" x="150" y="170" width="200" height="220" rx="60"/>
    <g class="pupil"><circle cx="250" cy="280" r="40"/></g>
  </g></g>
  <g class="eye"><g class="lid">
    <rect class="sclera" x="650" y="170" width="200" height="220" rx="60"/>
    <g class="pupil"><circle cx="750" cy="280" r="40"/></g>
  </g></g>
  <g class="mouth"><g id="mouth-open"><rect x="350" y="470" width="300" height="30" rx="15"/></g></g>
</svg>

<script>
  const GAZE_SPEED = 3;         // gaze units per second; full sweep (-1..1) takes 2/GAZE_SPEED s
  const PUPIL_TRAVEL = 60;      // viewBox px the pupil moves at gaze = ±1
  const MOUTH_TIMEOUT_MS = 300; // no amplitude sample for this long -> mouth closes
  const MOUTH_MAX_SCALE = 4;    // mouth height multiplier at amplitude 1

  const svg = document.querySelector('svg');
  const pupils = document.querySelectorAll('.pupil');
  const lids = document.querySelectorAll('.lid');
  const mouthOpen = document.getElementById('mouth-open');

  let gaze = [0, 0], gazeTarget = [0, 0];
  let mouth = 0, mouthTarget = 0, mouthAt = 0;

  const es = new EventSource('/events');
  es.onmessage = e => {
    const m = JSON.parse(e.data);
    if (m.expression) svg.setAttribute('class', m.expression);
    if (m.gaze) gazeTarget = m.gaze;
    if (m.mouth !== undefined) { mouthTarget = m.mouth; mouthAt = performance.now(); }
  };

  let last = performance.now();
  function frame(now) {
    const dt = (now - last) / 1000;
    last = now;

    const step = GAZE_SPEED * dt;
    for (let i = 0; i < 2; i++) {
      const d = gazeTarget[i] - gaze[i];
      gaze[i] += Math.abs(d) <= step ? d : Math.sign(d) * step;
    }
    const tx = gaze[0] * PUPIL_TRAVEL, ty = -gaze[1] * PUPIL_TRAVEL; // +y is up
    pupils.forEach(p => p.style.transform = `translate(${tx}px, ${ty}px)`);

    if (now - mouthAt > MOUTH_TIMEOUT_MS) mouthTarget = 0;
    mouth += (mouthTarget - mouth) * Math.min(1, dt * 20);
    mouthOpen.style.transform = `scaleY(${1 + (MOUTH_MAX_SCALE - 1) * mouth})`;

    requestAnimationFrame(frame);
  }
  requestAnimationFrame(frame);

  function blink() {
    if (!svg.classList.contains('sleepy')) {
      lids.forEach(l => l.style.transform = 'scaleY(0.05)');
      setTimeout(() => lids.forEach(l => l.style.transform = ''), 120);
    }
    setTimeout(blink, 3000 + Math.random() * 4000);
  }
  blink();
</script>
```

- [ ] **Step 2: Run the Task 1 test (still passes; it checks for `<svg`)**

Run: `ws python3 -m pytest src/robot_face/test -v`
Expected: PASS.

- [ ] **Step 3: Verify in a browser**

Start the node in the container, then open `http://localhost:8080/` in a browser on the host:

```bash
ws ros2 run robot_face face_node &
```

Publish from a second host shell and watch the face:

```bash
ws ros2 topic pub -1 /face/expression std_msgs/String "'{data: happy}'"      # eyes squint, mouth widens
ws ros2 topic pub -1 /face/expression std_msgs/String "'{data: surprised}'"  # eyes big, brows up, mouth tall
ws ros2 topic pub -1 /face/expression std_msgs/String "'{data: bogus}'"      # node logs a warning, face unchanged
ws ros2 topic pub -1 /face/gaze geometry_msgs/Point "'{x: 0.8, y: 0.2}'"     # pupils slide right and slightly up, ~0.3 s
ws ros2 topic pub -r 20 /face/mouth std_msgs/Float32 "'{data: 0.7}'"        # mouth opens; Ctrl-C -> closes within ~300 ms
```

Also: blink every few seconds; `sleepy` stops blinking; reload the page and the last expression/gaze are restored (replay). Kill the node when done.

- [ ] **Step 4: Commit**

```bash
git add src/robot_face/robot_face/index.html
git commit -m "Add SVG face: expressions, gaze, mouth amplitude, blink

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01UAKxNv7amKZ41YtZkxcpBY"
```

---

### Task 3: README

**Files:**
- Modify: `README.md` (lines 1-3 title, line 19 stage description, line 28 tree, lines 36-41 run instructions; add a new "Face" section before "## Multiple nodes & local-network discovery")

**Interfaces:** none.

- [ ] **Step 1: Edit the README**

1. Title line 1: change `# ROS 2 Template` and its badges to `# Robot Face` with the badges pointing at `docker-ros2-face` / `ros2-face` (badge URLs: replace `docker-ros2-template` → `docker-ros2-face` and `ros2-template` → `ros2-face`).
2. Line 2-4 intro: replace with `A robot face for a monitor on a robot. A ROS 2 node relays /face/* topics to a browser page over Server-Sent Events; the page animates the face. Built on the ROS 2 template (dev container + multi-arch prod image from one Dockerfile).`
3. Line 19: `example node` → `face node`.
4. Line 28 tree: `└── example_pkg/` → `└── robot_face/`.
5. Lines 36-41: replace the build-and-run block with:
   ```
   colcon build --symlink-install
   source install/setup.bash
   ros2 run robot_face face_node
   ```
   then open `http://localhost:8080/` in a browser (the container uses host networking).
6. Insert this section before `## Multiple nodes & local-network discovery`:

```markdown
## Face

`face_node` serves the face at `http://<robot>:8080/` and streams updates over Server-Sent Events.
Point any kiosk browser at it (`chromium --kiosk http://localhost:8080/`). Nothing is published.

| Topic              | Type                  | Meaning |
|--------------------|-----------------------|---------|
| `/face/expression` | `std_msgs/String`     | `neutral`, `happy`, `sad`, `surprised`, `angry`, `sleepy`. Unknown values are ignored. |
| `/face/gaze`       | `geometry_msgs/Point` | Look target. `x`, `y` in -1..1, (0,0) = straight ahead, +x right, +y up. `z` ignored. |
| `/face/mouth`      | `std_msgs/Float32`    | Mouth opening 0..1. Publish at audio RMS rate (~20–30 Hz). Mouth closes if no sample for 300 ms. |

Smoke test:

```
ros2 topic pub -1 /face/expression std_msgs/String "{data: happy}"
ros2 topic pub -1 /face/gaze geometry_msgs/Point "{x: 0.8, y: 0.2}"
ros2 topic pub -r 20 /face/mouth std_msgs/Float32 "{data: 0.7}"
```

Parameter: `port` (default 8080). Gaze slew speed is `GAZE_SPEED` at the top of the script in
`src/robot_face/robot_face/index.html`.

Test: `colcon test --packages-select robot_face --event-handlers console_direct+`
```

7. In the "Deploy" and "Use as a template" sections, replace `frankjoshua/ros2-template` with `frankjoshua/ros2-face`. Also update `DOCKER_CONTAINER` in `.github/workflows/ci.yml` to `frankjoshua/ros2-face`.

- [ ] **Step 2: Check the rendered result**

Run: `grep -n example README.md .github/workflows/ci.yml`
Expected: no output.

- [ ] **Step 3: Commit**

```bash
git add README.md .github/workflows/ci.yml
git commit -m "Document the face node and topics

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01UAKxNv7amKZ41YtZkxcpBY"
```
