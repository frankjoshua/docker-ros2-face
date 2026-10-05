// Liquid glass: a chubby, iridescent jelly blob on a pastel backdrop.
// The face is painted onto an opaque milky core inside a transmissive shell, so three's transmission
// pass refracts it like something suspended in the glass; tears, sweat and sparkles ride on the surface.
import * as THREE from "three";
import { facePose, STAR_PATH } from "../pose.js";

// ---- quality / performance ----
const MAX_PIXEL_RATIO = 1.5;
const TEX_W = 1024;               // feature texture width; height follows the painted region's aspect
const BODY_SEGMENTS = [112, 80];
const DISPERSION = 0.25;          // chromatic split in the glass; 0 saves two transmission samples per pixel
const ENV_SIZE = 128;             // PMREM cube face size, built once
const BG_W = 512, BG_H = 300;

// ---- shape and layout (body units; the body is ~3.2 wide) ----
const RX = 1.62, RY = 1.2, RZ = 1.1, BOTTOM = 0.78;  // half-extents; the lower half is flattened
const ROUNDNESS = 2.35;           // superellipse exponent: 2 = ellipsoid, higher = boxier gumdrop
const CORE = 0.8;                 // milky core size relative to the shell
const K = 0.0102;                 // body units per face-space px
const FACE_Y0 = -0.2;             // body y of face-space centre (200,160)
const MOUTH_SCALE = 0.62, MOUTH_LIFT = 46;  // the board's mouth is smaller and higher than face space
const PUPIL = 1.58, PUPIL_TALL = 1.38;
const SHEEN = 0.55;               // strength of the rainbow rim
const TBX = 1.45, TBY0 = -1.0, TBY1 = 1.1;  // body rect covered by the feature texture

// ---- motion ----
const JELLY_K = 170, JELLY_C = 8;   // squash spring: underdamped so changes overshoot and wobble
const TURN_K = 55, TURN_C = 10;
const TAU = Math.PI * 2;

const INK = "#1b1730";

// surface ripple along the normal: x = amplitude, y = phase
const JELLY_GLSL = "uJelly.x * (sin(dot(position, vec3(2.1, 3.3, 1.3)) + uJelly.y) + 0.6 * sin(dot(position, vec3(-3.1, 1.7, 2.3)) - 1.37 * uJelly.y))";

