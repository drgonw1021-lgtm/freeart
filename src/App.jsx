import React, { useState, useEffect, useRef, useCallback } from 'react';
import Canvas from './Canvas.jsx';
import { api } from './api.js';
import { putImageBlob, resolveUrl, dataUrlToBlob } from './store.js';
import { applyOps, parseInstruction, opLabels, looksLikeModelTask, CHIPS, buildBrandCard, rasterizeStrokes, rasterizeMask } from './localEdit.js';

const STORAGE_KEY = 'freeart-nodes-v1';
const BRAND_KEY = 'freeart-brand-v1';
const MYSKILL_KEY = 'freeart-skills-v1';

// 早期版本（Lovart Lite）的本地数据搬到新名字下，升级不丢画布
function migrateStorage() {
  const pairs = [
    ['lovart-lite-nodes-v1', STORAGE_KEY],
    ['lovart-lite-nodes-v1-history', STORAGE_KEY + '-history'],
    ['lovart-lite-brand-v1', BRAND_KEY],
    ['lovart-lite-skills-v1', MYSKILL_KEY],
  ];
  for (const [from, to] of pairs) {
    try {
      const v = localStorage.getItem(from);
      if (v && !localStorage.getItem(to)) {
        localStorage.setItem(to, v);
        localStorage.removeItem(from);
      }
    } catch (e) { /* 隐私模式等场景忽略 */ }
  }
}
const FONTS = [
  { label: '系统黑体', value: 'system-ui, "Microsoft YaHei", sans-serif' },
  { label: '思源黑体', value: '"Source Han Sans SC", "Noto Sans SC", sans-serif' },
  { label: '宋体', value: '"SimSun", "Songti SC", serif' },
  { label: '楷体', value: '"KaiTi", "STKaiti", serif' },
  { label: '等宽', value: 'ui-monospace, "Cascadia Mono", monospace' },
];
const DEFAULT_BRAND = {
  name: '我的品牌',
  colors: ['#534AB7', '#F1EFE8', '#2C2C2A', '#E9C46A', '#2A9D8F'],
  font: 'system-ui, "Microsoft YaHei", sans-serif',
};
const ASPECTS = [
  { id: '1:1', label: '1:1' },
  { id: '4:3', label: '4:3' },
  { id: '3:4', label: '3:4' },
  { id: '16:9', label: '16:9' },
];

const SKILLS = [
  { id: 'logo', label: 'Logo', prompt: 'minimalist logo for a brand, flat vector, clean lines, cream background, centered, high contrast' },
  { id: 'poster', label: '海报', prompt: 'bold promotional poster design, strong visual hierarchy, large headline space, modern typography, high contrast' },
  { id: 'social', label: '社媒图', prompt: 'instagram post design, lifestyle photography style, soft natural light, minimal layout, generous negative space' },
  { id: 'product', label: '电商主图', prompt: 'clean e-commerce product shot on white background, studio lighting, sharp focus, subtle shadow, centered' },
  { id: 'illus', label: '插画', prompt: 'flat editorial illustration, limited color palette, geometric shapes, textured grain, no text' },
  { id: 'brand', label: '品牌视觉', prompt: 'premium brand identity visual, elegant composition, muted color palette, refined typography, print-ready' },
];

const paramText = (s) => {
  const p = s.params || {};
  const bits = [];
  if (p.denoise !== undefined) bits.push('强度 ' + p.denoise);
  if (p.scale !== undefined) bits.push(p.scale + '×');
  if (p.left !== undefined) bits.push(`外扩 ${p.left}/${p.right}/${p.top}/${p.bottom}`);
  return bits.join(' · ');
};

const nextPos = (counter) => ({
  x: window.innerWidth / 2 - 160 + (counter % 4) * 340,
  y: window.innerHeight / 2 - 200 + Math.floor((counter % 8) / 4) * 340,
});

const cardStyle = {
  background: '#fff', borderRadius: 12, boxShadow: '0 1px 4px rgba(0,0,0,0.08)',
  padding: 12, fontSize: 12,
};
const inputStyle = {
  width: '100%', boxSizing: 'border-box', fontSize: 12, padding: '7px 9px',
  border: '1px solid #E3E1D9', borderRadius: 8, outline: 'none', background: '#fff',
};
const fmtBytes = (n) => (!n ? '0 B'
  : n >= 1073741824 ? (n / 1073741824).toFixed(1) + ' GB'
    : Math.round(n / 1048576) + ' MB');

const btnStyle = (bg, color) => ({
  padding: '7px 10px', background: bg, color, borderRadius: 8,
  cursor: 'pointer', textAlign: 'center', marginBottom: 6,
});

