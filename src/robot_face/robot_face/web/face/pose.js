// Channel values -> face geometry, independent of any look.
// Face space is 400 x 290, centre (200, 160), y down. Looks scale it to their own canvas or mesh.
// Every look reads the same pose, so a new preset or channel never needs per-look art.

const clamp = (x, lo = 0, hi = 1) => Math.min(hi, Math.max(lo, x));
const lerp = (a, b, t) => a + (b - a) * t;
const f = n => Math.round(n * 10) / 10;

export const FACE_W = 400, FACE_H = 290, FACE_CX = 200, FACE_CY = 160;

// Quadratic lid curve whose control sits at the eye centre, so x is linear in t.
export function quadAt(x0, y0, cx, cy, x1, y1, x) {
  const t = clamp((x - x0) / (x1 - x0));
  return (1 - t) * (1 - t) * y0 + 2 * t * (1 - t) * cy + t * t * y1;
}

export function cubicAt([p0, p1, p2, p3], t) {
  const u = 1 - t;
  return [
    u * u * u * p0[0] + 3 * u * u * t * p1[0] + 3 * u * t * t * p2[0] + t * t * t * p3[0],
    u * u * u * p0[1] + 3 * u * u * t * p1[1] + 3 * u * t * t * p2[1] + t * t * t * p3[1],
  ];
}

// A mouth edge runs corner -> centre -> corner as two cubics; t in 0..1 spans both.
export function edgeAt(edge, t) {
  return t < 0.5 ? cubicAt(edge[0], t * 2) : cubicAt(edge[1], t * 2 - 1);
}

const cubicPath = (edge, move = true) =>
  (move ? `M${f(edge[0][0][0])},${f(edge[0][0][1])} ` : "") +
  edge.map(([, a, b, c]) => `C${f(a[0])},${f(a[1])} ${f(b[0])},${f(b[1])} ${f(c[0])},${f(c[1])}`).join(" ");
const reverseEdge = edge => edge.slice().reverse().map(c => c.slice().reverse());

