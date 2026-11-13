// End-to-end test: loads the unpacked extension into Chrome for Testing and drives a live,
// public Google Sheet (Google's read-only "Class Data" sample). Run with `npm test`.
// Set HEADFUL=1 to watch it run. Screenshots are written to tests/output/.
const puppeteer = require('puppeteer');
const path = require('path');
const fs = require('fs');
const EXT = path.resolve(__dirname, '..');
const OUT = path.join(__dirname, 'output');
fs.mkdirSync(OUT, { recursive: true });
process.chdir(OUT);
const SHEET = 'https://docs.google.com/spreadsheets/d/1BxiMVs0XRA5nFMdKvBdBZjgmUUqptlbs74OgvE2upms/edit';
const sleep = (ms) => new Promise(r => setTimeout(r, ms));
let pass = 0, fail = 0;
function check(name, cond, info) {
  cond ? pass++ : fail++;
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}${info !== undefined ? '  -> ' + (typeof info === 'string' ? info : JSON.stringify(info)) : ''}`);
}

(async () => {
  const browser = await puppeteer.launch({
    headless: process.env.HEADFUL ? false : 'new',
    args: [`--disable-extensions-except=${EXT}`, `--load-extension=${EXT}`, '--window-size=1400,900'],
    defaultViewport: { width: 1400, height: 900 },
  });
  const swTarget = await browser.waitForTarget(t => t.type() === 'service_worker' && t.url().startsWith('chrome-extension://'), { timeout: 20000 });
  const extId = new URL(swTarget.url()).host;
  const worker = await swTarget.worker();
  check('extension service worker loaded', !!worker, extId);
  const setSettings = (s) => worker.evaluate((s) => new Promise(r => chrome.storage.sync.set(s, r)), s);
  const getSettings = () => worker.evaluate(() => new Promise(r => chrome.storage.sync.get(null, r)));

  const page = await browser.newPage();
  await page.goto(SHEET, { waitUntil: 'networkidle2', timeout: 90000 });
  await page.waitForSelector('#t-name-box', { timeout: 30000 });
  await sleep(2500);

  const nameBox = () => page.$eval('#t-name-box', e => e.value);
  const grid = await page.$eval('#waffle-grid-container', e => e.getBoundingClientRect().toJSON());

  // Click a row header and converge on the requested row number.
  async function clickRowHeader(n, opts = {}) {
    let y = grid.top + 34 + (n - 1) * 21;
    for (let i = 0; i < 8; i++) {
      await page.mouse.click(grid.left + 18, y, opts);
      await sleep(250);
      const v = await nameBox();
      const m = /^(\d+):(\d+)$/.exec(v);
      if (m && Number(m[1]) === n && Number(m[2]) === n) return v;
      if (!m) { y += 10; continue; }
      y += (n - Number(m[1])) * 21;
    }
    return nameBox();
  }
  const overlayInfo = () => page.evaluate(() => {
    const o = document.querySelector('.sheets-row-focus-overlay');
    if (!o) return { exists: false, visible: false };
    const cs = getComputedStyle(o);
    const r = o.getBoundingClientRect();
    return { exists: true, visible: cs.display !== 'none' && r.height > 0, rect: { left: r.left, top: r.top, width: r.width, height: r.height }, pe: cs.pointerEvents, cw: o.width, ch: o.height };
  });
  const selRect = () => page.evaluate(() => {
    const s = [...document.querySelectorAll('#waffle-grid-container .selection')].map(e => e.getBoundingClientRect()).filter(r => r.height > 0);
    if (!s.length) return null;
    return { top: Math.min(...s.map(r => r.top)), bottom: Math.max(...s.map(r => r.bottom)) };
  });
  // Average color of a screen region, measured from a real screenshot.
  async function regionColor(rect) {
    const b64 = await page.screenshot({ encoding: 'base64', clip: { x: Math.max(0, rect.left), y: rect.top, width: Math.max(1, rect.width), height: Math.max(1, rect.height) } });
    return page.evaluate(async (b64) => {
      const img = new Image(); img.src = 'data:image/png;base64,' + b64; await img.decode();
      const c = document.createElement('canvas'); c.width = img.width; c.height = img.height;
      const x = c.getContext('2d'); x.drawImage(img, 0, 0);
      const d = x.getImageData(0, 0, c.width, c.height).data;
      let r = 0, g = 0, b = 0, n = 0, dark = 0;
      for (let i = 0; i < d.length; i += 4) { r += d[i]; g += d[i + 1]; b += d[i + 2]; n++; if (d[i] + d[i + 1] + d[i + 2] < 200) dark++; }
      return { r: Math.round(r / n), g: Math.round(g / n), b: Math.round(b / n), darkFrac: +(dark / n).toFixed(4) };
    }, b64);
  }
  const waitFrames = () => sleep(400);
  const centred = (o, s) => Math.abs((o.rect.top + o.rect.height / 2) - (s.top + s.bottom) / 2) < 1.5;

  // ---------- defaults
  await setSettings({ enabled: true, scale: 150, fillEnabled: true, fillColor: '#fff59d', fillOpacity: 60 });
  await sleep(300);
  check('no overlay before any row selection', !(await overlayInfo()).visible);

  // ---------- select row 3
  let v = await clickRowHeader(3);
  check('row header click selects single row', v === '3:3', v);
  await waitFrames();
  let o = await overlayInfo(), s = await selRect();
  check('overlay visible for single row', o.visible, o);
  check('overlay ignores pointer events', o.pe === 'none', o.pe);
  const rowH = s.bottom - s.top;
  check('overlay height = row height x 1.5', Math.abs(o.rect.height - rowH * 1.5) < 1.5, { oh: o.rect.height, rowH });
  check('overlay vertically centred on row', centred(o, s));
  check('overlay starts at grid left (includes row header)', Math.abs(o.rect.left - grid.left) < 1.5, o.rect.left);
  let col = await regionColor({ left: o.rect.left + o.rect.width - 300, top: o.rect.top + 4, width: 250, height: o.rect.height - 8 });
  check('fill color applied (yellowish)', col.r > 200 && col.g > 200 && col.b < 215, col);
  let colText = await regionColor({ left: o.rect.left, top: o.rect.top + 2, width: 500, height: o.rect.height - 4 });
  check('magnified row content drawn (dark text pixels present)', colText.darkFrac > 0.005, colText);
  await page.screenshot({ path: 'e2e_row3.png' });

  // ---------- select another row
  v = await clickRowHeader(6);
  await waitFrames();
  o = await overlayInfo(); s = await selRect();
  check('selecting another row moves overlay to it', v === '6:6' && o.visible && centred(o, s), { v, o: o.rect, s });
  const overlays = await page.$$eval('.sheets-row-focus-overlay', l => l.length);
  check('only one overlay element exists', overlays === 1, overlays);

  // ---------- select a cell -> revert
  await page.mouse.click(grid.left + 300, s.top + 21 * 3 + 10);
  await sleep(300); await waitFrames();
  v = await nameBox(); o = await overlayInfo();
  check('selecting a cell reverts overlay', /^[A-Z]+\d+$/.test(v) && !o.visible, { v, vis: o.visible });

  // ---------- click inside overlay area passes through
  await clickRowHeader(4); await waitFrames();
  s = await selRect();
  await page.mouse.click(grid.left + 250, (s.top + s.bottom) / 2);
  await sleep(300);
  v = await nameBox();
  check('click on overlay passes through to Sheets cell', /^[A-Z]+4$/.test(v), v);
  check('...and overlay reverts', !(await overlayInfo()).visible);

  // ---------- multi-row selection -> no overlay
  await clickRowHeader(3);
  const s3 = await selRect();
  await page.keyboard.down('Shift'); await page.mouse.click(grid.left + 18, s3.top + 21 * 2 + 10); await page.keyboard.up('Shift');
  await sleep(300); await waitFrames();
  v = await nameBox(); o = await overlayInfo();
  check('multi-row selection shows no overlay', /^\d+:\d+$/.test(v) && v.split(':')[0] !== v.split(':')[1] && !o.visible, { v, vis: o.visible });

  // ---------- Ctrl+click multi-range (Name Box shows only "6:6") -> no overlay
  await clickRowHeader(3); await waitFrames();
  check('(pre) row 3 overlay visible', (await overlayInfo()).visible);
  {
    const s3b = await selRect();
    await page.keyboard.down('Control'); await page.mouse.click(grid.left + 18, s3b.top + 21 * 3 + 10); await page.keyboard.up('Control');
    await sleep(300); await waitFrames();
    v = await nameBox(); o = await overlayInfo();
    const nSel = await page.$$eval('#waffle-grid-container .selection', l => l.filter(e => e.getBoundingClientRect().height > 0).length);
    check('Ctrl+click second row (multi-range) shows no overlay', !o.visible, { v, selectionDivs: nSel, vis: o.visible });
  }

  // ---------- click remapping: a click on magnified column C must select column C
  await setSettings({ scale: 200 }); await sleep(300);
  v = await clickRowHeader(4); await waitFrames();
  o = await overlayInfo(); s = await selRect();
  {
    // Column A starts after the 46px row header; default width ~121px => column C spans ~288-409.
    const realX = 300;                      // a point inside column C at 100%
    const shownX = grid.left + (realX - grid.left) * 2; // where column C is drawn at 200%
    await page.mouse.click(shownX, (s.top + s.bottom) / 2);
    await sleep(400);
    v = await nameBox();
    check('click on magnified column C selects C4 (remapped, not E4)', v === 'C4', v);
    check('...overlay reverts after cell click', !(await overlayInfo()).visible);
  }
  // click on the enlarged overlay's top fringe (over row 3 visually) maps into row 4
  v = await clickRowHeader(4); await waitFrames();
  o = await overlayInfo();
  await page.mouse.click(grid.left + 200, o.rect.top + 3);
  await sleep(400);
  v = await nameBox();
  // x=200 on screen at 200% maps to x=100 → column A; the fringe (visually over row 3) maps into row 4.
  check('click on top fringe of magnified row stays in that row (A4)', v === 'A4', v);
  // overlay-free click elsewhere is not remapped
  await clickRowHeader(4); await waitFrames();
  o = await overlayInfo();
  await page.mouse.click(grid.left + 200, o.rect.top + o.rect.height + 40);
  await sleep(400);
  v = await nameBox();
  check('click outside overlay is not remapped', /^B\d+$/.test(v) && v !== 'B4', v);
  // drag starting on the magnified row and leaving it extends the selection to other rows
  await clickRowHeader(4); await waitFrames();
  o = await overlayInfo(); s = await selRect();
  await page.mouse.move(grid.left + 600, (s.top + s.bottom) / 2);
  await page.mouse.down();
  for (let i = 1; i <= 8; i++) { await page.mouse.move(grid.left + 600, (s.top + s.bottom) / 2 + i * 12); await sleep(30); }
  await page.mouse.up();
  await sleep(400);
  v = await nameBox();
  {
    const m = /^([A-Z]+)(\d+):([A-Z]+)(\d+)$/.exec(v);
    check('drag from magnified row extends selection across rows', !!m && m[2] === '4' && Number(m[4]) > 5, v);
  }

  // a popup drawn over the magnified strip (outside the grid) gets its own clicks
  await clickRowHeader(4); await waitFrames();
  o = await overlayInfo();
  await page.evaluate((r) => {
    const d = document.createElement('div');
    d.id = 'fake-popup';
    d.style.cssText = `position:fixed;left:500px;top:${r.top - 5}px;width:200px;height:${r.height + 10}px;background:#fff;border:1px solid #888;z-index:2000`;
    d.dataset.clicks = '0'; d.dataset.moves = '0';
    d.addEventListener('click', () => { d.dataset.clicks = String(+d.dataset.clicks + 1); });
    d.addEventListener('mousemove', () => { d.dataset.moves = String(+d.dataset.moves + 1); });
    document.body.appendChild(d);
  }, o.rect);
  await page.mouse.move(600, o.rect.top + o.rect.height / 2);
  await page.mouse.click(600, o.rect.top + o.rect.height / 2);
  await sleep(300);
  const pop = await page.$eval('#fake-popup', d => ({ clicks: +d.dataset.clicks, moves: +d.dataset.moves }));
  v = await nameBox();
  check('popup over magnified strip receives its click & hover (not remapped)', pop.clicks === 1 && pop.moves > 0 && v === '4:4', { pop, v });
  await page.$eval('#fake-popup', d => d.remove());

  // right-click on magnified row: Sheets receives the remapped contextmenu at the real cell position
  await page.evaluate(() => { window.__cm = []; document.addEventListener('contextmenu', (e) => window.__cm.push({ t: e.isTrusted, x: e.clientX }), true); });
  await clickRowHeader(4); await waitFrames();
  o = await overlayInfo(); s = await selRect();
  await page.mouse.click(grid.left + 600, (s.top + s.bottom) / 2, { button: 'right' });
  await sleep(400);
  const cm = await page.evaluate(() => window.__cm);
  check('right-click on magnified row is remapped for Sheets (x 600 -> 300)', cm.length === 1 && !cm[0].t && Math.abs(cm[0].x - (grid => grid)(300)) < 2, cm);
  await page.keyboard.press('Escape');

  await setSettings({ scale: 150 }); await sleep(300);

  // ---------- Name Box typing does not count until committed
  await page.mouse.click(grid.left + 200, grid.top + 400); await sleep(400);
  check('(pre) cell selected, no overlay', !(await overlayInfo()).visible, await nameBox());
  await page.click('#t-name-box', { clickCount: 3 });
  await page.keyboard.type('5:5');
  await sleep(400);
  check('typing "5:5" in Name Box (uncommitted) shows no overlay', !(await overlayInfo()).visible);
  await page.keyboard.press('Enter');
  await sleep(600);
  v = await nameBox();
  check('committing "5:5" in Name Box shows overlay', v === '5:5' && (await overlayInfo()).visible, v);

  // ---------- cell editor visible -> overlay hides (simulated: view-only sheet cannot edit)
  await page.evaluate(() => { const e = document.getElementById('waffle-rich-text-editor'); e.dataset.oldStyle = e.getAttribute('style') || ''; e.style.cssText += ';position:fixed;top:200px;left:100px;width:120px;height:21px;'; });
  await sleep(300);
  check('overlay hides while cell editor is on screen', !(await overlayInfo()).visible);
  await page.evaluate(() => { const e = document.getElementById('waffle-rich-text-editor'); e.setAttribute('style', e.dataset.oldStyle); });
  await sleep(300);
  check('overlay returns when editor closes', (await overlayInfo()).visible);

  // ---------- column selection -> no overlay
  await page.mouse.click(grid.left + 150, grid.top + 10);
  await sleep(300); await waitFrames();
  v = await nameBox(); o = await overlayInfo();
  check('column selection shows no overlay', !o.visible, v);

  // ---------- keyboard Shift+Space row selection
  await page.keyboard.press('Escape');
  await clickRowHeader(5); await sleep(200);
  await page.mouse.click(grid.left + 250, (await selRect()).top + 10);
  await sleep(400);
  console.log('      (cell before Shift+Space:', await nameBox(), ')');
  await page.keyboard.down('Shift'); await page.keyboard.press('Space'); await page.keyboard.up('Shift');
  await sleep(300); await waitFrames();
  v = await nameBox(); o = await overlayInfo();
  check('Shift+Space once (data range e.g. A5:F5) is not a whole row -> no overlay', !/^(\d+):\1$/.test(v) && !o.visible, { v, vis: o.visible });
  await page.keyboard.down('Shift'); await page.keyboard.press('Space'); await page.keyboard.up('Shift');
  await sleep(300); await waitFrames();
  v = await nameBox(); o = await overlayInfo();
  check('Shift+Space twice (whole row) shows overlay', /^(\d+):\1$/.test(v) && o.visible, { v, vis: o.visible });

  // ---------- live settings: scale 200, fill off
  await clickRowHeader(5); await waitFrames();
  await setSettings({ scale: 200, fillEnabled: false });
  await sleep(500);
  o = await overlayInfo(); s = await selRect();
  check('scale change applies live (200%)', Math.abs(o.rect.height - (s.bottom - s.top) * 2) < 1.5, { oh: o.rect.height, rowH: s.bottom - s.top });
  col = await regionColor({ left: o.rect.left + o.rect.width - 300, top: o.rect.top + 4, width: 250, height: o.rect.height - 8 });
  check('fill disabled -> white background', col.r > 240 && col.g > 240 && col.b > 240, col);
  await page.screenshot({ path: 'e2e_scale200_nofill.png' });

  // ---------- color change
  await setSettings({ fillEnabled: true, fillColor: '#90caf9', fillOpacity: 100 });
  await sleep(500);
  o = await overlayInfo();
  col = await regionColor({ left: o.rect.left + o.rect.width - 300, top: o.rect.top + 4, width: 250, height: o.rect.height - 8 });
  check('fill color change applies live (blue)', col.b > col.r + 40, col);
  await page.screenshot({ path: 'e2e_blue.png' });

  // ---------- scale 100
  await setSettings({ scale: 100 });
  await sleep(500);
  o = await overlayInfo(); s = await selRect();
  check('scale 100% -> overlay exactly row height', Math.abs(o.rect.height - (s.bottom - s.top)) < 1.5, { oh: o.rect.height });

  // ---------- disable
  await setSettings({ enabled: false });
  await sleep(500);
  check('disabling extension removes overlay', !(await overlayInfo()).visible);
  await clickRowHeader(7); await waitFrames();
  check('while disabled, row selection shows nothing', !(await overlayInfo()).visible);
  await setSettings({ enabled: true, scale: 150, fillColor: '#fff59d', fillOpacity: 60 });
  await sleep(500);
  check('re-enabling with row already selected shows overlay', (await overlayInfo()).visible);

  // ---------- scrolling follows the row
  await clickRowHeader(8); await waitFrames();
  const before = (await overlayInfo()).rect;
  await page.mouse.move(grid.left + 400, grid.top + 300);
  await page.mouse.wheel({ deltaY: 63 });
  await sleep(700);
  o = await overlayInfo(); s = await selRect();
  check('overlay follows row on scroll', !!s && o.visible && o.rect.top < before.top && centred(o, s), { before: before.top, after: o.rect && o.rect.top, s });
  await page.mouse.wheel({ deltaY: 2000 });
  await sleep(800);
  o = await overlayInfo();
  check('overlay hides when row scrolled out of view', !o.visible, o.rect);
  await page.mouse.wheel({ deltaY: -4000 });
  await sleep(800);
  check('overlay returns when scrolled back', (await overlayInfo()).visible);

  // ---------- context menu on row header remains above overlay
  await clickRowHeader(3); await waitFrames();
  s = await selRect();
  await page.mouse.click(grid.left + 18, (s.top + s.bottom) / 2, { button: 'right' });
  await sleep(700);
  const menuOnTop = await page.evaluate(() => {
    const menu = [...document.querySelectorAll('.goog-menu, [role="menu"]')].find(m => { const r = m.getBoundingClientRect(); const cs = getComputedStyle(m); return r.width > 50 && r.height > 50 && cs.display !== 'none' && cs.visibility !== 'hidden'; });
    if (!menu) return { menu: false };
    const r = menu.getBoundingClientRect();
    const el = document.elementFromPoint(r.left + 20, r.top + 15);
    return { menu: true, topIsMenu: !!(el && menu.contains(el)) };
  });
  check('row context menu is not covered by overlay', !menuOnTop.menu || menuOnTop.topIsMenu, menuOnTop);
  await page.screenshot({ path: 'e2e_contextmenu.png' });
  await page.keyboard.press('Escape');
  await sleep(300);

  // ---------- popup page
  const popup = await browser.newPage();
  await popup.goto(`chrome-extension://${extId}/popup.html`);
  await sleep(500);
  const popupState = await popup.evaluate(() => ({ en: document.getElementById('enabled').checked, scale: document.getElementById('scale').value, fill: document.getElementById('fillEnabled').checked, color: document.getElementById('fillColor').value }));
  check('popup reflects stored settings', popupState.en && popupState.scale === '150' && popupState.fill && popupState.color === '#fff59d', popupState);
  await popup.screenshot({ path: 'e2e_popup.png', clip: { x: 0, y: 0, width: 290, height: 420 } });
  await popup.click('button[data-color="#a5d6a7"]');
  await sleep(300);
  check('popup swatch saves color', (await getSettings()).fillColor === '#a5d6a7');
  await popup.$eval('#scale', e => { e.value = '220'; e.dispatchEvent(new Event('input')); e.dispatchEvent(new Event('change')); });
  await sleep(300);
  check('popup scale slider saves scale', (await getSettings()).scale === 220, (await getSettings()).scale);
  check('popup scale label updates', (await popup.$eval('#scaleValue', e => e.textContent)) === '220%');
  await popup.$eval('#fillColor', e => { e.value = '#ff0000'; e.dispatchEvent(new Event('input')); e.dispatchEvent(new Event('change')); });
  await sleep(300);
  check('popup color picker saves color', (await getSettings()).fillColor === '#ff0000');
  await popup.click('#fillEnabled');
  await sleep(300);
  check('popup fill toggle saves', (await getSettings()).fillEnabled === false);
  await popup.click('#enabled');
  await sleep(300);
  check('popup enable toggle saves + disables options', (await getSettings()).enabled === false && await popup.$eval('#options', e => e.disabled));
  await popup.click('#reset');
  await sleep(300);
  const reset = await getSettings();
  check('popup reset restores defaults', reset.enabled === true && reset.scale === 150 && reset.fillEnabled === true && reset.fillColor === '#fff59d', reset);

  await popup.$eval('#scale', e => { e.value = '250'; e.dispatchEvent(new Event('input')); e.dispatchEvent(new Event('change')); });
  await sleep(600);
  await page.bringToFront(); await sleep(600);
  o = await overlayInfo(); s = await selRect();
  check('sheet overlay updates from popup change (250%)', o.visible && Math.abs(o.rect.height - (s.bottom - s.top) * 2.5) < 1.5, { oh: o.rect && o.rect.height });
  await page.screenshot({ path: 'e2e_250.png' });
  await popup.close();

  // ---------- action enabled only on Sheets
  // chrome.action.isEnabled() ignores declarativeContent state, so verify the registered rule instead.
  const rules = await worker.evaluate(() => new Promise(r => chrome.declarativeContent.onPageChanged.getRules(r)));
  const pm = rules.length === 1 && rules[0].conditions[0].pageUrl;
  check('toolbar action rule: shown only on https://docs.google.com/spreadsheets/*', !!pm && pm.hostEquals === 'docs.google.com' && pm.pathPrefix === '/spreadsheets/' && rules[0].actions[0].instanceType === 'declarativeContent.ShowAction', rules);
  check('toolbar action disabled by default elsewhere', !(await worker.evaluate(() => chrome.action.isEnabled())));

  // ---------- extension reload: already-open Sheets tab gets the script again, no page reload
  await page.bringToFront();
  await clickRowHeader(2); await waitFrames();
  await worker.evaluate(() => chrome.runtime.reload()).catch(() => {});
  await sleep(500);
  const sw2 = await browser.waitForTarget(t => t.type() === 'service_worker' && t.url().startsWith('chrome-extension://') && t !== swTarget, { timeout: 20000 }).catch(() => null);
  await sleep(2000);
  const nOverlays = await page.$$eval('.sheets-row-focus-overlay', l => l.length);
  check('after extension reload: no duplicate overlays', nOverlays <= 1, nOverlays);
  v = await clickRowHeader(6); await waitFrames();
  o = await overlayInfo(); s = await selRect();
  check('after extension reload: open tab works without page refresh', !!sw2 && o.visible && centred(o, s), { v, o: o.rect });
  await page.mouse.click(grid.left + 300, grid.top + 300); await sleep(400);
  check('after extension reload: cell click reverts', !(await overlayInfo()).visible);

  // ---------- other sites: content script must not run
  const other = await browser.newPage();
  for (const url of ['https://example.com/', 'https://docs.google.com/document/u/0/']) {
    await other.goto(url, { waitUntil: 'domcontentloaded', timeout: 60000 }).catch(() => {});
    await sleep(1500);
    const injected = await other.evaluate(() => { const d = document.createElement('div'); d.className = 'sheets-row-focus-overlay'; document.body.appendChild(d); const z = getComputedStyle(d).zIndex; d.remove(); return z === '50'; });
    check(`content script NOT injected on ${url}`, !injected);
  }

  console.log(`\n${pass} passed, ${fail} failed`);
  await browser.close();
  process.exit(fail ? 1 : 0);
})().catch(e => { console.error('CRASH', e); console.log(`\n${pass} passed, ${fail} failed (crashed)`); process.exit(2); });
