// Hologram: a procedural robot head projected as cyan light inside a glass case.
// Scene renders to an offscreen target, then a two-level bloom and a composite pass add glow,
// chromatic fringe and the glitch burst that marks an expression change.
import * as THREE from "three";
import { facePose, FACE_W, FACE_H } from "../pose.js";
import { paintFeatures } from "../paint.js";

const PIXEL_RATIO_MAX = 1.5;
const MSAA_SAMPLES = 4;
const FACE_TEX_W = 640;       // face panel canvas width; height follows the 400x290 face aspect
const BLOOM_DIV = 4;          // bloom level 1 at 1/4 frame, level 2 at 1/8
const DUST_COUNT = 140;
const HEAD_SEGMENTS = [72, 48];
const SCAN_DENSITY = 150;     // scan-line phase per world unit of height
const REPAINT_EPS = 0.002;    // channel delta that triggers a face repaint

const HEAD = { y: 0.2, a: 1.3, b: 0.98, c: 1.0, p: 3.4 };
const PANEL = { w: 2.25, y: -0.05 };
const CASE_R = 2.5, CASE_TOP = 1.75, BASE_TOP = -1.68;
const VIEW_H = 3.5, VIEW_W = 3.7, LOOK_AT_Y = -0.2, CAM_RISE = 1.0, FOV = 30;

const FACE_STYLE = {
  eye: "#a6f2ff", iris: "#1d9ff0", pupil: "#020912", highlight: "#ffffff", pupilScale: 1.12,
  line: "#6fe6ff", mouthLine: "#86eeff", mouth: "#03111c", teeth: "#c8f6ff", tongue: "#2f9bd6",
  blush: "#ff6fc4", water: "#c6f8ff", closed: "#8ff0ff", rim: "#2a86e0",
  glow: 6, brows: true, browWidth: 10, nose: false, chin: false, marks: true,
};

const GLSL_COMMON = /* glsl */ `
  uniform float uTime, uGlitch, uFlicker, uSweep;
  float hash1(float n) { return fract(sin(n * 12.9898) * 43758.5453); }
`;

// Glitch displaces horizontal world-space slices; every holo part shares it so the panel stays glued on.
const HOLO_VERT = /* glsl */ `
  ${GLSL_COMMON}
  varying vec3 vN, vW;
  varying vec2 vUv;
  void main() {
    vUv = uv;
    vec4 wp = modelMatrix * vec4(position, 1.0);
    float band = floor(wp.y * 14.0) + floor(uTime * 24.0) * 7.0;
    wp.x += step(1.0 - uGlitch * 0.7, hash1(band)) * (hash1(band + 3.1) - 0.5) * 0.4 * uGlitch;
    vW = wp.xyz;
    vN = normalize(mat3(modelMatrix) * normal);
    gl_Position = projectionMatrix * viewMatrix * wp;
  }
`;

const HOLO_FRAG = /* glsl */ `
  ${GLSL_COMMON}
  uniform vec3 uColor;
  uniform float uBase, uRim, uGrid, uBack, uBoost;
  uniform vec2 uGridN;
  varying vec3 vN, vW;
  varying vec2 vUv;
  void main() {
    vec3 V = normalize(cameraPosition - vW);
    vec3 N = normalize(vN) * (gl_FrontFacing ? 1.0 : -1.0);
    float ndv = clamp(dot(N, V), 0.0, 1.0);
    float fres = pow(1.0 - ndv, 2.5);
    float scan = 0.55 + 0.45 * sin(vW.y * ${SCAN_DENSITY.toFixed(1)} - uTime * 4.0);
    float band = 0.75 + 0.25 * sin(vW.y * 7.0 - uTime * 1.3);
    vec2 gq = vUv * uGridN;
    vec2 gd = abs(fract(gq - 0.5) - 0.5) / max(fwidth(gq), 1e-4);
    float grid = 1.0 - min(min(gd.x, gd.y), 1.0);
    float sweep = exp(-pow((vW.y - uSweep) * 5.0, 2.0));
    float a = (uBase * band + uRim * fres) * scan + uGrid * grid * (0.35 + 0.65 * fres) + 0.5 * sweep * (0.3 + fres);
    a *= uFlicker * uBoost * (gl_FrontFacing ? 1.0 : uBack);
    vec3 col = uColor * a;
    float edge = pow(1.0 - ndv, 6.0) * uBoost;
    float side = (viewMatrix * vec4(N, 0.0)).x;
    col += edge * mix(vec3(1.0, 0.4, 0.15), vec3(0.7, 0.3, 1.0), step(0.0, side)) * 0.3;
    gl_FragColor = vec4(col, 1.0);
  }
`;

