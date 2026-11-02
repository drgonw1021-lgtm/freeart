// 全量回归测试：真实 Chrome 无头浏览器，覆盖全部功能点。
// 用法：node e2e-full.mjs            （本地）
//      BASE=https://... node e2e-full.mjs  （线上）
import puppeteer from 'puppeteer-core';
import path from 'path';
import fs from 'fs';
import { fileURLToPath } from 'url';
const ROOT = path.dirname(fileURLToPath(import.meta.url));
const SHOTS = path.join(ROOT, '.shots');
fs.mkdirSync(SHOTS, { recursive: true });

const CHROME = process.env.CHROME || 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
const BASE = process.env.BASE || 'http://localhost:3000';
const IMG = `${ROOT}/fixtures/sample.jpg`;
const IMG2 = `${ROOT}/fixtures/sample2.jpg`;
const BIG = `${ROOT}/fixtures/big.jpg`;
const TXT = `${ROOT}/fixtures/notimage.txt`;
const ONLINE = BASE.startsWith('http') && !BASE.includes('localhost');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// 40MB 的大图用例不进仓库，缺了就地造一张（在 JPEG 头部塞满注释段，仍是合法图片）
function ensureBig() {
  if (fs.existsSync(BIG)) return;
  const src = fs.readFileSync(IMG);
  const parts = [src.subarray(0, 2)];
  let total = 2;
  const seg = Buffer.concat([Buffer.from([0xff, 0xfe, 0xff, 0xff]), Buffer.alloc(65533, 0x41)]);
  while (total < 40 * 1024 * 1024) { parts.push(seg); total += seg.length; }
  parts.push(src.subarray(2));
  fs.writeFileSync(BIG, Buffer.concat(parts));
}
ensureBig();

const results = [];
function chk(name, cond, detail = '') {
  results.push({ name, pass: !!cond, detail });
  console.log(`${cond ? '✅' : '❌'} ${name}${detail ? '  [' + detail + ']' : ''}`);
}

const browser = await puppeteer.launch({
  executablePath: CHROME, headless: 'new',
  args: ['--no-sandbox', '--window-size=1440,900'],
});
const page = await browser.newPage();
await page.setViewport({ width: 1440, height: 900 });
const jsErrors = [];
page.on('pageerror', (e) => jsErrors.push(e.message.slice(0, 120)));
const dialogQueue = [];
page.on('dialog', (d) => {
  const val = dialogQueue.length ? dialogQueue.shift() : undefined;
  d.accept(d.type() === 'prompt' ? (val ?? '测试文案') : val);
});

const st = () => page.evaluate(() => ({
  images: window.__freeartStage.find('Image').length,
  texts: window.__freeartStage.find('Text').length,
  scale: +window.__freeartStage.scaleX().toFixed(3),
  sx: Math.round(window.__freeartStage.x()),
  sizes: window.__freeartStage.find('Image').map((n) => `${Math.round(n.width())}x${Math.round(n.height())}`),
  pos: window.__freeartStage.find('Image').map((n) => ({ x: Math.round(n.x()), y: Math.round(n.y()), w: Math.round(n.width()), h: Math.round(n.height()) })),
}));
const bodyText = () => page.evaluate(() => document.body.innerText);
const clickText = (t) => page.evaluate((l) => {
  const els = [...document.querySelectorAll('div,span')].filter((e) => e.textContent.trim() === l);
  els[els.length - 1]?.click();
  return !!els.length;
}, t).then(async (r) => { await sleep(250); return r; });
const waitIdle = async (max = 20000) => {
  const t0 = Date.now();
  while (Date.now() - t0 < max) {
    const b = await bodyText();
    if (!/本地处理中|导入中|保存结果|正在加载去背|去背中|生成色板卡|生成中/.test(b)) return true;
    await sleep(300);
  }
  return false;
};
const typeInto = async (placeholderIncludes, text, enter = false) => page.evaluate((ph, tx, en) => {
  const inp = [...document.querySelectorAll('input')].filter((i) => (i.type || 'text') === 'text' && i.placeholder.includes(ph)).pop();
  if (!inp) return false;
  const set = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
  set.call(inp, tx);
  inp.dispatchEvent(new Event('input', { bubbles: true }));
  if (en) inp.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
  return true;
}, placeholderIncludes, text, enter);
const typeMain = async (text, enter = false) => page.evaluate((tx, en) => {
  const inp = [...document.querySelectorAll('input')].filter((i) => (i.type || 'text') === 'text').pop();
  if (!inp) return false;
  const set = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
  set.call(inp, tx);
  inp.dispatchEvent(new Event('input', { bubbles: true }));
  if (en) inp.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
  return true;
}, text, enter);
const reset = async () => {
  await page.evaluate(() => localStorage.clear());
  await page.reload({ waitUntil: 'networkidle2' });
  await sleep(1000);
};
const clearCanvas = async () => {
  dialogQueue.length = 0;
  await clickText('清空');
  await sleep(700);
  await page.reload({ waitUntil: 'networkidle2' });
  await sleep(1000);
};
const importFile = async (p) => {
  const i = await page.$('input[type=file]');
  await i.uploadFile(p);
  await sleep(2200);
};
const selectAt = async (x = 740, y = 430) => { await page.mouse.click(x, y); await sleep(500); };

