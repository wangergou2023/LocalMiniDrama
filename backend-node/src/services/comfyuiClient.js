/**
 * ComfyUI Image Generation Client
 * 支持 Qwen-Image-Edit-2511（多参考图/图像编辑，GGUF）和 Z-Image Turbo（纯文生图）
 */
const https = require('https');
const http = require('http');
const fs = require('fs');
const path = require('path');

const ZIMAGE_WORKFLOW = {
  "1": {"inputs":{"unet_name":"z_image_turbo_bf16.safetensors","weight_dtype":"default"},"class_type":"UNETLoader"},
  "3": {"inputs":{"vae_name":"z_image_vae.safetensors"},"class_type":"VAELoader"},
  "4": {"inputs":{"model":["1",0],"positive":["5",0],"negative":["6",0],"latent_image":["7",0],"seed":42,"steps":9,"cfg":1,"sampler_name":"euler","scheduler":"simple","denoise":1},"class_type":"KSampler"},
  "6": {"inputs":{"conditioning":["5",0]},"class_type":"ConditioningZeroOut"},
  "7": {"inputs":{"width":720,"height":1280,"batch_size":1},"class_type":"EmptyLatentImage"},
  "8": {"inputs":{"samples":["4",0],"vae":["3",0]},"class_type":"VAEDecode"},
  "20": {"inputs":{"images":["8",0],"filename_prefix":"ComfyUI"},"class_type":"SaveImage"},
  "2": {"inputs":{"clip_name":"qwen_3_4b.safetensors","type":"qwen_image","device":"default"},"class_type":"CLIPLoader"},
  "5": {"inputs":{"clip":["2",0],"text":""},"class_type":"CLIPTextEncode"}
};

function parseSize(size) {
  if (!size) return { w: 1024, h: 1024 };
  if (size.includes(':')) {
    const [rw, rh] = size.split(':').map(Number);
    const base = 1024;
    return { w: Math.round(base * rw / rh), h: base };
  }
  const parts = size.split('x').map(Number);
  if (parts.length === 2 && parts[0] && parts[1]) return { w: parts[0], h: parts[1] };
  return { w: 1024, h: 1024 };
}

