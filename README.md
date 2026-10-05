# Robot Face [![CI](https://github.com/frankjoshua/docker-ros2-face/workflows/CI/badge.svg)](https://github.com/frankjoshua/docker-ros2-face/actions) [![](https://img.shields.io/docker/pulls/frankjoshua/ros2-face)](https://hub.docker.com/r/frankjoshua/ros2-face)

A robot face for a monitor on a robot. A ROS 2 node relays /face/* topics to a browser page over
Server-Sent Events; the page animates the face. Built on the ROS 2 template (dev container +
multi-arch prod image from one Dockerfile).

## How it works

One `Dockerfile`, three stages, all built from the same base image. The distro is set in one place —
the `BASE_IMAGE` arg at the top of the [Dockerfile](Dockerfile) (`frankjoshua/ros2:humble` by
default). Change that line to target any ROS 2 version; the dev container and `build.sh` both
inherit it, and everything else keys off `$ROS_DISTRO` (set by the base image). The stages:

- **`base`** — shared dependencies. Add every extra apt/pip package here so dev and deploy can't
  drift apart.
- **`dev`** — `base` + the image's non-root `ubuntu` user (with passwordless sudo) + an interactive shell. This is what VS Code opens. Your
  workspace is bind-mounted (not copied) and you build it inside the container.
- **`prod`** — `base` + your `src/` copied in and `colcon build`-ed, with an entrypoint that runs the
  face node. This is what `build.sh` / CI publish.

```
.
├── .devcontainer/devcontainer.json   # opens the dev stage
├── Dockerfile                        # base / dev / prod
├── build.sh                          # multi-arch build + push (prod stage)
├── ros_entrypoint.sh                 # sources ROS + workspace for the prod image
└── src/                              # your colcon packages (repo root is the workspace)
    └── robot_face/
```

## Develop

1. Install Docker, VS Code, and the **Dev Containers** extension.
2. Open this folder in VS Code.
3. `Ctrl+Shift+P` → **Dev Containers: Reopen in Container**. The first build pulls the base image.
4. Open a terminal — ROS is already sourced, so `ros2` works immediately. Build and run the face node:
   ```
   colcon build --symlink-install
   source install/setup.bash
   ros2 run robot_face face_node
   ```
   then open `http://localhost:8080/` in a browser (the container uses host networking).

The repo root is the colcon workspace (`/home/ws` in the container), so `build/`, `install/`, and
`log/` appear here and are git-ignored. The container runs as the non-root **`ubuntu`** user, which
is already in the `dialout`/`video`/`plugdev` groups — handy for serial devices and cameras. The
container also includes the `claude-code` dev container feature (Node.js + Claude Code), so coding
agents work out of the box.

### Without VS Code

The same config works with any devcontainer-spec tool — the
[devcontainer CLI](https://github.com/devcontainers/cli), herdr, etc.:

```
devcontainer up --workspace-folder .    # build & start
devcontainer exec --workspace-folder . bash
```

Add `--remove-existing-container` to `devcontainer up` to rebuild after changing
`devcontainer.json` or the `Dockerfile`. Whatever tool you use, keep the repo mounted at `/home/ws`
— the dev shell auto-sources `/home/ws/install/setup.bash`, so colcon output (`install/`) is
expected there.

> **Claude settings:** the devcontainer bind-mounts your host `~/.claude` and `~/.claude.json`, so
> your subscription login, settings, and skills carry into the container. If the host files don't
> exist yet, run `claude` once on the host first (Docker would otherwise create them root-owned).
> You may see non-blocking hook errors — host settings can reference absolute host paths (hooks,
> binaries) that don't exist in the container. Mount those paths too, or ignore the errors; remove
> the two mounts from `devcontainer.json` for a fully isolated container.

## Face

`face_node` serves the face at `http://<robot>:8080/` and streams updates over Server-Sent Events.
Point any kiosk browser with WebGL 2 at it (`chromium --kiosk http://localhost:8080/`).

The page has three looks, switchable live: **murmuration** (default; a flock of glowing particles),
**liquid_glass** (an iridescent jelly blob) and **hologram** (a cyan robot head in a glass case).
All three render the same expression rig, so a new expression is one recipe, not new art per look.

**Screens and menu:** the face is the default screen. Click or tap it to open the menu: **Face /
Diagnostics / Map** screen buttons, the look selector, all 14 expressions, a mood pad (drag for
pleasant/unpleasant × calm/excited) and a hold-to-talk button. Click the face again, press **Close**
or Escape to hide it; it also hides after 8 s idle. Diagnostics has **← Face** and **Map →**; the map
has **← Diagnostics** and **Face**; Escape steps back. Keys: **D** diagnostics, **M** map. The eyes
follow the mouse; 2.5 s after it stops, the gaze goes back to `/face/gaze`. Local input acts like
one more publisher: the newest input wins, so a ROS message replaces what was clicked. Add
`?controls=off` to the URL for a kiosk without the menu; tapping the face then opens diagnostics.

### Diagnostics and map

**Diagnostics** lists `/diagnostics` (`diagnostic_msgs/DiagnosticArray`) merged by component name;
tap an entry for its hardware ID and key/values. **Map** shows `/map` with the robot's TF pose
(heading arrow), the latest goal (target) and the planned path (line). Tapping inside the map
publishes a `geometry_msgs/PoseStamped` navigation goal; taps in the surrounding margins are
ignored. Map origins are currently assumed to have zero yaw. Goals from map taps and the
`goal_topic` subscription are shared with all browsers. The path comes from `nav_msgs/Path` on
`path_topic`; an empty path clears the line. Goals and paths in other coordinate frames are
transformed into `map_frame` using TF. The display retains the latest goal and path; it does not
track navigation completion.

Both views are themed to the selected look: violet starfield panels for murmuration, frosted
pastel glass for liquid glass, and cyan scan-line panels for hologram. The map recolours its
cells, robot, goal and path to match, and the face keeps animating behind the diagnostics.

### How expressions work

Expressions are defined once in
[`web/face/vocabulary.json`](src/robot_face/robot_face/web/face/vocabulary.json) as recipes over
**channels**: the 52 ARKit blend-shape names (`browInnerUp`, `mouthSmileLeft`, `eyeBlinkRight`, …)
plus seven cartoon effects (`pupilDilate`, `blush`, `tears`, `sweat`, `sparkle`, `squash`,
`stretch`), each 0..1. ARKit's `Left`/`Right` are the face's own sides, so `Left` is on the
viewer's right. Each frame the browser composes layers, bottom to top:

1. **Base:** the last `/face/expression` preset or `/face/affect` blend, whichever arrived last.
2. **Override:** `/face/channels` values replace the base for the channels they name.
3. **Procedural:** gaze (plus small saccades), speech from `/face/mouth`, and blinks (skipped while
   the base already holds the eyes mostly shut).

Changes to the base or override ease in and out over ~0.3 s. Each look then draws the composed
channels through one shared geometry ([`pose.js`](src/robot_face/robot_face/web/face/pose.js)).

| Topic              | Type                     | Meaning |
|--------------------|--------------------------|---------|
| `/face/expression` | `std_msgs/String`        | Preset: `neutral`, `happy`, `sad`, `surprised`, `angry`, `sleepy`, `joy`, `afraid`, `disgusted`, `contempt`, `skeptical`, `smitten`, `crying`, `nervous`. Unknown values are ignored. |
| `/face/affect`     | `geometry_msgs/Point`    | Mood as `x` = valence, `y` = arousal, each -1..1; blends the nearest presets. `z` ignored. |
| `/face/channels`   | `sensor_msgs/JointState` | Direct control: `name[]` channels, `position[]` values 0..1. Holds until the next message; an empty message clears it. A bilateral name without its side (`mouthSmile`) sets both sides. A message with an unknown name is ignored. |
| `/face/gaze`       | `geometry_msgs/Point`    | Look target. `x`, `y` in -1..1, (0,0) = straight ahead, +x right, +y up. `z` ignored. |
| `/face/mouth`      | `std_msgs/Float32`       | Mouth opening 0..1. Publish at audio RMS rate (~20–30 Hz). Mouth closes if no sample for 300 ms. |
| `/face/look`       | `std_msgs/String`        | `murmuration`, `liquid_glass` or `hologram`. |

Smoke test:

```
ros2 topic pub -1 /face/expression std_msgs/String "{data: happy}"
ros2 topic pub -1 /face/gaze geometry_msgs/Point "{x: 0.8, y: 0.2}"
ros2 topic pub -r 20 /face/mouth std_msgs/Float32 "{data: 0.7}"
ros2 topic pub -1 /face/affect geometry_msgs/Point "{x: -0.6, y: -0.5}"
ros2 topic pub -1 /face/channels sensor_msgs/JointState "{name: [browOuterUpLeft, tears], position: [1.0, 0.8]}"
ros2 topic pub -1 /face/channels sensor_msgs/JointState "{}"
ros2 topic pub -1 /face/look std_msgs/String "{data: hologram}"
```

Parameters: `port` (default 8080), `map_frame` (`map`), `base_frame` (`base_link`), and
`goal_topic` (`goal_pose`), and `path_topic` (`plan`). For a different planner topic, pass
`--ros-args -p path_topic:=/your/path/topic`. Timing constants (gaze slew speed, ease times,
blink) are at the top of [`web/face/rig.js`](src/robot_face/robot_face/web/face/rig.js); quality
constants (particle count, texture size, pixel-ratio cap) are at the top of each file in
`web/face/looks/`.

Preview without ROS: `python3 -m http.server -d src/robot_face/robot_face/web 8000`, then open
`http://localhost:8000/?demo` (a scripted tour; `?demo=looks` also cycles the looks, and
`?look=hologram` picks the starting look). three.js r186 is vendored in `web/vendor/` (MIT).

Test: `colcon test --packages-select robot_face --event-handlers console_direct+`

The Python/HTTP tests also run without ROS. To include the Chromium browser regressions:

```sh
python3 -m venv .venv
source .venv/bin/activate
python -m pip install -r requirements-test.txt
python -m playwright install chromium
PYTHONPATH=src/robot_face python -m pytest -q src/robot_face/test
```

Set `CHROMIUM_EXECUTABLE=/path/to/chromium` to use an existing browser. Browser tests are skipped
when Playwright is not installed. CI installs it and runs the complete suite before building.

## Multiple nodes & local-network discovery

Nodes can talk to each other — on this machine or across your LAN — out of the box. The dev
container (`.devcontainer/devcontainer.json`) sets:

- **`--net=host --ipc=host --pid=host`** (`runArgs`): host networking for LAN discovery; shared
  memory for same-host transport (**`--ipc=host` is required** — without a shared `/dev/shm`, Fast
  DDS instances silently fail to connect); and unique DDS GUIDs across containers.
- **`ROS_AUTOMATIC_DISCOVERY_RANGE=SUBNET`** (`containerEnv`): discover nodes anywhere on the local
  subnet, not just this host. Use `LOCALHOST` to restrict discovery to this machine.
- **`ROS_DOMAIN_ID=0`** (`containerEnv`): only nodes sharing this ID discover each other. Give each
  project/person a unique ID to stay isolated on a shared LAN.

### Quick pub/sub test

In two terminals — same container, two containers, or two machines on the LAN:

```
# A — publisher
ros2 topic pub /chatter std_msgs/msg/String "{data: hello}"

# B — subscriber
ros2 topic echo /chatter
```

`ros2 topic list` and `ros2 node list` should show the other side. Launch another instance as its
own container with the same flags:

```
docker run -it --net=host --ipc=host --pid=host frankjoshua/ros2-face
```

### Robot not showing up?

`SUBNET` discovery uses multicast — reliable on wired LANs, but Wi-Fi networks commonly block it
(unicast like ssh still works, so the robot seems reachable yet `ros2 topic list` shows nothing).
The fix, no changes on the robot:

1. In [`.devcontainer/fastdds_profiles.xml`](.devcontainer/fastdds_profiles.xml), set your robot's IP
   in `initialPeersList` (currently `192.168.2.50` for `tx2.local`). A VPN IP (e.g. the robot's Tailscale
   address) works too and keeps discovery alive off-LAN. Discovery then runs over unicast.
2. If the robot runs many nodes/containers, raise `maxInitialPeersRange` (the file defaults
   to 64) — too low and only the robot's first few nodes are discovered.
3. Restart the face node to reload the profile, then run `ros2 daemon stop` before checking
   `ros2 topic list`. The profile is bind-mounted, so editing it does not require rebuilding.

**The daemon will lie to you.** `ros2 topic list` asks a long-running daemon, and with
`--net=host` *all* containers on the machine share the single daemon — whichever shell spawned it
first, with whatever discovery config that shell had. After any change to profiles, peers, or
`ROS_DOMAIN_ID`, run `ros2 daemon stop` (it respawns on the next command). To bypass it while
debugging, use `ros2 topic list --no-daemon`: if that shows the robot but the plain command
doesn't, a stale daemon is answering.

Alternatively run a Fast DDS Discovery Server and point nodes at it with
`ROS_DISCOVERY_SERVER=<host-ip>:11811`.

## Deploy (build & publish a multi-arch image)

`build.sh` builds the `prod` stage for amd64 + arm64 with `docker buildx`.

Local single-arch build:
```
./build.sh -t frankjoshua/ros2-face -l
```

Multi-arch build and push to Docker Hub:
```
./build.sh -t frankjoshua/ros2-face -p
```

GitHub Actions publishes on every push to `main` (see `.github/workflows/ci.yml`). It expects the
`DOCKERHUB_USERNAME` and `DOCKERHUB_TOKEN` repository secrets. Pull requests run tests and build
the image without logging into Docker Hub or publishing.

Run the published image (host networking is needed because ROS 2 DDS uses ephemeral ports;
`--ipc=host` enables shared-memory transport between containers; `--pid=host` keeps DDS GUIDs unique):
```
docker run -it --network=host --ipc=host --pid=host frankjoshua/ros2-face
```

## Built on the ROS 2 template

This repo was created from [docker-ros2-template](https://github.com/frankjoshua/docker-ros2-template).
Shared dependencies go in the `base` stage of the `Dockerfile`; the image name lives in
`.github/workflows/ci.yml` (`DOCKER_CONTAINER`) and the `build.sh` commands above.

## License

Apache 2.0

## Author

Joshua Frank [@frankjoshua77](https://www.twitter.com/@frankjoshua77) · [roboticsascode.com](http://roboticsascode.com)
