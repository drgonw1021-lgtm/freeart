// 意图 → 工作流 的自动规划层
// 设计原则：LLM 只负责"选能力 + 调参数"，工作流一律由 comfyWorkflows.js 的模板拼装，
// 绝不让它自由生成节点图 —— 既安全，也保证拼出来的图一定能跑。
import { comfyCheck, comfyUpload, comfyRun, comfyDataUrl, comfyObjectInfo, comfyEnum, randName } from './comfyApi.js';
import { BUILDERS } from './comfyWorkflows.js';

export const CAPS = {
  txt2img:  { label: '文生图', needs: [] },
  img2img:  { label: '以图生图', needs: ['image'] },
  style:    { label: '风格化重绘', needs: ['image'] },
  variation:{ label: '生成变体', needs: ['image'] },
  inpaint:  { label: '局部重绘', needs: ['image', 'mask'] },
  outpaint: { label: '扩图补画', needs: ['image'] },
  enhance:  { label: '细节增强', needs: ['image'] },
  upscale:  { label: 'AI 放大', needs: ['image'] },
  bgremove: { label: '去背景（浏览器本地模型）', needs: ['image'] },
};

// 风格词典：中文风格词 → 英文提示词后缀（出图更稳）
const STYLE_WORDS = {
  吉卜力: 'studio ghibli anime style, hand painted background, soft warm palette',
  宫崎骏: 'studio ghibli anime style, lush painted scenery',
  赛博朋克: 'cyberpunk style, neon lights, high contrast, wet streets',
  水彩: 'watercolor painting, soft washes, paper texture',
  油画: 'oil painting, visible brushstrokes, rich colors',
  像素: 'pixel art, 16-bit, crisp pixels',
  漫画: 'manga comic style, bold ink lines, screentone',
  插画: 'editorial illustration, flat colors, clean shapes',
  写实: 'photorealistic, highly detailed, natural lighting',
  二次元: 'anime style, cel shading, vibrant colors',
  水墨: 'chinese ink wash painting, minimal composition',
  胶片: 'film photography look, film grain, warm tones',
  '3d': '3d render, octane render, soft studio lighting',
  极简: 'minimalist design, generous negative space, clean',
};

// 常见主体词：中文 → 英文（SD 系模型吃英文提示词，中文会明显掉质量）
const SUBJECT_WORDS = {
  猫: 'cat', 狗: 'dog', 花: 'flower', 车: 'car', 汽车: 'car', 树: 'tree', 房子: 'house',
  人: 'person', 女孩: 'girl', 男孩: 'boy', 太阳: 'sun', 云: 'cloud', 山: 'mountain',
  水: 'water', 海: 'ocean', 鸟: 'bird', 书: 'book', 咖啡: 'coffee', 杯子: 'cup',
  桌子: 'table', 城市: 'city', 森林: 'forest', 星空: 'starry sky', 蛋糕: 'cake',
  鞋子: 'shoes', 包: 'bag', 手机: 'phone', 电脑: 'laptop', 椅子: 'chair', 灯: 'lamp',
};

// 规则路由（零延迟、不依赖网络）
const RULES = [
  { cap: 'bgremove', re: /去背景|去掉背景|抠图|透明底|去掉底色|remove\s*bg|transparent\s*bg/i },
  { cap: 'outpaint', re: /扩图|加宽|加高|向外扩|扩展画布|延展画布|补画.*(边|外)|outpaint/i },
  { cap: 'inpaint',  re: /局部|这块|这一块|涂掉|抹掉|擦掉|去掉水印|去掉.*(人|物|字|logo)|换成|改成(一|个)/ },
  { cap: 'upscale',  re: /放大|高清|更清晰|4k|2\s*倍|两\s*倍|3\s*倍|分辨率|变清晰|upscale/ },
  { cap: 'enhance',  re: /增强细节|补细节|更精细|锐化|修复.*模糊|更精致/ },
  { cap: 'variation',re: /变一版|再来一张|变体|换个版本|类似.*再来|再生成/ },
  { cap: 'style',    re: /风格|画风|吉卜力|宫崎骏|赛博朋克|水彩|油画|像素|漫画|插画|写实|二次元|水墨|胶片|极简/ },
];
// 多步执行顺序（先改内容，后改清晰度/尺寸）
const PIPELINE_ORDER = ['bgremove', 'inpaint', 'style', 'variation', 'img2img', 'outpaint', 'enhance', 'upscale'];

