// 假引擎：不装真 ComfyUI 也能跑通连接层和 e2e（端口 8188）
// 端口 8188，实现 /system_stats /object_info/CheckpointLoaderSimple /upload/image /prompt /history/:id /view
import express from 'express';
import crypto from 'crypto';

const app = express();
const jobs = new Map();
const OUT_PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAEAAAABACAYAAACqaXHeAAAAGElEQVR4nO3BMQEAAADCoPVPbQlPoAAAAPwwGukAAAXPtB0AAAAASUVORK5CYII=',
  'base64'
);

app.use(express.json({ limit: '40mb' }));

app.get('/system_stats', (req, res) => res.json({ system: { comfyui_version: 'mock' } }));

app.get('/object_info/CheckpointLoaderSimple', (req, res) =>
  res.json({ CheckpointLoaderSimple: { input: { required: { ckpt_name: [['v1-5-pruned-emaonly.safetensors', 'sd15-mock.safetensors'], { image_outputs: 1 }] } } } })
);

app.post('/upload/image', (req, res) => {
  const name = crypto.randomBytes(6).toString('hex') + '.png';
  res.json({ name, subfolder: '', type: 'input' });
});

app.post('/prompt', (req, res) => {
  const id = crypto.randomUUID();
  jobs.set(id, { wf: req.body?.prompt, at: Date.now() });
  setTimeout(() => {
    jobs.set(id, {
      wf: req.body?.prompt,
      status: { status_str: 'success', completed: true },
      outputs: { '8': { images: [{ filename: 'mock-out-' + id.slice(0, 8) + '.png', subfolder: '', type: 'output' }] } },
    });
  }, 400);
  res.json({ prompt_id: id, number: 1, node_errors: {} });
});

app.get('/history/:id', (req, res) => {
  const j = jobs.get(req.params.id);
  if (!j) return res.json({});
  const { wf, ...rest } = j;
  res.json({ [req.params.id]: rest });
});

app.get('/view', (req, res) => {
  res.set('Content-Type', 'image/png');
  res.send(OUT_PNG);
});

const PORT = process.env.MOCK_COMFY_PORT || 8188;
app.listen(PORT, () => console.log(`mock comfy on ${PORT}`));
