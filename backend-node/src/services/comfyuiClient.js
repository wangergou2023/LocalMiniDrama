/**
 * ComfyUI Image Generation Client
 * 使用 Z-Image Turbo 工作流通过 ComfyUI API 生图
 */
const https = require('https');
const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

// Z-Image 工作流模板（Pixelle-Video 格式）
const ZIMAGE_WORKFLOW = {
  "1": {"inputs":{"unet_name":"z_image_turbo_bf16.safetensors","weight_dtype":"default"},"class_type":"UNETLoader","_meta":{"title":"UNETLoader"}},
  "3": {"inputs":{"vae_name":"z_image_vae.safetensors"},"class_type":"VAELoader","_meta":{"title":"VAELoader"}},
  "4": {"inputs":{"model":["1",0],"positive":["5",0],"negative":["6",0],"latent_image":["7",0],"seed":900080360242331,"steps":9,"cfg":1,"sampler_name":"euler","scheduler":"simple","denoise":1},"class_type":"KSampler","_meta":{"title":"KSampler"}},
  "6": {"inputs":{"conditioning":["5",0]},"class_type":"ConditioningZeroOut","_meta":{"title":"ConditioningZeroOut"}},
  "7": {"inputs":{"width":["7_w",0],"height":["7_h",0],"batch_size":1},"class_type":"EmptyLatentImage","_meta":{"title":"EmptyLatentImage"}},
  "8": {"inputs":{"samples":["4",0],"vae":["3",0]},"class_type":"VAEDecode","_meta":{"title":"VAEDecode"}},
  "20": {"inputs":{"images":["8",0],"filename_prefix":"ComfyUI"},"class_type":"SaveImage","_meta":{"title":"SaveImage"}},
  "2": {"inputs":{"clip_name":"qwen_3_4b.safetensors","type":"qwen_image","device":"default"},"class_type":"CLIPLoader","_meta":{"title":"CLIPLoader"}},
  "5_text": {"inputs":{"value":""},"class_type":"PrimitiveStringMultiline","_meta":{"title":"Prompt"}},
  "5": {"inputs":{"clip":["2",0],"text":["5_text",0]},"class_type":"CLIPTextEncode","_meta":{"title":"CLIPTextEncode"}},
  "7_w": {"inputs":{"value":720},"class_type":"INTConstant","_meta":{"title":"Width"}},
  "7_h": {"inputs":{"value":1280},"class_type":"INTConstant","_meta":{"title":"Height"}}
};

// 尺寸映射：LocalMiniDrama 格式 → 像素
function parseSize(size) {
  if (!size) return { w: 720, h: 1280 };
  // 支持 "16:9", "1024x1024", "720x1280" 等格式
  if (size.includes(':')) {
    const [rw, rh] = size.split(':').map(Number);
    const base = 720;
    const ratio = rw / rh;
    return { w: Math.round(base * ratio), h: base };
  }
  const parts = size.split('x').map(Number);
  if (parts.length === 2 && parts[0] && parts[1]) {
    return { w: parts[0], h: parts[1] };
  }
  return { w: 720, h: 1280 };
}

function postJSON(url, body, timeoutMs = 120000) {
  return new Promise((resolve, reject) => {
    const parsed = new URL(url);
    const mod = parsed.protocol === 'https:' ? https : http;
    const bodyStr = JSON.stringify(body);
    const options = {
      hostname: parsed.hostname,
      port: parsed.port || (parsed.protocol === 'https:' ? 443 : 80),
      path: parsed.pathname + parsed.search,
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(bodyStr),
      },
    };
    const req = mod.request(options, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => {
        const raw = Buffer.concat(chunks).toString('utf-8');
        if (res.statusCode < 200 || res.statusCode >= 300) {
          return reject(new Error(`ComfyUI HTTP ${res.statusCode}: ${raw.slice(0, 300)}`));
        }
        try { resolve(JSON.parse(raw)); } catch (_) { reject(new Error(`ComfyUI parse error: ${raw.slice(0, 200)}`)); }
      });
      res.on('error', reject);
    });
    req.setTimeout(timeoutMs, () => { req.destroy(); reject(new Error('ComfyUI request timeout')); });
    req.on('error', reject);
    req.write(bodyStr);
    req.end();
  });
}

function getJSON(url, timeoutMs = 30000) {
  return new Promise((resolve, reject) => {
    const parsed = new URL(url);
    const mod = parsed.protocol === 'https:' ? https : http;
    const req = mod.get({
      hostname: parsed.hostname,
      port: parsed.port || (parsed.protocol === 'https:' ? 443 : 80),
      path: parsed.pathname + parsed.search,
    }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => {
        const raw = Buffer.concat(chunks).toString('utf-8');
        try { resolve(JSON.parse(raw)); } catch (_) { resolve(null); }
      });
      res.on('error', reject);
    });
    req.setTimeout(timeoutMs, () => { req.destroy(); reject(new Error('ComfyUI get timeout')); });
    req.on('error', reject);
  });
}

