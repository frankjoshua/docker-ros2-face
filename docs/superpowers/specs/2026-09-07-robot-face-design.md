# Robot Face — Design

A face rendered in a browser on the robot's monitor, driven by ROS 2 topics.

## Architecture

One Python ROS 2 node (`robot_face/face_node`) subscribes to three topics and relays
them to a browser over Server-Sent Events (SSE). All animation runs in the browser.
The node is a dumb relay with a tiny stdlib HTTP server; no REST, no rosbridge, no Node.js.

```
other nodes ──/face/*──▶ face_node ──SSE (:8080/events)──▶ Chromium kiosk (index.html)
                                    └─GET / ────────────▶
```

The browser is not managed by this package. Point any kiosk browser at `http://<robot>:8080/`.

## Topics (in only; nothing published)

| Topic              | Type                  | Meaning |
|--------------------|-----------------------|---------|
| `/face/expression` | `std_msgs/String`     | Named baseline: `neutral`, `happy`, `sad`, `surprised`, `angry`, `sleepy`. Sets eye/brow/mouth shape. Unknown values are logged and ignored. |
| `/face/gaze`       | `geometry_msgs/Point` | Look target. `x`, `y` in -1..1, screen-normalized, (0,0) = straight ahead, +x right, +y up. Clamped. `z` ignored (reserved for per-command speed). |
| `/face/mouth`      | `std_msgs/Float32`    | Mouth opening 0..1, clamped. Publish at audio RMS rate (20–30 Hz is enough). If no sample arrives for 300 ms the mouth closes. |

Gaze speed is a node parameter, not a message field: publishers (e.g. a YOLO tracker) send raw
target positions every frame and the face smooths them.

## Node: `face_node`

- Package `src/robot_face` (ament_python). Replaces `example_pkg`.
- Parameters: `port` (int, default 8080), `gaze_speed` (float, units/sec, default 3.0).
- Three subscriptions. Each callback converts the message to a one-key JSON object —
  `{"expression": "happy"}`, `{"gaze": [x, y]}`, `{"mouth": 0.4}` — stores it as the last value
  for that key, and puts it on every connected client's `queue.Queue`.
- HTTP server: stdlib `ThreadingHTTPServer` on a daemon thread.
  - `GET /` → `index.html` (installed with the package via `data_files`).
  - `GET /events` → `text/event-stream`. On connect, send `{"gaze_speed": …}` and the last value
    of each key, then stream from the client's queue. Send an SSE comment every 15 s as a
    heartbeat; a failed write removes the client.
  - Anything else → 404.
- Shutdown: HTTP server thread is a daemon; `rclpy.spin` ends on Ctrl-C.

## Browser: `index.html`

Single file, no dependencies.

- Full-screen black background, SVG face: two eyes (sclera + pupil), two brows, one mouth.
- **Expressions**: a CSS class on `<svg>`. Each class sets eye height (`scaleY`), brow rotation,
  and mouth shape via `transform` with ~200 ms CSS transitions. No per-frame path rewriting.
- **Gaze**: `requestAnimationFrame` loop lerps pupil translation toward the target at
  `gaze_speed` (received on connect). Pupil travel is bounded so it stays inside the eye.
- **Mouth**: loop lerps `scaleY` on the mouth group toward the latest amplitude. If no sample
  for 300 ms, target = 0.
- **Blink**: `scaleY` eyes to 0 for ~120 ms at a random 3–7 s interval. Suppressed for `sleepy`.
- **Connection**: `EventSource('/events')`; the browser reconnects automatically and the node's
  replay-on-connect restores state.

## Docker

- `Dockerfile` `CMD` → `ros2 run robot_face face_node`. Add `EXPOSE 8080`. No new apt deps.
- README: replace the example-node section with the face topics table and a `ros2 topic pub`
  smoke test.

## Testing

One pytest in `src/robot_face/test/test_face_node.py`: start the node on a random port, open
`/events` with `urllib`, publish an expression, assert the event arrives within a timeout.
Runs via `colcon test` in the dev container. The stock flake8/pep257/copyright tests stay.

Manual smoke test:

```
ros2 topic pub -1 /face/expression std_msgs/String "{data: happy}"
ros2 topic pub -1 /face/gaze geometry_msgs/Point "{x: 0.8, y: 0.2}"
ros2 topic pub -r 20 /face/mouth std_msgs/Float32 "{data: 0.7}"
```

## Not building (add when needed)

Launch files, custom message types, per-command gaze speed, authentication, REST endpoints,
multiple faces, config files, bundled browser/kiosk setup, canvas renderer (fallback only if
SVG proves slow on the target hardware).
