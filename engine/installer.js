// FREEART 本地引擎安装器
// 把 ComfyUI + 推荐模型装到项目内的 engine/ComfyUI，装完即可用本地显卡出图。
// 全过程无人值守：自动选源、断点续传、可被取消。
import { spawn } from 'child_process';
import fs from 'fs';
import path from 'path';
import os from 'os';
import { createRequire } from 'module';
import { pipeline } from 'stream/promises';
import { Readable } from 'stream';

const require = createRequire(import.meta.url);
const IS_WIN = process.platform === 'win32';

// pip 源（按国内可达性排序，安装时逐个探测）
const PY_INDEXES = [
  'https://mirrors.aliyun.com/pypi/simple/',
  'https://mirrors.cloud.tencent.com/pypi/simple/',
  'https://pypi.tuna.tsinghua.edu.cn/simple/',
  'https://pypi.org/simple/',
];
// NVIDIA 显卡专用 torch 源
const TORCH_INDEXES = [
  'https://mirrors.aliyun.com/pytorch-wheels/cu124/',
  'https://mirror.sjtu.edu.cn/pytorch-wheels/cu121/',
  'https://download.pytorch.org/whl/cu121/',
];
const COMFY_ZIPS = [
  'https://codeload.github.com/comfyanonymous/ComfyUI/zip/refs/heads/master',
  'https://gh-proxy.com/https://github.com/comfyanonymous/ComfyUI/archive/refs/heads/master.zip',
  'https://github.com/comfyanonymous/ComfyUI/archive/refs/heads/master.zip',
];

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const GB = 1024 * 1024 * 1024;

function fmtSize(n) {
  if (!n) return '0 B';
  if (n >= GB) return (n / GB).toFixed(2) + ' GB';
  if (n >= 1024 * 1024) return (n / 1024 / 1024).toFixed(1) + ' MB';
  return Math.round(n / 1024) + ' KB';
}

/** 跑外部命令，逐行吐日志；kill 掉子进程即可取消 */
function run(cmd, args, opts = {}) {
  return new Promise((resolve) => {
    let child;
    try {
      child = spawn(cmd, args, {
        cwd: opts.cwd,
        windowsHide: false,
        env: { ...process.env, PYTHONIOENCODING: 'utf-8', PYTHONUNBUFFERED: '1', ...(opts.env || {}) },
      });
    } catch (e) {
      resolve({ code: -1, out: '', err: String(e.message) });
      return;
    }
    let buf = '';
    let out = '';
    const onData = (chunk) => {
      buf += chunk.toString('utf8');
      let i;
      while ((i = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, i).trim();
        buf = buf.slice(i + 1);
        if (line) { out += line + '\n'; opts.onLine?.(line); }
      }
    };
    child.stdout?.on('data', onData);
    child.stderr?.on('data', onData);
    const finish = (code) => {
      if (buf.trim()) { out += buf.trim() + '\n'; opts.onLine?.(buf.trim()); }
      resolve({ code, out });
    };
    child.on('close', finish);
    child.on('error', (e) => resolve({ code: -1, out, err: String(e.message) }));
    opts.register?.(child);
  });
}

/** 逐个探测，返回第一个连得上的 URL（以及它是否支持断点续传） */
async function probe(urls, { timeout = 15000, method = 'GET' } = {}) {
  for (const url of urls) {
    try {
      const r = await fetch(url, {
        method,
        headers: method === 'GET' ? { Range: 'bytes=0-0' } : undefined,
        signal: AbortSignal.timeout(timeout),
        redirect: 'follow',
      });
      await r.arrayBuffer().catch(() => {});
      if (r.ok || r.status === 206) return { url, ok: true, status: r.status };
    } catch (e) { /* 换下一个 */ }
  }
  return { url: urls[0], ok: false, status: 0 };
}

