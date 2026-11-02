// 本地引擎管理：状态探测 / 一键安装 / 启动 / 停止 / 日志流
// 引擎默认内置在 <项目>/engine/ComfyUI，也可以指向你已有的 ComfyUI 目录。
import { EventEmitter } from 'events';
import fs from 'fs';
import path from 'path';
import { spawn } from 'child_process';
import { installEngine, venvExe, hasNvidia, readCatalog, IS_WIN } from './installer.js';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const MAX_LOGS = 400;

export class EngineManager extends EventEmitter {
  constructor({ root, config, getConfig, saveConfig }) {
    super();
    this.root = root;
    this.bundled = path.join(root, 'engine', 'ComfyUI');
    this.config = config;
    this.getConfig = getConfig;
    this.saveConfig = saveConfig;
    this.logs = [];
    this.child = null;
    this.abort = null;
    this.phase = 'idle';       // idle | installing | starting | running | stopped | error
    this.lastError = '';
    this.gpu = null;
    this.online = false;
    this.progress = null;
    this.installTask = null;
  }

  get target() {
    const c = this.getConfig?.() || {};
    const configured = (c.COMFY_PATH || '').trim();
    if (configured && fs.existsSync(path.join(configured, 'main.py'))) return configured;
    return this.bundled;
  }

  get url() {
    const c = this.getConfig?.() || {};
    return (process.env.COMFY_URL || c.COMFY_URL || 'http://127.0.0.1:8188').replace(/\/+$/, '');
  }

  log(level, msg) {
    const entry = { t: Date.now(), level, msg: String(msg) };
    this.logs.push(entry);
    if (this.logs.length > MAX_LOGS) this.logs.splice(0, this.logs.length - MAX_LOGS);
    this.emit('log', entry);
    if (level === 'progress') {
      const m = /（(\d+)%）/.exec(entry.msg);
      if (m) this.progress = Number(m[1]) / 100;
    }
    if (level === 'err') this.lastError = String(msg);
  }

  async ping() {
    try {
      const r = await fetch(this.url + '/system_stats', { signal: AbortSignal.timeout(2000) });
      return r.ok;
    } catch (e) { return false; }
  }

  /** 汇总状态给前端 */
  async status() {
    const dir = this.target;
    const installed = fs.existsSync(path.join(dir, 'main.py'));
    const venvPy = venvExe(dir);
    const hasVenv = fs.existsSync(venvPy);
    const online = await this.ping();
    if (online && this.phase !== 'installing' && this.phase !== 'starting') this.phase = 'running';
    if (!online && this.phase === 'running') this.phase = 'stopped';

    let checkpoints = [];
    let upscalers = [];
    let vram = null;
    if (online) {
      try {
        const oi = await fetch(`${this.url}/object_info/CheckpointLoaderSimple`, { signal: AbortSignal.timeout(4000) });
        const j = await oi.json();
        checkpoints = j?.CheckpointLoaderSimple?.input?.required?.ckpt_name?.[0] || [];
      } catch (e) { /* ignore */ }
      try {
        const oi = await fetch(`${this.url}/object_info/UpscaleModelLoader`, { signal: AbortSignal.timeout(4000) });
        const j = await oi.json();
        upscalers = j?.UpscaleModelLoader?.input?.required?.model_name?.[0] || [];
      } catch (e) { /* ignore */ }
      try {
        const st = await fetch(this.url + '/system_stats', { signal: AbortSignal.timeout(4000) });
        const s = await st.json();
        const dev = s?.devices?.[0];
        if (dev) vram = { name: dev.name, total: Math.round((dev.vram_total || 0) / 1048576) };
      } catch (e) { /* ignore */ }
    }

    return {
      phase: this.phase,
      installed,
      hasVenv,
      dir,
      external: dir !== this.bundled,
      url: this.url,
      online,
      checkpoints,
      upscalers,
      vram,
      gpu: this.gpu?.name || null,
      progress: this.progress,
      lastError: this.lastError,
      logs: this.logs.slice(-120),
      catalog: readCatalog(this.root).map((m) => ({
        id: m.id, label: m.label, desc: m.desc, size: m.size, bytes: m.bytes || 0, core: !!m.core,
      })),
      missingModels: readCatalog(this.root)
        .filter((m) => !fs.existsSync(path.join(dir, m.dir, m.file)))
        .map((m) => m.id),
    };
  }

