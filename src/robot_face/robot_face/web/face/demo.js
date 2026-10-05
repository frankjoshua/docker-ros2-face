// Scripted stand-in for the ROS topics, for previewing looks without the node (?demo, ?demo=looks).
const TOUR = [
  ["neutral", 2.5], ["happy", 3], ["joy", 3], ["surprised", 3], ["afraid", 3], ["angry", 3], ["disgusted", 3],
  ["sad", 3], ["crying", 3.5], ["nervous", 3], ["skeptical", 3], ["contempt", 3], ["smitten", 3.5], ["sleepy", 3.5],
];
const LINE_EVERY = 3; // talk on every third stop

export function runDemo(rig, setLook, vocab, { cycleLooks = false } = {}) {
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
