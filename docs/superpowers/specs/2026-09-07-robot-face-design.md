# Robot Face — Design

A face rendered in a browser on the robot's monitor, driven by ROS 2 topics.

## Architecture

One Python ROS 2 node (`robot_face/face_node`) subscribes to the face topics plus `/diagnostics`,
`/map`, the goal and path topics and TF, and relays them to a browser over Server-Sent Events (SSE).
All animation runs in the browser. The node's only output is a navigation goal when the map is
tapped (`POST /goal` → `geometry_msgs/PoseStamped`); see `2026-09-08-map-mode-design.md`.

```
other nodes ──/face/*──▶ face_node ──SSE (:8080/events)──▶ Chromium kiosk (web/index.html)
                                    └─GET / and web/ files ─▶
```

The browser is not managed by this package. Point any kiosk browser at `http://<robot>:8080/`.

## Face topics (in)

| Topic              | Type                     | Meaning |
|--------------------|--------------------------|---------|
| `/face/expression` | `std_msgs/String`        | Preset name from `web/face/vocabulary.json` (14 presets). Becomes the base layer. Unknown values are logged and ignored. |
| `/face/affect`     | `geometry_msgs/Point`    | `x` valence, `y` arousal, -1..1, clamped. The browser blends presets near that point (Kismet/Russell style) into the base layer. `z` ignored. |
| `/face/channels`   | `sensor_msgs/JointState` | Override layer: `name[]` channels (or bilateral names without a side), `position[]` 0..1, clamped. Replaces the previous override; empty clears. Unknown names or a length mismatch: logged, whole message ignored. |
| `/face/gaze`       | `geometry_msgs/Point`    | Look target. `x`, `y` in -1..1, screen-normalized, (0,0) = straight ahead, +x right, +y up. Clamped. `z` ignored. |
| `/face/mouth`      | `std_msgs/Float32`       | Mouth opening 0..1, clamped. Publish at audio RMS rate (20–30 Hz is enough). If no sample arrives for 300 ms the mouth closes. |
| `/face/look`       | `std_msgs/String`        | `murmuration`, `liquid_glass`, `hologram`. Unknown values are logged and ignored. |

`/face/expression` and `/face/affect` both set the base layer; the one received last wins, including
after a browser reconnect (replay is in recency order).

Gaze speed is a constant in `web/face/rig.js`, not a message field: publishers (e.g. a YOLO tracker)
send raw target positions every frame and the face smooths them.

## Node: `face_node`

- Package `src/robot_face` (ament_python). One module, three layers:
  - **`FaceState`** (the rule; stdlib only, no ROS, no HTTP): `expression(name)` and `look(name)`
    return False for unknown names; `channels(names, values)` returns False for unknown names or a
    length mismatch, expands side-less bilateral names and clamps; `gaze`, `mouth`, `affect` clamp
    and store. Names come from `web/face/vocabulary.json`, the single source shared with the browser.
    `values` holds the last value per key in recency order; `subscribe()` returns a `queue.Queue`
    pre-loaded with the current values; every later change is put on every subscriber's queue as
    `(key, value)`.
  - **HTTP adapter**: stdlib `ThreadingHTTPServer` on a daemon thread, `serve(state, port) -> port`.
    `GET /events` → `text/event-stream`: subscribe, then write each `(key, value)` as
    `data: {"key": value}\n\n`. A failed write unsubscribes. `GET /` → `web/index.html`; any other
    path → that file under `web/` (package data; `..`, dot-files and missing files are 404). The
    query string is ignored.
  - **`main()`** (composition root, the only place `rclpy` is imported): declares parameter
    `port` (int, default 8080) and the map parameters, starts the server, and wires the
    subscriptions (warnings on rejected values), the TF pose timer and the goal publisher.
- Shutdown: HTTP server thread is a daemon; `rclpy.spin` ends on Ctrl-C.

## Browser: `web/`

ES modules, no build step. The only dependency is three.js r186 core, vendored as one minified
file (`web/vendor/three.module.min.js`, MIT) and mapped with an import map; no addons.

- **`face/rig.js`**: channel values per frame. Base (preset or affect blend) + override, eased
  ~0.3 s with ease-in-out; then procedural layers: gaze slewed at `GAZE_SPEED` plus small random
  saccades, speech (`jawOpen = max(base, 0.85·mouth)`, 300 ms timeout), blink (~160 ms, random
  3–7 s, sometimes double; suppressed while base `eyeBlink` ≥ 0.5). Also outputs a slow `breath`
  sine and `sinceChange` for look effects.
- **`face/pose.js`**: channels → face geometry (eyes with lid curves, brows, mouth edges, cheeks,
  tears, sweat, sparkles, squash/stretch). Couplings live here (brow down slants the upper lid,
  cheek raise lifts the lower lid), so every look gets them.
- **`face/paint.js`**: paints a pose onto a 2D canvas in a style; used for feature textures.
- **`face/looks/*.js`**: `createLook(container, vocab) → {update(state, now, dt), resize(), dispose()}`.
  Switching looks disposes the old one.
- **`face/main.js`**: wires SSE messages to the rig and the active look. `?look=` sets the starting
  look; `?demo` runs `face/demo.js` instead of SSE; `?controls=off` drops the controls.
- **`face/controls.js`**: on-screen panel (look selector, preset buttons, mood pad → `rig.affect`,
  hold-to-talk → `rig.mouth`), shown on pointer/touch/key input and hidden after 4 s idle. Pointer
  movement steers the gaze; 2.5 s after it stops the last `/face/gaze` target is restored.
- **`face/views.js`**: Diagnostics (`/diagnostics`, merged by name, expandable rows that keep
  open/focus state across updates) and Map (`/map` grid, TF pose, goal, path; tap → `POST /goal`)
  layered over the face. Opened from the panel, or by tapping the face with `?controls=off`; Escape
  steps back. The face keeps animating under the translucent diagnostics; it pauses under the
  opaque map.
- **Theming**: `face/ui.css` defines colour, font and radius tokens per look on
  `<html data-look>`. The controls, both views, the map cells, robot, goal and path all read them,
  so a look switch (panel or `/face/look`) restyles everything, and the map bitmap is recoloured.
- **Connection**: `EventSource('/events')`; the browser reconnects automatically and the node's
  replay-on-connect restores state.

## Docker

- `Dockerfile` `CMD` → `ros2 run robot_face face_node`. No new apt deps (`sensor_msgs` comes with ROS).
- README: replace the example-node section with the face topics table and a `ros2 topic pub`
  smoke test.

## Testing

One pytest file, `src/robot_face/test/test_face_node.py`, no ROS required: `FaceState` validation
and clamping for every topic, channel expansion and rejection, recency-ordered replay, and the HTTP
adapter (SSE replay + live, static files with content types, query strings, 404s including path
traversal). The browser is checked by rendering every preset in each look with headless Chrome.
The ROS wiring in `main()` is covered by the manual smoke test.

Manual smoke test:

```
ros2 topic pub -1 /face/expression std_msgs/String "{data: happy}"
ros2 topic pub -1 /face/gaze geometry_msgs/Point "{x: 0.8, y: 0.2}"
ros2 topic pub -r 20 /face/mouth std_msgs/Float32 "{data: 0.7}"
```

## Not building (add when needed)

Launch files, custom message types, per-command gaze speed, gaze speed as a ROS parameter, SSE heartbeat, authentication, REST endpoints,
config files, bundled browser/kiosk setup, an affect `stance` axis, eye-glyph substitution (hearts, stars),
a `/face/say` text topic.
