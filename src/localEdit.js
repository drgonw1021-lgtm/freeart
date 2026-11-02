// 本地图像编辑流水线：所有操作都是 Canvas 像素运算，不调任何模型、不花钱、即时生效。
// 对标商业产品里"改图"功能不需要生成模型的那一半——这类活儿不该花 GPU 的钱。
import { resolveUrl } from './store.js';

const OPS = {
  warm:     { label: '暖色调', group: 'tone', filter: 'saturate(1.06) brightness(1.03)', overlay: { color: '#FF9A3C', alpha: 0.18, mode: 'overlay' } },
  cool:     { label: '冷色调', group: 'tone', filter: 'saturate(1.02) brightness(1.02)', overlay: { color: '#3C7CFF', alpha: 0.15, mode: 'overlay' } },
  gray:     { label: '黑白', group: 'tone', filter: 'grayscale(1) contrast(1.06)' },
  vintage:  { label: '复古胶片', group: 'tone', filter: 'sepia(0.5) contrast(1.06) saturate(0.92) brightness(1.04)', overlay: { color: '#F1DEB5', alpha: 0.12, mode: 'soft-light' } },

  bright:   { label: '提亮', group: 'light', filter: 'brightness(1.22)' },
  dark:     { label: '压暗', group: 'light', filter: 'brightness(0.82)' },

  contrast: { label: '增强对比', group: 'contrast', filter: 'contrast(1.24)' },
  flat:     { label: '降低对比', group: 'contrast', filter: 'contrast(0.84)' },

  vivid:    { label: '提高饱和', group: 'sat', filter: 'saturate(1.42)' },
  muted:    { label: '降低饱和', group: 'sat', filter: 'saturate(0.52)' },
  fade:     { label: '褪色', group: 'sat', filter: 'saturate(0.78) contrast(0.92) brightness(1.06)', overlay: { color: '#FFFFFF', alpha: 0.1, mode: 'overlay' } },

  blur:     { label: '柔焦虚化', group: 'effect', filter: 'blur(6px)', pad: true },
  soft:     { label: '柔光', group: 'effect', filter: 'brightness(1.06) saturate(1.05)', overlay: { color: '#FFF6E5', alpha: 0.1, mode: 'soft-light' } },

  crop1_1:  { label: '方形裁切', group: 'crop', crop: 1 },
  crop4_3:  { label: '4:3 裁切', group: 'crop', crop: 4 / 3 },
  crop3_4:  { label: '3:4 裁切', group: 'crop', crop: 3 / 4 },
  crop16_9: { label: '16:9 裁切', group: 'crop', crop: 16 / 9 },
  crop9_16: { label: '9:16 裁切', group: 'crop', crop: 9 / 16 },

  round:    { label: '圆角', group: 'shape', round: true },
  flipH:    { label: '水平镜像', group: 'shape', flip: 'h' },
  rotate90: { label: '旋转 90°', group: 'shape', rotate: 90 },

  // 扩图（outpaint 近似）：不裁内容，用边缘延展 + 羽化把画面撑成目标比例
  expand1_1:  { label: '扩成方形', group: 'crop', expand: 1 },
  expand4_3:  { label: '扩成 4:3', group: 'crop', expand: 4 / 3 },
  expand3_4:  { label: '扩成 3:4', group: 'crop', expand: 3 / 4 },
  expand16_9: { label: '扩成 16:9', group: 'crop', expand: 16 / 9 },
  expand9_16: { label: '扩成 9:16', group: 'crop', expand: 9 / 16 },

  // 品牌主色：色相替换（混合模式 color），由调用方传入具体颜色
  brandtint:  { label: '套用品牌主色', group: 'brand', brand: true },
};

