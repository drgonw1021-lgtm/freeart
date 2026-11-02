// e2e: 手绘画笔 + ComfyUI 图生图 + 蒙版局部重绘（打 mock comfy:8188 + localhost:3000）
import puppeteer from 'puppeteer-core';
import { spawn } from 'child_process';
import path from 'path';
import { fileURLToPath } from 'url';
const ROOT = path.dirname(fileURLToPath(import.meta.url));

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const IMG = `${ROOT}/fixtures/sample.jpg`;
let pass = 0, fail = 0;
const chk = (name, ok, extra = '') => {
  console.log(`${ok ? '✅' : '❌'} ${name}${extra ? ' — ' + extra : ''}`);
  ok ? pass++ : fail++;
};

const browser = await puppeteer.launch({
  executablePath: process.env.CHROME || 'C:/Program Files/Google/Chrome/Application/chrome.exe',
  headless: 'new',
  args: ['--no-sandbox', '--disable-dev-shm-usage'],
});
const page = await browser.newPage();
await page.setViewport({ width: 1440, height: 900 });
const jsErrors = [];
page.on('pageerror', (e) => jsErrors.push(e.message.slice(0, 120)));

await page.goto('http://localhost:3000', { waitUntil: 'networkidle2' });
await page.evaluate(() => localStorage.clear());
await page.reload({ waitUntil: 'networkidle2' });
await sleep(1200);

const layers = () => page.evaluate(() => window.__freeartStage.find('Image').length);
const layerSizes = () => page.evaluate(() => window.__freeartStage.find('Image').map((n) => Math.round(n.width()) + 'x' + Math.round(n.height())));

// ---- A ComfyUI 探测 ----
const comfyStatus = await page.evaluate(async () => {
  const r = await fetch('/api/comfy/status');
  return r.json();
});
chk('A1 ComfyUI 探测在线', comfyStatus.online === true, `模型数=${comfyStatus.checkpoints?.length}`);

// ---- B 导入底图 ----
const inp = await page.$('input[type=file]');
await inp.uploadFile(IMG);
await sleep(2500);
chk('B1 导入底图', (await layers()) === 1);

// ---- C 手绘：画笔模式 → 画两笔 → 橡皮 → 完成 → 草图图层 ----
await page.evaluate(() => {
  [...document.querySelectorAll('span')].filter((e) => e.textContent.includes('画笔')).pop().click();
});
await sleep(400);
// 一笔
await page.mouse.move(400, 300);
await page.mouse.down();
for (let i = 0; i <= 20; i++) await page.mouse.move(400 + i * 8, 300 + Math.sin(i / 3) * 40);
await page.mouse.up();
await sleep(150);
// 另一笔
await page.mouse.move(500, 500);
await page.mouse.down();
await page.mouse.move(700, 520, { steps: 12 });
await page.mouse.up();
await sleep(200);
chk('C1 画布上出现实时笔迹层', await page.evaluate(() => !!document.querySelectorAll('.konvajs-content').length));
// 完成 → 转图层
await page.evaluate(() => {
  [...document.querySelectorAll('div')].filter((e) => e.textContent.trim() === '完成（转为图层）').pop().click();
});
await sleep(1500);
chk('C2 草图转为图层', (await layers()) === 2, JSON.stringify(await layerSizes()));
chk('C3 画笔模式已退出', await page.evaluate(() => !document.body.innerText.includes('完成（转为图层）')));

// ---- D 以图生图（选中底图 → 提示词 → denoise → ComfyUI 出图） ----
// 选中第一张（底图）
const imgPos = await page.evaluate(() => {
  const n = window.__freeartStage.find('Image')[0];
  return { x: n.x(), y: n.y() };
});
await page.mouse.click(imgPos.x + 30, imgPos.y + 20);
await sleep(700);
chk('D1 面板出现以图生图区块', await page.evaluate(() => document.body.innerText.includes('以图生图（草图/图片 → 成图）')));
await page.evaluate(() => {
  const inp = [...document.querySelectorAll('input')].find((i) => (i.placeholder || '').includes('基于这张图生成什么'));
  const s = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
  s.call(inp, 'a cozy cafe logo, warm illustration style');
  inp.dispatchEvent(new Event('input', { bubbles: true }));
});
await page.evaluate(() => {
  [...document.querySelectorAll('div')].filter((e) => e.textContent.trim() === '以图生图（草图/图片 → 成图）').pop().click();
});
// mock comfy 400ms 完成再取图，放宽到 15s
let d2 = null;
for (let i = 0; i < 30; i++) {
  await sleep(500);
  if ((await layers()) === 3) { d2 = true; break; }
}
chk('D2 图生图结果落画布', d2 === true, `图层=${await layers()}`);

