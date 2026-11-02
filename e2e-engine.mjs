// e2e：本地引擎（内置 ComfyUI）的接口契约 + 引擎面板 UI
// 用法：node e2e-engine.mjs             （基础，不触发下载）
//      FULL=1 node e2e-engine.mjs       （含真实安装流程，会下载几个 GB）
//      SKIP_UI=1 node e2e-engine.mjs    （只跑接口，CI 用）
// 跑到云端部署（CLOUD=1，无显卡）上时，自动改跑「云端降级」用例
import puppeteer from 'puppeteer-core';
import { spawn } from 'child_process';
import path from 'path';
import { fileURLToPath } from 'url';

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const CHROME = process.env.CHROME || 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
const BASE = process.env.BASE || 'http://localhost:3000';
const FULL = !!process.env.FULL;
const IMG = `${ROOT}/fixtures/sample.jpg`;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let pass = 0; let fail = 0;
const chk = (name, ok, extra = '') => {
  console.log(`${ok ? '✅' : '❌'} ${name}${extra ? ' — ' + extra : ''}`);
  ok ? pass++ : fail++;
};

async function alive(url) {
  try {
    const r = await fetch(url, { signal: AbortSignal.timeout(2000) });
    return r.ok;
  } catch (e) { return false; }
}

let server = null;
if (!(await alive(BASE + '/api/health'))) {
  console.log('· 未检测到服务，先启动…');
  server = spawn(process.execPath, ['server.js'], { cwd: ROOT, stdio: 'ignore' });
  for (let i = 0; i < 30 && !(await alive(BASE + '/api/health')); i++) await sleep(1000);
}

const jget = async (p) => {
  const r = await fetch(BASE + p);
  return { status: r.status, json: await r.json().catch(() => null) };
};
const jpost = async (p, body) => {
  const r = await fetch(BASE + p, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: body ? JSON.stringify(body) : undefined,
  });
  return { status: r.status, json: await r.json().catch(() => null) };
};

const finish = () => {
  if (server) server.kill();
  console.log(`\n结果：${pass} 通过 / ${fail} 失败`);
  process.exit(fail ? 1 : 0);
};

// ===================== 云端部署（没有显卡）=====================
const IS_CLOUD = (await jget('/api/health')).json?.cloud === true;
if (IS_CLOUD) {
  console.log('\n=== 云端部署：引擎接口只读 ===');
  const s = await jget('/api/engine/status');
  chk('C1. 引擎状态标记为云端', s.json?.cloud === true);
  chk('C2. 云端不报告任何引擎路径', s.json?.dir === '' && s.json?.catalog?.length === 0);
  const i = await jpost('/api/engine/install', { models: ['sd15'] });
  chk('C3. 云端拒绝安装引擎', i.json?.cloud === true && i.json?.started === false);
  const a = await jpost('/api/engine/start');
  chk('C4. 云端拒绝启动引擎', a.json?.cloud === true && a.json?.started === false);
  const o = await jpost('/api/engine/stop');
  chk('C5. 云端拒绝停止引擎', o.json?.cloud === true);

  if (process.env.SKIP_UI) {
    console.log('\n（SKIP_UI=1，跳过浏览器用例）');
    finish();
  }

  console.log('\n=== 云端部署：前端自动降级 ===');
  const browser = await puppeteer.launch({
    executablePath: CHROME, headless: 'new', args: ['--no-sandbox', '--disable-dev-shm-usage'],
  });
  try {
    const page = await browser.newPage();
    await page.setViewport({ width: 1440, height: 900 });
    await page.goto(BASE, { waitUntil: 'domcontentloaded' });
    await sleep(1500);
    chk('C6. 云端隐藏引擎入口', !(await page.$('[data-testid="engine-btn"]')));
    const input = await page.$('input[type=file]');
    await input.uploadFile(IMG);
    await sleep(2000);
    // 首图落在 (560,250)，尺寸 360x360，点它的正中间
    await page.mouse.click(740, 430);
    await sleep(1000);
    const t = await page.evaluate(() => document.body.innerText);
    chk('C7. 选中图片后说明云端没有显卡', t.includes('云端版本没有显卡'), (t.match(/云端版本没有显卡[^\n]*/) || [''])[0].slice(0, 30));
  } finally {
    await browser.close();
  }
  finish();
}

// ===================== 本机：接口契约 =====================
console.log('\n=== 引擎接口 ===');
const st = await jget('/api/engine/status');
chk('1. /api/engine/status 返回 200', st.status === 200, String(st.status));
chk('2. 状态含 installed / phase / url', !!st.json && 'installed' in st.json && 'phase' in st.json && !!st.json.url);
chk('3. 引擎地址是本机 8188', !!st.json?.url?.includes('8188'), st.json?.url);
chk('4. 模型清单有 3 项且含 SD1.5', st.json?.catalog?.length === 3 && st.json.catalog.some((m) => m.id === 'sd15'),
  (st.json?.catalog || []).map((m) => m.id).join(','));
chk('5. SD1.5 标记为核心必选', st.json?.catalog?.find((m) => m.id === 'sd15')?.core === true);
chk('6. 清单里每项都有体积', (st.json?.catalog || []).every((m) => m.bytes > 0));
chk('7. 引擎目录指向项目内 engine/ComfyUI', !!st.json?.dir?.replace(/\\/g, '/').includes('engine/ComfyUI'), st.json?.dir);

