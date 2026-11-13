// Sheets Row Focus — text recorder (runs in the page's own JavaScript world at document_start,
// only on https://docs.google.com/spreadsheets/*).
//
// Google Sheets paints its grid onto a <canvas> with fillText, so the magnified row would
// otherwise be a stretched (blurry) copy of those pixels. This script keeps a small live
// record of what is drawn on the grid canvas — each piece of text with its font, colour,
// position and clip area — so the content script can
// redraw the focused row's text as real, sharp text at any magnification.
//
// The record follows Sheets' own drawing: text is added as it is drawn, removed
// when something is painted over them, and moved when Sheets scrolls by copying the canvas
// onto itself. Nothing is sent anywhere; the content script asks for the text in a region via
// a synchronous DOM event on the canvas element and gets a JSON reply. The content script
// also checks every piece of text against the real pixels before redrawing it.
(() => {
  "use strict";
  const VERSION = 1;
  const QUERY = "sheets-row-focus:text-query";
  const REPLY = "sheets-row-focus:text-reply";
  const CONTROL = "sheets-row-focus:recorder";   // detail "pause" | "resume" (from content.js)
  const GRID_SELECTOR = "#waffle-grid-container";
  const MAX_TEXTS = 6000;   // per canvas; far more than a full screen of cells
  const MAX_KNOWN = 400;    // repainted areas tracked for a canvas that predates this script
  const BAND = 48;          // canvas px per band of the spatial index

  const prev = window.__sheetsRowFocusText;
  if (prev && prev.version >= VERSION) return;
  if (prev && typeof prev.stop === "function") prev.stop();

  const C2D = window.CanvasRenderingContext2D && CanvasRenderingContext2D.prototype;
  if (!C2D) return;

  let active = true;
  let nextId = 0;          // every fillText gets a new id; moved or split copies keep it
  // Canvases that already had pixels when this script started (injected into an open tab):
  // their record is incomplete until Sheets repaints them.
  const preexisting = new WeakSet(document.querySelectorAll("canvas"));
  const states = new WeakMap();

  // ------------------------------------------------------------------ geometry helpers
  // Boxes are [x0, y0, x1, y1] in canvas pixels.
  const isect = (a, b) => {
    const x0 = Math.max(a[0], b[0]);
    const y0 = Math.max(a[1], b[1]);
    const x1 = Math.min(a[2], b[2]);
    const y1 = Math.min(a[3], b[3]);
    return x1 > x0 && y1 > y0 ? [x0, y0, x1, y1] : null;
  };
  const inside = (a, b) => a[0] >= b[0] - 0.01 && a[1] >= b[1] - 0.01 && a[2] <= b[2] + 0.01 && a[3] <= b[3] + 0.01;
  // a minus b, as up to four boxes
  const subtract = (a, b) => {
    const i = isect(a, b);
    if (!i) return [a];
    const out = [];
    if (i[1] > a[1]) out.push([a[0], a[1], a[2], i[1]]);
    if (i[3] < a[3]) out.push([a[0], i[3], a[2], a[3]]);
    if (i[0] > a[0]) out.push([a[0], i[1], i[0], i[3]]);
    if (i[2] < a[2]) out.push([i[2], i[1], a[2], i[3]]);
    return out;
  };
  const INF = [-1e9, -1e9, 1e9, 1e9];

  function parseColor(s) {
    if (typeof s !== "string") return null;
    let m = /^#([0-9a-f]{6})$/i.exec(s);
    if (m) {
      const n = parseInt(m[1], 16);
      return [(n >> 16) & 255, (n >> 8) & 255, n & 255, 1];
    }
    m = /^rgba?\(\s*([\d.]+)[,\s]+([\d.]+)[,\s]+([\d.]+)(?:[,\s/]+([\d.]+))?\s*\)$/i.exec(s);
    if (m) return [+m[1], +m[2], +m[3], m[4] === undefined ? 1 : +m[4]];
    return null;
  }

  // ------------------------------------------------------------------ spatial index
  // Texts bucketed by horizontal bands of the canvas, so painting a cell only looks at the
  // record near it. Each item keeps its insertion order (`seq`).
  class Layer {
    constructor(max) {
      this.max = max;
      this.buckets = new Map();
      this.seq = 0;
      this.count = 0;
    }
    // `keep`: re-insert an item that was moved, keeping its place in the drawing order.
    add(item, box, keep) {
      if (!keep || !item.seq) item.seq = ++this.seq;
      item.b0 = Math.floor(box[1] / BAND);
      item.b1 = Math.floor((box[3] - 0.001) / BAND);
      for (let b = item.b0; b <= item.b1; b++) {
        let set = this.buckets.get(b);
        if (!set) this.buckets.set(b, (set = new Set()));
        set.add(item);
      }
      this.count++;
      if (this.count > this.max) this.prune();
    }
    remove(item) {
      for (let b = item.b0; b <= item.b1; b++) {
        const set = this.buckets.get(b);
        if (set && set.delete(item) && !set.size) this.buckets.delete(b);
      }
      this.count--;
    }
    // Items whose band range overlaps `area` (a snapshot array: safe to modify the layer after).
    near(area) {
      if (!this.count) return [];
      const b0 = Math.floor(area[1] / BAND);
      const b1 = Math.floor((area[3] - 0.001) / BAND);
      if (b0 === b1) {
        const set = this.buckets.get(b0);
        return set ? Array.from(set) : [];
      }
      const out = new Set();
      if (b1 - b0 > this.buckets.size) {
        for (const set of this.buckets.values()) for (const it of set) out.add(it);
      } else {
        for (let b = b0; b <= b1; b++) {
          const set = this.buckets.get(b);
          if (set) for (const it of set) out.add(it);
        }
      }
      return Array.from(out);
    }
    all() {
      return this.near([0, -1e9, 0, 1e9]);
    }
    // Forget the oldest items (the newest describe what is on screen now).
    prune() {
      const items = [...this.all()].sort((a, b) => a.seq - b.seq);
      for (const it of items.slice(0, items.length - Math.floor(this.max * 0.75))) this.remove(it);
    }
  }

  // ------------------------------------------------------------------ per-canvas state

  function resetState(st, complete) {
    st.texts = new Layer(MAX_TEXTS);
    st.clip = INF;
    st.stack = [];
    st.path = [];
    st.pathOk = true;
    st.complete = complete;
    st.known = [];
  }

  function stateOf(canvas) {
    let st = states.get(canvas);
    if (st && st.grid === false) {
      // Not (yet) a grid canvas: look again occasionally (it may be attached later).
      if (performance.now() - st.checked < 1000) return null;
      st = null;
    }
    if (!st) {
      const grid = canvas instanceof HTMLCanvasElement && canvas.isConnected && !!canvas.closest(GRID_SELECTOR) &&
        !canvas.classList.contains("sheets-row-focus-overlay");
      if (!grid) {
        states.set(canvas, { grid: false, checked: performance.now() });
        return null;
      }
      // `known`: areas painted since this script started (only matters while not `complete`).
      // `stale`: Sheets drew on it while recording was paused, so the record is incomplete.
      st = { grid: true, w: canvas.width, h: canvas.height, stale: false };
      resetState(st, !preexisting.has(canvas));
      states.set(canvas, st);
    }
    if (st.stale) {
      // Drawing was missed while paused: start over, trusting only what is repainted from now on.
      st.stale = false;
      resetState(st, false);
    }
    if (st.w !== canvas.width || st.h !== canvas.height) {
      // Resizing a canvas clears it and resets its drawing state.
      st.w = canvas.width;
      st.h = canvas.height;
      resetState(st, true);
    }
    return st;
  }

  // Only axis-aligned transforms (scale + translate) are followed; anything else isn't recorded.
  function mapBox(t, x, y, w, h) {
    const xa = t.a * x + t.e;
    const ya = t.d * y + t.f;
    const xb = t.a * (x + w) + t.e;
    const yb = t.d * (y + h) + t.f;
    return [Math.min(xa, xb), Math.min(ya, yb), Math.max(xa, xb), Math.max(ya, yb)];
  }
  const axisAligned = (t) => Math.abs(t.b) < 1e-9 && Math.abs(t.c) < 1e-9;

  const visible = (t) => isect(t.box, t.clip);
  function addTextItem(st, t) {
    const vis = visible(t);
    if (vis) st.texts.add(t, vis);
  }

  // Something opaque was painted over `box` (in canvas pixels): hide what was underneath.
  function cover(st, box) {
    const area = isect(box, st.clip);
    if (!area) return;
    if (area[0] <= 0.5 && area[1] <= 0.5 && area[2] >= st.w - 0.5 && area[3] >= st.h - 0.5) {
      resetState(st, true);
      return;
    }
    if (!st.complete) addKnown(st, area);
    for (const t of st.texts.near(area)) {
      const vis = visible(t);
      if (!vis || !isect(vis, area)) continue;
      st.texts.remove(t);
      // Partly covered: keep the uncovered pieces as separately clipped copies.
      if (!inside(vis, area)) {
        for (const piece of subtract(t.clip, area)) if (isect(piece, t.box)) addTextItem(st, { ...t, clip: piece });
      }
    }
  }

  // Areas of a pre-existing canvas whose content has been repainted since this script started.
  function addKnown(st, box) {
    st.known = st.known.filter((k) => !inside(k, box));
    st.known.push(box);
    if (st.known.length > MAX_KNOWN) st.known.splice(0, st.known.length - MAX_KNOWN); // forget = safe
  }
  function isKnown(st, area) {
    if (st.complete) return true;
    let rest = [area];
    for (const k of st.known) {
      rest = rest.flatMap((r) => subtract(r, k));
      if (!rest.length) return true;
    }
    // Ignore slivers (sub-pixel rounding at the edges of repainted areas).
    return rest.every((r) => r[2] - r[0] < 1.5 || r[3] - r[1] < 1.5);
  }

  // Sheets scrolls by copying part of the canvas onto itself: move the record along with it.
  function blit(st, src, dst) {
    const fx = (dst[2] - dst[0]) / (src[2] - src[0]);
    const fy = (dst[3] - dst[1]) / (src[3] - src[1]);
    const mx = (x) => dst[0] + (x - src[0]) * fx;
    const my = (y) => dst[1] + (y - src[1]) * fy;
    const mb = (b) => [mx(b[0]), my(b[1]), mx(b[2]), my(b[3])];
    const target = isect(dst, st.clip);
    if (!target) return;
    // A plain scroll (same size) moves whole items in place; anything else is copied.
    const shift = Math.abs(fx - 1) < 1e-6 && Math.abs(fy - 1) < 1e-6;
    const texts = [];
    const moved = [];
    for (const t of st.texts.near(src)) {
      const vis = visible(t);
      if (!vis || !isect(vis, src)) continue;
      // The clip moves with the copy (limited to the copied area), so it still covers the
      // anti-aliasing around the glyphs.
      const part = isect(t.clip, src);
      const clip = part && isect(mb(part), target);
      if (!clip) continue;
      const geo = { x: mx(t.x), y: my(t.y), size: t.size * fy, box: mb(t.box), clip };
      if (shift && inside(vis, src)) moved.push([t, geo]);
      else texts.push({ ...t, ...geo });
    }
    texts.sort((a, b) => a.seq - b.seq);
    for (const [t] of moved) st.texts.remove(t);
    let known = null;
    if (!st.complete) {
      // Copied pixels are only known where their source was; the rest of the target is not.
      known = [];
      for (const k of st.known) {
        const part = isect(k, src);
        const box = part && isect(mb(part), target);
        if (box) known.push(box);
      }
    }
    cover(st, target);
    if (known) {
      st.known = st.known.flatMap((k) => subtract(k, target));
      for (const k of known) addKnown(st, k);
    }
    for (const [t, geo] of moved) {
      Object.assign(t, geo);
      const vis = visible(t);
      if (vis) st.texts.add(t, vis, true);
    }
    for (const t of texts) addTextItem(st, t);
  }

  function addText(ctx, st, text, x, y, maxWidth) {
    const t = ctx.getTransform();
    if (!axisAligned(t) || t.a <= 0 || t.d <= 0) return;
    const s = String(text);
    if (!s.trim()) return;
    const m = ctx.measureText(s);
    let left = m.actualBoundingBoxLeft;
    let right = m.actualBoundingBoxRight;
    let squeeze = 1;
    if (maxWidth !== undefined && m.width > maxWidth && m.width > 0) {
      squeeze = Math.max(0, maxWidth) / m.width;
      left *= squeeze;
      right *= squeeze;
    }
    const px = t.a * x + t.e;
    const py = t.d * y + t.f;
    const box = [px - left * t.a, py - m.actualBoundingBoxAscent * t.d, px + right * t.a, py + m.actualBoundingBoxDescent * t.d];
    const vis = isect(box, st.clip);
    if (!vis) return;
    const fill = typeof ctx.fillStyle === "string" ? ctx.fillStyle : "#000000";
    addTextItem(st, {
      id: ++nextId, text: s, x: px, y: py, size: t.d, sx: (t.a / t.d) * squeeze,
      font: ctx.font, fill, alpha: ctx.globalAlpha, align: ctx.textAlign, base: ctx.textBaseline,
      dir: ctx.direction, box, clip: st.clip === INF ? [0, 0, st.w, st.h] : st.clip.slice()
    });
  }

  const opaqueFill = (ctx, color) => color && color[3] >= 0.999 && ctx.globalAlpha >= 0.999 &&
    ctx.globalCompositeOperation === "source-over";

  // ------------------------------------------------------------------ hooks

  function hook(name, after) {
    const orig = C2D[name];
    if (typeof orig !== "function") return;
    C2D[name] = function (...args) {
      const result = orig.apply(this, args);
      try {
        if (active) {
          const st = this.canvas && stateOf(this.canvas);
          if (st) after(this, st, args);
        } else {
          const st = this.canvas && states.get(this.canvas);
          if (st && st.grid) st.stale = true;
        }
      } catch (_) {
        /* recording must never break Sheets' drawing */
      }
      return result;
    };
  }

  hook("save", (ctx, st) => st.stack.push(st.clip));
  hook("restore", (ctx, st) => {
    if (st.stack.length) st.clip = st.stack.pop();
  });
  hook("reset", (ctx, st) => resetState(st, true));
  hook("beginPath", (ctx, st) => {
    st.path = [];
    st.pathOk = true;
  });
  hook("rect", (ctx, st, [x, y, w, h]) => {
    const t = ctx.getTransform();
    if (axisAligned(t)) st.path.push(mapBox(t, x, y, w, h));
    else st.pathOk = false;
  });
  for (const name of ["moveTo", "lineTo", "arc", "arcTo", "bezierCurveTo", "quadraticCurveTo", "ellipse", "roundRect"]) {
    hook(name, (ctx, st) => {
      st.pathOk = false;
    });
  }
  hook("clip", (ctx, st, args) => {
    // Only rectangular clips are followed (Sheets clips text to its cell this way).
    if (args.length && typeof args[0] === "object") return; // clip(Path2D): unknown shape
    if (!st.pathOk || !st.path.length) return;
    const b = st.path.reduce((u, r) => [Math.min(u[0], r[0]), Math.min(u[1], r[1]), Math.max(u[2], r[2]), Math.max(u[3], r[3])]);
    st.clip = isect(st.clip, b) || [0, 0, 0, 0];
  });
  hook("fillText", (ctx, st, [text, x, y, maxWidth]) => addText(ctx, st, text, x, y, maxWidth));
  hook("fillRect", (ctx, st, [x, y, w, h]) => {
    const t = ctx.getTransform();
    if (!axisAligned(t)) return;
    const box = mapBox(t, x, y, w, h);
    if (opaqueFill(ctx, parseColor(ctx.fillStyle))) cover(st, box);
  });
  hook("clearRect", (ctx, st, [x, y, w, h]) => {
    const t = ctx.getTransform();
    if (axisAligned(t)) cover(st, mapBox(t, x, y, w, h));
  });
  hook("drawImage", (ctx, st, args) => {
    const t = ctx.getTransform();
    if (!axisAligned(t)) return;
    const img = args[0];
    const iw = img.width;
    const ih = img.height;
    let src;
    let dst;
    if (args.length >= 9) {
      src = [args[1], args[2], args[1] + args[3], args[2] + args[4]];
      dst = mapBox(t, args[5], args[6], args[7], args[8]);
    } else {
      src = [0, 0, iw, ih];
      dst = mapBox(t, args[1], args[2], args.length >= 5 ? args[3] : iw, args.length >= 5 ? args[4] : ih);
    }
    if (img === ctx.canvas) {
      if (src[2] > src[0] && src[3] > src[1]) blit(st, src, dst);
    } else if (img instanceof HTMLCanvasElement && states.get(img) && states.get(img).grid) {
      cover(st, dst);
    }
    // Other images (icons, chips, pictures in cells) are not followed; the content script's
    // pixel check keeps any text they touch as plain pixels.
  });

  // ------------------------------------------------------------------ queries

  const PRIVATE = new Set(["seq", "b0", "b1"]);
  function onQuery(e) {
    const canvas = e.target;
    let reply = { version: VERSION, complete: false, texts: [] };
    try {
      const st = canvas instanceof HTMLCanvasElement ? states.get(canvas) : null;
      const q = JSON.parse(e.detail);
      if (active && st && st.grid && !st.stale && st.w === canvas.width && st.h === canvas.height) {
        const area = [q.x0, q.y0, q.x1, q.y1];
        const texts = st.texts.near(area)
          .filter((t) => {
            const vis = visible(t);
            return vis && isect(vis, area);
          })
          .sort((a, b) => a.seq - b.seq);
        reply = { version: VERSION, complete: isKnown(st, area), texts };
      }
    } catch (_) {
      /* malformed query: empty reply */
    }
    canvas.dispatchEvent(new CustomEvent(REPLY, {
      detail: JSON.stringify(reply, (k, v) => (PRIVATE.has(k) ? undefined : v))
    }));
  }
  document.addEventListener(QUERY, onQuery, true);

  function onControl(e) {
    if (e.detail === "pause") {
      active = false;
    } else if (e.detail === "resume") {
      active = true;
    }
  }
  document.addEventListener(CONTROL, onControl, true);

  function stop() {
    active = false;
    document.removeEventListener(QUERY, onQuery, true);
    document.removeEventListener(CONTROL, onControl, true);
  }

  window.__sheetsRowFocusText = Object.freeze({ version: VERSION, stop });
})();