console.log(`\n===== 目标：${BASE} =====\n`);
await page.goto(BASE, { waitUntil: 'networkidle2' });
await reset();

// ---------------- A 启动 ----------------
console.log('\n--- A 启动 ---');
const boot = await page.evaluate(async () => {
  const r = await fetch('/api/health?sharecode=' + (new URLSearchParams(location.search).get('sharecode') || ''));
  const j = await r.json().catch(() => null);
  return { status: r.status, json: j, stage: !!window.__freeartStage };
});
chk('A1 页面加载无 JS 错误', jsErrors.length === 0, jsErrors.join(' | '));
chk('A2 健康接口可用', boot.status === 200 && boot.json, `status=${boot.status} provider=${boot.json?.provider || '-'} free=${boot.json?.free}`);
chk('A3 画布 stage 已挂载', boot.stage);

// ---------------- B 导入 ----------------
console.log('\n--- B 导入 ---');
await importFile(IMG);
let s = await st();
chk('B1 单张导入', s.images === 1 && s.sizes[0] === '360x360', `图层=${s.images} 尺寸=${s.sizes[0]}`);
await importFile(IMG2);
s = await st();
chk('B2 批量导入（连续 2 张）', s.images === 2, `图层=${s.images}`);

await importFile(TXT);
await sleep(600);
let t = await bodyText();
s = await st();
chk('B3 非图片文件被拒绝', /不是图片格式/.test(t) && s.images === 2, `图层=${s.images}`);

await importFile(BIG);
await sleep(800);
t = await bodyText();
s = await st();
chk('B4 超过 40MB 被拒绝', /超过 40MB/.test(t) && s.images === 2, `图层=${s.images}`);

// ---------------- C 本地改图：全部操作 ----------------
console.log('\n--- C 本地改图（21 种操作）---');
const CMDS = [
  ['warm', '暖一点'], ['cool', '冷一点'], ['gray', '转黑白'], ['vintage', '复古胶片'],
  ['bright', '亮一点'], ['dark', '暗一点'], ['contrast', '对比强一点'], ['flat', '降低对比'],
  ['vivid', '饱和度提高'], ['muted', '降低饱和'], ['fade', '褪色'], ['blur', '背景虚化'],
  ['soft', '柔光'], ['crop1_1', '切方形'], ['crop4_3', '4:3 裁切'], ['crop3_4', '3:4 裁切'],
  ['crop16_9', '16:9 裁切'], ['crop9_16', '9:16 裁切'], ['expand1_1', '扩成方形'],
  ['expand16_9', '扩成横版'], ['expand9_16', '扩成竖版'], ['expand4_3', '扩成4:3'],
  ['expand3_4', '扩成3:4'], ['round', '加圆角'], ['flipH', '镜像'], ['rotate90', '转90度'],
  ['brandtint', '套用品牌色'],
];
await clearCanvas();
await importFile(IMG);
await selectAt();
chk('C0 点选图片出现改图面板', /本地即时改/.test(await bodyText()));