// ---- E 蒙版局部重绘（涂抹 → 开始重绘） ----
await page.evaluate(() => {
  [...document.querySelectorAll('div')].filter((e) => e.textContent.trim() === '涂抹蒙版 → 局部重绘').pop().click();
});
await sleep(500);
// 在底图上涂
await page.mouse.move(imgPos.x + 60, imgPos.y + 60);
await page.mouse.down();
await page.mouse.move(imgPos.x + 160, imgPos.y + 120, { steps: 10 });
await page.mouse.up();
await sleep(200);
await page.evaluate(() => {
  [...document.querySelectorAll('div')].filter((e) => e.textContent.trim() === '开始局部重绘').pop().click();
});
let e2 = null;
for (let i = 0; i < 30; i++) {
  await sleep(500);
  if ((await layers()) === 4) { e2 = true; break; }
}
chk('E1 局部重绘结果落画布', e2 === true, `图层=${await layers()}`);
chk('E2 蒙版模式已退出', await page.evaluate(() => !document.body.innerText.includes('开始局部重绘')));

// ---- H 随心改：说出效果 → AI 拆解 → 多步执行 ----
const p3 = await page.evaluate(() => {
  const n = window.__freeartStage.find('Image')[0];
  return { x: n.x(), y: n.y() };
});
await page.mouse.click(p3.x + 30, p3.y + 20);
await sleep(700);
chk('H1 随心改区块存在', await page.evaluate(() => document.body.innerText.includes('✨ 随心改（AI 自动搭工作流）')));
await page.evaluate(() => {
  const inp = [...document.querySelectorAll('input')].find((i) => (i.placeholder || '').includes('放大两倍并增强细节'));
  const s = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
  s.call(inp, '放大两倍并增强细节');
  inp.dispatchEvent(new Event('input', { bubbles: true }));
});
await page.evaluate(() => {
  [...document.querySelectorAll('div')].filter((e) => e.textContent.trim() === 'AI 拆解').pop().click();
});
await sleep(2500);
const planText = await page.evaluate(() => document.body.innerText);
chk('H2 拆解出多步计划', /1\. 细节增强/.test(planText) && /2\. AI 放大/.test(planText), planText.match(/1\.[^\n]*/)?.[0] || '');
chk('H3 显示执行按钮', /执行（2 步）/.test(planText));
await page.evaluate(() => {
  [...document.querySelectorAll('div')].filter((e) => /^执行（\d+ 步）$/.test(e.textContent.trim())).pop().click();
});
let h4 = false;
for (let i = 0; i < 40; i++) {
  await sleep(500);
  if ((await layers()) === 5) { h4 = true; break; }
}
chk('H4 多步计划执行完成并落图', h4, `图层=${await layers()}`);

// ---- F ComfyUI 离线路径（拦截 status 请求模拟离线） ----
await page.setRequestInterception(true);
page.on('request', (req) => {
  if (req.url().includes('/api/comfy/status')) req.abort();
  else req.continue();
});
await page.reload({ waitUntil: 'networkidle2' });
await sleep(1500);
// 选中一张图让面板出现
const p2 = await page.evaluate(() => {
  const n = window.__freeartStage.find('Image')[0];
  return { x: n.x(), y: n.y() };
});
await page.mouse.click(p2.x + 30, p2.y + 20);
await sleep(900);
chk('F1 离线提示正确显示', await page.evaluate(() => {
  const t = document.body.innerText;
  return t.includes('本地引擎没在运行') && t.includes('打开引擎面板');
}));

// ---- G 刷新持久化 ----
await page.reload({ waitUntil: 'networkidle2' });
await sleep(1500);
chk('G1 刷新后 5 个图层保留', (await layers()) === 5, `图层=${await layers()}`);

chk('Z1 无 JS 报错', jsErrors.length === 0, jsErrors.join(' | ').slice(0, 150));

console.log(`\n===== 汇总: ${pass} 通过 / ${fail} 失败 =====`);
await browser.close();
process.exit(fail ? 1 : 0);