// 关键词语序很重要：同组内先匹配到谁就用谁（如"降低饱和"不能命中 vivid）
const RULES = [
  { op: 'muted',    re: /降低.{0,4}饱和|低.{0,2}饱和|降饱和|莫兰迪|素一点|淡一点|寡淡|desaturate|muted/i },
  { op: 'vivid',    re: /鲜艳|饱和|浓郁|更艳|浓一点|vivid|saturat/i },
  { op: 'fade',     re: /褪色|发灰|老照片|fade/i },
  { op: 'flat',     re: /降低对比|对比弱|平一点|flat|low.?contrast/i },
  { op: 'contrast', re: /对比|冲击力|通透|contrast/i },
  { op: 'gray',     re: /黑白|灰度|去色|单色|grayscale|black.?and.?white|mono/i },
  { op: 'vintage',  re: /复古|胶片|怀旧|老电影|vintage|retro|film/i },
  { op: 'warm',     re: /暖|温馨|橙|阳光感|warm/i },
  { op: 'cool',     re: /冷|清冷|蓝调|cool/i },
  { op: 'bright',   re: /亮|提亮|明亮|曝光|bright/i },
  { op: 'dark',     re: /暗|压暗|昏|dark|dim/i },
  { op: 'blur',     re: /模糊|虚化|柔焦|朦胧|blur/i },
  { op: 'soft',     re: /柔光|柔化|光泽|soft/i },
  // 扩图规则必须在裁切之前：同属 crop 组，先匹配者生效（"扩成横版"不应走裁切）
  { op: 'expand1_1',  re: /扩.{0,3}方|补成方|扩展到方|方形.{0,3}(扩|补)|expand.*square/i },
  { op: 'expand16_9', re: /扩.{0,4}(横|宽|16:9)|补成横|加宽|横向延展|outpaint.*wide/i },
  { op: 'expand9_16', re: /扩.{0,4}(竖|高|9:16)|补成竖|加高|竖向延展|outpaint.*tall/i },
  { op: 'expand4_3',  re: /扩.{0,4}4:3|补成4:3|扩成4比3/i },
  { op: 'expand3_4',  re: /扩.{0,4}3:4|补成3:4|扩成3比4/i },
  { op: 'crop1_1',  re: /方图|方形|正方形|1:1|square/i },
  { op: 'crop16_9', re: /16:9|横版|宽幅|banner/i },
  { op: 'crop9_16', re: /9:16|竖版|竖图|story|手机壁纸/i },
  { op: 'crop4_3',  re: /4:3/i },
  { op: 'crop3_4',  re: /3:4/i },
  { op: 'brandtint', re: /品牌主?色|套用品牌|品牌色调|主色调|brand.?tint/i },
  { op: 'round',    re: /圆角|圆润|round/i },
  { op: 'flipH',    re: /镜像|翻转|左右互换|flip/i },
  { op: 'rotate90', re: /旋转|转90|横过来|竖过来|rotate/i },
];

// 这些词说明用户想"重画内容"，不是调色
const NEEDS_MODEL = /生成|画一|再做|重新做|新的一?张|换成|去掉|删掉|抠掉|重绘|redraw|replace|generate|design a/i;

export const CHIPS = [
  { op: 'warm', label: '暖一点' },
  { op: 'cool', label: '冷一点' },
  { op: 'bright', label: '亮一点' },
  { op: 'contrast', label: '更通透' },
  { op: 'gray', label: '转黑白' },
  { op: 'vintage', label: '胶片感' },
  { op: 'blur', label: '背景虚化' },
  { op: 'crop1_1', label: '切方形' },
  { op: 'expand16_9', label: '扩成横版' },
  { op: 'expand9_16', label: '扩成竖版' },
  { op: 'round', label: '加圆角' },
  { op: 'rotate90', label: '转 90°' },
];

export function parseInstruction(text) {
  const t = (text || '').trim();
  if (!t) return [];
  const used = new Set();
  const ops = [];
  for (const rule of RULES) {
    const def = OPS[rule.op];
    if (!def || used.has(def.group)) continue;
    if (rule.re.test(t)) {
      used.add(def.group);
      ops.push(rule.op);
    }
  }
  return ops;
}