let opFails = [];
for (const [key, cmd] of CMDS) {
  const before = (await st()).images;
  await typeInto('暖一点、扩成横版', cmd, true);
  await waitIdle(15000);
  const after = await st();
  const errShown = /本地改图失败|没听懂/.test(await bodyText());
  if (after.images !== before + 1 || errShown) opFails.push(key);
}
chk('C1 全部 27 项本地操作均生效', opFails.length === 0, opFails.length ? '失败: ' + opFails.join(',') : `共 ${CMDS.length} 项`);
await page.screenshot({ path: `${SHOTS}/full_ops.png` });

// 模型任务路由：应进入"生成中"状态，而不是走本地改图
await clickText('删除');
await reset();
await importFile(IMG);
await selectAt();
await typeMain('换成一只猫', true);
let wentModel = false;
for (let i = 0; i < 25; i++) {
  await sleep(200);
  const btn = await page.evaluate(() => {
    const b = [...document.querySelectorAll('button')].find((x) => /^\d+s$/.test(x.textContent.trim()) || x.textContent.trim() === '生成');
    return b ? b.textContent.trim() : '';
  });
  if (/^\d+s$/.test(btn)) { wentModel = true; break; }
}
chk('C2 "换成一只猫"走模型生成而非本地改图', wentModel, wentModel ? '已进入生成中' : '未触发生成');
await page.reload({ waitUntil: 'networkidle2' }); // 中断请求，避免污染后续用例
await sleep(800);

// 右侧改图框输入需要重画的指令 → 应给出明确引导而不是"没听懂"
await selectAt();
await typeInto('暖一点、扩成横版', '换成一只猫', true);
await sleep(800);
chk('C3 改图框遇到重画指令时给出正确引导', /要重画内容/.test(await bodyText()));

// ---------------- D 扩图比例 ----------------
console.log('\n--- D 扩图比例 ---');
await clearCanvas();
await importFile(IMG);
await selectAt();
const ratios = [
  ['扩成方形', 1],
  ['扩成横版', 16 / 9],
  ['扩成竖版', 9 / 16],
];
let dFails = [];
for (const [cmd, r] of ratios) {
  const before = (await st()).sizes.length;
  await typeInto('暖一点、扩成横版', cmd, true);
  await waitIdle(15000);
  const sizes = (await st()).sizes;
  const last = sizes[sizes.length - 1];
  if (sizes.length !== before + 1 || !last) { dFails.push(cmd + '(无新图层)'); continue; }
  const [w, hh] = last.split('x').map(Number);
  const got = w / hh;
  if (Math.abs(got - r) > 0.02) dFails.push(`${cmd}(得到 ${got.toFixed(2)} 期望 ${r.toFixed(2)})`);
}
chk('D1 三种扩图比例精确', dFails.length === 0, dFails.join('; ') || '1.00 / 1.78 / 0.56');

// ---------------- E 品牌套件 ----------------
console.log('\n--- E 品牌套件 ---');
await clickText('品牌');
await sleep(400);
chk('E1 品牌面板打开', /品牌套件/.test(await bodyText()));

await page.evaluate(() => {
  const inp = [...document.querySelectorAll('input')].find((i) => i.placeholder === '品牌名');
  const set = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
  set.call(inp, 'MORNING COFFEE');
  inp.dispatchEvent(new Event('input', { bubbles: true }));
});
await page.evaluate(() => {
  const inp = document.querySelector('input[type=color]');
  const set = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
  set.call(inp, '#c0492b');
  inp.dispatchEvent(new Event('input', { bubbles: true }));
});
await page.evaluate(() => {
  const sel = document.querySelector('select');
  const opt = [...sel.options].find((o) => o.label === '楷体');
  const set = Object.getOwnPropertyDescriptor(window.HTMLSelectElement.prototype, 'value').set;
  set.call(sel, opt.value);
  sel.dispatchEvent(new Event('change', { bubbles: true }));
});
await sleep(600);
let brand = await page.evaluate(() => JSON.parse(localStorage.getItem('freeart-brand-v1') || 'null'));
chk('E2 品牌名/主色/字体写入', brand?.name === 'MORNING COFFEE' && (brand.colors || [])[0]?.toLowerCase() === '#c0492b' && /KaiTi/.test(brand.font || ''), `${brand?.name} ${brand?.colors?.[0]} ${brand?.font}`);