export async function createLook(container, vocab) {
  const renderer = new THREE.WebGLRenderer({ antialias: true, powerPreference: "high-performance" });
  renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, MAX_PIXEL_RATIO));
  renderer.toneMapping = THREE.NeutralToneMapping;
  container.appendChild(renderer.domElement);

  const scene = new THREE.Scene();
  const camera = new THREE.PerspectiveCamera(26, 1, 0.1, 60);
  const textures = [];
  const track = t => (textures.push(t), t);

  const bgTex = track(new THREE.CanvasTexture(paintBackground()));
  bgTex.colorSpace = THREE.SRGBColorSpace;
  scene.background = bgTex;
  const envRT = buildEnvironment(renderer);
  scene.environment = envRT.texture;

  // ---- body ----
  const glassGeo = bodyGeometry();
  const coreGeo = glassGeo.clone();
  coreGeo.scale(CORE, CORE, CORE);
  planarUV(coreGeo, TBX, TBY0, TBY1);
  planarUV(glassGeo, RX * 1.08, -RY * BOTTOM, RY);

  const jelly = { value: new THREE.Vector3(0, 0, 0) }; // amplitude, phase, unused
  const wobble = shader => {
    shader.uniforms.uJelly = jelly;
    shader.vertexShader = "uniform vec3 uJelly;\n" + shader.vertexShader.replace("#include <begin_vertex>",
      `#include <begin_vertex>
      transformed += objectNormal * ${JELLY_GLSL};`);
  };

  // Thin in the middle so the face isn't lens-magnified, thick at the rim where the backdrop bends.
  const thickTex = track(new THREE.CanvasTexture(paintThickness()));
  const glassMat = new THREE.MeshPhysicalMaterial({
    color: 0xffffff, metalness: 0, roughness: 0.08, transmission: 1, ior: 1.36,
    thickness: 1.5, thicknessMap: thickTex,
    iridescence: 1, iridescenceIOR: 1.32, iridescenceThicknessRange: [180, 780],
    clearcoat: 1, clearcoatRoughness: 0.05, specularIntensity: 1,
    attenuationColor: new THREE.Color(0xe7dcff), attenuationDistance: 2.5,
    dispersion: DISPERSION, envMapIntensity: 1.25,
  });
  glassMat.onBeforeCompile = wobble;

  const featCanvas = document.createElement("canvas");
  const P = TEX_W / (2 * TBX);
  featCanvas.width = TEX_W;
  featCanvas.height = Math.round(P * (TBY1 - TBY0));
  const featCtx = featCanvas.getContext("2d");
  const featTex = track(new THREE.CanvasTexture(featCanvas));
  featTex.colorSpace = THREE.SRGBColorSpace;
  featTex.anisotropy = 4;
  const coreMat = new THREE.MeshStandardMaterial({
    map: featTex, roughness: 0.5, metalness: 0,
    emissive: 0xffffff, emissiveMap: featTex, emissiveIntensity: 0.32, envMapIntensity: 0.85,
  });
  coreMat.onBeforeCompile = wobble;

  const rig = new THREE.Group();        // pivot on the floor: squash/stretch and rocking happen about the base
  const body = new THREE.Group();
  body.position.y = RY * BOTTOM;
  rig.add(body);
  scene.add(rig);
  const glass = new THREE.Mesh(glassGeo, glassMat);
  const core = new THREE.Mesh(coreGeo, coreMat);
  // three's thin-film term is subtle at real-time env resolution; this additive fresnel shell paints
  // the board's rainbow rim streaks on top and lets them drift
  const sheenMat = new THREE.ShaderMaterial({
    uniforms: { uJelly: jelly, uTime: { value: 0 }, uGain: { value: SHEEN } },
    transparent: true, depthWrite: false, blending: THREE.AdditiveBlending,
    vertexShader: `uniform vec3 uJelly; varying vec3 vN, vV, vP;
      void main() {
        vec3 p = position + normal * ${JELLY_GLSL};
        vec4 mv = modelViewMatrix * vec4(p, 1.0);
        vN = normalize(normalMatrix * normal); vV = normalize(-mv.xyz); vP = position;
        gl_Position = projectionMatrix * mv;
      }`,
    fragmentShader: `uniform float uTime, uGain; varying vec3 vN, vV, vP;
      vec3 hue(float h) { return clamp(abs(fract(h + vec3(0.0, 2.0 / 3.0, 1.0 / 3.0)) * 6.0 - 3.0) - 1.0, 0.0, 1.0); }
      void main() {
        float f = 1.0 - max(dot(normalize(vN), normalize(vV)), 0.0);
        float rim = pow(f, 2.4);
        float streak = 0.5 + 0.5 * sin(vP.y * 4.0 + vP.x * 2.5 + uTime * 0.5) * sin(vP.x * 3.3 - vP.y * 1.7 - uTime * 0.37);
        vec3 c = mix(vec3(1.0), hue(f * 1.3 + vP.y * 0.22 + vP.x * 0.12 + uTime * 0.03), 0.7);
        gl_FragColor = vec4(c * rim * (0.35 + streak) * uGain, 1.0);
      }`,
  });
  const sheen = new THREE.Mesh(glassGeo, sheenMat);
  sheen.renderOrder = 5;
  body.add(core, glass, sheen);

  // contact shadow with a faint caustic where the glass focuses light
  const shadowTex = track(new THREE.CanvasTexture(paintShadow()));
  shadowTex.colorSpace = THREE.SRGBColorSpace;
  const shadow = new THREE.Mesh(new THREE.PlaneGeometry(1, 1),
    new THREE.MeshBasicMaterial({ map: shadowTex, transparent: true, depthWrite: false, toneMapped: false }));
  shadow.rotation.x = -Math.PI / 2;
  shadow.position.y = 0.004;
  scene.add(shadow);

  // ---- surface effects (sprites in body space) ----
  const dropTex = track(new THREE.CanvasTexture(paintDrop()));
  dropTex.colorSpace = THREE.SRGBColorSpace;
  const starTex = track(new THREE.CanvasTexture(paintStar()));
  starTex.colorSpace = THREE.SRGBColorSpace;
  const sprite = map => {
    const s = new THREE.Sprite(new THREE.SpriteMaterial({ map, transparent: true, depthTest: false, depthWrite: false, toneMapped: false }));
    s.renderOrder = 10;
    s.visible = false;
    body.add(s);
    return s;
  };
  const tearSprites = [sprite(dropTex), sprite(dropTex)];
  const fallSprites = [sprite(dropTex), sprite(dropTex)];
  const sweatSprite = sprite(dropTex);
  const starSprites = [sprite(starTex), sprite(starTex)];
  for (const s of [...tearSprites, ...fallSprites, sweatSprite]) s.center.set(0.5, 1);

  const bx = fx => (fx - 200) * K;
  const by = fy => FACE_Y0 - (fy - 160) * K;
  const frontZ = (x, y) => {
    const e = ROUNDNESS, ry = y < 0 ? RY * BOTTOM : RY;
    const r = 1 - Math.abs(x / RX) ** e - Math.abs(y / ry) ** e;
    return RZ * Math.max(0, r) ** (1 / e) + 0.06;
  };
  const place = (s, fx, fy) => {
    const x = bx(fx), y = by(fy);
    s.position.set(x, y, frontZ(x, y));
  };

  // ---- painting ----
  const paint = createPainter(featCtx, P);

  // ---- state ----
  const names = vocab.channels;
  const paints = names.map(n => n !== "squash" && n !== "stretch"); // squash/stretch move the body, not the paint
  let poseKey = NaN, paintKey = NaN, pose = null;
  let jy = 1, jv = 0, lastSince = Infinity, ripple = 0, phase = 0;
  let ryaw = 0, vyaw = 0, rpitch = 0, vpitch = 0;
  let disposed = false;

  function resize() {
    const w = Math.max(1, container.clientWidth), h = Math.max(1, container.clientHeight);
    renderer.setSize(w, h, false);
    camera.aspect = w / h;
    // fit the blob (plus its jelly overshoot and a sliver of floor) into whichever axis is tighter
    const t = Math.tan(THREE.MathUtils.degToRad(camera.fov / 2));
    const halfH = 1.25, halfW = RX * 1.16;
    const dist = Math.max(halfH / t, halfW / (t * camera.aspect)) + RZ;
    const cy = RY * BOTTOM + 0.1;
    camera.position.set(0, cy + 0.22, dist);
    camera.lookAt(0, cy, 0);
    camera.updateProjectionMatrix();
  }
  resize();

  function update(state, now, dt) {
    if (disposed) return;
    const ch = state.ch;
    let hp = 0, hf = 0;
    for (let i = 0; i < names.length; i++) {
      const q = Math.round((ch[names[i]] || 0) * 512);
      hf = (Math.imul(hf, 31) + q) | 0;
      if (paints[i]) hp = (Math.imul(hp, 31) + q) | 0;
    }
    if (hf !== poseKey || !pose) {
      poseKey = hf;
      pose = facePose(ch);
      if (hp !== paintKey) {
        paintKey = hp;
        paint(pose);
        featTex.needsUpdate = true;
      }
      layoutEffects(pose);
    }

    // jelly: one damped spring on vertical stretch, volume roughly preserved sideways
    if (state.sinceChange < lastSince - 1e-3) { jv -= 1.9; ripple = 1; }
    lastSince = state.sinceChange;
    const target = pose.scale[1] * (1 + 0.016 * state.breath + 0.055 * state.speech);
    const steps = dt > 0.02 ? Math.ceil(dt / 0.016) : 1, h = dt / steps;
    for (let i = 0; i < steps; i++) {
      jv += (JELLY_K * (target - jy) - JELLY_C * jv) * h;
      jy += jv * h;
      vyaw += (TURN_K * (state.gaze[0] * 0.34 - ryaw) - TURN_C * vyaw) * h;
      ryaw += vyaw * h;
      vpitch += (TURN_K * (-state.gaze[1] * 0.13 - rpitch) - TURN_C * vpitch) * h;
      rpitch += vpitch * h;
    }
    const puff = ch.cheekPuff || 0;
    const side = pose.scale[0] * Math.sqrt(pose.scale[1] / Math.max(0.5, jy));
    rig.scale.set(side * (1 + 0.06 * puff), jy, side * (1 + 0.03 * puff));
    rig.rotation.set(rpitch, ryaw, -0.05 * vyaw + 0.012 * state.breath);
    rig.position.x = 0.12 * ryaw;
    shadow.scale.set(RX * 2.7 * side * (1 + 0.06 * puff), RZ * 2.5 * side, 1);
    shadow.position.x = rig.position.x;
    shadow.material.opacity = 1 - 0.25 * Math.max(0, jy - 1);

    ripple *= Math.exp(-2.6 * dt);
    phase += dt * (5 + 7 * ripple);
    jelly.value.set(0.006 + 0.004 * state.speech + 0.04 * ripple, phase, 0);

    // liquid shimmer: the reflections drift and the thin-film colours breathe
    scene.environmentRotation.y = 0.5 * Math.sin(now * 0.00011) + 0.35 * ryaw;
    glassMat.iridescenceThicknessRange[1] = 760 + 140 * Math.sin(now * 0.0006) + 120 * ripple;
    sheenMat.uniforms.uTime.value = now / 1000 + 3 * ripple;
    sheenMat.uniforms.uGain.value = SHEEN * (1 + 0.8 * ripple);

    animateEffects(pose, now);
    renderer.render(scene, camera);
  }

  function layoutEffects(p) {
    for (let i = 0; i < 2; i++) {
      const t = p.tears[i], s = tearSprites[i];
      s.visible = !!t;
      if (t) {
        place(s, t.x, t.y0);
        s.scale.set(17 * K, t.len * K, 1);
        s.material.opacity = t.alpha;
      }
    }
    sweatSprite.visible = !!p.sweat;
    if (p.sweat) {
      place(sweatSprite, p.sweat.x, p.sweat.y0);
      sweatSprite.scale.set(19 * K, p.sweat.len * K * 1.1, 1);
      sweatSprite.material.opacity = p.sweat.alpha;
    }
  }

  function animateEffects(p, now) {
    for (let i = 0; i < 2; i++) {
      const t = p.tears[i], s = fallSprites[i];
      s.visible = !!t && t.alpha > 0.55;
      if (s.visible) {
        const k = (now / 1300 + i * 0.47) % 1;
        place(s, t.x, t.y0 + t.len - 6 + k * 46);
        s.scale.set(13 * K, 16 * K, 1);
        s.material.opacity = (t.alpha - 0.55) * 2.2 * Math.min(1, k * 6) * (1 - k);
      }
      const sp = p.sparkles[i], st = starSprites[i];
      st.visible = !!sp;
      if (sp) {
        place(st, sp.x, sp.y);
        const tw = 0.8 + 0.2 * Math.sin(now * 0.007 + i * 2.1);
        st.scale.setScalar(0.58 * sp.s * tw);
        st.material.rotation = 0.25 * Math.sin(now * 0.0013 + i);
      }
    }
    if (sweatSprite.visible) {
      // a slow slide down and back keeps the drop alive
      const k = 0.5 + 0.5 * Math.sin(now * 0.0021);
      place(sweatSprite, p.sweat.x, p.sweat.y0 + 6 * k);
    }
  }

  return {
    update,
    resize,
    dispose() {
      disposed = true;
      scene.traverse(o => {
        o.geometry?.dispose();
        o.material?.dispose();
      });
      for (const t of textures) t.dispose();
      envRT.dispose();
      renderer.dispose();
      renderer.forceContextLoss();
      renderer.domElement.remove();
    },
  };
}

