// Expression rig: turns topic inputs into one set of channel values per frame.
//
// Layers, bottom to top:
//   base       /face/expression (a preset) or /face/affect (a blend of presets); last one received wins
//   override   /face/channels: exact values for named channels, replacing the base for those names
//   procedural gaze (+ small saccades), speech mouth, blink; composited every frame
// Base and override changes are eased (slow in / slow out). Channel names follow ARKit:
// "Left" is the face's own left, which appears on the viewer's right.

const GAZE_SPEED = 3;            // gaze units per second; full sweep (-1..1) takes 2/GAZE_SPEED s
const MOUTH_TIMEOUT_MS = 300;    // no /face/mouth sample for this long -> mouth closes
const EXPRESSION_MS = 320;       // ease time for a new expression or channel override
const AFFECT_MS = 160;           // ease time for an affect update (publishers usually stream these)
const BLINK_MS = 160;
const AFFECT_RADIUS = 0.8;       // affect presets further away than this contribute nothing

const clamp = (x, lo = 0, hi = 1) => Math.min(hi, Math.max(lo, x));
const ease = t => (t < 0.5 ? 4 * t * t * t : 1 - (-2 * t + 2) ** 3 / 2);

export function createRig(vocab) {
  const names = vocab.channels;
  const known = new Set(names);

  // A recipe may name a bilateral channel without its side ("mouthSmile"); that sets both sides.
  const expand = recipe => {
    const out = {};
    for (const [n, val] of Object.entries(recipe)) {
      if (known.has(n)) out[n] = val;
      else if (known.has(n + "Left")) { out[n + "Left"] = val; out[n + "Right"] = val; }
    }
    return out;
  };
  const presets = Object.fromEntries(Object.entries(vocab.presets).map(([n, r]) => [n, expand(r)]));
  const zero = () => Object.fromEntries(names.map(n => [n, 0]));

  let base = {}, override = {};
  let from = zero(), to = zero(), shown = zero(), t0 = -1e9, dur = 1;
  let expression = "neutral", changedAt = -1e9;
  let gaze = [0, 0], gazeTarget = [0, 0];
  let mouth = 0, mouthTarget = 0, mouthAt = -1e9;
  let blinkAt = -1e9, nextBlink = 0, saccade = [0, 0], nextSaccade = 0;
  let last = null;

  function retarget(ms, now) {
    from = { ...shown };
    to = { ...zero(), ...base, ...override };
    t0 = now;
    dur = ms;
  }

  return {
    presets: Object.keys(presets),

    expression(name, now = performance.now()) {
      if (!presets[name]) return false;
      base = presets[name];
      expression = name;
      changedAt = now;
      retarget(EXPRESSION_MS, now);
      return true;
    },

    affect(valence, arousal, now = performance.now()) {
      const w = {};
      let sum = 0;
      for (const [n, [x, y]] of Object.entries(vocab.affect)) {
        const wi = Math.max(0, 1 - Math.hypot(valence - x, arousal - y) / AFFECT_RADIUS) ** 2;
        if (wi > 0 && presets[n]) { w[n] = wi; sum += wi; }
      }
      const blend = {};
      for (const [n, wi] of Object.entries(w)) {
        for (const [c, val] of Object.entries(presets[n])) blend[c] = (blend[c] || 0) + (val * wi) / sum;
      }
      base = blend;
      const top = Object.entries(w).sort((a, b) => b[1] - a[1])[0];
      if (top && top[0] !== expression) changedAt = now;
      expression = top ? top[0] : "neutral";
      retarget(AFFECT_MS, now);
    },

    channels(values, now = performance.now()) {
      override = expand(values);
      retarget(EXPRESSION_MS, now);
    },

    gaze(x, y) { gazeTarget = [clamp(x, -1, 1), clamp(y, -1, 1)]; },

    mouth(a, now = performance.now()) { mouthTarget = clamp(a); mouthAt = now; },

    update(now = performance.now()) {
      const dt = last === null ? 0 : Math.min(0.1, (now - last) / 1000);
      last = now;

      const p = ease(clamp((now - t0) / dur));
      for (const n of names) shown[n] = from[n] + (to[n] - from[n]) * p;
      const v = { ...shown };

      // gaze: constant-speed slew, plus a small saccade jitter on the eyes only
      const step = GAZE_SPEED * dt;
      gaze = gaze.map((g, i) => {
        const d = gazeTarget[i] - g;
        return g + (Math.abs(d) <= step ? d : Math.sign(d) * step);
      });
      if (now > nextSaccade) {
        saccade = Math.random() < 0.35 ? [0, 0] : [(Math.random() * 2 - 1) * 0.06, (Math.random() * 2 - 1) * 0.04];
        nextSaccade = now + 600 + Math.random() * 1900;
      }
      const ex = clamp(gaze[0] + saccade[0], -1, 1), ey = clamp(gaze[1] + saccade[1], -1, 1);
      // +x is the viewer's right = the face's left: left eye looks out, right eye looks in.
      const add = (n, val) => { v[n] = clamp(v[n] + val); };
      if (ex > 0) { add("eyeLookOutLeft", ex); add("eyeLookInRight", ex); }
      else { add("eyeLookOutRight", -ex); add("eyeLookInLeft", -ex); }
      if (ey > 0) { add("eyeLookUpLeft", ey); add("eyeLookUpRight", ey); }
      else { add("eyeLookDownLeft", -ey); add("eyeLookDownRight", -ey); }

      // speech: amplitude drives the jaw on top of the expression
      if (now - mouthAt > MOUTH_TIMEOUT_MS) mouthTarget = 0;
      mouth += (mouthTarget - mouth) * Math.min(1, dt * 20);
      v.jawOpen = Math.max(v.jawOpen, 0.85 * mouth);
      v.mouthClose *= 1 - mouth;

      // blink, suppressed while the expression already holds the lids mostly shut
      const heavy = (shown.eyeBlinkLeft + shown.eyeBlinkRight) / 2 >= 0.5;
      if (now > nextBlink) {
        if (!heavy) blinkAt = now;
        nextBlink = now + (Math.random() < 0.15 ? 260 : 3000 + Math.random() * 4000); // sometimes a double blink
      }
      const bt = (now - blinkAt) / BLINK_MS;
      const blink = bt >= 0 && bt <= 1 ? 1 - Math.abs(bt * 2 - 1) : 0;
      v.eyeBlinkLeft = Math.max(v.eyeBlinkLeft, blink);
      v.eyeBlinkRight = Math.max(v.eyeBlinkRight, blink);

      return {
        ch: v,
        gaze: [...gaze],
        speech: mouth,
        blink,
        breath: Math.sin(now / 1000 * Math.PI * 2 / 4.2), // ~4 s idle breathing cycle, the "moving hold"
        expression,
        sinceChange: (now - changedAt) / 1000,
        transition: 1 - p,
      };
    },
  };
}
