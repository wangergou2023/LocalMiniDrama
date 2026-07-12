/**
 * ComfyUI Image Generation Client
 * 支持 Z-Image Turbo（文生图）和 Flux Kontext（多参考图）
 */
const https = require('https');
const http = require('http');
const fs = require('fs');
const path = require('path');

const FLUX_KONTEXT_WORKFLOW = {
  "37": {"inputs":{"unet_name":"flux1-dev-kontext_fp8_scaled.safetensors","weight_dtype":"default"},"class_type":"UNETLoader"},
  "38": {"inputs":{"clip_name1":"clip_l.safetensors","clip_name2":"t5xxl_fp8_e4m3fn_scaled.safetensors","type":"flux"},"class_type":"DualCLIPLoader"},
  "39": {"inputs":{"vae_name":"ae.safetensors"},"class_type":"VAELoader"},
  // LoadImage/ImageBatch 节点在运行时动态创建（根据参考图数量）
  "42": {"inputs":{"image":["batch",0]},"class_type":"FluxKontextImageScale"},
  "124": {"inputs":{"pixels":["42",0],"vae":["39",0]},"class_type":"VAEEncode"},
  "6": {"inputs":{"clip":["38",0],"clip_l":"__PROMPT__","t5xxl":"__PROMPT__","guidance":2.5},"class_type":"CLIPTextEncodeFlux"},
  "177": {"inputs":{"conditioning":["6",0],"latent":["124",0]},"class_type":"ReferenceLatent"},
  "35": {"inputs":{"guidance":2.5,"conditioning":["177",0]},"class_type":"FluxGuidance"},
  "neg": {"inputs":{"conditioning":["6",0]},"class_type":"ConditioningZeroOut"},
  "188": {"inputs":{"width":1024,"height":1024,"batch_size":1},"class_type":"EmptySD3LatentImage"},
  "31": {"inputs":{"seed":42,"steps":20,"cfg":1,"sampler_name":"euler","scheduler":"simple","denoise":1,"model":["37",0],"positive":["35",0],"negative":["neg",0],"latent_image":["188",0]},"class_type":"KSampler"},
  "8": {"inputs":{"samples":["31",0],"vae":["39",0]},"class_type":"VAEDecode"},
  "136": {"inputs":{"images":["8",0],"filename_prefix":"ComfyUI"},"class_type":"SaveImage"}
};

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

async function prepareReferenceImages(referenceUrls, comfyuiInputDir, log) {
  if (!Array.isArray(referenceUrls) || referenceUrls.length === 0) return [];
  const filenames = [];
  for (let i = 0; i < referenceUrls.length; i++) {
    const ref = referenceUrls[i];
    if (!ref) continue;
    try {
      const name = 'ref_' + Date.now() + '_' + i + '.png';
      const destPath = path.join(comfyuiInputDir, name);
      if (ref.startsWith('data:')) {
        const base64Data = ref.replace(/^data:image\/\w+;base64,/, '');
        fs.writeFileSync(destPath, Buffer.from(base64Data, 'base64'));
      } else if (ref.startsWith('http://') || ref.startsWith('https://')) {
        await httpDownload(ref, destPath);
      } else if (fs.existsSync(ref)) {
        fs.copyFileSync(ref, destPath);
      } else {
        log.warn('[ComfyUI] Reference image not found: ' + ref);
        continue;
      }
      filenames.push(name);
    } catch (e) {
      log.warn('[ComfyUI] Failed to prepare reference image: ' + e.message);
    }
  }
  return filenames;
}