export function facePose(v) {
  const g = n => clamp(v[n] || 0);
  const fx = {
    pupilDilate: g("pupilDilate"), blush: g("blush"), tears: g("tears"), sweat: g("sweat"),
    sparkle: g("sparkle"), squash: g("squash"), stretch: g("stretch"),
  };

  const eyes = [], brows = [], cheeks = [], wrinkles = [];
  for (const s of ["Right", "Left"]) {
    const d = s === "Left" ? 1 : -1, cx = FACE_CX + 72 * d, cy = 118;
    const blink = g("eyeBlink" + s), sq = g("eyeSquint" + s), wide = g("eyeWide" + s), ck = g("cheekSquint" + s);
    const bd = g("browDown" + s), bi = g("browInnerUp"), bo = g("browOuterUp" + s);
    const rx = 32 * (1 + 0.06 * wide), ry = 38 * (1 + 0.22 * wide);
    const inX = cx - 54 * d, outX = cx + 54 * d;

    // Couplings: brow pose tilts the upper lid (angry and sad shapes); cheek raise lifts the lower lid.
    const sad = bi * (1 - bo);
    let uIn = cy - ry - 6 + 34 * bd - 2 * sad, uOut = cy - ry - 6 + 6 * bd + 30 * sad, uC = cy - ry - 10 + 16 * bd + 10 * sad;
    const lift = clamp(0.8 * sq + 0.6 * ck, 0, 1.1);
    const rise = blink * clamp(1 - lift) * ry * 0.7; // a blink lifts the lower lid too, so the closed line sits inside the eye
    const lE = cy + ry + 6 - lift * (ry + 4) - rise, lC = cy + ry + 12 - lift * (ry * 1.75) - rise;
    uIn = lerp(uIn, lE, blink); uOut = lerp(uOut, lE, blink); uC = lerp(uC, lC, blink);

    const lo = g("eyeLookOut" + s), li = g("eyeLookIn" + s), lu = g("eyeLookUp" + s), ldn = g("eyeLookDown" + s);
    const px = cx + 16 * d * (lo - li), py = cy + 2 + 16 * (ldn - lu);
    const pr = 14 * (1 + 0.5 * fx.pupilDilate - 0.35 * wide);

    // closed-eye line: the part of the lower-lid curve spanning the eye's width
    const t0 = (54 - 0.92 * rx) / 108, e = lE + 2 * t0 * (1 - t0) * (lC - lE), c = 2 * (lE + 0.5 * (lC - lE)) - e;

    eyes.push({
      side: s, d, cx, cy, rx, ry, inX, outX, uIn, uOut, uC, lE, lC, blink, lift, wide, px, py, pr,
      top: x => quadAt(inX, uIn, cx, uC, outX, uOut, x),
      bottom: x => quadAt(inX, lE, cx, lC, outX, lE, x),
      lidPath: `M${f(inX)},${f(uIn)} Q${cx},${f(uC)} ${f(outX)},${f(uOut)} L${f(outX)},${f(lE)} Q${cx},${f(lC)} ${f(inX)},${f(lE)}Z`,
      closedPath: `M${f(cx - 0.92 * rx)},${f(e)} Q${cx},${f(c)} ${f(cx + 0.92 * rx)},${f(e)}`,
    });

    const by = cy - 64;
    const bInX = cx - 30 * d - 6 * d * bd, bOutX = cx + 36 * d;
    const bInY = by - 26 * bi + 20 * bd, bOutY = by - 24 * bo + 4 * bd + 4 * sad;
    const bMidX = cx + 2 * d, bMid = (bInY + bOutY) / 2 - 8 - 4 * bo + 3 * bd;
    brows.push({
      side: s, inX: bInX, inY: bInY, midX: bMidX, midY: bMid, outX: bOutX, outY: bOutY,
      at: t => [
        (1 - t) * (1 - t) * bInX + 2 * t * (1 - t) * bMidX + t * t * bOutX,
        (1 - t) * (1 - t) * bInY + 2 * t * (1 - t) * bMid + t * t * bOutY,
      ],
      path: `M${f(bInX)},${f(bInY)} Q${f(bMidX)},${f(bMid)} ${f(bOutX)},${f(bOutY)}`,
    });

    const puff = g("cheekPuff");
    cheeks.push({
      side: s, cx: cx + 6 * d, cy: cy + 66 - 10 * ck, rx: 22 * (1 + 0.45 * puff), ry: 10 * (1 + 0.7 * puff),
      alpha: clamp(0.1 + 0.3 * ck + 0.3 * puff + 0.7 * fx.blush, 0, 0.85),
    });

    const sn = g("noseSneer" + s);
    if (sn > 0) wrinkles.push({ path: `M${FACE_CX + 8 * d},${f(156 - 6 * sn)} l${10 * d},-5 M${FACE_CX + 8 * d},${f(146 - 6 * sn)} l${9 * d},-4`, alpha: sn });
  }

  const sn = (g("noseSneerLeft") + g("noseSneerRight")) / 2;
  const ny = 172 - 7 * sn, nTilt = 4 * (g("noseSneerLeft") - g("noseSneerRight"));
  const nose = { y: ny, path: `M190,${f(ny - nTilt)} Q200,${f(ny + 8)} 210,${f(ny + nTilt)}`, wrinkles };

  // mouth
  const sh = 26 * (g("mouthLeft") - g("mouthRight"));
  const jawShift = 14 * (g("jawLeft") - g("jawRight"));
  const jaw = g("jawOpen"), close = g("mouthClose"), fun = g("mouthFunnel"), puc = g("mouthPucker"), puff = g("cheekPuff"), to = g("tongueOut");
  const mx = FACE_CX + sh, my = 214;
  const corner = s => {
    const d = s === "Left" ? 1 : -1;
    const sm = g("mouthSmile" + s), fr = g("mouthFrown" + s), st = g("mouthStretch" + s), dm = g("mouthDimple" + s), pr = g("mouthPress" + s);
    const half = Math.max(8, 48 + 10 * sm + 18 * st + 6 * dm - 30 * puc - 26 * fun - 6 * pr - 8 * puff - 8 * jaw);
    return { d, sm, dm, pr, x: mx + d * half + jawShift * 0.4, y: my - 26 * sm + 24 * fr + 6 * st - 4 * dm + 8 * jaw * (1 - sm) };
  };
  const R = corner("Right"), L = corner("Left");
  const uuR = g("mouthUpperUpRight"), uuL = g("mouthUpperUpLeft"), ldR = g("mouthLowerDownRight"), ldL = g("mouthLowerDownLeft");
  const uu = (uuR + uuL) / 2, ld = (ldR + ldL) / 2;
  const gap = 54 * jaw * (1 - close) + 26 * fun * (1 - puc) + 10 * to;
  const uY = my - 12 * uu - 6 * g("mouthShrugUpper") + 4 * g("mouthRollUpper") - gap * 0.12;
  const lY = Math.max(uY, my + gap * 0.88 + 16 * ld - 8 * g("mouthShrugLower") - 4 * g("mouthRollLower"));
  const k1 = 0.22 * (1 - fun), k2 = 0.62 + 0.38 * fun;
  // corner a -> centre (xc, yc) -> corner b; ea/eb lift one half for one-sided lip raises
  const edge = (yc, xc, a, b, ea, eb) => [
    [[a.x, a.y], [a.x + (xc - a.x) * k1, a.y + (yc - a.y) * k2 + ea], [xc - (xc - a.x) * 0.5, yc], [xc, yc]],
    [[xc, yc], [xc + (b.x - xc) * 0.5, yc], [b.x - (b.x - xc) * k1, b.y + (yc - b.y) * k2 + eb], [b.x, b.y]],
  ];
  const upper = edge(uY, mx, R, L, -14 * (uuR - uu), -14 * (uuL - uu));
  const lower = edge(lY, mx + jawShift, R, L, 14 * (ldR - ld), 14 * (ldL - ld));
  const smile = (R.sm + L.sm) / 2;
  const open = lY - uY >= 1.5;
  const marks = [];
  for (const c of [R, L]) {
    if (c.dm > 0) marks.push({ path: `M${f(c.x + 9 * c.d)},${f(c.y - 7)} q${5 * c.d},7 0,14`, alpha: c.dm });
    if (c.pr > 0) marks.push({ path: `M${f(c.x + 7 * c.d)},${f(c.y - 8)} v16`, alpha: c.pr });
  }
  if (puc > 0) marks.push({ path: `M${f(R.x - 7)},${f(R.y - 9)} q-5,9 0,18 M${f(L.x + 7)},${f(L.y - 9)} q5,9 0,18`, alpha: puc });
  const ru = g("mouthRollUpper"), rl = g("mouthRollLower"), sl = g("mouthShrugLower"), su = g("mouthShrugUpper");
  if (ru > 0) marks.push({ path: `M${f(mx - 16)},${f(uY - 10)} h32`, alpha: ru });
  if (rl > 0) marks.push({ path: `M${f(mx - 16)},${f(lY + 10)} h32`, alpha: rl });
  if (sl > 0) marks.push({ path: `M${f(mx - 13)},${f(lY + 22)} q13,7 26,0`, alpha: sl });
  if (su > 0) marks.push({ path: `M${f(mx - 10)},${f(uY - 11)} q10,-6 20,0`, alpha: su });

  const mouth = {
    R, L, mx, my, uY, lY, gap, jaw, jawShift, smile, open, upper, lower, uu, ld, pucker: puc, funnel: fun,
    width: 6 + 2 * (R.pr + L.pr) + 4 * puc + ru + rl,
    linePath: cubicPath(upper),
    openPath: cubicPath(upper) + " " + cubicPath(reverseEdge(lower), false) + "Z",
    upperTeeth: open ? clamp(uu * 1.4 + (smile > 0.4 && lY - uY > 8 ? 0.5 : 0)) : 0,
    lowerTeeth: open && ld > 0.1 ? ld : 0,
    innerTongue: lY - uY > 16,
    tongueOut: to,
    marks,
  };

  const jf = g("jawForward"), cw = 30 * (1 + 0.35 * jf);
  const chin = {
    path: `M${f(mx + jawShift - cw)},${f(262 + 16 * jaw + 3 * jf)} q${f(cw)},${f(12 + 5 * jf)} ${f(2 * cw)},0`,
    alpha: 0.22 + 0.6 * Math.max(jf, Math.abs(jawShift) / 14), width: 4 + 2 * jf,
  };

  const tears = fx.tears > 0 ? eyes.map(e => {
    const x = e.cx + 14 * e.d, y0 = e.cy + e.ry - 8, len = 12 + 46 * fx.tears;
    return { x, y0, len, alpha: 0.4 + 0.6 * fx.tears, path: drop(x, y0, len) };
  }) : [];
  const sweat = fx.sweat > 0 ? { x: 332, y0: 34, len: 18 + 18 * fx.sweat, alpha: fx.sweat, path: drop(332, 34, 18 + 18 * fx.sweat) } : null;
  const sparkles = fx.sparkle > 0 ? eyes.map(e => ({ x: e.cx + 34 * e.d, y: e.cy - 30, s: fx.sparkle })) : [];

  return {
    v, fx, eyes, brows, cheeks, nose, mouth, chin, tears, sweat, sparkles,
    scale: [1 + 0.08 * fx.squash - 0.06 * fx.stretch, 1 - 0.1 * fx.squash + 0.1 * fx.stretch],
  };
}

function drop(x, y0, len) {
  return `M${f(x)},${f(y0)} C${f(x + 9)},${f(y0 + len * 0.55)} ${f(x + 9)},${f(y0 + len)} ${f(x)},${f(y0 + len)} ` +
    `C${f(x - 9)},${f(y0 + len)} ${f(x - 9)},${f(y0 + len * 0.55)} ${f(x)},${f(y0)}Z`;
}

export const STAR_PATH = "M0,-10 L2.5,-2.5 10,0 2.5,2.5 0,10 -2.5,2.5 -10,0 -2.5,-2.5Z";