const PANEL_FRAG = /* glsl */ `
  ${GLSL_COMMON}
  uniform sampler2D uMap;
  uniform vec3 uColor;
  varying vec3 vN, vW;
  varying vec2 vUv;
  void main() {
    vec4 t = texture2D(uMap, vUv);
    if (t.a < 0.02) discard;
    float scan = 0.55 + 0.45 * sin(vW.y * ${SCAN_DENSITY.toFixed(1)} - uTime * 4.0);
    float sweep = exp(-pow((vW.y - uSweep) * 5.0, 2.0));
    vec3 col = t.rgb * (0.8 + 0.2 * scan) * uFlicker + uColor * (0.05 * scan + 0.3 * sweep) * t.a;
    gl_FragColor = vec4(col, t.a);
  }
`;

const CASE_FRAG = /* glsl */ `
  uniform float uI;
  uniform float uHeadY;
  varying vec3 vN, vW;
  varying vec2 vUv;
  void main() {
    vec3 V = normalize(cameraPosition - vW);
    vec3 N = normalize(vN) * (gl_FrontFacing ? 1.0 : -1.0);
    float ndv = abs(dot(N, V));
    float sx = (viewMatrix * vec4(N, 0.0)).x;
    float a = 0.9 * pow(1.0 - ndv, 3.0);
    a += 0.35 * pow(max(0.0, 1.0 - abs(sx - 0.62) * 9.0), 2.0) + 0.25 * pow(max(0.0, 1.0 - abs(sx + 0.75) * 12.0), 2.0);
    a += 0.25 * (smoothstep(0.06, 0.0, vUv.y) + smoothstep(0.94, 1.0, vUv.y));
    vec3 col = vec3(0.55, 0.75, 0.9) * a + vec3(0.1, 0.45, 0.8) * 0.06 * exp(-pow(vW.y - uHeadY, 2.0));
    gl_FragColor = vec4(col * uI, 1.0);
  }
`;

const PLAIN_VERT = /* glsl */ `
  varying vec3 vN, vW;
  varying vec2 vUv;
  void main() {
    vUv = uv;
    vec4 wp = modelMatrix * vec4(position, 1.0);
    vW = wp.xyz;
    vN = normalize(mat3(modelMatrix) * normal);
    gl_Position = projectionMatrix * viewMatrix * wp;
  }
`;

const BASE_FRAG = /* glsl */ `
  uniform float uRing, uTop, uR;
  varying vec3 vN, vW;
  varying vec2 vUv;
  void main() {
    vec3 V = normalize(cameraPosition - vW);
    float r = length(vW.xz);
    vec3 col = vec3(0.014, 0.018, 0.024);
    if (vN.y > 0.5) {
      col += vec3(0.15, 0.55, 0.9) * uRing * (0.35 * exp(-pow((r - 0.95) * 3.5, 2.0)) + 0.12 * exp(-r * r * 0.5));
      col += vec3(0.25, 0.32, 0.4) * smoothstep(uR - 0.06, uR, r);
    } else {
      col += vec3(0.05, 0.07, 0.09) * pow(1.0 - abs(dot(normalize(vN), V)), 2.0);
      col += vec3(0.3, 0.4, 0.5) * smoothstep(uTop - 0.03, uTop, vW.y);
    }
    gl_FragColor = vec4(col, 1.0);
  }
`;

const GLOW_DISC_FRAG = /* glsl */ `
  uniform float uRing, uTime;
  varying vec2 vUv;
  void main() {
    float r = length(vUv - 0.5) * 2.0 * 1.4;
    float a = exp(-pow((r - 0.95) * 9.0, 2.0)) * 0.55 + exp(-pow((r - 0.62) * 14.0, 2.0)) * 0.15 + 0.1 * exp(-r * r * 3.0);
    a *= uRing * (0.9 + 0.1 * sin(uTime * 3.0));
    gl_FragColor = vec4(vec3(0.3, 0.78, 1.0) * a, 1.0);
  }
`;

const BEAM_FRAG = /* glsl */ `
  uniform float uI, uTime;
  varying vec2 vUv;
  void main() {
    float ang = vUv.x * 6.2831853;
    float s = pow(0.5 + 0.5 * sin(ang * 23.0 + 2.0 * sin(ang * 7.0 + uTime * 0.7)), 4.0);
    s += 0.6 * pow(0.5 + 0.5 * sin(ang * 61.0 - uTime * 1.1), 8.0);
    float h = vUv.y;
    float fade = pow(1.0 - h, 1.6) * smoothstep(0.0, 0.06, h);
    gl_FragColor = vec4(vec3(0.3, 0.75, 1.0) * (0.2 + s) * fade * uI, 1.0);
  }
`;