// ---- geometry ----

function bodyGeometry() {
  // seam at the back (phiStart 1.5π) so it never crosses the face
  const g = new THREE.SphereGeometry(1, BODY_SEGMENTS[0], BODY_SEGMENTS[1], Math.PI * 1.5);
  const p = g.attributes.position;
  const e = ROUNDNESS;
  for (let i = 0; i < p.count; i++) {
    let x = p.getX(i), y = p.getY(i), z = p.getZ(i);
    const r = (Math.abs(x) ** e + Math.abs(y) ** e + Math.abs(z) ** e) ** (-1 / e);
    x *= r; y *= r; z *= r;
    const w = 1 + 0.05 * (0.2 - y);   // fuller low, like a gumdrop settling under its own weight
    p.setXYZ(i, x * RX * w, y * (y < 0 ? RY * BOTTOM : RY), z * RZ * w);
  }
  g.computeVertexNormals();
  weldNormals(g);
  return g;
}

// SphereGeometry duplicates vertices along the seam and at the poles; average their normals so the
// glass shows no crease in its reflections.
function weldNormals(g) {
  const p = g.attributes.position.array, n = g.attributes.normal.array, acc = new Map();
  const key = i => `${Math.round(p[i] * 1e4)},${Math.round(p[i + 1] * 1e4)},${Math.round(p[i + 2] * 1e4)}`;
  for (let i = 0; i < p.length; i += 3) {
    const k = key(i), a = acc.get(k);
    if (a) { a[0] += n[i]; a[1] += n[i + 1]; a[2] += n[i + 2]; } else acc.set(k, [n[i], n[i + 1], n[i + 2]]);
  }
  for (let i = 0; i < p.length; i += 3) {
    const a = acc.get(key(i)), l = Math.hypot(a[0], a[1], a[2]) || 1;
    n[i] = a[0] / l; n[i + 1] = a[1] / l; n[i + 2] = a[2] / l;
  }
}

