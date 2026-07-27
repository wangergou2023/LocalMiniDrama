/**
 * ComfyUI Image Generation Client
 * 支持 Qwen-Image-Edit-2511（多参考图/图像编辑，GGUF）和 Z-Image Turbo（纯文生图）
 */
const https = require('https');
const http = require('http');
const fs = require('fs');
const path = require('path');

const ZIMAGE_WORKFLOW = {
  "1": {"inputs":{"unet_name":"z-image-turbo-Q4_K_M.gguf"},"class_type":"UnetLoaderGGUF"},
  "3": {"inputs":{"vae_name":"z_image_vae.safetensors"},"class_type":"VAELoader"},
  "4": {"inputs":{"model":["1",0],"positive":["5",0],"negative":["6",0],"latent_image":["7",0],"seed":42,"steps":9,"cfg":1,"sampler_name":"euler","scheduler":"simple","denoise":1},"class_type":"KSampler"},
  "6": {"inputs":{"conditioning":["5",0]},"class_type":"ConditioningZeroOut"},
  "7": {"inputs":{"width":720,"height":1280,"batch_size":1},"class_type":"EmptyLatentImage"},
  "8": {"inputs":{"samples":["4",0],"vae":["3",0]},"class_type":"VAEDecode"},
  "20": {"inputs":{"images":["8",0],"filename_prefix":"ComfyUI"},"class_type":"SaveImage"},
  "2": {"inputs":{"clip_name":"Qwen3-4B-Q4_K_M.gguf","type":"qwen_image","device":"default"},"class_type":"CLIPLoaderGGUF"},
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

/**
 * 队列感知的 ComfyUI 任务等待：
 * - 任务仍在 queue_pending（排队）时不计入执行超时（串行队列里等前面的任务是正常现象）
 * - 仅对 queue_running（实际执行）时间应用 runningBudgetMs
 * - 任务既不在队列也不在历史中连续多次 → 视为丢失
 * - absoluteCapMs 兜底防止无限等待
 * @returns {Promise<object>} history item（status.completed 后返回）
 */
async function waitForComfyJob(baseUrl, promptId, log, { runningBudgetMs, absoluteCapMs, tag }) {
  const startTime = Date.now();
  let runningSince = null;
  let missCount = 0;
  let lastState = '';
  while (Date.now() - startTime < absoluteCapMs) {
    await new Promise((r) => setTimeout(r, 5000));
    let hist = null;
    try {
      hist = await getJSON(baseUrl + '/history/' + promptId, 10000);
    } catch (_) {}
    if (hist && hist[promptId]) {
      const status = hist[promptId].status;
      if (status && status.completed) return hist[promptId];
      if (status && status.status_str === 'error') {
        const errMsg = (status.messages || []).find((m) => m[0] === 'execution_error');
        throw new Error(errMsg ? errMsg[1].exception_message : 'ComfyUI execution error');
      }
    }
    let state = 'unknown';
    try {
      const q = await getJSON(baseUrl + '/queue', 10000);
      const inRunning = (q.queue_running || []).some((it) => it && it[1] === promptId);
      const inPending = (q.queue_pending || []).some((it) => it && it[1] === promptId);
      if (inRunning) state = 'running';
      else if (inPending) state = 'queued';
      else state = 'absent';
    } catch (_) {
      state = 'unknown'; // ComfyUI 暂时失联不算任务丢失
    }
    if (state === 'running') {
      if (runningSince == null) {
        runningSince = Date.now();
        log.info('[ComfyUI' + tag + '] 任务开始执行 prompt_id=' + promptId);
      }
      missCount = 0;
      if (Date.now() - runningSince > runningBudgetMs) {
        throw new Error('ComfyUI' + tag + ' 执行超时（运行超过 ' + Math.round(runningBudgetMs / 60000) + ' 分钟）');
      }
    } else if (state === 'queued') {
      missCount = 0;
      if (lastState !== 'queued') log.info('[ComfyUI' + tag + '] 任务排队中 prompt_id=' + promptId);
    } else if (state === 'absent') {
      // 不在队列也未 completed：可能是 history 写入延迟，连续 3 次才判丢失
      missCount += 1;
      if (missCount >= 3) {
        throw new Error('ComfyUI' + tag + ' 任务丢失（不在队列且无产出，可能被手动取消或 ComfyUI 重启）');
      }
    }
    lastState = state;
  }
  throw new Error('ComfyUI' + tag + ' 等待超过绝对上限 ' + Math.round(absoluteCapMs / 3600000) + ' 小时');
}

async function callComfyUIImageApi(config, log, opts) {
  const { prompt, size, image_gen_id, reference_image_urls, files_base_url, storage_local_path } = opts;
  const baseUrl = (config.base_url || 'http://127.0.0.1:8188').replace(/\/$/, '');
  const hasRefs = Array.isArray(reference_image_urls) && reference_image_urls.some(Boolean);

  // 解析 settings 中的 workflow 字段
  let workflowFile = null;
  if (config.settings) {
    try {
      const s = typeof config.settings === 'string' ? JSON.parse(config.settings) : config.settings;
      if (s.workflow) workflowFile = s.workflow;
    } catch (_) {}
  }

  // 优先用上游解析好的模型名
  const modelStr = (opts.model && String(opts.model).trim())
    || (Array.isArray(config.model) ? config.model.join(',') : (config.model || ''));
  const isZImage = modelStr.toLowerCase().includes('z-image');
  const isQwenEdit = !isZImage;

  // 如果是动态工作流模式
  if (workflowFile) {
    const { loadWorkflow, prepareWorkflow, extractImageFromResult } = require('./workflowEngine');

    log.info('[ComfyUI/' + workflowFile + '] Starting generation (dynamic workflow)', {
      baseUrl, size, hasRefs,
      prompt: prompt ? prompt.slice(0, 80) : '',
    });

    // 准备参考图
    let refFilenames = [];
    const inputDir = path.join(process.env.HOME || '/home/wangergou', 'ComfyUI', 'input');
    if (!fs.existsSync(inputDir)) fs.mkdirSync(inputDir, { recursive: true });
    if (hasRefs) {
      refFilenames = await prepareReferenceImages(reference_image_urls.filter(Boolean), inputDir, log, storage_local_path);
      log.info('[ComfyUI/' + workflowFile + '] Prepared ' + refFilenames.length + ' reference images');
    }

    const wf = loadWorkflow(workflowFile);
    const dims = parseSize(size);
    const seed = Math.floor(Math.random() * 9007199254740991);
    const { prompt: apiPrompt, outputPrefixes } = prepareWorkflow(wf, {
      prompt: prompt || '',
      width: dims.w,
      height: dims.h,
      seed,
      refImages: refFilenames.length > 0 ? refFilenames : undefined,
    });

    const payload = { prompt: apiPrompt, client_id: 'localminidrama_' + Date.now() };
    const nodeCount = Object.keys(apiPrompt).length;
    log.info('[ComfyUI/' + workflowFile + '] 最终提交: 节点=' + nodeCount
      + ', 尺寸=' + dims.w + 'x' + dims.h
      + ', seed=' + seed
      + '\n[ComfyUI] PROMPT 全文:\n' + (prompt || '(空)'));

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

    const result = await waitForComfyJob(baseUrl, promptId, log, {
      runningBudgetMs: 20 * 60 * 1000,
      absoluteCapMs: 2 * 3600 * 1000,
      tag: '',
    });

    const imageFilename = extractImageFromResult(result, outputPrefixes);
    if (!imageFilename) throw new Error('ComfyUI completed but no image found');

    var imageUrl = baseUrl + '/view?filename=' + imageFilename + '&type=output';
    log.info('[ComfyUI/' + workflowFile + '] Done: ' + imageUrl);
    return { image_url: imageUrl };
  }

  // --- 原逻辑：根据模型名选择 ZIMAGE_WORKFLOW 或 Qwen-Edit ---
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

  // 等待完成（排队时间不计入执行超时）
  const result = await waitForComfyJob(baseUrl, promptId, log, {
    runningBudgetMs: 20 * 60 * 1000,
    absoluteCapMs: 2 * 3600 * 1000,
    tag: '',
  });

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


// LTX 2.3 图生视频工作流（API 格式已固化在 workflows/ltx23-i2v-api.json，
// 两阶段采样 + 音轨；由 WYC UI 工作流一次性转换而来，不再依赖 ComfyUI 用户目录）

async function callComfyUIVideoApi(config, log, opts) {
  const { prompt, model, image_url, video_gen_id, files_base_url, storage_local_path } = opts;
  const baseUrl = (config.base_url || "http://127.0.0.1:8188").replace(/\/$/, "");

  const fs = require("fs");
  const path = require("path");

  // 解析 settings 中的 workflow 字段
  let workflowFile = null;
  if (config.settings) {
    try {
      const s = typeof config.settings === 'string' ? JSON.parse(config.settings) : config.settings;
      if (s.workflow) workflowFile = s.workflow;
    } catch (_) {}
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

  // Prepare input image
  const inputDir = path.join(require("os").homedir(), "ComfyUI", "input");
  if (!fs.existsSync(inputDir)) fs.mkdirSync(inputDir, { recursive: true });
  let imgName = "example.png";
  if (image_url) {
    const prepared = await prepareReferenceImages([image_url], inputDir, log, storage_local_path);
    if (prepared.length > 0) imgName = prepared[0];
    else log.warn("[ComfyUI/LTX] Failed to prepare input image: " + String(image_url).slice(0, 120));
  }

  // 动态工作流模式
  if (workflowFile) {
    const { loadWorkflow, prepareWorkflow, extractImageFromResult } = require('./workflowEngine');

    log.info('[ComfyUI/LTX/' + workflowFile + '] Starting (dynamic)', { frames, size: vidW + 'x' + vidH });

    const wf = loadWorkflow(workflowFile);
    const seed = Math.floor(Math.random() * 9007199254740991);
    const { prompt: apiPrompt } = prepareWorkflow(wf, {
      prompt: prompt || '',
      width: vidW,
      height: vidH,
      seed,
      videoFrames: frames,
      videoFps: fps,
    });

    // Video-specific injection
    for (const [nid, node] of Object.entries(apiPrompt)) {
      if (node.class_type === 'EmptyLTXVLatentVideo') {
        node.inputs.length = frames;
        node.inputs.width = vidW;
        node.inputs.height = vidH;
      }
      if (node.class_type === 'RandomNoise') {
        node.inputs.noise_seed = seed;
      }
      if (node.class_type === 'LoadImage' && node.inputs.image != null) {
        node.inputs.image = imgName;
      }
      if (node.class_type === 'CLIPTextEncode' && !Array.isArray(node.inputs.text)) {
        node.inputs.text = prompt || '';
      }
      if (node.class_type === 'LTXVImgToVideoInplace' && node.inputs.strength != null && node.inputs.strength < 0.95) {
        node.inputs.strength = 0.8;
      }
    }

    log.info("[ComfyUI/LTX/" + workflowFile + "] Submitting " + Object.keys(apiPrompt).length + " nodes");
    const payload = { prompt: apiPrompt, client_id: "localminidrama_ltx_" + Date.now() };

    let submitResp;
    try {
      submitResp = await postJSON(baseUrl + "/prompt", payload, 30000);
    } catch (e) {
      throw new Error("ComfyUI submit failed: " + e.message);
    }
    const promptId = submitResp.prompt_id;
    if (!promptId) throw new Error("ComfyUI submit returned no prompt_id");
    log.info("[ComfyUI/LTX] Submitted prompt_id=" + promptId);

    const result = await waitForComfyJob(baseUrl, promptId, log, {
      runningBudgetMs: 30 * 60 * 1000,
      absoluteCapMs: 4 * 3600 * 1000,
      tag: '/LTX',
    });

    let videoFilename = null;
    const outs = result.outputs || {};
    for (const key of Object.keys(outs)) {
      const out = outs[key];
      if (out.images && out.images.length > 0) { videoFilename = out.images[0].filename; break; }
      if (out.gifs && out.gifs.length > 0) { videoFilename = out.gifs[0].filename; break; }
      if (out.videos && out.videos.length > 0) { videoFilename = out.videos[0].filename; break; }
    }
    if (!videoFilename) throw new Error("ComfyUI completed but no video found");

    const videoUrl = baseUrl + "/view?filename=" + videoFilename + "&type=output";
    log.info("[ComfyUI/LTX/" + workflowFile + "] Done: " + videoUrl);
    return { video_url: videoUrl };
  }

  // --- 原逻辑：硬编码工作流 ---
  const wfPath = path.join(__dirname, "workflows", "ltx23-i2v-api.json");
  const prompt_data = JSON.parse(fs.readFileSync(wfPath, "utf-8"));

  for (const node of Object.values(prompt_data)) {
    if (node.class_type === "RandomNoise") {
      node.inputs.noise_seed = Math.floor(Math.random() * 9007199254740991);
    }
  }

  for (const [nid, node] of Object.entries(prompt_data)) {
    if (node.class_type === "PrimitiveInt" && parseInt(node.inputs.value) === 97) node.inputs.value = frames;
    if (node.class_type === "PrimitiveInt" && parseInt(node.inputs.value) === 24) node.inputs.value = fps;
    if (node.class_type === "PrimitiveFloat" && parseFloat(node.inputs.value) === 24) node.inputs.value = fps;
    if (node.class_type === "EmptyLTXVLatentVideo") {
      node.inputs.length = frames;
      node.inputs.width = vidW;
      node.inputs.height = vidH;
    }
    if (node.class_type === "LTXVImgToVideoInplace" && node.inputs.strength != null && node.inputs.strength < 0.95) {
      node.inputs.strength = 0.8;
    }
  }
  log.info("[ComfyUI/LTX] Duration: " + videoDuration + "s, frames: " + frames + ", fps: " + fps + ", size: " + vidW + "x" + vidH + " (aspect: " + ratio + ")");

  let imgName2 = "example.png";
  if (image_url) {
    const prepared = await prepareReferenceImages([image_url], inputDir, log, storage_local_path);
    if (prepared.length > 0) imgName2 = prepared[0];
    else log.warn("[ComfyUI/LTX] Failed to prepare input image: " + String(image_url).slice(0, 120));
  }

  for (const [nid, node] of Object.entries(prompt_data)) {
    if (node.class_type === "LoadImage") {
      node.inputs.image = imgName2;
    }
    if (node.class_type === "CLIPTextEncode") {
      // Inject prompt from LocalMiniDrama into the first CLIPTextEncode (positive prompt)
      if (!node.inputs.text || nid === "121") {
        node.inputs.text = prompt || node.inputs.text || "";
      }
    }
  }

  log.info("[ComfyUI/LTX] Using image: " + imgName2 + " Submitting " + Object.keys(prompt_data).length + " nodes");
  
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

  // Wait for result（排队时间不计入执行超时；22B 两阶段执行预算 60 分钟）
  const result = await waitForComfyJob(baseUrl, promptId, log, {
    runningBudgetMs: 60 * 60 * 1000,
    absoluteCapMs: 6 * 3600 * 1000,
    tag: '/LTX',
  });

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
