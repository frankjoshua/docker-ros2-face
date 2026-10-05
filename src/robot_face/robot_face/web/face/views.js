// Diagnostics and map views, layered over the face. Colours come from the active look's theme
// (CSS custom properties in ui.css keyed off <html data-look>), so they restyle on a look switch.

const DIAG_RENDER_INTERVAL_MS = 300; // caps rendering work for frequent diagnostics updates
const LEVELS = ["OK", "Warning", "Error", "Stale"];

const el = (tag, className = "", text = "") => {
  const e = document.createElement(tag);
  e.className = className;
  e.textContent = text;
  return e;
};

export function createViews() {
  const root = document.createElement("div");
  root.innerHTML = `
    <div id="diag-layer" class="view" hidden>
      <header class="diag-toolbar">
        <button id="diag-back" class="nav-button">&larr; Face</button>
        <div class="diag-heading">
          <h1 class="diag-header">Diagnostics</h1>
          <p class="diag-hint">Tap an entry to show or hide details</p>
        </div>
        <button id="diag-map-btn" class="nav-button primary">Map &rarr;</button>
      </header>
      <div id="diag-list"></div>
    </div>
    <div id="map-layer" class="view" hidden>
      <canvas id="map-canvas"></canvas>
      <div class="map-toolbar">
        <button id="map-back" class="nav-button">&larr; Diagnostics</button>
        <button id="map-face" class="nav-button">Face</button>
      </div>
      <div id="map-empty">No map data</div>
      <div id="map-legend"><span class="robot">▲ Robot</span><span class="goal">⊕ Goal</span><span class="path">━ Path</span></div>
    </div>`;
  document.body.append(...root.children);

  const $ = id => document.getElementById(id);
  const diagLayer = $("diag-layer"), diagList = $("diag-list");
  const mapLayer = $("map-layer"), mapCanvas = $("map-canvas"), mapEmpty = $("map-empty");
  const mapCtx = mapCanvas.getContext("2d");

  let current = null;
  function open(view) {
    current = view;
    diagLayer.hidden = view !== "diagnostics";
    mapLayer.hidden = view !== "map";
    if (view) document.body.dataset.view = view;
    else delete document.body.dataset.view;
    if (view === "diagnostics") renderDiagnostics();
    if (view === "map") { mapEmpty.hidden = !!mapBitmap; drawMap(); }
  }
  $("diag-back").addEventListener("click", () => open(null));
  $("diag-map-btn").addEventListener("click", () => open("map"));
  $("map-back").addEventListener("click", () => open("diagnostics"));
  $("map-face").addEventListener("click", () => open(null));
  addEventListener("keydown", e => {
    if (e.key === "Escape" && current) open(current === "map" ? "diagnostics" : null);
  });

  // ---- diagnostics ----
  let diagnostics = [], diagTimer = null;
  const diagRows = new Map();

  function scheduleDiagRender() {
    if (diagLayer.hidden || diagTimer) return;
    diagTimer = setTimeout(() => { diagTimer = null; renderDiagnostics(); }, DIAG_RENDER_INTERVAL_MS);
  }

  function renderDiagnostics() {
    if (!diagnostics.length) {
      diagList.replaceChildren(el("div", "", "No diagnostics data yet"));
      diagList.firstChild.id = "diag-empty";
      diagRows.clear();
      return;
    }
    $("diag-empty")?.remove();
    const names = new Set(diagnostics.map(s => s.name));
    for (const [name, row] of diagRows) {
      if (!names.has(name)) { row.remove(); diagRows.delete(name); }
    }
    diagnostics.forEach((s, index) => {
      let row = diagRows.get(s.name);
      if (!row) {
        // Keep these nodes across updates so tapping, focus, and open state survive.
        row = document.createElement("details");
        const summary = document.createElement("summary");
        const text = document.createElement("span");
        text.append(el("span", "diag-name"), el("span", "diag-msg"));
        const dot = el("span", "diag-dot");
        dot.setAttribute("aria-hidden", "true");
        summary.append(dot, text, el("span", "diag-level"));
        row.append(summary, el("div", "diag-body"));
        diagRows.set(s.name, row);
      }
      row.className = `diag-row level-${s.level}`;
      row.querySelector(".diag-name").textContent = s.name;
      row.querySelector(".diag-msg").textContent = s.message;
      row.querySelector(".diag-level").textContent = LEVELS[s.level] || "Unknown";
      const content = [];
      if (s.hardware_id) content.push(el("div", "diag-hw", `Hardware: ${s.hardware_id}`));
      if (s.values.length) {
        const values = el("dl", "diag-kvs");
        for (const [k, v] of s.values) values.append(el("dt", "", k), el("dd", "", v));
        content.push(values);
      }
      if (!content.length) content.push(el("div", "", "No additional details"));
      row.querySelector(".diag-body").replaceChildren(...content);
      if (diagList.children[index] !== row) diagList.insertBefore(row, diagList.children[index] || null);
    });
  }

  // ---- map ----
  let mapMsg = null;     // last /map payload, kept so a theme change can recolour it
  let mapInfo = null;    // {resolution, width, height, origin}
  let mapBitmap = null;  // offscreen canvas holding the pre-rendered grid
  let mapDraw = null;    // {scale, offsetX, offsetY}: map-pixel <-> canvas-pixel
  let robotPose = null, goalPosition = null, plannedPath = [];
  let theme = null;

  const hexRGB = hex => {
    const n = parseInt(hex.trim().replace("#", ""), 16);
    return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
  };
  function readTheme() {
    const css = getComputedStyle(document.documentElement);
    const v = name => css.getPropertyValue(name).trim();
    theme = {
      bg: v("--map-bg"), free: hexRGB(v("--map-free")), unknown: hexRGB(v("--map-unknown")),
      occupied: hexRGB(v("--map-occupied")), robot: v("--map-robot"), goal: v("--map-goal"),
      path: v("--map-path"), grid: v("--map-grid"), glow: parseFloat(v("--map-glow")) || 0,
    };
  }

  function renderMap(m) {
    mapMsg = m;
    mapInfo = { resolution: m.resolution, width: m.width, height: m.height, origin: m.origin };
    const raw = atob(m.data);
    const cells = new Int8Array(raw.length);
    for (let i = 0; i < raw.length; i++) cells[i] = raw.charCodeAt(i); // Int8Array wraps 255 to -1 (unknown)
    const off = document.createElement("canvas");
    off.width = m.width;
    off.height = m.height;
    const octx = off.getContext("2d");
    const img = octx.createImageData(m.width, m.height);
    for (let row = 0; row < m.height; row++) {
      for (let col = 0; col < m.width; col++) {
        const cell = cells[row * m.width + col];
        const di = ((m.height - 1 - row) * m.width + col) * 4; // flip: row 0 is the map's bottom
        const c = cell < 0 ? theme.unknown : cell < 50 ? theme.free : theme.occupied;
        img.data[di] = c[0]; img.data[di + 1] = c[1]; img.data[di + 2] = c[2]; img.data[di + 3] = 255;
      }
    }
    octx.putImageData(img, 0, 0);
    mapBitmap = off;
    mapEmpty.hidden = true;
    if (!mapLayer.hidden) drawMap();
  }

  // ponytail: assumes the map origin has zero yaw (true for virtually all SLAM-generated
  // maps). A rotated origin would need a rotation term here; add if a map ever has one.
  function mapToCanvas(x, y) {
    const col = (x - mapInfo.origin[0]) / mapInfo.resolution;
    const row = (y - mapInfo.origin[1]) / mapInfo.resolution;
    return [mapDraw.offsetX + col * mapDraw.scale, mapDraw.offsetY + (mapInfo.height - row) * mapDraw.scale];
  }

  function canvasToMap(px, py) {
    const col = (px - mapDraw.offsetX) / mapDraw.scale;
    const row = mapInfo.height - (py - mapDraw.offsetY) / mapDraw.scale;
    return [mapInfo.origin[0] + col * mapInfo.resolution, mapInfo.origin[1] + row * mapInfo.resolution];
  }

  function drawMap() {
    if (!mapBitmap || mapLayer.hidden) return;
    mapCanvas.width = innerWidth;
    mapCanvas.height = innerHeight;
    const scale = Math.min(mapCanvas.width / mapBitmap.width, mapCanvas.height / mapBitmap.height);
    const offsetX = (mapCanvas.width - mapBitmap.width * scale) / 2;
    const offsetY = (mapCanvas.height - mapBitmap.height * scale) / 2;
    mapDraw = { scale, offsetX, offsetY };
    mapCtx.imageSmoothingEnabled = false;
    mapCtx.fillStyle = theme.bg;
    mapCtx.fillRect(0, 0, mapCanvas.width, mapCanvas.height);
    mapCtx.drawImage(mapBitmap, offsetX, offsetY, mapBitmap.width * scale, mapBitmap.height * scale);
    drawGrid();
    drawPath();
    drawGoal();
    drawRobot();
  }

  // One line per metre, for looks whose theme asks for a grid.
  function drawGrid() {
    if (!theme.grid || theme.grid === "none") return;
    const step = mapDraw.scale / mapInfo.resolution;
    if (step < 12) return;
    const w = mapInfo.width * mapDraw.scale, h = mapInfo.height * mapDraw.scale;
    mapCtx.save();
    mapCtx.strokeStyle = theme.grid;
    mapCtx.lineWidth = 1;
    mapCtx.beginPath();
    for (let x = 0; x <= w; x += step) { mapCtx.moveTo(mapDraw.offsetX + x + 0.5, mapDraw.offsetY); mapCtx.lineTo(mapDraw.offsetX + x + 0.5, mapDraw.offsetY + h); }
    for (let y = 0; y <= h; y += step) { mapCtx.moveTo(mapDraw.offsetX, mapDraw.offsetY + h - y + 0.5); mapCtx.lineTo(mapDraw.offsetX + w, mapDraw.offsetY + h - y + 0.5); }
    mapCtx.stroke();
    mapCtx.restore();
  }

  function glow(color) {
    mapCtx.shadowColor = color;
    mapCtx.shadowBlur = theme.glow;
  }

  function drawPath() {
    if (!plannedPath.length) return;
    mapCtx.save();
    glow(theme.path);
    mapCtx.strokeStyle = theme.path;
    mapCtx.lineWidth = 3;
    mapCtx.lineJoin = "round";
    mapCtx.lineCap = "round";
    mapCtx.beginPath();
    plannedPath.forEach(([x, y], i) => {
      const [px, py] = mapToCanvas(x, y);
      if (i === 0) mapCtx.moveTo(px, py);
      else mapCtx.lineTo(px, py);
    });
    mapCtx.stroke();
    mapCtx.restore();
  }

  function drawGoal() {
    if (!goalPosition) return;
    const [px, py] = mapToCanvas(...goalPosition);
    mapCtx.save();
    glow(theme.goal);
    mapCtx.strokeStyle = theme.goal;
    mapCtx.lineWidth = 3;
    mapCtx.beginPath();
    mapCtx.arc(px, py, 10, 0, Math.PI * 2);
    mapCtx.moveTo(px - 16, py); mapCtx.lineTo(px + 16, py);
    mapCtx.moveTo(px, py - 16); mapCtx.lineTo(px, py + 16);
    mapCtx.stroke();
    mapCtx.restore();
  }

  function drawRobot() {
    if (!robotPose || !mapDraw || !mapInfo) return;
    const [px, py] = mapToCanvas(robotPose[0], robotPose[1]);
    mapCtx.save();
    mapCtx.translate(px, py);
    mapCtx.rotate(-robotPose[2]);
    glow(theme.robot);
    mapCtx.fillStyle = theme.robot;
    mapCtx.beginPath();
    mapCtx.moveTo(14, 0);
    mapCtx.lineTo(-10, 8);
    mapCtx.lineTo(-10, -8);
    mapCtx.closePath();
    mapCtx.fill();
    mapCtx.restore();
  }

  mapCanvas.addEventListener("click", e => {
    if (!mapInfo || !mapDraw) return;
    const rect = mapCanvas.getBoundingClientRect();
    const px = (e.clientX - rect.left) * mapCanvas.width / rect.width;
    const py = (e.clientY - rect.top) * mapCanvas.height / rect.height;
    if (px < mapDraw.offsetX || py < mapDraw.offsetY ||
        px >= mapDraw.offsetX + mapInfo.width * mapDraw.scale ||
        py >= mapDraw.offsetY + mapInfo.height * mapDraw.scale) return;
    const [x, y] = canvasToMap(px, py);
    fetch("/goal", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ x, y }) })
      .catch(() => {}); // no node behind a static preview
  });

  readTheme();
  return {
    open,
    get current() { return current; },
    get covering() { return current === "map"; }, // the map is opaque; the face can skip rendering
    diagnostics(list) { diagnostics = list; scheduleDiagRender(); },
    map(m) { renderMap(m); },
    pose(p) { robotPose = p; drawMap(); },
    goal(g) { goalPosition = g; drawMap(); },
    path(p) { plannedPath = p; drawMap(); },
    resize() { drawMap(); },
    retheme() {
      readTheme();
      if (mapMsg) renderMap(mapMsg);
      else drawMap();
    },
    // read-only state for tests and debugging
    state: {
      get diagnostics() { return diagnostics; },
      get robotPose() { return robotPose; },
      get goalPosition() { return goalPosition; },
      get plannedPath() { return plannedPath; },
      get theme() { return theme; },
    },
  };
}
