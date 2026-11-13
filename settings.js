// Shared settings definition used by the content script and the popup.
// Loaded as a classic script, so it exposes a single global.
(() => {
  const DEFAULTS = Object.freeze({
    enabled: true,      // master switch for the whole extension
    scale: 150,         // magnification of the selected row, in percent (100 = no scaling)
    pushRows: true,     // make room: push the rows below down instead of covering neighbours
    fillEnabled: true,  // tint the selected row with a fill color
    fillColor: "#fff59d",
    fillOpacity: 60     // strength of the fill tint, in percent
  });

  const LIMITS = Object.freeze({
    scale: { min: 100, max: 300, step: 10 },
    fillOpacity: { min: 10, max: 100, step: 5 }
  });

  const clamp = (n, lo, hi) => Math.min(hi, Math.max(lo, n));

  function sanitize(raw) {
    const s = Object.assign({}, DEFAULTS, raw || {});
    const scale = Number(s.scale);
    const opacity = Number(s.fillOpacity);
    return {
      enabled: s.enabled !== false,
      scale: Number.isFinite(scale) ? clamp(Math.round(scale), LIMITS.scale.min, LIMITS.scale.max) : DEFAULTS.scale,
      pushRows: s.pushRows !== false,
      fillEnabled: s.fillEnabled !== false,
      fillColor: /^#[0-9a-f]{6}$/i.test(s.fillColor) ? s.fillColor.toLowerCase() : DEFAULTS.fillColor,
      fillOpacity: Number.isFinite(opacity)
        ? clamp(Math.round(opacity), LIMITS.fillOpacity.min, LIMITS.fillOpacity.max)
        : DEFAULTS.fillOpacity
    };
  }

  function load() {
    return new Promise((resolve) => {
      try {
        chrome.storage.sync.get(DEFAULTS, (items) => {
          resolve(sanitize(chrome.runtime.lastError ? DEFAULTS : items));
        });
      } catch (_) {
        resolve(sanitize(DEFAULTS));
      }
    });
  }

  function save(partial) {
    return new Promise((resolve) => {
      try {
        chrome.storage.sync.set(partial, () => resolve());
      } catch (_) {
        resolve();
      }
    });
  }

  globalThis.RowFocusSettings = Object.freeze({ DEFAULTS, LIMITS, sanitize, load, save });
})();
