import express from 'express';
import path from 'path';
import fs from 'fs';
import crypto from 'crypto';
import { fileURLToPath } from 'url';
import {
  comfyCheck, comfyUpload, comfyRun, comfyDataUrl, randName, DEFAULT_NEG,
} from './comfyApi.js';
import { BUILDERS } from './comfyWorkflows.js';
import { plan, executePlan, detectCaps } from './planner.js';
import { loadConfig, saveConfig } from './config.js';
import { EngineManager } from './engine/manager.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const app = express();
app.use(express.json({ limit: '60mb' }));

// ---------- 配置 ----------
const config = loadConfig();

const DATA_DIR = path.join(__dirname, 'data', 'images');
fs.mkdirSync(DATA_DIR, { recursive: true });
app.use('/files', express.static(path.join(__dirname, 'data')));

// 选择一个可用 provider：优先显式配置，其次按 key 是否存在回退
function pickProvider() {
  const forced = process.env.IMAGE_PROVIDER || config.IMAGE_PROVIDER;
  const falKey = process.env.FAL_KEY || config.FAL_KEY;
  const zhipuKey = process.env.ZHIPU_KEY || config.ZHIPU_KEY;
  const hasFal = falKey && !falKey.includes('粘贴') && falKey.length > 20;
  const hasZhipu = zhipuKey && !zhipuKey.includes('粘贴') && zhipuKey.length > 10;

  if (forced === 'fal' && hasFal) return 'fal';
  if (forced === 'zhipu' && hasZhipu) return 'zhipu';
  if (forced === 'pollinations') return 'pollinations';
  if (hasZhipu) return 'zhipu';
  return 'pollinations';
}

// ---------- Provider: Pollinations（免费、无需 key） ----------
// 全局串行队列 + 最小间隔，规避匿名档的频率限制
let queueTail = Promise.resolve();
let lastCallAt = 0;
function enqueue(task) {
  const run = queueTail.then(task, task);
  queueTail = run.then(() => {}, () => {});
  return run;
}
async function throttle(minGap = 15000) {
  const wait = Math.max(0, lastCallAt + minGap - Date.now());
  if (wait > 0) await new Promise((r) => setTimeout(r, wait));
  lastCallAt = Date.now();
}

async function genPollinations(prompt, size) {
  // 注意：seed 参数会触发 402（付费档），这里刻意不带 seed
  const base =
    'https://image.pollinations.ai/prompt/' +
    encodeURIComponent(prompt) +
    `?width=${size.width}&height=${size.height}&nologo=true`;
  // sana/turbo 快（约 7s），flux 慢（30s+）但质量更稳，作兜底
  const models = ['sana', 'turbo', 'flux'];
  let lastErr;
  for (let attempt = 0; attempt < 4; attempt++) {
    await throttle(15000);
    const model = models[attempt % models.length];
    const url = base + '&model=' + model;
    try {
      const res = await fetch(url, {
        signal: AbortSignal.timeout(75000),
        headers: { 'User-Agent': 'Mozilla/5.0 FREEART/1.0' },
      });
      if (res.status === 402) {
        lastErr = new Error('免费通道排队中（402），正在重试');
        await new Promise((r) => setTimeout(r, 6000 * (attempt + 1)));
        continue;
      }
      if (!res.ok) {
        lastErr = new Error(`Pollinations 返回 ${res.status}`);
        continue;
      }
      const buf = Buffer.from(await res.arrayBuffer());
      if (buf.length < 1000) { lastErr = new Error('返回内容异常'); continue; }
      return { buffer: buf, mime: res.headers.get('content-type') || 'image/jpeg', model };
    } catch (e) {
      lastErr = e;
    }
  }
  throw lastErr || new Error('生成失败');
}