async function callComfyUIImageApi(config, log, opts) {
  const { prompt, size, image_gen_id, reference_image_urls, files_base_url, storage_local_path } = opts;
  const baseUrl = (config.base_url || 'http://127.0.0.1:8188').replace(/\/$/, '');
  const hasRefs = Array.isArray(reference_image_urls) && reference_image_urls.some(Boolean);

  // model 可能是字符串或数组（LocalMiniDrama 多模型选择）
  const modelStr = Array.isArray(config.model) ? config.model.join(',') : (config.model || '');
  const useFlux = !modelStr.toLowerCase().includes("z-image");
  const workflowName = useFlux ? 'Flux Kontext' : 'Z-Image Turbo';

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
    refFilenames = await prepareReferenceImages(reference_image_urls.filter(Boolean), inputDir, log);
    log.info('[ComfyUI/' + workflowName + '] Prepared ' + refFilenames.length + ' reference images');
  }

  // 选择工作流
  const workflow = JSON.parse(JSON.stringify(useFlux ? FLUX_KONTEXT_WORKFLOW : ZIMAGE_WORKFLOW));
  const dims = parseSize(size);
  const seed = Math.floor(Math.random() * 9007199254740991);

  // 注入参数
  if (useFlux) {
    workflow['6'].inputs.clip_l = prompt || '';
    workflow['6'].inputs.t5xxl = prompt || '';
    workflow['188'].inputs.width = dims.w;
    workflow['188'].inputs.height = dims.h;
    workflow['31'].inputs.seed = seed;
    // 动态参考图注入（支持任意数量）
    if (refFilenames.length > 0) {
      // 清理旧的固定 LoadImage/ImageBatch 节点
      var oldKeys = ['190', '191', 'batch'];
      for (var k = 0; k < oldKeys.length; k++) { delete workflow[oldKeys[k]]; }
      
      // 创建 LoadImage 节点
      var imgNodes = [];
      for (var ri = 0; ri < refFilenames.length; ri++) {
        var imgKey = 'ref_img_' + ri;
        workflow[imgKey] = {"inputs":{"image": refFilenames[ri]},"class_type":"LoadImage"};
        imgNodes.push(imgKey);
      }
      
      // 链式 ImageBatch
      if (imgNodes.length === 1) {
        workflow['42'].inputs.image = [imgNodes[0], 0];
      } else {
        var prevBatchKey = '';
        for (var ri = 0; ri < imgNodes.length - 1; ri++) {
          var batchKey = 'ref_batch_' + ri;
          if (ri === 0) {
            workflow[batchKey] = {"inputs":{"image1":[imgNodes[ri],0],"image2":[imgNodes[ri+1],0]},"class_type":"ImageBatch"};
          } else {
            workflow[batchKey] = {"inputs":{"image1":[prevBatchKey,0],"image2":[imgNodes[ri+1],0]},"class_type":"ImageBatch"};
          }
          prevBatchKey = batchKey;
        }
        workflow['42'].inputs.image = [prevBatchKey, 0];
      }
    } else {
      workflow['190'].inputs.image = 'example.png';
      workflow['191'].inputs.image = 'example.png';
    }
  } else {
    // Z-Image: 直接注入到 CLIPTextEncode 和 EmptyLatentImage
    workflow['5'].inputs.text = prompt || '';
    workflow['7'].inputs.width = dims.w;
    workflow['7'].inputs.height = dims.h;
    workflow['4'].inputs.seed = seed;
  }

  const payload = { prompt: workflow, client_id: 'localminidrama_' + Date.now() };

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
  for (const [nid, node] of Object.entries(prompt_data)) {
    if (node.class_type === "PrimitiveInt" && parseInt(node.inputs.value) === 97) node.inputs.value = frames;
    if (node.class_type === "PrimitiveInt" && parseInt(node.inputs.value) === 24) node.inputs.value = fps;
    if (node.class_type === "PrimitiveFloat" && parseFloat(node.inputs.value) === 24) node.inputs.value = fps;
    if (node.class_type === "EmptyLTXVLatentVideo") node.inputs.length = frames;
  }
  log.info("[ComfyUI/LTX] Duration: " + videoDuration + "s, frames: " + frames + ", fps: " + fps);


  // Adjust video resolution based on aspect ratio
  const ratio = (opts.aspect_ratio || '').toString();
  const [rw, rh] = ratio.includes(':') ? ratio.split(':').map(Number) : [9, 16];
  const totalPx = 768 * 512; const ratioVal = rw / rh;
  const vidW = Math.max(256, Math.round(Math.sqrt(totalPx * ratioVal) / 32) * 32);
  const vidH = Math.max(256, Math.round(Math.sqrt(totalPx / ratioVal) / 32) * 32);
  for (const [nid, node] of Object.entries(prompt_data)) {
  const fps = 24; const videoDuration = Number(opts.duration) || 5; const frames = Math.max(9, Math.round(videoDuration * fps / 8) * 8 + 1); log.info("[ComfyUI/LTX] Duration: " + videoDuration + "s, frames: " + frames + ", fps: " + fps);
    if (node.class_type === 'PrimitiveFloat' && parseFloat(node.inputs.value) === 24) { node.inputs.value = fps; }
    if (node.class_type === 'EmptyLTXVLatentVideo') {
      node.inputs.width = vidW;
      node.inputs.height = vidH;
    }
  }
  log.info("[ComfyUI/LTX] Video size: " + vidW + "x" + vidH + " (aspect: " + ratio + ")");

  // Increase I2V strength to better match reference image
  for (const [nid, node] of Object.entries(prompt_data)) {
  for (const [nid, node] of Object.entries(prompt_data)) {
    if (node.class_type === "PrimitiveInt" && parseInt(node.inputs.value) === 97 || parseInt(node.inputs.value) === 24) {
      node.inputs.value = (parseInt(node.inputs.value) === 97) ? frames : fps;
    }
    if (node.class_type === 'PrimitiveFloat' && parseFloat(node.inputs.value) === 24) { node.inputs.value = fps; }
    if (node.class_type === "EmptyLTXVLatentVideo") {
      node.inputs.length = frames;
    }
  }
  log.info("[ComfyUI/LTX] Frames: " + frames + ", FPS: " + fps);
    if (node.class_type === 'LTXVImgToVideoInplace') {
      if (node.inputs.strength != null && node.inputs.strength < 0.95) {
        node.inputs.strength = 0.8;
      }
    }
  }

  // Set input image
  const inputDir = require("path").join(require("os").homedir(), "ComfyUI", "input");
  let imgName = "example.png";
  if (image_url) {
    // Download reference image to ComfyUI input dir
    const imgPath = require("path").join(inputDir, "ltx_input_" + Date.now() + ".png");
    try {
      log.info("[ComfyUI/LTX] Downloading image: " + (image_url || "NULL"));
      // use local httpDownload
      await httpDownload(image_url, imgPath);
      imgName = require("path").basename(imgPath);
    } catch (e) {
      log.warn("[ComfyUI/LTX] Failed to download input image: " + e.message);
    }
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
