// Paints a pose's features onto a 2D canvas in a given style. Liquid glass and hologram use it to
// build their feature textures; the geometry comes entirely from pose.js.
import { FACE_W, FACE_H, FACE_CX, FACE_CY, STAR_PATH } from "./pose.js";

const path = d => new Path2D(d);

// style: colours plus switches. Colours are CSS strings; null skips that part.
//   eye, pupil, highlight, line, mouth, teeth, tongue, blush, water, rim
//   pupilScale, browWidth, glow (shadowBlur in face px), brows, nose, chin, marks
export function paintFeatures(ctx, pose, style, { width = ctx.canvas.width, height = ctx.canvas.height, clear = true } = {}) {
  const k = Math.min(width / FACE_W, height / FACE_H);
  if (clear) ctx.clearRect(0, 0, width, height);
  ctx.save();
  ctx.translate(width / 2, height / 2);
  ctx.scale(k * pose.scale[0], k * pose.scale[1]);
  ctx.translate(-FACE_CX, -FACE_CY);
  ctx.lineCap = "round";
  ctx.lineJoin = "round";
  const glow = (color, blur) => {
    ctx.shadowColor = color;
    ctx.shadowBlur = (style.glow || 0) * (blur ?? 1) * k;
  };
  const noGlow = () => { ctx.shadowBlur = 0; };

  for (const c of pose.cheeks) {
    if (!style.blush || c.alpha <= 0.02) continue;
    const grad = ctx.createRadialGradient(c.cx, c.cy, 0, c.cx, c.cy, c.rx);
    grad.addColorStop(0, style.blush);
    grad.addColorStop(1, "rgba(0,0,0,0)");
    ctx.save();
    ctx.globalAlpha = c.alpha;
    ctx.translate(c.cx, c.cy);
    ctx.scale(1, c.ry / c.rx);
    ctx.translate(-c.cx, -c.cy);
    ctx.fillStyle = grad;
    ctx.beginPath();
    ctx.arc(c.cx, c.cy, c.rx * 1.3, 0, Math.PI * 2);
    ctx.fill();
    ctx.restore();
  }

  for (const e of pose.eyes) {
    const pr = e.pr * (style.pupilScale || 1);
    if (e.blink < 0.995) {
      ctx.save();
      ctx.clip(path(e.lidPath));
      glow(style.eye, 1);
      ctx.fillStyle = style.eye;
      ctx.beginPath();
      ctx.ellipse(e.cx, e.cy, e.rx, e.ry, 0, 0, Math.PI * 2);
      ctx.fill();
      noGlow();
      if (style.iris) {
        ctx.fillStyle = style.iris;
        ctx.beginPath();
        ctx.arc(e.px, e.py, pr * 1.45, 0, Math.PI * 2);
        ctx.fill();
      }
      ctx.fillStyle = style.pupil;
      ctx.beginPath();
      ctx.ellipse(e.px, e.py, pr, pr * (style.pupilTall || 1), 0, 0, Math.PI * 2);
      ctx.fill();
      ctx.fillStyle = style.highlight;
      ctx.beginPath();
      ctx.arc(e.px + 0.35 * pr, e.py - 0.45 * pr * (style.pupilTall || 1), 3.5 + 3 * pose.fx.sparkle + 0.12 * pr, 0, Math.PI * 2);
      ctx.fill();
      ctx.beginPath();
      ctx.arc(e.px - 0.4 * pr, e.py + 0.35 * pr, 1.6 + 2 * pose.fx.sparkle, 0, Math.PI * 2);
      ctx.fill();
      if (style.rim) {
        // No shadow here: a shadowed stroke inside the lid clip wipes the canvas in Chrome when the lids are part-closed.
        ctx.strokeStyle = style.rim;
        ctx.lineWidth = 3.5;
        ctx.beginPath();
        ctx.ellipse(e.cx, e.cy, e.rx - 1.5, e.ry - 1.5, 0, 0, Math.PI * 2);
        ctx.stroke();
      }
      ctx.restore();
    }
    if (e.blink > 0.75) {
      glow(style.line || style.pupil, 0.6);
      ctx.globalAlpha = Math.min(1, (e.blink - 0.75) * 4);
      ctx.strokeStyle = style.closed || style.line || style.pupil;
      ctx.lineWidth = 7;
      ctx.stroke(path(e.closedPath));
      ctx.globalAlpha = 1;
      noGlow();
    }
  }

  if (style.brows) {
    glow(style.line, 1);
    ctx.strokeStyle = style.line;
    ctx.lineWidth = style.browWidth || 10;
    for (const b of pose.brows) ctx.stroke(path(b.path));
    noGlow();
  }

  if (style.nose) {
    ctx.strokeStyle = style.line;
    ctx.lineWidth = 5;
    ctx.stroke(path(pose.nose.path));
  }
  if (style.line) {
    ctx.lineWidth = 3.5;
    ctx.strokeStyle = style.line;
    for (const w of pose.nose.wrinkles) { ctx.globalAlpha = w.alpha; ctx.stroke(path(w.path)); }
    ctx.globalAlpha = 1;
  }

  const m = pose.mouth;
  const lineColor = style.mouthLine || style.line || style.mouth;
  if (!m.open) {
    glow(lineColor, 0.8);
    ctx.strokeStyle = lineColor;
    ctx.lineWidth = m.width * (style.mouthScale || 1);
    ctx.stroke(path(m.linePath));
    noGlow();
  } else {
    const open = path(m.openPath);
    ctx.save();
    ctx.clip(open);
    ctx.fillStyle = style.mouth;
    ctx.fillRect(m.mx - 90, m.uY - 20, 180, m.lY - m.uY + 60);
    if (m.upperTeeth > 0.05) { ctx.fillStyle = style.teeth; ctx.fillRect(m.mx - 70, m.uY - 12, 140, 12 + 14 * m.upperTeeth); }
    if (m.lowerTeeth > 0) { ctx.fillStyle = style.teeth; ctx.fillRect(m.mx - 70, m.lY - 6 - 14 * m.lowerTeeth, 140, 30); }
    if (m.innerTongue) {
      ctx.fillStyle = style.tongue;
      ctx.beginPath();
      ctx.ellipse(m.mx + m.jawShift, m.lY + 4, 24, 12, 0, 0, Math.PI * 2);
      ctx.fill();
    }
    ctx.restore();
    if (style.mouthLine !== null) {
      glow(lineColor, 0.8);
      ctx.strokeStyle = lineColor;
      ctx.lineWidth = m.width * 0.8 * (style.mouthScale || 1);
      ctx.stroke(open);
      noGlow();
    }
  }
  if (m.tongueOut > 0) {
    ctx.fillStyle = style.tongue;
    ctx.beginPath();
    ctx.ellipse(m.mx + m.jawShift, m.lY + 6 + 10 * m.tongueOut, 15, 6 + 12 * m.tongueOut, 0, 0, Math.PI * 2);
    ctx.fill();
  }
  if (style.marks !== false && style.line) {
    ctx.strokeStyle = style.line;
    ctx.lineWidth = 3.5;
    for (const mk of m.marks) { ctx.globalAlpha = mk.alpha; ctx.stroke(path(mk.path)); }
    ctx.globalAlpha = 1;
  }
  if (style.chin && pose.chin.alpha > 0.25) {
    ctx.globalAlpha = pose.chin.alpha;
    ctx.strokeStyle = style.line;
    ctx.lineWidth = pose.chin.width;
    ctx.stroke(path(pose.chin.path));
    ctx.globalAlpha = 1;
  }

  if (style.water) {
    glow(style.water, 0.6);
    ctx.fillStyle = style.water;
    for (const t of pose.tears) { ctx.globalAlpha = t.alpha; ctx.fill(path(t.path)); }
    if (pose.sweat) { ctx.globalAlpha = pose.sweat.alpha; ctx.fill(path(pose.sweat.path)); }
    ctx.globalAlpha = 1;
    noGlow();
  }
  for (const sp of pose.sparkles) {
    ctx.save();
    glow(style.highlight, 1);
    ctx.translate(sp.x, sp.y);
    ctx.scale(sp.s, sp.s);
    ctx.fillStyle = style.highlight;
    ctx.fill(path(STAR_PATH));
    ctx.restore();
  }
  noGlow();
  ctx.restore();
}