export function looksLikeModelTask(text) {
  return NEEDS_MODEL.test(text || '');
}

export function opLabels(ops) {
  return ops.map((o) => OPS[o]?.label).filter(Boolean);
}

async function loadImage(url) {
  const src = await resolveUrl(url);
  return new Promise((resolve, reject) => {
    const img = new window.Image();
    img.crossOrigin = 'anonymous';
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error('图片加载失败'));
    img.src = src;
  });
}

// 检测是否存在透明像素（去背产物需要保留 alpha，输出 PNG）
function hasAlpha(img) {
  try {
    const c = document.createElement('canvas');
    c.width = 64; c.height = 64;
    const x = c.getContext('2d');
    x.drawImage(img, 0, 0, 64, 64);
    const d = x.getImageData(0, 0, 64, 64).data;
    for (let i = 3; i < d.length; i += 4) if (d[i] < 250) return true;
    return false;
  } catch (e) {
    return false;
  }
}

/**
 * 扩图：把画面撑成目标比例，原内容一像素不裁。
 * 做法：四周用原图边缘条带拉伸 + 模糊铺底（模拟内容延续），
 *      中间原图羽化叠回去 —— 视觉上接近 outpaint，但零模型、零成本。
 */
function renderExpand(img, iw, ih, defs, ratio) {
  const srcRatio = iw / ih;
  let outW, outH;
  if (srcRatio > ratio) { outW = iw; outH = Math.round(iw / ratio); }
  else { outH = ih; outW = Math.round(ih * ratio); }
  const k = Math.min(1, 1600 / Math.max(outW, outH));
  outW = Math.round(outW * k);
  outH = Math.round(outH * k);

  const canvas = document.createElement('canvas');
  canvas.width = outW;
  canvas.height = outH;
  const ctx = canvas.getContext('2d');

  const fk = Math.min(outW / iw, outH / ih);
  const fw = Math.round(iw * fk);
  const fh = Math.round(ih * fk);
  const dx = Math.round((outW - fw) / 2);
  const dy = Math.round((outH - fh) / 2);
  const ext = Math.max(outW, outH) * 0.35;
  const band = Math.max(1, Math.round(Math.min(iw, ih) * 0.06));

  // 背景：边缘条带向外拉伸 + 模糊，形成柔和的内容延续
  ctx.save();
  ctx.filter = 'blur(26px) saturate(1.04)';
  ctx.drawImage(img, 0, 0, band, ih, dx - ext, dy, ext + 2, fh);
  ctx.drawImage(img, iw - band, 0, band, ih, dx + fw - 2, dy, ext + 2, fh);
  ctx.drawImage(img, 0, 0, iw, band, dx, dy - ext, fw, ext + 2);
  ctx.drawImage(img, 0, ih - band, iw, band, dx, dy + fh - 2, fw, ext + 2);
  // 四角用角落块撑开
  ctx.drawImage(img, 0, 0, band, band, dx - ext, dy - ext, ext + 2, ext + 2);
  ctx.drawImage(img, iw - band, 0, band, band, dx + fw - 2, dy - ext, ext + 2, ext + 2);
  ctx.drawImage(img, 0, ih - band, band, band, dx - ext, dy + fh - 2, ext + 2, ext + 2);
  ctx.drawImage(img, iw - band, ih - band, band, band, dx + fw - 2, dy + fh - 2, ext + 2, ext + 2);
  ctx.drawImage(img, 0, 0, iw, ih, dx, dy, fw, fh);
  ctx.restore();

  // 前景：原图居中，边缘羽化融进背景
  const tmp = document.createElement('canvas');
  tmp.width = outW;
  tmp.height = outH;
  const tx = tmp.getContext('2d');
  tx.drawImage(img, 0, 0, iw, ih, dx, dy, fw, fh);
  tx.globalCompositeOperation = 'destination-out';
  const f = Math.max(2, Math.round(Math.min(fw, fh) * 0.045));
  const grads = [
    [dx, dy, dx + f, dy],                       // 左
    [dx + fw, dy, dx + fw - f, dy],             // 右
    [dx, dy, dx, dy + f],                       // 上
    [dx, dy + fh, dx, dy + fh - f],             // 下
  ];
  for (const [x1, y1, x2, y2] of grads) {
    const g = tx.createLinearGradient(x1, y1, x2, y2);
    g.addColorStop(0, 'rgba(0,0,0,0.85)');
    g.addColorStop(1, 'rgba(0,0,0,0)');
    tx.fillStyle = g;
    tx.fillRect(dx, dy, Math.max(0, fw), Math.max(0, fh));
  }
  tx.globalCompositeOperation = 'source-over';
  ctx.drawImage(tmp, 0, 0);

  return { canvas, outW, outH };
}