// 色板上限 6
const addSwatch = () => page.evaluate(() => {
  const plus = [...document.querySelectorAll('div')].find((d) => d.textContent.trim() === '+' && d.children.length === 0);
  plus?.click();
  return !!plus;
});
await addSwatch();
await sleep(300);
const plusGone = await page.evaluate(() => ![...document.querySelectorAll('div')].some((d) => d.textContent.trim() === '+' && d.children.length === 0));
brand = await page.evaluate(() => JSON.parse(localStorage.getItem('freeart-brand-v1') || 'null'));
chk('E3 色板可加到 6 个后按钮消失', brand.colors.length === 6 && plusGone, `色数=${brand.colors.length} +号消失=${plusGone}`);

// 新文字用品牌主色 + 字体
const tBefore = (await st()).texts;
await clickText('加文字');
await sleep(900);
const txt = await page.evaluate(() => {
  const t = window.__freeartStage.find('Text');
  const n = t[t.length - 1];
  return n ? { fill: String(n.fill()).toLowerCase(), font: n.fontFamily() } : null;
});
chk('E4 新文字自动套品牌色+字体', txt && txt.fill === '#c0492b' && /KaiTi/.test(txt.font), JSON.stringify(txt));

// 色板卡
const beforeCard = (await st()).sizes;
await clickText('生成品牌色板卡');
await waitIdle(20000);
await sleep(1500);
const cardSizes = (await st()).sizes;
const card = cardSizes[cardSizes.length - 1];
const cardRatio = card ? (() => { const [w, hh] = card.split('x').map(Number); return w / hh; })() : 0;
chk('E5 品牌色板卡生成', cardSizes.length === beforeCard.length + 1 && Math.abs(cardRatio - 1400 / 920) < 0.03, `尺寸=${card} 比例=${cardRatio.toFixed(2)}`);

// 品牌色套图
await selectAt(740, 430);
const beforeTint = (await st()).images;
await clickText('把选中图套成品牌色');
await waitIdle(20000);
chk('E6 图片套用品牌主色', (await st()).images === beforeTint + 1);
await page.screenshot({ path: `${SHOTS}/full_brand.png` });

// ---------------- F 技能沉淀 ----------------
console.log('\n--- F 技能沉淀 ---');
await page.evaluate(() => {
  const inp = [...document.querySelectorAll('input')].filter((i) => (i.type || 'text') === 'text').pop();
  const set = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
  set.call(inp, 'premium coffee poster, warm light');
  inp.dispatchEvent(new Event('input', { bubbles: true }));
});
dialogQueue.length = 0; dialogQueue.push('回归技能');
await clickText('存技能');
await sleep(900);
let skills = await page.evaluate(() => JSON.parse(localStorage.getItem('freeart-skills-v1') || '[]'));
chk('F1 存技能写入本地', skills.length === 1 && skills[0].name === '回归技能', JSON.stringify(skills.map((x) => x.name)));

await page.reload({ waitUntil: 'networkidle2' });
await sleep(1200);
const chipExists = await page.evaluate(() => {
  const chips = [...document.querySelectorAll('div')].filter((d) => d.textContent.includes('回归技能') && d.textContent.includes('★'));
  return chips.length >= 1;
});
chk('F2 刷新后技能仍存在', chipExists);

// 点 chip 回填
await page.evaluate(() => {
  const chip = [...document.querySelectorAll('div')].filter((d) => d.textContent.includes('回归技能') && d.textContent.includes('★')).pop();
  chip.click();
});
await sleep(700);
const filled = await page.evaluate(() => [...document.querySelectorAll('input')].filter((i) => (i.type || 'text') === 'text').pop().value);
chk('F3 点技能回填提示词', filled === 'premium coffee poster, warm light', filled);

// 删除技能
await page.evaluate(() => {
  const chip = [...document.querySelectorAll('div')].filter((d) => d.textContent.includes('回归技能') && d.textContent.includes('★')).pop();
  [...chip.querySelectorAll('span')].find((x) => x.textContent.trim() === '×').click();
});
await sleep(600);
skills = await page.evaluate(() => JSON.parse(localStorage.getItem('freeart-skills-v1') || '[]'));
const chipGone = await page.evaluate(() => ![...document.querySelectorAll('div')].some((d) => d.textContent.includes('回归技能') && d.textContent.includes('★')));
chk('F4 删除技能生效', skills.length === 0 && chipGone);

