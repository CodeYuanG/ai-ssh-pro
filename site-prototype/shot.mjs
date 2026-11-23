import { chromium } from 'playwright-core';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const file = 'file:///' + path.join(__dirname, 'index.html').replace(/\\/g, '/');

const browser = await chromium.launch({
  executablePath: 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
  headless: true,
});

// desktop full page
const page = await browser.newPage({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: 1 });
await page.goto(file, { waitUntil: 'networkidle' });
await page.screenshot({ path: path.join(__dirname, 'preview-desktop.png'), fullPage: true });
console.log('desktop:', await page.title());

// mobile full page
const m = await browser.newPage({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 1 });
await m.goto(file, { waitUntil: 'networkidle' });
await m.screenshot({ path: path.join(__dirname, 'preview-mobile.png'), fullPage: true });
console.log('mobile done');

await browser.close();