/**
 * 对图片执行一组本地操作，返回 dataURL。
 * extra: { brandColor } —— 品牌主色（用于 brandtint）
 */
export async function applyOps(url, ops, extra = {}) {
  const defs = ops
    .map((o) => {
      const base = OPS[o];
      if (!base) return null;
      if (base.brand) {
        return {
          ...base,
          filter: 'saturate(0.92)',
          overlay: { color: extra.brandColor || '#534AB7', alpha: extra.brandStrength ?? 0.3, mode: 'color' },
        };
      }
      return base;
    })
    .filter(Boolean);
  if (!defs.length) throw new Error('没有可执行的本地操作');

  const img = await loadImage(url);
  const iw = img.naturalWidth || img.width;
  const ih = img.naturalHeight || img.height;

  // 0) 扩图分支：独立绘制路径
  const expandDef = defs.find((d) => d.expand);
  if (expandDef) {
    const { canvas } = renderExpand(img, iw, ih, defs, expandDef.expand);
    for (const d of defs) {
      if (!d.overlay) continue;
      const c2 = canvas.getContext('2d');
      c2.save();
      c2.globalCompositeOperation = d.overlay.mode;
      c2.globalAlpha = d.overlay.alpha;
      c2.fillStyle = d.overlay.color;
      c2.fillRect(0, 0, canvas.width, canvas.height);
      c2.restore();
    }
    return { dataUrl: canvas.toDataURL('image/jpeg', 0.93), width: canvas.width, height: canvas.height };
  }

  // 1) 裁切框（源图坐标）
  const cropDef = defs.find((d) => d.crop);
  let srcW = iw;
  let srcH = ih;
  if (cropDef) {
    const r = cropDef.crop;
    if (iw / ih > r) srcW = Math.round(ih * r);
    else srcH = Math.round(iw / r);
  }
  const srcX = Math.round((iw - srcW) / 2);
  const srcY = Math.round((ih - srcH) / 2);

  // 2) 旋转后尺寸
  const rotate = defs.find((d) => d.rotate)?.rotate || 0;
  const swapped = rotate % 180 !== 0;
  let outW = swapped ? srcH : srcW;
  let outH = swapped ? srcW : srcH;

  // 3) 输出尺寸上限（控体积，1600px 足够导出用）
  const k = Math.min(1, 1600 / Math.max(outW, outH));
  outW = Math.round(outW * k);
  outH = Math.round(outH * k);

  const canvas = document.createElement('canvas');
  canvas.width = outW;
  canvas.height = outH;
  const ctx = canvas.getContext('2d');

  const needRound = defs.some((d) => d.round);
  if (needRound) {
    const rad = Math.min(outW, outH) * 0.12;
    ctx.save();
    ctx.beginPath();
    const x0 = 0, y0 = 0, w0 = outW, h0 = outH, r = rad;
    ctx.moveTo(x0 + r, y0);
    ctx.arcTo(x0 + w0, y0, x0 + w0, y0 + h0, r);
    ctx.arcTo(x0 + w0, y0 + h0, x0, y0 + h0, r);
    ctx.arcTo(x0, y0 + h0, x0, y0, r);
    ctx.arcTo(x0, y0, x0 + w0, y0, r);
    ctx.closePath();
    ctx.clip();
  }

  const filterStr = defs.map((d) => d.filter).filter(Boolean).join(' ') || 'none';
  const flip = defs.some((d) => d.flip === 'h');
  const pad = defs.some((d) => d.pad);

  ctx.save();
  ctx.translate(outW / 2, outH / 2);
  if (rotate) ctx.rotate((rotate * Math.PI) / 180);
  if (flip) ctx.scale(-1, 1);
  // 模糊会产生透明边缘，稍微放大覆盖掉
  const dw = (swapped ? srcH : srcW) * k * (pad ? 1.12 : 1);
  const dh = (swapped ? srcW : srcH) * k * (pad ? 1.12 : 1);
  ctx.filter = filterStr;
  ctx.drawImage(img, srcX, srcY, srcW, srcH, -dw / 2, -dh / 2, dw, dh);
  ctx.restore();
  if (needRound) ctx.restore();

  // 4) 叠加色调层
  for (const d of defs) {
    if (!d.overlay) continue;
    ctx.save();
    ctx.globalCompositeOperation = d.overlay.mode;
    ctx.globalAlpha = d.overlay.alpha;
    ctx.fillStyle = d.overlay.color;
    ctx.fillRect(0, 0, outW, outH);
    ctx.restore();
  }

  const keepAlpha = needRound || hasAlpha(img);
  const mime = keepAlpha ? 'image/png' : 'image/jpeg';
  return { dataUrl: canvas.toDataURL(mime, 0.92), width: outW, height: outH };
}

