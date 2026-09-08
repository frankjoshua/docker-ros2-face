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

    def expression(self, name):
        if name not in EXPRESSIONS:
            return False
        self._push('expression', name)
        return True

    def gaze(self, x, y):
        self._push('gaze', [clamp(x, -1.0, 1.0), clamp(y, -1.0, 1.0)])

    def mouth(self, amplitude):
        self._push('mouth', clamp(amplitude, 0.0, 1.0))

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


def main(args=None):
    import rclpy
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
    try:
        rclpy.spin(node)
    except KeyboardInterrupt:
        pass
    finally:
        rclpy.try_shutdown()
