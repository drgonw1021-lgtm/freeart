// 统一配置入口：优先读 config.json，没有则退回 config.example.json（仓库里那份）
// config.json 本身不进版本库，方便各自保存自己的路径和密钥
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const FILE = path.join(__dirname, 'config.json');
const EXAMPLE = path.join(__dirname, 'config.example.json');

const DEFAULTS = {
  IMAGE_PROVIDER: 'auto',
  FAL_KEY: '',
  ZHIPU_KEY: '',
  COMFY_PATH: '',
  COMFY_URL: 'http://127.0.0.1:8188',
  COMFY_ARGS: [],
  ENGINE_AUTOSTART: true,
};

let cache = null;

export function loadConfig() {
  if (cache) return cache;
  let raw = {};
  try { raw = JSON.parse(fs.readFileSync(FILE, 'utf-8')); } catch (e) {
    try { raw = JSON.parse(fs.readFileSync(EXAMPLE, 'utf-8')); } catch (e2) { /* 用默认值 */ }
  }
  cache = { ...DEFAULTS, ...raw, COMFY_ARGS: raw.COMFY_ARGS || [] };
  return cache;
}

export function saveConfig(patch) {
  const cfg = loadConfig();
  Object.assign(cfg, patch);
  try {
    fs.writeFileSync(FILE, JSON.stringify(cfg, null, 2));
  } catch (e) { /* 只读环境也能继续跑 */ }
  return cfg;
}

export { DEFAULTS };
