// Murmuration: a flock of glowing particles holds the face. Every particle has a fixed role and fixed
// random parameters; its target is recomputed from the pose each frame and it springs toward it, so an
// expression change reads as the flock re-forming rather than as re-sampled pixels.
import * as THREE from "three";
import { facePose, FACE_CX } from "../pose.js";

// ---- performance knobs ----
const PARTICLE_SCALE = 1;      // multiplies every role's count; 1 ≈ 39k particles
const PIXEL_RATIO_CAP = 1.5;
const MAX_STEP = 1 / 60;       // physics sub-step: keeps the stiff eye springs stable when frames run long

// ---- look ----
const EYE_SCALE = 1.25;        // eyes (and brow spacing) grow about each eye centre, nearer the board's proportions
const PUPIL_K = 1.5;           // dark disk radius / pose pupil radius: the board's pupils are mostly black iris
const BROW_LIFT = 9.5;         // keeps brows clear of the enlarged eyes
const EYE_POP = 10, BULGE = 14, LID_BAND = 3.5;
const HEAD = { cy: 150, a: 205, b: 158, c: 120 }; // ellipsoid semi-axes in face units; cy is in pose y
const FOV = 30;
const TEAR_RATE = 0.55, SWEAT_RATE = 0.3;          // stream cycles per second
const RAMP_T = 0.7;            // after an expression change springs ramp from slack to full over this long
const BURST = 140;             // scatter impulse at an expression change, face units / s

const COUNT = {
  shell: 12000, interior: 3000, dust: 2500, bokeh: 140,
  white: 4600, rim: 700, lid: 500, socket: 1400, highlight: 260,
  brow: 600, lip: 1600, fill: 900, teeth: 250, tongue: 300, accent: 120,
  blush: 400, tear: 450, sweat: 350, sparkle: 220,
};

const TEAL = [0.12, 0.85, 0.78], VIOLET = [0.52, 0.34, 1], BLUE = [0.3, 0.42, 1], CREAM = [1, 0.86, 0.7];
const WHITE = [1, 1, 1], LAVENDER = [0.8, 0.68, 1], PINK = [1, 0.36, 0.62], WATER = [0.55, 0.86, 1];
const STAR = [0, -10, 2.5, -2.5, 10, 0, 2.5, 2.5, 0, 10, -2.5, 2.5, -10, 0, -2.5, -2.5];

const G = {
  shell: 0, interior: 1, dust: 2, bokeh: 3, eye: 4, hi: 6, brow: 8, mouth: 9, teethU: 10, teethL: 11,
  tongue: 12, blush: 13, tear: 15, sweat: 17, sparkle: 18, accent: 20,
}; // per-side groups take two slots: base + side (0 = Right, 1 = Left)
const NG = 22;

const MS = 48;                 // mouth edge samples
const KE = 20;                 // eye occluder columns

const TAB = 4096, TMASK = TAB - 1, TK = TAB / (2 * Math.PI);
const SIN = new Float32Array(TAB);
for (let i = 0; i < TAB; i++) SIN[i] = Math.sin((i / TAB) * 2 * Math.PI);

const clamp = (x, lo = 0, hi = 1) => (x < lo ? lo : x > hi ? hi : x);
const smooth = (a, b, x) => { const t = clamp((x - a) / (b - a)); return t * t * (3 - 2 * t); };
const zs = (X, Y) => { const q = 1 - (X / HEAD.a) ** 2 - (Y / HEAD.b) ** 2; return q > 0 ? HEAD.c * Math.sqrt(q) : 0; };

const VERT = /* glsl */ `
uniform float uGroup[${NG}];
uniform float uTime;
uniform float uPx;
attribute vec3 aColor;
attribute float aSize;
attribute vec3 aMeta;   // group, seed, mode (0 dot, 1 bokeh disk, >=2 stream with rate = mode - 2)
attribute float aAmp;
varying vec3 vColor;
varying float vDisk;
void main() {
  float g = uGroup[int(aMeta.x + 0.5)] * aAmp;
  float tw = 0.78 + 0.22 * sin(uTime * (1.3 + 2.7 * aMeta.y) + aMeta.y * 61.0);
  if (aMeta.z > 1.5) tw *= sin(3.14159 * fract(uTime * (aMeta.z - 2.0) + aMeta.y));
  vColor = aColor * g * tw;
  vDisk = aMeta.z > 0.5 && aMeta.z < 1.5 ? 1.0 : 0.0;
  vec4 mv = modelViewMatrix * vec4(position, 1.0);
  gl_Position = projectionMatrix * mv;
  gl_PointSize = g > 0.003 ? max(1.0, aSize * uPx / -mv.z) : 0.0;
}`;

const FRAG = /* glsl */ `
varying vec3 vColor;
varying float vDisk;
void main() {
  vec2 c = gl_PointCoord * 2.0 - 1.0;
  float d2 = dot(c, c);
  if (d2 > 1.0) discard;
  float a = mix(exp(-d2 * 4.0), smoothstep(1.0, 0.6, d2) * (0.7 + 0.3 * d2), vDisk);
  gl_FragColor = vec4(vColor * a, 1.0);
}`;

