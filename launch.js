// FREEART 一键启动：拉起内置引擎 → 启动服务 → 打开独立应用窗口
// 用法：双击「启动 FREEART.bat」，或 node launch.js
import { spawn } from 'child_process';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { createRequire } from 'module';
import { loadConfig, saveConfig } from './config.js';
import { EngineManager } from './engine/manager.js';

const require = createRequire(import.meta.url);
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const cfg = loadConfig();

const PORT = process.env.PORT || 3000;
const APP_URL = `http://localhost:${PORT}`;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function alive(url, timeout = 2500) {
  try {
    const r = await fetch(url, { signal: AbortSignal.timeout(timeout) });
    return r.ok;
  } catch (e) { return false; }
}

async function startApp() {
  if (await alive(APP_URL)) { console.log('✔ 服务已在运行'); return; }
  console.log('▶ 启动 FREEART 服务…');
  const child = spawn(process.execPath, ['server.js'], {
    cwd: __dirname, detached: true, stdio: 'ignore',
  });
  child.unref();
  for (let i = 0; i < 30; i++) {
    await sleep(1000);
    if (await alive(APP_URL)) { console.log('✔ 服务已就绪'); return; }
  }
  throw new Error('服务启动失败');
}

function openAppWindow() {
  const chromePaths = [
    'C:/Program Files/Google/Chrome/Application/chrome.exe',
    'C:/Program Files (x86)/Google/Chrome/Application/chrome.exe',
    path.join(process.env.LOCALAPPDATA || '', 'Google/Chrome/Application/chrome.exe'),
    'C:/Program Files/Microsoft/Edge/Application/msedge.exe',
    'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
  ].filter((p) => p && fs.existsSync(p));

  if (chromePaths.length) {
    spawn(chromePaths[0], [`--app=${APP_URL}`, '--window-size=1440,900'], { detached: true, stdio: 'ignore' }).unref();
    console.log('✔ 已打开应用窗口（' + path.basename(chromePaths[0]) + '）');
  } else {
    spawn('cmd', ['/c', 'start', APP_URL], { detached: true, stdio: 'ignore' }).unref();
    console.log('✔ 已在默认浏览器打开');
  }
}

(async () => {
  console.log('\n===== FREEART 启动器 =====');
  if (!fs.existsSync(path.join(__dirname, 'node_modules'))) {
    console.log('✘ 缺少依赖，请先在项目目录执行：npm install --registry=https://registry.npmmirror.com');
    process.exit(1);
  }

  const engine = new EngineManager({
    root: __dirname,
    config: cfg,
    getConfig: () => cfg,
    saveConfig: (patch) => saveConfig(patch),
  });
  engine.on('log', (e) => {
    const mark = e.level === 'err' ? '✘' : e.level === 'warn' ? '!' : e.level === 'ok' ? '✔' : '·';
    console.log(`  ${mark} ${e.msg}`);
  });

  try {
    const st = await engine.status();
    if (!st.installed) {
      console.log('· 本地引擎未安装 → 打开页面后点 ⚡ 引擎 → 一键安装（约 4GB，全程自动）');
      console.log('  不装也能用：云端生图 + 本地 27 种改图照常可用');
    } else if (st.online) {
      console.log('✔ 本地引擎已在运行');
    } else {
      await engine.start();
    }
    await startApp();
    openAppWindow();
    console.log('\n完成。浏览器窗口已打开：' + APP_URL);
    console.log('提示：图生图 / 局部重绘 / 随心改 需要引擎在运行。\n');
  } catch (e) {
    console.log('✘ 启动失败：' + e.message);
    process.exit(1);
  }
})();