function roundRectPath(ctx, x, y, w, h, r) {
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + w, y, x + w, y + h, r);
  ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.arcTo(x, y + h, x, y, r);
  ctx.arcTo(x, y, x + w, y, r);
  ctx.closePath();
}

/**
 * 生成品牌色板卡（提案用）：品牌名 + 色板 + 字体样张，纯 Canvas 绘制。
 */
export async function buildBrandCard(brand) {
  const W = 1400;
  const H = 920;
  const c = document.createElement('canvas');
  c.width = W;
  c.height = H;
  const x = c.getContext('2d');
  const colors = (brand.colors && brand.colors.length ? brand.colors : ['#534AB7']).slice(0, 6);
  const font = brand.font || 'system-ui, sans-serif';

  x.fillStyle = '#FAF9F4';
  x.fillRect(0, 0, W, H);

  const bw = W / colors.length;
  colors.forEach((col, i) => {
    x.fillStyle = col;
    x.fillRect(i * bw, 0, bw, 14);
  });

  const pad = 90;
  x.textBaseline = 'top';
  x.fillStyle = '#1A1A18';
  x.font = `600 76px ${font}`;
  x.fillText(brand.name || 'My Brand', pad, 96);

  x.fillStyle = '#8A8778';
  x.font = `500 22px ${font}`;
  x.fillText('BRAND KIT  ·  COLOR & TYPE', pad, 196);

  const sw = 168;
  const gap = 26;
  const y0 = 286;
  colors.forEach((col, i) => {
    const sx = pad + i * (sw + gap);
    roundRectPath(x, sx, y0, sw, sw, 18);
    x.fillStyle = col;
    x.fill();
    x.fillStyle = '#5F5E5A';
    x.font = '500 20px monospace';
    x.fillText(col.toUpperCase(), sx, y0 + sw + 16);
  });

  x.fillStyle = '#1A1A18';
  x.font = `600 52px ${font}`;
  x.fillText('品牌字体 Aa 字体样张', pad, y0 + sw + 78);
  x.fillStyle = '#5F5E5A';
  x.font = `400 28px ${font}`;
  x.fillText('The quick brown fox jumps over the lazy dog  0123456789', pad, y0 + sw + 152);

  x.strokeStyle = '#E3E1D9';
  x.lineWidth = 2;
  x.beginPath();
  x.moveTo(pad, H - 80);
  x.lineTo(W - pad, H - 80);
  x.stroke();

  return c.toDataURL('image/png');
}