function mulberry32(a) {
  return () => {
    a |= 0; a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export async function createLook(container) {
  const rand = mulberry32(0x5eed);
  const gauss = () => (rand() + rand() + rand() + rand() - 2) * 1.732;

  // ---- layout: contiguous index ranges per role (eye whites + rims first: they own the dynamic amp range)
  const RG = {};
  let N = 0;
  const take = (key, count) => (RG[key] = [N, (N += Math.max(1, Math.round(count * PARTICLE_SCALE)))]);
  for (const s of [0, 1]) take("white" + s, COUNT.white);
  for (const s of [0, 1]) take("rim" + s, COUNT.rim);
  const AMP_END = N;
  for (const s of [0, 1]) {
    take("lid" + s, COUNT.lid); take("socket" + s, COUNT.socket); take("hi" + s, COUNT.highlight);
    take("brow" + s, COUNT.brow); take("accent" + s, COUNT.accent); take("blush" + s, COUNT.blush);
    take("tear" + s, COUNT.tear); take("sparkle" + s, COUNT.sparkle);
  }
  take("lip", COUNT.lip); take("fill", COUNT.fill); take("teethU", COUNT.teeth); take("teethL", COUNT.teeth);
  take("tongue", COUNT.tongue); take("sweat", COUNT.sweat);
  take("shell", COUNT.shell); take("interior", COUNT.interior); take("dust", COUNT.dust);
  RG.bokeh = [N, (N += COUNT.bokeh)];

  const pos = new Float32Array(3 * N), vel = new Float32Array(3 * N), tgt = new Float32Array(3 * N);
  const color = new Float32Array(3 * N), size = new Float32Array(N), meta = new Float32Array(3 * N);
  const amp = new Float32Array(N).fill(1);
  const p0 = new Float32Array(N), p1 = new Float32Array(N), p2 = new Float32Array(N), p3 = new Float32Array(N);
  const kS = new Float32Array(N), zeta = new Float32Array(N), flowD = new Float32Array(N), delay = new Float32Array(N);
  const free = new Uint8Array(N);

  const spawn = (i, col, br, sz, group, k, z, D, mode = 0) => {
    color[3 * i] = col[0] * br; color[3 * i + 1] = col[1] * br; color[3 * i + 2] = col[2] * br;
    size[i] = sz; meta[3 * i] = group; meta[3 * i + 1] = rand(); meta[3 * i + 2] = mode;
    kS[i] = k; zeta[i] = z; flowD[i] = D; delay[i] = 0.05 + 0.32 * rand();
    pos[3 * i] = (rand() - 0.5) * 1400; pos[3 * i + 1] = (rand() - 0.5) * 900; pos[3 * i + 2] = (rand() - 0.5) * 700;
  };
  const mix = (a, b, t) => [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t];
  const each = (key, fn) => { for (let i = RG[key][0]; i < RG[key][1]; i++) fn(i); };
  const halo = (i, chance, grow, dim) => { if (rand() < chance) { size[i] *= grow; for (let c = 0; c < 3; c++) color[3 * i + c] *= dim; } };

  // ---- head
  each("shell", i => {
    const uz = 2 * rand() - 1, ph = 2 * Math.PI * rand(), r0 = Math.sqrt(1 - uz * uz);
    const ux = r0 * Math.cos(ph), uy = r0 * Math.sin(ph), limb = 1 - Math.abs(uz);
    let rr = 1 + gauss() * 0.05;
    if (rand() < 0.14) rr = 1.04 + rand() ** 2 * 0.4 * (0.3 + 0.7 * limb);
    p0[i] = ux * rr; p1[i] = uy * rr; p2[i] = uz * rr;
    const tm = smooth(0.3, 0.95, limb) * (0.45 + 0.55 * clamp(0.55 - 0.45 * ux + 0.35 * uy));
    let col = mix(mix(VIOLET, BLUE, rand() * 0.5), TEAL, tm), br = (0.3 + 0.85 * limb ** 1.5) * (uz < 0 ? 0.6 : 1), sz = 2 + 2 * rand();
    if (rand() < 0.06) { col = WHITE; br = 0.9; sz *= 1.4; }
    spawn(i, col, br, sz, G.shell, 8 + 22 * rand(), 0.45, 7);
  });
  each("interior", i => {
    const uz = 2 * rand() - 1, ph = 2 * Math.PI * rand(), r0 = Math.sqrt(1 - uz * uz), r = Math.cbrt(rand()) * 0.93;
    p0[i] = r0 * Math.cos(ph) * r; p1[i] = r0 * Math.sin(ph) * r; p2[i] = uz * r;
    spawn(i, mix(VIOLET, BLUE, rand()), 0.22 + 0.2 * rand(), 2 + rand(), G.interior, 5 + 10 * rand(), 0.5, 12);
  });
  const ambient = (i, zLo, zHi) => {
    let x, y, z;
    do {
      x = (rand() * 2 - 1) * HEAD.a * 2.6; y = (rand() * 2 - 1) * HEAD.b * 1.9; z = zLo + (zHi - zLo) * rand();
    } while ((x / HEAD.a) ** 2 + (y / HEAD.b) ** 2 + (z / HEAD.c) ** 2 < 1.3);
    p0[i] = x; p1[i] = y; p2[i] = z;
  };
  const AMBIENT_COLS = [TEAL, VIOLET, BLUE, WHITE, LAVENDER, [0.85, 0.5, 0.95]];
  each("dust", i => {
    ambient(i, -350, 150);
    spawn(i, AMBIENT_COLS[(rand() * 6) | 0], 0.3 + 0.9 * rand() ** 2, 1.6 + 3 * rand() ** 2, G.dust, 1.5 + 2.5 * rand(), 0.4, 30);
  });
  each("bokeh", i => {
    ambient(i, -500, 260);
    spawn(i, AMBIENT_COLS[(rand() * 6) | 0], 0.1 + 0.2 * rand(), 10 + 30 * rand(), G.bokeh, 0.6 + 0.6 * rand(), 0.4, 50, 1);
  });

  // ---- eyes
  for (const s of [0, 1]) {
    each("white" + s, i => {
      const th = 2 * Math.PI * rand();
      const sv = rand() < 0.2 ? 0.07 * rand() : 0.07 + 0.93 * rand() ** 0.85;
      p0[i] = Math.cos(th); p1[i] = Math.sin(th); p2[i] = sv; p3[i] = rand();
      let col, br;
      if (sv < 0.07) { col = mix(VIOLET, BLUE, rand() * 0.5); br = 0.95; }
      else if (sv > 0.86) { col = VIOLET; br = 0.7; }
      else { col = mix(CREAM, VIOLET, 0.7 * smooth(0.22, 0.07, sv) + 0.15 * rand() + 0.55 * smooth(0.6, 0.86, sv)); br = 0.5; }
      spawn(i, col, br, 3 + 2 * rand(), G.eye + s, 350 + 550 * rand(), 0.75, 1.2);
      halo(i, 0.1, 5, 0.1);
    });
    each("rim" + s, i => {
      const ph = 2 * Math.PI * rand();
      p0[i] = Math.cos(ph); p1[i] = Math.sin(ph); p2[i] = rand(); p3[i] = rand();
      spawn(i, mix(VIOLET, LAVENDER, rand() * 0.5), 0.8, 2 + 1.4 * rand(), G.eye + s, 300 + 500 * rand(), 0.75, 1.2);
    });
    each("lid" + s, i => {
      p0[i] = -0.95 + 1.9 * rand(); p1[i] = rand();
      spawn(i, LAVENDER, 0.7, 2 + 1.4 * rand(), G.eye + s, 300 + 500 * rand(), 0.75, 1);
    });
    each("socket" + s, i => {
      const ph = 2 * Math.PI * rand(), rho = 1.03 + 0.55 * rand() ** 1.6;
      p0[i] = Math.cos(ph) * rho; p1[i] = Math.sin(ph) * rho;
      spawn(i, mix(VIOLET, BLUE, rand()), 0.1 + 0.6 * (1.6 - rho) / 0.6, 2.4 + 2 * rand(), G.eye + s, 60 + 120 * rand(), 0.6, 4);
    });
    each("hi" + s, i => {
      p0[i] = clamp(gauss() * 0.4, -1, 1); p1[i] = clamp(gauss() * 0.4, -1, 1); p2[i] = rand() < 0.8 ? 0 : 1;
      spawn(i, WHITE, 1.5, 2.4 + rand(), G.hi + s, 400 + 500 * rand(), 0.8, 0.3);
      halo(i, 0.12, 5, 0.15);
    });
    each("brow" + s, i => {
      p0[i] = rand(); p1[i] = clamp(gauss() * 0.45, -1, 1);
      spawn(i, rand() < 0.12 ? TEAL : mix(LAVENDER, VIOLET, rand()), 0.42, 2.4 + 1.8 * rand(), G.brow, 150 + 250 * rand(), 0.7, 2.5);
    });
    each("accent" + s, i => {
      p0[i] = rand(); p1[i] = gauss();
      spawn(i, LAVENDER, 0.8, 2 + 1.2 * rand(), G.accent + s, 200 + 300 * rand(), 0.7, 1);
    });
    each("blush" + s, i => {
      p0[i] = clamp(gauss() * 0.5, -1.4, 1.4); p1[i] = clamp(gauss() * 0.5, -1.4, 1.4);
      spawn(i, PINK, 0.45, 2.2 + 1.8 * rand(), G.blush + s, 30 + 60 * rand(), 0.6, 3);
      halo(i, 0.15, 3.5, 0.25);
    });
    each("tear" + s, i => {
      const stream = rand() < 0.65;
      p0[i] = rand(); p1[i] = stream ? gauss() : rand() < 0.5 ? Math.sign(rand() - 0.5) : rand() * 2 - 1; p2[i] = stream ? 1 : 0;
      spawn(i, WATER, stream ? 0.9 : 1.2, 2 + 1.4 * rand(), G.tear + s, 250 + 300 * rand(), 0.7, 1, stream ? 2 + TEAR_RATE : 0);
      free[i] = stream ? 1 : 0;
    });
    each("sparkle" + s, i => {
      const edge = rand() < 0.75;
      p0[i] = edge ? 8 * rand() : -1; p1[i] = gauss() * (edge ? 0.3 : 0.35); p2[i] = gauss() * 0.35;
      spawn(i, WHITE, edge ? 1.2 : 0.8, edge ? 2 + rand() : 2 + 3 * rand(), G.sparkle + s, 200 + 300 * rand(), 0.7, 0.5);
      if (!edge) halo(i, 0.3, 3, 0.3);
    });
  }

  // ---- mouth
  each("lip", i => {
    const x = 2 * rand() - 1, w = rand() ** 1.4;
    p0[i] = 0.5 + 0.5 * Math.sign(x) * Math.abs(x) ** 1.25; p1[i] = rand() < 0.5 ? 0 : 1; p2[i] = w;
    spawn(i, w < 0.35 ? mix(CREAM, WHITE, rand()) : mix(LAVENDER, VIOLET, rand()), w < 0.35 ? 0.9 : 0.6, 2 + 1.2 * rand(), G.mouth, 250 + 400 * rand(), 0.7, 1.4);
    halo(i, 0.08, 6, 0.1);
  });
  each("fill", i => {
    p0[i] = 0.04 + 0.92 * rand(); p1[i] = rand();
    spawn(i, mix(VIOLET, BLUE, rand()), 0.35, 2 + 1.2 * rand(), G.mouth, 120 + 200 * rand(), 0.6, 5);
  });
  for (const key of ["teethU", "teethL"]) each(key, i => {
    p0[i] = 0.2 + 0.6 * rand(); p1[i] = rand();
    spawn(i, WHITE, 0.7, 2 + 1 * rand(), G[key], 250 + 300 * rand(), 0.7, 1);
  });
  each("tongue", i => {
    p0[i] = clamp(gauss() * 0.45, -1, 1); p1[i] = clamp(gauss() * 0.45, -1, 1);
    spawn(i, PINK, 0.7, 2 + 1.2 * rand(), G.tongue, 200 + 300 * rand(), 0.7, 1.5);
  });
  each("sweat", i => {
    const stream = rand() < 0.35;
    p0[i] = rand(); p1[i] = stream ? gauss() : rand() < 0.5 ? Math.sign(rand() - 0.5) : rand() * 2 - 1; p2[i] = stream ? 1 : 0;
    spawn(i, mix(WATER, WHITE, 0.3), 1.3, 2 + 1.4 * rand(), G.sweat, 250 + 300 * rand(), 0.7, 0.8, stream ? 2 + SWEAT_RATE : 0);
    free[i] = stream ? 1 : 0;
  });

  // ---- three.js scene
  const renderer = new THREE.WebGLRenderer({ antialias: false, alpha: false, powerPreference: "high-performance" });
  renderer.setClearColor(0x000000, 1);
  container.appendChild(renderer.domElement);
  const scene = new THREE.Scene();
  const camera = new THREE.PerspectiveCamera(FOV, 1, 10, 6000);

  const geometry = new THREE.BufferGeometry();
  const posAttr = new THREE.BufferAttribute(pos, 3).setUsage(THREE.DynamicDrawUsage);
  const ampAttr = new THREE.BufferAttribute(amp, 1).setUsage(THREE.DynamicDrawUsage);
  geometry.setAttribute("position", posAttr);
  geometry.setAttribute("aColor", new THREE.BufferAttribute(color, 3));
  geometry.setAttribute("aSize", new THREE.BufferAttribute(size, 1));
  geometry.setAttribute("aMeta", new THREE.BufferAttribute(meta, 3));
  geometry.setAttribute("aAmp", ampAttr);
  const groups = new Float32Array(NG).fill(1);
  const uniforms = { uGroup: { value: groups }, uTime: { value: 0 }, uPx: { value: 600 } };
  const material = new THREE.ShaderMaterial({
    uniforms, vertexShader: VERT, fragmentShader: FRAG,
    transparent: true, depthWrite: false, depthTest: true, blending: THREE.AdditiveBlending,
  });
  const points = new THREE.Points(geometry, material);
  points.frustumCulled = false;
  scene.add(points);

  // Black occluders over the eye openings and the open mouth hide the back of the shell, so pupils and
  // the mouth read as true dark holes despite additive blending.
  const occVerts = 2 * (KE + 1) * 2 + 2 * (MS + 1);
  const occPos = new Float32Array(3 * occVerts), occIdx = [];
  const strip = (base, cols) => {
    for (let j = 0; j < cols; j++) {
      const a = base + 2 * j;
      occIdx.push(a, a + 1, a + 2, a + 1, a + 3, a + 2);
    }
  };
  strip(0, KE); strip(2 * (KE + 1), KE); strip(4 * (KE + 1), MS);
  const occGeo = new THREE.BufferGeometry();
  const occAttr = new THREE.BufferAttribute(occPos, 3).setUsage(THREE.DynamicDrawUsage);
  occGeo.setAttribute("position", occAttr);
  occGeo.setIndex(occIdx);
  const occMat = new THREE.MeshBasicMaterial({ color: 0x000000, side: THREE.DoubleSide });
  const occluder = new THREE.Mesh(occGeo, occMat);
  occluder.frustumCulled = false;
  scene.add(occluder);

  function resize() {
    const w = container.clientWidth || innerWidth, h = container.clientHeight || innerHeight;
    renderer.setPixelRatio(Math.min(devicePixelRatio || 1, PIXEL_RATIO_CAP));
    renderer.setSize(w, h, false);
    camera.aspect = w / h;
    const tn = Math.tan((FOV / 2) * Math.PI / 180);
    camera.position.set(0, 0, Math.max((HEAD.b * 1.2) / tn, (HEAD.a * 1.3) / (tn * camera.aspect)));
    camera.lookAt(0, 0, 0);
    camera.updateProjectionMatrix();
    uniforms.uPx.value = (h * renderer.getPixelRatio()) / (2 * tn);
  }
  resize();

  // ---- per-frame formation transform (squash/stretch, breath, head turn) applied to every target
  let sxk = 1, syk = 1, bsk = 1, bob = 0, cyw = 1, syw = 0, cpt = 1, spt = 0, gx = 0, gy = 0;
  const put = (arr, o, X, Y, Z) => {
    const x1 = X * sxk, y1 = Y * syk + bob, z1 = Z * bsk;
    const x2 = x1 * cyw + z1 * syw, z2 = z1 * cyw - x1 * syw;
    arr[o] = x2 + gx; arr[o + 1] = y1 * cpt + z2 * spt + gy; arr[o + 2] = z2 * cpt - y1 * spt;
  };

  const ux = new Float32Array(MS + 1), uy = new Float32Array(MS + 1), lx = new Float32Array(MS + 1), ly = new Float32Array(MS + 1);
  const sampleEdge = (edge, xs, ys) => {
    for (let j = 0; j <= MS; j++) {
      const t = j / MS, c = t < 0.5 ? edge[0] : edge[1], u = t < 0.5 ? 2 * t : 2 * t - 1, v = 1 - u;
      const b0 = v * v * v, b1 = 3 * v * v * u, b2 = 3 * v * u * u, b3 = u * u * u;
      xs[j] = b0 * c[0][0] + b1 * c[1][0] + b2 * c[2][0] + b3 * c[3][0];
      ys[j] = b0 * c[0][1] + b1 * c[1][1] + b2 * c[2][1] + b3 * c[3][1];
    }
  };
  // edge lookup into the sampled tables; writes ex, ey
  let ex = 0, ey = 0;
  const edgeAt = (xs, ys, t) => {
    const f = t * MS, j = Math.min(MS - 1, f | 0), r = f - j;
    ex = xs[j] + (xs[j + 1] - xs[j]) * r; ey = ys[j] + (ys[j + 1] - ys[j]) * r;
  };

  function eyeTargets(e, s, fx) {
    const k = EYE_SCALE, cx = e.cx, cy = e.cy, rx = e.rx * k, ry = e.ry * k;
    const px = cx + (e.px - cx) * k, py = cy + (e.py - cy) * k;
    const R = Math.min(e.pr * PUPIL_K * k, 0.86 * Math.min(rx, ry));
    const zE = zs(cx - FACE_CX, HEAD.cy - cy) + EYE_POP;
    const top = x => cy + (e.top(cx + (x - cx) / k) - cy) * k;
    const bot = x => cy + (e.bottom(cx + (x - cx) / k) - cy) * k;
    const ox = (px - cx) / rx, oy = (py - cy) / ry, oc = ox * ox + oy * oy - 1;

    // Whites: polar about the pupil, so the dark disk stays empty and the iris ring is the inner band.
    let [a, b] = RG["white" + s];
    for (let i = a; i < b; i++) {
      const c = p0[i], sn = p1[i], dx = c / rx, dy = sn / ry, A = dx * dx + dy * dy, B = ox * dx + oy * dy;
      const bd = (-B + Math.sqrt(Math.max(0, B * B - A * oc))) / A;
      const d = bd > R ? R + p2[i] * (bd - R) : bd * (0.95 + 0.05 * p2[i]);
      const x = px + c * d;
      let y = py + sn * d;
      // compensates the crowding on the pupil's near side and lights the far side, as on the board
      let am = clamp(0.2 + (0.85 * (bd - R)) / (0.6 * rx), 0.15, 1.6);
      const tp = top(x), bt = bot(x), band = Math.min(LID_BAND, bt > tp ? bt - tp : 0) + 1.2;
      if (y < tp) { y = tp - 0.6 + p3[i] * band; am *= 0.45; }
      else if (y > bt) { y = bt + 0.6 - p3[i] * band; am *= 0.45; }
      const qx = (x - cx) / rx, qy = (y - cy) / ry, q = 1 - qx * qx - qy * qy;
      put(tgt, 3 * i, x - FACE_CX, HEAD.cy - y, zE + BULGE * (q > 0 ? Math.sqrt(q) : 0));
      amp[i] = am;
    }
    [a, b] = RG["rim" + s];
    for (let i = a; i < b; i++) {
      const x = cx + rx * p0[i] * (1 - 0.06 * p2[i]);
      let y = cy + ry * p1[i] * (1 - 0.06 * p2[i]), am = 1;
      const tp = top(x), bt = bot(x), band = Math.min(LID_BAND, bt > tp ? bt - tp : 0) + 1.2;
      if (y < tp) { y = tp - 0.6 + p3[i] * band; am = 0.5; }
      else if (y > bt) { y = bt + 0.6 - p3[i] * band; am = 0.5; }
      put(tgt, 3 * i, x - FACE_CX, HEAD.cy - y, zE + 1);
      amp[i] = am;
    }
    [a, b] = RG["lid" + s];
    for (let i = a; i < b; i++) {
      const u = p0[i], x = cx + rx * u, h = ry * Math.sqrt(1 - u * u);
      const y = Math.min(Math.max(top(x), cy - h) + p1[i] * 2, bot(x));
      const qy = (y - cy) / ry, q = 1 - u * u - qy * qy;
      put(tgt, 3 * i, x - FACE_CX, HEAD.cy - y, zE + 1.5 + BULGE * (q > 0 ? Math.sqrt(q) : 0));
    }
    [a, b] = RG["socket" + s];
    for (let i = a; i < b; i++) put(tgt, 3 * i, cx + rx * p0[i] - FACE_CX, HEAD.cy - (cy + ry * p1[i]), zE - 6);

    const hx = px + 0.36 * R, hy = py - 0.42 * R, hr = 0.15 * R + 2 + 3 * fx.sparkle;
    groups[G.hi + s] = clamp((hy - top(hx)) / 5) * clamp((bot(hx) - hy) / 5);
    [a, b] = RG["hi" + s];
    for (let i = a; i < b; i++) {
      const second = p2[i] > 0.5, r = second ? hr * 0.45 : hr;
      const x = (second ? px - 0.38 * R : hx) + p0[i] * r, y = (second ? py + 0.36 * R : hy) + p1[i] * r;
      put(tgt, 3 * i, x - FACE_CX, HEAD.cy - y, zE + BULGE + 3);
    }

    // occluder strip over the visible opening, inset so its edge hides under the rim particles
    let o = 3 * 2 * (KE + 1) * s;
    for (let j = 0; j <= KE; j++, o += 6) {
      const u = -0.96 + (1.92 * j) / KE, x = cx + rx * u, h = ry * Math.sqrt(1 - u * u);
      const yt = Math.max(cy - h, top(x)) + 1.5, yb = Math.max(yt, Math.min(cy + h, bot(x)) - 1.5);
      put(occPos, o, x - FACE_CX, HEAD.cy - yt, zE - 1);
      put(occPos, o + 3, x - FACE_CX, HEAD.cy - yb, zE - 1);
    }
    return { cx, cy, k, zE, px, py, R };
  }

  function update(state, now, dt) {
    const t = (now - born) / 1000;
    const pose = facePose(state.ch), fx = pose.fx, m = pose.mouth;
    if (state.sinceChange + 1e-3 < lastSince) scatter();
    lastSince = state.sinceChange;
    const age = Math.min(state.sinceChange, t);

    const bs = 1 + 0.015 * state.breath;
    sxk = pose.scale[0] * bs; syk = pose.scale[1] * bs; bsk = bs; bob = 2.5 * state.breath;
    const yaw = 0.3 * state.gaze[0], pitch = 0.18 * state.gaze[1];
    cyw = Math.cos(yaw); syw = Math.sin(yaw); cpt = Math.cos(pitch); spt = Math.sin(pitch);
    gx = 10 * state.gaze[0]; gy = 6 * state.gaze[1];

    // head, ambient
    let [a, b] = RG.shell;
    for (let i = a; i < b; i++) put(tgt, 3 * i, HEAD.a * p0[i], HEAD.b * p1[i], HEAD.c * p2[i]);
    [a, b] = RG.interior;
    for (let i = a; i < b; i++) put(tgt, 3 * i, HEAD.a * p0[i], HEAD.b * p1[i], HEAD.c * p2[i]);
    for (const key of ["dust", "bokeh"]) {
      [a, b] = RG[key];
      for (let i = a; i < b; i++) put(tgt, 3 * i, p0[i], p1[i], p2[i]);
    }

    for (const s of [0, 1]) {
      const e = pose.eyes[s], E = eyeTargets(e, s, fx);

      const br = pose.brows[s];
      [a, b] = RG["brow" + s];
      for (let i = a; i < b; i++) {
        const u = p0[i], v = 1 - u;
        const x = E.cx + (v * v * br.inX + 2 * u * v * br.midX + u * u * br.outX - E.cx) * E.k;
        const y = v * v * br.inY + 2 * u * v * br.midY + u * u * br.outY - BROW_LIFT + p1[i] * 8 * (0.4 + 0.6 * Math.sin(Math.PI * u));
        const X = x - FACE_CX, Y = HEAD.cy - y;
        put(tgt, 3 * i, X, Y, zs(X, Y) + 8);
      }

      const corner = s === 0 ? m.R : m.L;
      groups[G.accent + s] = Math.max(corner.dm, corner.pr) * 0.9;
      [a, b] = RG["accent" + s];
      for (let i = a; i < b; i++) {
        const u = p0[i], x = corner.x + corner.d * (8 + 4 * Math.sin(Math.PI * u)) + p1[i] * 0.8, y = corner.y - 8 + 16 * u;
        const X = x - FACE_CX, Y = HEAD.cy - y;
        put(tgt, 3 * i, X, Y, zs(X, Y) + 6);
      }

      const ck = pose.cheeks[s];
      groups[G.blush + s] = clamp((ck.alpha - 0.22) / 0.55);
      [a, b] = RG["blush" + s];
      for (let i = a; i < b; i++) {
        const X = ck.cx + p0[i] * ck.rx * 1.25 - FACE_CX, Y = HEAD.cy - (ck.cy + 6 + p1[i] * ck.ry * 1.4);
        put(tgt, 3 * i, X, Y, zs(X, Y) + 4);
      }

      const tear = pose.tears[s];
      groups[G.tear + s] = tear ? tear.alpha : 0;
      if (tear) {
        const x0 = E.cx + (tear.x - E.cx) * E.k, y0 = E.cy + (tear.y0 - E.cy) * E.k, len = tear.len * 1.1;
        dropTargets(RG["tear" + s], x0, y0, len, 9, 95, TEAR_RATE, t);
      }

      const sp = pose.sparkles[s];
      groups[G.sparkle + s] = sp ? sp.s * (0.8 + 0.2 * Math.sin(t * 5 + s)) : 0;
      if (sp) {
        const x0 = E.cx + (sp.x - E.cx) * E.k, y0 = E.cy + (sp.y - E.cy) * E.k, sc = 1.7 * sp.s;
        const rot = 0.35 * Math.sin(t * 1.3 + s * 2), cr = Math.cos(rot), sr = Math.sin(rot);
        [a, b] = RG["sparkle" + s];
        for (let i = a; i < b; i++) {
          let lx0, ly0;
          if (p0[i] < 0) { lx0 = p1[i] * 10; ly0 = p2[i] * 10; }
          else {
            const f = p0[i], j = f | 0, r = f - j, j2 = (j + 1) & 7;
            lx0 = STAR[2 * j] + (STAR[2 * j2] - STAR[2 * j]) * r + p1[i];
            ly0 = STAR[2 * j + 1] + (STAR[2 * j2 + 1] - STAR[2 * j + 1]) * r + p1[i];
          }
          const x = x0 + sc * (lx0 * cr - ly0 * sr), y = y0 + sc * (lx0 * sr + ly0 * cr);
          put(tgt, 3 * i, x - FACE_CX, HEAD.cy - y, E.zE + BULGE + 6);
        }
      }
    }

    mouthTargets(m);
    groups[G.mouth] = 1;
    groups[G.teethU] = m.upperTeeth;
    groups[G.teethL] = m.lowerTeeth;
    groups[G.tongue] = Math.max(m.tongueOut, 0.55 * clamp((m.lY - m.uY - 16) / 10));

    groups[G.sweat] = pose.sweat ? pose.sweat.alpha : 0;
    if (pose.sweat) dropTargets(RG.sweat, pose.sweat.x - 6, pose.sweat.y0 + 8, pose.sweat.len * 1.5, 15, 60, SWEAT_RATE, t);

    groups[G.shell] = 0.92 + 0.08 * state.breath;

    physics(dt, t, age);
    posAttr.needsUpdate = true;
    ampAttr.clearUpdateRanges();
    ampAttr.addUpdateRange(0, AMP_END);
    ampAttr.needsUpdate = true;
    occAttr.needsUpdate = true;
    uniforms.uTime.value = t % 600;
    renderer.render(scene, camera);
  }

  function mouthTargets(m) {
    sampleEdge(m.upper, ux, uy);
    sampleEdge(m.lower, lx, ly);
    const h0 = m.width * 0.6 + 4;
    let [a, b] = RG.lip;
    for (let i = a; i < b; i++) {
      const t = p0[i], sn = Math.sin(Math.PI * t), h = h0 * Math.pow(sn, 0.6) + 0.6;
      let x, y;
      if (p1[i] < 0.5) { edgeAt(ux, uy, t); x = ex; y = ey - p2[i] * h; }
      else { edgeAt(lx, ly, t); x = ex; y = ey + p2[i] * h; }
      const X = x - FACE_CX, Y = HEAD.cy - y;
      put(tgt, 3 * i, X, Y, zs(X, Y) + 5 + 4 * sn);
    }
    const between = (key, from, span, z0) => {
      [a, b] = RG[key];
      for (let i = a; i < b; i++) {
        const t = p0[i], f = from + span * p1[i];
        edgeAt(ux, uy, t); const x0 = ex, y0 = ey;
        edgeAt(lx, ly, t);
        const X = x0 + (ex - x0) * f - FACE_CX, Y = HEAD.cy - (y0 + (ey - y0) * f);
        put(tgt, 3 * i, X, Y, zs(X, Y) + z0 + 3 * Math.sin(Math.PI * t));
      }
    };
    between("fill", 0, 1, 2);
    between("teethU", 0, 0.28, 3);
    // lower teeth hang from the lower edge: f runs 1 -> 0.78
    between("teethL", 1, -0.22, 3);

    const out = m.tongueOut > 0.01, tx = m.mx + m.jawShift;
    const ty = out ? m.lY + 6 + 10 * m.tongueOut : m.lY - 4, trx = out ? 15 : 20, tr = out ? 6 + 12 * m.tongueOut : 6;
    [a, b] = RG.tongue;
    for (let i = a; i < b; i++) {
      const X = tx + p0[i] * trx - FACE_CX, Y = HEAD.cy - (ty + p1[i] * tr);
      put(tgt, 3 * i, X, Y, zs(X, Y) + (out ? 10 : 3));
    }

    let o = 3 * 4 * (KE + 1);
    for (let j = 0; j <= MS; j++, o += 6) {
      const yt = uy[j] + 1, yb = Math.max(yt, ly[j] - 1);
      const Xt = ux[j] - FACE_CX, Xb = lx[j] - FACE_CX, Yt = HEAD.cy - yt, Yb = HEAD.cy - yb;
      put(occPos, o, Xt, Yt, zs(Xt, Yt) + 1);
      put(occPos, o + 3, Xb, Yb, zs(Xb, Yb) + 1);
    }
  }

  // Teardrop outline+body that springs into place, plus a stream whose particles are placed directly
  // (their fade is computed in the shader from the same phase, so the wrap is invisible).
  function dropTargets([a, b], x0, y0, len, w, fall, rate, t) {
    for (let i = a; i < b; i++) {
      if (p2[i] > 0.5) {
        const ph = t * rate + meta[3 * i + 1], p = ph - Math.floor(ph);
        const x = x0 + p1[i] * 1.5 + 2 * Math.sin(p * 9 + meta[3 * i + 1] * 20), y = y0 + len * 0.85 + p * fall;
        const X = x - FACE_CX, Y = HEAD.cy - y;
        put(pos, 3 * i, X, Y, zs(X, Y) + 9);
      } else {
        const v = p0[i], hw = w * Math.sqrt(v * (1 - v)) * Math.pow(v, 0.35) * 1.6;
        const X = x0 + p1[i] * hw - FACE_CX, Y = HEAD.cy - (y0 + v * len);
        put(tgt, 3 * i, X, Y, zs(X, Y) + 10);
      }
    }
  }

  // Coherent swirl: an ABC-style flow sampled from a sine table, so neighbours move together like a flock.
  const FT = 0.012 * TK, FT2 = 0.0156 * TK;
  function physics(dt, t, age) {
    if (dt <= 0) return;
    const n = Math.ceil(dt / MAX_STEP), h = dt / n;
    const boost = 1 + 2.5 * Math.exp(-age * 2.5);
    const q0 = (t * 0.5 * TK) | 0, q1 = (t * 0.37 * TK) | 0, q2 = (t * 0.43 * TK) | 0;
    const q3 = (t * 0.61 * TK) | 0, q4 = (t * 0.55 * TK) | 0, q5 = (t * 0.29 * TK) | 0, Q = TAB >> 2;
    for (let i = 0; i < N; i++) {
      if (free[i]) continue;
      const o = 3 * i;
      let x = pos[o], y = pos[o + 1], z = pos[o + 2], vx = vel[o], vy = vel[o + 1], vz = vel[o + 2];
      const tx = tgt[o], ty = tgt[o + 1], tz = tgt[o + 2];
      let r = (age - delay[i]) / RAMP_T;
      r = r <= 0 ? 0 : r >= 1 ? 1 : r * r * (3 - 2 * r);
      const k = kS[i] * (0.06 + 0.94 * r), c = 2 * zeta[i] * Math.sqrt(k), f = flowD[i] * k * boost;
      const fx = f * (SIN[((z * FT) | 0) + q0 & TMASK] + SIN[((y * FT2) | 0) + q1 + Q & TMASK]);
      const fy = f * (SIN[((x * FT) | 0) + q2 & TMASK] + SIN[((z * FT2) | 0) + q3 + Q & TMASK]);
      const fz = f * (SIN[((y * FT) | 0) + q4 & TMASK] + SIN[((x * FT2) | 0) + q5 + Q & TMASK]);
      for (let s = 0; s < n; s++) {
        vx += (k * (tx - x) - c * vx + fx) * h; x += vx * h;
        vy += (k * (ty - y) - c * vy + fy) * h; y += vy * h;
        vz += (k * (tz - z) - c * vz + fz) * h; z += vz * h;
      }
      pos[o] = x; pos[o + 1] = y; pos[o + 2] = z; vel[o] = vx; vel[o + 1] = vy; vel[o + 2] = vz;
    }
  }

  // Expression change: kick every particle outward-ish; the slack spring ramp then lets the flock re-form.
  function scatter() {
    for (let i = 0; i < N; i++) {
      if (free[i]) continue;
      const o = 3 * i, sd = meta[o + 1] * 1000;
      const ln = Math.hypot(pos[o], pos[o + 1], pos[o + 2]) || 1, sp = BURST * (0.4 + 0.6 * meta[o + 1]);
      vel[o] += sp * (Math.sin(sd * 1.7) + 0.6 * pos[o] / ln);
      vel[o + 1] += sp * (Math.sin(sd * 2.3 + 1) + 0.6 * pos[o + 1] / ln);
      vel[o + 2] += sp * (Math.sin(sd * 3.1 + 2) + 0.6 * pos[o + 2] / ln);
    }
  }

  const born = performance.now();
  let lastSince = -Infinity;

  return {
    update,
    resize,
    dispose() {
      geometry.dispose(); material.dispose(); occGeo.dispose(); occMat.dispose();
      renderer.dispose();
      renderer.forceContextLoss();
      renderer.domElement.remove();
    },
  };
}
