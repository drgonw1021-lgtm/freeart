// ComfyUI 工作流模板：所有能力都在这里以模板拼装，模型/LLM 只负责挑能力和调参数
const seed = () => Math.floor(Math.random() * 1e9);
export const NEG = 'lowres, bad anatomy, blurry, watermark, text, deformed, ugly';

const head = (ckpt, pos, neg) => ({
  '1': { class_type: 'CheckpointLoaderSimple', inputs: { ckpt_name: ckpt } },
  '2': { class_type: 'CLIPTextEncode', inputs: { text: pos, clip: ['1', 1] } },
  '3': { class_type: 'CLIPTextEncode', inputs: { text: neg || NEG, clip: ['1', 1] } },
});

const sampler = (latent, cfg, steps, denoise) => ({
  '6': {
    class_type: 'KSampler',
    inputs: {
      seed: seed(), steps, cfg, sampler_name: 'dpmpp_2m', scheduler: 'karras', denoise,
      model: ['1', 0], positive: ['2', 0], negative: ['3', 0], latent_image: latent,
    },
  },
});

const tail = (src) => ({
  '7': { class_type: 'VAEDecode', inputs: { samples: ['6', 0], vae: ['1', 2] } },
  '8': { class_type: 'SaveImage', inputs: { images: [src || '7', 0] } },
});

export function buildTxt2Img({ ckpt, pos, neg, width = 512, height = 512, steps = 24, cfg = 7.5 }) {
  return {
    ...head(ckpt, pos, neg),
    '5': { class_type: 'EmptyLatentImage', inputs: { width, height, batch_size: 1 } },
    ...sampler(['5', 0], cfg, steps, 1.0),
    ...tail(),
  };
}

export function buildImg2Img({ ckpt, pos, neg, imageName, denoise = 0.65, steps = 24, cfg = 7.5 }) {
  return {
    ...head(ckpt, pos, neg),
    '4': { class_type: 'LoadImage', inputs: { image: imageName } },
    '5': { class_type: 'VAEEncode', inputs: { pixels: ['4', 0], vae: ['1', 2] } },
    ...sampler(['5', 0], cfg, steps, denoise),
    ...tail(),
  };
}

export function buildInpaint({ ckpt, pos, neg, imageName, maskName, steps = 28, cfg = 7.5 }) {
  return {
    ...head(ckpt, pos, neg),
    '4': { class_type: 'LoadImage', inputs: { image: imageName } },
    '9': { class_type: 'LoadImageMask', inputs: { image: maskName, channel: 'red' } },
    '5': { class_type: 'VAEEncode', inputs: { pixels: ['4', 0], vae: ['1', 2] } },
    '10': { class_type: 'SetLatentNoiseMask', inputs: { samples: ['5', 0], mask: ['9', 0] } },
    ...sampler(['10', 0], cfg, steps, 1.0),
    ...tail(),
  };
}

/** 扩图：ImagePadForOutpaint 同时给出 padding 后的图与蒙版，走 inpaint 逻辑把新增区域画出来 */
export function buildOutpaint({ ckpt, pos, neg, imageName, left = 0, top = 0, right = 0, bottom = 0 }) {
  return {
    ...head(ckpt, pos, neg),
    '4': { class_type: 'LoadImage', inputs: { image: imageName } },
    '11': { class_type: 'ImagePadForOutpaint', inputs: { image: ['4', 0], left, top, right, bottom, feathering: 40 } },
    '5': { class_type: 'VAEEncode', inputs: { pixels: ['11', 0], vae: ['1', 2] } },
    '10': { class_type: 'SetLatentNoiseMask', inputs: { samples: ['5', 0], mask: ['11', 1] } },
    ...sampler(['10', 0], 7.5, 28, 1.0),
    ...tail(),
  };
}

/** AI 放大（需 RealESRGAN 类放大模型）；无模型时由 planner 回退到 buildEnhance */
export function buildUpscaleModel({ ckpt, pos, neg, imageName, modelName, scale, refine = 0 }) {
  const base = {
    ...head(ckpt, pos, neg),
    '4': { class_type: 'LoadImage', inputs: { image: imageName } },
    '20': { class_type: 'UpscaleModelLoader', inputs: { model_name: modelName } },
    '21': { class_type: 'ImageUpscaleWithModel', inputs: { upscale_model: ['20', 0], image: ['4', 0] } },
  };
  if (!refine) return { ...base, '8': { class_type: 'SaveImage', inputs: { images: ['21', 0] } } };
  return {
    ...base,
    '22': { class_type: 'ImageScale', inputs: { image: ['21', 0], upscale_method: 'bicubic', width: 0, height: 0, crop: 'disabled' } },
    '5': { class_type: 'VAEEncode', inputs: { pixels: ['21', 0], vae: ['1', 2] } },
    ...sampler(['5', 0], 7, Math.round(18 * scale / 2), refine),
    ...tail(),
  };
}

/** 放大 + 轻度重绘补细节（不需要任何额外模型，SD1.5 本体即可） */
export function buildEnhance({ ckpt, pos, neg, imageName, scale = 2, denoise = 0.35, steps = 18 }) {
  return {
    ...head(ckpt, pos, neg),
    '4': { class_type: 'LoadImage', inputs: { image: imageName } },
    '21': { class_type: 'ImageScaleBy', inputs: { image: ['4', 0], upscale_method: 'lanczos', scale_by: scale } },
    '5': { class_type: 'VAEEncode', inputs: { pixels: ['21', 0], vae: ['1', 2] } },
    ...sampler(['5', 0], 7, steps, denoise),
    ...tail(),
  };
}

export function buildUpscaleOnly({ imageName, scale = 2 }) {
  return {
    '4': { class_type: 'LoadImage', inputs: { image: imageName } },
    '21': { class_type: 'ImageScaleBy', inputs: { image: ['4', 0], upscale_method: 'lanczos', scale_by: scale } },
    '8': { class_type: 'SaveImage', inputs: { images: ['21', 0] } },
  };
}

export const BUILDERS = {
  txt2img: buildTxt2Img,
  img2img: buildImg2Img,
  inpaint: buildInpaint,
  outpaint: buildOutpaint,
  upscale: buildUpscaleModel,
  enhance: buildEnhance,
  upscaleOnly: buildUpscaleOnly,
};