export default function App() {
  const [nodes, setNodes] = useState([]);
  const [selectedId, setSelectedId] = useState(null);
  const [prompt, setPrompt] = useState('');
  const [loading, setLoading] = useState(false);
  const [elapsed, setElapsed] = useState(0);
  const [busy, setBusy] = useState('');
  const [history, setHistory] = useState([]);
  const [error, setError] = useState('');
  const [health, setHealth] = useState(null);
  const [aspect, setAspect] = useState('1:1');
  const [skill, setSkill] = useState(null);
  const [notice, setNotice] = useState('');
  const [editCmd, setEditCmd] = useState('');
  const [brand, setBrand] = useState(DEFAULT_BRAND);
  const [brandOpen, setBrandOpen] = useState(false);
  const [mySkills, setMySkills] = useState([]);
  const [isMobile, setIsMobile] = useState(window.innerWidth < 640);
  // 手绘模式（Krita 式边画边生成）
  const [drawing, setDrawing] = useState(false);
  const [brushColor, setBrushColor] = useState('#2C2C2A');
  const [brushSize, setBrushSize] = useState(6);
  const [eraser, setEraser] = useState(false);
  const [strokes, setStrokes] = useState([]);
  const [maskMode, setMaskMode] = useState(false);
  // 本地引擎（内置 ComfyUI）
  const [engine, setEngine] = useState(null);
  const [engineOpen, setEngineOpen] = useState(false);
  const [selModels, setSelModels] = useState(['sd15']);
  const [comfy, setComfy] = useState(null);
  const [comfyCkpt, setComfyCkpt] = useState('');
  const [refPrompt, setRefPrompt] = useState('');
  const [denoise, setDenoise] = useState(0.65);
  // 随心改：说出效果 → AI 自动搭工作流
  const [planCmd, setPlanCmd] = useState('');
  const [planResult, setPlanResult] = useState(null);
  const [planBusy, setPlanBusy] = useState(false);
  const [pendingPlan, setPendingPlan] = useState(null);
  const counter = useRef(0);
  const fileRef = useRef(null);

  useEffect(() => {
    const onResize = () => setIsMobile(window.innerWidth < 640);
    window.addEventListener('resize', onResize);
    return () => window.removeEventListener('resize', onResize);
  }, []);

  useEffect(() => {
    migrateStorage();
    try {
      const saved = JSON.parse(localStorage.getItem(STORAGE_KEY) || '[]');
      setNodes(saved.filter((n) => n.url || n.type === 'text'));
      setHistory(JSON.parse(localStorage.getItem(STORAGE_KEY + '-history') || '[]'));
      const b = JSON.parse(localStorage.getItem(BRAND_KEY) || 'null');
      if (b && Array.isArray(b.colors)) setBrand({ ...DEFAULT_BRAND, ...b });
      const s = JSON.parse(localStorage.getItem(MYSKILL_KEY) || '[]');
      if (Array.isArray(s)) setMySkills(s);
    } catch (e) { /* ignore */ }
    api('/api/health').then((r) => r.json()).then(setHealth).catch(() => {});
    api('/api/engine/status').then((r) => r.json()).then(setEngine).catch(() => {});
  }, []);

  const saveBrand = (next) => {
    setBrand(next);
    localStorage.setItem(BRAND_KEY, JSON.stringify(next));
  };

  const saveMySkills = (next) => {
    setMySkills(next);
    localStorage.setItem(MYSKILL_KEY, JSON.stringify(next));
  };

  // ---- 本地引擎探测 ----
  const checkComfy = useCallback(async () => {
    try {
      const r = await api('/api/comfy/status');
      const j = await r.json();
      setComfy(j);
      setComfyCkpt((prev) => prev || (j.checkpoints && j.checkpoints[0]) || '');
    } catch (e) {
      setComfy({ online: false, checkpoints: [] });
    }
  }, []);

  useEffect(() => { checkComfy(); }, [checkComfy]);

  // ---- 手绘会话 ----
  const toggleDraw = () => {
    if (drawing && strokes.length) {
      if (!confirm('放弃当前未保存的笔迹？')) return;
    }
    setStrokes([]);
    setMaskMode(false);
    setEraser(false);
    setDrawing((v) => !v);
  };

  const handleStrokeEnd = (s) => setStrokes((st) => [...st, s]);

  const finishSketch = async () => {
    const out = rasterizeStrokes(strokes);
    setStrokes([]);
    setDrawing(false);
    if (!out) return;
    setBusy('生成草图图层…');
    try {
      const key = await putImageBlob(await dataUrlToBlob(out.dataUrl));
      if (!key) throw new Error('保存失败');
      pushNodes([addImageNode(key, { x: out.x, y: out.y, width: out.width, height: out.height, derived: '手绘' })]);
      setNotice('草图已转为图层，选中它可「以图生图」');
    } catch (err) {
      setError('保存草图失败：' + err.message);
    } finally {
      setBusy('');
    }
  };

  const nodeToDataUrl = async (node) => {
    const src = await resolveUrl(node.url);
    const blob = await fetch(src).then((r) => r.blob());
    return new Promise((res) => {
      const fr = new FileReader();
      fr.onload = () => res(fr.result);
      fr.readAsDataURL(blob);
    });
  };

  // ---- ComfyUI 统一执行入口：多步计划 / 单步图生图 / 蒙版重绘 都走这里 ----
  const buildMaskData = async (node) => {
    const src = await resolveUrl(node.url);
    const nat = await new Promise((res, rej) => {
      const el = new window.Image();
      el.onload = () => res({ w: el.naturalWidth, h: el.naturalHeight });
      el.onerror = () => rej(new Error('读取原图尺寸失败'));
      el.src = src;
    });
    return rasterizeMask(strokes, { x: node.x, y: node.y, width: node.width, height: node.height }, nat.w, nat.h);
  };

  const executeComfyPlan = async (node, plan, maskDataUrl) => {
    if (!comfy?.online) {
      setError('本地引擎没在运行。打开顶栏「引擎」装一下并启动即可。');
      return;
    }
    if (!node) return;
    setError('');
    setBusy(`执行中（${plan.steps.length} 步）…`);
    try {
      const initImage = await nodeToDataUrl(node);
      const res = await api('/api/comfy/run-plan', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          steps: plan.steps,
          prompt: plan.prompt,
          initImage,
          mask: maskDataUrl,
          ckpt: comfyCkpt || undefined,
          upscaleModel: (comfy?.upscaleModels || [])[0],
        }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || '执行失败');
      const outs = (data.results || []).filter((r) => r.dataUrl);
      for (const r of (data.results || [])) {
        if (r.handledByFrontend) await removeBg(node);
      }
      if (!outs.length) {
        setNotice('已执行（结果由本地模型直接在画布生成）');
      } else {
        const last = outs[outs.length - 1];
        const key = await putImageBlob(await dataUrlToBlob(last.dataUrl));
        if (!key) throw new Error('保存失败');
        pushNodes([addImageNode(key, {
          x: node.x + 28, y: node.y + 28,
          width: node.width, height: node.height,
          prompt: plan.prompt,
          derived: plan.steps.map((s) => s.label).join(' → '),
        })]);
        setNotice(`${plan.steps.map((s) => s.label).join(' → ')} 完成`);
      }
    } catch (err) {
      setError('执行失败：' + err.message);
    } finally {
      setBusy('');
      setStrokes([]);
      setMaskMode(false);
      setDrawing(false);
      setPendingPlan(null);
    }
  };

  // ---- ComfyUI 以图生图：草图/任意图片当底图 ----
  const runImg2Img = async (node, dn) => {
    if (!refPrompt.trim()) {
      setError('先在下方写一句提示词，描述基于这张图要生成什么');
      return;
    }
    await executeComfyPlan(node, {
      steps: [{ cap: 'img2img', label: '以图生图', params: { denoise: dn ?? denoise } }],
      prompt: refPrompt.trim(),
    });
  };

  // ---- 蒙版模式：先涂区域，再执行 ----
  const startMask = (plan = null) => {
    if (!refPrompt.trim() && !plan?.prompt) {
      setError('先写提示词：蒙版里要重画成什么');
      return;
    }
    setPendingPlan(plan);
    setMaskMode(true);
    setEraser(false);
    setDrawing(true);
    setNotice('在图上涂抹要重画的区域，然后点「开始重绘」');
  };

  const runMaskPlan = async (node) => {
    if (!strokes.length) {
      setError('还没涂抹。在图上涂出要重画的区域再点开始。');
      return;
    }
    setBusy('准备蒙版…');
    try {
      const mask = await buildMaskData(node);
      const plan = pendingPlan || {
        steps: [{ cap: 'inpaint', label: '局部重绘', params: {} }],
        prompt: refPrompt.trim(),
      };
      await executeComfyPlan(node, plan, mask.dataUrl);
    } catch (err) {
      setError('蒙版处理失败：' + err.message);
      setBusy('');
      setStrokes([]);
      setMaskMode(false);
      setDrawing(false);
    }
  };

  // ---- 随心改：说出效果 → AI 自动搭工作流 ----
  const askPlan = async () => {
    if (!planCmd.trim()) return;
    setPlanBusy(true);
    setError('');
    try {
      const res = await api('/api/comfy/plan', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          instruction: planCmd.trim(),
          ctx: { hasImage: !!selected, hasMask: strokes.length > 0, width: selected?.width, height: selected?.height },
        }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || '规划失败');
      setPlanResult(data);
    } catch (err) {
      setError('AI 拆解失败：' + err.message);
    } finally {
      setPlanBusy(false);
    }
  };

  const runPlan = async () => {
    if (!planResult) return;
    const needsMask = planResult.steps.some((s) => s.cap === 'inpaint');
    if (needsMask && !strokes.length) {
      await startMask(planResult);
      return;
    }
    let maskDataUrl;
    if (needsMask && strokes.length) maskDataUrl = (await buildMaskData(selected)).dataUrl;
    await executeComfyPlan(selected, planResult, maskDataUrl);
    setPlanResult(null);
    setPlanCmd('');
  };

  const drawProps = drawing
    ? {
        color: maskMode ? '#FFFFFF' : brushColor,
        eraser: !maskMode && eraser,
        size: eraser ? brushSize * 2.2 : brushSize,
      }
    : null;

  useEffect(() => {
    if (!loading) return;
    const t0 = Date.now();
    setElapsed(0);
    const timer = setInterval(() => setElapsed(Math.round((Date.now() - t0) / 1000)), 500);
    return () => clearInterval(timer);
  }, [loading]);

  useEffect(() => {
    if (!notice) return;
    const t = setTimeout(() => setNotice(''), 2600);
    return () => clearTimeout(t);
  }, [notice]);

  const persist = useCallback((nextNodes, nextHistory) => {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(nextNodes));
    localStorage.setItem(STORAGE_KEY + '-history', JSON.stringify(nextHistory || history));
  }, [history]);

  const addImageNode = (url, extra = {}) => {
    const pos = nextPos(counter.current);
    counter.current += 1;
    return {
      id: 'n' + Date.now() + Math.random().toString(16).slice(2, 6),
      type: 'image',
      url,
      x: extra.x ?? pos.x,
      y: extra.y ?? pos.y,
      ...extra,
    };
  };

  const pushNodes = (newNodes) => {
    setNodes((ns) => {
      const next = [...ns, ...newNodes];
      persist(next);
      return next;
    });
  };

  const handleGenerate = async () => {
    const typed = prompt.trim();
    if (loading || busy) return;

    // 先判断：这是"改这张图"的指令，还是"画一张新图"？
    if (typed && !loading && !looksLikeModelTask(typed)) {
      const target = nodes.find((n) => n.id === selectedId && n.type === 'image');
      if (target) {
        const ops = parseInstruction(typed);
        if (ops.length) {
          setPrompt('');
          await runLocalEdit(target, ops);
          return;
        }
        setError('这句话本地改不了（涉及重画内容）。要画新内容，请把「生成」换成描述性提示词，或输入含"生成/换成"的说法走模型。');
        return;
      }
    }

    const base = skill ? SKILLS.find((s) => s.id === skill)?.prompt || '' : '';
    const finalPrompt = typed ? (base ? `${typed}, ${base}` : typed) : base;
    if (!finalPrompt) return;
    setLoading(true);
    setError('');
    try {
      const res = await api('/api/generate', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ prompt: finalPrompt, aspect }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || '生成失败');
      const genNodes = data.images.map((img) =>
        addImageNode(img.url, { width: img.width, height: img.height, prompt: finalPrompt })
      );
      pushNodes(genNodes);
      setHistory((h) => {
        const next = [{ prompt: finalPrompt, time: Date.now() }, ...h].slice(0, 60);
        localStorage.setItem(STORAGE_KEY + '-history', JSON.stringify(next));
        return next;
      });
      setPrompt('');
    } catch (err) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
  };

  // 用选中图片的 prompt 再生成一张（变体）
  const regenerate = async (node) => {
    if (loading || !node.prompt) return;
    setLoading(true);
    setError('');
    try {
      const res = await api('/api/generate', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ prompt: node.prompt, aspect }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || '生成失败');
      pushNodes(data.images.map((img) => addImageNode(img.url, { width: img.width, height: img.height, prompt: node.prompt })));
    } catch (err) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
  };

  // ---- 导入本地图片（存浏览器本地，不上传、瞬时完成） ----
  const importFiles = async (files) => {
    if (!files.length) return;
    setError('');
    setBusy('导入中…');
    const failed = [];
    for (const file of files) {
      try {
        if (file.size > 40 * 1024 * 1024) {
          failed.push(`${file.name}（超过 40MB）`);
          continue;
        }
        if (!/^image\//.test(file.type)) {
          failed.push(`${file.name}（不是图片格式）`);
          continue;
        }
        const key = await putImageBlob(file);
        pushNodes([addImageNode(key)]);
      } catch (err) {
        failed.push(`${file.name}（${err.message}）`);
      }
    }
    setBusy('');
    if (failed.length) setError('这些图片导入失败：' + failed.join('、'));
  };

  // ---- 一键去背（浏览器本地模型，零成本） ----
  const removeBg = async (node) => {
    if (busy) return;
    setError('');
    try {
      setBusy('正在加载去背模型（首次约 30-60 秒）…');
      const { removeBackground } = await import('@imgly/background-removal');
      const src = await resolveUrl(node.url);
      // small 模型体积减半（44MB vs 88MB），弱网更稳；失败自动重试一次
      const once = () => removeBackground(src, {
        model: 'small',
        output: { format: 'image/png' },
        progress: (key, current, total) => {
          if (total) setBusy(`去背中 ${Math.round((current / total) * 100)}%`);
        },
      });
      let blob;
      try {
        blob = await once();
      } catch (e1) {
        setBusy('模型下载中断，自动重试…');
        blob = await once();
      }
      setBusy('保存结果…');
      const key = await putImageBlob(blob);
      if (!key) throw new Error('保存失败');
      pushNodes([
        addImageNode(key, {
          x: node.x + 24,
          y: node.y + 24,
          width: node.width,
          height: node.height,
          prompt: node.prompt,
          derived: '去背',
        }),
      ]);
    } catch (err) {
      setError('去背失败：' + err.message + '（首次需联网下载模型，若持续失败请检查网络）');
    } finally {
      setBusy('');
    }
  };

  // ---- 本地改图：纯像素流水线，即时生效、不花钱、不走模型排队 ----
  const runLocalEdit = async (node, ops) => {
    if (!node || node.type !== 'image' || !ops.length || busy) return;
    setError('');
    setBusy('本地处理中…');
    try {
      const { dataUrl, width, height } = await applyOps(node.url, ops, { brandColor: brand.colors[0] });
      const key = await putImageBlob(await dataUrlToBlob(dataUrl));
      if (!key) throw new Error('保存失败');
      // 宽高比可能变化（扩图/裁切），按长边等尺度重算显示尺寸，避免拉伸变形
      const long = Math.max(node.width || 320, node.height || 320);
      const nw = width >= height ? long : Math.round((long * width) / height);
      const nh = width >= height ? Math.round((long * height) / width) : long;
      const created = addImageNode(key, {
        x: node.x + 28,
        y: node.y + 28,
        width: nw,
        height: nh,
        prompt: node.prompt,
        derived: opLabels(ops).join(' · '),
      });
      pushNodes([created]);
      setSelectedId(created.id);
      setNotice('已应用：' + opLabels(ops).join(' · '));
    } catch (err) {
      setError('本地改图失败：' + err.message);
    } finally {
      setBusy('');
    }
  };

  // ---- 文字图层 ----
  const addText = () => {
    const pos = nextPos(counter.current);
    counter.current += 1;
    const node = {
      id: 't' + Date.now(),
      type: 'text',
      text: '双击编辑文字',
      x: pos.x,
      y: pos.y,
      fontSize: 40,
      fill: brand.colors[0] || '#2C2C2A',
      fontFamily: brand.font,
      width: 280,
    };
    pushNodes([node]);
    setSelectedId(node.id);
  };

  // ---- 品牌套件 ----
  const makeBrandCard = async () => {
    if (busy) return;
    setBusy('生成品牌色板卡…');
    try {
      const dataUrl = await buildBrandCard(brand);
      const key = await putImageBlob(await dataUrlToBlob(dataUrl));
      if (!key) throw new Error('保存失败');
      pushNodes([addImageNode(key, { derived: '品牌色板卡' })]);
      setNotice('品牌色板卡已落到画布');
    } catch (err) {
      setError('生成色板卡失败：' + err.message);
    } finally {
      setBusy('');
    }
  };

  // ---- 技能沉淀：把成功的配方存成一键技能 ----
  const saveSkill = () => {
    const p = prompt.trim() || (skill ? SKILLS.find((s) => s.id === skill)?.prompt : '');
    if (!p) {
      setError('先写点提示词（或选一个预设风格）再存技能');
      return;
    }
    const name = window.prompt('给这个技能起个名字', p.slice(0, 12));
    if (!name) return;
    const next = [{ id: 'k' + Date.now(), name, prompt: p, skill, aspect }, ...mySkills].slice(0, 20);
    saveMySkills(next);
    setNotice(`已存为技能「${name}」`);
  };

  const applyMySkill = (k) => {
    setPrompt(k.prompt || '');
    setSkill(k.skill || null);
    if (k.aspect) setAspect(k.aspect);
    setNotice(`已套用技能「${k.name}」，点生成即可`);
  };

  const removeMySkill = (e, id) => {
    e.stopPropagation();
    saveMySkills(mySkills.filter((k) => k.id !== id));
  };

  const editText = (node) => {
    const val = window.prompt('编辑文字', node.text);
    if (val === null) return;
    handleChange(node.id, { text: val || ' ' });
  };

  const handleChange = (id, patch) => {
    setNodes((ns) => {
      const next = ns.map((n) => (n.id === id ? { ...n, ...patch } : n));
      persist(next);
      return next;
    });
  };

  const handleDelete = (id) => {
    setNodes((ns) => {
      const next = ns.filter((n) => n.id !== id);
      persist(next);
      return next;
    });
    setSelectedId(null);
  };

  const exportCanvas = () => {
    const stage = window.__freeartStage;
    if (!stage) return;
    const a = document.createElement('a');
    a.href = stage.toDataURL({ pixelRatio: 2 });
    a.download = `freeart-${Date.now()}.png`;
    a.click();
  };

  const clearAll = () => {
    if (!nodes.length) return;
    if (!confirm('清空画布？（本地记录一并清除）')) return;
    setNodes([]); setHistory([]); setSelectedId(null);
    localStorage.removeItem(STORAGE_KEY);
    localStorage.removeItem(STORAGE_KEY + '-history');
  };

  // ---------- 本地引擎（内置 ComfyUI）----------
  const refreshEngine = useCallback(async () => {
    try {
      const s = await (await api('/api/engine/status')).json();
      setEngine(s);
      if (s?.online) {
        const c = await (await api('/api/comfy/status')).json();
        setComfy(c);
      }
      return s;
    } catch (e) { return null; }
  }, []);

  useEffect(() => {
    if (!engineOpen) return undefined;
    let alive = true;
    const tick = async () => { if (alive) await refreshEngine(); };
    tick();
    const iv = setInterval(tick, 2500);
    return () => { alive = false; clearInterval(iv); };
  }, [engineOpen, refreshEngine]);

  const engineInstall = async () => {
    try {
      const r = await api('/api/engine/install', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ models: selModels }),
      });
      if (r.status === 409 || !r.ok) return;
      await refreshEngine();
    } catch (e) { setError('引擎安装失败：' + e.message); }
  };

  const engineCancel = async () => {
    await api('/api/engine/cancel', { method: 'POST' }).catch(() => {});
    await refreshEngine();
  };

  const engineStart = async () => {
    await api('/api/engine/start', { method: 'POST' }).catch(() => {});
    await refreshEngine();
  };

  const engineStop = async () => {
    await api('/api/engine/stop', { method: 'POST' }).catch(() => {});
    await refreshEngine();
  };

  const selected = nodes.find((n) => n.id === selectedId);
  const cloud = !!health?.cloud;
  const engineDot = engine?.online ? '#3B6D11'
    : (engine?.phase === 'installing' || engine?.phase === 'starting') ? '#BA7517'
      : engine?.installed ? '#8A5A16' : '#B4B2A9';

  return (
    <div style={{ width: '100%', height: '100%', position: 'relative' }}>
      <Canvas
        nodes={nodes}
        selectedId={selectedId}
        onSelect={setSelectedId}
        onChange={handleChange}
        onDelete={handleDelete}
        onEditText={editText}
        draw={drawProps}
        strokes={strokes}
        onStrokeEnd={handleStrokeEnd}
      />

      <div style={{
        position: 'absolute', top: 16, left: 20, right: 20,
        display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12,
        pointerEvents: 'none',
      }}>
        <div style={{
          background: '#fff', borderRadius: 12, padding: isMobile ? '7px 10px' : '8px 16px',
          boxShadow: '0 1px 4px rgba(0,0,0,0.08)', pointerEvents: 'auto',
          display: 'flex', alignItems: 'center', gap: isMobile ? 6 : 8,
        }}>
          <div style={{ width: 10, height: 10, borderRadius: 5, background: '#534AB7', flexShrink: 0 }} />
          {!isMobile && <span style={{ fontWeight: 600, fontSize: 14, color: '#2C2C2A', letterSpacing: 0.5 }}>FREEART</span>}
          <span style={{
            fontSize: 11, padding: '2px 8px', borderRadius: 6, whiteSpace: 'nowrap',
            background: health?.free ? '#EAF3DE' : '#EEEDFE',
            color: health?.free ? '#3B6D11' : '#534AB7',
          }}>
            {health ? (health.free ? '免费 · sana' : health.provider === 'zhipu' ? '智谱' : 'fal') : '…'}
          </span>
        </div>
        <div style={{
          background: '#fff', borderRadius: 12, padding: isMobile ? '7px 10px' : '8px 14px',
          boxShadow: '0 1px 4px rgba(0,0,0,0.08)', pointerEvents: 'auto',
          fontSize: isMobile ? 11 : 12, color: '#5F5E5A',
          display: 'flex', alignItems: 'center', gap: isMobile ? 10 : 14,
          flexWrap: 'wrap', justifyContent: 'flex-end', maxWidth: 'min(70vw, 420px)',
        }}>
          <span onClick={() => fileRef.current?.click()} style={{ cursor: 'pointer', color: '#0F6E56', whiteSpace: 'nowrap' }}>导入图片</span>
          <span onClick={toggleDraw} style={{ cursor: 'pointer', color: drawing ? '#534AB7' : '#0F6E56', fontWeight: drawing ? 600 : 400, whiteSpace: 'nowrap' }}>✏️ 画笔</span>
          <span onClick={addText} style={{ cursor: 'pointer', color: '#0F6E56', whiteSpace: 'nowrap' }}>加文字</span>
          <span onClick={() => setBrandOpen((v) => !v)} style={{ cursor: 'pointer', color: brandOpen ? '#534AB7' : '#5F5E5A', fontWeight: brandOpen ? 600 : 400, whiteSpace: 'nowrap' }}>
            <span style={{ display: 'inline-block', width: 8, height: 8, borderRadius: 4, background: brand.colors[0], marginRight: 4 }} />
            品牌
          </span>
          {!cloud && (
            <span
              data-testid="engine-btn"
              onClick={() => setEngineOpen((v) => !v)}
              style={{ cursor: 'pointer', color: engineOpen ? '#534AB7' : '#5F5E5A', fontWeight: engineOpen ? 600 : 400, whiteSpace: 'nowrap' }}
            >
              <span style={{ display: 'inline-block', width: 8, height: 8, borderRadius: 4, background: engineDot, marginRight: 4 }} />
              引擎
            </span>
          )}
          <span onClick={exportCanvas} style={{ cursor: 'pointer', color: '#185FA5', whiteSpace: 'nowrap' }}>导出 PNG</span>
          <span onClick={clearAll} style={{ cursor: 'pointer', color: '#A32D2D', whiteSpace: 'nowrap' }}>清空</span>
          <input
            ref={fileRef}
            type="file"
            accept="image/*"
            multiple
            style={{ display: 'none' }}
            onChange={(e) => { importFiles(Array.from(e.target.files || [])); e.target.value = ''; }}
          />
        </div>
      </div>

      {drawing && (
        <div style={{
          position: 'absolute', left: 20, bottom: 110, width: 216,
          background: '#fff', borderRadius: 12, boxShadow: '0 2px 10px rgba(0,0,0,0.12)',
          padding: 12, pointerEvents: 'auto', fontSize: 12, zIndex: 20,
        }}>
          <div style={{ fontWeight: 500, color: '#444441', marginBottom: 8 }}>
            {maskMode ? '🖌️ 蒙版涂抹（涂在选中图上）' : '✏️ 手绘模式'}
          </div>
          {!maskMode && (
            <div style={{ display: 'flex', gap: 5, marginBottom: 8, flexWrap: 'wrap' }}>
              {['#2C2C2A', '#FFFFFF', ...brand.colors.slice(0, 4)].map((c) => (
                <div key={c} onClick={() => { setBrushColor(c); setEraser(false); }} style={{
                  width: 24, height: 24, borderRadius: 12, background: c, cursor: 'pointer',
                  border: !eraser && brushColor === c ? '2px solid #534AB7' : '1px solid rgba(0,0,0,0.15)',
                  boxSizing: 'border-box',
                }} />
              ))}
              <div onClick={() => setEraser((v) => !v)} style={{
                width: 24, height: 24, borderRadius: 12, cursor: 'pointer',
                display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 13,
                border: eraser ? '2px solid #534AB7' : '1px solid rgba(0,0,0,0.15)',
                boxSizing: 'border-box', background: '#F1EFE8',
              }}>⌫</div>
            </div>
          )}
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 9 }}>
            <span style={{ color: '#888780', fontSize: 11 }}>粗细</span>
            <input type="range" min={2} max={48} value={brushSize} onChange={(e) => setBrushSize(Number(e.target.value))} style={{ flex: 1 }} />
            <span style={{ width: 22, textAlign: 'right', color: '#5F5E5A' }}>{brushSize}</span>
          </div>
          <div style={{ display: 'flex', gap: 6, marginBottom: 8 }}>
            <div onClick={() => setStrokes((st) => st.slice(0, -1))} style={{ ...btnStyle('#F1EFE8', '#5F5E5A'), flex: 1, marginBottom: 0 }}>撤销</div>
            <div onClick={toggleDraw} style={{ ...btnStyle('#FCEBEB', '#A32D2D'), flex: 1, marginBottom: 0 }}>取消</div>
          </div>
          {maskMode ? (
            <div onClick={() => runMaskPlan(selected)} style={{ ...btnStyle('#534AB7', '#fff'), marginBottom: 0 }}>
              开始局部重绘
            </div>
          ) : (
            <div onClick={finishSketch} style={{ ...btnStyle('#534AB7', '#fff'), marginBottom: 0 }}>
              完成（转为图层）
            </div>
          )}
          {!maskMode && (
            <div style={{ fontSize: 10, color: '#A8A79E', marginTop: 7, lineHeight: 1.5 }}>
              画草图 → 完成 → 选中草图 → 写提示词 → 图生图
            </div>
          )}
        </div>
      )}

      {notice && (
        <div style={{
          position: 'absolute', top: 78, left: '50%', transform: 'translateX(-50%)',
          background: '#0F6E56', color: '#fff', padding: '7px 16px', borderRadius: 8, fontSize: 12,
          boxShadow: '0 2px 8px rgba(0,0,0,0.12)',
        }}>{notice}</div>
      )}

      {busy && (
        <div style={{
          position: 'absolute', top: '50%', left: '50%', transform: 'translate(-50%, -50%)',
          background: '#2C2C2A', color: '#fff', padding: '12px 22px', borderRadius: 10, fontSize: 13,
        }}>{busy}</div>
      )}

      {history.length > 0 && !isMobile && (
        <div style={{
          position: 'absolute', left: 20, top: 90, bottom: 170, width: 200,
          background: '#fff', borderRadius: 12, boxShadow: '0 1px 4px rgba(0,0,0,0.08)',
          padding: 12, overflowY: 'auto', pointerEvents: 'auto',
        }}>
          <div style={{ fontSize: 12, fontWeight: 500, color: '#444441', marginBottom: 8 }}>生成历史</div>
          {history.map((h, i) => (
            <div key={i} onClick={() => setPrompt(h.prompt)} style={{
              fontSize: 11, color: '#5F5E5A', padding: '6px 8px', marginBottom: 4,
              background: '#F1EFE8', borderRadius: 8, cursor: 'pointer',
              overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
            }} title={h.prompt}>{h.prompt}</div>
          ))}
        </div>
      )}

      {(brandOpen || selected || engineOpen) && (
        <div style={{
          position: 'absolute', right: 20, top: 90, width: isMobile ? 'calc(100vw - 40px)' : 238,
          maxHeight: 'calc(100vh - 300px)', overflowY: 'auto',
          display: 'flex', flexDirection: 'column', gap: 10, pointerEvents: 'auto',
        }}>
          {brandOpen && (
            <div style={cardStyle}>
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 8 }}>
                <span style={{ fontWeight: 500, color: '#444441' }}>品牌套件</span>
                <span onClick={() => setBrandOpen(false)} style={{ cursor: 'pointer', color: '#888780', fontSize: 15, lineHeight: 1 }}>×</span>
              </div>
              <input
                value={brand.name}
                onChange={(e) => saveBrand({ ...brand, name: e.target.value })}
                placeholder="品牌名"
                style={inputStyle}
              />
              <div style={{ fontSize: 11, color: '#888780', margin: '9px 0 6px' }}>品牌色板（点色块改色）</div>
              <div style={{ display: 'flex', gap: 5, flexWrap: 'wrap', marginBottom: 8 }}>
                {brand.colors.map((c, i) => (
                  <label key={i} style={{
                    width: 33, height: 30, borderRadius: 6, background: c, cursor: 'pointer',
                    border: i === 0 ? '2px solid #185FA5' : '1px solid rgba(0,0,0,0.08)',
                    boxSizing: 'border-box',
                  }}>
                    <input
                      type="color"
                      value={c}
                      onChange={(e) => {
                        const cs = [...brand.colors];
                        cs[i] = e.target.value;
                        saveBrand({ ...brand, colors: cs });
                      }}
                      style={{ opacity: 0, width: 0, height: 0 }}
                    />
                  </label>
                ))}
                {brand.colors.length < 6 && (
                  <div
                    onClick={() => saveBrand({ ...brand, colors: [...brand.colors, '#9AA39B'] })}
                    style={{
                      width: 26, height: 30, borderRadius: 6, border: '1px dashed #C9C7BC',
                      display: 'flex', alignItems: 'center', justifyContent: 'center',
                      cursor: 'pointer', color: '#888780', boxSizing: 'border-box',
                    }}>+</div>
                )}
              </div>
              <select
                value={brand.font}
                onChange={(e) => saveBrand({ ...brand, font: e.target.value })}
                style={{ ...inputStyle, marginBottom: 9 }}
              >
                {FONTS.map((f) => <option key={f.value} value={f.value}>{f.label}</option>)}
              </select>
              <div onClick={makeBrandCard} style={btnStyle('#EEEDFE', '#534AB7')}>生成品牌色板卡</div>
              {selected && selected.type === 'image' && (
                <div onClick={() => runLocalEdit(selected, ['brandtint'])} style={btnStyle('#E1F5EE', '#0F6E56')}>
                  把选中图套成品牌色
                </div>
              )}
              <div style={{ fontSize: 10, color: '#A8A79E', lineHeight: 1.6 }}>
                品牌主色会自动用于新文字图层，改色即时存本机。
              </div>
            </div>
          )}

          {engineOpen && (
            <div style={cardStyle} data-testid="engine-panel">
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 8 }}>
                <span style={{ fontWeight: 500, color: '#444441' }}>⚡ 本地引擎</span>
                <span
                  data-testid="engine-close"
                  onClick={() => setEngineOpen(false)}
                  style={{ cursor: 'pointer', color: '#888780', fontSize: 15, lineHeight: 1 }}
                >×</span>
              </div>

              <div style={{ fontSize: 11, color: '#444441', marginBottom: 8, lineHeight: 1.5 }}>
                {!engine ? '检测引擎中…'
                  : engine.phase === 'installing' ? '正在安装（可以关掉面板，装完会自动启动）'
                    : engine.phase === 'starting' ? '正在启动，首次要加载模型…'
                      : engine.online && engine.installed ? `运行中 · ${engine.checkpoints.length} 个底模${engine.vram ? ` · ${engine.vram.name}` : ''}`
                        : engine.online ? `已有引擎在 ${(engine.url || '').replace(/^https?:\/\//, '')} 运行`
                          : engine.installed ? '已安装，没在运行'
                            : '未安装'}
              </div>

              {engine?.phase === 'installing' && engine.progress != null && (
                <div style={{ height: 4, background: '#E3E1D9', borderRadius: 2, marginBottom: 8, overflow: 'hidden' }}>
                  <div style={{ width: `${Math.round(engine.progress * 100)}%`, height: '100%', background: '#534AB7', transition: 'width .3s' }} />
                </div>
              )}

              {!engine?.installed && engine?.phase !== 'installing' && (
                <>
                  {engine?.online && (
                    <div style={{ fontSize: 10, color: '#0F6E56', lineHeight: 1.6, marginBottom: 8 }}>
                      检测到 {(engine.url || '').replace(/^https?:\/\//, '')} 上已经有一个引擎在跑，可以直接用。
                      下面这一条是把它换成 FREEART 托管的内置版本。
                    </div>
                  )}
                  <div style={{ fontSize: 10, color: '#5F5E5A', lineHeight: 1.6, marginBottom: 8 }}>
                    装上之后：草图成图、以图生图、涂掉重画、随心改，全部跑你自己的显卡，不排队也不花钱。
                    不装也能用——云端生图和本地 27 种改图照常。
                  </div>
                  {(engine?.catalog || []).map((m) => (
                    <label key={m.id} style={{
                      display: 'flex', gap: 6, alignItems: 'flex-start', fontSize: 11,
                      color: '#444441', marginBottom: 5, cursor: 'pointer', lineHeight: 1.4,
                    }}>
                      <input
                        type="checkbox"
                        checked={selModels.includes(m.id)}
                        onChange={() => setSelModels((v) => (v.includes(m.id) ? v.filter((x) => x !== m.id) : [...v, m.id]))}
                        style={{ marginTop: 2 }}
                      />
                      <span>
                        {m.label} · <span style={{ color: '#888780' }}>{m.size}</span>
                        {m.core && <span style={{ color: '#8A5A16', marginLeft: 4 }}>必选</span>}
                      </span>
                    </label>
                  ))}
                  <div
                    data-testid="engine-install"
                    onClick={engineInstall}
                    style={btnStyle('#534AB7', '#fff')}
                  >
                    一键安装（约 {fmtBytes((engine?.catalog || []).filter((m) => selModels.includes(m.id)).reduce((a, b) => a + (b.bytes || 0), 0))}）
                  </div>
                  <div style={{ fontSize: 10, color: '#A8A79E', lineHeight: 1.6 }}>
                    会自动准备 Python 环境、ComfyUI 和所选模型。国内自动走镜像源，中断了再点一次会接着下。
                  </div>
                </>
              )}

              {engine?.phase === 'installing' && (
                <>
                  <div style={{
                    maxHeight: 150, overflowY: 'auto', background: '#FAF9F4', borderRadius: 8,
                    padding: 8, marginBottom: 8,
                  }}>
                    {(engine.logs || []).slice(-30).map((l, i) => (
                      <div key={i} style={{
                        fontSize: 10, lineHeight: 1.6, wordBreak: 'break-all',
                        color: l.level === 'err' ? '#A32D2D' : l.level === 'ok' ? '#3B6D11'
                          : l.level === 'warn' ? '#8A5A16' : l.level === 'progress' ? '#185FA5' : '#5F5E5A',
                      }}>{l.msg}</div>
                    ))}
                  </div>
                  <div data-testid="engine-cancel" onClick={engineCancel} style={{ ...btnStyle('#FCEBEB', '#A32D2D'), marginBottom: 0 }}>
                    取消安装
                  </div>
                </>
              )}

              {engine?.installed && engine?.phase !== 'installing' && (
                <>
                  {engine.online ? (
                    <>
                      <div style={{ fontSize: 10, color: '#5F5E5A', lineHeight: 1.6, marginBottom: 8 }}>
                        {engine.checkpoints.length
                          ? `底模：${engine.checkpoints.join('、')}`
                          : '引擎里还没有底模，把 .safetensors / .ckpt 放进 models/checkpoints 再刷新'}
                        {engine.upscalers.length ? ` · 放大模型：${engine.upscalers.join('、')}` : ''}
                      </div>
                      <div data-testid="engine-stop" onClick={engineStop} style={btnStyle('#FCEBEB', '#A32D2D')}>
                        停止引擎
                      </div>
                    </>
                  ) : (
                    <div data-testid="engine-start" onClick={engineStart} style={btnStyle('#534AB7', '#fff')}>
                      启动引擎
                    </div>
                  )}
                  <div style={{ fontSize: 10, color: '#A8A79E', lineHeight: 1.6, wordBreak: 'break-all' }}>
                    {engine.external ? '外部引擎：' : '内置引擎：'}{engine.dir}
                  </div>
                  <a
                    href={engine.url}
                    target="_blank"
                    rel="noreferrer"
                    style={{ fontSize: 10, color: '#185FA5' }}
                  >打开节点界面（进阶玩法）</a>
                </>
              )}
            </div>
          )}

          {selected && (
            <div style={cardStyle}>
              <div style={{ fontWeight: 500, color: '#444441', marginBottom: 8 }}>
                {selected.type === 'text' ? '选中文字' : '选中图片'}
              </div>
              {selected.type === 'text' ? (
                <>
                  <div onClick={() => editText(selected)} style={btnStyle('#EEEDFE', '#534AB7')}>编辑文字</div>
                  <div style={{ display: 'flex', gap: 4, marginBottom: 6 }}>
                    {brand.colors.slice(0, 5).map((c) => (
                      <div key={c} onClick={() => handleChange(selected.id, { fill: c })} style={{
                        flex: 1, height: 22, background: c, borderRadius: 5, cursor: 'pointer',
                        border: selected.fill === c ? '2px solid #185FA5' : '1px solid rgba(0,0,0,0.06)',
                        boxSizing: 'border-box',
                      }} />
                    ))}
                  </div>
                  <div style={{ fontSize: 10, color: '#A8A79E' }}>色板来自品牌套件</div>
                </>
              ) : (
                <>
                  <div style={{ fontSize: 11, color: '#888780', marginBottom: 6, lineHeight: 1.5 }}>
                    本地即时改（不花钱、不等模型）：
                  </div>
                  <div style={{ display: 'flex', flexWrap: 'wrap', gap: 4, marginBottom: 8 }}>
                    {CHIPS.map((c) => (
                      <div key={c.op} onClick={() => runLocalEdit(selected, [c.op])} style={{
                        fontSize: 11, padding: '4px 8px', borderRadius: 7, cursor: 'pointer',
                        background: '#F1EFE8', color: '#444441',
                      }}>{c.label}</div>
                    ))}
                  </div>
                  <input
                    value={editCmd}
                    onChange={(e) => setEditCmd(e.target.value)}
                    onKeyDown={(e) => {
                      if (e.key !== 'Enter') return;
                      if (looksLikeModelTask(editCmd)) {
                        setError('这句要重画内容，本地改不了。填到底部输入框点「生成」即可。');
                        return;
                      }
                      const ops = parseInstruction(editCmd);
                      if (ops.length) { runLocalEdit(selected, ops); setEditCmd(''); }
                      else setError('没听懂这句。试试"调暖一点、扩成横版、加圆角、转黑白"这类说法。');
                    }}
                    placeholder="或直接说：暖一点、扩成横版…"
                    style={{ ...inputStyle, marginBottom: 8 }}
                  />
                  {!cloud && (<>
                  <div style={{ borderTop: '1px solid #E3E1D9', margin: '10px 0', paddingTop: 9 }}>
                    <div style={{ fontWeight: 500, color: '#444441', marginBottom: 7 }}>✨ 随心改（AI 自动搭工作流）</div>
                    <div style={{ fontSize: 10, color: '#A8A79E', marginBottom: 6, lineHeight: 1.5 }}>
                      说出想要的效果，后台自动选能力、调参数、拼工作流，不用你碰节点图
                    </div>
                    <input
                      value={planCmd}
                      onChange={(e) => setPlanCmd(e.target.value)}
                      onKeyDown={(e) => e.key === 'Enter' && askPlan()}
                      placeholder="如：放大两倍并增强细节 / 改成吉卜力风格 / 加宽一点"
                      style={{ ...inputStyle, marginBottom: 6 }}
                    />
                    <div onClick={askPlan} style={btnStyle('#FFF3E0', '#8A5A16')}>
                      {planBusy ? '拆解中…' : 'AI 拆解'}
                    </div>
                    {planResult && (
                      <div style={{ background: '#FAF9F4', borderRadius: 8, padding: 8, marginBottom: 6 }}>
                        <div style={{ fontSize: 10, color: '#888780', marginBottom: 5 }}>
                          拆解结果（{planResult.source === 'llm' ? '模型规划' : '规则匹配'}）
                        </div>
                        {planResult.steps.map((s, i) => (
                          <div key={i} style={{ fontSize: 11, color: '#444441', marginBottom: 4 }}>
                            {i + 1}. {s.label}
                            {Object.keys(s.params || {}).length > 0 && (
                              <span style={{ color: '#A8A79E', marginLeft: 4 }}>{paramText(s)}</span>
                            )}
                          </div>
                        ))}
                        {planResult.prompt && (
                          <div style={{ fontSize: 10, color: '#5F5E5A', marginTop: 4, wordBreak: 'break-all' }}>
                            提示词：{planResult.prompt}
                          </div>
                        )}
                        {planResult.note && (
                          <div style={{ fontSize: 10, color: '#BA7517', marginTop: 3 }}>{planResult.note}</div>
                        )}
                        <div onClick={runPlan} style={{ ...btnStyle('#534AB7', '#fff'), marginTop: 6, marginBottom: 4 }}>
                          执行（{planResult.steps.length} 步）
                        </div>
                        <div onClick={() => setPlanResult(null)} style={{ fontSize: 10, color: '#888780', textAlign: 'center', cursor: 'pointer' }}>取消</div>
                      </div>
                    )}
                  </div>

                  <div style={{ borderTop: '1px solid #E3E1D9', margin: '10px 0', paddingTop: 9 }}>
                    <div style={{ fontWeight: 500, color: '#444441', marginBottom: 7 }}>以图生图（本地显卡）</div>
                    {comfy === null ? (
                      <div style={{ fontSize: 10, color: '#A8A79E' }}>检测本地引擎中…</div>
                    ) : comfy.online ? (
                      <>
                        <select
                          value={comfyCkpt}
                          onChange={(e) => setComfyCkpt(e.target.value)}
                          style={{ ...inputStyle, marginBottom: 7 }}
                          title="选择引擎里的底模"
                        >
                          {comfy.checkpoints.length
                            ? comfy.checkpoints.map((c) => <option key={c} value={c}>{c}</option>)
                            : <option value="">（无可用模型）</option>}
                        </select>
                        <input
                          value={refPrompt}
                          onChange={(e) => setRefPrompt(e.target.value)}
                          placeholder="基于这张图生成什么？（如 a red sports car photo）"
                          style={{ ...inputStyle, marginBottom: 7 }}
                        />
                        <div style={{ display: 'flex', gap: 4, marginBottom: 7 }}>
                          {[{ l: '轻改', v: 0.45 }, { l: '均衡', v: 0.65 }, { l: '大改', v: 0.85 }].map((d) => (
                            <div key={d.v} onClick={() => setDenoise(d.v)} style={{
                              flex: 1, textAlign: 'center', fontSize: 11, padding: '4px 0',
                              borderRadius: 7, cursor: 'pointer',
                              background: denoise === d.v ? '#534AB7' : '#F1EFE8',
                              color: denoise === d.v ? '#fff' : '#444441',
                            }}>{d.l}</div>
                          ))}
                        </div>
                        <div onClick={() => runImg2Img(selected)} style={btnStyle('#534AB7', '#fff')}>
                          以图生图（草图/图片 → 成图）
                        </div>
                        <div onClick={() => startMask(null)} style={btnStyle('#FFF3E0', '#8A5A16')}>
                          涂抹蒙版 → 局部重绘
                        </div>
                      </>
                    ) : (
                      <div style={{ fontSize: 10, color: '#A8A79E', lineHeight: 1.6 }}>
                        本地引擎没在运行。装上并启动后，这里就能：草图→成图、以图生图、涂抹局部重绘——
                        全部走你自己的显卡，免费无限，不排队。
                        {' '}
                        <span onClick={() => setEngineOpen(true)} style={{ color: '#185FA5', cursor: 'pointer' }}>打开引擎面板</span>
                        {' · '}
                        <span onClick={checkComfy} style={{ color: '#185FA5', cursor: 'pointer' }}>重新检测</span>
                      </div>
                    )}
                  </div>
                  </>)}
                  {cloud && (
                    <div style={{ borderTop: '1px solid #E3E1D9', margin: '10px 0', paddingTop: 9, fontSize: 10, color: '#A8A79E', lineHeight: 1.6 }}>
                      以图生图、局部重绘、随心改 都要跑本地显卡，云端版本没有显卡，这些入口就不显示了。
                      把项目装到自己电脑上就能用全套能力。
                    </div>
                  )}
                  <div onClick={() => removeBg(selected)} style={btnStyle('#E1F5EE', '#0F6E56')}>一键去背景（本地模型）</div>
                  <div onClick={() => regenerate(selected)} style={btnStyle('#EEEDFE', '#534AB7')}>再生成一张变体</div>
                  <div onClick={async () => {
                    const a = document.createElement('a');
                    a.href = await resolveUrl(selected.url);
                    a.download = `image-${selected.id}.png`;
                    a.click();
                  }} style={btnStyle('#E6F1FB', '#185FA5')}>下载这张图</div>
                </>
              )}
              <div onClick={() => handleDelete(selected.id)} style={{ ...btnStyle('#FCEBEB', '#A32D2D'), marginBottom: 0 }}>删除</div>
            </div>
          )}
        </div>
      )}

      <div style={{
        position: 'absolute', bottom: 20, left: '50%', transform: 'translateX(-50%)',
        width: 'min(760px, 94vw)', pointerEvents: 'none',
      }}>
        {error && (
          <div style={{ background: '#FCEBEB', color: '#A32D2D', borderRadius: 8, padding: '8px 12px', fontSize: 13, marginBottom: 8 }}>{error}</div>
        )}
        <div style={{ display: 'flex', gap: 6, marginBottom: 8, pointerEvents: 'auto', flexWrap: 'wrap' }}>
          {SKILLS.map((s) => (
            <div key={s.id} onClick={() => setSkill(skill === s.id ? null : s.id)} style={{
              fontSize: 12, padding: '5px 11px', borderRadius: 8, cursor: 'pointer',
              background: skill === s.id ? '#534AB7' : '#fff',
              color: skill === s.id ? '#fff' : '#5F5E5A',
              boxShadow: '0 1px 3px rgba(0,0,0,0.06)',
            }}>{s.label}</div>
          ))}
          <div style={{ width: 1, background: '#D3D1C7', margin: '2px 4px' }} />
          {ASPECTS.map((a) => (
            <div key={a.id} onClick={() => setAspect(a.id)} style={{
              fontSize: 12, padding: '5px 10px', borderRadius: 8, cursor: 'pointer',
              background: aspect === a.id ? '#2C2C2A' : '#fff',
              color: aspect === a.id ? '#fff' : '#5F5E5A',
              boxShadow: '0 1px 3px rgba(0,0,0,0.06)',
            }}>{a.label}</div>
          ))}
          {mySkills.length > 0 && <div style={{ width: 1, background: '#D3D1C7', margin: '2px 4px' }} />}
          {mySkills.map((k) => (
            <div key={k.id} onClick={() => applyMySkill(k)} title={k.prompt} style={{
              fontSize: 12, padding: '5px 8px 5px 11px', borderRadius: 8, cursor: 'pointer',
              background: '#FFF6E5', color: '#8A5A16', boxShadow: '0 1px 3px rgba(0,0,0,0.06)',
              display: 'flex', alignItems: 'center', gap: 5,
            }}>
              ★ {k.name}
              <span onClick={(e) => removeMySkill(e, k.id)} style={{ color: '#C1974F', fontSize: 14, lineHeight: 1 }}>×</span>
            </div>
          ))}
        </div>
        <div style={{
          background: '#fff', borderRadius: 16, boxShadow: '0 2px 12px rgba(0,0,0,0.12)',
          display: 'flex', alignItems: 'center', padding: '8px 8px 8px 16px', gap: 8,
          pointerEvents: 'auto',
        }}>
          <input
            value={prompt}
            onChange={(e) => setPrompt(e.target.value)}
            onKeyDown={(e) => e.key === 'Enter' && handleGenerate()}
            placeholder={
              selected && selected.type === 'image'
                ? '选中了图片：输入「暖一点」「加圆角」「转黑白」直接改这张图'
                : skill ? '补充需求（可留空只用预设风格）' : '描述你想要的设计，英文出图更稳'
            }
            style={{ flex: 1, border: 'none', outline: 'none', fontSize: 14, background: 'transparent' }}
            disabled={loading}
          />
          <span
            onClick={saveSkill}
            title="把当前提示词存为一键技能，下次点一下就复用"
            style={{ cursor: 'pointer', fontSize: 12, color: '#888780', whiteSpace: 'nowrap', padding: '0 4px' }}
          >存技能</span>
          <button
            onClick={handleGenerate}
            disabled={loading || (!prompt.trim() && !skill)}
            style={{
              background: loading ? '#B4B2A9' : '#534AB7', color: '#fff', border: 'none',
              borderRadius: 10, padding: '9px 20px', fontSize: 14, cursor: 'pointer',
              fontWeight: 500, whiteSpace: 'nowrap',
            }}
          >{loading ? `${elapsed}s` : '生成'}</button>
        </div>
        <div style={{ fontSize: 11, color: '#888780', textAlign: 'center', marginTop: 6 }}>
          {loading ? `生成中，已等待 ${elapsed} 秒（免费通道排队较慢）` : (health?.hint || '')}
        </div>
      </div>
    </div>
  );
}