const clamp = (v, min, max, def) => {
  const n = Number(v);
  if (!Number.isFinite(n)) return def;
  return Math.min(max, Math.max(min, n));
};
const mul8 = (v) => Math.max(8, Math.round(v / 8) * 8);

function extractParams(instruction, cap, ctx) {
  const p = {};
  if (cap === 'upscale' || cap === 'enhance') {
    const m = instruction.match(/(\d(?:\.\d)?)\s*(?:倍|x|×)/i);
    p.scale = clamp(m ? m[1] : 2, 1.5, 4, 2);
  }
  if (cap === 'enhance') p.denoise = /强|明显/.test(instruction) ? 0.45 : 0.3;
  if (cap === 'style' || cap === 'img2img' || cap === 'variation') {
    p.denoise = /微调|轻微|一点点/.test(instruction) ? 0.4
      : /大改|彻底|完全/.test(instruction) ? 0.85
      : cap === 'variation' ? 0.55 : 0.68;
  }
  if (cap === 'outpaint') {
    const pad = ctx?.width ? Math.round(ctx.width * 0.25) : 160;
    const wide = /加宽|横向|宽/.test(instruction);
    const tall = /加高|竖向|高/.test(instruction);
    p.left = mul8(wide || (!wide && !tall) ? pad : pad * 0.4);
    p.right = p.left;
    p.top = mul8(tall ? pad : pad * 0.4);
    p.bottom = p.top;
  }
  return p;
}

function styleSuffix(instruction) {
  return Object.entries(STYLE_WORDS)
    .filter(([k]) => instruction.includes(k))
    .map(([, v]) => v)
    .join(', ');
}