/**
 * 提交 ComfyUI 工作流并等待完成，下载生成的图片到本地
 * @param {object} config - { base_url, api_key?, model? }
 * @param {object} log
 * @param {object} opts - { prompt, size, image_gen_id, files_base_url, storage_local_path }
 * @returns {object} { prompt_id, image_path, image_url }
 */
async function callComfyUIImageApi(config, log, opts) {
  const { prompt, size, image_gen_id, files_base_url, storage_local_path } = opts;
  const baseUrl = (config.base_url || 'http://127.0.0.1:8188').replace(/\/$/, '');

  log.info('[ComfyUI] Starting image generation', { baseUrl, size, prompt: prompt?.slice(0, 80) });

  // 1. 构建工作流
  const workflow = JSON.parse(JSON.stringify(ZIMAGE_WORKFLOW));
  const dims = parseSize(size);

  // 注入参数
  const seed = Math.floor(Math.random() * 9007199254740991);
  workflow['5_text'].inputs.value = prompt || '';
  workflow['7_w'].inputs.value = dims.w;
  workflow['7_h'].inputs.value = dims.h;
  workflow['4'].inputs.seed = seed;

  const payload = {
    prompt: workflow,
    client_id: `localminidrama_${Date.now()}`,
  };

  // 2. 提交工作流
  let submitResp;
  try {
    submitResp = await postJSON(`${baseUrl}/prompt`, payload, 30000);
  } catch (e) {
    throw new Error(`ComfyUI submit failed: ${e.message}`);
  }

  const promptId = submitResp.prompt_id;
  if (!promptId) {
    throw new Error(`ComfyUI submit returned no prompt_id: ${JSON.stringify(submitResp)}`);
  }
  log.info(`[ComfyUI] Submitted prompt_id=${promptId}`);

  // 3. 等待完成（最长 10 分钟）
  const startTime = Date.now();
  const maxWait = 600000;
  let result = null;
  while (Date.now() - startTime < maxWait) {
    await new Promise((r) => setTimeout(r, 3000));
    try {
      const hist = await getJSON(`${baseUrl}/history/${promptId}`, 10000);
      if (hist && hist[promptId]) {
        const status = hist[promptId].status;
        if (status && status.completed) {
          result = hist[promptId];
          break;
        }
        if (status && status.status_str === 'error') {
          const msgs = status.messages || [];
          const errMsg = msgs.find((m) => m[0] === 'execution_error');
          throw new Error(errMsg ? errMsg[1].exception_message : 'ComfyUI execution error');
        }
      }
    } catch (e) {
      if (!e.message.includes('ComfyUI')) {
        // Network error, retry
        log.warn(`[ComfyUI] Poll error: ${e.message}`);
      } else {
        throw e;
      }
    }
  }

  if (!result) {
    throw new Error('ComfyUI generation timed out after 10 minutes');
  }

  // 4. 提取图片文件名
  const outputs = result.outputs || {};
  let imageFilename = null;
  for (const [, out] of Object.entries(outputs)) {
    if (out.images && out.images.length > 0) {
      imageFilename = out.images[0].filename;
      break;
    }
  }

  if (!imageFilename) {
    throw new Error('ComfyUI completed but no image found in outputs');
  }

  const imageUrl = `${baseUrl}/view?filename=${imageFilename}&type=output`;

  // 5. 下载图片到本地存储
  const localDir = storage_local_path || path.join(process.cwd(), 'data', 'storage');
  if (!fs.existsSync(localDir)) fs.mkdirSync(localDir, { recursive: true });

  const localFilename = image_gen_id ? `${image_gen_id}.png` : `comfyui_${Date.now()}.png`;
  const localPath = path.join(localDir, localFilename);

  try {
    await downloadFile(imageUrl, localPath);
  } catch (e) {
    // 如果下载失败，返回远程 URL
    log.warn(`[ComfyUI] Download failed, using remote URL: ${e.message}`);
    return {
      prompt_id: promptId,
      image_path: imageUrl,
      image_url: imageUrl,
    };
  }

  const localUrl = files_base_url ? `${files_base_url.replace(/\/$/, '')}/${path.basename(localDir)}/${localFilename}` : imageUrl;

  log.info(`[ComfyUI] Image saved: ${localPath}`);

  return {
    prompt_id: promptId,
    image_path: localPath,
    image_url: localUrl,
  };
}

function downloadFile(url, destPath) {
  return new Promise((resolve, reject) => {
    const parsed = new URL(url);
    const mod = parsed.protocol === 'https:' ? https : http;
    const file = fs.createWriteStream(destPath);
    mod.get({
      hostname: parsed.hostname,
      port: parsed.port || (parsed.protocol === 'https:' ? 443 : 80),
      path: parsed.pathname + parsed.search,
    }, (res) => {
      if (res.statusCode < 200 || res.statusCode >= 300) {
        file.close();
        fs.unlink(destPath, () => {});
        return reject(new Error(`Download failed: HTTP ${res.statusCode}`));
      }
      res.pipe(file);
      file.on('finish', () => { file.close(); resolve(); });
      file.on('error', (e) => { fs.unlink(destPath, () => {}); reject(e); });
    }).on('error', (e) => { fs.unlink(destPath, () => {}); reject(e); });
  });
}

module.exports = { callComfyUIImageApi, parseSize };