// ---------- 手绘/蒙版栅格化（Krita 式"边画边生成"的输入侧） ----------

function drawStrokes(ctx, strokes, ox, oy, bg) {
  if (bg) { ctx.fillStyle = bg; ctx.fillRect(0, 0, ctx.canvas.width, ctx.canvas.height); }
  ctx.lineCap = 'round';
  ctx.lineJoin = 'round';
  for (const s of strokes) {
    ctx.save();
    ctx.translate(ox, oy);
    if (s.eraser) ctx.globalCompositeOperation = 'destination-out';
    ctx.strokeStyle = s.color;
    ctx.fillStyle = s.color;
    ctx.lineWidth = s.size;
    const p = s.points;
    if (p.length < 4) {
      ctx.beginPath();
      ctx.arc(p[0], p[1], s.size / 2, 0, Math.PI * 2);
      ctx.fill();
      ctx.restore();
      continue;
    }
    ctx.beginPath();
    ctx.moveTo(p[0], p[1]);
    for (let i = 2; i < p.length - 2; i += 2) {
      ctx.quadraticCurveTo(p[i], p[i + 1], (p[i] + p[i + 2]) / 2, (p[i + 1] + p[i + 3]) / 2);
    }
    ctx.lineTo(p[p.length - 2], p[p.length - 1]);
    ctx.stroke();
    ctx.restore();
  }
}

/** 把一组世界坐标笔迹栅格化为透明 PNG 图层，返回 {dataUrl,x,y,width,height} 或 null */
export function rasterizeStrokes(strokes, padExtra = 0) {
  const pts = [];
  for (const s of strokes) {
    for (let i = 0; i < s.points.length; i += 2) pts.push([s.points[i], s.points[i + 1]]);
  }
  if (!pts.length) return null;
  let bx = Infinity, by = Infinity, rx = -Infinity, ry = -Infinity;
  for (const [x, y] of pts) {
    if (x < bx) bx = x; if (y < by) by = y;
    if (x > rx) rx = x; if (y > ry) ry = y;
  }
  const maxBrush = Math.max(padExtra, ...strokes.map((s) => s.size || 4));
  const pad = maxBrush + 6;
  bx -= pad; by -= pad; rx += pad; ry += pad;
  const w = Math.ceil(rx - bx);
  const h = Math.ceil(ry - by);
  if (w <= 0 || h <= 0) return null;
  const c = document.createElement('canvas');
  c.width = w; c.height = h;
  drawStrokes(c.getContext('2d'), strokes, -bx, -by);
  return { dataUrl: c.toDataURL('image/png'), x: bx, y: by, width: w, height: h };
}

/** 把蒙版笔迹映射到原图像素坐标，输出黑白蒙版 PNG（白=重画区域） */
export function rasterizeMask(strokes, rect, natW, natH) {
  const c = document.createElement('canvas');
  c.width = natW; c.height = natH;
  const ctx = c.getContext('2d');
  ctx.fillStyle = '#000';
  ctx.fillRect(0, 0, natW, natH);
  const scale = natW / rect.width;
  const mapped = strokes.map((s) => ({
    ...s,
    eraser: false,
    color: '#FFFFFF',
    size: s.size * scale,
    points: s.points.map((v, i) => (i % 2 === 0 ? (v - rect.x) * scale : (v - rect.y) * scale)),
  }));
  drawStrokes(ctx, mapped, 0, 0);
  return { dataUrl: c.toDataURL('image/png'), width: natW, height: natH };
}