  /** 一键安装：源码 + Python 环境 + 依赖 + 选中的模型 */
  install({ models } = {}) {
    if (this.phase === 'installing') return { started: false, reason: 'busy' };
    this.phase = 'installing';
    this.progress = 0;
    this.lastError = '';
    this.abort = new AbortController();
    this.log('info', '开始安装本地引擎，全程自动，可随时取消');

    const picked = models && models.length ? models : ['sd15'];
    this.installTask = (async () => {
      try {
        this.gpu = await hasNvidia();
        if (this.gpu) this.log('ok', `检测到 ${this.gpu.name}${this.gpu.vramMB ? ` · ${Math.round(this.gpu.vramMB / 1024)}GB 显存` : ''}`);
        else this.log('warn', '没检测到 NVIDIA 显卡，将安装 CPU 版（能跑，但慢很多）');

        await installEngine({
          root: this.root,
          dir: path.join(this.root, 'engine'),
          models: picked,
          gpu: this.gpu,
          signal: this.abort.signal,
          onLog: (level, msg) => this.log(level, msg),
        });

        this.saveConfig?.({ COMFY_PATH: this.bundled });
        this.log('ok', '安装完成，正在启动引擎…');
        this.phase = 'idle';
        await this.start();
      } catch (e) {
        if (String(e.message).includes('已取消')) {
          this.log('warn', '已取消安装（已下载的部分会保留，下次接着下）');
        } else {
          this.log('err', '安装失败：' + e.message);
        }
        this.phase = 'error';
      } finally {
        this.abort = null;
        this.installTask = null;
      }
    })();
    return { started: true };
  }

  cancelInstall() {
    if (this.phase !== 'installing') return { ok: false };
    this.abort?.abort();
    return { ok: true };
  }

  /** 拉起引擎（已装但没跑时用） */
  async start() {
    if (await this.ping()) { this.phase = 'running'; return { ok: true, already: true }; }
    const dir = this.target;
    const venvPy = venvExe(dir);
    if (!fs.existsSync(path.join(dir, 'main.py'))) return { ok: false, error: '引擎未安装' };
    if (!fs.existsSync(venvPy)) return { ok: false, error: '缺少 Python 环境，请重新安装引擎' };

    const c = this.getConfig?.() || {};
    let args = Array.isArray(c.COMFY_ARGS) ? c.COMFY_ARGS.slice() : [];
    if (!args.length) {
      const g = this.gpu || (await hasNvidia());
      this.gpu = g;
      const low = g?.vramMB && g.vramMB < 6144;
      args = low ? ['--lowvram'] : [];
      if (low) this.log('info', `显存 ${Math.round(g.vramMB / 1024)}GB，自动加 --lowvram`);
    }
    this.phase = 'starting';
    this.log('info', `启动引擎：python main.py ${args.join(' ')}`);
    const child = spawn(venvPy, ['main.py', ...args], {
      cwd: dir, detached: !IS_WIN, stdio: 'ignore', windowsHide: false,
    });
    child.unref();
    this.child = child;

    for (let i = 0; i < 150; i++) {
      await sleep(2000);
      if (this.abort?.signal.aborted && this.phase === 'installing') break;
      if (await this.ping()) {
        this.phase = 'running';
        this.log('ok', `引擎已就绪（${((i + 1) * 2)}s）→ ${this.url}`);
        return { ok: true };
      }
      if (i % 10 === 9) this.log('info', `仍在启动…（${((i + 1) * 2)}s，首次要加载模型，请稍等）`);
    }
    this.phase = 'error';
    this.log('err', '引擎启动超时，请检查显卡驱动或引擎窗口输出');
    return { ok: false, error: '启动超时' };
  }

  async stop() {
    if (this.child) {
      try { process.kill(-this.child.pid); } catch (e) { try { this.child.kill(); } catch (e2) { /* ignore */ } }
      this.child = null;
    }
    // 外部启动的也要关掉：直接对端口发 /exit 不可靠，最多等 10s
    for (let i = 0; i < 10; i++) {
      await sleep(1000);
      if (!(await this.ping())) { this.phase = 'stopped'; this.log('info', '引擎已停止'); return { ok: true }; }
    }
    this.phase = 'stopped';
    return { ok: true, warning: '引擎未响应，可能由外部启动，请在它自己的窗口里关闭' };
  }
}
