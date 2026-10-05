// Scripted stand-in for the ROS topics, for previewing looks without the node (?demo, ?demo=looks).
// It also feeds example diagnostics and a small floor plan so the Diagnostics and Map views have content.
const TOUR = [
  ["neutral", 2.5], ["happy", 3], ["joy", 3], ["surprised", 3], ["afraid", 3], ["angry", 3], ["disgusted", 3],
  ["sad", 3], ["crying", 3.5], ["nervous", 3], ["skeptical", 3], ["contempt", 3], ["smitten", 3.5], ["sleepy", 3.5],
];
const LINE_EVERY = 3; // talk on every third stop

export function runDemo(rig, setLook, vocab, { cycleLooks = false, views = null } = {}) {
  if (views) sampleRobot(views);
  let i = 0, lookIndex = 0;
  const next = () => {
    const [name, seconds] = TOUR[i % TOUR.length];
    rig.expression(name);
    if (i % LINE_EVERY === 1) talk(seconds * 0.6);
    i++;
    if (cycleLooks && i % TOUR.length === 0) setLook(vocab.looks[++lookIndex % vocab.looks.length]);
    setTimeout(next, seconds * 1000);
  };
  next();

  // gaze wanders between a few points of interest
  const glance = () => {
    rig.gaze(Math.random() < 0.3 ? 0 : (Math.random() * 2 - 1) * 0.7, (Math.random() * 2 - 1) * 0.35);
    setTimeout(glance, 1200 + Math.random() * 2200);
  };
  glance();

  // speech: a syllable-ish envelope at 20 Hz, like an audio RMS publisher
  function talk(seconds) {
    const end = performance.now() + seconds * 1000;
    const tick = () => {
      const t = performance.now() / 1000;
      rig.mouth(Math.max(0, Math.sin(t * 9.3) * 0.6 + Math.sin(t * 3.1) * 0.35));
      if (performance.now() < end) setTimeout(tick, 50);
    };
    tick();
  }
}

// A 12 m x 8 m floor plan at 10 cm cells: outer walls, two rooms, a doorway, some unknown space.
function sampleRobot(views) {
  const W = 120, H = 80, cells = new Int8Array(W * H);
  const wall = (x0, y0, x1, y1) => { for (let y = y0; y <= y1; y++) for (let x = x0; x <= x1; x++) cells[y * W + x] = 100; };
  for (let y = 0; y < H; y++) for (let x = 96; x < W; x++) cells[y * W + x] = -1;
  wall(0, 0, 95, 1); wall(0, H - 2, 95, H - 1); wall(0, 0, 1, H - 1); wall(94, 0, 95, H - 1);
  wall(48, 0, 49, 30); wall(48, 44, 49, H - 1); wall(62, 20, 82, 22); wall(20, 50, 28, 58);
  views.map({ resolution: 0.1, width: W, height: H, origin: [0, 0], data: btoa(String.fromCharCode(...new Uint8Array(cells.buffer))) });

  const route = [[1.5, 1.5], [3.5, 3.7], [5.0, 3.7], [7.5, 5.5], [8.5, 6.5]];
  views.goal(route[route.length - 1]);
  views.path(route);
  let t = 0;
  setInterval(() => {
    t = (t + 0.004) % 1;
    const seg = Math.min(route.length - 2, Math.floor(t * (route.length - 1)));
    const u = t * (route.length - 1) - seg, [a, b] = [route[seg], route[seg + 1]];
    views.pose([a[0] + (b[0] - a[0]) * u, a[1] + (b[1] - a[1]) * u, Math.atan2(b[1] - a[1], b[0] - a[0])]);
  }, 100);

  const status = () => {
    const volts = 24.6 - Math.random() * 0.8;
    views.diagnostics([
      { name: "battery", level: volts < 24 ? 1 : 0, message: volts < 24 ? "Low voltage" : "Healthy", hardware_id: "bms", values: [["Voltage", `${volts.toFixed(1)} V`], ["Charge", `${Math.round(60 + (volts - 23.8) * 40)} %`]] },
      { name: "motors", level: 0, message: "Ready", hardware_id: "drive", values: [["Left temp", "41 °C"], ["Right temp", "43 °C"]] },
      { name: "lidar", level: Math.random() < 0.2 ? 1 : 0, message: "Scanning at 10 Hz", hardware_id: "rplidar", values: [["Rate", "10.0 Hz"]] },
      { name: "camera", level: 2, message: "No frames for 5 s", hardware_id: "usb-cam", values: [] },
    ]);
  };
  status();
  setInterval(status, 2000);
}
