# FREEART

**说出想要的效果，AI 自动搭工作流。开源、自带本地推理引擎、能边画边生成的 AI 设计画布。**

```
中文 → 「把这块涂掉换成一只猫」 → 自动拆解 → 蒙版局部重绘 → 出图
```

不用搭节点图，不用配 ComfyUI 工作流，不用买 API 额度。装好引擎后，出图走的是你自己的显卡。

> 本项目是独立实现的开源软件，与 Lovart 及其官方产品没有任何关联。

---

## 为什么做这个

市面上的 AI 设计工具（Lovart 等）体验很好，但有三个问题：**按张计费**、**排队等待**、**闭源不可改**。

而它们做的事里，其实有一大半并不需要模型：

| 你以为要 AI 干的 | 真相 |
|---|---|
| 调色、裁切、扩图、加圆角、转黑白、镜像 | 纯像素运算，毫秒级，零成本 |
| 去背景 | 浏览器内 WASM 小模型，1 秒 |
| 品牌色板、文字排版 | 就是 HTML/Canvas |
| 生成、重绘、换物体 | 这个确实要模型 —— 那就跑你自己的显卡 |

FREEART 把这三档能力放在同一个无限画布上，并且**只对最后一档收费（你自己的电费）**。

## 三种能力，按成本分级

| 层级 | 能力 | 成本 | 速度 |
|---|---|---|---|
| **本地像素流水线** | 27 种改图操作、去背景、文字图层、品牌套件、技能沉淀 | 免费、可离线 | 毫秒级 |
| **云端文生图** | 底部输入框描述 → 落画布 | 免费（Pollinations） | 约 7s/张，有排队 |
| **本地引擎**（内置） | 画笔手绘、以图生图、蒙版局部重绘、**随心改（AI 自动搭工作流）** | 免费无限 | 4GB 显存约 3–8s/张 |

## 快速开始

```bash
git clone https://github.com/drgonw1021-lgtm/freeart.git
cd freeart
npm install
npm run build
npm start
```

打开 <http://localhost:3000>。

Windows 用户也可以直接双击 **`启动 FREEART.bat`**。

```bash
npm install --registry=https://registry.npmmirror.com   # 国内装依赖走镜像更快
```

## 内置引擎：点一下就装好

第一次打开页面 → 顶栏 **⚡ 引擎** → **一键安装**。之后它会自己完成：

1. 准备 Python 环境（有 3.10–3.12 就用本机的，没有就自动装 uv 并下载 CPython）
2. 下载 ComfyUI 源码到 `engine/ComfyUI`
3. 装依赖：有 NVIDIA 显卡就装 CUDA 版 torch，没有就装 CPU 版
4. 下载你勾选的模型（默认 SD1.5，约 4GB）
5. 写进 `config.json`，然后自动启动

全程有进度条和日志，**随时可以取消，中断了再点一次会接着下**（断点续传）。

国内网络会自动挑镜像源（pip / PyTorch / HuggingFace / GitHub 都有备选），不用挂梯子。

```bash
# 也可以走命令行
npm run engine:install                       # 引擎 + SD1.5
npm run engine:install -- --no-models        # 只装引擎，模型自己放
npm run engine:install -- --models sd15,realesrgan-x2
```

### 硬件

| 显存 | 能跑什么 | 说明 |
|---|---|---|
| 4GB（RTX 3050 Laptop 实测） | SD1.5 的 512–768px | 自动加 `--lowvram`，够用 |
| 6GB 以上 | SD1.5 提速，可试 SDXL | 不自动加 `--lowvram` |
| 无独显 / CPU | SD1.5 | 能跑，一张几十秒到几分钟 |

### 已经有 ComfyUI 了

在 `config.json` 里指过去就行，FREEART 不会再自己装：

```json
{ "COMFY_PATH": "E:/ComfyUI" }
```

想自己挑模型，直接丢进对应目录，会被自动识别：

- 底模 → `models/checkpoints/`（.safetensors / .ckpt）
- 放大模型 → `models/upscale_models/`（RealESRGAN 等）

## 随心改：说出效果，后台自己搭工作流

选中画布上任意图片 → 右侧 **✨ 随心改** → 说出效果 → **AI 拆解** → 看它拆成了几步 → **执行**。

```
「放大两倍并增强细节」  →  ① 细节增强（强度 0.45, 2×）  →  ② AI 放大（2×）
「改成吉卜力风格」      →  ① 风格化重绘（强度 0.68），提示词自动补 ghibli 风格词
「横向加宽一点」        →  ① 扩图补画（左右各 128px）
「这块涂掉换成一只猫」  →  自动进入蒙版涂抹 → 局部重绘
```

**设计原则：模型只负责"选能力 + 调参数"，工作流一律由模板拼装。**

`comfyWorkflows.js` 里是 7 类写死的工作流模板（txt2img / img2img / inpaint / outpaint / upscale / enhance / upscaleOnly）。规划层先走规则（零延迟），规则认不出来才问 LLM，LLM 的输出还要过白名单校验和参数夹取。

