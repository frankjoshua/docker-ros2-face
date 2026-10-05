// On-screen controls for people playing with the face: look selector, diagnostics/map buttons,
// expression buttons, a mood pad and a talk button. The eyes follow the pointer. The panel shows on
// any pointer, touch or key activity and hides when idle, so a kiosk at rest shows only the face.
// Local input is just another publisher: the newest input wins, and ROS messages still apply.

const HIDE_MS = 4000;          // panel hides after this long without input
const POINTER_GAZE_MS = 2500;  // gaze returns to the ROS target this long after the pointer stops
const clamp = (x, lo, hi) => Math.min(hi, Math.max(lo, x));

export function createControls({ rig, vocab, setLook, currentLook, openView }) {
  const root = document.createElement("div");
  root.id = "controls";
  root.innerHTML = `
    <div class="row">
      <div class="row" role="group" aria-label="Look">${vocab.looks.map(n =>
        `<button class="look" data-look="${n}">${n.replace("_", " ")}</button>`).join("")}
        <button class="open-view" data-view="diagnostics">Diagnostics</button>
        <button class="open-view" data-view="map">Map</button></div>
      <div class="row tools">
        <div class="pad" id="mood" tabindex="0" role="slider" aria-label="Mood: drag for valence and arousal; arrow keys move it"
          aria-valuetext="neutral"><span class="ax">mood</span><i></i></div>
        <button id="talk" aria-pressed="false">Hold to talk</button>
        <label class="follow"><input type="checkbox" id="follow" checked> Eyes follow pointer</label>
      </div>
    </div>
    <div class="row" role="group" aria-label="Expression">${Object.keys(vocab.presets).map(n =>
      `<button class="expr" data-expr="${n}">${n}</button>`).join("")}</div>`;
  document.body.appendChild(root);

  const buttons = sel => [...root.querySelectorAll(sel)];
  const looks = buttons(".look"), exprs = buttons(".expr");
  const pad = root.querySelector("#mood"), dot = pad.querySelector("i");
  const talkBtn = root.querySelector("#talk"), follow = root.querySelector("#follow");

  // visibility
  let hideTimer = 0;
  const show = () => {
    document.body.classList.add("ui");
    clearTimeout(hideTimer);
    hideTimer = setTimeout(() => { if (!root.matches(":hover")) document.body.classList.remove("ui"); }, HIDE_MS);
  };
  root.addEventListener("pointerleave", show);

  // gaze: pointer wins while it moves; ROS gaze takes over again once it stops
  let remote = [0, 0], pointerAt = 0; // pointerAt 0 = the pointer is not steering the gaze
  const gazeFromPointer = e => {
    if (!follow.checked) return;
    pointerAt = performance.now();
    rig.gaze(clamp(e.clientX / innerWidth * 2 - 1, -1, 1), clamp(1 - e.clientY / innerHeight * 2, -1, 1));
  };
  addEventListener("pointermove", e => { show(); gazeFromPointer(e); });
  addEventListener("pointerdown", e => { show(); gazeFromPointer(e); });
  addEventListener("keydown", show);
  const restore = setInterval(() => {
    if (pointerAt && performance.now() - pointerAt > POINTER_GAZE_MS) { rig.gaze(...remote); pointerAt = 0; }
  }, 250);
  follow.addEventListener("change", () => { if (!follow.checked) { rig.gaze(...remote); pointerAt = 0; } });

  root.addEventListener("click", e => {
    const b = e.target.closest("button");
    if (b?.dataset.look) setLook(b.dataset.look);
    if (b?.dataset.expr) rig.expression(b.dataset.expr);
    if (b?.dataset.view) { document.body.classList.remove("ui"); openView(b.dataset.view); }
  });

  // mood pad: valence across, arousal up
  const moodAt = (x, y) => {
    dot.style.left = `${(x + 1) * 50}%`;
    dot.style.top = `${(1 - y) * 50}%`;
    pad.setAttribute("aria-valuetext", `valence ${x.toFixed(1)}, arousal ${y.toFixed(1)}`);
    rig.affect(x, y);
  };
  const moodFromEvent = e => {
    const r = pad.getBoundingClientRect();
    moodAt(clamp((e.clientX - r.left) / r.width * 2 - 1, -1, 1), clamp(1 - (e.clientY - r.top) / r.height * 2, -1, 1));
  };
  let dragging = false;
  pad.addEventListener("pointerdown", e => { dragging = true; pad.setPointerCapture(e.pointerId); moodFromEvent(e); });
  pad.addEventListener("pointermove", e => { if (dragging) moodFromEvent(e); });
  pad.addEventListener("pointerup", () => { dragging = false; });
  pad.addEventListener("keydown", e => {
    const step = { ArrowLeft: [-0.1, 0], ArrowRight: [0.1, 0], ArrowUp: [0, 0.1], ArrowDown: [0, -0.1] }[e.key];
    if (!step) return;
    e.preventDefault();
    const x = parseFloat(dot.style.left || "50") / 50 - 1, y = 1 - parseFloat(dot.style.top || "50") / 50;
    moodAt(clamp(x + step[0], -1, 1), clamp(y + step[1], -1, 1));
  });

  // talk: a syllable-ish envelope at 20 Hz while held, like an audio RMS publisher
  let talkTimer = 0;
  const talk = on => {
    clearInterval(talkTimer);
    talkBtn.setAttribute("aria-pressed", String(on));
    if (on) talkTimer = setInterval(() => {
      const t = performance.now() / 1000;
      rig.mouth(Math.max(0, Math.sin(t * 9.3) * 0.6 + Math.sin(t * 3.1) * 0.35));
    }, 50);
  };
  talkBtn.addEventListener("pointerdown", () => talk(true));
  for (const ev of ["pointerup", "pointerleave", "pointercancel"]) talkBtn.addEventListener(ev, () => talk(false));
  talkBtn.addEventListener("keydown", e => { if ((e.key === " " || e.key === "Enter") && !e.repeat) talk(true); });
  talkBtn.addEventListener("keyup", e => { if (e.key === " " || e.key === "Enter") talk(false); });

  let shownLook = null, shownExpr = null;
  return {
    remoteGaze(x, y) {
      remote = [x, y];
      if (!pointerAt) rig.gaze(x, y);
    },
    update(state) {
      const lk = currentLook();
      if (lk !== shownLook) { shownLook = lk; for (const b of looks) b.setAttribute("aria-pressed", String(b.dataset.look === lk)); }
      if (state.expression !== shownExpr) { shownExpr = state.expression; for (const b of exprs) b.setAttribute("aria-pressed", String(b.dataset.expr === shownExpr)); }
    },
    dispose() { clearInterval(restore); clearInterval(talkTimer); clearTimeout(hideTimer); root.remove(); },
  };
}
