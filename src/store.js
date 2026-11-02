// 图片本地存储：导入的图、去背结果、本地改图结果都存进浏览器 IndexedDB，
// 不经过服务器上传——导入即时完成，也不再受部署环境网络延迟影响。
// 节点里存 "idb:<key>"，渲染时解析成 blob URL（带缓存）。
import { withShare } from './api.js';

const DB_NAME = 'freeart-images';
const STORE = 'img';
const VERSION = 1;

let dbPromise = null;
function getDB() {
  if (!dbPromise) {
    dbPromise = new Promise((resolve, reject) => {
      const req = indexedDB.open(DB_NAME, VERSION);
      req.onupgradeneeded = () => {
        const d = req.result;
        if (!d.objectStoreNames.contains(STORE)) d.createObjectStore(STORE);
      };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error || new Error('IndexedDB 打开失败'));
    });
  }
  return dbPromise;
}

export function isLocalRef(url) {
  return typeof url === 'string' && url.startsWith('idb:');
}

export async function putImageBlob(blob) {
  const key = 'i' + Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
  const db = await getDB();
  await new Promise((resolve, reject) => {
    const tx = db.transaction(STORE, 'readwrite');
    tx.objectStore(STORE).put(blob, key);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error || new Error('本地保存失败'));
  });
  return 'idb:' + key;
}

export async function dataUrlToBlob(dataUrl) {
  const res = await fetch(dataUrl);
  return res.blob();
}

const urlCache = new Map();

export async function resolveUrl(url) {
  if (!url) return url;
  if (!isLocalRef(url)) return withShare(url);
  if (urlCache.has(url)) return urlCache.get(url);
  const key = url.slice(4);
  const db = await getDB();
  const blob = await new Promise((resolve, reject) => {
    const tx = db.transaction(STORE, 'readonly');
    const rq = tx.objectStore(STORE).get(key);
    rq.onsuccess = () => resolve(rq.result);
    rq.onerror = () => reject(rq.error);
  });
  if (!blob) throw new Error('本地图片已丢失（可能清理过浏览器缓存）');
  const objUrl = URL.createObjectURL(blob);
  urlCache.set(url, objUrl);
  return objUrl;
}