// front-on planar projection onto [-hx, hx] x [y0, y1]; the back gets an unseen mirror
function planarUV(g, hx, y0, y1) {
  const p = g.attributes.position, uv = g.attributes.uv;
  for (let i = 0; i < p.count; i++) {
    uv.setXY(i, (p.getX(i) + hx) / (2 * hx), (p.getY(i) - y0) / (y1 - y0));
  }
  uv.needsUpdate = true;
}

function buildEnvironment(renderer) {
  const s = new THREE.Scene();
  const sky = new THREE.Mesh(new THREE.SphereGeometry(20, 48, 24), new THREE.ShaderMaterial({
    side: THREE.BackSide, depthWrite: false,
    vertexShader: "varying vec3 vDir; void main(){ vDir = normalize(position); gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }",
    fragmentShader: `varying vec3 vDir;
      void main(){
        float y = vDir.y;
        vec3 top = vec3(0.42, 0.46, 1.0), hor = vec3(1.0, 0.72, 0.62), low = vec3(0.62, 0.48, 0.85);
        vec3 c = y > 0.0 ? mix(hor, top, pow(y, 0.55)) : mix(hor, low, pow(-y, 0.45));
        c = mix(c, vec3(0.55, 0.85, 1.0), 0.35 * smoothstep(0.1, 0.9, -vDir.x) * (1.0 - abs(y)));
        c = mix(c, vec3(1.0, 0.6, 0.8), 0.35 * smoothstep(0.1, 0.9, vDir.x) * (1.0 - abs(y)));
        gl_FragColor = vec4(c * 0.85, 1.0);
      }`,
  }));
  s.add(sky);
  // bright panels become the long soft highlights and the coloured rim glints
  const panel = (w, h, color, gain, x, y, z) => {
    const m = new THREE.Mesh(new THREE.PlaneGeometry(w, h),
      new THREE.MeshBasicMaterial({ color: new THREE.Color(color).multiplyScalar(gain), side: THREE.DoubleSide }));
    m.position.set(x, y, z);
    m.lookAt(0, 0, 0);
    s.add(m);
  };
  panel(9, 3, 0xffffff, 4.5, -2, 9, 5);     // key softbox above front-left
  panel(2, 8, 0xffd2c0, 3.2, 9, 1, -1);     // warm right strip
  panel(2, 8, 0xa8d8ff, 3.2, -9, 0.5, -1);  // cool left strip
  panel(8, 2, 0xffc6ec, 2.0, 0, -6, 6);     // pink floor bounce
  panel(3, 3, 0xffffff, 3.0, 5, 5, 8);      // small front-right catchlight
  panel(10, 2, 0xd9c8ff, 2.0, 0, 3, -9);    // back rim
  const pm = new THREE.PMREMGenerator(renderer);
  const rt = pm.fromScene(s, 0.02, 0.1, 50, { size: ENV_SIZE });
  pm.dispose();
  s.traverse(o => { o.geometry?.dispose(); o.material?.dispose(); });
  return rt;
}