function postJSON(url, body, timeoutMs = 120000) {
  return new Promise((resolve, reject) => {
    const parsed = new URL(url);
    const mod = parsed.protocol === 'https:' ? https : http;
    const bodyStr = JSON.stringify(body);
    const options = {
      hostname: parsed.hostname, port: parsed.port || (parsed.protocol === 'https:' ? 443 : 80),
      path: parsed.pathname + parsed.search, method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(bodyStr) },
    };
    const req = mod.request(options, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => {
        const raw = Buffer.concat(chunks).toString('utf-8');
        if (res.statusCode < 200 || res.statusCode >= 300) {
          return reject(new Error('ComfyUI HTTP ' + res.statusCode + ': ' + raw.slice(0, 300)));
        }
        try { resolve(JSON.parse(raw)); } catch (_) { reject(new Error('ComfyUI parse error: ' + raw.slice(0, 200))); }
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
    const req = mod.get({ hostname: parsed.hostname, port: parsed.port || (parsed.protocol === 'https:' ? 443 : 80), path: parsed.pathname + parsed.search }, (res) => {
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

function httpDownload(url, destPath) {
  return new Promise((resolve, reject) => {
    const parsed = new URL(url);
    const mod = parsed.protocol === 'https:' ? https : http;
    const file = fs.createWriteStream(destPath);
    mod.get({ hostname: parsed.hostname, port: parsed.port || (parsed.protocol === 'https:' ? 443 : 80), path: parsed.pathname + parsed.search }, (res) => {
      if (res.statusCode < 200 || res.statusCode >= 300) {
        file.close();
        try { fs.unlinkSync(destPath); } catch (_) {}
        return reject(new Error('Download failed: HTTP ' + res.statusCode));
      }
      res.pipe(file);
      file.on('finish', () => { file.close(); resolve(); });
      file.on('error', (e) => { try { fs.unlinkSync(destPath); } catch (_) {} reject(e); });
    }).on('error', (e) => { try { fs.unlinkSync(destPath); } catch (_) {} reject(e); });
  });
}

async function prepareReferenceImages(referenceUrls, comfyuiInputDir, log, storageLocalPath) {
  if (!Array.isArray(referenceUrls) || referenceUrls.length === 0) return [];
  const filenames = [];
  const srcIndices = [];
  for (let i = 0; i < referenceUrls.length; i++) {
    const ref = referenceUrls[i];
    if (!ref) continue;
    try {
      const name = 'ref_' + Date.now() + '_' + i + '.png';
      const destPath = path.join(comfyuiInputDir, name);
      let via = null;
      if (ref.startsWith('data:')) {
        const base64Data = ref.replace(/^data:image\/\w+;base64,/, '');
        fs.writeFileSync(destPath, Buffer.from(base64Data, 'base64'));
        via = 'base64';
      } else if (ref.startsWith('http://') || ref.startsWith('https://')) {
        await httpDownload(ref, destPath);
        via = 'http';
      } else if (fs.existsSync(ref)) {
        fs.copyFileSync(ref, destPath);
        via = 'abs-path';
      } else if (storageLocalPath && fs.existsSync(path.join(storageLocalPath, ref.replace(/^\//, '')))) {
        fs.copyFileSync(path.join(storageLocalPath, ref.replace(/^\//, '')), destPath);
        via = 'storage-rel';
      } else {
        log.warn('[ComfyUI] 参考图 ' + (i + 1) + '/' + referenceUrls.length + ' 未找到，跳过: ' + String(ref).slice(0, 160));
        continue;
      }
      log.info('[ComfyUI] 参考图 ' + (i + 1) + '/' + referenceUrls.length + ' 已就绪 (' + via + '): ' + String(ref).slice(0, 120) + ' -> ' + name);
      filenames.push(name);
      srcIndices.push(i);
    } catch (e) {
      log.warn('[ComfyUI] 参考图 ' + (i + 1) + '/' + referenceUrls.length + ' 处理失败: ' + String(ref).slice(0, 120) + ' err=' + e.message);
    }
  }
  filenames.srcIndices = srcIndices;
  return filenames;
}

// Qwen-Image-Edit-2511 GGUF 工作流固定文件名（models 目录下）
const QWEN_EDIT_FILES = {
  unet: 'qwen-image-edit-2511-Q4_K_M.gguf',
  clip: 'qwen_2.5_vl_7b_fp8_scaled.safetensors',
  vae: 'qwen_image_vae.safetensors',
  lightning_lora: 'Qwen-Image-Edit-2509-Lightning-4steps-V1.0-bf16.safetensors',
  angles_lora: 'qwen-image-edit-2511-multiple-angles-lora.safetensors',
};

/** Qwen-Edit 输出尺寸：保持宽高比，总像素压到 ~1.5MP 内，边长对齐 16 */
function qwenDims(size) {
  const d = parseSize(size);
  const maxPx = 1664 * 928;
  const px = d.w * d.h;
  const scale = px > maxPx ? Math.sqrt(maxPx / px) : 1;
  const w = Math.max(512, Math.round(d.w * scale / 16) * 16);
  const h = Math.max(512, Math.round(d.h * scale / 16) * 16);
  return { w, h };
}

/**
 * 按参考图标签分组：首帧站位锁+场景 / 角色 / 道具（无标签的归入道具组）。
 * labels 形如 'Image 2: character appearance reference for "张伟" ...'，与 refs 按下标对齐。
 */
function groupQwenRefs(refFilenames, labels) {
  const groups = { lock: [], scene: [], chars: [], props: [] };
  const names = { chars: [], props: [] };
  for (let i = 0; i < refFilenames.length; i++) {
    const lbl = (labels && labels[i]) || '';
    const nameMatch = lbl.match(/for\s+"([^"]+)"/i);
    const name = nameMatch ? nameMatch[1] : '';
    if (/LAYOUT_LOCK/i.test(lbl)) {
      groups.lock.push(refFilenames[i]);
    } else if (/scene background/i.test(lbl)) {
      groups.scene.push(refFilenames[i]);
    } else if (/character appearance/i.test(lbl)) {
      groups.chars.push(refFilenames[i]);
      names.chars.push(name || ('角色' + (groups.chars.length)));
    } else {
      groups.props.push(refFilenames[i]);
      names.props.push(name || ('物品' + (groups.props.length)));
    }
  }
  return { groups, names };
}

/**
 * Qwen-Image-Edit-2511（GGUF Q4_K_M + Lightning 4步）工作流。
 * 参考官方 image_qwen_image_edit_2509 模板 Raw Latent 变体：
 *   UNET(GGUF) → LoRA → ModelSamplingAuraFlow(3) → CFGNorm → KSampler(4步 cfg1)
 *   TextEncodeQwenImageEditPlus 原生吃 image1..3（视觉token+参考潜变量）
 *   三通道分配：image1=场景整图，image2=全部角色 ImageStitch 横拼，image3=全部道具横拼
 * prompt 含 <sks> 触发词时自动加挂 Multiple-Angles 机位 LoRA。
 * 返回 { wf, header }：header 为按通道生成的中文参考说明，需拼在提示词前。
 */
function buildQwenEditWorkflow(prompt, dims, seed, refFilenames, refLabels) {
  const useAnglesLora = /<sks>/i.test(prompt || '');
  const wf = {
    'unet': { inputs: { unet_name: QWEN_EDIT_FILES.unet }, class_type: 'UnetLoaderGGUF' },
    'clip': { inputs: { clip_name: QWEN_EDIT_FILES.clip, type: 'qwen_image', device: 'default' }, class_type: 'CLIPLoader' },
    'vae': { inputs: { vae_name: QWEN_EDIT_FILES.vae }, class_type: 'VAELoader' },
    'lora_lightning': { inputs: { lora_name: QWEN_EDIT_FILES.lightning_lora, strength_model: 1, model: ['unet', 0] }, class_type: 'LoraLoaderModelOnly' },
    'shift': { inputs: { shift: 3, model: [useAnglesLora ? 'lora_angles' : 'lora_lightning', 0] }, class_type: 'ModelSamplingAuraFlow' },
    'cfgnorm': { inputs: { strength: 1, model: ['shift', 0] }, class_type: 'CFGNorm' },
    'pos': { inputs: { clip: ['clip', 0], prompt: prompt || '', vae: ['vae', 0] }, class_type: 'TextEncodeQwenImageEditPlus' },
    'negp': { inputs: { clip: ['clip', 0], prompt: '' }, class_type: 'TextEncodeQwenImageEditPlus' },
    'latent': { inputs: { width: dims.w, height: dims.h, batch_size: 1 }, class_type: 'EmptySD3LatentImage' },
    'sampler': { inputs: { seed, steps: 4, cfg: 1, sampler_name: 'euler', scheduler: 'simple', denoise: 1, model: ['cfgnorm', 0], positive: ['pos', 0], negative: ['negp', 0], latent_image: ['latent', 0] }, class_type: 'KSampler' },
    'decode': { inputs: { samples: ['sampler', 0], vae: ['vae', 0] }, class_type: 'VAEDecode' },
    'save': { inputs: { images: ['decode', 0], filename_prefix: 'LocalMiniDrama_qwen' }, class_type: 'SaveImage' },
  };
  if (useAnglesLora) {
    wf['lora_angles'] = { inputs: { lora_name: QWEN_EDIT_FILES.angles_lora, strength_model: 1, model: ['lora_lightning', 0] }, class_type: 'LoraLoaderModelOnly' };
  }

  /** 组内多图 → LoadImage(+ImageStitch 横拼) → 返回可接入 image1..3 的 [nodeKey, 0] */
  let nodeSeq = 0;
  function buildGroupInput(files, tag) {
    const imgKeys = files.map((f) => {
      const k = 'ld_' + tag + '_' + (nodeSeq++);
      wf[k] = { inputs: { image: f }, class_type: 'LoadImage' };
      return k;
    });
    let prev = imgKeys[0];
    for (let i = 1; i < imgKeys.length; i++) {
      const sk = 'st_' + tag + '_' + (nodeSeq++);
      wf[sk] = {
        inputs: {
          image1: [prev, 0], image2: [imgKeys[i], 0],
          direction: 'right', match_image_size: true, spacing_width: 16, spacing_color: 'white'
        },
        class_type: 'ImageStitch'
      };
      prev = sk;
    }
    return [prev, 0];
  }

  const { groups, names } = groupQwenRefs(refFilenames, refLabels || []);
  const slots = [];
  const headerLines = [];
  const slot1Files = [...groups.lock, ...groups.scene.slice(0, 1)];
  if (slot1Files.length) {
    let desc;
    if (groups.lock.length && groups.scene.length) {
      desc = '左为首帧画面参考（保持构图与人物站位一致），右为场景环境参考（只取空间、光线与氛围）';
    } else if (groups.lock.length) {
      desc = '首帧画面参考（保持构图、人物站位与环境一致，仅演化动作与表情）';
    } else {
      desc = '场景环境参考（只取空间布局、光线与氛围，禁止照搬其取景/构图）';
    }
    slots.push({ input: buildGroupInput(slot1Files, 'scene'), desc });
  }
  if (groups.chars.length) {
    slots.push({
      input: buildGroupInput(groups.chars, 'char'),
      desc: groups.chars.length > 1
        ? `角色外貌参考拼图，从左到右依次为：${names.chars.join('、')}（严格保持每个人的长相、发型、服装）`
        : `角色「${names.chars[0]}」外貌参考（严格保持长相、发型、服装）`
    });
  }
  if (groups.props.length) {
    slots.push({
      input: buildGroupInput(groups.props, 'prop'),
      desc: groups.props.length > 1
        ? `道具外观参考拼图，从左到右依次为：${names.props.join('、')}`
        : `道具「${names.props[0]}」外观参考`
    });
  }
  for (let i = 0; i < Math.min(slots.length, 3); i++) {
    wf['pos'].inputs['image' + (i + 1)] = slots[i].input;
    headerLines.push(`图${i + 1}：${slots[i].desc}`);
  }
  const header = headerLines.length
    ? headerLines.join('\n') + '\n\n生成一张全新的单幅完整画面（禁止拼贴、分屏、宫格）：\n'
    : '';
  return { wf, header };
}

async function callComfyUIImageApi(config, log, opts) {
  const { prompt, size, image_gen_id, reference_image_urls, files_base_url, storage_local_path } = opts;
  const baseUrl = (config.base_url || 'http://127.0.0.1:8188').replace(/\/$/, '');
  const hasRefs = Array.isArray(reference_image_urls) && reference_image_urls.some(Boolean);

  // 优先用上游解析好的模型名（default_model/请求指定），回退到配置模型列表拼接
  const modelStr = (opts.model && String(opts.model).trim())
    || (Array.isArray(config.model) ? config.model.join(',') : (config.model || ''));
  const isZImage = modelStr.toLowerCase().includes('z-image');
  // z-image 走纯文生图；其余（含 qwen、空、未知）一律走 Qwen-Edit
  const isQwenEdit = !isZImage;
  const workflowName = isQwenEdit ? 'Qwen-Edit-2511' : 'Z-Image Turbo';

  log.info('[ComfyUI/' + workflowName + '] Starting generation', {
    baseUrl, size, hasRefs,
    prompt: prompt ? prompt.slice(0, 80) : '',
    model: modelStr
  });

  // 准备参考图
  const inputDir = path.join(process.env.HOME || '/home/wangergou', 'ComfyUI', 'input');
  if (!fs.existsSync(inputDir)) fs.mkdirSync(inputDir, { recursive: true });
  let refFilenames = [];
  if (hasRefs) {
    refFilenames = await prepareReferenceImages(reference_image_urls.filter(Boolean), inputDir, log, storage_local_path);
    log.info('[ComfyUI/' + workflowName + '] Prepared ' + refFilenames.length + ' reference images');
  }

  // 选择工作流
  const dims = isQwenEdit ? qwenDims(size) : parseSize(size);
  const seed = Math.floor(Math.random() * 9007199254740991);
  let workflow;
  let finalPrompt = prompt || '';
  if (isQwenEdit) {
    // Qwen 用原始提示词（不要 imageClient 注入的英文 Image N 头），标签按下载成功的下标对齐
    const rawPrompt = (opts.raw_prompt && String(opts.raw_prompt).trim()) || (prompt || '');
    const srcIndices = refFilenames.srcIndices || refFilenames.map((_, i) => i);
    const alignedLabels = srcIndices.map((si) => (opts.reference_labels || [])[si] || '');
    const built = buildQwenEditWorkflow(rawPrompt, dims, seed, refFilenames, alignedLabels);
    workflow = built.wf;
    finalPrompt = built.header + rawPrompt;
    workflow['pos'].inputs.prompt = finalPrompt;
    log.info('[ComfyUI/Qwen-Edit-2511] 参考图 ' + refFilenames.length + ' 张 → ' + Math.min(3, Object.keys(workflow).filter(k => k.startsWith('ld_')).length ? (workflow['pos'].inputs.image3 ? 3 : workflow['pos'].inputs.image2 ? 2 : 1) : 0) + ' 个通道 (场景/角色拼图/道具拼图)'
      + (/<sks>/i.test(rawPrompt) ? ' + 机位LoRA' : '') + ', 输出 ' + dims.w + 'x' + dims.h);
  } else {
    workflow = JSON.parse(JSON.stringify(ZIMAGE_WORKFLOW));
    // Z-Image: 直接注入到 CLIPTextEncode 和 EmptyLatentImage
    workflow['5'].inputs.text = prompt || '';
    workflow['7'].inputs.width = dims.w;
    workflow['7'].inputs.height = dims.h;
    workflow['4'].inputs.seed = seed;
  }

  const payload = { prompt: workflow, client_id: 'localminidrama_' + Date.now() };
  log.info('[ComfyUI/' + workflowName + '] 最终提交: 节点=' + Object.keys(workflow).length
    + ', 参考图=' + refFilenames.length
    + ', 尺寸=' + dims.w + 'x' + dims.h
    + '\n[ComfyUI] PROMPT 全文:\n' + (finalPrompt || '(空)'));

  // 提交
  let submitResp;
  try {
    submitResp = await postJSON(baseUrl + '/prompt', payload, 30000);
  } catch (e) {
    throw new Error('ComfyUI submit failed: ' + e.message);
  }
  const promptId = submitResp.prompt_id;
  if (!promptId) throw new Error('ComfyUI submit returned no prompt_id');
  log.info('[ComfyUI] Submitted prompt_id=' + promptId);

  // 等待完成
  const startTime = Date.now();
  const maxWait = 900000;
  let result = null;
  while (Date.now() - startTime < maxWait) {
    await new Promise((r) => setTimeout(r, 5000));
    try {
      const hist = await getJSON(baseUrl + '/history/' + promptId, 10000);
      if (hist && hist[promptId]) {
        const status = hist[promptId].status;
        if (status && status.completed) { result = hist[promptId]; break; }
        if (status && status.status_str === 'error') {
          const errMsg = (status.messages || []).find(function(m) { return m[0] === 'execution_error'; });
          throw new Error(errMsg ? errMsg[1].exception_message : 'ComfyUI execution error');
        }
      }
    } catch (e) {
      if (e.message && (e.message.indexOf('ComfyUI execution error') >= 0 || e.message.indexOf('ComfyUI get timeout') >= 0)) throw e;
      log.warn('[ComfyUI] Poll error: ' + e.message);
    }
  }
  if (!result) throw new Error('ComfyUI generation timed out');

  // 提取图片
  let imageFilename = null;
  var outs = result.outputs || {};
  var keys = Object.keys(outs);
  for (var i = 0; i < keys.length; i++) {
    var out = outs[keys[i]];
    if (out.images && out.images.length > 0) { imageFilename = out.images[0].filename; break; }
  }
  if (!imageFilename) throw new Error('ComfyUI completed but no image found');

  var imageUrl = baseUrl + '/view?filename=' + imageFilename + '&type=output';
  log.info('[ComfyUI/' + workflowName + '] Done: ' + imageUrl);
  return { image_url: imageUrl };
}


// LTX 2.3 图生视频工作流（基于 WYC-LTX2.3 工作流）
// 注意：当前存在 audio+video tensor 兼容性问题，通过 API 提交可能失败，经 ComfyUI UI 直接加载可正常工作

async function callComfyUIVideoApi(config, log, opts) {
  const { prompt, model, image_url, video_gen_id, files_base_url, storage_local_path } = opts;
  const baseUrl = (config.base_url || "http://127.0.0.1:8188").replace(/\/$/, "");

  // 使用已保存的完整工作流文件
  const fs = require("fs");
  const wfPath = require("path").join(require("os").homedir(), "ComfyUI", "user", "default", "workflows", "WYC-LTX2.3图生视频.json");
  
  if (!fs.existsSync(wfPath)) {
    throw new Error("LTX workflow not found: " + wfPath);
  }

  const wf = JSON.parse(fs.readFileSync(wfPath, "utf-8"));
  
  const SKIP_TYPES = new Set(["MarkdownNote"]);
  const SKIP_IDS = new Set([]); // Keep all nodes, replace missing LoRA files // I2V adapter LoRA not available
  
  const prompt_data = {};
  const links_by_id = {};
  for (const l of wf.links || []) {
    if (Array.isArray(l) && l.length >= 5) {
      links_by_id[l[0]] = { from_id: l[1], from_slot: l[2], to_id: l[3], to_slot: l[4] };
    }
  }

  for (const n of wf.nodes) {
    if (SKIP_TYPES.has(n.type) || SKIP_IDS.has(n.id)) continue;
    const nid = String(n.id);
    const node_info = { inputs: {} };
    const ws = n.widgets_values || [];
    let wi = 0;

    for (const inp of n.inputs || []) {
      const name = inp.name;
      const link = inp.link;

      if (link != null) {
        const l = links_by_id[link];
        if (l) {
          let sid = l.from_id;
          let ss = l.from_slot;
          
          // Rewire around skipped I2V adapter LoRA (node 184)
          if (sid === 184) {
            for (const [lid, l2] of Object.entries(links_by_id)) {
              if (l2.to_id === 184 && l2.to_slot === 0) {
                sid = l2.from_id;
                ss = l2.from_slot;
                break;
              }
            }
          }
          
          if (!SKIP_IDS.has(sid)) {
            node_info.inputs[name] = [String(sid), ss];
          }
        }
        // Always advance widget index for linked widgets too
        if (inp.widget) {
          if (wi < ws.length) {
            const wname = inp.widget.name;
            if (wname === "seed" && wi + 1 < ws.length && typeof ws[wi + 1] === "string") {
              wi += 2;
            } else {
              wi += 1;
            }
          }
        }
      } else if (inp.widget) {
        const wname = inp.widget.name;
        if (wname === "seed" && wi + 1 < ws.length && typeof ws[wi + 1] === "string") {
          node_info.inputs[name] = ws[wi];
          wi += 2;
        } else {
          if (wi < ws.length) {
            node_info.inputs[name] = ws[wi];
            wi += 1;
          }
        }
      }
    }
    node_info.class_type = n.type;
    prompt_data[nid] = node_info;
  }

  // Replace missing I2V adapter LoRA with available distilled LoRA
  for (const [nid, node] of Object.entries(prompt_data)) {
    if (node.class_type === "LoraLoaderModelOnly") {
      const loraName = node.inputs.lora_name || "";
      if (loraName.includes("Image2Vid") || loraName.includes("I2V")) {
        node.inputs.lora_name = "ltx-2.3-22b-distilled-lora-dynamic_fro09_avg_rank_105_bf16.safetensors"
        log.info("[ComfyUI/LTX] Replaced missing I2V LoRA with available distilled LoRA");
      }
    }
  }

  // fps=24, frames 8n+1
  const fps = 24;
  const videoDuration = Number(opts.duration) || 5;
  const frames = Math.max(9, Math.round(videoDuration * fps / 8) * 8 + 1);

  // Adjust video resolution based on aspect ratio
  const ratio = (opts.aspect_ratio || '').toString();
  const [rw, rh] = ratio.includes(':') ? ratio.split(':').map(Number) : [9, 16];
  const totalPx = 768 * 512; const ratioVal = rw / rh;
  const vidW = Math.max(256, Math.round(Math.sqrt(totalPx * ratioVal) / 32) * 32);
  const vidH = Math.max(256, Math.round(Math.sqrt(totalPx / ratioVal) / 32) * 32);

  for (const [nid, node] of Object.entries(prompt_data)) {
    if (node.class_type === "PrimitiveInt" && parseInt(node.inputs.value) === 97) node.inputs.value = frames;
    if (node.class_type === "PrimitiveInt" && parseInt(node.inputs.value) === 24) node.inputs.value = fps;
    if (node.class_type === "PrimitiveFloat" && parseFloat(node.inputs.value) === 24) node.inputs.value = fps;
    if (node.class_type === "EmptyLTXVLatentVideo") {
      node.inputs.length = frames;
      node.inputs.width = vidW;
      node.inputs.height = vidH;
    }
    // Increase I2V strength to better match reference image
    if (node.class_type === "LTXVImgToVideoInplace" && node.inputs.strength != null && node.inputs.strength < 0.95) {
      node.inputs.strength = 0.8;
    }
  }
  log.info("[ComfyUI/LTX] Duration: " + videoDuration + "s, frames: " + frames + ", fps: " + fps + ", size: " + vidW + "x" + vidH + " (aspect: " + ratio + ")");

  // Set input image（支持 http(s) / data: / 本地绝对路径 / storage 相对路径）
  const inputDir = require("path").join(require("os").homedir(), "ComfyUI", "input");
  if (!fs.existsSync(inputDir)) fs.mkdirSync(inputDir, { recursive: true });
  let imgName = "example.png";
  if (image_url) {
    const prepared = await prepareReferenceImages([image_url], inputDir, log, storage_local_path);
    if (prepared.length > 0) imgName = prepared[0];
    else log.warn("[ComfyUI/LTX] Failed to prepare input image: " + String(image_url).slice(0, 120));
  }

  for (const [nid, node] of Object.entries(prompt_data)) {
    if (node.class_type === "LoadImage") {
      node.inputs.image = imgName;
    }
    if (node.class_type === "CLIPTextEncode") {
      // Inject prompt from LocalMiniDrama into the first CLIPTextEncode (positive prompt)
      if (!node.inputs.text || nid === "121") {
        node.inputs.text = prompt || node.inputs.text || "";
      }
    }
  }

  log.info("[ComfyUI/LTX] Using image: " + imgName + " Submitting " + Object.keys(prompt_data).length + " nodes");
  
  // Submit via REST API
  const https = require("https");
  const http = require("http");
  
  const payload = JSON.stringify({ prompt: prompt_data, client_id: "localminidrama_ltx_" + Date.now() });
  const parsed = new URL(baseUrl + "/prompt");
  const mod = parsed.protocol === "https:" ? https : http;
  
  const submitResult = await new Promise((resolve, reject) => {
    const req = mod.request({
      hostname: parsed.hostname, port: parsed.port || (parsed.protocol === "https:" ? 443 : 80),
      path: parsed.pathname, method: "POST",
      headers: { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(payload) }
    }, (res) => {
      let data = "";
      res.on("data", c => data += c);
      res.on("end", () => {
        try { resolve(JSON.parse(data)); } catch (e) { reject(new Error("ComfyUI parse error: " + data.slice(0, 200))); }
      });
    });
    req.setTimeout(30000, () => { req.destroy(); reject(new Error("ComfyUI submit timeout")); });
    req.on("error", reject);
    req.write(payload);
    req.end();
  });

  const promptId = submitResult.prompt_id;
  if (!promptId) throw new Error("ComfyUI submit failed: " + JSON.stringify(submitResult).slice(0, 200));

  log.info("[ComfyUI/LTX] Submitted prompt_id=" + promptId);

  // Wait for result
  const startTime = Date.now();
  const maxWait = 1200000; // 20 min for LTX video
  let result = null;
  
  while (Date.now() - startTime < maxWait) {
    await new Promise(r => setTimeout(r, 5000));
    try {
      const hist = await new Promise((resolve, reject) => {
        const req = mod.get({
          hostname: parsed.hostname, port: parsed.port || (parsed.protocol === "https:" ? 443 : 80),
          path: "/history/" + promptId
        }, (res) => {
          let data = "";
          res.on("data", c => data += c);
          res.on("end", () => { try { resolve(JSON.parse(data)); } catch (e) { resolve(null); } });
        });
        req.setTimeout(10000, () => { req.destroy(); resolve(null); });
        req.on("error", () => resolve(null));
      });
      
      if (hist && hist[promptId]) {
        const status = hist[promptId].status;
        if (status && status.completed) { result = hist[promptId]; break; }
        if (status && status.status_str === "error") {
          const msgs = status.messages || [];
          const errMsg = msgs.find(m => m[0] === "execution_error");
          throw new Error(errMsg ? errMsg[1].exception_message : "ComfyUI execution error");
        }
      }
    } catch (e) {
      if (e.message.includes("ComfyUI execution error") || e.message.includes("Sizes of tensors")) throw e;
      log.warn("[ComfyUI/LTX] Poll error: " + e.message);
    }
  }

  if (!result) throw new Error("ComfyUI LTX generation timed out");

  // Extract video
  let videoFilename = null;
  let subfolder = null;
  for (const [, out] of Object.entries(result.outputs || {})) {
    if (out.gifs && out.gifs.length > 0) {
      videoFilename = out.gifs[0].filename;
      subfolder = out.gifs[0].subfolder || "";
      break;
    }
    if (out.images && out.animated) {
      videoFilename = out.images[0].filename;
      subfolder = out.images[0].subfolder || "";
      break;
    }
  }


  const videoUrl = baseUrl + "/view?filename=" + videoFilename + "&type=output&subfolder=" + encodeURIComponent(subfolder);
  log.info("[ComfyUI/LTX] Done: " + videoUrl);
  return { video_url: videoUrl, first_frame_url: image_url || null };
}

module.exports = { callComfyUIImageApi, callComfyUIVideoApi, parseSize };