/** 断点续传下载。urls 逐个兜底，网络断了保留 .part 下次接着下 */
async function downloadFile(urls, dest, { onLog, label, bytes, signal } = {}) {
  const tmp = dest + '.part';
  const attempts = urls.length * 3;
  for (let i = 0; i < attempts; i++) {
    if (signal?.aborted) throw new Error('已取消');
    const url = urls[i % urls.length];
    let start = fs.existsSync(tmp) ? fs.statSync(tmp).size : 0;
    try {
      // 超时只作用于「拿到响应头」这一步，绝不能绑定整个下载流
      const ac = new AbortController();
      const timer = setTimeout(() => ac.abort(new Error('连接超时')), 45000);
      let res;
      try {
        res = await fetch(url, {
          headers: start > 0 ? { Range: `bytes=${start}-` } : undefined,
          signal: ac.signal,
          redirect: 'follow',
        });
      } finally { clearTimeout(timer); }

      if (res.status === 416) { fs.rmSync(tmp, { force: true }); start = 0; throw new Error('服务端不接受续传，重新开始'); }
      if (!res.ok && res.status !== 206) throw new Error('HTTP ' + res.status);
      const partial = res.status === 206;
      const total = Number(res.headers.get('content-length') || 0) + (partial ? start : 0);
      if (!partial) start = 0;

      const ws = fs.createWriteStream(tmp, { flags: partial ? 'a' : 'w' });
      let done = start;
      let lastLog = 0;
      let lastChunk = Date.now();
      const src = Readable.fromWeb(res.body);
      // 卡死看门狗：3 分钟没收到任何字节就断掉重连
      const dog = setInterval(() => {
        if (Date.now() - lastChunk > 180000) {
          try { src.destroy(new Error('下载停滞')); } catch (e) { /* ignore */ }
        }
      }, 10000);
      src.on('data', (c) => {
        done += c.length;
        lastChunk = Date.now();
        const now = Date.now();
        const pct = total ? done / total : 0;
        if (now - lastLog > 1500 || pct >= 1) {
          lastLog = now;
          onLog?.('progress', `${label}：${fmtSize(done)} / ${fmtSize(total || bytes || 0)}（${Math.round(pct * 100)}%）`);
        }
        if (signal?.aborted) {
          try { src.destroy(new Error('已取消')); } catch (e) { /* ignore */ }
        }
      });
      try {
        await pipeline(src, ws);
      } finally { clearInterval(dog); }

      fs.renameSync(tmp, dest);
      onLog?.('ok', `${label} 下载完成（${fmtSize(fs.statSync(dest).size)}）`);
      return dest;
    } catch (e) {
      if (signal?.aborted) throw new Error('已取消');
      const kept = fs.existsSync(tmp) ? fs.statSync(tmp).size : 0;
      if (i === attempts - 1) {
        onLog?.('err', `${label} 下载失败：${e.message}（已保留 ${fmtSize(kept)}，下次接着下）`);
        throw e;
      }
      onLog?.('warn', `${label} 下载中断（${e.message}），换源重试…`);
      await sleep(2000);
    }
  }
  throw new Error('下载失败');
}

/** 解压 zip / tar.gz 到目标目录 */
async function extract(archive, dest, onLog) {
  fs.mkdirSync(dest, { recursive: true });
  if (archive.endsWith('.zip') && IS_WIN) {
    const r = await run('powershell', [
      '-NoProfile', '-NonInteractive', '-Command',
      `Expand-Archive -LiteralPath '${archive}' -DestinationPath '${dest}' -Force`,
    ], { onLine: (l) => onLog?.('info', l) });
    if (r.code !== 0) throw new Error('解压失败（Expand-Archive）');
    return;
  }
  const r = await run('tar', ['-xf', archive, '-C', dest], { onLine: (l) => onLog?.('info', l) });
  if (r.code !== 0) throw new Error('解压失败（tar）');
}

