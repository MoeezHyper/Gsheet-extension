// Quick visual check: saves screenshots of a focused row to tests/output/ (no assertions).
// Usage: node tests/visual.js
const puppeteer = require('puppeteer');
const path = require('path');
const fs = require('fs');
const EXT = path.resolve(__dirname, '..');
const OUT = path.join(__dirname, 'output');
fs.mkdirSync(OUT, { recursive: true });
const SHEET = 'https://docs.google.com/spreadsheets/d/1BxiMVs0XRA5nFMdKvBdBZjgmUUqptlbs74OgvE2upms/edit';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

(async () => {
  const browser = await puppeteer.launch({
    headless: process.env.HEADFUL ? false : 'new',
    args: [`--disable-extensions-except=${EXT}`, `--load-extension=${EXT}`],
    defaultViewport: { width: 1400, height: 900, deviceScaleFactor: Number(process.env.DPR || 1) },
  });
  const sw = await browser.waitForTarget((t) => t.type() === 'service_worker', { timeout: 20000 });
  const worker = await sw.worker();
  const set = (s) => worker.evaluate((s) => new Promise((r) => chrome.storage.sync.set(s, r)), s);
  const page = await browser.newPage();
  await page.goto(SHEET, { waitUntil: 'networkidle2', timeout: 90000 });
  await sleep(3000);
  const grid = await page.$eval('#waffle-grid-container', (e) => e.getBoundingClientRect().toJSON());
  const nameBox = () => page.$eval('#t-name-box', (e) => e.value);
  async function selectRow(n) {
    let y = grid.top + 34 + (n - 1) * 21;
    for (let i = 0; i < 10; i++) {
      await page.mouse.click(grid.left + 18, y); await sleep(250);
      const m = /^(\d+):(\d+)$/.exec(await nameBox());
      if (m && +m[1] === n && +m[2] === n) return;
      y += m ? (n - +m[1]) * 21 : 10;
    }
  }
  const shot = async (name) => { await sleep(700); await page.screenshot({ path: path.join(OUT, name) }); console.log('saved', name, await page.evaluate(() => ({ ...document.querySelector('.sheets-row-focus-overlay')?.dataset }))); };

  await set({ enabled: true, scale: Number(process.env.SCALE || 120), pushRows: true, alignColumns: true, showHeader: true, headerRow: 1, fillEnabled: false, fillColor: '#fff59d', fillOpacity: 60 });
  await selectRow(9); await shot('visual_row9.png');
  await page.mouse.move(grid.left + 500, grid.top + 300);
  await page.mouse.wheel({ deltaY: 21 * 15 }); await sleep(600);
  await selectRow(Number(process.env.ROW || 24)); await shot('visual_scrolled.png');
  await set({ scale: 200, fillEnabled: true, fillColor: '#90caf9', fillOpacity: 60 }); await shot('visual_200_blue.png');
  await set({ scale: Number(process.env.SCALE || 120), fillEnabled: false });
  await set({ alignColumns: false }); await shot('visual_unaligned.png');
  await set({ alignColumns: true, pushRows: false }); await shot('visual_overlaymode.png');
  await browser.close();
})().catch((e) => { console.error(e); process.exit(1); });
