/**
 * 工作流引擎 — 解析 ComfyUI 工作流 JSON 并注入参数
 */
const fs = require('fs');
const path = require('path');

const WORKFLOWS_DIR = path.join(__dirname, '..', '..', '..', 'workflows', 'C图像-Zimage');
const WORKFLOWS_DIR_B = path.join(__dirname, '..', '..', '..', 'workflows', 'B图像-Qwen编辑');
const WORKFLOWS_DIR_H = path.join(__dirname, '..', '..', '..', 'workflows', 'H视频-LTX');

function listWorkflows(type) {
  const all = [];
  let dirs = [WORKFLOWS_DIR, WORKFLOWS_DIR_B];
  if (type === 'video') dirs = [WORKFLOWS_DIR_H];
  
  for (const dir of dirs) {
    if (!fs.existsSync(dir)) continue;
    for (const f of fs.readdirSync(dir)) {
      if (!f.endsWith('.json')) continue;
      try {
        const meta = parseWorkflowMeta(path.join(dir, f));
        all.push({ filename: f, ...meta });
      } catch (e) {
        all.push({ filename: f, error: e.message });
      }
    }
  }
  return all.sort((a, b) => a.filename.localeCompare(b.filename));
}

function parseWorkflowMeta(filePath) {
  const raw = fs.readFileSync(filePath, 'utf-8');
  const wf = JSON.parse(raw);
  const nodes = wf.nodes || [];
  const types = new Set(nodes.map(n => n.type));
  const requiredPlugins = detectRequiredPlugins(types);
  return {
    nodeCount: nodes.length,
    hasUNETLoader: nodes.some(n => n.type === 'UNETLoader'),
    hasNunchaku: nodes.some(n => (n.type || '').includes('Nunchaku')),
    hasControlNet: nodes.some(n => (n.type || '').toLowerCase().includes('control')),
    hasSeedVR: nodes.some(n => (n.type || '').includes('SeedVR')),
    hasLora: nodes.some(n => (n.type || '').includes('Lora') && (n.type || '').includes('Loader')),
    samplerCount: nodes.filter(n => (n.type || '').includes('Sampler')).length,
    textEncodeCount: nodes.filter(n => (n.type || '').includes('TextEncode')).length,
    outputPrefix: findOutputPrefix(nodes),
    requiredPlugins,
  };
}

function detectRequiredPlugins(types) {
  const plugins = [];
  const add = (name) => { if (!plugins.includes(name)) plugins.push(name); };
  for (const t of types) {
    if (t.startsWith('easy ')) add('ComfyUI-Easy-Use');
    if (t.includes('LayerUtility:') || t.includes('LayerMask:') || t.includes('LayerColor:')) add('ComfyUI-LayerStyle');
    if (t.includes('Nunchaku')) add('ComfyUI-Nunchaku');
    if (t.includes('SeedVR')) add('ComfyUI-SeedVR2');
    if (t.includes('DetailDaemon')) add('ComfyUI-Detail-Daemon');
    if (t.includes('QwenImage') || t.includes('Diffsynth')) add('ComfyUI-QwenImageDiffsynth');
    if (t === 'AIO_Preprocessor') add('ComfyUI_ControlNet_Aux');
    if (t.includes('Llama') || t.includes('llama')) add('ComfyUI-LLaMA-CPP');
    if (t.startsWith('CR ')) add('ComfyUI_Comfyroll_CustomNodes');
    if (t.includes('UpscaleModel') || t.includes('UltimateSD')) add('ComfyUI_UltimateSDUpscale');
    if (t.includes('Impact') || t === 'FaceDetailer' || t === 'SAMLoader') add('ComfyUI-Impact-Pack');
    if (t.includes('WJI') || t.includes('Wuji')) add('ComfyUI-WJNodes');
    if (t.includes('TTP_')) add('ComfyUI-TTP');
    if (t.startsWith('Power Lora') || t.startsWith('Lora Loader Stack')) add('rgthree-comfy');
    if (t.includes('Flux2Klein')) add('ComfyUI-Flux2KleinEdit');
  }
  return plugins;
}

function findOutputPrefix(nodes) {
  for (const n of nodes) {
    if (n.type === 'SaveImage' || n.type === 'PreviewImage') {
      for (const inp of n.inputs || []) {
        if ((inp.name || '').includes('filename_prefix')) {
          const val = (inp.widget || {}).value;
          if (val) return val;
        }
      }
    }
  }
  return 'ComfyUI';
}

