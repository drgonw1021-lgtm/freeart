#!/usr/bin/env node
// 命令行安装本地引擎：node engine/install.mjs
// 常用参数：
//   --models sd15,realesrgan-x2   只装指定模型（id 见 engine/models.json）
//   --no-models                   只装引擎本体，模型自己放
//   --force                       已装也重装
//   --no-start                    装完不自动启动
import path from 'path';
import fs from 'fs';
import { fileURLToPath } from 'url';
import { loadConfig, saveConfig } from '../config.js';
import { EngineManager } from './manager.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.join(__dirname, '..');
const argv = process.argv.slice(2);
const argOf = (name) => {
  const i = argv.indexOf(name);
  return i >= 0 && argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[i + 1] : null;
};
const has = (name) => argv.includes(name);

const cfg = loadConfig();
const engine = new EngineManager({
  root, config: cfg, getConfig: () => cfg, saveConfig: (p) => saveConfig(p),
});
engine.on('log', (e) => {
  const mark = e.level === 'err' ? '✘' : e.level === 'warn' ? '!' : e.level === 'ok' ? '✔' : '·';
  console.log(`${mark} ${e.msg}`);
});

const st = await engine.status();
if (st.installed && !has('--force')) {
  console.log('✔ 引擎已安装：' + st.dir);
  console.log('  要重装请加 --force');
  if (!st.online && !has('--no-start')) {
    console.log('· 引擎未运行，正在启动…');
    await engine.start();
  }
  process.exit(0);
}

const models = has('--no-models') ? [] : (argOf('--models') || 'sd15').split(',').map((s) => s.trim()).filter(Boolean);
console.log('===== FREEART 引擎安装 =====');
console.log('目标目录：' + path.join(root, 'engine', 'ComfyUI'));
console.log('模型：' + (models.length ? models.join(', ') : '不装（稍后自己放）'));
console.log('');

engine.install({ models });
await engine.installTask.catch(() => {});

const after = await engine.status();
if (!after.installed) { console.log('\n✘ 安装未完成，可重跑本命令继续（已下载的部分会保留）'); process.exit(1); }
console.log('\n===== 安装完成 =====');
console.log('引擎目录：' + after.dir);
if (has('--no-start')) {
  console.log('运行 npm start 即可使用');
} else {
  await engine.start();
  console.log('打开 http://localhost:3000 开始用');
}
process.exit(0);
