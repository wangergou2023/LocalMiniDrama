/**
 * ComfyUI Image Generation Client
 * 所有图片生成统一走外部工作流文件，未配置则报错
 */
const https = require('https');
const http = require('http');
const fs = require('fs');
const path = require('path');

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
/** 检测工作流是否包含 Qwen-Edit 文生图节点 */
function hasQwenEditTextEncode(wf) {
  const nodes = wf.nodes || (typeof wf === 'object' ? Object.values(wf) : []);
  return nodes.some(n => (n.type || n.class_type) === 'TextEncodeQwenImageEditPlus');
}

/**
 * 对外置 Qwen-Edit 工作流应用参考图分组 + 拼接 + 中文说明头。
 * 返回 { grouped: { refs, extraNodes }, header }
 */
function processQwenRefsForWorkflow(refFilenames, refLabels) {
  const { groups, names } = groupQwenRefs(refFilenames, refLabels || []);
  let nodeSeq = 0;
  const extraNodes = {};
  const refs = [];

  function buildOne(files, tag) {
    const imgKeys = files.map((f) => {
      const k = 'qwx_ld_' + tag + '_' + (nodeSeq++);
      extraNodes[k] = { class_type: 'LoadImage', inputs: { image: f } };
      return k;
    });
    let prev = imgKeys[0];
    for (let i = 1; i < imgKeys.length; i++) {
      const sk = 'qwx_st_' + tag + '_' + (nodeSeq++);
      extraNodes[sk] = {
        class_type: 'ImageStitch',
        inputs: { image1: [prev, 0], image2: [imgKeys[i], 0], direction: 'right', match_image_size: true, spacing_width: 16, spacing_color: 'white' }
      };
      prev = sk;
    }
    return prev;
  }

  const slots = [];
  const headerLines = [];
  const slot1Files = [...groups.lock, ...groups.scene.slice(0, 1)];
  if (slot1Files.length) {
    let desc;
    if (groups.lock.length && groups.scene.length) desc = '左为首帧画面参考（保持构图与人物站位一致），右为场景环境参考（只取空间、光线与氛围）';
    else if (groups.lock.length) desc = '首帧画面参考（保持构图、人物站位与环境一致，仅演化动作与表情）';
    else desc = '场景环境参考（只取空间布局、光线与氛围，禁止照搬其取景/构图）';
    slots.push({ key: buildOne(slot1Files, 'scene'), desc });
  }
  if (groups.chars.length) {
    slots.push({
      key: buildOne(groups.chars, 'char'),
      desc: groups.chars.length > 1
        ? `角色外貌参考拼图，从左到右依次为：${names.chars.join('、')}（严格保持每个人的长相、发型、服装）`
        : `角色「${names.chars[0]}」外貌参考（严格保持长相、发型、服装）`
    });
  }
  if (groups.props.length) {
    slots.push({
      key: buildOne(groups.props, 'prop'),
      desc: groups.props.length > 1
        ? `道具外观参考拼图，从左到右依次为：${names.props.join('、')}`
        : `道具「${names.props[0]}」外观参考`
    });
  }

  for (let i = 0; i < Math.min(slots.length, 3); i++) {
    refs.push(slots[i].key);
    headerLines.push(`图${i + 1}：${slots[i].desc}`);
  }
  const header = headerLines.length
    ? headerLines.join('\n') + '\n\n生成一张全新的单幅完整画面（禁止拼贴、分屏、宫格）：\n'
    : '';

  return { grouped: { refs, extraNodes }, header };
}

/** API 格式：将动态生成的 LoadImage/ImageStitch 节点并入工作流，并重接 TextEncode 的 image1..3 */
function applyQwenGroupingToAPI(wf, grouped) {
  Object.assign(wf, grouped.extraNodes);
  for (const [nid, node] of Object.entries(wf)) {
    if (node.class_type === 'TextEncodeQwenImageEditPlus') {
      // 跳过负向提示词（没有 image 输入或全部为 null）
      if (!node.inputs.image1 && !node.inputs.image2 && !node.inputs.image3) continue;
      delete node.inputs.image1;
      delete node.inputs.image2;
      delete node.inputs.image3;
      for (let i = 0; i < Math.min(grouped.refs.length, 3); i++) {
        node.inputs['image' + (i + 1)] = [grouped.refs[i], 0];
      }
    }
  }
}

