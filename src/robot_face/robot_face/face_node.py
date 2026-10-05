import json
import queue
import threading
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from importlib.resources import files
from urllib.parse import urlsplit

WEB = files('robot_face').joinpath('web')
VOCABULARY = json.loads(WEB.joinpath('face').joinpath('vocabulary.json').read_text())
EXPRESSIONS = set(VOCABULARY['presets'])
LOOKS = set(VOCABULARY['looks'])
CHANNELS = set(VOCABULARY['channels'])
CONTENT_TYPES = {
    '.html': 'text/html; charset=utf-8',
    '.js': 'text/javascript; charset=utf-8',
    '.json': 'application/json',
}


def clamp(v, lo, hi):
    return max(lo, min(hi, v))


class FaceState:
    """Last value per key, fanned out to subscribers. Knows nothing about ROS or HTTP."""

    def __init__(self):
        self.values = {}     # key -> last value, replayed to new subscribers
        self.clients = []    # one queue.Queue per subscriber
        self.lock = threading.Lock()

    def expression(self, name):
        if name not in EXPRESSIONS:
            return False
        self._push('expression', name)
        return True

    def look(self, name):
        if name not in LOOKS:
            return False
        self._push('look', name)
        return True

    def gaze(self, x, y):
        self._push('gaze', [clamp(x, -1.0, 1.0), clamp(y, -1.0, 1.0)])

    def mouth(self, amplitude):
        self._push('mouth', clamp(amplitude, 0.0, 1.0))

    def affect(self, valence, arousal):
        self._push('affect', [clamp(valence, -1.0, 1.0), clamp(arousal, -1.0, 1.0)])

    def channels(self, names, values):
        """Replace the override layer. A bilateral name without its side sets both sides."""
        if len(names) != len(values):
            return False
        out = {}
        for name, value in zip(names, values):
            sides = [name] if name in CHANNELS else [name + 'Left', name + 'Right']
            if not all(s in CHANNELS for s in sides):
                return False
            for s in sides:
                out[s] = clamp(float(value), 0.0, 1.0)
        self._push('channels', out)
        return True

    def _push(self, key, value):
        with self.lock:
            # Re-insert so replay order is recency order: the browser applies the newest base layer last.
            self.values.pop(key, None)
            self.values[key] = value
            for q in self.clients:
                q.put((key, value))

    def subscribe(self):
        q = queue.Queue()
        with self.lock:
            for item in self.values.items():
                q.put(item)
            self.clients.append(q)
        return q

    def unsubscribe(self, q):
        with self.lock:
            self.clients.remove(q)


def make_handler(state):
    class Handler(BaseHTTPRequestHandler):
        def log_message(self, *args):
            pass

        def do_GET(self):
            path = urlsplit(self.path).path
            if path == '/events':
                self._events()
                return
            parts = ['index.html'] if path == '/' else path.lstrip('/').split('/')
            if any(p in ('', '..') or p.startswith('.') for p in parts):
                self.send_error(404)
                return
            target = WEB
            for p in parts:
                target = target.joinpath(p)
            if not target.is_file():
                self.send_error(404)
                return
            body = target.read_bytes()
            suffix = parts[-1][parts[-1].rfind('.'):] if '.' in parts[-1] else ''
            self.send_response(200)
            self.send_header('Content-Type', CONTENT_TYPES.get(suffix, 'application/octet-stream'))
            self.send_header('Content-Length', str(len(body)))
            self.end_headers()
            self.wfile.write(body)

        def _events(self):
            self.send_response(200)
            self.send_header('Content-Type', 'text/event-stream')
            self.send_header('Cache-Control', 'no-cache')
            self.end_headers()
            q = state.subscribe()
            try:
                # ponytail: a client that disconnects while idle is only reaped
                # on the next event's failed write; add a heartbeat if that leaks.
                while True:
                    key, value = q.get()
                    self.wfile.write(f'data: {json.dumps({key: value})}\n\n'.encode())
                    self.wfile.flush()
            except OSError:
                pass
            finally:
                state.unsubscribe(q)

    return Handler


def serve(state, port):
    """Start the HTTP server on a daemon thread. Returns the bound port."""
    server = ThreadingHTTPServer(('', port), make_handler(state))
    threading.Thread(target=server.serve_forever, daemon=True).start()
    return server.server_address[1]


def main(args=None):
    import rclpy
    from geometry_msgs.msg import Point
    from sensor_msgs.msg import JointState
    from std_msgs.msg import Float32, String

    rclpy.init(args=args)
    node = rclpy.create_node('face_node')
    node.declare_parameter('port', 8080)
    state = FaceState()
    port = serve(state, node.get_parameter('port').value)
    node.get_logger().info(f'face at http://0.0.0.0:{port}/')

    def on_expression(msg):
        if not state.expression(msg.data):
            node.get_logger().warning(f'unknown expression {msg.data!r}')

    def on_look(msg):
        if not state.look(msg.data):
            node.get_logger().warning(f'unknown look {msg.data!r}')

    def on_channels(msg):
        if not state.channels(list(msg.name), list(msg.position)):
            node.get_logger().warning(f'bad channels {list(msg.name)!r}: unknown name or name/position length mismatch')

    node.create_subscription(String, '/face/expression', on_expression, 10)
    node.create_subscription(String, '/face/look', on_look, 10)
    node.create_subscription(Point, '/face/gaze', lambda m: state.gaze(m.x, m.y), 10)
    node.create_subscription(Float32, '/face/mouth', lambda m: state.mouth(m.data), 10)
    node.create_subscription(Point, '/face/affect', lambda m: state.affect(m.x, m.y), 10)
    node.create_subscription(JointState, '/face/channels', on_channels, 10)
    try:
        rclpy.spin(node)
    except KeyboardInterrupt:
        pass
    finally:
        rclpy.try_shutdown()
