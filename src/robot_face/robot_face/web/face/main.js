// Page entry: one rig, one active look, fed by the node's SSE stream (or the demo driver).
// URL options: ?look=<name> picks the starting look; ?demo runs a scripted tour without the node;
// ?controls=off removes the on-screen controls (they otherwise appear on pointer, touch or key input).
import { createRig } from "./rig.js";

const vocab = await (await fetch(new URL("vocabulary.json", import.meta.url))).json();
const params = new URLSearchParams(location.search);
const stage = document.getElementById("stage");
const rig = createRig(vocab);

let look = null, lookName = null, lookToken = 0;

async function setLook(name) {
  if (!vocab.looks.includes(name) || name === lookName) return false;
  lookName = name;
  const token = ++lookToken;
  const { createLook } = await import(`./looks/${name}.js`);
  const next = await createLook(stage, vocab);
  if (token !== lookToken) { next.dispose(); return false; } // a newer request won while this one loaded
  look?.dispose();
  look = next;
  return true;
}

const controls = params.get("controls") === "off" ? null : (await import("./controls.js")).createControls({
  rig, vocab, setLook, currentLook: () => lookName,
});

const apply = {
  expression: v => rig.expression(v),
  gaze: ([x, y]) => (controls ? controls.remoteGaze(x, y) : rig.gaze(x, y)),
  mouth: v => rig.mouth(v),
  affect: ([x, y]) => rig.affect(x, y),
  channels: v => rig.channels(v),
  look: v => setLook(v),
};

window.face = { rig, setLook, vocab, get look() { return lookName; } };

await setLook(vocab.looks.includes(params.get("look")) ? params.get("look") : vocab.looks[0]);

if (params.has("demo")) {
  const { runDemo } = await import("./demo.js");
  runDemo(rig, setLook, vocab, { cycleLooks: params.get("demo") === "looks" });
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
  look?.update(state, now, dt);
  controls?.update(state);
  requestAnimationFrame(frame);
}
requestAnimationFrame(frame);
addEventListener("resize", () => look?.resize());
