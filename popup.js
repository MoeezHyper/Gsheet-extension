(async () => {
  const { DEFAULTS, sanitize, load, save } = globalThis.RowFocusSettings;
  const $ = (id) => document.getElementById(id);

  const els = {
    enabled: $("enabled"),
    options: $("options"),
    scale: $("scale"),
    scaleValue: $("scaleValue"),
    fillEnabled: $("fillEnabled"),
    fillOptions: $("fillOptions"),
    fillColor: $("fillColor"),
    fillOpacity: $("fillOpacity"),
    fillOpacityValue: $("fillOpacityValue"),
    reset: $("reset"),
    swatches: [...document.querySelectorAll(".swatches button")]
  };

  function render(s) {
    els.enabled.checked = s.enabled;
    els.options.disabled = !s.enabled;
    els.scale.value = s.scale;
    els.scaleValue.textContent = `${s.scale}%`;
    els.fillEnabled.checked = s.fillEnabled;
    els.fillOptions.classList.toggle("off", !s.fillEnabled);
    els.fillColor.value = s.fillColor;
    els.fillOpacity.value = s.fillOpacity;
    els.fillOpacityValue.textContent = `${s.fillOpacity}%`;
    for (const b of els.swatches) {
      b.setAttribute("aria-pressed", String(b.dataset.color === s.fillColor));
    }
  }

  let state = await load();
  render(state);

  function update(partial) {
    state = sanitize({ ...state, ...partial });
    render(state);
    save(partial);
  }

  // Range inputs fire "input" continuously while dragging; throttle storage writes
  // (chrome.storage.sync allows ~120 writes/minute) and always commit on "change".
  function throttledSave(key, input, format) {
    let timer = null;
    input.addEventListener("input", () => {
      const value = Number(input.value);
      state = sanitize({ ...state, [key]: value });
      format(state[key]);
      clearTimeout(timer);
      timer = setTimeout(() => save({ [key]: state[key] }), 150);
    });
    input.addEventListener("change", () => {
      clearTimeout(timer);
      update({ [key]: Number(input.value) });
    });
  }

  els.enabled.addEventListener("change", () => update({ enabled: els.enabled.checked }));
  els.fillEnabled.addEventListener("change", () => update({ fillEnabled: els.fillEnabled.checked }));

  throttledSave("scale", els.scale, (v) => (els.scaleValue.textContent = `${v}%`));
  throttledSave("fillOpacity", els.fillOpacity, (v) => (els.fillOpacityValue.textContent = `${v}%`));

  let colorTimer = null;
  els.fillColor.addEventListener("input", () => {
    clearTimeout(colorTimer);
    colorTimer = setTimeout(() => update({ fillColor: els.fillColor.value }), 120);
  });
  els.fillColor.addEventListener("change", () => {
    clearTimeout(colorTimer);
    update({ fillColor: els.fillColor.value });
  });

  for (const b of els.swatches) {
    b.addEventListener("click", () => update({ fillColor: b.dataset.color }));
  }

  els.reset.addEventListener("click", () => update({ ...DEFAULTS }));
})();
