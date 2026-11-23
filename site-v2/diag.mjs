import { chromium } from 'playwright-core';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const browser = await chromium.launch({ executablePath: 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe', headless: true });
for (const name of ['queqiao', 'ai-ssh-pro']) {
  const file = 'file:///' + path.join(__dirname, name + '.html').replace(/\\/g, '/');
  const page = await browser.newPage({ viewport: { width: 390, height: 844 } });
  await page.goto(file, { waitUntil: 'networkidle' });
  const out = await page.evaluate(() => {
    const vw = document.documentElement.clientWidth;
    const bad = [];
    document.querySelectorAll('*').forEach(el => {
      const r = el.getBoundingClientRect();
      if (r.width > 0 && (r.right > vw + 1 || r.left < -1)) {
        bad.push({ tag: el.tagName, cls: el.className?.toString().slice(0,40), left: Math.round(r.left), right: Math.round(r.right), w: Math.round(r.width) });
      }
    });
    return { vw, bad: bad.slice(0, 20) };
  });
  console.log(name, JSON.stringify(out, null, 2));
  await page.close();
}
await browser.close();