// ---------- Provider: 智谱 CogView-3-Flash（免费额度，需 key） ----------
async function genZhipu(prompt, size, key) {
  const res = await fetch('https://open.bigmodel.cn/api/paas/v4/images/generations', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${key}` },
    body: JSON.stringify({ model: 'cogview-3-flash', prompt, size: `${size.width}x${size.height}` }),
    signal: AbortSignal.timeout(120000),
  });
  const data = await res.json();
  if (!res.ok) throw new Error(data?.error?.message || `智谱返回 ${res.status}`);
  const imgUrl = data?.data?.[0]?.url;
  if (!imgUrl) throw new Error('智谱未返回图片地址');
  const imgRes = await fetch(imgUrl, { signal: AbortSignal.timeout(60000) });
  const buf = Buffer.from(await imgRes.arrayBuffer());
  return { buffer: buf, mime: imgRes.headers.get('content-type') || 'image/png' };
}

// ---------- Provider: fal.ai Nano Banana（付费，需 key） ----------
async function genFal(prompt, size, key) {
  const res = await fetch('https://queue.fal.run/fal-ai/gemini-25-flash-image', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Key ${key}` },
    body: JSON.stringify({ prompt }),
    signal: AbortSignal.timeout(180000),
  });
  if (!res.ok) {
    const t = await res.text();
    throw new Error(`fal.ai 返回 ${res.status}: ${t.slice(0, 160)}`);
  }
  const { request_id, response_url } = await res.json();
  const respUrl = response_url || `https://queue.fal.run/fal-ai/gemini-25-flash-image/requests/${request_id}`;

  for (let i = 0; i < 90; i++) {
    await new Promise((r) => setTimeout(r, 2000));
    const st = await fetch(respUrl, {
      headers: { Authorization: `Key ${key}` },
      signal: AbortSignal.timeout(30000),
    });
    if (st.status === 202) continue;
    const data = await st.json();
    const imgUrl = data?.images?.[0]?.url;
    if (imgUrl) {
      const imgRes = await fetch(imgUrl, { signal: AbortSignal.timeout(60000) });
      const buf = Buffer.from(await imgRes.arrayBuffer());
      return { buffer: buf, mime: imgRes.headers.get('content-type') || 'image/png' };
    }
    if (data?.status === 'COMPLETED' && !imgUrl) throw new Error('fal.ai 返回结果为空');
  }
  throw new Error('fal.ai 生成超时');
}

// ---------- 本地引擎（内置 ComfyUI）----------
// 引擎默认住在 <项目>/engine/ComfyUI，也可以指向已有的 ComfyUI 目录
const engine = new EngineManager({
  root: __dirname,
  config,
  getConfig: () => config,
  saveConfig: (patch) => saveConfig(patch),
});

app.get('/api/engine/status', async (req, res) => {
  try { res.json(await engine.status()); } catch (e) { res.status(500).json({ error: e.message }); }
});

app.get('/api/engine/logs', (req, res) => res.json({ logs: engine.logs.slice(-200) }));

app.get('/api/engine/stream', (req, res) => {
  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache, no-transform',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no',
  });
  const send = (obj) => res.write(`data: ${JSON.stringify(obj)}\n\n`);
  send({ type: 'hello', phase: engine.phase });
  const onLog = (entry) => send({ type: 'log', entry });
  engine.on('log', onLog);
  const tick = setInterval(async () => {
    try {
      const s = await engine.status();
      send({
        type: 'status',
        phase: s.phase, online: s.online, installed: s.installed,
        progress: s.progress, checkpoints: s.checkpoints.length,
      });
    } catch (e) { /* ignore */ }
  }, 3000);
  req.on('close', () => { clearInterval(tick); engine.off('log', onLog); });
});

app.post('/api/engine/install', (req, res) => {
  const { models } = req.body || {};
  const r = engine.install({ models });
  if (!r.started) return res.status(409).json(r);
  res.json(r);
});

app.post('/api/engine/cancel', (req, res) => res.json(engine.cancelInstall()));

app.post('/api/engine/start', (req, res) => {
  engine.start().then((r) => {
    if (!r.ok && r.error) engine.log('err', r.error);
  }).catch((e) => engine.log('err', e.message));
  res.json({ started: true });
});

app.post('/api/engine/stop', async (req, res) => res.json(await engine.stop()));

// ---------- Provider: ComfyUI（本机 GPU，免费无限）+ 自动工作流规划 ----------
// 底层与工作流模板已拆到 comfyApi.js / comfyWorkflows.js / planner.js
app.get('/api/comfy/status', async (req, res) => {
  res.json(await comfyCheck());
});