const DUST_VERT = /* glsl */ `
  uniform float uTime, uPx, uBottom, uHeight;
  attribute vec4 seed;
  varying float vA;
  void main() {
    float h = fract(seed.y + uTime * (0.04 + 0.05 * seed.z));
    float ang = seed.x * 6.2831853 + uTime * 0.15 * (seed.w - 0.5);
    float r = (0.25 + 1.0 * seed.w) * (1.0 + 0.4 * h);
    vec4 mv = modelViewMatrix * vec4(cos(ang) * r, uBottom + h * uHeight, sin(ang) * r, 1.0);
    vA = sin(h * 3.14159) * (0.4 + 0.6 * seed.z);
    gl_PointSize = (2.0 + 3.0 * seed.z) * uPx * (4.0 / -mv.z);
    gl_Position = projectionMatrix * mv;
  }
`;

const DUST_FRAG = /* glsl */ `
  varying float vA;
  void main() {
    float d = length(gl_PointCoord - 0.5);
    gl_FragColor = vec4(vec3(0.45, 0.85, 1.0) * vA * smoothstep(0.5, 0.0, d), 1.0);
  }
`;

const BACK_FRAG = /* glsl */ `
  uniform float uHeadY;
  varying vec3 vW;
  void main() {
    vec2 p = vW.xy - vec2(0.0, uHeadY);
    vec3 col = vec3(0.012, 0.017, 0.024) + vec3(0.03, 0.09, 0.15) * exp(-dot(p, p) * 0.12);
    gl_FragColor = vec4(col, 1.0);
  }
`;

const QUAD_VERT = /* glsl */ `
  varying vec2 vUv;
  void main() { vUv = uv; gl_Position = vec4(position.xy, 0.0, 1.0); }
`;

// 4 bilinear taps one source texel off-centre average a 4x4 block, so thin scan lines don't shimmer.
const DOWN_FRAG = /* glsl */ `
  uniform sampler2D tSrc;
  uniform vec2 uTexel;
  uniform float uThreshold;
  varying vec2 vUv;
  void main() {
    vec3 c = texture2D(tSrc, vUv + uTexel * vec2(-1.0, -1.0)).rgb + texture2D(tSrc, vUv + uTexel * vec2(1.0, -1.0)).rgb
           + texture2D(tSrc, vUv + uTexel * vec2(-1.0, 1.0)).rgb + texture2D(tSrc, vUv + uTexel * vec2(1.0, 1.0)).rgb;
    c *= 0.25;
    float l = max(c.r, max(c.g, c.b));
    gl_FragColor = vec4(c * smoothstep(uThreshold, uThreshold + 0.5, l), 1.0);
  }
`;

const BLUR_FRAG = /* glsl */ `
  uniform sampler2D tSrc;
  uniform vec2 uDir;
  varying vec2 vUv;
  void main() {
    vec3 c = texture2D(tSrc, vUv).rgb * 0.2270270270;
    c += (texture2D(tSrc, vUv + uDir * 1.3846153846).rgb + texture2D(tSrc, vUv - uDir * 1.3846153846).rgb) * 0.3162162162;
    c += (texture2D(tSrc, vUv + uDir * 3.2307692308).rgb + texture2D(tSrc, vUv - uDir * 3.2307692308).rgb) * 0.0702702703;
    gl_FragColor = vec4(c, 1.0);
  }
`;

const COMPOSITE_FRAG = /* glsl */ `
  ${GLSL_COMMON}
  uniform sampler2D tScene, tBloom1, tBloom2;
  uniform vec2 uRes;
  varying vec2 vUv;
  float hash2(vec2 p) { return fract(sin(dot(p, vec2(12.9898, 78.233))) * 43758.5453); }
  void main() {
    vec2 uv = vUv;
    float band = floor(uv.y * 36.0);
    float tick = floor(uTime * 20.0);
    if (hash2(vec2(band, tick)) > 1.0 - uGlitch * 0.45) uv.x += (hash2(vec2(tick, band)) - 0.5) * 0.07 * uGlitch;
    vec2 d = uv - 0.5;
    vec2 ca = d * (0.006 + 0.02 * uGlitch) + vec2(0.006 * uGlitch, 0.0);
    vec3 c = vec3(texture2D(tScene, uv + ca).r, texture2D(tScene, uv).g, texture2D(tScene, uv - ca).b);
    c += texture2D(tBloom1, uv).rgb * 0.75 + texture2D(tBloom2, uv).rgb * 0.9;
    c *= 1.0 - 0.55 * dot(d, d);
    c += (hash2(vUv * uRes + fract(uTime) * 100.0) - 0.5) * 0.02;
    gl_FragColor = vec4(c, 1.0);
  }
`;

