import { chromium } from 'playwright-core';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const file = 'file:///' + path.join(__dirname, 'index.html').replace(/\\/g, '/');
const browser = await chromium.launch({
  executablePath: 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
  headless: true,
});

for (const [name, width, height] of [['desktop', 1440, 900], ['tablet', 768, 1024], ['mobile', 390, 844]]) {
  const page = await browser.newPage({ viewport: { width, height } });
  await page.goto(file, { waitUntil: 'networkidle' });
  const info = await page.evaluate(() => {
    const de = document.documentElement;
    const overflowX = de.scrollWidth - de.clientWidth;
    const q = (s) => document.querySelector(s);
    const rect = (s) => { const el = q(s); if (!el) return null; const r = el.getBoundingClientRect(); return { w: Math.round(r.width), h: Math.round(r.height), top: Math.round(r.top) }; };
    return {
      scrollWidth: de.scrollWidth,
      clientWidth: de.clientWidth,
      overflowX,
      docHeight: de.scrollHeight,
      title: document.title,
      h1: q('h1')?.innerText.replace(/\n/g, ' '),
      h1Rect: rect('h1'),
      topo: rect('.topo'),
      productCount: document.querySelectorAll('.product').length,
      productsVisible: [...document.querySelectorAll('.product')].map(el => { const r = el.getBoundingClientRect(); return r.width > 0 && r.height > 0; }),
      tableMinWidth: q('.compare-table')?.getBoundingClientRect().width,
      fontsReady: document.fonts.status,
      cssVars: getComputedStyle(document.documentElement).getPropertyValue('--queqiao').trim(),
    };
  });
  console.log(name, JSON.stringify(info, null, 2));
  await page.close();
}
await browser.close();
