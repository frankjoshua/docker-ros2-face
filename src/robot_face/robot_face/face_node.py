import json
import queue
import threading
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from importlib.resources import files

EXPRESSIONS = {'neutral', 'happy', 'sad', 'surprised', 'angry', 'sleepy'}


def clamp(v, lo, hi):
    return max(lo, min(hi, v))


class FaceState:
    """Last value per key, fanned out to subscribers. Knows nothing about ROS or HTTP."""

    def __init__(self):
        self.values = {}     # key -> last value, replayed to new subscribers
        self.clients = []    # one queue.Queue per subscriber
        self.lock = threading.Lock()
        # name -> latest status. Each /diagnostics publisher reports only its own
        # components, so this accumulates a running list instead of replacing it.
        # Mutated only from the single ROS callback thread, so no lock needed here.
        self._diagnostics = {}

    def expression(self, name):
        if name not in EXPRESSIONS:
            return False
        self._push('expression', name)
        return True

    def gaze(self, x, y):
        self._push('gaze', [clamp(x, -1.0, 1.0), clamp(y, -1.0, 1.0)])

    def mouth(self, amplitude):
        self._push('mouth', clamp(amplitude, 0.0, 1.0))

    def diagnostics(self, statuses):
        for status in statuses:
            self._diagnostics[status['name']] = status
        self._push('diagnostics', list(self._diagnostics.values()))

    def _push(self, key, value):
        with self.lock:
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
            else:
                self.send_error(404)

    return Handler


def serve(state, port):
    """Start the HTTP server on a daemon thread. Returns the bound port."""
    server = ThreadingHTTPServer(('', port), make_handler(state))
    threading.Thread(target=server.serve_forever, daemon=True).start()
    return server.server_address[1]


def diagnostic_array_to_json(msg):
    """Convert a diagnostic_msgs/DiagnosticArray into plain JSON-able dicts."""
    return [
        {
            'name': s.name,
            'level': int(s.level[0]) if isinstance(s.level, (bytes, bytearray)) else int(s.level),
            'message': s.message,
            'hardware_id': s.hardware_id,
            'values': [[kv.key, kv.value] for kv in s.values],
        }
        for s in msg.status
    ]


def main(args=None):
    import rclpy
    from diagnostic_msgs.msg import DiagnosticArray
    from geometry_msgs.msg import Point
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

    node.create_subscription(String, '/face/expression', on_expression, 10)
    node.create_subscription(Point, '/face/gaze', lambda m: state.gaze(m.x, m.y), 10)
    node.create_subscription(Float32, '/face/mouth', lambda m: state.mouth(m.data), 10)
    node.create_subscription(
        DiagnosticArray, '/diagnostics',
        lambda m: state.diagnostics(diagnostic_array_to_json(m)), 10)
    try:
        rclpy.spin(node)
    except KeyboardInterrupt:
        pass
    finally:
        rclpy.try_shutdown()