// 当前 ComfyUI 实际支持的能力（放大模型、扩图节点等是否可用）
app.get('/api/comfy/caps', async (req, res) => {
  res.json(await detectCaps());
});

// 单步：以图生图（保留供画笔/蒙版等确定性路径使用）
app.post('/api/comfy/img2img', async (req, res) => {
  const { initImage, prompt, negative, denoise, ckpt } = req.body || {};
  if (!initImage || !prompt) return res.status(400).json({ error: '缺少底图或提示词' });
  try {
    const st = await comfyCheck();
    if (!st.online) return res.status(503).json({ error: '未检测到本地 ComfyUI（需在本机运行，默认端口 8188）' });
    const model = ckpt || st.checkpoints[0];
    if (!model) return res.status(400).json({ error: 'ComfyUI 中没有可用的 checkpoint 模型' });
    const { buf, mime } = comfyDataUrl(initImage);
    const up = await comfyUpload(buf, mime, randName());
    const wf = BUILDERS.img2img({
      ckpt: model, pos: prompt, neg: negative || DEFAULT_NEG, imageName: up.name,
      denoise: Math.min(0.95, Math.max(0.2, Number(denoise) || 0.65)),
    });
    const out = await comfyRun(wf);
    res.json({ images: [{ dataUrl: `data:${out.mime};base64,${out.buffer.toString('base64')}` }] });
  } catch (err) {
    console.error('[comfy img2img]', err.message);
    res.status(500).json({ error: err.message });
  }
});

// 单步：蒙版局部重绘
app.post('/api/comfy/inpaint', async (req, res) => {
  const { initImage, mask, prompt, negative, ckpt } = req.body || {};
  if (!initImage || !mask || !prompt) return res.status(400).json({ error: '缺少底图、蒙版或提示词' });
  try {
    const st = await comfyCheck();
    if (!st.online) return res.status(503).json({ error: '未检测到本地 ComfyUI（需在本机运行，默认端口 8188）' });
    const model = ckpt || st.checkpoints[0];
    if (!model) return res.status(400).json({ error: 'ComfyUI 中没有可用的 checkpoint 模型' });
    const a = comfyDataUrl(initImage);
    const b = comfyDataUrl(mask);
    const [up1, up2] = await Promise.all([
      comfyUpload(a.buf, a.mime, randName()),
      comfyUpload(b.buf, b.mime, randName()),
    ]);
    const wf = BUILDERS.inpaint({
      ckpt: model, pos: prompt, neg: negative || DEFAULT_NEG, imageName: up1.name, maskName: up2.name,
    });
    const out = await comfyRun(wf);
    res.json({ images: [{ dataUrl: `data:${out.mime};base64,${out.buffer.toString('base64')}` }] });
  } catch (err) {
    console.error('[comfy inpaint]', err.message);
    res.status(500).json({ error: err.message });
  }
});

// 意图 → 工作流：说出想要的效果，后台自动拆解成可执行的步骤
app.post('/api/comfy/plan', async (req, res) => {
  const { instruction, ctx } = req.body || {};
  if (!instruction) return res.status(400).json({ error: '缺少 instruction' });
  try {
    res.json(await plan(String(instruction).slice(0, 300), ctx || {}));
  } catch (err) {
    res.status(500).json({ error: '规划失败：' + err.message });
  }
});

