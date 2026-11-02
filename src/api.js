// 线上部署时，平台网关心跳对 /api 和 /files 的访问要求携带 sharecode。
// 这里统一把它附加到所有请求和图片地址上（本地开发没有 sharecode，自动跳过）。
export const SHARECODE = (() => {
  try {
    return new URLSearchParams(window.location.search).get('sharecode') || '';
  } catch (e) {
    return '';
  }
})();

export function withShare(url) {
  if (!url || typeof url !== 'string') return url;
  if (/^(https?:|data:|blob:)/i.test(url)) return url;
  if (!SHARECODE) return url;
  const sep = url.includes('?') ? '&' : '?';
  return `${url}${sep}sharecode=${encodeURIComponent(SHARECODE)}`;
}

export function api(path, opts) {
  return fetch(withShare(path), opts);
}
