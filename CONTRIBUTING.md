# 贡献指南

感谢你想让 FREEART 变好一点。

## 跑起来

```bash
npm install
npm run dev        # 前端热更新（另开终端跑 npm start 起服务）
```

或者：

```bash
npm run build && npm start
```

不需要先装引擎就能改大部分代码——本地改图、画布、品牌、云端生图都不依赖引擎。
要验证引擎相关能力，用假引擎即可：

```bash
node mock-comfy.js     # 8188 端口起一个假 ComfyUI
npm start              # 3000
node e2e-paint.mjs
```

## 项目约定

- 2 空格缩进、单引号、写分号，注释用中文
- 能不加依赖就不加（这是轻量项目）
- 前端状态一律存 localStorage / IndexedDB，图片不出浏览器
- 服务端不保存用户数据

## 加一个新技能：本地改图操作

这是最受欢迎的 PR 类型——因为它不依赖模型，人人可用。

三处改动，缺一不可：

1. **`src/localEdit.js` 的 `OPS`**：实现像素操作，形如 `(img, params) => void`
2. **`src/localEdit.js` 的 `parseInstruction`**：加一条正则，让中文说法能命中它
   ```js
   if (/暖/.test(s)) ops.push({ op: 'warmer', params: { amount: 12 } });
   ```
3. **`src/localEdit.js` 的 `CHIPS`**：加一个按钮标签，让用户不用打字也能点

顺手在 `e2e-full.mjs` 里补一条用例。

## 加一个新技能：工作流模板

1. **`comfyWorkflows.js`**：写一个 `buildXxx({...})`，返回 ComfyUI 的 API 格式节点图
2. **`planner.js` 的 `CAPS`**：登记这个能力（id、标签、需要的参数、参数范围）
3. **`planner.js` 的规则路由**：加匹配规则（优先于 LLM，零延迟）
4. 需要的话，把提示词词典也补上

> 工作流**必须由模板拼装**。让模型直接输出节点图是不安全的，这条路我们不走。

## 加一个可一键安装的模型

编辑 `engine/models.json`：

```json
{
  "id": "my-model",
  "label": "显示名",
  "desc": "一句话说明它干什么",
  "dir": "models/checkpoints",
  "file": "my-model.safetensors",
  "bytes": 2134567890,
  "size": "2.0 GB",
  "core": false,
  "urls": ["https://...", "https://镜像/..."]
}
```

多个 URL 会按顺序试，装不上也不影响其他模型。

## 测试

```bash
npm run build
node e2e-engine.mjs    # 引擎接口 + 面板
node e2e-full.mjs      # 全量回归
node e2e-paint.mjs     # 画笔 / 图生图 / 局部重绘 / 随心改
```

改了前端必须本地跑一遍 e2e，别让红叉留给别人。

## 提交 PR

- 一个 PR 一件事
- 描述里写清楚"改了什么 + 怎么验证的"
- 涉及 UI 的，截张图

## 不做的事

- 不引入需要付费 API 才能用的核心功能（可以做成可选项）
- 不上传用户图片到任何服务器
- 不使用 GPL 传染性代码（本项目 MIT；内置引擎是外部依赖，不合并进本仓库）