/** 找系统 Python（3.10 ~ 3.13），找不到返回 null */
async function detectPython() {
  const cands = IS_WIN ? ['python', 'py -3'] : ['python3', 'python'];
  for (const raw of cands) {
    const [cmd, ...pre] = raw.split(' ');
    if (!cmd) continue;
    const r = await run(cmd, [...pre, '-c', 'import sys;print(sys.version_info[:2])'], { cwd: os.tmpdir() });
    if (r.code !== 0) continue;
    const m = /\(\s*(\d+)\s*,\s*(\d+)\s*\)/.exec(r.out.trim());
    if (!m) continue;
    const minor = Number(m[2]);
    const major = Number(m[1]);
    if (major !== 3 || minor < 10 || minor > 13) continue;
    return { exe: raw === 'py -3' ? 'py' : cmd, preArgs: raw === 'py -3' ? ['-3'] : [], version: `3.${minor}`, warn: minor >= 13 };
  }
  return null;
}

/** 有 NVIDIA 显卡吗（决定装 CUDA 版还是 CPU 版 torch、要不要 --lowvram） */
async function hasNvidia() {
  const r = await run('nvidia-smi', ['-L'], { cwd: os.tmpdir() });
  if (r.code !== 0) return null;
  const name = (r.out.match(/GPU \d+: (.+?) \(/) || [])[1] || (r.out.split('\n')[0] || '').trim();
  let vramMB = 0;
  const m = await run('nvidia-smi', ['--query-gpu=memory.total', '--format=csv,noheader,nounits'], { cwd: os.tmpdir() });
  if (m.code === 0) vramMB = Number((m.out.trim().split('\n')[0] || '').trim()) || 0;
  return { name: name || 'NVIDIA GPU', vramMB };
}

/** 没有合适 Python 时，装一个独立的 uv（它可以自动下载 CPython） */
async function ensureUv(toolsDir, onLog, signal) {
  const exeName = IS_WIN ? 'uv.exe' : 'uv';
  const existing = path.join(toolsDir, exeName);
  if (fs.existsSync(existing)) return existing;

  const plat = (() => {
    const arch = process.arch;
    if (IS_WIN) return arch === 'arm64' ? 'aarch64-pc-windows-msvc' : 'x86_64-pc-windows-msvc';
    if (process.platform === 'darwin') return arch === 'arm64' ? 'aarch64-apple-darwin' : 'x86_64-apple-darwin';
    return arch === 'arm64' ? 'aarch64-unknown-linux-gnu' : 'x86_64-unknown-linux-gnu';
  })();
  fs.mkdirSync(toolsDir, { recursive: true });
  onLog?.('info', '本机没有合适的 Python，改用 uv 自动准备（约 20MB）…');
  let got = null;
  for (const raw of [
    `https://github.com/astral-sh/uv/releases/latest/download/uv-${plat}.zip`,
    `https://gh-proxy.com/https://github.com/astral-sh/uv/releases/latest/download/uv-${plat}.zip`,
    `https://github.com/astral-sh/uv/releases/latest/download/uv-${plat}.tar.gz`,
    `https://gh-proxy.com/https://github.com/astral-sh/uv/releases/latest/download/uv-${plat}.tar.gz`,
  ]) {
    const ext = raw.endsWith('.zip') ? '.zip' : '.tar.gz';
    const p = path.join(toolsDir, 'uv' + ext);
    try {
      await downloadFile([raw], p, { onLog, label: 'uv', bytes: 20 * 1024 * 1024, signal });
      got = p;
      break;
    } catch (e) { /* 换下一个源 */ }
  }
  if (!got) throw new Error('uv 下载失败。请手动安装 Python 3.11（https://www.python.org/downloads/）后重试');
  await extract(got, toolsDir, onLog);
  fs.rmSync(got, { force: true });
  if (!fs.existsSync(existing)) throw new Error('uv 解压后未找到可执行文件');
  if (!IS_WIN) fs.chmodSync(existing, 0o755);
  onLog?.('ok', 'uv 就绪');
  return existing;
}

function venvExe(comfyDir) {
  return IS_WIN
    ? path.join(comfyDir, 'venv', 'Scripts', 'python.exe')
    : path.join(comfyDir, 'venv', 'bin', 'python');
}

/**
 * 安装引擎主体
 * @param {object} o { root, dir, models:[id], gpu, onLog, signal, register }
 */
export async function installEngine(o) {
  const {
    root, dir, models = ['sd15'], gpu = null, onLog, signal, register,
  } = o;
  const target = path.join(dir, 'ComfyUI');
  const toolsDir = path.join(dir, '.tools');
  fs.mkdirSync(dir, { recursive: true });

  const abort = () => { if (signal?.aborted) throw new Error('已取消安装'); };

  // ---- 1. 源码 ----
  if (fs.existsSync(path.join(target, 'main.py'))) {
    onLog?.('ok', `ComfyUI 已存在，跳过下载（${target}）`);
  } else {
    onLog?.('info', '下载 ComfyUI 源码…');
    const zip = path.join(dir, 'comfy.zip');
    try {
      await downloadFile(COMFY_ZIPS, zip, { onLog, label: 'ComfyUI 源码', bytes: 8 * 1024 * 1024, signal, register });
    } catch (e) {
      if (signal?.aborted) throw new Error('已取消安装');
      throw e;
    }
    onLog?.('info', '解压 ComfyUI…');
    const staging = path.join(dir, '.staging');
    fs.rmSync(staging, { recursive: true, force: true });
    await extract(zip, staging, onLog);
    fs.rmSync(zip, { force: true });
    const inner = fs.readdirSync(staging).find((n) => fs.existsSync(path.join(staging, n, 'main.py')));
    if (!inner) throw new Error('压缩包里没找到 main.py，请手工下载 ComfyUI 放进 engine/ComfyUI');
    fs.rmSync(target, { recursive: true, force: true });
    fs.renameSync(path.join(staging, inner), target);
    fs.rmSync(staging, { recursive: true, force: true });
    onLog?.('ok', 'ComfyUI 源码就绪');
  }
  abort();

  // ---- 2. Python 环境 ----
  let venvPy = venvExe(target);
  let useUv = null;
  if (!fs.existsSync(venvPy)) {
    const py = await detectPython();
    const mirrorPick = await probe(PY_INDEXES, { timeout: 10000 });
    const indexUrl = mirrorPick.ok ? mirrorPick.url : PY_INDEXES[PY_INDEXES.length - 1];
    onLog?.('info', `pip 源：${indexUrl.replace(/\/simple\/?$/, '')}`);

    if (py) {
      onLog?.('info', `使用本机 Python ${py.version}${py.warn ? '（3.13 兼容性略差，建议 3.11/3.12）' : ''}，创建虚拟环境…`);
      const r = await run(py.exe, [...py.preArgs, '-m', 'venv', path.join(target, 'venv')], { cwd: target, onLine: (l) => onLog?.('info', l), register });
      if (r.code !== 0) throw new Error('创建虚拟环境失败：' + (r.out || '').slice(-300));
    } else {
      useUv = await ensureUv(toolsDir, onLog, signal);
      abort();
      onLog?.('info', '用 uv 创建虚拟环境（会自动下载 CPython 3.11）…');
      const r = await run(useUv, ['venv', '--python', '3.11', path.join(target, 'venv')], {
        cwd: target, onLine: (l) => onLog?.('info', l), register,
        env: { UV_INDEX_URL: indexUrl, UV_PYTHON_INSTALL_DIR: toolsDir },
      });
      if (r.code !== 0) throw new Error('uv 创建虚拟环境失败：' + (r.out || '').slice(-300));
    }
    onLog?.('ok', '虚拟环境创建完成');
  } else {
    // 已存在 venv：判断是否 uv 建的（uv 建的更快）
    if (fs.existsSync(path.join(toolsDir, IS_WIN ? 'uv.exe' : 'uv'))) {
      useUv = path.join(toolsDir, IS_WIN ? 'uv.exe' : 'uv');
    }
    onLog?.('ok', '虚拟环境已存在，跳过');
  }
  abort();

  // ---- 3. 依赖 ----
  const reqFile = path.join(target, 'requirements.txt');
  const mirrorPick = await probe(PY_INDEXES, { timeout: 10000 });
  const indexUrl = mirrorPick.ok ? mirrorPick.url : PY_INDEXES[PY_INDEXES.length - 1];
  const pipEnv = useUv
    ? { UV_INDEX_URL: indexUrl, UV_PYTHON_INSTALL_DIR: toolsDir, VIRTUAL_ENV: path.join(target, 'venv') }
    : {};

  if (gpu?.name) {
    onLog?.('info', `检测到 ${gpu.name}${gpu.vramMB ? `（${Math.round(gpu.vramMB / 1024)}GB 显存）` : ''}，安装 CUDA 版 torch（约 2.5GB，请耐心）…`);
    const torchPick = await probe(TORCH_INDEXES, { timeout: 12000 });
    const torchUrl = torchPick.ok ? torchPick.url : TORCH_INDEXES[TORCH_INDEXES.length - 1];
    const args = useUv
      ? ['pip', 'install', '--index-url', torchUrl, '--extra-index-url', indexUrl, 'torch', 'torchvision', 'torchaudio']
      : ['-m', 'pip', 'install', '--index-url', torchUrl, '--extra-index-url', indexUrl, 'torch', 'torchvision', 'torchaudio'];
    const cmd = useUv ? useUv : venvPy;
    const r = await run(cmd, args, {
      cwd: target, env: pipEnv, register,
      onLine: (l) => { if (/Collecting|Downloading|Installing|Successfully|ERROR|error:/i.test(l)) onLog?.('info', l); },
    });
    if (r.code !== 0) {
      onLog?.('warn', 'CUDA 版 torch 安装失败，退回普通源继续（可能退化为 CPU 版）');
    } else {
      onLog?.('ok', 'CUDA 版 torch 安装完成');
    }
    abort();
  }

  onLog?.('info', '安装 ComfyUI 依赖（requirements.txt）…');
  const req = await run(useUv ? useUv : venvPy, [...(useUv ? ['pip', 'install', '--index-url', indexUrl, '-r', reqFile] : ['-m', 'pip', 'install', '-i', indexUrl, '-r', reqFile])], {
    cwd: target, env: pipEnv, register,
    onLine: (l) => { if (/Collecting|Downloading|Installing|Successfully|ERROR|error:/i.test(l)) onLog?.('info', l); },
  });
  if (req.code !== 0) throw new Error('依赖安装失败：' + (req.out || '').slice(-400));
  onLog?.('ok', '依赖安装完成');
  abort();

  // ---- 4. 模型 ----
  const catalog = readCatalog(root);
  const picked = catalog.filter((m) => models.includes(m.id));
  fs.mkdirSync(path.join(target, 'models', 'checkpoints'), { recursive: true });
  fs.mkdirSync(path.join(target, 'models', 'upscale_models'), { recursive: true });
  for (const m of picked) {
    abort();
    const dest = path.join(target, m.dir, m.file);
    if (fs.existsSync(dest)) { onLog?.('ok', `${m.label} 已存在，跳过`); continue; }
    onLog?.('info', `下载 ${m.label}（${m.size}）…`);
    await downloadFile(m.urls, dest, { onLog, label: m.label, bytes: m.bytes, signal, register });
  }

  onLog?.('ok', '全部就绪。引擎已内置到 ' + target);
  return { dir: target, venvPy: venvExe(target) };
}

export function readCatalog(root) {
  try {
    const j = JSON.parse(fs.readFileSync(path.join(root, 'engine', 'models.json'), 'utf-8'));
    return Array.isArray(j.models) ? j.models : [];
  } catch (e) { return []; }
}

export { venvExe, detectPython, hasNvidia, fmtSize, downloadFile, IS_WIN };
