import base64
import json
import math
import queue
import threading
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from importlib.resources import files

EXPRESSIONS = {'neutral', 'happy', 'sad', 'surprised', 'angry', 'sleepy'}
CLIENT_QUEUE_SIZE = 64
HEARTBEAT_SECONDS = 15
SOCKET_TIMEOUT_SECONDS = 10
MAX_GOAL_BYTES = 4096


def clamp(v, lo, hi):
    return max(lo, min(hi, v))


def yaw_to_quaternion(yaw):
    """Quaternion (x, y, z, w) for a rotation of `yaw` radians about Z. Avoids a
    tf_transformations dependency for this one conversion."""
    return (0.0, 0.0, math.sin(yaw / 2), math.cos(yaw / 2))


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
        # dedup identical /map pushes; mutated only from the single ROS callback
        # thread, like _diagnostics, so no lock needed here either.
        self._last_map = None

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

    def map(self, resolution, width, height, origin, data_b64):
        payload = {'resolution': resolution, 'width': width, 'height': height,
                   'origin': origin, 'data': data_b64}
        if payload == self._last_map:
            return
        self._last_map = payload
        self._push('map', payload)

    def pose(self, x, y, theta):
        self._push('pose', [x, y, theta])

    def _push(self, key, value):
        with self.lock:
            self.values[key] = value
            for q in self.clients:
                try:
                    q.put_nowait((key, value))
                except queue.Full:
                    # A stalled browser needs current state, not an ever-growing
                    # history. Replay every key so infrequent updates survive too.
                    while True:
                        try:
                            q.get_nowait()
                        except queue.Empty:
                            break
                    for item in self.values.items():
                        q.put_nowait(item)

    def subscribe(self):
        q = queue.Queue(maxsize=CLIENT_QUEUE_SIZE)
        with self.lock:
            for item in self.values.items():
                q.put(item)
            self.clients.append(q)
        return q

    def unsubscribe(self, q):
        with self.lock:
            self.clients.remove(q)


def make_handler(state, publish_goal):
    class Handler(BaseHTTPRequestHandler):
        def setup(self):
            super().setup()
            self.connection.settimeout(SOCKET_TIMEOUT_SECONDS)

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
                    while True:
                        try:
                            key, value = q.get(timeout=HEARTBEAT_SECONDS)
                            event = f'data: {json.dumps({key: value})}\n\n'.encode()
                        except queue.Empty:
                            event = b': heartbeat\n\n'
                        self.wfile.write(event)
                        self.wfile.flush()
                except OSError:
                    pass
                finally:
                    state.unsubscribe(q)
            else:
                self.send_error(404)

        def do_POST(self):
            if self.path != '/goal':
                self.send_error(404)
                return
            if (self.headers.get_content_type() != 'application/json'
                    or self.headers.get('Transfer-Encoding') is not None):
                self.send_error(400)
                return
            try:
                lengths = self.headers.get_all('Content-Length', [])
                if len(lengths) != 1 or not lengths[0].isascii() or not lengths[0].isdigit():
                    raise ValueError('invalid content length')
                length = int(lengths[0])
                if length <= 0:
                    raise ValueError('empty body')
                if length > MAX_GOAL_BYTES:
                    self.send_error(413)
                    return
                body = json.loads(self.rfile.read(length))
                if not isinstance(body, dict) or any(isinstance(body[k], bool) for k in ('x', 'y')):
                    raise ValueError('expected coordinates')
                x, y = float(body['x']), float(body['y'])
                if not (math.isfinite(x) and math.isfinite(y)):
                    raise ValueError('non-finite coordinate')
            except TimeoutError:
                self.send_error(408)
                return
            except (ValueError, KeyError, TypeError, OverflowError, RecursionError):
                self.send_error(400)
                return
            publish_goal(x, y)
            self.send_response(204)
            self.end_headers()

    return Handler