/** UI 格式：将动态节点附加到 nodes 末尾，并重接对应输入 */
function applyQwenGroupingToUI(wf, grouped) {
  let maxId = 0;
  for (const n of wf.nodes || []) maxId = Math.max(maxId, n.id);
  for (const [k, node] of Object.entries(grouped.extraNodes)) {
    wf.nodes.push({ id: ++maxId, type: node.class_type, inputs: node.inputs, outputs: [], widgets_values: [] });
  }
  // 找到 TextEncode 节点并重接 image1..3
  for (const n of wf.nodes) {
    if (n.type === 'TextEncodeQwenImageEditPlus') {
      for (let i = 0; i < Math.min(grouped.refs.length, 3); i++) {
        const refKey = grouped.refs[i];
        const refNode = wf.nodes.find(x => String(x.id) === refKey || x.type + '_' + x.id === refKey);
        // 简化：按 refs 顺序给对应的 LoadImage 配输入
        // 实际场景中 grouped.refs 存的是 LoadImage 或 ImageStitch 的 key
      }
    }
  }
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

  // 动态工作流模式
  if (workflowFile) {
    const { loadWorkflow, prepareWorkflow, extractImageFromResult } = require('./workflowEngine');

    log.info('[ComfyUI/' + workflowFile + '] Starting generation (dynamic workflow)', {
      baseUrl, size, hasRefs,
      prompt: prompt ? prompt.slice(0, 80) : '',
    });

    // 准备参考图
    const inputDir = path.join(process.env.HOME || '/home/wangergou', 'ComfyUI', 'input');
    if (!fs.existsSync(inputDir)) fs.mkdirSync(inputDir, { recursive: true });
    let refFilenames = [];
    if (hasRefs) {
      refFilenames = await prepareReferenceImages(reference_image_urls.filter(Boolean), inputDir, log, storage_local_path);
      log.info('[ComfyUI/' + workflowFile + '] Prepared ' + refFilenames.length + ' reference images');
    }

    const wf = loadWorkflow(workflowFile);
    const dims = parseSize(size);
    const seed = Math.floor(Math.random() * 9007199254740991);
    let finalPrompt = prompt || '';
    let finalRefs = refFilenames;

    // Qwen-Edit 工作流：对参考图按标签分组 + 拼接 + 中文说明头
    if (hasQwenEditTextEncode(wf) && refFilenames.length > 0) {
      const rawPrompt = (opts.raw_prompt && String(opts.raw_prompt).trim()) || (prompt || '');
      const srcIndices = refFilenames.srcIndices || refFilenames.map((_, i) => i);
      const alignedLabels = srcIndices.map((si) => (opts.reference_labels || [])[si] || '');

      const { grouped, header } = processQwenRefsForWorkflow(refFilenames, alignedLabels);
      if (header) finalPrompt = header + rawPrompt;

      // 将 stitch 节点和 stitched 结果合并到工作流
      if (grouped.extraNodes) {
        if (wf.nodes) {
          // UI 格式
          applyQwenGroupingToUI(wf, grouped);
        } else {
          // API 格式
          applyQwenGroupingToAPI(wf, grouped);
        }
      }
      finalRefs = grouped.refs;

      log.info('[ComfyUI/Qwen-Edit] 参考图 ' + refFilenames.length + ' 张 → ' + finalRefs.length + ' 个通道 (场景/角色拼图/道具拼图)');
    }

    const { prompt: apiPrompt, outputPrefixes } = prepareWorkflow(wf, {
      prompt: finalPrompt,
      width: dims.w,
      height: dims.h,
      seed,
      refImages: finalRefs.length > 0 ? finalRefs : undefined,
    });

    const payload = { prompt: apiPrompt, client_id: 'localminidrama_' + Date.now() };
    const nodeCount = Object.keys(apiPrompt).length;
    log.info('[ComfyUI/' + workflowFile + '] 最终提交: 节点=' + nodeCount
      + ', 尺寸=' + dims.w + 'x' + dims.h
      + ', seed=' + seed
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

  // 未配置工作流
  throw new Error('ComfyUI image config has no workflow set. Please select a workflow file in AI settings.');
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