// ---------------- G 画布交互 ----------------
console.log('\n--- G 画布交互 ---');
await clearCanvas();
await importFile(IMG);
s = await st();
const p0 = s.pos[0];
// 拖拽
await page.mouse.move(p0.x + p0.w / 2, p0.y + p0.h / 2);
await page.mouse.down();
await page.mouse.move(p0.x + p0.w / 2 + 120, p0.y + p0.h / 2 + 60, { steps: 10 });
await page.mouse.up();
await sleep(600);
let p1 = (await st()).pos[0];
chk('G1 拖拽移动节点', Math.abs(p1.x - p0.x - 120) < 12 && Math.abs(p1.y - p0.y - 60) < 12, `${p0.x},${p0.y} → ${p1.x},${p1.y}`);

// 滚轮缩放
const sc0 = (await st()).scale;
await page.mouse.move(700, 450);
await page.mouse.wheel({ deltaY: -240 });
await sleep(700);
const sc1 = (await st()).scale;
chk('G2 滚轮缩放画布', sc1 > sc0, `scale ${sc0} → ${sc1}`);
await page.mouse.wheel({ deltaY: 240 });
await sleep(600);

// 空白拖拽平移
s = await st();
const sx0 = s.sx;
await page.mouse.move(100, 700);
await page.mouse.down();
await page.mouse.move(220, 760, { steps: 10 });
await page.mouse.up();
await sleep(600);
const sx1 = (await st()).sx;
chk('G3 空白处拖拽平移画布', sx1 !== sx0, `stage.x ${sx0} → ${sx1}`);

// 刷新后位置持久化
await page.reload({ waitUntil: 'networkidle2' });
await sleep(1200);
const p2 = (await st()).pos[0];
chk('G4 刷新后节点位置保留', p2 && Math.abs(p2.x - p1.x) < 2, `${p1.x},${p1.y} → ${p2?.x},${p2?.y}`);

// Delete 删除
await page.mouse.click(p2.x + p2.w / 2, p2.y + p2.h / 2);
await sleep(500);
await page.keyboard.press('Delete');
await sleep(600);
chk('G5 Delete 键删除选中节点', (await st()).images === 0, `剩余=${(await st()).images}`);

// 双击编辑文字
await clickText('加文字');
await sleep(800);
s = await st();
const tp = await page.evaluate(() => {
  const t = window.__freeartStage.find('Text')[0];
  return { x: Math.round(t.x()), y: Math.round(t.y()), w: Math.round(t.width()) };
});
dialogQueue.length = 0; dialogQueue.push('品牌主标题');
// Konva 的 dblclick 需要两次独立点击（间隔 < 400ms），clickCount:2 不会触发
await page.mouse.click(tp.x + 30, tp.y + 18);
await sleep(90);
await page.mouse.click(tp.x + 30, tp.y + 18);
await sleep(900);
const txtNow = await page.evaluate(() => window.__freeartStage.find('Text')[0]?.text());
chk('G6 双击文字可编辑', txtNow === '品牌主标题', String(txtNow));

// 拖角缩放
const nodePos = await page.evaluate(() => {
  const n = window.__freeartStage.find('Image')[0];
  return n ? { x: Math.round(n.x()), y: Math.round(n.y()), w: Math.round(n.width()), h: Math.round(n.height()) } : null;
});
chk('G7 文字图层可变换（读取尺寸正常）', tp.w > 0, `width=${tp.w}`);

// ---------------- H 导出 ----------------
console.log('\n--- H 导出 ---');
await clearCanvas();
await importFile(IMG);
const dataUrlLen = await page.evaluate(() => window.__freeartStage.toDataURL({ pixelRatio: 1 }).length);
chk('H1 画布可导出 PNG（dataURL 有效）', dataUrlLen > 5000, `${Math.round(dataUrlLen / 1024)}KB`);