def serve(state, port, publish_goal=None):
    """Start the HTTP server on a daemon thread. Returns the bound port."""
    if publish_goal is None:
        publish_goal = lambda x, y: None
    server = ThreadingHTTPServer(('', port), make_handler(state, publish_goal))
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
    import tf2_ros
    from diagnostic_msgs.msg import DiagnosticArray
    from geometry_msgs.msg import Point, PoseStamped, Quaternion
    from nav_msgs.msg import OccupancyGrid
    from rclpy.qos import DurabilityPolicy, QoSProfile, ReliabilityPolicy
    from std_msgs.msg import Float32, String

    rclpy.init(args=args)
    node = rclpy.create_node('face_node')
    node.declare_parameter('port', 8080)
    node.declare_parameter('map_frame', 'map')
    node.declare_parameter('base_frame', 'base_link')
    node.declare_parameter('goal_topic', 'goal_pose')
    map_frame = node.get_parameter('map_frame').value
    base_frame = node.get_parameter('base_frame').value

    state = FaceState()
    # last_pose/has_pose are written by the ROS timer thread and read by HTTP handler
    # threads with no lock — safe in practice (GIL-atomic ops), same assumption FaceState
    # documents for _diagnostics/_last_map.
    last_pose = [0.0, 0.0, 0.0]  # x, y, theta; faces the goal heading toward the tap
    has_pose = False  # no TF lookup has succeeded yet; identity heading until one does
    goal_pub = node.create_publisher(PoseStamped, node.get_parameter('goal_topic').value, 10)

    def publish_goal(x, y):
        theta = math.atan2(y - last_pose[1], x - last_pose[0]) if has_pose else 0.0
        qx, qy, qz, qw = yaw_to_quaternion(theta)
        msg = PoseStamped()
        msg.header.frame_id = map_frame
        msg.pose.position.x = x
        msg.pose.position.y = y
        msg.pose.orientation = Quaternion(x=qx, y=qy, z=qz, w=qw)
        goal_pub.publish(msg)

    port = serve(state, node.get_parameter('port').value, publish_goal)
    node.get_logger().info(f'face at http://0.0.0.0:{port}/')

    def on_expression(msg):
        if not state.expression(msg.data):
            node.get_logger().warning(f'unknown expression {msg.data!r}')

    def on_map(msg):
        state.map(msg.info.resolution, msg.info.width, msg.info.height,
                   [msg.info.origin.position.x, msg.info.origin.position.y],
                   base64.b64encode(msg.data.tobytes()).decode('ascii'))

    node.create_subscription(String, '/face/expression', on_expression, 10)
    node.create_subscription(Point, '/face/gaze', lambda m: state.gaze(m.x, m.y), 10)
    node.create_subscription(Float32, '/face/mouth', lambda m: state.mouth(m.data), 10)
    node.create_subscription(
        DiagnosticArray, '/diagnostics',
        lambda m: state.diagnostics(diagnostic_array_to_json(m)), 10)
    map_qos = QoSProfile(depth=1, reliability=ReliabilityPolicy.RELIABLE,
                          durability=DurabilityPolicy.TRANSIENT_LOCAL)
    node.create_subscription(OccupancyGrid, '/map', on_map, map_qos)

    tf_buffer = tf2_ros.Buffer()
    tf2_ros.TransformListener(tf_buffer, node)

    def on_pose_timer():
        nonlocal has_pose
        try:
            t = tf_buffer.lookup_transform(map_frame, base_frame, rclpy.time.Time())
        except (tf2_ros.LookupException, tf2_ros.ConnectivityException,
                tf2_ros.ExtrapolationException):
            return
        q = t.transform.rotation
        theta = math.atan2(2 * (q.w * q.z + q.x * q.y), 1 - 2 * (q.y * q.y + q.z * q.z))
        last_pose[0] = t.transform.translation.x
        last_pose[1] = t.transform.translation.y
        last_pose[2] = theta
        has_pose = True
        state.pose(*last_pose)

    node.create_timer(0.2, on_pose_timer)

    try:
        rclpy.spin(node)
    except KeyboardInterrupt:
        pass
    finally:
        rclpy.try_shutdown()
