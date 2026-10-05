# Map Mode — Design

A third full-screen mode on the face's browser page: shows the occupancy grid map,
the robot's current position, and lets a tap send a navigation goal.

## Architecture

`face_node` gains its first outbound publish and its first inbound HTTP write. Everything
else follows the existing pattern: `FaceState` stays a plain relay, the HTTP adapter stays
dumb, and only `main()` touches ROS.

```
/map (latched) ──┐
/tf (map→base)  ─┼─▶ face_node ──SSE {"map":…}, {"pose":…}──▶ browser (map-layer canvas)
                 │                                                   │
                 │◀── POST /goal {x, y} ────────────────────────────┘
                 └──▶ publish /goal_pose (PoseStamped)
```

Confirmed live against the robot currently on the LAN: `/map` is `nav_msgs/OccupancyGrid`
published `RELIABLE` + `TRANSIENT_LOCAL`; `/goal_pose` already has a subscriber
(`geometry_msgs/PoseStamped`) — Nav2's `bt_navigator` default goal topic, the same one
RViz's "2D Nav Goal" tool publishes to; the robot's base frame is `base_link`, map frame `map`.

## Topics

| Topic | Type | Direction | Notes |
|---|---|---|---|
| `/map` | `nav_msgs/OccupancyGrid` | in | Subscribed with QoS `reliable`, `transient_local`, depth 1 — matches the latched publisher; a volatile subscription would miss it. |
| `/goal_pose` | `geometry_msgs/PoseStamped` | out | Published on tap. `frame_id` = `map_frame` parameter. Orientation faces from the robot's last known position toward the tap point; identity quaternion if no pose is known yet. |
| TF `map_frame` → `base_frame` | — | in | Looked up at 5 Hz via `tf2_ros.Buffer`/`TransformListener`. A failed lookup (no transform yet) just skips that tick — no error, no marker drawn. |

Parameters: `map_frame` (str, default `map`), `base_frame` (str, default `base_link`),
`goal_topic` (str, default `goal_pose`) — all overridable in case a robot names them
differently. `port` (existing) is unchanged.

## Wire format (SSE)

- `{"map": {"resolution": r, "width": w, "height": h, "origin": [x, y], "data": "<base64>"}}` —
  pushed once on the map's first arrival and again only if a later `/map` message differs from
  the last one pushed (SLAM maps update occasionally; no need to re-push identical grids).
  `data` is `OccupancyGrid.data` (an `array.array('b', …)` of `width*height` signed bytes,
  row-major, cell `(x, y)` at index `y*width + x`) base64-encoded directly via `.tobytes()`.
  Map origin yaw is assumed 0 (true for virtually all SLAM-generated maps) — an axis-aligned
  map only; a rotated origin will place taps wrong.
- `{"pose": [x, y, theta]}` — robot position and heading in map-frame meters/radians, pushed
  at 5 Hz whenever the TF lookup succeeds. No replay-on-connect guarantee beyond `FaceState`'s
  normal last-value replay.

## Node changes (`face_node.py`)

- `FaceState` gets two more pass-through pushes: `map(resolution, width, height, origin, data_b64)`
  (only pushes if the encoded payload differs from the stored one) and `pose(x, y, theta)`.
- `main()`: subscribes `/map` with the transient-local QoS; creates a `tf2_ros.Buffer` +
  `TransformListener` and a 5 Hz timer that looks up the transform and calls `state.pose(...)`;
  creates the `/goal_pose` publisher.
- HTTP adapter: `make_handler(state, publish_goal)` — `publish_goal(x, y)` is a closure from
  `main()` that computes heading from the last known pose (tracked by `main()`, not `FaceState`,
  since it's ROS-side bookkeeping, not display state) and publishes the `PoseStamped`.
  `do_POST` is added alongside `do_GET`: `POST /goal` reads the JSON body, validates `x`/`y` are
  numbers (else 400), calls `publish_goal`, returns 204. Any other path/method → 404.
- New exec_depends: `nav_msgs`, `tf2_ros` (both standard ROS packages, resolved by `rosdep`
  like the existing `geometry_msgs`/`diagnostic_msgs` deps — no new apt/pip packages).
- Quaternion-from-yaw is a 4-line trig function in `face_node.py`, not a new dependency.

## Browser (`web/face/views.js`; originally in the single-file `index.html`)

- Full-screen layer, `#map-layer[hidden]`, `<canvas>` (raster data wants pixel-level control).
- On a `map` event: decode the base64 grid, render once to an offscreen canvas using the active
  look's theme colours (unknown, free, occupied cells), scaled to fit the viewport. A look switch
  re-renders the bitmap in the new theme.
  Store the scale/offset and the map's resolution/origin for the tap→world conversion.
- On a `pose` event: blit the cached map bitmap plus a small glowing arrow marker at the
  robot's position/heading onto the visible canvas. Redrawing only the composite (not
  re-rendering the whole grid) avoids the flicker the diagnostics list had.
- Tap on the canvas: convert the tap's pixel to map-frame meters using the stored scale and
  origin, `POST /goal` with `{x, y}` JSON.
- Navigation: diagnostics screen gets a "MAP →" button; map screen gets a "← DIAGNOSTICS"
  button, alongside the existing face-tap-to-diagnostics and diagnostics' BACK (which now
  reads "← FACE" for clarity with a third mode in play).
- No map data yet → "NO MAP DATA" placeholder, matching the diagnostics empty state.

## Testing

Extend `test_face_node.py`: `FaceState.map()` dedups identical pushes; a `POST /goal` test using
a stub `publish_goal` callback asserts it's called with the parsed `x`/`y` and that malformed
JSON or a missing field returns 400 without calling it. No ROS needed, same pattern as the
existing tests. Manual smoke test against the live robot: publish/observe `/map` and `/goal_pose`
as already confirmed above; tap the browser and confirm a `PoseStamped` lands on `/goal_pose`.

## Not building (add when needed)

Pan/zoom, path or costmap overlay, a cancel-goal control, multi-waypoint queuing, a rotated
map origin, multiple simultaneous map sources.