// Unit sphere remapped onto |x/a|^p + |y/b|^p + |z/c|^p = 1, with analytic normals (no seam shading).
function superellipsoid(a, b, c, p, ws, hs) {
  const g = new THREE.SphereGeometry(1, ws, hs);
  const pos = g.attributes.position, nor = g.attributes.normal;
  for (let i = 0; i < pos.count; i++) {
    const x = pos.getX(i), y = pos.getY(i), z = pos.getZ(i);
    const t = Math.pow(Math.abs(x / a) ** p + Math.abs(y / b) ** p + Math.abs(z / c) ** p, -1 / p);
    const X = x * t, Y = y * t, Z = z * t;
    const nx = Math.sign(X) * Math.abs(X / a) ** (p - 1) / a;
    const ny = Math.sign(Y) * Math.abs(Y / b) ** (p - 1) / b;
    const nz = Math.sign(Z) * Math.abs(Z / c) ** (p - 1) / c;
    const nl = Math.hypot(nx, ny, nz) || 1;
    pos.setXYZ(i, X, Y, Z);
    nor.setXYZ(i, nx / nl, ny / nl, nz / nl);
  }
  return g;
}

// Planar-projected patch of the head front that carries the face texture.
function facePanel(w, h, yOff) {
  const g = new THREE.PlaneGeometry(w, h, 48, 36);
  const pos = g.attributes.position;
  const { a, b, c, p } = HEAD;
  for (let i = 0; i < pos.count; i++) {
    const x = pos.getX(i), y = pos.getY(i) + yOff;
    const s = 1 - Math.abs(x / a) ** p - Math.abs(y / b) ** p;
    pos.setXYZ(i, x, y, c * Math.pow(Math.max(0, s), 1 / p) + 0.015);
  }
  g.computeVertexNormals();
  return g;
}

function roundRect(ctx, x, y, w, h, rt, rb) {
  ctx.beginPath();
  ctx.moveTo(x + rt, y);
  ctx.lineTo(x + w - rt, y);
  ctx.quadraticCurveTo(x + w, y, x + w, y + rt);
  ctx.lineTo(x + w, y + h - rb);
  ctx.quadraticCurveTo(x + w, y + h, x + w - rb, y + h);
  ctx.lineTo(x + rb, y + h);
  ctx.quadraticCurveTo(x, y + h, x, y + h - rb);
  ctx.lineTo(x, y + rt);
  ctx.quadraticCurveTo(x, y, x + rt, y);
  ctx.closePath();
}