const lg = await jget('/api/engine/logs');
chk('8. /api/engine/logs 返回日志数组', lg.status === 200 && Array.isArray(lg.json?.logs));

// SSE：连上后读第一帧就断开
let sseHead = '';
try {
  const r = await fetch(BASE + '/api/engine/stream');
  const reader = r.body.getReader();
  const { value } = await reader.read();
  sseHead = new TextDecoder().decode(value || new Uint8Array());
  await reader.cancel();
} catch (e) { sseHead = ''; }
chk('9. /api/engine/stream 推送 SSE 首帧', sseHead.startsWith('data:') && sseHead.includes('hello'), sseHead.slice(0, 40));

const st0 = await jpost('/api/engine/start');
chk('10. 启动接口非阻塞返回', st0.status === 200 && st0.json?.started === true);

if (!st.json?.installed) {
  const c = await jpost('/api/engine/cancel');
  chk('11. 未安装时取消接口返回 ok:false', c.status === 200 && c.json?.ok === false);
} else {
  const s2 = await jget('/api/engine/status');
  chk('11. 已安装时状态自洽', s2.json?.installed === true && 'hasVenv' in s2.json);
}

if (FULL) {
  console.log('\n=== 真实安装流程（FULL=1）===');
  const a = await jpost('/api/engine/install', { models: ['sd15'] });
  chk('F1. 安装接口启动', a.status === 200 && a.json?.started === true);
  const b = await jpost('/api/engine/install', { models: ['sd15'] });
  chk('F2. 重复触发返回 409', b.status === 409);
  for (let i = 0; i < 40; i++) {
    await sleep(3000);
    const s3 = await jget('/api/engine/status');
    if (s3.json?.phase !== 'installing') break;
  }
  await jpost('/api/engine/cancel');
  chk('F3. 取消后状态回到 idle/error', ['idle', 'error', 'stopped'].includes((await jget('/api/engine/status')).json?.phase));
}

// ===================== 本机：引擎面板 UI =====================
if (process.env.SKIP_UI) {
  console.log('\n（SKIP_UI=1，跳过浏览器用例）');
  finish();
}

console.log('\n=== 引擎面板 ===');
const browser = await puppeteer.launch({
  executablePath: CHROME, headless: 'new', args: ['--no-sandbox', '--disable-dev-shm-usage'],
});
try {
  const page = await browser.newPage();
  await page.goto(BASE, { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('[data-testid="engine-btn"]', { timeout: 15000 });
  chk('12. 顶栏有引擎入口', true);

  await page.click('[data-testid="engine-btn"]');
  await page.waitForSelector('[data-testid="engine-panel"]', { timeout: 8000 });
  chk('13. 点一下打开引擎面板', true);

  const panelText = await page.$eval('[data-testid="engine-panel"]', (el) => el.innerText);
  chk('14. 面板显示当前状态', /未安装|已安装|运行中|正在|已有引擎/.test(panelText), (panelText.split('\n').find((l) => /未安装|已安装|运行|正在|已有引擎/.test(l)) || ''));

  const installedNow = (await jget('/api/engine/status')).json?.installed;
  if (!installedNow) {
    const hasInstallBtn = await page.$('[data-testid="engine-install"]');
    chk('15. 未安装时有一键安装按钮', !!hasInstallBtn);
    const boxes = await page.$$eval('[data-testid="engine-panel"] input[type=checkbox]', (els) => els.length);
    chk('16. 三个模型可选', boxes === 3, String(boxes));
    const before = await page.$eval('[data-testid="engine-install"]', (el) => el.innerText);
    // 勾上第二个大模型，体积提示应该跟着涨
    await page.$$eval('[data-testid="engine-panel"] input[type=checkbox]', (els) => els[1]?.click());
    await sleep(400);
    const after = await page.$eval('[data-testid="engine-install"]', (el) => el.innerText);
    const num = (s) => Number((s.match(/([\d.]+)\s*GB/) || [])[1] || 0);
    chk('17. 勾选后体积提示跟着变', before !== after && num(after) > num(before), `${before.trim()} → ${after.trim()}`);
    await page.$$eval('[data-testid="engine-panel"] input[type=checkbox]', (els) => els[1]?.click());
    await sleep(300);
  } else {
    const t = await page.$eval('[data-testid="engine-panel"]', (el) => el.innerText);
    chk('15. 已安装时显示引擎路径', /引擎[:：]/.test(t), (t.match(/引擎[:：]\s*\S+/) || [''])[0]);
    chk('16. 已安装时不显示安装按钮', !(await page.$('[data-testid="engine-install"]')));
    chk('17. 有启动或停止按钮', !!(await page.$('[data-testid="engine-start"]')) || !!(await page.$('[data-testid="engine-stop"]')));
  }

  // 关掉面板
  await page.click('[data-testid="engine-close"]');
  await sleep(400);
  chk('18. 可以关闭面板', !(await page.$('[data-testid="engine-panel"]')));
} finally {
  await browser.close();
}

finish();