// ---- canvases ----

function paintBackground() {
  const c = document.createElement("canvas");
  c.width = BG_W; c.height = BG_H;
  const g = c.getContext("2d");
  let gr = g.createLinearGradient(0, 0, BG_W, BG_H * 0.6);
  gr.addColorStop(0, "#9aa6ee");
  gr.addColorStop(0.45, "#c4b7ef");
  gr.addColorStop(0.8, "#f1c9d8");
  gr.addColorStop(1, "#fbd8c6");
  g.fillStyle = gr;
  g.fillRect(0, 0, BG_W, BG_H);
  // warm horizon haze and a pale floor
  gr = g.createLinearGradient(0, BG_H * 0.55, 0, BG_H);
  gr.addColorStop(0, "rgba(255,226,214,0)");
  gr.addColorStop(0.55, "rgba(255,226,220,0.55)");
  gr.addColorStop(1, "rgba(200,190,245,0.55)");
  g.fillStyle = gr;
  g.fillRect(0, 0, BG_W, BG_H);
  gr = g.createRadialGradient(BG_W * 0.85, BG_H * 0.3, 0, BG_W * 0.85, BG_H * 0.3, BG_W * 0.45);
  gr.addColorStop(0, "rgba(255,228,206,0.7)");
  gr.addColorStop(1, "rgba(255,228,206,0)");
  g.fillStyle = gr;
  g.fillRect(0, 0, BG_W, BG_H);
  // dither against banding on 8-bit panels
  const img = g.getImageData(0, 0, BG_W, BG_H), d = img.data;
  for (let i = 0; i < d.length; i += 4) {
    const n = (Math.random() - 0.5) * 3;
    d[i] += n; d[i + 1] += n; d[i + 2] += n;
  }
  g.putImageData(img, 0, 0);
  return c;
}