// 执行规划（多步串行）
app.post('/api/comfy/run-plan', async (req, res) => {
  const { steps, prompt, negative, initImage, mask, ckpt, upscaleModel } = req.body || {};
  if (!steps?.length) return res.status(400).json({ error: '没有可执行的步骤' });
  try {
    const results = await executePlan({ steps, prompt, negative, initImage, mask, ckpt, upscaleModel });
    res.json({ results });
  } catch (err) {
    console.error('[comfy run-plan]', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ---------- 生成接口 ----------
app.post('/api/generate', async (req, res) => {
  const { prompt, aspect } = req.body || {};
  if (!prompt) return res.status(400).json({ error: '缺少 prompt' });

  const sizes = {
    '1:1': { width: 1024, height: 1024 },
    '4:3': { width: 1152, height: 864 },
    '3:4': { width: 864, height: 1152 },
    '16:9': { width: 1280, height: 720 },
  };
  const size = sizes[aspect] || sizes['1:1'];
  const provider = pickProvider();

  try {
    const t0 = Date.now();
    const out = await enqueue(async () => {
      if (provider === 'zhipu') {
        return await genZhipu(prompt, size, process.env.ZHIPU_KEY || config.ZHIPU_KEY);
      }
      if (provider === 'fal') {
        return await genFal(prompt, size, process.env.FAL_KEY || config.FAL_KEY);
      }
      return await genPollinations(prompt, size);
    });
    const ext = out.mime.includes('png') ? 'png' : out.mime.includes('webp') ? 'webp' : 'jpg';
    const name = crypto.randomBytes(8).toString('hex') + '.' + ext;
    fs.writeFileSync(path.join(DATA_DIR, name), out.buffer);
    res.json({
      images: [{ url: `/files/images/${name}`, width: size.width, height: size.height }],
      provider,
      elapsed: Date.now() - t0,
    });
  } catch (err) {
    console.error(`[${provider}]`, err.message);
    res.status(500).json({ error: `生成失败（${provider}）：${err.message}` });
  }
});

// ---------- 上传编辑结果（去背 / 裁剪等本地处理产物） ----------
app.post('/api/upload', (req, res) => {
  const { dataUrl } = req.body || {};
  const m = /^data:(image\/(png|jpeg|webp));base64,(.+)$/.exec(dataUrl || '');
  if (!m) return res.status(400).json({ error: '图片格式不支持' });
  const ext = m[2] === 'jpeg' ? 'jpg' : m[2];
  const name = crypto.randomBytes(8).toString('hex') + '.' + ext;
  try {
    fs.writeFileSync(path.join(DATA_DIR, name), Buffer.from(m[3], 'base64'));
    res.json({ url: `/files/images/${name}` });
  } catch (e) {
    res.status(500).json({ error: '保存失败：' + e.message });
  }
});

app.get('/api/health', (req, res) => {
  const provider = pickProvider();
  res.json({
    ok: true,
    provider,
    free: provider === 'pollinations',
    hint:
      provider === 'pollinations'
        ? '免费通道（Pollinations / sana），无需密钥。去背、图层、导出全部本地完成；中文提示词可填智谱 key 提升。'
        : provider === 'zhipu'
        ? '当前使用智谱 CogView-3-Flash（免费额度）'
        : '当前使用 fal.ai Nano Banana（付费）',
  });
});

// ---------- 静态资源 ----------
// 自动挑选实际存在的产物目录（web 为当前构建目录，dist 兼容旧构建）
const candidates = ['web', 'dist'].map((d) => path.join(__dirname, d));
const hasIndex = (dir) => fs.existsSync(path.join(dir, 'index.html'));
const staticDir = candidates.find(hasIndex);

if (staticDir) {
  app.use(express.static(staticDir));
  app.get('*', (req, res, next) => {
    if (req.path.startsWith('/api/') || req.path.startsWith('/files/')) return next();
    res.sendFile(path.join(staticDir, 'index.html'));
  });
} else {
  console.warn('[warn] 未找到前端产物目录（web/ 或 dist/），请先执行 npm run build');
  app.get('/', (req, res) => {
    res.status(500).send('前端产物缺失：请在项目根目录执行 npm run build 后重新启动。');
  });
}

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  const p = pickProvider();
  console.log(`FREEART → http://localhost:${PORT}`);
  console.log(`图像通道: ${p}${p === 'pollinations' ? '（免费，无需 key）' : ''}`);

  if (config.ENGINE_AUTOSTART !== false) {
    (async () => {
      try {
        const s = await engine.status();
        if (s.installed && !s.online) {
          console.log('· 本地引擎已安装，后台启动中…');
          engine.start().catch(() => {});
        } else if (!s.installed) {
          console.log('· 本地引擎未安装：打开页面 → ⚡ 引擎 → 一键安装');
        }
      } catch (e) { /* 启动探测失败不影响主服务 */ }
    })();
  }
});
