// Page entry: one rig, one active look, the diagnostics/map views, fed by the node's SSE stream
// (or the demo driver). URL options: ?look=<name> picks the starting look; ?demo runs a scripted
// tour without the node; ?controls=off removes the on-screen controls (tapping the face then opens
// diagnostics directly).
import { createRig } from "./rig.js";
import { createViews } from "./views.js";

const vocab = await (await fetch(new URL("vocabulary.json", import.meta.url))).json();
const params = new URLSearchParams(location.search);
const stage = document.getElementById("stage");
const rig = createRig(vocab);
const views = createViews({});

let look = null, lookName = null, lookToken = 0;

async function setLook(name) {
  if (!vocab.looks.includes(name) || name === lookName) return false;
  lookName = name;
  // The theme follows the selection even if the look itself fails to start (no WebGL).
  document.documentElement.dataset.look = name;
  views.retheme();
  const token = ++lookToken;
  let next;
  try {
    next = await (await import(`./looks/${name}.js`)).createLook(stage, vocab);
  } catch (err) {
    console.error(`look ${name} failed to start`, err);
    if (token === lookToken) { look?.dispose(); look = null; }
    return false;
  }
  if (token !== lookToken) { next.dispose(); return false; } // a newer request won while this one loaded
  look?.dispose();
  look = next;
  return true;
}

const controls = params.get("controls") === "off" ? null : (await import("./controls.js")).createControls({
  rig, vocab, setLook, currentLook: () => lookName, openView: v => views.open(v),
});
if (!controls) stage.addEventListener("click", () => views.open("diagnostics"));

const apply = {
  expression: v => rig.expression(v),
  gaze: ([x, y]) => (controls ? controls.remoteGaze(x, y) : rig.gaze(x, y)),
  mouth: v => rig.mouth(v),
  affect: ([x, y]) => rig.affect(x, y),
  channels: v => rig.channels(v),
  look: v => setLook(v),
  diagnostics: v => views.diagnostics(v),
  map: v => views.map(v),
  pose: v => views.pose(v),
  goal: v => views.goal(v),
  path: v => views.path(v),
};

window.face = { rig, setLook, vocab, views, get look() { return lookName; } };

await setLook(vocab.looks.includes(params.get("look")) ? params.get("look") : vocab.looks[0]);

if (params.has("demo")) {
  const { runDemo } = await import("./demo.js");
  runDemo(rig, setLook, vocab, { cycleLooks: params.get("demo") === "looks", views });
} else {
  // Replay on connect arrives in the order the values were last set, so the newest base layer wins.
  const es = new EventSource("/events");
  es.onmessage = e => {
    for (const [key, value] of Object.entries(JSON.parse(e.data))) apply[key]?.(value);
  };
}

let last = performance.now();
function frame(now) {
  const dt = Math.min(0.1, (now - last) / 1000);
  last = now;
  const state = rig.update(now);
  if (!views.covering) look?.update(state, now, dt); // the map is opaque; skip GPU work behind it
  controls?.update(state);
  requestAnimationFrame(frame);
}
requestAnimationFrame(frame);
addEventListener("resize", () => { look?.resize(); views.resize(); });