/** 规则规划：本地即时，无网络依赖 */
export function planByRules(instruction, ctx = {}) {
  const hits = RULES.filter((r) => r.re.test(instruction)).map((r) => r.cap);
  const ordered = PIPELINE_ORDER.filter((c) => hits.includes(c));
  let steps = ordered;
  if (!steps.length) steps = ctx.hasImage ? ['img2img'] : ['txt2img'];

  // 提示词只保留英文部分（风格词 + 主体词 + 用户自己写的英文），中文喂给 SD 会掉质量
  const latin = (instruction.match(/[A-Za-z][A-Za-z0-9 ,.'-]{2,}/g) || []).join(' ').trim();
  const subjects = Object.entries(SUBJECT_WORDS)
    .filter(([k]) => instruction.includes(k))
    .map(([, v]) => v)
    .join(', ');
  const suffix = styleSuffix(instruction);
  const prompt = [latin, subjects, suffix].filter(Boolean).join(', ') || instruction;

  return {
    source: 'rule',
    prompt,
    negative: '',
    steps: steps.map((cap) => ({
      cap,
      label: CAPS[cap].label,
      params: extractParams(instruction, cap, ctx),
      reason: `识别到「${RULES.find((r) => r.cap === cap)?.re.source.split('|')[0] || cap}」类需求`,
    })),
  };
}

const SYSTEM_PROMPT = `你是 ComfyUI 工作流规划器。根据用户想要的效果，从下面的能力库中选择 1-3 个步骤并给出参数。
能力库（cap 只能取这些值）：
${Object.entries(CAPS).map(([k, v]) => `- ${k}（${v.label}）需要：${v.needs.join('+') || '无'}`).join('\n')}
参数规则：
- img2img/style/variation：denoise 0.2~0.95（改动越大越接近1）
- enhance：scale 1.5~4，denoise 0.2~0.5
- upscale：scale 1.5~4
- outpaint：left/top/right/bottom 8~1024 且为 8 的倍数
- bgremove 由浏览器本地模型执行，不消耗 ComfyUI
输出严格为 JSON（不要解释、不要 markdown）：
{"prompt":"英文提示词（用于生成/重绘）","steps":[{"cap":"...","params":{...},"reason":"一句话中文说明为什么这步"}]}
若上下文有图片，优先使用基于图片的能力；若只是想"画一张新的"则用 txt2img。`;

// 免费文本通道有 45s/IP 限流：结果缓存 + 失败退避重试一次
const llmCache = new Map();
const LLM_TTL = 10 * 60 * 1000;

/** LLM 规划：规则无法覆盖复杂表达时兜底（Pollinations 免费文本通道） */
export async function planByLLM(instruction, ctx = {}) {
  const key = `${instruction}::${ctx.hasImage ? 'img' : 'noimg'}::${ctx.hasMask ? 'mask' : 'nomask'}`;
  const hit = llmCache.get(key);
  if (hit && Date.now() - hit.at < LLM_TTL) return hit.data;
  const data = await planByLLMOnce(instruction, ctx);
  llmCache.set(key, { at: Date.now(), data });
  return data;
}

async function planByLLMOnce(instruction, ctx = {}) {
  const body = {
    model: 'openai',
    messages: [
      { role: 'system', content: SYSTEM_PROMPT },
      {
        role: 'user',
        content: `用户想要：「${instruction}」\n上下文：${ctx.hasImage ? `已有一张 ${ctx.width || '?'}x${ctx.height || '?'} 的图` : '画布上没有选中图片'}${ctx.hasMask ? '，并且已经涂抹了蒙版' : ''}`,
      },
    ],
    temperature: 0.3,
    max_tokens: 400,
  };
  let res = await fetch('https://text.pollinations.ai/openai', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(45000),
  });
  if (res.status === 402 || res.status === 429) {
    await new Promise((r) => setTimeout(r, 9000)); // 撞上 45s/IP 限流，等一轮再试
    res = await fetch('https://text.pollinations.ai/openai', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(45000),
    });
  }
  if (!res.ok) throw new Error(`规划模型 ${res.status}`);
  const j = await res.json();
  const text = j?.choices?.[0]?.message?.content || '';
  const m = text.match(/\{[\s\S]*\}/);
  if (!m) throw new Error('规划结果不是 JSON');
  const raw = JSON.parse(m[0]);

  // 白名单校验 + 参数夹取：LLM 只能"选菜调参"，拼装仍由模板完成
  const steps = (raw.steps || [])
    .filter((s) => CAPS[s.cap])
    .slice(0, 3)
    .map((s) => {
      const p = s.params || {};
      const out = { cap: s.cap, label: CAPS[s.cap].label, params: {}, reason: String(s.reason || '').slice(0, 60) };
      if (p.denoise !== undefined) out.params.denoise = clamp(p.denoise, 0.2, 0.95, 0.65);
      if (p.scale !== undefined) out.params.scale = clamp(p.scale, 1.5, 4, 2);
      if (p.left !== undefined) out.params.left = mul8(clamp(p.left, 8, 1024, 128));
      if (p.top !== undefined) out.params.top = mul8(clamp(p.top, 8, 1024, 128));
      if (p.right !== undefined) out.params.right = mul8(clamp(p.right, 8, 1024, 128));
      if (p.bottom !== undefined) out.params.bottom = mul8(clamp(p.bottom, 8, 1024, 128));
      return out;
    });
  if (!steps.length) throw new Error('规划结果无有效步骤');
  return { source: 'llm', prompt: String(raw.prompt || instruction).slice(0, 500), negative: '', steps };
}

/** 对外：先规则，规则没识别出具体意图时再问 LLM */
export async function plan(instruction, ctx = {}) {
  const rule = planByRules(instruction, ctx);
  const explicit = rule.steps.some((s) => s.cap !== 'img2img' && s.cap !== 'txt2img');
  if (explicit) return rule;
  try {
    const llm = await planByLLM(instruction, ctx);
    return llm;
  } catch (e) {
    return { ...rule, note: '规划模型暂不可用，已按规则执行（' + e.message + '）' };
  }
}

/** 执行计划：多步串行，上一步的输出作为下一步的输入 */
export async function executePlan({ steps, prompt, negative, initImage, mask, ckpt, upscaleModel }) {
  const st = await comfyCheck();
  if (!st.online) throw new Error('未检测到本地 ComfyUI');
  const model = ckpt || st.checkpoints[0];
  if (!model) throw new Error('ComfyUI 中没有可用的 checkpoint 模型');

  let cur = initImage;
  const results = [];
  for (const step of steps) {
    if (step.cap === 'bgremove') {
      results.push({ cap: step.cap, label: step.label, handledByFrontend: true });
      continue;
    }
    if (step.cap === 'txt2img') {
      const wf = BUILDERS.txt2img({ ckpt: model, pos: prompt, neg: negative, ...step.params });
      const out = await comfyRun(wf);
      cur = `data:${out.mime};base64,${out.buffer.toString('base64')}`;
      results.push({ cap: step.cap, label: step.label, dataUrl: cur });
      continue;
    }
    if (!cur) throw new Error(`「${step.label}」需要底图，但没有可用的图片`);
    if (step.cap === 'inpaint' && !mask) throw new Error('局部重绘需要先涂抹蒙版');

    const a = comfyDataUrl(cur);
    const up = await comfyUpload(a.buf, a.mime, randName());
    const args = { ckpt: model, pos: prompt || 'high quality, detailed', neg: negative, imageName: up.name, ...step.params };
    let wf;
    if (step.cap === 'inpaint') {
      const b = comfyDataUrl(mask);
      const upm = await comfyUpload(b.buf, b.mime, randName());
      wf = BUILDERS.inpaint({ ...args, maskName: upm.name });
    } else if (step.cap === 'upscale') {
      if (upscaleModel && (await comfyObjectInfo('ImageUpscaleWithModel'))) {
        wf = BUILDERS.upscale({ ...args, modelName: upscaleModel, refine: 0.3 });
      } else {
        // 没装放大模型时降级为"放大 + 轻度重绘补细节"，SD1.5 本体即可
        wf = BUILDERS.enhance({ ...args, scale: step.params.scale || 2, denoise: 0.3 });
      }
    } else {
      wf = BUILDERS[step.cap](args);
    }
    const out = await comfyRun(wf);
    cur = `data:${out.mime};base64,${out.buffer.toString('base64')}`;
    results.push({ cap: step.cap, label: step.label, dataUrl: cur });
  }
  return results;
}

/** 当前 ComfyUI 实际支持哪些能力（用于前端显示与降级） */
export async function detectCaps() {
  const st = await comfyCheck();
  if (!st.online) return { online: false, checkpoints: [], upscaleModels: [], caps: [] };
  const [upscaleModels, hasOutpaint, hasUpscaleNode] = await Promise.all([
    comfyEnum('UpscaleModelLoader', 'model_name'),
    comfyObjectInfo('ImagePadForOutpaint').then((d) => !!d),
    comfyObjectInfo('ImageUpscaleWithModel').then((d) => !!d),
  ]);
  const caps = ['txt2img', 'img2img', 'inpaint', 'variation', 'style', 'enhance', 'upscale', 'bgremove'];
  if (hasOutpaint) caps.push('outpaint');
  return {
    online: true,
    checkpoints: st.checkpoints,
    upscaleModels,
    aiUpscale: hasUpscaleNode && upscaleModels.length > 0,
    caps,
  };
}