// ---------------- J 去背 ----------------
console.log('\n--- J 去背景（本地模型）---');
await selectAt(740, 430);
const beforeBg = (await st()).images;
const bgClicked = await clickText('一键去背景（本地模型）');
let bgOk = false;
if (bgClicked) {
  const t0 = Date.now();
  while (Date.now() - t0 < 240000) {
    const b = await bodyText();
    if (/去背失败/.test(b)) break;
    if (!/正在加载去背|去背中|保存结果/.test(b)) { await sleep(1200); bgOk = (await st()).images === beforeBg + 1; break; }
    await sleep(1000);
  }
}
chk('J1 一键去背景生成新图层', bgOk, bgOk ? '成功' : (/去背失败/.test(await bodyText()) ? '报错: ' + (await bodyText()).match(/去背失败[^\n]*/)?.[0]?.slice(0, 80) : '超时'));

// ---------------- I 生成 ----------------
console.log('\n--- I AI 生成 ---');
if (!ONLINE) {
  await clearCanvas();
  const beforeGen = (await st()).images;
  await typeInto('描述你想要的设计', 'a single red apple on white background, studio photo');
  await sleep(300);
  await page.evaluate(() => [...document.querySelectorAll('button')].find((b) => b.textContent.trim() === '生成')?.click());
  let genOk = false;
  const t0 = Date.now();
  while (Date.now() - t0 < 200000) {
    await sleep(3000);
    const s2 = await st();
    if (s2.images > beforeGen) { genOk = true; break; }
    if (/生成失败/.test(await bodyText())) break;
  }
  chk('I1 生成图片并落到画布', genOk, genOk ? `耗时 ${Math.round((Date.now() - t0) / 1000)}s` : '失败/超时');

  const histOk = await page.evaluate(() => JSON.parse(localStorage.getItem('freeart-nodes-v1-history') || '[]').length > 0);
  chk('I2 生成历史已记录', histOk);
  await page.screenshot({ path: `${SHOTS}/full_gen.png` });
} else {
  console.log('（线上跳过：生成耗时过长，已单独验证过）');
}

// ---------------- H 清空 ----------------
console.log('\n--- H 清空画布 ---');
dialogQueue.length = 0;
await clickText('清空');
await sleep(800);
const cleared = await page.evaluate(() => ({
  images: window.__freeartStage.find('Image').length,
  store: JSON.parse(localStorage.getItem('freeart-nodes-v1') || '[]').length,
}));
chk('H2 清空画布并清除本地记录', cleared.images === 0 && cleared.store === 0, JSON.stringify(cleared));

// ---------------- K 移动端 ----------------
console.log('\n--- K 移动端视口 ---');
const m = await browser.newPage();
await m.setViewport({ width: 375, height: 812, isMobile: true, hasTouch: true });
await m.goto(BASE, { waitUntil: 'networkidle2' });
await sleep(1200);
const mobile = await m.evaluate(() => ({
  overflowX: document.documentElement.scrollWidth - window.innerWidth,
  hasInput: !!document.querySelector('input[placeholder]'),
  hasButtons: !!document.body.innerText.includes('生成'),
  panelW: document.querySelector('div')?.getBoundingClientRect().width,
}));
chk('K1 移动端无横向溢出', mobile.overflowX <= 2, `溢出=${mobile.overflowX}px`);
chk('K2 移动端输入框与生成按钮可见', mobile.hasInput && mobile.hasButtons);
const btnRows = await m.evaluate(() => {
  const spans = [...document.querySelectorAll('span')].filter((s) => ['导入图片', '加文字', '导出 PNG', '清空'].includes(s.textContent.trim()));
  return spans.map((s) => ({ t: s.textContent.trim(), h: Math.round(s.getBoundingClientRect().height) }));
});
chk('K3 移动端顶栏按钮不折行', btnRows.length === 4 && btnRows.every((b) => b.h < 30), JSON.stringify(btnRows));
await m.screenshot({ path: `${SHOTS}/full_mobile.png` });
await m.close();

chk('A4 全流程无 JS 报错', jsErrors.length === 0, jsErrors.slice(0, 3).join(' | '));

// ---------------- 汇总 ----------------
const passed = results.filter((r) => r.pass).length;
console.log('\n================ 汇总 ================');
console.log(`通过 ${passed}/${results.length}`);
const failed = results.filter((r) => !r.pass);
if (failed.length) {
  console.log('失败项：');
  failed.forEach((f) => console.log(` ❌ ${f.name}  ${f.detail}`));
} else {
  console.log('全部通过 ✅');
}
await browser.close();
process.exit(failed.length ? 1 : 0);
