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
Point any kiosk browser at it (`chromium --kiosk http://localhost:8080/`). Tap the face to open
diagnostics, then **MAP** to view `/map` and the robot's TF pose. Tapping inside the map publishes
a `geometry_msgs/PoseStamped` navigation goal; taps in the surrounding margins are ignored.
Map origins are currently assumed to have zero yaw.
The robot is a magenta heading arrow, the latest goal is a yellow target, and the planned
path is green. Goals from map taps and the `goal_topic` subscription are shared with all
browsers. The path comes from `nav_msgs/Path` on `path_topic`; an empty path clears the line.
Goals and paths in other coordinate frames are transformed into `map_frame` using TF.
The display retains the latest goal and path; it does not track navigation completion.

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

Parameters: `port` (default 8080), `map_frame` (`map`), `base_frame` (`base_link`), and
`goal_topic` (`goal_pose`), and `path_topic` (`plan`). For a different planner topic, pass
`--ros-args -p path_topic:=/your/path/topic`. Gaze slew speed is `GAZE_SPEED` at the top of the script in
`src/robot_face/robot_face/index.html`.

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