function loadWorkflow(filename) {
  for (const dir of [WORKFLOWS_DIR, WORKFLOWS_DIR_B, WORKFLOWS_DIR_H]) {
    const fp = path.join(dir, filename);
    if (fs.existsSync(fp)) {
      return JSON.parse(fs.readFileSync(fp, 'utf-8'));
    }
  }
  throw new Error('Workflow not found: ' + filename);
}

function buildLinkMap(workflow) {
  const map = {};
  for (const link of workflow.links || []) {
    map[link[0]] = { srcNodeId: link[1], srcOutputIdx: link[2] };
  }
  return map;
}

/**
 * 将工作流格式转换为 ComfyUI API prompt 格式。
 * widget 值为 null/undefined 的不写入，让 ComfyUI 使用节点默认值。
 */
function workflowToApiFormat(workflow, linkMap) {
  const prompt = {};
  for (const node of workflow.nodes || []) {
    const nid = String(node.id);
    const inputs = {};
    for (const inp of node.inputs || []) {
      const name = inp.name;
      if (inp.link != null) {
        const link = linkMap[inp.link];
        if (link) {
          inputs[name] = [String(link.srcNodeId), link.srcOutputIdx];
        }
      } else if (inp.widget != null && inp.widget.value != null) {
        let val = inp.widget.value;
        if (inp.type === 'INT') val = parseInt(val, 10);
        if (inp.type === 'FLOAT') val = parseFloat(val);
        if (inp.type === 'BOOLEAN') val = val === true || val === 'true';
        inputs[name] = val;
      }
    }
    prompt[nid] = { class_type: node.type, inputs };
  }
  return prompt;
}

function getDefaultInput(classType, inputName) {
  if (classType === 'CLIPLoader') {
    if (inputName === 'clip_name') return 'qwen_3_4b.safetensors';
    if (inputName === 'type') return 'qwen_image';
    if (inputName === 'device') return 'default';
  }
  if (classType === 'UNETLoader') {
    if (inputName === 'unet_name') return 'z_image_turbo_bf16.safetensors';
    if (inputName === 'weight_dtype') return 'default';
  }
  if (classType === 'VAELoader') {
    if (inputName === 'vae_name') return 'z_image_vae.safetensors';
  }
  if (classType === 'LoraLoaderModelOnly') {
    if (inputName === 'strength_model') return 1.0;
  }
  if (classType === 'SaveImage' || classType === 'PreviewImage') {
    if (inputName === 'filename_prefix') return 'ComfyUI';
  }
  return undefined;
}

/**
 * 绕过未选 LoRA 的 LoraLoaderModelOnly / Power Lora Loader 节点
 * 将其 model 输入直连到下游节点
 */
function bypassEmptyLoras(prompt, workflow, linkMap) {
  const nodes = workflow.nodes || [];

  for (const node of nodes) {
    const classType = node.type;
    if (classType !== 'LoraLoaderModelOnly' && classType !== 'Power Lora Loader (rgthree)') continue;

    const nid = String(node.id);
    const apiInputs = prompt[nid]?.inputs;
    if (!apiInputs) continue;

    // 没有选择 LoRA 文件 → 绕过
    const loraKey = classType === 'LoraLoaderModelOnly' ? 'lora_name' : 'lora';
    const loraVal = apiInputs[loraKey];
    if (loraVal && String(loraVal).trim() !== '') continue;

    // 找到 model 输入的来源节点
    const modelInput = apiInputs.model;
    if (!Array.isArray(modelInput)) continue;
    const bypassSrc = modelInput; // [sourceNodeId, sourceOutputIdx]

    // 找到所有引用此节点输出的链接，重定向到 bypassSrc
    for (const otherNode of nodes) {
      const otherNid = String(otherNode.id);
      const otherInputs = prompt[otherNid]?.inputs;
      if (!otherInputs) continue;

      for (const key of Object.keys(otherInputs)) {
        const val = otherInputs[key];
        if (Array.isArray(val) && String(val[0]) === nid) {
          otherInputs[key] = bypassSrc;
        }
      }
    }

    // 删除该节点
    delete prompt[nid];
  }
}

/**
 * 准备工作流并注入参数
 * @param {object} workflow - 原始工作流 JSON (含 nodes + links)
 * @param {object} params - { prompt, width, height, seed, batchSize }
 * @returns {{ prompt: object, outputPrefixes: string[] }} - API 格式的 prompt 对象
 */