所以**不会执行任何"模型生成的节点图"**，也不会出现拼错节点跑不起来的情况。

## 边画边生成（Krita + ComfyUI 的那一套）

1. 顶栏 **✏️ 画笔** → 直接画草图（或者先在底部生成一张图）
2. 选中它 → 右侧写"想变成什么" → 选强度（轻改/均衡/大改）→ **以图生图**
3. 想只改局部：**涂抹蒙版 → 局部重绘**，用笔刷涂住要改的地方，涂哪儿改哪儿

## 全部功能

**画布**：无限画布、拖拽缩放、多图层、多选、导出 PNG、生成历史

**本地改图（27 种，即时生效）**：调色（暖/冷/亮/暗/对比/饱和）、裁切、扩图、圆角、镜像、旋转、转黑白、复古、胶片感、锐化、模糊、暗角、去背景、品牌色化、像素化、描边……

**品牌套件**：品牌名 + 色板 + 字体，一键生成色板卡，新文字图层自动取主色

**技能沉淀**：把好用的提示词存成一键技能，下次点一下复用

**生成**：文生图、以图生图、局部重绘、扩图、AI 放大、再生成变体

## 架构

```
浏览器（React + Konva 画布）          图片存在 IndexedDB，不出浏览器
        │
        ▼
server.js ─── 云端生图（Pollinations / 智谱 / fal，可换）
        │
        ├── /api/engine/*  ──→ engine/manager.js ──→ engine/ComfyUI（内置，本机 GPU）
        │
        └── /api/comfy/*   ──→ planner.js（意图→步骤）
                                   ├── 规则路由（优先，零延迟）
                                   └── LLM 兜底（text.pollinations.ai）
                                            │ 只输出「能力 + 参数」
                                            ▼
                                   comfyWorkflows.js（模板拼装工作流，必过）
```

| 文件 | 职责 |
|---|---|
| `server.js` | Express：云端生图、引擎接口、ComfyUI 代理 |
| `engine/installer.js` | 安装器：选源 / 断点续传 / 可取消 |
| `engine/manager.js` | 引擎状态、安装、启动、停止、日志流 |
| `engine/models.json` | 可一键安装的模型清单 |
| `planner.js` | 意图 → 工作流（规则 + LLM + 多步串联） |
| `comfyWorkflows.js` | 7 类工作流模板 |
| `comfyApi.js` | ComfyUI 底层封装 |
| `src/localEdit.js` | 本地像素流水线 + 笔迹/蒙版栅格化 |
| `src/Canvas.jsx` | Konva 画布与手绘图层 |
| `src/store.js` | IndexedDB 图片存储 |

## 测试

```bash
npm run build
npm start                 # 另开一个终端
node e2e-engine.mjs       # 引擎接口 + 引擎面板（18 项）
node e2e-full.mjs         # 全量回归（38 项）
node e2e-paint.mjs        # 画笔 / 图生图 / 局部重绘 / 随心改（16 项，用假引擎）
```

用 `puppeteer-core` 开本机 Chrome 无头跑真实浏览器流程。`e2e-paint.mjs` 会自己拉起一个假引擎（`mock-comfy.js`）和服务，不用真装 4GB 也能验证。

```bash
SKIP_UI=1 node e2e-engine.mjs   # 只跑接口部分（CI 用）
```

## 部署

纯静态 + Node 服务，任何能跑 Node 20+ 的地方都行。

注意：**本地引擎依赖本机 GPU，云端部署版本会自动降级**——保留本地像素流水线、云端生图、画笔，隐藏引擎相关入口。想要全部能力就在自己电脑上跑。

## 常见问题

**不装引擎能用吗？**
能。云端生图 + 27 种本地改图 + 去背景 + 品牌套件 + 画笔全部照常，只是"以图生图 / 局部重绘 / 随心改"用不了。

**装到一半断了怎么办？**
再点一次。`.part` 文件保留着，会从断点继续。

**C 盘会被塞满吗？**
引擎默认装在**项目目录**下（`engine/ComfyUI`）。把项目放在非系统盘就行。

**为什么我的图不见了？**
图片存在浏览器 IndexedDB 里（为了导入瞬时完成 + 不上传服务器）。换浏览器或清缓存会丢，画布结构还在。

**模型能换成别的吗？**
能。`engine/models.json` 里加一条，或者直接把模型文件丢进 `models/checkpoints/`。

## 贡献

见 [CONTRIBUTING.md](CONTRIBUTING.md)。最欢迎的两类 PR：**新的本地改图操作**（不依赖模型、能被中文指令识别）和**新的工作流模板**。

## 许可证

[MIT](LICENSE)。

依赖各自的许可证：ComfyUI（GPL-3.0）、Stable Diffusion 1.5（CreativeML OpenRAIL-M）、RealESRGAN（BSD-3-Clause）。本仓库不包含这些权重，由安装器在你的机器上另行下载。
