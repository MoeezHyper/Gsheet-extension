// Sheets Row Focus — content script (runs only on https://docs.google.com/spreadsheets/*).
//
// Google Sheets paints the grid on <canvas>, so there are no DOM rows to restyle. Instead:
//   1. Detect a single whole-row selection from the Name Box ("5:5").
//   2. Locate the row on screen using Sheets' DOM selection overlay (div.selection).
//   3. Copy that strip of pixels from the grid canvas(es) onto our own overlay canvas,
//      enlarged by the configured scale and tinted with the fill color.
// The overlay ignores the mouse, so clicks go straight through to Sheets. Selecting a
// cell, another row, a column or a multi-row range changes the Name Box and the overlay
// updates or disappears.
(() => {
  "use strict";

  if (window.top !== window) return; // never run inside embedded frames
  if (location.hostname !== "docs.google.com" || !location.pathname.startsWith("/spreadsheets/")) return;
  // A newer copy (e.g. injected into an already-open tab after install/update) takes over
  // from any older copy instead of running alongside it.
  try {
    if (typeof window.__sheetsRowFocusShutdown === "function") window.__sheetsRowFocusShutdown();
  } catch (_) {
    /* the old copy's context is gone */
  }

  const Settings = globalThis.RowFocusSettings;
  const SINGLE_ROW_RE = /^\$?(\d+):\$?(\d+)$/;
  const POLL_MS = 100;           // how often the Name Box is checked
  const REFRESH_MS = 150;        // repaint at least this often while frames are running
  const BURST_MS = 400;          // keep painting every frame this long after the last movement
  const IDLE_REFRESH_MS = 500;   // otherwise refresh the copied pixels twice a second
  const ROW_PADDING = 4;         // CSS px of breathing room above and below the magnified row
  const OLD_RENDER_SCALE_KEY = "sheetsRowFocus.renderScale"; // left behind by v1.1, removed
  const TEXT_QUERY = "sheets-row-focus:text-query";  // answered by text-recorder.js
  const TEXT_REPLY = "sheets-row-focus:text-reply";
  const RECORDER_CONTROL = "sheets-row-focus:recorder"; // "pause" / "resume" text-recorder.js
  const SNAPSHOT_MAX_H = 240;
  const PX_TOL = 12;             // colour tolerance (per channel) when checking text pixels    // CSS px of a row read back for analysis (tall wrapped rows)
  const SELECTION_SELECTOR = ".selection";
  const GRID_SELECTOR = "#waffle-grid-container";

  let settings = Settings.sanitize(Settings.DEFAULTS);
  let activeRow = null;          // row number currently focused, or null
  let overlay = null;            // our <canvas>
  let ctx = null;
  let rafId = 0;
  let idleTimer = 0;
  let burstUntil = 0;
  let gridObserver = null;
  let observedGrid = null;
  let lastKey = "";              // geometry/settings signature of the last paint
  let lastPaint = 0;
  let dirty = true;
  let pollTimer = 0;
  let alive = true;
  let geom = null;               // placement of the visible overlay, used to remap clicks
  let gesture = null;            // click gesture being remapped onto the real row

  // ---------------------------------------------------------------- helpers

  const nameBox = () => document.getElementById("t-name-box") || document.querySelector(".waffle-name-box");
  const gridContainer = () => document.querySelector(GRID_SELECTOR);

  function parseSingleRow(value) {
    const m = SINGLE_ROW_RE.exec(String(value || "").trim());
    if (!m || m[1] !== m[2]) return null;
    return Number(m[1]);
  }

  function intersect(a, b) {
    const left = Math.max(a.left, b.left);
    const top = Math.max(a.top, b.top);
    const right = Math.min(a.right, b.right);
    const bottom = Math.min(a.bottom, b.bottom);
    if (right <= left || bottom <= top) return null;
    return { left, top, right, bottom, width: right - left, height: bottom - top };
  }

  function rectOf(el) {
    const r = el.getBoundingClientRect();
    return { left: r.left, top: r.top, right: r.right, bottom: r.bottom, width: r.width, height: r.height };
  }

  function isRendered(el) {
    if (!el.isConnected) return false;
    const cs = getComputedStyle(el);
    return cs.display !== "none" && cs.visibility !== "hidden" && Number(cs.opacity) !== 0;
  }

  // Overflow-clipping ancestors of `el` (up to `stop`). Sheets' container overflow styles don't
  // change, so they are cached per element instead of re-reading computed styles every frame.
  let clipCache = new WeakMap();
  function clipAncestors(el, stop) {
    let list = clipCache.get(el);
    if (list) return list;
    list = [];
    for (let p = el.parentElement; p; p = p.parentElement) {
      const cs = getComputedStyle(p);
      const x = cs.overflowX !== "visible";
      const y = cs.overflowY !== "visible";
      if (x || y) list.push({ p, x, y });
      if (p === stop) break;
    }
    clipCache.set(el, list);
    return list;
  }

  // The part of `el` actually visible, clipped by every overflow-hiding ancestor up to `stop`.
  function visibleRect(el, stop) {
    let r = rectOf(el);
    if (r.width <= 0 && r.height <= 0) return null; // inside a display:none subtree
    for (const { p, x, y } of clipAncestors(el, stop)) {
      const pr = rectOf(p);
      r = intersect(r, {
        left: x ? pr.left : -Infinity,
        right: x ? pr.right : Infinity,
        top: y ? pr.top : -Infinity,
        bottom: y ? pr.bottom : Infinity
      });
      if (!r) return null;
    }
    return r;
  }

  // Grid canvases that are actually painted on screen.
  function gridCanvases(grid) {
    return [...grid.querySelectorAll("canvas")].filter((c) => {
      if (c === overlay || !c.width || !c.height) return false;
      const r = c.getBoundingClientRect();
      return r.width > 0 && r.height > 0 && isRendered(c);
    });
  }

  // Vertical extent of the user's selected row, from Sheets' `div.selection` fills.
  // - Frozen columns split one row into several divs with the same top/bottom: merged.
  // - Ctrl+click multi-range selections leave extra divs (same color, other rows): the Name Box
  //   only shows the active range, so these are detected here and the overlay is suppressed.
  // - Collaborators' selections use other colors and are ignored.
  function selectedRowBand(grid) {
    const fills = [];
    for (const el of grid.querySelectorAll(SELECTION_SELECTOR)) {
      const r = rectOf(el); // cheap check first: hidden fills have an empty rect
      if (r.height <= 0 || r.width <= 0 || !isRendered(el)) continue;
      fills.push({ r, color: getComputedStyle(el).backgroundColor, visible: visibleRect(el, grid) });
    }
    if (!fills.length) return null;

    // Our own active cell sits inside the selected row; use it to pick our selection color.
    const centers = [];
    for (const el of grid.querySelectorAll(".active-cell-border")) {
      const r = rectOf(el);
      if ((r.width > 0 || r.height > 0) && isRendered(el)) centers.push(r);
    }
    const borderTop = centers.length ? Math.min(...centers.map((r) => r.top)) : NaN;
    const borderBottom = centers.length ? Math.max(...centers.map((r) => r.bottom)) : NaN;
    const mid = (borderTop + borderBottom) / 2;

    let anchor = Number.isFinite(mid) ? fills.find((f) => f.r.top <= mid && mid <= f.r.bottom) : null;
    if (!anchor) anchor = fills[0];
    const same = (a, b) => Math.abs(a - b) < 1.5;
    const mine = fills.filter((f) => f.color === anchor.color);
    if (mine.some((f) => !same(f.r.top, anchor.r.top) || !same(f.r.bottom, anchor.r.bottom))) return null;

    let top = Infinity;
    let bottom = -Infinity;
    for (const f of mine) {
      if (!f.visible) continue;
      top = Math.min(top, f.visible.top);
      bottom = Math.max(bottom, f.visible.bottom);
    }
    return bottom > top ? { top, bottom } : null;
  }

  // Sheets' in-grid cell editor is parked off-screen (top ≈ -9998) unless a cell is being edited.
  function isEditingCell() {
    const ed = document.getElementById("waffle-rich-text-editor");
    if (!ed) return false;
    const r = ed.getBoundingClientRect();
    return r.width > 0 && r.height > 0 && r.bottom > 0 && r.top < window.innerHeight;
  }

  // Locate the focused row: its vertical extent from Sheets' selection overlay, and the
  // horizontal extent of the painted grid (row header included).
  function measureRow() {
    const grid = gridContainer();
    if (!grid) return null;
    const gridRect = rectOf(grid);

    const band = selectedRowBand(grid);
    if (!band) return null;
    const { top, bottom } = band;

    const canvases = gridCanvases(grid);
    if (!canvases.length) return null;
    let left = Infinity;
    let right = -Infinity;
    let contentBottom = -Infinity; // lowest painted grid pixel (above the horizontal scrollbar)
    for (const c of canvases) {
      const v = visibleRect(c, grid) || rectOf(c);
      left = Math.min(left, v.left);
      right = Math.max(right, v.right);
      contentBottom = Math.max(contentBottom, v.bottom);
    }
    contentBottom = Math.min(contentBottom, gridRect.bottom);
    const row = intersect({ left, right, top, bottom }, gridRect);
    if (!row) return null;
    return { row, gridRect, canvases, contentBottom };
  }

  // A "source" draws a viewport-CSS rectangle (sx, sy, sw, sh) of grid pixels into the overlay
  // at device-pixel rectangle (dx, dy, dw, dh). The live source reads Sheets' canvas(es).
  function liveSource(canvases) {
    const grid = gridContainer();
    const parts = canvases.map((c) => ({ c, cr: rectOf(c), vis: visibleRect(c, grid) }));
    return (sx, sy, sw, sh, dx, dy, dw, dh) => {
      if (sw <= 0 || sh <= 0) return;
      const fx = dw / sw;
      const fy = dh / sh;
      for (const { c, cr, vis } of parts) {
        const part = intersect({ left: sx, top: sy, right: sx + sw, bottom: sy + sh }, vis || cr);
        if (!part) continue;
        const kx = c.width / cr.width;
        const ky = c.height / cr.height;
        try {
          ctx.drawImage(
            c,
            (part.left - cr.left) * kx, (part.top - cr.top) * ky, part.width * kx, part.height * ky,
            dx + (part.left - sx) * fx, dy + (part.top - sy) * fy, part.width * fx, part.height * fy
          );
        } catch (_) {
          /* canvas mid-resize; next frame will repaint */
        }
      }
    };
  }

  // ---------------------------------------------------------------- grid pixel analysis
  //
  // To keep columns aligned and to find the header row, the grid's own pixels are read:
  //  - column edges: the 1px grey separators in the column-letter header band;
  //  - row edges: the 1px grey separators in the row-number column (a thick grey bar marks
  //    the end of frozen rows);
  //  - text extent of each cell, so a cell is enlarged around its text alignment point.
  // Pixels are copied into a small private canvas first, so Sheets' own canvas is never read
  // back directly (which could make Chrome move it off the GPU).

  // Reading pixels back from the GPU costs a few ms per read regardless of size, so all the
  // regions needed are copied into one scratch canvas (stacked; tall strips transposed into
  // short rows) and read with a single getImageData. Returns one pixel accessor per spec.
  let scratch = null;
  function readSnapshot(c, cr, specs) {
    const kx = c.width / cr.width;
    const ky = c.height / cr.height;
    const clampI = (n, hi) => Math.max(0, Math.min(hi, n));
    const boxes = specs.map(({ rect, transpose }) => {
      const x0 = clampI(Math.round((rect.left - cr.left) * kx), c.width);
      const y0 = clampI(Math.round((rect.top - cr.top) * ky), c.height);
      const w = clampI(Math.round((rect.right - cr.left) * kx), c.width) - x0;
      const h = clampI(Math.round((rect.bottom - cr.top) * ky), c.height) - y0;
      return w > 0 && h > 0 ? { x0, y0, w, h, transpose } : null;
    });
    let sw = 1;
    let sh = 0;
    for (const b of boxes) {
      if (!b) continue;
      b.off = sh;
      sw = Math.max(sw, b.transpose ? b.h : b.w);
      sh += b.transpose ? b.w : b.h;
    }
    if (!sh) return specs.map(() => null);
    if (!scratch) {
      const canvas = document.createElement("canvas");
      scratch = { canvas, ctx: canvas.getContext("2d", { willReadFrequently: true }) };
    }
    if (scratch.canvas.width < sw || scratch.canvas.height < sh) {
      scratch.canvas.width = Math.max(scratch.canvas.width, sw);
      scratch.canvas.height = Math.max(scratch.canvas.height, sh);
    }
    const sctx = scratch.ctx;
    sctx.setTransform(1, 0, 0, 1, 0, 0);
    sctx.clearRect(0, 0, sw, sh);
    sctx.imageSmoothingEnabled = false;
    for (const b of boxes) {
      if (!b) continue;
      // Transposed: source (i, j) lands at scratch (j, off + i).
      if (b.transpose) sctx.setTransform(0, 1, 1, 0, 0, b.off);
      else sctx.setTransform(1, 0, 0, 1, 0, b.off);
      sctx.drawImage(c, b.x0, b.y0, b.w, b.h, 0, 0, b.w, b.h);
    }
    sctx.setTransform(1, 0, 0, 1, 0, 0);
    const data = sctx.getImageData(0, 0, sw, sh).data; // throws if the canvas is tainted
    return boxes.map((b) => b && {
      data, w: b.w, h: b.h, kx, ky,
      idx: b.transpose ? (x, y) => ((b.off + x) * sw + y) * 4 : (x, y) => ((b.off + y) * sw + x) * 4,
      cssX: (x) => cr.left + (b.x0 + x) / kx,
      cssY: (y) => cr.top + (b.y0 + y) / ky,
      devX: (cssX) => Math.round((cssX - cr.left) * kx) - b.x0,
      devY: (cssY) => Math.round((cssY - cr.top) * ky) - b.y0
    });
  }

  function freeScratch() {
    scratch = null;
    widthCache.clear();
  }

  // ---------------------------------------------------------------- sharp (vector) text
  //
  // text-recorder.js (page world) keeps a live record of the text Sheets draws on its grid
  // canvas. The magnified row's text is redrawn from that record at the enlarged size, so it is
  // as sharp as normal text instead of a stretched picture. Returns the text pieces overlapping
  // `rect` (viewport CSS px) in viewport CSS px, or null when no complete record is available
  // (then the stretched picture is used as before).
  function textsIn(canvases, rect) {
    const out = [];
    for (const c of canvases) {
      const cr = rectOf(c);
      const kx = c.width / cr.width;
      const ky = c.height / cr.height;
      if (!(kx > 0) || !(ky > 0)) continue;
      const area = intersect(rect, cr);
      if (!area) continue;
      let reply = null;
      const onReply = (e) => {
        try {
          reply = JSON.parse(e.detail);
        } catch (_) {
          reply = null;
        }
      };
      c.addEventListener(TEXT_REPLY, onReply);
      try {
        c.dispatchEvent(new CustomEvent(TEXT_QUERY, {
          bubbles: true,
          detail: JSON.stringify({ x0: (area.left - cr.left) * kx, y0: (area.top - cr.top) * ky,
            x1: (area.right - cr.left) * kx, y1: (area.bottom - cr.top) * ky })
        }));
      } finally {
        c.removeEventListener(TEXT_REPLY, onReply);
      }
      if (!reply || !reply.complete || !Array.isArray(reply.texts)) return null;
      const X = (x) => cr.left + x / kx;
      const Y = (y) => cr.top + y / ky;
      for (const t of reply.texts) {
        const m = /(\d+(?:\.\d+)?|\.\d+)px/.exec(t.font || "");
        if (!m || typeof t.text !== "string") continue;
        out.push({
          id: t.id, canvas: c, text: t.text, x: X(t.x), y: Y(t.y),
          px: Number(m[1]) * t.size / ky,          // font size, CSS px
          wpx: t.size * t.sx / kx,                  // CSS px per unit of measured width
          font: t.font, fontAt: (size) => t.font.replace(m[0], `${size}px`),
          fill: t.fill, alpha: t.alpha, align: t.align, base: t.base, dir: t.dir,
          box: [X(t.box[0]), Y(t.box[1]), X(t.box[2]), Y(t.box[3])],
          clip: [X(t.clip[0]), Y(t.clip[1]), X(t.clip[2]), Y(t.clip[3])],
          slack: 1 / kx                             // anti-aliasing fringe around the glyphs
        });
      }
    }
    return out;
  }

  // Area of the stretched copy wiped before `t` is redrawn: its glyphs plus their anti-aliasing
  // fringe, but never outside its clip (Sheets drew nothing there) or the row's own band
  // (keeps the gridline at the bottom of the row).
  function eraseBox(t, band) {
    const b = intersect(
      { left: t.box[0] - t.slack, top: t.box[1] - t.slack, right: t.box[2] + t.slack, bottom: t.box[3] + t.slack },
      { left: t.clip[0], top: t.clip[1], right: t.clip[2], bottom: t.clip[3] });
    return b && band ? intersect(b, { left: -Infinity, right: Infinity, top: band.top, bottom: band.bottom - 1 }) : b;
  }

  function parseRgb(str) {
    let m = /^#([0-9a-f]{6})$/i.exec(str || "");
    if (m) {
      const n = parseInt(m[1], 16);
      return [(n >> 16) & 255, (n >> 8) & 255, n & 255, 1];
    }
    m = /^rgba?\(\s*([\d.]+)[,\s]+([\d.]+)[,\s]+([\d.]+)(?:[,\s/]+([\d.]+))?\s*\)$/i.exec(str || "");
    return m ? [+m[1], +m[2], +m[3], m[4] === undefined ? 1 : +m[4]] : null;
  }

  // A verdict belongs to one drawing of one piece of text. When Sheets repaints a cell (new
  // contents, colour or formatting), its text gets a new id and must be checked again.

  // Decide, from the real pixels (snapshot `p` of `rect`), which text can be redrawn sharply.
  // Under and around each piece of text every pixel must be the recorded background, the text
  // colour, or a blend of the two. Anything else (a chip or pill behind the text, an icon, an
  // image, a second background colour) would be damaged by the wipe, so that text keeps its
  // stretched pixels. Lines in the text colour running across the text (underline,
  // strikethrough) are measured so they are redrawn too. Returns Map(id -> { ok, decos, bg }).
  function checkTexts(p, texts, rect) {
    const out = new Map();
    if (!p || !texts) return out;
    const d = p.data;
    const band = { top: rect.top, bottom: rect.bottom };
    for (const t of texts) {
      const key = t.id;
      const prev = out.get(key);
      if (prev && !prev.ok) continue;
      let ok = false;
      let bg = null;
      const decos = [];
      const fg0 = parseRgb(t.fill);
      const e = eraseBox(t, band);
      // Checked area: the wiped area plus a 1px ring around it (inside the clip and row).
      const lim = e && intersect({ left: t.clip[0], top: t.clip[1], right: t.clip[2], bottom: t.clip[3] },
        { left: -Infinity, right: Infinity, top: band.top, bottom: band.bottom - 1 });
      const r = e && (intersect({ left: e.left - 1, top: e.top - 1, right: e.right + 1, bottom: e.bottom + 1 }, lim || e) || e);
      const x0 = r ? Math.max(0, p.devX(r.left)) : 0;
      const x1 = r ? Math.min(p.w, p.devX(r.right)) : 0;
      const y0 = r ? Math.max(0, p.devY(r.top)) : 0;
      const y1 = r ? Math.min(p.h, p.devY(r.bottom)) : 0;
      if (fg0 && x1 > x0 && y1 > y0 && t.box[3] <= rect.bottom - 1) {
        // The background is the most common colour around and under the text.
        const counts = new Map();
        let bestN = 0;
        for (let y = y0; y < y1; y++) {
          for (let x = x0; x < x1; x++) {
            const i = p.idx(x, y);
            const k = (d[i] << 16) | (d[i + 1] << 8) | d[i + 2];
            const c = (counts.get(k) || 0) + 1;
            counts.set(k, c);
            if (c > bestN) {
              bestN = c;
              bg = [d[i], d[i + 1], d[i + 2]];
            }
          }
        }
        const a = fg0[3] * (t.alpha >= 0 && t.alpha <= 1 ? t.alpha : 1);
        const fg = [0, 1, 2].map((c) => bg[c] + (fg0[c] - bg[c]) * a);
        // Sheets' text is anti-aliased per colour channel (LCD text), so each channel of an
        // edge pixel lies somewhere between the background and the text colour on its own.
        const lo = [0, 1, 2].map((c) => Math.min(bg[c], fg[c]) - PX_TOL);
        const hi = [0, 1, 2].map((c) => Math.max(bg[c], fg[c]) + PX_TOL);
        const sig = [0, 1, 2].filter((c) => Math.abs(fg[c] - bg[c]) >= 40);
        const ex0 = p.devX(e.left);
        const ex1 = p.devX(e.right);
        const ey0 = p.devY(e.top);
        const ey1 = p.devY(e.bottom);
        let ringN = 0;   // pixels just outside the wiped area...
        let ringBg = 0;  // ...that are plain background
        const boxW = p.devX(t.box[2]) - p.devX(t.box[0]);
        let bad = 0;
        let n = 0;
        for (let y = y0; y < y1; y++) {
          let run = 0;
          let best = 0;
          let bestEnd = 0;
          for (let x = x0; x < x1; x++) {
            const i = p.idx(x, y);
            const fits = d[i] >= lo[0] && d[i] <= hi[0] && d[i + 1] >= lo[1] && d[i + 1] <= hi[1] &&
              d[i + 2] >= lo[2] && d[i + 2] <= hi[2];
            let sc = 0;
            for (const c of sig) sc += (d[i + c] - bg[c]) / (fg[c] - bg[c]);
            sc = sig.length ? sc / sig.length : 0;
            n++;
            if (!fits) bad++;
            if (x < ex0 || x >= ex1 || y < ey0 || y >= ey1) {
              ringN++;
              if (Math.abs(d[i] - bg[0]) + Math.abs(d[i + 1] - bg[1]) + Math.abs(d[i + 2] - bg[2]) <= 3 * PX_TOL) ringBg++;
            }
            if (fits && sc >= 0.6) {
              run++;
              if (run > best) {
                best = run;
                bestEnd = x + 1;
              }
            } else {
              run = 0;
            }
          }
          // A solid run in the text colour across most of the text: a decoration line.
          if (y >= ey0 && y < ey1 && best >= Math.max(4 * p.kx, 0.6 * boxW)) {
            const last = decos[decos.length - 1];
            const lx0 = p.cssX(bestEnd - best) - t.x;
            const lx1 = p.cssX(bestEnd) - t.x;
            const ly0 = p.cssY(y) - t.y;
            const ly1 = p.cssY(y + 1) - t.y;
            if (last && Math.abs(last.y1 - ly0) < 0.01) {
              last.y1 = ly1;
              last.x0 = Math.min(last.x0, lx0);
              last.x1 = Math.max(last.x1, lx1);
            } else {
              decos.push({ x0: lx0, x1: lx1, y0: ly0, y1: ly1 });
            }
          }
        }
        // Around the text there must be plain background: a chip, pill or icon reaching under the
        // text shows up in this ring even when its colour lies between text and background.
        ok = n > 0 && bad <= n * 0.01 && (ringN < 4 || ringBg >= ringN * 0.8);
        // Lines thicker than about 2 px are glyph strokes ("■■■", "▬"), redrawn with the text.
        for (let i = decos.length - 1; i >= 0; i--) {
          if ((decos[i].y1 - decos[i].y0) * p.ky > 2.5) decos.splice(i, 1);
        }
      }
      const v = { ok, decos, bg: bg ? `rgb(${bg[0]}, ${bg[1]}, ${bg[2]})` : null };
      // Pieces of one text split by Sheets must agree; otherwise keep its pixels.
      if (prev && (prev.bg !== v.bg || prev.decos.length !== v.decos.length)) v.ok = false;
      out.set(key, v);
    }
    return out;
  }

  // The texts that passed checkTexts, with their decoration lines attached.
  function sharpOnly(texts, verdicts) {
    if (!texts || !verdicts || !verdicts.size) return null;
    const out = [];
    for (const t of texts) {
      const v = verdicts.get(t.id);
      if (v && v.ok) out.push({ ...t, bg: v.bg, decos: v.decos });
    }
    return out.length ? out : null;
  }

  // Width of `text` in `font` on the overlay (cached; fonts are the page's own).
  const widthCache = new Map();
  const onFontsLoaded = () => {
    widthCache.clear();
    wake();
  };
  function textWidth(font, text) {
    const key = font + "\u0000" + text;
    let w = widthCache.get(key);
    if (w === undefined) {
      if (widthCache.size > 4000) widthCache.clear();
      ctx.font = font;
      w = ctx.measureText(text).width;
      widthCache.set(key, w);
    }
    return w;
  }

  // Redraw a cell's text sharply: wipe the stretched glyphs (with the cell background under
  // each piece of text), then draw the text at the enlarged size. `mx`/`my` map viewport CSS
  // coordinates of the source row to overlay device pixels; `k` is device px per CSS px.
  function drawTexts(texts, mx, my, k, band) {
    const boxes = [];
    for (const t of texts) {
      const b = eraseBox(t, band);
      if (!b) continue;
      boxes.push(t);
      ctx.fillStyle = t.bg;
      const x0 = Math.floor(mx(b.left));
      const y0 = Math.floor(my(b.top));
      ctx.fillRect(x0, y0, Math.ceil(mx(b.right)) - x0, Math.ceil(my(b.bottom)) - y0);
    }
    for (const t of boxes) {
      const size = Math.round(t.px * k * 100) / 100;
      if (!(size > 0)) continue;
      const font = t.fontAt(size);
      // Keep the exact enlarged width of the original (font hinting changes widths slightly).
      const w0 = textWidth(t.font, t.text) * t.wpx * k;
      const w1 = textWidth(font, t.text);
      const fx = w1 > 0 && w0 > 0 ? w0 / w1 : 1;
      ctx.save();
      ctx.beginPath();
      const cx0 = mx(t.clip[0]);
      const cy0 = my(t.clip[1]);
      ctx.rect(cx0, cy0, mx(t.clip[2]) - cx0, my(t.clip[3]) - cy0);
      ctx.clip();
      ctx.font = font;
      ctx.fillStyle = t.fill;
      ctx.globalAlpha = t.alpha >= 0 && t.alpha <= 1 ? t.alpha : 1;
      ctx.textAlign = t.align || "start";
      ctx.textBaseline = t.base || "alphabetic";
      ctx.direction = t.dir === "rtl" ? "rtl" : "ltr";
      ctx.setTransform(fx, 0, 0, 1, mx(t.x), my(t.y));
      ctx.fillText(t.text, 0, 0);
      // Underline / strikethrough lines (Sheets draws them separately), measured from the pixels.
      ctx.setTransform(1, 0, 0, 1, 0, 0);
      for (const d of t.decos || []) {
        const x0 = mx(t.x + d.x0);
        const y0 = Math.round(my(t.y + d.y0));
        const y1 = Math.max(y0 + 1, Math.round(my(t.y + d.y1)));
        ctx.fillRect(x0, y0, mx(t.x + d.x1) - x0, y1 - y0);
      }
      ctx.restore();
    }
    return boxes.length;
  }

  // A separator pixel: neutral grey, darker than cell/header backgrounds, lighter than text.
  function isLinePx(d, i) {
    const r = d[i], g = d[i + 1], b = d[i + 2];
    const avg = (r + g + b) / 3;
    return Math.max(r, g, b) - Math.min(r, g, b) < 18 && avg >= 130 && avg <= 236;
  }

  // Runs of separator pixels along a line of the pixel buffer.
  function lineRuns(p, horizontal, fixed) {
    const n = horizontal ? p.w : p.h;
    const runs = [];
    let start = -1;
    for (let t = 0; t <= n; t++) {
      const on = t < n && isLinePx(p.data, horizontal ? p.idx(t, fixed) : p.idx(fixed, t));
      if (on && start < 0) start = t;
      if (!on && start >= 0) {
        runs.push({ a: start, b: t - 1, len: t - start });
        start = -1;
      }
    }
    return runs;
  }

  const scrollerOf = (axis) => document.querySelector(`#waffle-grid-container .native-scrollbar-${axis}`) ||
    document.querySelector(`.native-scrollbar-${axis}`);
  const scrollTopOf = () => { const s = scrollerOf("y"); return s ? s.scrollTop : null; };
  const scrollLeftOf = () => { const s = scrollerOf("x"); return s ? s.scrollLeft : null; };

  // Row bands from the row-number column. Returns header-band bottom and visible rows
  // ({top, bottom, frozen}) in viewport CSS px; a row includes its bottom separator.
  function scanRows(p) {
    if (!p) return null;
    const thin = 2.5 * p.ky;
    const lines = lineRuns(p, false, 0).filter((r) => r.len <= 8 * p.ky);
    if (lines.length < 2) return null;
    const rows = [];
    let frozen = false;
    let seenThick = false;
    for (let i = 0; i + 1 < lines.length; i++) {
      if (lines[i].len > thin) seenThick = true;
      const top = lines[i].b + 1;
      // A row includes its 1px bottom separator, but not a thick frozen-rows bar.
      const bottom = lines[i + 1].len > thin ? lines[i + 1].a + Math.round(p.ky) : lines[i + 1].b + 1;
      if (lines[i + 1].a - top < 2 * p.ky) continue; // adjacent lines (e.g. line + frozen bar)
      rows.push({ top: p.cssY(top), bottom: p.cssY(bottom), afterThick: seenThick });
    }
    // Rows before the frozen bar are frozen (rows 1..n); everything is scrollable without a bar.
    const hasBar = seenThick;
    for (const r of rows) r.frozen = hasBar && !r.afterThick;
    return { headerBottom: p.cssY(lines[0].b + 1), rows };
  }

  // Number the visible rows. Frozen rows are 1..n from the top. Scrollable rows are numbered
  // from the selected row (anchor) when known, or from the top when scrolled to the very top.
  //
  // Hidden or filtered rows leave no trace in the row-number column, so a number is only
  // marked `sure` when it can be verified: frozen rows always; scrollable rows when the sheet
  // is scrolled to the top and, counting from the top, the selected row gets its real number
  // (then no rows are hidden above it). Only sure rows are used as the header row.
  function indexRows(scan, anchor) {
    const frozen = scan.rows.filter((r) => r.frozen);
    frozen.forEach((r, i) => { r.index = i + 1; r.sure = true; });
    const scroll = scan.rows.filter((r) => !r.frozen);
    if (scrollTopOf() !== 0) return; // first visible scrollable row may be clipped/unknown
    scroll.forEach((r, i) => { r.index = frozen.length + 1 + i; r.sure = false; });
    const k = anchor ? scroll.findIndex((r) => Math.abs(r.top - anchor.top) < 2.5) : -1;
    if (k >= 0 && scroll[k].index === anchor.row) {
      for (let i = 0; i <= k; i++) scroll[i].sure = true;
    } else if (!anchor && scroll.length && scroll[0].index === 1) {
      scroll[0].sure = true; // row 1 at the very top: nothing can be hidden above it
    }
  }

  // Column segments from the column-letter header band: [{l, r, sep: {l, r} | null}] in
  // viewport CSS px, the first segment being the row-number column. `fixedRight` is where the
  // horizontally scrolling area starts (after frozen columns, if any).
  function scanColumns(p, headerBottom) {
    if (!p) return null;
    const bandH = Math.min(p.h, p.devY(headerBottom)); // the band read may be taller than the header
    if (bandH < 8 * p.ky) return null;
    const ya = Math.round(3 * p.ky);
    const yb = bandH - 1 - Math.round(4 * p.ky);
    const runsA = lineRuns(p, true, ya).filter((r) => r.len <= 8 * p.kx);
    const runsB = lineRuns(p, true, yb);
    const seps = runsA.filter((ra) => runsB.some((rb) => rb.a <= ra.b && ra.a <= rb.b));
    if (!seps.length) return null;
    const segs = [];
    let l = p.cssX(0);
    for (const s of seps) {
      const sep = { l: p.cssX(s.a), r: p.cssX(s.b + 1), thick: s.len > 2.5 * p.kx };
      if (sep.l > l) segs.push({ l, r: sep.l, sep });
      l = sep.r;
    }
    if (p.cssX(p.w) > l) segs.push({ l, r: p.cssX(p.w), sep: null });
    const thick = seps.map((s) => ({ s, thick: s.len > 2.5 * p.kx })).filter((x) => x.thick).pop();
    const fixedRight = thick ? p.cssX(thick.s.b + 1) : segs[0].r + (segs[0].sep ? segs[0].sep.r - segs[0].sep.l : 0);
    return { segs, fixedRight };
  }

  // Cells of one row strip: neighbouring segments are merged where the row draws no separator
  // (merged cells, text overflowing into an empty cell, hidden gridlines). Each cell gets an
  // anchor `a`: the point that stays put when its contents are enlarged (text start for
  // left-aligned text, text end for right-aligned numbers, centre for centred text).
  function stripCells(p, segs) {
    if (!p) return null;
    const d = p.data;
    // Ignore a couple of pixels at each edge so cell borders and gridlines never count as text.
    const yA = Math.min(p.h - 1, Math.ceil(2 * p.ky));
    const yB = Math.max(yA + 1, p.h - Math.ceil(3 * p.ky));
    const diff = (i, j) => Math.abs(d[i] - d[j]) + Math.abs(d[i + 1] - d[j + 1]) + Math.abs(d[i + 2] - d[j + 2]);
    // Most common colour in a pixel column: the cell's background (robust to glyphs/borders).
    const bgAt = (x) => {
      const counts = new Map();
      let best = p.idx(x, yA);
      let bestN = 0;
      for (let y = yA; y < yB; y++) {
        const i = p.idx(x, y);
        const key = (d[i] << 16) | (d[i + 1] << 8) | d[i + 2];
        const n = (counts.get(key) || 0) + 1;
        counts.set(key, n);
        if (n > bestN) { bestN = n; best = i; }
      }
      return best;
    };
    const clampX = (x) => Math.min(p.w - 1, Math.max(0, x));
    const edge = Math.ceil(2 * p.kx);
    // Two columns are only joined when text actually crosses the boundary between them (text
    // overflowing into an empty cell, merged cells). A gridline, a fill colour, a border or a
    // hidden gridline all keep them separate, so filled/bordered rows stay aligned too.
    const joined = (sep, left, right) => {
      const x = clampX(p.devX(sep.l));
      const bgL = bgAt(clampX(p.devX(left.r) - edge));
      const bgR = bgAt(clampX(p.devX(right.l) + edge));
      let ink = 0;
      for (let y = yA; y < yB; y++) {
        const i = p.idx(x, y);
        if (!isLinePx(d, i) && diff(i, bgL) > 90 && diff(i, bgR) > 90) ink++;
      }
      return ink >= 2 && ink < (yB - yA) * 0.9; // a solid run is a border, not text
    };
    const cells = [];
    const seps = [];
    let cur = null;
    segs.forEach((s, n) => {
      if (!cur) cur = { l: s.l, r: s.r };
      else cur.r = s.r;
      const next = segs[n + 1];
      if (!s.sep || n === 0 || !next || !joined(s.sep, s, next)) {
        cells.push(cur);
        cur = null;
        if (s.sep) seps.push({ l: s.sep.l, r: s.sep.r });
      } else {
        cur.r = s.sep.r;
      }
    });
    if (cur) cells.push(cur);

    for (const cell of cells) {
      const xa = clampX(p.devX(cell.l) + edge);
      const xb = Math.min(p.w, p.devX(cell.r) - edge);
      if (xb <= xa) {
        cell.a = cell.l;
        continue;
      }
      const bg = bgAt(xa);
      cell.bg = `rgb(${d[bg]}, ${d[bg + 1]}, ${d[bg + 2]})`; // fills the padding around the row
      let inkL = -1;
      let inkR = -1;
      for (let x = xa; x < xb; x++) {
        for (let y = yA; y < yB; y++) {
          if (diff(p.idx(x, y), bg) > 90) {
            if (inkL < 0) inkL = x;
            inkR = x;
            break;
          }
        }
      }
      if (inkL < 0) {
        cell.a = cell.l;
        continue;
      }
      const L = p.cssX(inkL);
      const R = p.cssX(inkR + 1);
      const gapL = L - cell.l;
      const gapR = cell.r - R;
      // Text filling (nearly) the whole cell is anchored at its start so the beginning stays
      // readable; centred text at its middle; right-aligned (numbers) at its end.
      if (R - L >= cell.r - cell.l - 8) cell.a = L;
      else if (gapL > 5 && gapR > 5 && Math.abs(gapL - gapR) <= 3) cell.a = (L + R) / 2;
      else if (gapR < gapL && gapR <= 8) cell.a = R;
      else cell.a = L;
    }
    return { cells, seps };
  }

  // ---------------------------------------------------------------- header row cache
  //
  // Sheets only paints what is on screen, so the header row's pixels are cached whenever it
  // is visible and reused (shifted with horizontal scroll) once it scrolls out of view.

  let headerCache = null;
  const sheetGid = () => (/[#&?]gid=(\d+)/.exec(location.href) || [])[1] || "0";

  function captureHeader(c, cr, scan, cols, right) {
    const key = `${sheetGid()}|${settings.headerRow}`;
    const keep = headerCache && headerCache.key === key ? headerCache : null;
    const hdr = scan.rows.find((r) => r.index === settings.headerRow && r.sure);
    if (!hdr || !cols) return keep;
    const rect = { left: cr.left, right, top: hdr.top, bottom: hdr.bottom };
    rect.width = rect.right - rect.left;
    rect.height = rect.bottom - rect.top;
    // Don't replace a good copy with a row that is partly scrolled out of view.
    if (keep && rect.height < keep.rect.height - 1 && Math.abs(keep.kx - c.width / cr.width) < 0.01) return keep;
    // Nor re-read one captured moments ago at the same place.
    if (keep && performance.now() - keep.at < HEADER_REFRESH_MS && keep.scrollLeft === scrollLeftOf() &&
        Math.abs(keep.rect.top - rect.top) < 0.5 && Math.abs(keep.rect.height - rect.height) < 0.5 &&
        Math.abs(keep.kx - c.width / cr.width) < 0.01) return keep;
    const snapRect = { ...rect, bottom: Math.min(rect.bottom, rect.top + SNAPSHOT_MAX_H) };
    const snap = readSnapshot(c, cr, [{ rect: snapRect }])[0];
    const parts = stripCells(snap, cols.segs);
    if (!parts) return keep;
    const verdicts = checkTexts(snap, textsIn([c], snapRect), snapRect);
    const kx = c.width / cr.width;
    const ky = c.height / cr.height;
    const w = Math.max(1, Math.round(rect.width * kx));
    const h = Math.max(1, Math.round(rect.height * ky));
    const img = headerCache && headerCache.img ? headerCache.img : document.createElement("canvas");
    if (img.width !== w) img.width = w;
    if (img.height !== h) img.height = h;
    const ictx = img.getContext("2d");
    ictx.clearRect(0, 0, w, h);
    ictx.drawImage(c, (rect.left - cr.left) * kx, (rect.top - cr.top) * ky, w, h, 0, 0, w, h);
    headerCache = { key, img, kx, ky, rect, cells: parts.cells, seps: parts.seps, texts: sharpOnly(textsIn([c], rect), verdicts),
      colSeps: cols.segs.filter((s) => s.sep).map((s) => s.sep.l),
      scrollLeft: scrollLeftOf(), scrollTop: scrollTopOf(), fixedRight: cols.fixedRight,
      at: performance.now(), canvasW: c.width, canvasH: c.height };
    return headerCache;
  }

  // The cached header is only drawn if its columns still line up with the live grid (a column
  // resized/inserted, a zoom or freeze change while the header was off screen would misalign it).
  function headerFits(cache, a, rowLeft, rowRight) {
    if (!a.colSeps || Math.abs(cache.kx - a.kx) > 0.01 || Math.abs(cache.fixedRight - a.fixedRight) > 1) return false;
    const sl = scrollLeftOf();
    const shift = (x, fixedRight, sl0) => (x >= fixedRight - 0.5 && sl0 !== null && sl !== null ? x + sl0 - sl : x);
    const live = a.colSeps.map((x) => shift(x, a.fixedRight, a.sl));
    if (!live.length) return false;
    // Compare only where the live analysis has data (it may lag behind horizontal scrolling).
    const lo = Math.max(rowLeft, Math.min(...live) - 1);
    const hi = Math.min(rowRight, Math.max(...live) + 1);
    const cached = cache.colSeps.map((x) => shift(x, cache.fixedRight, cache.scrollLeft)).filter((x) => x >= lo && x <= hi);
    if (!cached.length) return true;
    const hits = cached.filter((x) => live.some((y) => Math.abs(x - y) <= 1)).length;
    return hits / cached.length >= 0.8;
  }

  // Draw source for the cached header image (coordinates: viewport CSS px at capture time).
  function cacheSource(cache) {
    return (sx, sy, sw, sh, dx, dy, dw, dh) => {
      const part = intersect({ left: sx, top: sy, right: sx + sw, bottom: sy + sh }, cache.rect);
      if (!part || sw <= 0 || sh <= 0) return;
      const fx = dw / sw;
      const fy = dh / sh;
      ctx.drawImage(
        cache.img,
        (part.left - cache.rect.left) * cache.kx, (part.top - cache.rect.top) * cache.ky,
        part.width * cache.kx, part.height * cache.ky,
        dx + (part.left - sx) * fx, dy + (part.top - sy) * fy, part.width * fx, part.height * fy
      );
    };
  }

  // Cached header cells, moved by the horizontal scroll since capture (frozen part stays put).
  function headerStrip(cache, fixedRight) {
    const sl = scrollLeftOf();
    const delta = cache.scrollLeft !== null && sl !== null ? cache.scrollLeft - sl : 0;
    const move = (o) => (o.l >= cache.fixedRight - 0.5 ? { ...o, d: delta, minX: fixedRight } : { ...o, d: 0 });
    return {
      src: cacheSource(cache),
      top: cache.rect.top,
      height: cache.rect.height,
      cells: cache.cells.map(move),
      seps: cache.seps.map(move),
      texts: cache.texts
    };
  }

  // Opportunistic capture while no row is focused (e.g. right after the sheet loads, when
  // the header row is usually on screen), so the header is available later.
  let captureTimer = 0;
  let lastCaptureTry = -Infinity;
  const HEADER_REFRESH_MS = 15000; // a header seen this recently at the same place isn't re-read
  const CAPTURE_MIN_GAP_MS = 2000;
  function scheduleHeaderCapture() {
    if (!settings.enabled || !settings.showHeader || activeRow !== null) return;
    clearTimeout(captureTimer);
    captureTimer = setTimeout(() => {
      captureTimer = 0;
      if (!alive || activeRow !== null) return;
      try {
        const grid = gridContainer();
        const canvases = grid ? gridCanvases(grid) : [];
        if (!canvases.length) return;
        const c = mainCanvas(canvases);
        // Typing or scrolling pauses come often: don't read pixels back for an unchanged view.
        const hc = headerCache && headerCache.key === headerKey() ? headerCache : null;
        if (hc && performance.now() - hc.at < HEADER_REFRESH_MS && hc.scrollTop === scrollTopOf() &&
            hc.scrollLeft === scrollLeftOf() && hc.canvasW === c.width && hc.canvasH === c.height) return;
        if (performance.now() - lastCaptureTry < CAPTURE_MIN_GAP_MS) return;
        lastCaptureTry = performance.now();
        const cr = rectOf(c);
        const vis = visibleRect(c, grid) || cr;
        const g = analyzeGrid(c, cr, vis.right, vis.bottom, null);
        if (!g.scan) return;
        indexRows(g.scan, null);
        captureHeader(c, cr, g.scan, g.cols, vis.right);
      } catch (_) {
        /* pixels unreadable */
      }
    }, 400);
  }

  const mainCanvas = (canvases) => canvases.reduce((a, b) => (a.width * a.height >= b.width * b.height ? a : b));
  const headerKey = () => `${sheetGid()}|${settings.headerRow}`;

  // One pixel read: row-number column (transposed), column-letter band, and optionally a row.
  function analyzeGrid(c, cr, right, bottom, rowRect) {
    const specs = [
      { rect: { left: cr.left + 1, right: cr.left + 3, top: cr.top, bottom }, transpose: true },
      { rect: { left: cr.left, right, top: cr.top, bottom: Math.min(bottom, cr.top + 64) } }
    ];
    if (rowRect) specs.push({ rect: rowRect });
    const [pv, pb, pr] = readSnapshot(c, cr, specs);
    const scan = scanRows(pv);
    const cols = scan ? scanColumns(pb, scan.headerBottom) : null;
    const rowParts = cols && pr ? stripCells(pr, cols.segs) : null;
    return { scan, cols, rowParts, rowSnap: pr };
  }

  // Analysis of the focused row, reused between paints. It is redone when the row, sheet,
  // zoom or settings change, after horizontal scrolling settles, and every few seconds
  // at rest (to pick up edited contents). While scrolling it is reused: vertical scrolling
  // doesn't move columns, and horizontal scrolling just slides them (see slideCells).
  let analysis = null;
  const ANALYSIS_MS = 5000;
  const ANALYSIS_MAX_AGE_MS = 6000;
  const RECHECK_MS = 250;        // re-check soon when Sheets has redrawn text in the row
  function currentAnalysis(now, canvases, row, contentBottom) {
    const c = mainCanvas(canvases);
    const cr = rectOf(c);
    const key = [activeRow, c.width, c.height, Math.round(cr.left), Math.round(cr.top), Math.round(cr.width),
      Math.round(cr.height), settings.alignColumns, settings.showHeader, settings.headerRow, sheetGid()].join("|");
    const sl = scrollLeftOf();
    const age = analysis ? now - analysis.at : Infinity;
    if (analysis && analysis.key === key &&
        (now < burstUntil ? age < ANALYSIS_MAX_AGE_MS : age < ANALYSIS_MS && analysis.sl === sl)) {
      return analysis;
    }
    analysis = { key, at: now, sl, fixedRight: row.left, rowCells: null, colSeps: null, kx: c.width / cr.width,
      sharp: new Map() };
    try {
      // Only the top of a very tall (wrapped) row is read; text below it stays as pixels.
      const rowRect = { ...row, bottom: Math.min(row.bottom, row.top + SNAPSHOT_MAX_H) };
      const g = analyzeGrid(c, cr, row.right, contentBottom, rowRect);
      if (g.rowSnap) analysis.sharp = checkTexts(g.rowSnap, textsIn([c], row), rowRect);
      if (g.cols) {
        analysis.fixedRight = g.cols.fixedRight;
        analysis.colSeps = g.cols.segs.filter((s) => s.sep).map((s) => s.sep.l);
      }
      analysis.rowCells = g.rowParts;
      if (g.scan && settings.showHeader) {
        indexRows(g.scan, { row: activeRow, top: row.top });
        captureHeader(c, cr, g.scan, g.cols, row.right);
      }
    } catch (_) {
      /* Sheets' canvas is unreadable (e.g. tainted by a cross-origin image): no analysis */
    }
    return analysis;
  }

  // Cells analysed at one horizontal scroll position, moved to the current one. Cells right of
  // the frozen columns slide with the scroll; any newly exposed gap is filled with a plain cell
  // until the next analysis.
  function slideCells(parts, sl0, fixedRight, rowLeft, rowRight) {
    const sl = scrollLeftOf();
    const delta = sl0 !== null && sl !== null ? sl0 - sl : 0;
    if (!delta) return parts;
    const move = (o) => (o.l >= fixedRight - 0.5 ? { ...o, d: delta, minX: fixedRight } : o);
    const cells = parts.cells.map(move);
    const seps = parts.seps.map(move);
    if (delta < 0) {
      const end = Math.max(...cells.map((x) => x.r + (x.d || 0)));
      if (end < rowRight) cells.push({ l: end, r: rowRight, a: end });
    } else {
      cells.push({ l: fixedRight, r: Math.min(rowRight, fixedRight + delta), a: fixedRight });
    }
    return { cells, seps };
  }

  // Draw a strip of cells: each cell is enlarged around its anchor and clipped to its own
  // column, so columns stay aligned with the rest of the grid; separators are stretched.
  // `pad` (CSS px) adds breathing room above and below: each cell's background is extended
  // into it and the column separators run through it.
  // Cells and texts of a live strip may have been analysed before a horizontal scroll: a cell's
  // `l`/`r`/`a` are then where it was, `d` how far it has moved since. A live strip's pixels and
  // text are read where the cell is now (l + d); a cached strip's where it was captured (l).
  // Returns the number of text pieces redrawn as sharp text.
  function drawCells(strip, destTop, scale, dpr, oLeft, oRight, pad = 0) {
    const h = strip.height;
    const dy = destTop * dpr;
    const dh = h * scale * dpr;
    const pd = pad * dpr;
    const bgY = strip.top + Math.min(2, h / 4); // a line inside the cell, above its text
    const my = (y) => dy + (y - strip.top) * scale * dpr;
    let sharp = 0;
    for (const cell of strip.cells) {
      const d = cell.d || 0;
      const at = strip.live ? d : 0; // source offset of this cell's contents
      const cl = Math.max(cell.l + d, oLeft, cell.minX !== undefined ? cell.minX : -Infinity);
      const cr = Math.min(cell.r + d, oRight);
      if (cr <= cl) continue;
      ctx.save();
      ctx.beginPath();
      ctx.rect((cl - oLeft) * dpr, dy - pd, (cr - cl) * dpr, dh + 2 * pd);
      ctx.clip();
      const destL = cell.a + d + (cell.l - cell.a) * scale;
      const dw = (cell.r - cell.l) * scale * dpr;
      if (pad && cell.bg) {
        ctx.fillStyle = cell.bg;
        ctx.fillRect((cl - oLeft) * dpr, dy - pd, (cr - cl) * dpr, dh + 2 * pd);
      } else if (pad) {
        strip.src(cell.l + at, bgY, cell.r - cell.l, 1, (destL - oLeft) * dpr, dy - pd, dw, dh + 2 * pd);
      }
      strip.src(cell.l + at, strip.top, cell.r - cell.l, h, (destL - oLeft) * dpr, dy, dw, dh);
      if (strip.texts) {
        // Text whose visible part lies in this cell's source range, mapped like its pixels.
        const lo = cell.l + at;
        const hi = cell.r + at;
        const mine = strip.texts.filter((t) => Math.min(t.box[2], t.clip[2]) > lo && Math.max(t.box[0], t.clip[0]) < hi);
        if (mine.length) {
          const mx = (x) => (cell.a + d + (x - at - cell.a) * scale - oLeft) * dpr;
          sharp += drawTexts(mine, mx, my, scale * dpr, { top: strip.top, bottom: strip.top + h });
        }
      }
      ctx.restore();
    }
    for (const s of strip.seps) {
      const d = s.d || 0;
      if (s.l + d < (s.minX !== undefined ? s.minX : oLeft) || s.r + d > oRight) continue;
      strip.src(s.l + (strip.live ? d : 0), strip.top, s.r - s.l, h, (s.l + d - oLeft) * dpr, dy - pd, (s.r - s.l) * dpr, dh + 2 * pd);
    }
    return sharp;
  }

  // ---------------------------------------------------------------- overlay

  function ensureOverlay() {
    const grid = gridContainer();
    if (!grid) return null;
    if (overlay && overlay.parentElement === grid) return overlay;
    if (!overlay) {
      overlay = document.createElement("canvas");
      overlay.className = "sheets-row-focus-overlay";
      overlay.setAttribute("aria-hidden", "true");
      ctx = overlay.getContext("2d");
    }
    // Inside the grid container so Sheets' menus, dialogs and tooltips stay on top of it.
    grid.appendChild(overlay);
    return overlay;
  }

  function hideOverlay() {
    if (overlay) {
      overlay.classList.remove("is-visible");
      // Release the pixel buffer while hidden (it is reallocated on the next paint).
      if (overlay.width || overlay.height) {
        overlay.width = 0;
        overlay.height = 0;
      }
    }
    lastKey = "";
    geom = null;
  }

  function removeOverlay() {
    hideOverlay();
    if (overlay) overlay.remove();
    overlay = null;
    ctx = null;
  }

  function paint(now) {
    // Never cover Sheets' cell editor while the user types into the selected row.
    const m = isEditingCell() ? null : measureRow();
    if (!m || !ensureOverlay()) {
      hideOverlay();
      return;
    }
    const { row, gridRect, canvases, contentBottom } = m;
    const scale = settings.scale / 100;
    const dpr = window.devicePixelRatio || 1;
    const live = liveSource(canvases);

    // Cell layout of the selected row (column-aligned), plus the header row if requested.
    // Falls back to enlarging the row as one picture if the grid can't be analysed.
    let rowStrip = { src: live, live: true, top: row.top, height: row.height,
      cells: [{ l: row.left, r: row.right, a: row.left }], seps: [], texts: null };
    let aligned = false;
    let hdrStrip = null;
    {
      let a = currentAnalysis(now, canvases, row, contentBottom);
      let texts = textsIn(canvases, row);
      const main = mainCanvas(canvases);
      if (texts && now - a.at > RECHECK_MS && texts.some((t) => t.canvas === main && !a.sharp.has(t.id))) {
        a.at = -Infinity;
        a = currentAnalysis(now, canvases, row, contentBottom);
        texts = textsIn(canvases, row);
      }
      rowStrip.texts = sharpOnly(texts, a.sharp);
      if (settings.alignColumns && a.rowCells) {
        const parts = slideCells(a.rowCells, a.sl, a.fixedRight, row.left, row.right);
        rowStrip = { ...rowStrip, cells: parts.cells, seps: parts.seps };
        aligned = true;
      }
      const cache = headerCache && headerCache.key === headerKey() ? headerCache : null;
      if (cache && settings.showHeader && activeRow > settings.headerRow + 1 &&
          headerFits(cache, a, row.left, row.right)) {
        hdrStrip = headerStrip(cache, a.fixedRight);
        if (!settings.alignColumns) {
          // Same one-picture enlargement as the row when alignment is off: the frozen part stays,
          // the scrolling part slides, both scaled about the row's left edge like the row itself.
          const sl = scrollLeftOf();
          const delta = cache.scrollLeft !== null && sl !== null ? cache.scrollLeft - sl : 0;
          const L = cache.rect.left;
          hdrStrip.cells = [
            { l: L, r: cache.fixedRight, a: L, d: 0 },
            { l: cache.fixedRight, r: cache.rect.right, a: L - delta, d: delta, minX: a.fixedRight }
          ];
          hdrStrip.seps = [];
        }
      }
    }

    // Vertical layout: [header strip][enlarged row][rows below, pushed down].
    const width = row.width;
    const left = row.left;
    const stripH = row.height * scale;
    const pad = ROW_PADDING;
    let hdrH = hdrStrip ? hdrStrip.height * scale : 0;
    if (hdrH && hdrH + stripH + 2 * pad > gridRect.height) hdrH = 0, hdrStrip = null;
    const blockH = Math.min(hdrH + stripH + 2 * pad, gridRect.height);
    const extra = blockH - row.height;
    let top;
    let height;
    let yOffset = 0;  // offset of the enlarged row inside its strip (when clamped to grid height)
    let shift = 0;    // how far the rows below are pushed down
    if (settings.pushRows && extra >= 0.5 && row.top + blockH <= contentBottom) {
      // Make room: the block grows downward from the row's own top and every row below it is
      // redrawn shifted down, so neighbouring rows stay fully visible and clickable.
      top = row.top;
      height = contentBottom - row.top;
      shift = extra;
    } else {
      // Overlay mode (or no room below): the enlarged row is centred on the real row with the
      // header strip right above it, all kept inside the grid.
      height = blockH;
      top = row.top + row.height / 2 - (blockH - hdrH) / 2 - hdrH;
      top = Math.max(gridRect.top, Math.min(top, gridRect.bottom - blockH));
      yOffset = (blockH - hdrH - 2 * pad - stripH) / 2;
    }
    const stripTop = top + hdrH;   // top of the padded row area
    geom = { left, top, width, height, hdrH, stripTop, stripH: blockH - hdrH, pad, shift, yOffset, scale, aligned,
      rowLeft: row.left, rowTop: row.top, rowHeight: row.height };

    const key = [row.left, row.top, row.width, row.height, top, height, hdrH, dpr, settings.scale,
      settings.pushRows, settings.alignColumns, settings.showHeader, settings.headerRow,
      settings.fillEnabled, settings.fillColor, settings.fillOpacity, scrollLeftOf()].join("|");
    if (!dirty && key === lastKey && now - lastPaint < REFRESH_MS) return;
    lastKey = key;
    lastPaint = now;
    dirty = false;

    const pxW = Math.max(1, Math.round(width * dpr));
    const pxH = Math.max(1, Math.round(height * dpr));
    if (overlay.width !== pxW) overlay.width = pxW;
    if (overlay.height !== pxH) overlay.height = pxH;
    overlay.style.width = `${width}px`;
    overlay.style.height = `${height}px`;
    overlay.classList.add("is-visible");
    overlay.classList.toggle("is-pushing", shift > 0);
    // Exposed for tests/debugging.
    overlay.dataset.stripTop = String(stripTop);
    overlay.dataset.stripHeight = String(blockH - hdrH);
    overlay.dataset.pad = String(pad);
    overlay.dataset.headerHeight = String(hdrH);
    overlay.dataset.shift = String(shift);
    overlay.dataset.aligned = String(aligned);
    placeOverlay(left, top);

    const hdrPx = Math.round(hdrH * dpr);
    const blockPx = Math.round(blockH * dpr);
    const right = left + width;
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.globalCompositeOperation = "source-over";
    ctx.globalAlpha = 1;
    ctx.fillStyle = "#ffffff";
    ctx.fillRect(0, 0, pxW, pxH);
    ctx.imageSmoothingEnabled = true;
    ctx.imageSmoothingQuality = "high";

    // 1. Header row strip (column titles), enlarged like the row and lightly shaded.
    let sharpHeader = 0;
    if (hdrStrip) {
      sharpHeader = drawCells(hdrStrip, 0, scale, dpr, left, right);
      ctx.globalCompositeOperation = "multiply";
      ctx.fillStyle = "#e8eaed";
      ctx.fillRect(0, 0, pxW, hdrPx);
      ctx.globalCompositeOperation = "source-over";
    }

    // 2. The selected row, enlarged (cell by cell when aligned).
    const sharpRow = drawCells(rowStrip, hdrH + pad + yOffset, scale, dpr, left, right, pad);
    overlay.dataset.sharpText = String(sharpRow);       // exposed for tests/debugging
    overlay.dataset.sharpHeader = String(sharpHeader);

    // 3. Push mode: the rows below, at normal size, moved down by `shift`.
    if (shift > 0) {
      const hBelow = contentBottom - shift - row.bottom;
      if (hBelow > 0) live(row.left, row.bottom, width, hBelow, 0, blockPx, width * dpr, hBelow * dpr);
    }

    // 4. Fill color on the enlarged row only. Multiply keeps text and borders dark while white
    //    cell backgrounds take the color.
    if (settings.fillEnabled) {
      ctx.globalCompositeOperation = "multiply";
      ctx.globalAlpha = settings.fillOpacity / 100;
      ctx.fillStyle = settings.fillColor;
      ctx.fillRect(0, hdrPx, pxW, blockPx - hdrPx);
      ctx.globalCompositeOperation = "source-over";
      ctx.globalAlpha = 1;
    }

    // 5. Outline the block (header + row), a divider under the header, and a soft shadow onto
    //    the pushed rows.
    if (shift > 0) {
      const sh = Math.round(6 * dpr);
      const grad = ctx.createLinearGradient(0, blockPx, 0, blockPx + sh);
      grad.addColorStop(0, "rgba(0, 0, 0, 0.22)");
      grad.addColorStop(1, "rgba(0, 0, 0, 0)");
      ctx.fillStyle = grad;
      ctx.fillRect(0, blockPx, pxW, sh);
    }
    const lw = Math.max(1, Math.round(2 * dpr));
    ctx.strokeStyle = "rgba(32, 33, 36, 0.85)";
    ctx.lineWidth = lw;
    ctx.strokeRect(lw / 2, lw / 2, pxW - lw, blockPx - lw);
    if (hdrPx) {
      ctx.lineWidth = Math.max(1, Math.round(dpr));
      ctx.beginPath();
      ctx.moveTo(0, hdrPx);
      ctx.lineTo(pxW, hdrPx);
      ctx.stroke();
    }
  }

  // position:fixed can be offset by transformed ancestors; measure and correct.
  function placeOverlay(left, top) {
    overlay.style.left = `${left}px`;
    overlay.style.top = `${top}px`;
    const r = overlay.getBoundingClientRect();
    const dx = left - r.left;
    const dy = top - r.top;
    if (Math.abs(dx) > 0.5 || Math.abs(dy) > 0.5) {
      overlay.style.left = `${left + dx}px`;
      overlay.style.top = `${top + dy}px`;
    }
  }

  // Frame scheduling. Measuring the row forces style/layout reads, so it is not done every
  // frame forever: after anything that can move the row (scroll, wheel, input, resize, a DOM
  // change inside the grid) it runs every frame for a short burst, then drops to a slow
  // refresh that only picks up cell contents changing underneath (e.g. collaborators' edits).
  const isRunning = () => alive && activeRow !== null && settings.enabled;

  function loop(now) {
    rafId = 0;
    if (!isRunning()) return;
    paint(now);
    if (now < burstUntil) {
      rafId = requestAnimationFrame(loop);
    } else if (!document.hidden) {
      idleTimer = setTimeout(() => {
        idleTimer = 0;
        if (!rafId && isRunning()) rafId = requestAnimationFrame(loop);
      }, IDLE_REFRESH_MS);
    }
  }

  function wake() {
    dirty = true;
    burstUntil = performance.now() + BURST_MS;
    if (!isRunning()) {
      scheduleHeaderCapture();
      return;
    }
    if (idleTimer) {
      clearTimeout(idleTimer);
      idleTimer = 0;
    }
    if (!rafId) rafId = requestAnimationFrame(loop);
  }

  const startLoop = wake;

  function stopLoop() {
    if (rafId) cancelAnimationFrame(rafId);
    if (idleTimer) clearTimeout(idleTimer);
    rafId = 0;
    idleTimer = 0;
  }

  // Sheets repositions its selection/scroll DOM when the grid moves; treat that as a wake-up.
  function observeGrid() {
    const grid = gridContainer();
    if (!grid || observedGrid === grid) return;
    if (gridObserver) gridObserver.disconnect();
    gridObserver = new MutationObserver((records) => {
      if (records.some((r) => r.target !== overlay)) wake();
    });
    gridObserver.observe(grid, { attributes: true, attributeFilter: ["style", "class"], subtree: true });
    observedGrid = grid;
  }

  // ---------------------------------------------------------------- click remapping
  //
  // The overlay ignores the mouse, but what it shows is enlarged (and, in push mode, the rows
  // below are moved down), so a click on the magnified "column D" or on a pushed row would
  // really hit whatever lies beneath it. Mouse events landing on the overlay are therefore
  // re-sent to the cell the user actually sees under the pointer.
  // A whole gesture (down → move → up → click, and a quick second click for double-click)
  // keeps the mapping it started with, even after the overlay disappears mid-gesture.

  const DOWN = new Set(["pointerdown", "mousedown"]);
  const UP = new Set(["pointerup", "mouseup"]);
  const HOVER = new Set(["pointermove", "mousemove", "contextmenu"]);
  const REMAPPED_TYPES = ["pointerdown", "mousedown", "pointermove", "mousemove", "pointerup",
    "mouseup", "click", "auxclick", "dblclick", "contextmenu"];
  const DBLCLICK_MS = 500;

  function hitOverlay(x, y) {
    const g = geom;
    if (!g || (g.scale === 1 && !g.shift && !g.hdrH) || !overlay || !overlay.classList.contains("is-visible")) return null;
    if (x < g.left || x >= g.left + g.width || y < g.top || y >= g.top + g.height) return null;
    return g;
  }

  function mapPoint(g, x, y) {
    // Pushed-down rows below the enlarged row: same size, just moved down by `shift`.
    const clampX = (v) => Math.min(g.rowLeft + g.width - 1, Math.max(g.rowLeft, v));
    if (g.shift > 0 && y >= g.stripTop + g.stripH) {
      return { x: clampX(x), y: y - g.shift };
    }
    // Aligned cells keep their real columns, so x is unchanged; otherwise undo the enlargement.
    const mx = g.aligned ? x : g.rowLeft + (x - g.left) / g.scale;
    // The header strip above the row maps onto the selected row (same column).
    const my = y < g.stripTop ? g.rowTop + g.rowHeight / 2 : g.rowTop + (y - g.stripTop - g.pad - g.yOffset) / g.scale;
    // Keep the mapped point safely inside the row (clicks on the padding or the edge of the
    // magnified row must never land on the neighbouring row's border).
    const inset = Math.min(4, g.rowHeight / 3);
    return {
      x: Math.min(g.rowLeft + g.width - 1, Math.max(g.rowLeft, mx)),
      y: Math.min(g.rowTop + g.rowHeight - inset, Math.max(g.rowTop + inset, my))
    };
  }

  const inRect = (g, x, y) => x >= g.left && x < g.left + g.width && y >= g.top && y < g.top + g.height;
  const resetGesture = () => { gesture = null; };

  function remap(e) {
    if (!e.isTrusted || !alive) return;
    const now = performance.now();
    const x = e.clientX;
    const y = e.clientY;
    // Only events that really hit the grid are remapped; Sheets' menus, dropdowns and dialogs
    // drawn over the magnified strip receive their clicks untouched.
    const grid = gridContainer();
    const onGrid = !!grid && e.target instanceof Node && grid.contains(e.target);
    let g = null;

    if (DOWN.has(e.type)) {
      const same = gesture && !gesture.passthrough && (
        // the compatibility mousedown that follows our remapped pointerdown
        (gesture.down && e.type === "mousedown") ||
        // second press of a double-click, after the first one already hid the overlay
        (!gesture.down && now < gesture.until && Math.abs(x - gesture.x) < 6 && Math.abs(y - gesture.y) < 6)
      );
      if (same && onGrid) {
        g = gesture.g;
        gesture.down = true;
        gesture.until = Infinity;
      } else {
        g = onGrid ? hitOverlay(x, y) : null;
        gesture = g ? { g, x, y, down: true, until: Infinity, passthrough: false } : null;
      }
    } else if (gesture && (gesture.down || now < gesture.until)) {
      if (UP.has(e.type)) {
        gesture.down = false;
        gesture.until = now + DBLCLICK_MS;
      } else if (gesture.down && e.buttons === 0 && (e.type === "mousemove" || e.type === "pointermove")) {
        gesture = null; // missed the button release (e.g. released outside the window)
        return;
      }
      // Once a drag leaves the magnified strip, Sheets gets real coordinates for the rest of it,
      // so drag-select across rows, row drag-move and edge auto-scroll behave normally.
      if (gesture.passthrough || !inRect(gesture.g, x, y)) {
        gesture.passthrough = true;
        return;
      }
      g = gesture.g;
    } else if (HOVER.has(e.type)) {
      g = onGrid ? hitOverlay(x, y) : null;
    }
    if (!g) return;

    const p = mapPoint(g, e.clientX, e.clientY);
    const target = document.elementFromPoint(p.x, p.y);
    if (!target || target === overlay) return;
    e.stopImmediatePropagation();
    // Cancelling pointerdown/move/up would suppress the browser's follow-up mouse events (which
    // are remapped separately). Everything else — including click/auxclick/contextmenu, which
    // Chrome delivers as PointerEvents — is cancelled so no native menu or default action fires.
    if (!e.type.startsWith("pointer")) e.preventDefault();

    const init = {
      bubbles: e.bubbles, cancelable: e.cancelable, composed: e.composed, view: window,
      detail: e.detail, clientX: p.x, clientY: p.y,
      screenX: e.screenX + (p.x - e.clientX), screenY: e.screenY + (p.y - e.clientY),
      button: e.button, buttons: e.buttons, relatedTarget: e.relatedTarget,
      ctrlKey: e.ctrlKey, shiftKey: e.shiftKey, altKey: e.altKey, metaKey: e.metaKey
    };
    if (typeof PointerEvent !== "undefined" && e instanceof PointerEvent) {
      Object.assign(init, {
        pointerId: e.pointerId, pointerType: e.pointerType, isPrimary: e.isPrimary,
        width: e.width, height: e.height, pressure: e.pressure
      });
      target.dispatchEvent(new PointerEvent(e.type, init));
    } else {
      target.dispatchEvent(new MouseEvent(e.type, init));
    }
  }

  // ---------------------------------------------------------------- selection tracking

  function check() {
    if (!alive) return;
    const box = nameBox();
    // While the user types a reference into the Name Box, its text is not the selection yet.
    if (box && document.activeElement === box) return;
    const row = settings.enabled && box ? parseSingleRow(box.value) : null;
    if (row === activeRow) return;
    activeRow = row;
    if (row === null) {
      stopLoop();
      removeOverlay();
    } else {
      hideOverlay(); // new row: never show the previous row's pixels
      clipCache = new WeakMap();
      observeGrid();
      startLoop();
    }
  }

  const markDirty = () => {
    wake();
    // Selection changes from mouse/keyboard: react immediately rather than waiting for the poll.
    queueMicrotask(check);
    setTimeout(check, 0);
  };

  function shutdown() {
    if (!alive) return;
    alive = false;
    clearInterval(pollTimer);
    stopLoop();
    removeOverlay();
    if (gridObserver) gridObserver.disconnect();
    gridObserver = null;
    observedGrid = null;
    clearTimeout(captureTimer);
    headerCache = null;
    analysis = null;
    freeScratch();
    for (const [type, fn, opts] of listeners) window.removeEventListener(type, fn, opts);
    try {
      document.fonts.removeEventListener("loadingdone", onFontsLoaded);
    } catch (_) {
      /* no font loading API */
    }
    try {
      chrome.storage.onChanged.removeListener(onStorageChanged);
    } catch (_) {
      /* extension context invalidated */
    }
    if (window.__sheetsRowFocusShutdown === shutdown) window.__sheetsRowFocusShutdown = null;
  }

  const listeners = [
    ["mouseup", markDirty, true],
    ["keyup", markDirty, true],
    ["keydown", wake, true],
    ["wheel", wake, { capture: true, passive: true }],
    ["scroll", wake, { capture: true, passive: true }],
    ["resize", wake, false],
    ["visibilitychange", wake, true],
    ...REMAPPED_TYPES.map((type) => [type, remap, true]),
    ["pointercancel", resetGesture, true],
    ["dragstart", resetGesture, true],
    ["visibilitychange", resetGesture, true],
    ["blur", resetGesture, false]
  ];

  // ---------------------------------------------------------------- init

  // v1.1 asked Sheets to render at a higher resolution via this key; no longer used.
  try {
    window.localStorage.removeItem(OLD_RENDER_SCALE_KEY);
  } catch (_) {
    /* storage blocked */
  }

  function applySettings(next) {
    settings = Settings.sanitize(next);
    wake();
    if (!settings.enabled) {
      activeRow = null;
      stopLoop();
      removeOverlay();
    }
    check();
  }

  Settings.load().then((loaded) => {
    if (!alive) return;
    applySettings(loaded);
    for (const [type, fn, opts] of listeners) window.addEventListener(type, fn, opts);
    try {
      document.fonts.addEventListener("loadingdone", onFontsLoaded);
    } catch (_) {
      /* no font loading API */
    }
    // The header row is usually on screen right after the sheet loads: remember it.
    setTimeout(scheduleHeaderCapture, 1500);
    pollTimer = setInterval(() => {
      // When the extension is reloaded/removed, this orphaned script loses chrome.runtime.
      try {
        if (!chrome.runtime || !chrome.runtime.id) return shutdown();
      } catch (_) {
        return shutdown();
      }
      check();
    }, POLL_MS);
  });

  function onStorageChanged(changes, area) {
    if (area !== "sync" || !alive) return;
    const next = { ...settings };
    for (const [k, { newValue }] of Object.entries(changes)) {
      if (k in Settings.DEFAULTS) next[k] = newValue === undefined ? Settings.DEFAULTS[k] : newValue;
    }
    applySettings(next);
  }

  try {
    chrome.storage.onChanged.addListener(onStorageChanged);
  } catch (_) {
    /* storage unavailable */
  }

  window.__sheetsRowFocusShutdown = shutdown;
  // The page-side recorder keeps running for the life of the tab (an extension reload would
  // otherwise lose what Sheets draws in between); make sure it is recording.
  document.dispatchEvent(new CustomEvent(RECORDER_CONTROL, { detail: "resume" }));
})();