function prepareWorkflow(workflow, params) {
  const { prompt: promptText, width, height, seed, batchSize = 1, refImages, videoFrames, videoFps } = params;
  const linkMap = buildLinkMap(workflow);
  const prompt = workflowToApiFormat(workflow, linkMap);

  // 删除纯显示节点（不影响出图）
  const skipTypes = new Set(['MarkdownNote', 'Note', 'Note Plus (mtb)', 'Label (rgthree)', 'Reroute', 'ShowText|pysssss']);
  for (const nid of Object.keys(prompt)) {
    if (skipTypes.has(prompt[nid]?.class_type)) {
      delete prompt[nid];
    }
  }

  const outputPrefixes = [];

  // 绕过无效的 LoRA 节点
  bypassEmptyLoras(prompt, workflow, linkMap);

  // 注入参考图到 LoadImage 节点
  let refIdx = 0;
  if (refImages && refImages.length > 0) {
    for (const node of workflow.nodes || []) {
      const nid = String(node.id);
      const apiInputs = prompt[nid]?.inputs;
      if (!apiInputs) continue;
      if (node.type === 'LoadImage') {
        if (refIdx < refImages.length) {
          apiInputs.image = refImages[refIdx];
          refIdx++;
        }
      }
    }
  }

  for (const node of workflow.nodes || []) {
    const nid = String(node.id);
    const apiInputs = prompt[nid]?.inputs;
    if (!apiInputs) continue;
    const classType = node.type;

    // CLIPTextEncode / TextEncodeQwenImageEditPlus: 注入 prompt（跳过已链接的 text 输入）
    if ((classType === 'CLIPTextEncode' || classType === 'TextEncodeQwenImageEditPlus') && promptText !== undefined) {
      if (!Array.isArray(apiInputs.text)) {
        apiInputs.text = promptText;
      }
      if (apiInputs.prompt !== undefined && !Array.isArray(apiInputs.prompt)) {
        apiInputs.prompt = promptText;
      }
    }

    // EmptyLatentImage / EmptySD3LatentImage: 注入尺寸
    if (classType === 'EmptyLatentImage' || classType === 'EmptySD3LatentImage') {
      if (width !== undefined) apiInputs.width = width;
      if (height !== undefined) apiInputs.height = height;
      if (batchSize !== undefined) apiInputs.batch_size = batchSize;
    }

    // KSampler: 注入 seed
    if (classType === 'KSampler') {
      if (seed !== undefined && !Array.isArray(apiInputs.seed)) {
        apiInputs.seed = seed;
      }
    }

    // KSamplerAdvanced: 注入 noise_seed
    if (classType === 'KSamplerAdvanced') {
      if (seed !== undefined && !Array.isArray(apiInputs.noise_seed)) {
        apiInputs.noise_seed = seed;
      }
    }

    // RandomNoise: 注入 noise_seed
    if (classType === 'RandomNoise') {
      if (seed !== undefined && !Array.isArray(apiInputs.noise_seed)) {
        apiInputs.noise_seed = seed;
      }
    }

    // BasicScheduler / Flux2Scheduler / CFGGuider: 无需注入（保持工作流默认）
    if ((classType === 'easy promptList' || classType === 'easy promptLine') && promptText !== undefined) {
      for (let i = 1; i <= 5; i++) {
        const key = 'prompt_' + i;
        if (apiInputs[key] !== undefined && !Array.isArray(apiInputs[key])) {
          apiInputs[key] = promptText;
        }
      }
      if (!Array.isArray(apiInputs.positives)) {
        apiInputs.positives = promptText;
      }
    }

    // EmptyLTXVLatentVideo: 注入帧数和分辨率
    if (classType === 'EmptyLTXVLatentVideo') {
      if (videoFrames !== undefined) apiInputs.length = videoFrames;
      if (width !== undefined) apiInputs.width = width;
      if (height !== undefined) apiInputs.height = height;
    }

    // 收集输出前缀
    if (classType === 'SaveImage' || classType === 'PreviewImage') {
      if (!apiInputs.filename_prefix) {
        apiInputs.filename_prefix = 'ComfyUI';
      }
      outputPrefixes.push(String(apiInputs.filename_prefix));
    }
  }

  return { prompt, outputPrefixes };
}

function extractImageFromResult(result, outputPrefixes) {
  const outs = result.outputs || {};
  for (const key of Object.keys(outs)) {
    const out = outs[key];
    if (out.images && out.images.length > 0) {
      const filename = out.images[0].filename;
      if (outputPrefixes && outputPrefixes.length > 0) {
        for (const prefix of outputPrefixes) {
          if (filename.startsWith(prefix) || filename.includes(prefix)) {
            return filename;
          }
        }
      }
      return filename;
    }
  }
  return null;
}

module.exports = { listWorkflows, loadWorkflow, prepareWorkflow, extractImageFromResult, WORKFLOWS_DIR, WORKFLOWS_DIR_H };