// thicknessMap reads green; uv spans the body's bounding box, so a centred circle traces its outline
function paintThickness() {
  const c = document.createElement("canvas");
  c.width = c.height = 128;
  const g = c.getContext("2d");
  const gr = g.createRadialGradient(64, 64, 0, 64, 64, 64);
  gr.addColorStop(0, "rgb(0,12,0)");
  gr.addColorStop(0.7, "rgb(0,22,0)");
  gr.addColorStop(0.9, "rgb(0,120,0)");
  gr.addColorStop(1, "rgb(0,255,0)");
  g.fillStyle = gr;
  g.fillRect(0, 0, 128, 128);
  return c;
}

function paintShadow() {
  const c = document.createElement("canvas");
  c.width = c.height = 256;
  const g = c.getContext("2d");
  const gr = g.createRadialGradient(128, 128, 0, 128, 128, 128);
  gr.addColorStop(0, "rgba(255,236,250,0.45)");
  gr.addColorStop(0.3, "rgba(150,120,210,0.32)");
  gr.addColorStop(0.55, "rgba(80,60,140,0.28)");
  gr.addColorStop(1, "rgba(80,60,140,0)");
  g.fillStyle = gr;
  g.fillRect(0, 0, 256, 256);
  return c;
}

function paintDrop() {
  const c = document.createElement("canvas");
  c.width = 64; c.height = 128;
  const g = c.getContext("2d");
  const d = new Path2D("M32,3 C58,70 58,125 32,125 C6,125 6,70 32,3Z");
  const gr = g.createLinearGradient(0, 0, 64, 128);
  gr.addColorStop(0, "rgba(190,230,255,0.75)");
  gr.addColorStop(1, "rgba(80,150,250,0.9)");
  g.fillStyle = gr;
  g.fill(d);
  g.lineWidth = 4;
  g.strokeStyle = "rgba(40,80,190,0.85)";
  g.stroke(d);
  g.fillStyle = "rgba(255,255,255,0.95)";
  g.beginPath();
  g.ellipse(23, 92, 6, 13, 0.35, 0, TAU);
  g.fill();
  return c;
}

function paintStar() {
  const c = document.createElement("canvas");
  c.width = c.height = 128;
  const g = c.getContext("2d");
  const gr = g.createRadialGradient(64, 64, 0, 64, 64, 64);
  gr.addColorStop(0, "rgba(255,240,250,0.9)");
  gr.addColorStop(0.3, "rgba(255,170,215,0.35)");
  gr.addColorStop(1, "rgba(255,170,215,0)");
  g.fillStyle = gr;
  g.fillRect(0, 0, 128, 128);
  g.translate(64, 64);
  g.scale(5.6, 5.6);
  const star = new Path2D(STAR_PATH);
  g.lineWidth = 1.2;
  g.lineJoin = "round";
  g.strokeStyle = "rgba(255,150,200,0.9)";
  g.stroke(star);
  g.fillStyle = "#ffffff";
  g.fill(star);
  return c;
}

