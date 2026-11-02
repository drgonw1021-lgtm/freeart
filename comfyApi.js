// ComfyUI API 薄封装：探测、上传、执行、节点能力查询
import crypto from 'crypto';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { loadConfig } from './config.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const cfg = loadConfig();

export const COMFY_URL = (process.env.COMFY_URL || cfg.COMFY_URL || 'http://127.0.0.1:8188').replace(/\/+$/, '');
const CLIENT_ID = crypto.randomUUID();

export async function comfyCheck() {
  try {
    const r = await fetch(COMFY_URL + '/system_stats', { signal: AbortSignal.timeout(2500) });
    if (!r.ok) throw new Error(String(r.status));
    let checkpoints = [];
    try {
      const oi = await fetch(COMFY_URL + '/object_info/CheckpointLoaderSimple', { signal: AbortSignal.timeout(5000) });
      const j = await oi.json();
      checkpoints = j?.CheckpointLoaderSimple?.input?.required?.ckpt_name?.[0] || [];
    } catch (e) { /* 老版本无此节点也不影响 */ }
    return { online: true, checkpoints };
  } catch (e) {
    return { online: false, checkpoints: [] };
  }
}

export function comfyDataUrl(dataUrl) {
  const m = /^data:(image\/(png|jpeg|webp));base64,(.+)$/.exec(dataUrl || '');
  if (!m) throw new Error('图片格式不支持');
  return { buf: Buffer.from(m[3], 'base64'), mime: m[1] };
}

export async function comfyUpload(buf, mime, name) {
  const fd = new FormData();
  fd.append('image', new Blob([buf], { type: mime }), name);
  fd.append('overwrite', 'true');
  const r = await fetch(COMFY_URL + '/upload/image', { method: 'POST', body: fd, signal: AbortSignal.timeout(60000) });
  const j = await r.json();
  if (!j.name) throw new Error('ComfyUI 图片上传失败：' + JSON.stringify(j).slice(0, 120));
  return j;
}

export async function comfyRun(workflow) {
  const r = await fetch(COMFY_URL + '/prompt', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ prompt: workflow, client_id: CLIENT_ID }),
    signal: AbortSignal.timeout(30000),
  });
  const j = await r.json();
  if (j.error || !j.prompt_id) throw new Error('ComfyUI 拒绝工作流：' + JSON.stringify(j).slice(0, 200));
  const id = j.prompt_id;

  for (let i = 0; i < 600; i++) {
    await new Promise((res) => setTimeout(res, 1000));
    let entry;
    try {
      const h = await fetch(`${COMFY_URL}/history/${id}`, { signal: AbortSignal.timeout(10000) });
      entry = (await h.json())?.[id];
    } catch (e) { continue; }
    if (!entry) continue;
    if (entry.status?.status_str === 'error') throw new Error('ComfyUI 执行出错（检查模型/显存，4GB 显存建议加 --lowvram 启动）');
    const outs = entry.outputs || {};
    for (const nid of Object.keys(outs)) {
      const imgs = outs[nid]?.images;
      if (imgs?.length) {
        const im = imgs[0];
        const v = await fetch(
          `${COMFY_URL}/view?filename=${encodeURIComponent(im.filename)}&subfolder=${encodeURIComponent(im.subfolder || '')}&type=${im.type || 'output'}`,
          { signal: AbortSignal.timeout(60000) }
        );
        return { buffer: Buffer.from(await v.arrayBuffer()), mime: v.headers.get('content-type') || 'image/png' };
      }
    }
  }
  throw new Error('ComfyUI 生成超时（10 分钟）');
}

const oiCache = new Map();
/** 查询某个节点类型是否可用、可选模型有哪些（结果缓存 60s） */
export async function comfyObjectInfo(nodeType) {
  const hit = oiCache.get(nodeType);
  if (hit && Date.now() - hit.at < 60000) return hit.data;
  let data = null;
  try {
    const r = await fetch(`${COMFY_URL}/object_info/${nodeType}`, { signal: AbortSignal.timeout(5000) });
    const j = await r.json();
    data = j?.[nodeType] || null;
  } catch (e) { data = null; }
  oiCache.set(nodeType, { at: Date.now(), data });
  return data;
}

/** 取某个节点的某个枚举输入的可选值列表 */
export async function comfyEnum(nodeType, inputName) {
  const info = await comfyObjectInfo(nodeType);
  const req = info?.input?.required || {};
  const list = req[inputName]?.[0];
  return Array.isArray(list) ? list : [];
}

export const randName = () => crypto.randomBytes(6).toString('hex') + '.png';
export const DEFAULT_NEG = 'lowres, bad anatomy, blurry, watermark, text, deformed, ugly';
