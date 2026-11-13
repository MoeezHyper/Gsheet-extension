// Performance benchmark: CPU time and memory of the extension on a live Google Sheet.
// Run with `node tests/perf.js`. Compares the same page with and without the extension.
const puppeteer = require('puppeteer');
const path = require('path');
const EXT = path.resolve(__dirname, '..');
const SHEET = 'https://docs.google.com/spreadsheets/d/1BxiMVs0XRA5nFMdKvBdBZjgmUUqptlbs74OgvE2upms/edit';
const WINDOW_MS = 10000;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const MB = (b) => (b / 1048576).toFixed(1) + ' MB';

async function session(withExt, dpr) {
  const args = ['--window-size=1400,900'];
  if (withExt) args.push(`--disable-extensions-except=${EXT}`, `--load-extension=${EXT}`);
  const browser = await puppeteer.launch({ headless: 'new', args, defaultViewport: { width: 1400, height: 900, deviceScaleFactor: dpr } });
  let worker = null;
  if (withExt) {
    const t = await browser.waitForTarget((t) => t.type() === 'service_worker', { timeout: 20000 });
    worker = await t.worker();
  }
  const page = await browser.newPage();
  const cdp = await page.createCDPSession();
  await cdp.send('Performance.enable');
  await page.goto(SHEET, { waitUntil: 'networkidle2', timeout: 90000 });
  await sleep(4000);
  const grid = await page.$eval('#waffle-grid-container', (e) => e.getBoundingClientRect().toJSON());
  const nameBox = () => page.$eval('#t-name-box', (e) => e.value);
  async function selectRow(n) {
    let y = grid.top + 34 + (n - 1) * 21;
    for (let i = 0; i < 8; i++) {
      await page.mouse.click(grid.left + 18, y); await sleep(250);
      const m = /^(\d+):(\d+)$/.exec(await nameBox());
      if (m && +m[1] === n && +m[2] === n) return;
      y += m ? (n - +m[1]) * 21 : 10;
    }
  }
  const set = (s) => worker && worker.evaluate((s) => new Promise((r) => chrome.storage.sync.set(s, r)), s);
  const metrics = async () => Object.fromEntries((await cdp.send('Performance.getMetrics')).metrics.map((m) => [m.name, m.value]));
  async function measure(label, during) {
    await cdp.send('HeapProfiler.collectGarbage');
    await sleep(500);
    const a = await metrics();
    const t0 = Date.now();
    if (during) await during(); else await sleep(WINDOW_MS);
    const secs = (Date.now() - t0) / 1000;
    const b = await metrics();
    await cdp.send('HeapProfiler.collectGarbage');
    const heap = (await metrics()).JSHeapUsedSize;
    const canvas = await page.evaluate(() => {
      const o = document.querySelector('.sheets-row-focus-overlay');
      return o && getComputedStyle(o).display !== 'none' ? { w: o.width, h: o.height } : null;
    });
    return {
      label,
      cpuPct: ((b.TaskDuration - a.TaskDuration) / secs * 100).toFixed(2) + '%',
      scriptMsPerSec: ((b.ScriptDuration - a.ScriptDuration) / secs * 1000).toFixed(2),
      layoutStyleMsPerSec: (((b.LayoutDuration - a.LayoutDuration) + (b.RecalcStyleDuration - a.RecalcStyleDuration)) / secs * 1000).toFixed(2),
      jsHeap: MB(heap),
      overlayCanvas: canvas ? `${canvas.w}x${canvas.h} = ${MB(canvas.w * canvas.h * 4)}` : '-',
    };
  }
  async function scrolling() {
    await page.mouse.move(grid.left + 500, grid.top + 300);
    for (let i = 0; i < 50; i++) { await page.mouse.wheel({ deltaY: i % 20 < 10 ? 21 : -21 }); await sleep(WINDOW_MS / 50); }
  }

  const out = [];
  const tag = `${withExt ? 'ext' : 'no-ext'} dpr${dpr}`;
  await page.mouse.click(grid.left + 300, grid.top + 300); await sleep(500);
  out.push(await measure(`${tag}: cell selected, idle`));
  if (withExt) await set({ pushRows: false, scale: 150 });
  await selectRow(5); await sleep(800);
  out.push(await measure(`${tag}: row focused, idle${withExt ? ' (overlay mode)' : ''}`));
  if (withExt) {
    await set({ pushRows: true, scale: 150 }); await sleep(800);
    out.push(await measure(`${tag}: row focused, idle (push mode)`));
  }
  out.push(await measure(`${tag}: row focused, scrolling`, scrolling));
  await browser.close();
  return out;
}

(async () => {
  const rows = [];
  for (const [ext, dpr] of [[false, 1], [true, 1], [true, 2]]) rows.push(...(await session(ext, dpr)));
  console.table(rows);
})().catch((e) => { console.error(e); process.exit(1); });