// Paints the face onto the core texture. Geometry comes from the pose; this only adds the
// glassy rendering: recessed sockets, glossy jelly-bean pupils, a dark rounded mouth.
function createPainter(ctx, P) {
  const W = ctx.canvas.width, H = ctx.canvas.height, PK = P * K;
  const base = ctx.createRadialGradient(W * 0.5, H * 0.38, 0, W * 0.5, H * 0.45, W * 0.55);
  base.addColorStop(0, "#f1efff");
  base.addColorStop(0.6, "#dcd9f6");
  base.addColorStop(1, "#c3c4ee");
  // Soft inner shade as stacked translucent strokes, shifted down so it pools under the upper edge.
  // (Canvas shadowBlur inside a clip blanked the whole canvas in Chrome, so it is avoided.)
  const innerShade = (paths, rgb, alpha, width, dy) => {
    ctx.save();
    ctx.translate(0, dy);
    for (let i = 0; i < 4; i++) {
      ctx.strokeStyle = `rgba(${rgb},${alpha})`;
      ctx.lineWidth = width * (1 - i * 0.22);
      for (const p of paths) ctx.stroke(p);
    }
    ctx.restore();
  };

  return function paint(pose) {
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.fillStyle = base;
    ctx.fillRect(0, 0, W, H);
    ctx.setTransform(PK, 0, 0, PK, P * TBX - 200 * PK, P * (TBY1 - FACE_Y0) - 160 * PK);
    ctx.lineCap = "round";
    ctx.lineJoin = "round";

    for (const c of pose.cheeks) {
      const a = Math.min(1, Math.max(0, (c.alpha - 0.1) / 0.75));
      if (a <= 0.01) continue;
      ctx.save();
      ctx.translate(c.cx, c.cy + 6);
      ctx.scale(1.25, 1.25 * c.ry / c.rx);
      const gr = ctx.createRadialGradient(0, 0, 0, 0, 0, c.rx * 1.25);
      gr.addColorStop(0, `rgba(255,120,170,${0.75 * a})`);
      gr.addColorStop(0.6, `rgba(255,140,185,${0.35 * a})`);
      gr.addColorStop(1, "rgba(255,150,190,0)");
      ctx.fillStyle = gr;
      ctx.beginPath();
      ctx.arc(0, 0, c.rx * 1.25, 0, TAU);
      ctx.fill();
      ctx.restore();
    }

    const sparkle = pose.fx.sparkle;
    for (const e of pose.eyes) {
      const lid = new Path2D(e.lidPath);
      const ball = new Path2D();
      ball.ellipse(e.cx, e.cy, e.rx, e.ry, 0, 0, TAU);
      if (e.blink < 0.97) {
        ctx.save();
        ctx.clip(lid);
        // socket lip: pale bevel below, soft shade above, so the opening reads as pressed in
        ctx.fillStyle = "rgba(255,255,255,0.85)";
        ctx.beginPath(); ctx.ellipse(e.cx, e.cy + 3, e.rx + 3.5, e.ry + 3, 0, 0, TAU); ctx.fill();
        ctx.fillStyle = "rgba(120,110,185,0.55)";
        ctx.beginPath(); ctx.ellipse(e.cx, e.cy - 2.5, e.rx + 2.5, e.ry + 2.5, 0, 0, TAU); ctx.fill();
        ctx.clip(ball);
        let gr = ctx.createLinearGradient(0, e.cy - e.ry, 0, e.cy + e.ry);
        gr.addColorStop(0, "#cfcbef");
        gr.addColorStop(0.5, "#eeedfc");
        gr.addColorStop(1, "#fbfbff");
        ctx.fillStyle = gr;
        ctx.fillRect(e.cx - e.rx - 2, e.cy - e.ry - 2, 2 * e.rx + 4, 2 * e.ry + 4);

        const prx = e.pr * PUPIL, pry = prx * PUPIL_TALL;
        gr = ctx.createLinearGradient(0, e.py - pry, 0, e.py + pry);
        gr.addColorStop(0, "#04040c");
        gr.addColorStop(0.55, "#12122a");
        gr.addColorStop(1, "#3a4a92");
        ctx.fillStyle = gr;
        ctx.beginPath(); ctx.ellipse(e.px, e.py, prx, pry, 0, 0, TAU); ctx.fill();
        ctx.fillStyle = "#ffffff";
        ctx.beginPath();
        ctx.ellipse(e.px + 0.36 * prx, e.py - 0.42 * pry, (0.24 + 0.08 * sparkle) * prx, (0.3 + 0.08 * sparkle) * pry, -0.45, 0, TAU);
        ctx.fill();
        ctx.fillStyle = "rgba(255,255,255,0.8)";
        ctx.beginPath(); ctx.arc(e.px - 0.38 * prx, e.py + 0.5 * pry, (0.08 + 0.06 * sparkle) * prx, 0, TAU); ctx.fill();

        innerShade([ball, lid], "70,60,130", 0.07, 18, 3.5);
        ctx.strokeStyle = INK;
        ctx.lineWidth = 9;
        ctx.stroke(lid);
        ctx.restore();
      }
      if (e.blink > 0.75) {
        ctx.globalAlpha = Math.min(1, (e.blink - 0.75) * 4);
        ctx.strokeStyle = "rgba(255,255,255,0.8)";
        ctx.lineWidth = 9;
        ctx.save(); ctx.translate(0, 3); ctx.stroke(new Path2D(e.closedPath)); ctx.restore();
        ctx.strokeStyle = INK;
        ctx.lineWidth = 7.5;
        ctx.stroke(new Path2D(e.closedPath));
        ctx.globalAlpha = 1;
      }
    }

    ctx.strokeStyle = "rgba(90,80,150,0.6)";
    ctx.lineWidth = 3.5;
    for (const w of pose.nose.wrinkles) { ctx.globalAlpha = w.alpha; ctx.stroke(new Path2D(w.path)); }
    if (pose.chin.alpha > 0.25) {
      ctx.globalAlpha = pose.chin.alpha * 0.6;
      ctx.lineWidth = pose.chin.width;
      ctx.save();
      ctx.translate(200, 214 - MOUTH_LIFT); ctx.scale(MOUTH_SCALE, MOUTH_SCALE); ctx.translate(-200, -214);
      ctx.stroke(new Path2D(pose.chin.path));
      ctx.restore();
    }
    ctx.globalAlpha = 1;

    const m = pose.mouth;
    ctx.save();
    ctx.translate(200, 214 - MOUTH_LIFT);
    ctx.scale(MOUTH_SCALE, MOUTH_SCALE);
    ctx.translate(-200, -214);
    if (!m.open) {
      const line = new Path2D(m.linePath), w = 11 + 2.2 * m.width;
      ctx.save();
      ctx.translate(0, 4);
      ctx.strokeStyle = "rgba(255,255,255,0.8)";
      ctx.lineWidth = w + 4;
      ctx.stroke(line);
      ctx.restore();
      ctx.strokeStyle = INK;
      ctx.lineWidth = w;
      ctx.stroke(line);
    } else {
      const open = new Path2D(m.openPath);
      ctx.save();
      ctx.translate(0, 4);
      ctx.strokeStyle = "rgba(255,255,255,0.8)";
      ctx.lineWidth = 10;
      ctx.stroke(open);
      ctx.restore();
      ctx.strokeStyle = INK;
      ctx.lineWidth = 8;
      ctx.stroke(open);
      ctx.save();
      ctx.clip(open);
      const gr = ctx.createLinearGradient(0, m.uY, 0, m.lY + 10);
      gr.addColorStop(0, "#120e22");
      gr.addColorStop(1, "#3a2c58");
      ctx.fillStyle = gr;
      ctx.fillRect(m.mx - 120, m.uY - 30, 240, m.lY - m.uY + 80);
      if (m.upperTeeth > 0.05) { ctx.fillStyle = "#f6f4ff"; ctx.fillRect(m.mx - 90, m.uY - 12, 180, 12 + 14 * m.upperTeeth); }
      if (m.lowerTeeth > 0) { ctx.fillStyle = "#f6f4ff"; ctx.fillRect(m.mx - 90, m.lY - 6 - 14 * m.lowerTeeth, 180, 30); }
      if (m.innerTongue) {
        ctx.fillStyle = "#ef8fb0";
        ctx.beginPath(); ctx.ellipse(m.mx + m.jawShift, m.lY + 4, 26, 13, 0, 0, TAU); ctx.fill();
      }
      innerShade([open], "8,4,20", 0.22, 20, 4);
      ctx.restore();
    }
    if (m.tongueOut > 0) {
      ctx.fillStyle = "#ef8fb0";
      ctx.strokeStyle = INK;
      ctx.lineWidth = 4;
      ctx.beginPath();
      ctx.ellipse(m.mx + m.jawShift, m.lY + 6 + 10 * m.tongueOut, 17, 6 + 12 * m.tongueOut, 0, 0, TAU);
      ctx.fill();
      ctx.stroke();
    }
    ctx.strokeStyle = "rgba(80,70,140,0.75)";
    ctx.lineWidth = 5;
    for (const mk of m.marks) { ctx.globalAlpha = mk.alpha; ctx.stroke(new Path2D(mk.path)); }
    ctx.globalAlpha = 1;
    ctx.restore();
  };
}
