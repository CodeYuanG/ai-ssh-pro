import { chromium } from 'playwright-core';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const browser = await chromium.launch({
  executablePath: 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
  headless: true,
});

for (const name of ['queqiao', 'ai-ssh-pro']) {
  const file = 'file:///' + path.join(__dirname, name + '.html').replace(/\\/g, '/');
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  await page.goto(file, { waitUntil: 'networkidle' });

  // 检查默认布局
  const base = await page.evaluate(() => {
    const de = document.documentElement;
    return {
      title: document.title,
      overflowX: de.scrollWidth - de.clientWidth,
      docHeight: de.scrollHeight,
      switchName: document.querySelector('.switch-name')?.textContent,
      panelOpen: document.getElementById('switchPanel')?.dataset.open,
      accent: getComputedStyle(document.documentElement).getPropertyValue('--accent').trim(),
    };
  });
  console.log(name, 'base:', JSON.stringify(base));

  // 点击切换器，检查展开（等待 CSS transition 完成）
  await page.click('#switchBtn');
  await page.waitForTimeout(350);
  const opened = await page.evaluate(() => {
    const p = document.getElementById('switchPanel');
    const r = p.getBoundingClientRect();
    return {
      panelOpen: p.dataset.open,
      expanded: document.getElementById('switchBtn').getAttribute('aria-expanded'),
      visible: getComputedStyle(p).visibility,
      opacity: getComputedStyle(p).opacity,
      items: [...p.querySelectorAll('.switch-item')].map(a => ({ text: a.querySelector('b')?.textContent, href: a.getAttribute('href') })),
      rect: { w: Math.round(r.width), h: Math.round(r.height) },
    };
  });
  console.log(name, 'opened:', JSON.stringify(opened));

  // 截图：默认 + 切换器展开
  await page.screenshot({ path: path.join(__dirname, name + '-top.png'), clip: { x: 0, y: 0, width: 1440, height: 900 } });
  await page.screenshot({ path: path.join(__dirname, name + '-switch-open.png'), clip: { x: 0, y: 0, width: 1440, height: 900 } });
  await page.screenshot({ path: path.join(__dirname, name + '-full.png'), fullPage: true });

  // 移动端检查
  const m = await browser.newPage({ viewport: { width: 390, height: 844 } });
  await m.goto(file, { waitUntil: 'networkidle' });
  const mob = await m.evaluate(() => {
    const de = document.documentElement;
    return { overflowX: de.scrollWidth - de.clientWidth, docHeight: de.scrollHeight };
  });
  console.log(name, 'mobile:', JSON.stringify(mob));
  await m.close();
  await page.close();
}
await browser.close();
