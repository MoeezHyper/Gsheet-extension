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
  const REFRESH_MS = 150;        // minimum pixel-refresh rate while a row is focused
  const SELECTION_SELECTOR = ".selection";
  const GRID_SELECTOR = "#waffle-grid-container";

  let settings = Settings.sanitize(Settings.DEFAULTS);
  let activeRow = null;          // row number currently focused, or null
  let overlay = null;            // our <canvas>
  let ctx = null;
  let rafId = 0;
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

  // The part of `el` actually visible, clipped by every overflow-hiding ancestor up to `stop`.
  function visibleRect(el, stop) {
    let r = rectOf(el);
    for (let p = el.parentElement; p && r; p = p.parentElement) {
      const cs = getComputedStyle(p);
      if (cs.display === "none" || cs.visibility === "hidden") return null;
      if (cs.overflowX !== "visible" || cs.overflowY !== "visible") {
        const pr = rectOf(p);
        const clip = {
          left: cs.overflowX !== "visible" ? pr.left : -Infinity,
          right: cs.overflowX !== "visible" ? pr.right : Infinity,
          top: cs.overflowY !== "visible" ? pr.top : -Infinity,
          bottom: cs.overflowY !== "visible" ? pr.bottom : Infinity
        };
        r = intersect(r, clip);
      }
      if (p === stop) break;
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
      if (!isRendered(el)) continue;
      const r = rectOf(el);
      if (r.height <= 0 || r.width <= 0) continue;
      fills.push({ r, color: getComputedStyle(el).backgroundColor, visible: visibleRect(el, grid) });
    }
    if (!fills.length) return null;

    // Our own active cell sits inside the selected row; use it to pick our selection color.
    const centers = [];
    for (const el of grid.querySelectorAll(".active-cell-border")) {
      if (!isRendered(el)) continue;
      const r = rectOf(el);
      if (r.width > 0 || r.height > 0) centers.push(r);
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
    for (const c of canvases) {
      const v = visibleRect(c, grid) || rectOf(c);
      left = Math.min(left, v.left);
      right = Math.max(right, v.right);
    }
    const row = intersect({ left, right, top, bottom }, gridRect);
    if (!row) return null;
    return { row, gridRect, canvases };
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
    if (overlay) overlay.classList.remove("is-visible");
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
    const { row, gridRect, canvases } = m;
    const scale = settings.scale / 100;
    const dpr = window.devicePixelRatio || 1;

    // Enlarged strip: anchored to the left edge of the grid, centred on the row, kept inside the grid.
    const width = row.width;
    const height = Math.min(row.height * scale, gridRect.height);
    let top = row.top + row.height / 2 - height / 2;
    top = Math.max(gridRect.top, Math.min(top, gridRect.bottom - height));
    const left = row.left;
    const yOffset = (height - row.height * scale) / 2; // non-zero only when clamped to grid height
    geom = { left, top, width, height, rowLeft: row.left, rowTop: row.top, rowHeight: row.height, scale, yOffset };

    const key = [row.left, row.top, row.width, row.height, top, dpr, settings.scale,
      settings.fillEnabled, settings.fillColor, settings.fillOpacity].join("|");
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
    placeOverlay(left, top);

    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.globalCompositeOperation = "source-over";
    ctx.globalAlpha = 1;
    ctx.fillStyle = "#ffffff";
    ctx.fillRect(0, 0, pxW, pxH);
    ctx.imageSmoothingEnabled = true;
    ctx.imageSmoothingQuality = "high";

    // Copy the row strip from every canvas that intersects it, enlarged by `scale` (in CSS px → device px).
    const k = dpr * scale;
    for (const c of canvases) {
      const cr = rectOf(c);
      const part = intersect(row, visibleRect(c, gridContainer()) || cr);
      if (!part) continue;
      const sx = (c.width / cr.width);
      const sy = (c.height / cr.height);
      try {
        ctx.drawImage(
          c,
          (part.left - cr.left) * sx, (part.top - cr.top) * sy, part.width * sx, part.height * sy,
          (part.left - row.left) * k, (part.top - row.top) * k + yOffset * dpr, part.width * k, part.height * k
        );
      } catch (_) {
        /* canvas mid-resize; next frame will repaint */
      }
    }

    if (settings.fillEnabled) {
      // Multiply keeps text and borders dark while white cell backgrounds take the fill color.
      ctx.globalCompositeOperation = "multiply";
      ctx.globalAlpha = settings.fillOpacity / 100;
      ctx.fillStyle = settings.fillColor;
      ctx.fillRect(0, 0, pxW, pxH);
      ctx.globalCompositeOperation = "source-over";
      ctx.globalAlpha = 1;
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

  function loop(now) {
    rafId = 0;
    if (!alive || activeRow === null || !settings.enabled) return;
    paint(now);
    rafId = requestAnimationFrame(loop);
  }

  function startLoop() {
    dirty = true;
    if (!rafId) rafId = requestAnimationFrame(loop);
  }

  function stopLoop() {
    if (rafId) cancelAnimationFrame(rafId);
    rafId = 0;
  }

  // ---------------------------------------------------------------- click remapping
  //
  // The overlay ignores the mouse, but what it shows is enlarged, so a click on the magnified
  // "column D" would really hit whatever cell lies beneath it. Mouse events landing on the
  // overlay are therefore re-sent to the cell the user actually sees under the pointer.
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
    if (!g || g.scale === 1 || !overlay || !overlay.classList.contains("is-visible")) return null;
    if (x < g.left || x >= g.left + g.width || y < g.top || y >= g.top + g.height) return null;
    return g;
  }

  function mapPoint(g, x, y) {
    const mx = g.rowLeft + (x - g.left) / g.scale;
    const my = g.rowTop + (y - g.top - g.yOffset) / g.scale;
    return {
      x: Math.min(g.rowLeft + g.width - 1, Math.max(g.rowLeft, mx)),
      y: Math.min(g.rowTop + g.rowHeight - 1, Math.max(g.rowTop + 1, my))
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
      startLoop();
    }
  }

  const markDirty = () => {
    dirty = true;
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
    for (const [type, fn, opts] of listeners) window.removeEventListener(type, fn, opts);
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
    ["wheel", () => { dirty = true; }, { capture: true, passive: true }],
    ["scroll", () => { dirty = true; }, { capture: true, passive: true }],
    ["resize", () => { dirty = true; }, false],
    ...REMAPPED_TYPES.map((type) => [type, remap, true]),
    ["pointercancel", resetGesture, true],
    ["dragstart", resetGesture, true],
    ["visibilitychange", resetGesture, true],
    ["blur", resetGesture, false]
  ];

  // ---------------------------------------------------------------- init

  function applySettings(next) {
    settings = Settings.sanitize(next);
    dirty = true;
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
})();