export async function createLook(container) {
  const renderer = new THREE.WebGLRenderer({ antialias: false, alpha: false, powerPreference: "high-performance" });
  renderer.setClearColor(0x020407, 1);
  const canvas = renderer.domElement;
  container.appendChild(canvas);

  const disposables = [];
  const keep = x => (disposables.push(x), x);

  const shared = {
    uTime: { value: 0 }, uGlitch: { value: 0 }, uFlicker: { value: 1 }, uSweep: { value: 100 },
  };

  const scene = new THREE.Scene();
  const camera = new THREE.PerspectiveCamera(FOV, 1, 0.1, 60);

  const holoMat = ({ color = [0.25, 0.72, 1.0], base = 0.1, rim = 1.1, grid = 0, gridN = [32, 16], back = 0.35 } = {}) =>
    keep(new THREE.ShaderMaterial({
      uniforms: {
        ...shared,
        uColor: { value: new THREE.Vector3(...color) }, uBase: { value: base }, uRim: { value: rim },
        uGrid: { value: grid }, uGridN: { value: new THREE.Vector2(...gridN) }, uBack: { value: back }, uBoost: { value: 1 },
      },
      vertexShader: HOLO_VERT, fragmentShader: HOLO_FRAG,
      transparent: true, depthWrite: false, blending: THREE.AdditiveBlending, side: THREE.DoubleSide,
    }));
  const mesh = (geo, mat, order) => {
    const m = new THREE.Mesh(keep(geo), mat);
    m.renderOrder = order;
    return m;
  };

  // Backdrop
  const back = mesh(new THREE.PlaneGeometry(60, 40), keep(new THREE.ShaderMaterial({
    uniforms: { uHeadY: { value: HEAD.y } }, vertexShader: PLAIN_VERT, fragmentShader: BACK_FRAG, depthWrite: false,
  })), -10);
  back.position.z = -8;
  scene.add(back);

  // Base, projector ring, beams, dust
  const baseMat = keep(new THREE.ShaderMaterial({
    uniforms: { uRing: { value: 1 }, uTop: { value: BASE_TOP }, uR: { value: CASE_R + 0.12 } },
    vertexShader: PLAIN_VERT, fragmentShader: BASE_FRAG,
  }));
  const base = mesh(new THREE.CylinderGeometry(CASE_R + 0.12, CASE_R + 0.18, 0.7, 96, 1), baseMat, 0);
  base.position.y = BASE_TOP - 0.35;
  scene.add(base);

  const discMat = keep(new THREE.ShaderMaterial({
    uniforms: { uRing: { value: 1 }, uTime: shared.uTime }, vertexShader: PLAIN_VERT, fragmentShader: GLOW_DISC_FRAG,
    transparent: true, depthWrite: false, blending: THREE.AdditiveBlending,
  }));
  const disc = mesh(new THREE.PlaneGeometry(2.8, 2.8), discMat, 1);
  disc.rotation.x = -Math.PI / 2;
  disc.position.y = BASE_TOP + 0.004;
  scene.add(disc);

  const ringMat = holoMat({ color: [0.45, 0.88, 1.0], base: 0.9, rim: 0.4, back: 1 });
  const ring = mesh(new THREE.TorusGeometry(0.95, 0.03, 10, 96), ringMat, 1);
  ring.rotation.x = Math.PI / 2;
  ring.position.y = BASE_TOP + 0.03;
  scene.add(ring);

  const neckBottom = HEAD.y - HEAD.b - 0.3;
  const beamMat = keep(new THREE.ShaderMaterial({
    uniforms: { uI: { value: 0.42 }, uTime: shared.uTime }, vertexShader: PLAIN_VERT, fragmentShader: BEAM_FRAG,
    transparent: true, depthWrite: false, blending: THREE.AdditiveBlending, side: THREE.DoubleSide,
  }));
  const beamH = neckBottom - BASE_TOP;
  const beam = mesh(new THREE.CylinderGeometry(0.5, 0.95, beamH, 96, 1, true), beamMat, 1);
  beam.position.y = BASE_TOP + beamH / 2;
  scene.add(beam);
  const flareMat = keep(beamMat.clone());
  flareMat.uniforms.uTime = shared.uTime;
  flareMat.uniforms.uI.value = 0.22;
  const flareH = HEAD.y - BASE_TOP - 0.2;
  const flare = mesh(new THREE.CylinderGeometry(1.45, 0.95, flareH, 96, 1, true), flareMat, 1);
  flare.position.y = BASE_TOP + flareH / 2;
  flare.rotation.y = 1.3;
  scene.add(flare);

  const dustGeo = new THREE.BufferGeometry();
  const seeds = new Float32Array(DUST_COUNT * 4);
  for (let i = 0; i < seeds.length; i++) seeds[i] = Math.random();
  dustGeo.setAttribute("seed", new THREE.BufferAttribute(seeds, 4));
  dustGeo.setAttribute("position", new THREE.BufferAttribute(new Float32Array(DUST_COUNT * 3), 3));
  const dustMat = keep(new THREE.ShaderMaterial({
    uniforms: { uTime: shared.uTime, uPx: { value: 1 }, uBottom: { value: BASE_TOP }, uHeight: { value: HEAD.y + HEAD.b - BASE_TOP } },
    vertexShader: DUST_VERT, fragmentShader: DUST_FRAG,
    transparent: true, depthWrite: false, blending: THREE.AdditiveBlending,
  }));
  const dust = new THREE.Points(keep(dustGeo), dustMat);
  dust.frustumCulled = false;
  dust.renderOrder = 1;
  scene.add(dust);

  // Glass case: back half before the hologram, front half last, so the opaque-ish face panel sits between.
  const caseH = CASE_TOP - BASE_TOP;
  const caseGeo = keep(new THREE.CylinderGeometry(CASE_R, CASE_R, caseH, 128, 1, true));
  const caseMat = side => keep(new THREE.ShaderMaterial({
    uniforms: { uI: { value: 0.32 }, uHeadY: { value: HEAD.y } }, vertexShader: PLAIN_VERT, fragmentShader: CASE_FRAG,
    transparent: true, depthWrite: false, blending: THREE.AdditiveBlending, side,
  }));
  const caseBack = new THREE.Mesh(caseGeo, caseMat(THREE.BackSide));
  const caseFront = new THREE.Mesh(caseGeo, caseMat(THREE.FrontSide));
  caseBack.renderOrder = 0.5;
  caseFront.renderOrder = 20;
  for (const m of [caseBack, caseFront]) { m.position.y = BASE_TOP + caseH / 2; scene.add(m); }
  const rimMat = caseMat(THREE.FrontSide);
  rimMat.uniforms.uI.value = 0.5;
  for (const y of [CASE_TOP, BASE_TOP + 0.02]) {
    const rim = mesh(new THREE.TorusGeometry(CASE_R, 0.035, 8, 128), rimMat, 20);
    rim.rotation.x = Math.PI / 2;
    rim.position.y = y;
    scene.add(rim);
  }

  // Hologram: float group (bob) > neck + head group (gaze turn, squash)
  const holo = new THREE.Group();
  scene.add(holo);
  const head = new THREE.Group();
  head.rotation.order = "YXZ";
  head.position.y = HEAD.y;
  holo.add(head);

  const shellMat = holoMat({ base: 0.07, rim: 1.25, grid: 0.22, gridN: [36, 18] });
  head.add(mesh(superellipsoid(HEAD.a, HEAD.b, HEAD.c, HEAD.p, ...HEAD_SEGMENTS), shellMat, 3));

  const plate = mesh(superellipsoid(0.42, 0.07, 0.3, 4, 32, 16), holoMat({ base: 0.25, rim: 1.4, back: 0.6 }), 3);
  plate.position.set(0, HEAD.b * 0.985, 0.12);
  plate.rotation.x = 0.08;
  head.add(plate);

  const cupMat = holoMat({ base: 0.05, rim: 0.55, grid: 0.18, gridN: [32, 3], back: 0.2 });
  const earRingMat = holoMat({ color: [0.4, 0.86, 1.0], base: 0.75, rim: 0.5, back: 0.6 });
  for (const d of [-1, 1]) {
    const ear = new THREE.Group();
    ear.position.set(d * (HEAD.a - 0.04), -0.02, -0.05);
    // toe the cups forward so their rings read from the front, like the concept's headphones
    ear.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), new THREE.Vector3(d * 0.88, 0, 0.48).normalize());
    ear.add(mesh(new THREE.CylinderGeometry(0.43, 0.47, 0.3, 48, 2), cupMat, 5));
    const outer = mesh(new THREE.TorusGeometry(0.37, 0.05, 12, 64), earRingMat, 5);
    const inner = mesh(new THREE.TorusGeometry(0.2, 0.025, 8, 48), earRingMat, 5);
    for (const r of [outer, inner]) { r.rotation.x = Math.PI / 2; r.position.y = 0.16; ear.add(r); }
    head.add(ear);
  }

  const neckMat = holoMat({ base: 0.06, rim: 0.7, grid: 0.2, gridN: [24, 2], back: 0.2 });
  const neck = mesh(new THREE.CylinderGeometry(0.42, 0.46, 0.26, 48, 1), neckMat, 2);
  neck.position.y = HEAD.y - HEAD.b - 0.08;
  holo.add(neck);
  const collar = mesh(new THREE.TorusGeometry(0.5, 0.045, 10, 64), holoMat({ base: 0.35, rim: 0.6, back: 0.5 }), 2);
  collar.rotation.x = Math.PI / 2;
  collar.position.y = neck.position.y - 0.12;
  holo.add(collar);

  // Face panel: visor + features painted on a canvas, only when the channels move.
  const texH = Math.round(FACE_TEX_W * FACE_H / FACE_W);
  const faceCanvas = document.createElement("canvas");
  faceCanvas.width = FACE_TEX_W;
  faceCanvas.height = texH;
  const fctx = faceCanvas.getContext("2d");
  const visor = document.createElement("canvas");
  visor.width = FACE_TEX_W;
  visor.height = texH;
  {
    const v = visor.getContext("2d"), k = FACE_TEX_W / FACE_W;
    v.scale(k, k);
    const grad = v.createLinearGradient(0, 0, 0, FACE_H);
    grad.addColorStop(0, "rgba(4,18,34,0.80)");
    grad.addColorStop(1, "rgba(2,10,22,0.86)");
    roundRect(v, 22, 10, FACE_W - 44, FACE_H - 18, 90, 115);
    v.fillStyle = grad;
    v.fill();
    v.shadowColor = "#4fd8ff";
    v.shadowBlur = 8 * k;
    v.strokeStyle = "rgba(110,225,255,0.7)";
    v.lineWidth = 3;
    v.stroke();
  }
  const faceTex = keep(new THREE.CanvasTexture(faceCanvas));
  faceTex.anisotropy = 4;
  const panelMat = keep(new THREE.ShaderMaterial({
    uniforms: { ...shared, uMap: { value: faceTex }, uColor: { value: new THREE.Vector3(0.25, 0.72, 1.0) } },
    vertexShader: HOLO_VERT, fragmentShader: PANEL_FRAG,
    transparent: true, depthWrite: true,
  }));
  head.add(mesh(facePanel(PANEL.w, PANEL.w * FACE_H / FACE_W, PANEL.y), panelMat, 4));

  let chNames = null, lastCh = null, scaleX = 1, scaleY = 1;
  const paint = ch => {
    const pose = facePose(ch);
    scaleX = pose.scale[0];
    scaleY = pose.scale[1];
    pose.scale = [1, 1]; // squash/stretch is applied to the whole 3D head instead
    for (const c of pose.cheeks) c.alpha = Math.max(0, c.alpha - 0.1) * 1.15; // no resting blush on a hologram
    fctx.clearRect(0, 0, faceCanvas.width, faceCanvas.height);
    fctx.drawImage(visor, 0, 0);
    paintFeatures(fctx, pose, FACE_STYLE, { clear: false });
    faceTex.needsUpdate = true;
  };
  const changed = ch => {
    if (!chNames) {
      chNames = Object.keys(ch);
      lastCh = new Float32Array(chNames.length).fill(-1);
    }
    let diff = false;
    for (let i = 0; i < chNames.length; i++) {
      const v = ch[chNames[i]] || 0;
      if (Math.abs(v - lastCh[i]) > REPAINT_EPS) { diff = true; lastCh[i] = v; }
    }
    return diff;
  };

  // Post: scene -> bloom chain -> composite
  const rtOpts = { type: THREE.UnsignedByteType, depthBuffer: false };
  const rtScene = keep(new THREE.WebGLRenderTarget(1, 1, { type: THREE.UnsignedByteType, samples: MSAA_SAMPLES }));
  const rtA1 = keep(new THREE.WebGLRenderTarget(1, 1, rtOpts)), rtB1 = keep(new THREE.WebGLRenderTarget(1, 1, rtOpts));
  const rtA2 = keep(new THREE.WebGLRenderTarget(1, 1, rtOpts)), rtB2 = keep(new THREE.WebGLRenderTarget(1, 1, rtOpts));
  const quadCam = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);
  const quad = new THREE.Mesh(keep(new THREE.PlaneGeometry(2, 2)));
  quad.frustumCulled = false;
  const passMat = (frag, uniforms) => keep(new THREE.ShaderMaterial({
    uniforms, vertexShader: QUAD_VERT, fragmentShader: frag, depthTest: false, depthWrite: false,
  }));
  const downMat = passMat(DOWN_FRAG, { tSrc: { value: null }, uTexel: { value: new THREE.Vector2() }, uThreshold: { value: 0.1 } });
  const blurMat = passMat(BLUR_FRAG, { tSrc: { value: null }, uDir: { value: new THREE.Vector2() } });
  const compMat = passMat(COMPOSITE_FRAG, {
    ...shared, tScene: { value: rtScene.texture }, tBloom1: { value: rtA1.texture }, tBloom2: { value: rtA2.texture },
    uRes: { value: new THREE.Vector2() },
  });
  const pass = (mat, target) => {
    quad.material = mat;
    renderer.setRenderTarget(target);
    renderer.render(quad, quadCam);
  };
  const down = (src, srcW, srcH, dst, threshold) => {
    downMat.uniforms.tSrc.value = src.texture;
    downMat.uniforms.uTexel.value.set(1 / srcW, 1 / srcH);
    downMat.uniforms.uThreshold.value = threshold;
    pass(downMat, dst);
  };
  const blur = (a, b, w, h) => {
    blurMat.uniforms.tSrc.value = a.texture;
    blurMat.uniforms.uDir.value.set(1 / w, 0);
    pass(blurMat, b);
    blurMat.uniforms.tSrc.value = b.texture;
    blurMat.uniforms.uDir.value.set(0, 1 / h);
    pass(blurMat, a);
  };

  let W = 1, H = 1, w1 = 1, h1 = 1, w2 = 1, h2 = 1;
  const resize = () => {
    const cw = container.clientWidth || innerWidth, chh = container.clientHeight || innerHeight;
    const pr = Math.min(devicePixelRatio || 1, PIXEL_RATIO_MAX);
    renderer.setPixelRatio(pr);
    renderer.setSize(cw, chh, false);
    W = Math.max(1, Math.round(cw * pr));
    H = Math.max(1, Math.round(chh * pr));
    w1 = Math.max(1, Math.round(W / BLOOM_DIV)); h1 = Math.max(1, Math.round(H / BLOOM_DIV));
    w2 = Math.max(1, Math.round(w1 / 2)); h2 = Math.max(1, Math.round(h1 / 2));
    rtScene.setSize(W, H);
    rtA1.setSize(w1, h1); rtB1.setSize(w1, h1);
    rtA2.setSize(w2, h2); rtB2.setSize(w2, h2);
    compMat.uniforms.uRes.value.set(W, H);
    dustMat.uniforms.uPx.value = pr * H / 600;

    const aspect = cw / chh, tan = Math.tan(THREE.MathUtils.degToRad(FOV / 2));
    const dist = Math.max(VIEW_H / (2 * tan), VIEW_W / (2 * tan * aspect));
    camera.aspect = aspect;
    camera.position.set(0, LOOK_AT_Y + CAM_RISE, dist);
    camera.lookAt(0, LOOK_AT_Y, 0);
    camera.updateProjectionMatrix();
  };
  resize();

  let yaw = 0, pitch = 0, sx = 1, sy = 1, flicker = 1;
  let nextIdleGlitch = performance.now() + 5000, idleGlitchAt = -1e9;

  return {
    update(state, now, dt) {
      const t = now / 1000;
      shared.uTime.value = t;
      if (changed(state.ch)) paint(state.ch);

      // Change burst: glitch + RGB split for ~0.4 s and a materialise sweep; rare idle micro-glitches.
      if (now > nextIdleGlitch) { idleGlitchAt = now; nextIdleGlitch = now + 4000 + Math.random() * 7000; }
      const sc = state.sinceChange;
      const burst = sc < 0.4 ? (1 - sc / 0.4) ** 1.5 : 0;
      const idle = now - idleGlitchAt < 110 ? 0.3 : 0;
      shared.uGlitch.value = Math.max(burst, idle);
      const sweepDur = 0.9, idleSweepPeriod = 6;
      const sp = sc < sweepDur ? sc / sweepDur : (t % idleSweepPeriod) / 1.4;
      shared.uSweep.value = sp <= 1 ? BASE_TOP + 0.3 + sp * (HEAD.y + HEAD.b + 0.4 - BASE_TOP) : 100;
      flicker += ((0.93 + 0.07 * Math.random()) - flicker) * Math.min(1, dt * 20);
      shared.uFlicker.value = flicker * (1 - 0.25 * burst);

      const k = 1 - Math.exp(-dt * 4.5);
      yaw += (state.gaze[0] * 0.5 - yaw) * k;
      pitch += (state.gaze[1] * 0.28 - pitch) * k;
      const ks = 1 - Math.exp(-dt * 14);
      sx += (1 + (scaleX - 1) * 1.6 - sx) * ks;
      sy += (1 + (scaleY - 1) * 1.6 - sy) * ks;
      // slow idle drift keeps the head visibly 3D while the gaze rests at centre
      head.rotation.set(-pitch + 0.03 * state.breath, yaw + 0.1 * Math.sin(t * 0.31) + 0.03 * Math.sin(t * 0.83), -yaw * 0.12 + 0.02 * Math.sin(t * 0.8));
      head.scale.set(sx, sy, sx);
      holo.position.y = 0.05 * state.breath + 0.015 * Math.sin(t * 1.7);

      earRingMat.uniforms.uBoost.value = 1 + 0.12 * state.breath + 0.7 * state.speech;
      const ringPulse = 1 + 0.12 * state.breath;
      discMat.uniforms.uRing.value = ringPulse;
      baseMat.uniforms.uRing.value = ringPulse;
      ringMat.uniforms.uBoost.value = ringPulse;

      renderer.setRenderTarget(rtScene);
      renderer.render(scene, camera);
      down(rtScene, W, H, rtA1, 0.1);
      blur(rtA1, rtB1, w1, h1);
      down(rtA1, w1, h1, rtA2, 0);
      blur(rtA2, rtB2, w2, h2);
      pass(compMat, null);
    },
    resize,
    dispose() {
      for (const d of disposables) d.dispose();
      renderer.setRenderTarget(null);
      renderer.dispose();
      renderer.forceContextLoss();
      canvas.remove();
    },
  };
}
