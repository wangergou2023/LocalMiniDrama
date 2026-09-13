/**
 * ComfyUI Image Generation Client
 * 所有图片生成统一走外部工作流文件，未配置则报错
 */
const https = require('https');
const http = require('http');
const fs = require('fs');
const path = require('path');
const { markDialogue } = require('../utils/h3DialogueMark');
const { fixLegacySegmentText } = require('../utils/segmentTextNormalize');

/**
 * H3 音色参考音频的裁剪上限（秒）。
 *
 * 内置音色库（backend-node/src/assets/voice-bank/voices/）那 14 个 mp3 全部 13.7~21.2 秒，
 * 中位 15.3 秒 —— 那是一整段带内容、带节奏、带情绪的完整念白，不是「音色样本」。
 *
 * H3 官方规范把 `<Audio N>` 定位成 voice-timbre reference，并在 §5.4 明确警告：
 *   "When only timbre, rhythm, emotion, or delivery is referenced,
 *    do not carry the original dialogue from the reference audio into the target video."
 * 参考越长，原始台词/语速/情绪越容易漏进成片；而我们的目标分镜只有 6~10 秒，
 * 15 秒的参考比目标还长，参考关系是倒挂的。音色克隆惯例是 3~5 秒，这里取 4 秒。
 *
 * 注：裁剪对速度几乎没有收益（15 秒 ≈ 1204 token，占整条 packed 序列约 4%，
 *     而 7 张参考图合计约 3570 token），纯属语义层面的修正。
 */
const H3_VOICE_REF_MAX_SECONDS = 4;

/**
 * 音色参考在保留窗口之前额外丢掉的秒数（去掉开头静音之后再丢）。
 *
 * 为什么需要它 —— 从 ComfyUI 的 H3 模型实现里找到了「参考音频被续读」的根因：
 *   comfy/ldm/minimax/model.py
 *     def _ref_t_span(blk):
 *         # time-axis span a reference block occupies AHEAD OF THE TARGET STREAMS
 *         if kind == "audio": return float(blk["ref_audio_t"])
 *   …
 *     pos.append(_audio_grid(cursor, rt, *target_audio_w))   # 参考音频排在时间轴 cursor 处
 *     cursor += float(rt)
 *     pos.append(_audio_grid(cursor, audio_t, *target_audio_w))  # 目标音频紧接其后
 *
 * 也就是说：参考音频与目标音频位于**同一条连续时间轴**上，参考在前、目标紧随其后，
 * 且参考部分以 frozen conditioning 注入（audio_update=False）。模型被训练成「接着参考往下说」。
 * 这是位置/结构层面的设计，不是提示词没写清楚 —— 实测三种提示词写法
 * （泛泛的 <Audio> 说明行 / 点名角色+禁止复述 / 再加 <d> 与 (Sx) 编号）都没能去掉
 * 开头多出来的那段语音（用户听到的是参考音频开头的「你好」）。
 *
 * 所以只能从参考音频本身下手：把开头那段有辨识度的内容丢掉，让前缀的结尾落在句子中间，
 * 模型要继续的东西就变成了目标台词。
 */
const H3_VOICE_REF_SKIP_HEAD_SECONDS = 1.0;

/** 用 ffprobe 读取媒体时长（秒）；失败返回 null */
function probeMediaDuration(filePath, log) {
  try {
    const { getFfprobePath } = require('../utils/ffmpegPath');
    const { spawnSync } = require('child_process');
    const r = spawnSync(
      getFfprobePath(),
      ['-v', 'error', '-show_entries', 'format=duration', '-of', 'default=noprint_wrappers=1:nokey=1', filePath],
      { encoding: 'utf8' }
    );
    if (r.status !== 0) return null;
    const d = Number(String(r.stdout || '').trim());
    return Number.isFinite(d) && d > 0 ? d : null;
  } catch (e) {
    if (log) log.warn('[ComfyUI] ffprobe 读取时长失败: ' + e.message);
    return null;
  }
}

/**
 * 把过长的音色参考裁到 maxSeconds。
 *
 * - 先去掉开头静音（音色样本里的空白没有信息量，还会占掉裁剪预算），再截前 maxSeconds
 * - 统一输出 32kHz / 立体声 / s16le WAV：H3 audio VAE 工作在 32kHz，
 *   且 `_encode_ref_audio` 按 [B, 32, ch=2, T] 编码，单声道源显式补成双声道更稳
 * - 全程 best-effort：ffprobe/ffmpeg 缺失、解码失败等情况一律保留原文件并告警，
 *   绝不因为裁剪失败而让整条视频生成挂掉
 *
 * @returns {Promise<{path:string, changed:boolean, from?:number, to?:number}>}
 */
function trimVoiceReference(audioPath, log, maxSeconds = H3_VOICE_REF_MAX_SECONDS, skipSeconds = H3_VOICE_REF_SKIP_HEAD_SECONDS) {
  const keep = Number(maxSeconds);
  if (!Number.isFinite(keep) || keep <= 0) return { path: audioPath, changed: false };
  const origDuration = probeMediaDuration(audioPath, log);
  if (origDuration == null) {
    log.warn('[ComfyUI] 音色参考时长未知，跳过多余裁剪: ' + path.basename(audioPath));
    return { path: audioPath, changed: false };
  }
  // 源时长不足以「跳过 + 保留」时，退化为不跳过，避免把参考裁成空
  const skip = origDuration > keep + (Number(skipSeconds) || 0) + 0.3 ? (Number(skipSeconds) || 0) : 0;
  if (origDuration <= keep + 0.05) return { path: audioPath, changed: false, from: origDuration };

  const outPath = audioPath.replace(/\.[^.]+$/, '') + '_trim.wav';
  try {
    const { getFfmpegPath } = require('../utils/ffmpegPath');
    const { spawnSync } = require('child_process');
    // 先用 silenceremove 去掉开头静音，再用 atrim 丢掉带辨识度的开头（见 SKIP_HEAD 注释），
    // 最后 asetpts 重置时间戳（否则 atrim 后时间轴仍从 skip 处起算，-t 会截错）。
    const skipHead = skip;   // 见上方「源时长不足则退化」的判断
    const filter = skipHead > 0
      ? `silenceremove=start_periods=1:start_silence=0.05:start_threshold=-45dB,` +
        `atrim=start=${skipHead},asetpts=N/SR/TB`
      : 'silenceremove=start_periods=1:start_silence=0.05:start_threshold=-45dB';
    const r = spawnSync(
      getFfmpegPath(),
      [
        '-y', '-i', audioPath,
        '-af', filter,
        '-t', String(keep),
        '-ar', '32000', '-ac', '2', '-c:a', 'pcm_s16le',
        outPath,
      ],
      { encoding: 'utf8', maxBuffer: 16 * 1024 * 1024 }
    );
    if (r.status !== 0 || !fs.existsSync(outPath)) {
      log.warn('[ComfyUI] 音色参考裁剪失败，保留原文件', {
        file: path.basename(audioPath),
        stderr: (r.stderr || '').slice(-400),
      });
      return { path: audioPath, changed: false, from: origDuration };
    }
    // 裁出来的新文件为 0 字节/极短时不替换（例如源文件几乎全是静音）
    const newDuration = probeMediaDuration(outPath, log);
    if (newDuration == null || newDuration < 0.3) {
      log.warn('[ComfyUI] 音色参考裁剪结果过短，保留原文件', {
        file: path.basename(audioPath),
        trimmed_seconds: newDuration,
      });
      try { fs.unlinkSync(outPath); } catch (_) {}
      return { path: audioPath, changed: false, from: origDuration };
    }
    try { fs.unlinkSync(audioPath); } catch (_) {}
    return { path: outPath, changed: true, from: origDuration, to: newDuration };
  } catch (e) {
    log.warn('[ComfyUI] 音色参考裁剪异常，保留原文件: ' + e.message);
    try { if (fs.existsSync(outPath)) fs.unlinkSync(outPath); } catch (_) {}
    return { path: audioPath, changed: false, from: origDuration };
  }
}

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

/**
 * MiniMax H3 的帧数必须落在 17k+5 网格上。
 * ComfyUI 节点内部也是 `while n % 17 != 5: n += 1` 逐帧上取（comfy_extras/nodes_minimax_h3.py:37），
 * 这里主动对齐，避免把 8k+1 的值丢过去、再依赖对方静默吸附（那样请求时长会被悄悄改掉）。
 */
function snapToH3FrameGrid(n) {
  let f = Math.max(5, Math.round(n));
  while (f % 17 !== 5) f++;
  return f;
}

/**
 * 找出工作流里的「turbo 加速」开关节点。
 * 这类工作流的写法是：一个 PrimitiveBoolean 同时驱动若干 ComfySwitchNode
 * （一个切「原始模型 / 挂 LoRA」，一个切「多步数 / 少步数」），
 * 见 A03 的 146 → 141/142。这里按结构识别，不写死节点号，换工作流也能用。
 */
function findTurboSwitchIds(prompt) {
  const switchIds = new Set();
  for (const node of Object.values(prompt)) {
    if (node && node.class_type === 'ComfySwitchNode') {
      const sw = node.inputs && node.inputs.switch;
      if (Array.isArray(sw) && typeof sw[0] === 'string') switchIds.add(sw[0]);
    }
  }
  return [...switchIds].filter((id) => prompt[id] && prompt[id].class_type === 'PrimitiveBoolean');
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

/** 统一解析 ComfyUI input 目录：优先 AI 配置 settings.input_dir，其次环境变量 COMFYUI_INPUT_DIR，默认 ~/ComfyUI/input */
function resolveComfyInputDir(config) {
  if (config && config.settings) {
    try {
      const s = typeof config.settings === 'string' ? JSON.parse(config.settings) : config.settings;
      if (s.input_dir && typeof s.input_dir === 'string') return s.input_dir;
    } catch (_) {}
  }
  if (process.env.COMFYUI_INPUT_DIR) return process.env.COMFYUI_INPUT_DIR;
  return path.join(require('os').homedir(), 'ComfyUI', 'input');
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

/** 把音频参考 URL/路径准备进 ComfyUI input 目录，返回可写入 LoadAudio 的 [{name, ext}] 列表（含 srcIndices 对齐）。 */
async function prepareReferenceAudios(referenceUrls, comfyuiInputDir, log, storageLocalPath) {
  if (!Array.isArray(referenceUrls) || referenceUrls.length === 0) return [];
  const filenames = [];
  const srcIndices = [];
  const AUDIO_EXTS = ['.mp3', '.wav', '.m4a', '.oga', '.ogg', '.aac', '.flac', '.mp4'];
  for (let i = 0; i < referenceUrls.length; i++) {
    const ref = referenceUrls[i];
    if (!ref) continue;
    try {
      const extMatch = String(ref).split('?')[0].match(/\.([a-zA-Z0-9]+)$/);
      const ext = '.' + (extMatch ? extMatch[1].toLowerCase() : 'mp3');
      const safeExt = AUDIO_EXTS.includes(ext) ? ext : '.mp3';
      const name = 'ref_audio_' + Date.now() + '_' + i + safeExt;
      const destPath = path.join(comfyuiInputDir, name);
      let via = null;
      if (ref.startsWith('data:audio')) {
        const base64Data = ref.replace(/^data:audio\/[^;]+;base64,/, '');
        fs.writeFileSync(destPath, Buffer.from(base64Data, 'base64'));
        via = 'base64';
      } else if (ref.startsWith('http://') || ref.startsWith('https://')) {
        await httpDownload(ref, destPath);
        via = 'http';
      } else if (fs.existsSync(ref)) {
        fs.copyFileSync(ref, destPath);
        via = 'abs-path';
      } else {
        // 处理相对路径：优先 strip 掉 /static/ 或 /uploads/ 前缀，再按 storage 根目录解析，
        // 兼容 seedance2_voice_asset.url 这类 /static/drama_X/characters/voice/xxx.mp3。
        const stripped = String(ref).replace(/^\/?(static|uploads)\//, '');
        if (storageLocalPath && stripped && fs.existsSync(path.join(storageLocalPath, stripped))) {
          fs.copyFileSync(path.join(storageLocalPath, stripped), destPath);
          via = 'storage-rel';
        } else if (fs.existsSync(stripped)) {
          fs.copyFileSync(stripped, destPath);
          via = 'abs-path';
        } else {
          log.warn('[ComfyUI] 参考音频 ' + (i + 1) + '/' + referenceUrls.length + ' 未找到，跳过: ' + String(ref).slice(0, 160));
          continue;
        }
      }
      log.info('[ComfyUI] 参考音频 ' + (i + 1) + '/' + referenceUrls.length + ' 已就绪 (' + via + '): ' + String(ref).slice(0, 120) + ' -> ' + name);
      // H3 音色参考裁到 4 秒（见 H3_VOICE_REF_MAX_SECONDS 注释）。非 H3 路径不经过本函数。
      const trimmed = trimVoiceReference(destPath, log);
      const finalName = trimmed.changed ? path.basename(trimmed.path) : name;
      if (trimmed.changed) {
        log.info('[ComfyUI] 音色参考已裁剪 ' + trimmed.from.toFixed(2) + 's -> ' + trimmed.to.toFixed(2) + 's'
          + (H3_VOICE_REF_SKIP_HEAD_SECONDS > 0 ? '（另跳过开头 ' + H3_VOICE_REF_SKIP_HEAD_SECONDS + 's）' : '') + ': ' + finalName);
      }
      filenames.push(finalName);
      srcIndices.push(i);
    } catch (e) {
      log.warn('[ComfyUI] 参考音频 ' + (i + 1) + '/' + referenceUrls.length + ' 处理失败: ' + String(ref).slice(0, 120) + ' err=' + e.message);
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
    const inputDir = resolveComfyInputDir(config);
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

/** 检测工作流是否为 MiniMax H3 参考图生视频（含编辑器格式 nodes/links 与 API 格式两种） */
function hasH3ReferenceNode(wf) {
  if (!wf) return false;
  const isRef = (t) => t === 'MiniMaxH3ReferenceToVideo' || t === 'MiniMaxH3ImageToVideo';
  if (Array.isArray(wf.nodes)) return wf.nodes.some((n) => isRef(n.type));
  return Object.values(wf).some((n) => n && typeof n === 'object' && isRef(n.class_type));
}

/**
 * H3 参考生视频：把参考图按要求接到 MiniMaxH3ReferenceToVideo 的 ref_image_0..N。
 *  - labels 与 refImages 等长且带类型（scene/角色/character 等）：Qwen 式分组，
 *    多角色/多物品用 ImageStitch 横拼成单张，最多 3 通道，并生成中文说明头拼进 prompt。
 *  - 无 labels：每张参考图一个 LoadImage，逐张切槽（最多 9 张，节点 Autogrow 上限）。
 * 就地修改 apiPrompt，返回说明头（可为空串）。
 */
function applyH3RefsToApi(apiPrompt, refImages, labels, promptText, audioFiles, audioLabels, dialogueSpeakers, shotSeconds, log) {
  let h3Id = null;
  for (const [nid, node] of Object.entries(apiPrompt)) {
    if (node && node.class_type === 'MiniMaxH3ReferenceToVideo') { h3Id = nid; break; }
  }
  if (!h3Id) return '';
  const h3 = apiPrompt[h3Id];
  // 清掉旧接线（若工作流本身有 ref_image_0..N / ref_audio_0..N -> LoadImage/LoadAudio）。
  // 应用可投喂参考图与参考音频；参考视频/音轨暂未用，保留占位会因文件不存在而报错，故一并断开。
  for (const k of Object.keys(h3.inputs || {})) {
    if (k.indexOf('ref_images.ref_image_') === 0 ||
        k.indexOf('ref_audios.ref_audio_') === 0 ||
        k.indexOf('ref_videos.ref_video_') === 0 ||
        k.indexOf('ref_video_audios.ref_video_audio_') === 0) {
      delete h3.inputs[k];
    }
  }

  // MiniMax H3 本地节点只用 <Picture i>/<Video k>/<Audio j> 标签把参考媒体编码进 conditioning；
  // 正文里的 @图片N / 参考图N 均为普通文本，不引入参考 token。
  // 逐张独立：把每张参考图接到各自的 ref_image_N，<Picture N> 编号从 1 起，与 ref_image_0.. 连接顺序一致。
  const toPictureTags = (s) =>
    String(s || '')
      .replace(/@图片\s*(\d+)/g, '<Picture $1>')
      .replace(/参考图\s*(\d+)/g, '<Picture $1>');

  // 历史遗留措辞修正抽到 utils/segmentTextNormalize.js 共用（英译前置步骤也要用，且必须在英译之前跑）
  let boundPrompt = markDialogue(fixLegacySegmentText(toPictureTags(promptText)), dialogueSpeakers);

  // 说话人 → (Sx) 编号表：供下面 <Audio j> 说明行把音轨绑到具体说话人
  const speakerIds = new Map();
  for (const n of (Array.isArray(dialogueSpeakers) ? dialogueSpeakers : [])) {
    const name = String(n || '').trim();
    if (name && !speakerIds.has(name)) speakerIds.set(name, speakerIds.size + 1);
  }

  // 说明头语言跟随正文：
  // 正文已是英文（英译成功）时，说明头也走英文。原因是实测发现「谈论语音」的文字最容易被
  // 当成台词念出来 —— 中文的 <Audio 1> 说明行里带「只/严禁」这类限制性措辞，
  // 在中文正文那批渲染里疑似被朗读（用户听到「限制了步数」）。正文英文时不要再留中文说明。
  // 判定时先剥掉 <d> 块，因为对白本来就该保留中文。
  const bodyWithoutDialogue = String(promptText || '').replace(/<d>[\s\S]*?<\/d>/g, '');
  const useEnHeader = !!bodyWithoutDialogue.trim() && !/[\u4e00-\u9fa5]/.test(bodyWithoutDialogue);

  // 逐张：每图一个 LoadImage，直接接 ref_image_0..N（最多 9 张），不拼图
  const addNodes = {};
  const cap = Math.min(refImages.length, 9);
  const headerLines = [];
  for (let i = 0; i < cap; i++) {
    const k = 'h3_ld_i' + i;
    addNodes[k] = { class_type: 'LoadImage', inputs: { image: refImages[i] } };
    h3.inputs['ref_images.ref_image_' + i] = [k, 0];
    const lbl = String((Array.isArray(labels) ? labels[i] : '') || '');
    const nameMatch = lbl.match(/for\s+"([^"]+)"/i);
    const name = nameMatch ? nameMatch[1] : '';
    const picNum = i + 1;
    let desc;
    if (useEnHeader) {
      if (/scene background|场景|scene/i.test(lbl)) {
        desc = '<Picture ' + picNum + '>: scene and environment reference (the image may be a multi-view sheet or a multi-panel collage — extract only the unified space, lighting and atmosphere; do not reproduce its panels or side-by-side layout in the final shot)';
      } else if (/character appearance|角色|character/i.test(lbl)) {
        desc = '<Picture ' + picNum + '>: appearance reference for the character "' + (name || ('Character ' + picNum)) + '" (if the image is a multi-view turnaround, keep only the face, hairstyle and costume; the finished shot must be one single natural camera view)';
      } else {
        desc = '<Picture ' + picNum + '>: appearance reference for the prop "' + (name || ('Prop ' + picNum)) + '" (if it is a multi-angle or composite image, keep only the prop\'s exterior shape)';
      }
    } else {
      if (/scene background|场景|scene/i.test(lbl)) {
        desc = '<Picture ' + picNum + '>：场景环境参考（注意：该图为参考，可能是多视角/宫格拼图——只取其中统一的空间、光线与氛围语义，禁止照搬其分格/取景/并列布局）';
      } else if (/character appearance|角色|character/i.test(lbl)) {
        desc = '<Picture ' + picNum + '>：角色「' + (name || '角色' + picNum) + '」外貌参考（若该图为同一人物多角度/四视图合成图，仅锁定其长相、发型、服装；成片取单一自然镜头，禁止复现其多视图/拼图布局）';
      } else {
        desc = '<Picture ' + picNum + '>：道具「' + (name || '物品' + picNum) + '」外观参考（若为多角度/合成图，仅锁定道具外形）';
      }
    }
    headerLines.push(desc);
  }

  // 参考音频：每段独立接 ref_audio_0..N（最多 3 段），<Audio j> 编号从 1 起
  //
  // 措辞很关键。旧文案是「参考音频片段（用作生成音频的音色/节奏参考，按 <Audio j> 标签引用）」，
  // 实测会导致模型把参考音频的开头「续读」出来（镜 3 用户听到参考音频开头的「你好」）。
  // 官方规范 §5.4：「When only timbre … is referenced, do not carry the original dialogue
  // from the reference audio into the target video.」
  // 所以这里：① 指明是哪个角色的音色 ② 显式禁止复述内容 ③ 语言跟随正文。
  // 另外说明行里**不能出现字面量 <d>**（special token，会造成开闭标签不平衡）。
  const audioList = (Array.isArray(audioFiles) ? audioFiles : []).filter(Boolean);
  const audioCap = Math.min(audioList.length, 3);
  for (let j = 0; j < audioCap; j++) {
    const k = 'h3_ad_' + j;
    addNodes[k] = { class_type: 'LoadAudio', inputs: { audio: audioList[j] } };
    h3.inputs['ref_audios.ref_audio_' + j] = [k, 0];
    const who = String((Array.isArray(audioLabels) ? audioLabels[j] : '') || '').trim();
    const sid = who && speakerIds.has(who) ? speakerIds.get(who) : 0;
    if (useEnHeader) {
      // 极简陈述句，照官方规范 <Audio N> 的写法。
      // 不要在这里写「只能/严禁/见下方」这类关于说话的说明 —— 实测这类文字会被模型念出来
      // （用户两次听到 <Audio 1> 说明行被朗读：一次疑似「限制了步数」、一次「本…下方」）。
      const subj = who
        ? 'voice-timbre reference for the character "' + who + '"' + (sid ? ' (S' + sid + ')' : '')
        : 'voice-timbre reference';
      headerLines.push('<Audio ' + (j + 1) + '>: ' + subj + '.');
    } else {
      const subject = who
        ? '角色「' + who + '」' + (sid ? ' (S' + sid + ')' : '') + ' 的音色参考'
        : '音色参考';
      headerLines.push('<Audio ' + (j + 1) + '>：' + subject + '。');
    }
  }

  Object.assign(apiPrompt, addNodes);

  const headerLead = useEnHeader
    ? '\n\nGenerate one continuous, complete single take (no collage, no split screen, no grid, no side-by-side panels; do not reproduce the reference images\' grid or multi-view layout):\n'
    : '\n\n生成一段连续、完整、单一镜头的画面（禁止拼贴、分屏、宫格、多画面并列、复刻参考图的网格/多视图布局）：\n';
  const header = headerLines.length ? headerLines.join('\n') + headerLead : '';
  if (header && promptText !== undefined) h3.inputs.prompt = header + boundPrompt;
  else if (promptText !== undefined) h3.inputs.prompt = boundPrompt;

  // 守卫：<d>/</d> 必须配平。它们是词表 special token（MINIMAX_EXTRA_TOKENS），
  // 说明性文字里出现孤立标签会干扰模型判断哪些文本是台词，而且这种错误此前是静默进模型的。
  const finalPrompt = String(h3.inputs.prompt || '');
  const openD = (finalPrompt.match(/<d>/g) || []).length;
  const closeD = (finalPrompt.match(/<\/d>/g) || []).length;
  if (openD !== closeD && log && typeof log.warn === 'function') {
    log.warn('[ComfyUI/H3] prompt 里 <d> 与 </d> 数量不平衡，请检查说明性文字是否混入了字面标签', {
      open_d: openD, close_d: closeD,
    });
  }
  return header;
}

async function callComfyUIVideoApi(config, log, opts) {
  const { prompt, model, image_url, video_gen_id, files_base_url, storage_local_path, reference_image_urls, reference_labels, reference_audio_urls, voice_reference_url, voice_reference_name, dialogue_speakers } = opts;
  const reference_audio_names = opts.reference_audio_names;
  const baseUrl = (config.base_url || "http://127.0.0.1:8188").replace(/\/$/, "");

  const fs = require("fs");
  const path = require("path");

  // 解析服务级 settings（AI 配置页保存的 JSON）：workflow / megapixels / turbo
  let workflowFile = null;
  let svcMegapixels = NaN;
  let svcTurbo; // undefined = 不覆盖工作流自身的开关
  if (config.settings) {
    try {
      const s = typeof config.settings === 'string' ? JSON.parse(config.settings) : config.settings;
      if (s.workflow) workflowFile = s.workflow;
      svcMegapixels = Number(s.megapixels);
      if (typeof s.turbo === 'boolean') svcTurbo = s.turbo;
    } catch (_) {}
  }

  // fps=24。帧数一律按 MiniMax H3 的 17k+5 网格对齐
  // （官方已验证范围约 124~362 帧 ≈ 5.2~15.1s；超上限在下面 isH3Ref 分支里夹取）
  const fps = 24;
  const videoDuration = Number(opts.duration) || 5;
  let frames = snapToH3FrameGrid(videoDuration * fps);

  // 分辨率：与官方 ResolutionSelector 同构（comfy_extras/nodes_resolution.py:82-85）——
  //   total = megapixels * 1024 * 1024（官方用的是二进制 MP，不是 1e6），再按 multiple=32 取整。
  //   唯一配置入口：「AI 配置 → 视频服务 → 视频画幅」，存于 settings.megapixels；
  //   兜底顺序：settings.megapixels → config.yaml style.default_video_megapixels → 0.5
  //   0.4 MP → 16:9 得 864x480；0.5 → 960x544；0.98 → 1344x768（768p LoRA 的训练分辨率）
  const cfgMegapixels = Number(config && config.style && config.style.default_video_megapixels);
  const rawMegapixels = Number.isFinite(svcMegapixels) && svcMegapixels > 0
    ? svcMegapixels
    : (Number.isFinite(cfgMegapixels) && cfgMegapixels > 0 ? cfgMegapixels : 0.5);
  const VIDEO_MEGAPIXELS = Math.min(2.0, Math.max(0.1, rawMegapixels));
  const totalPx = Math.round(VIDEO_MEGAPIXELS * 1024 * 1024);
  const ratio = (opts.aspect_ratio || '').toString();
  const [rw, rh] = ratio.includes(':') ? ratio.split(':').map(Number) : [9, 16];
  const ratioVal = rw / rh;
  const vidW = Math.max(256, Math.round(Math.sqrt(totalPx * ratioVal) / 32) * 32);
  const vidH = Math.max(256, Math.round(Math.sqrt(totalPx / ratioVal) / 32) * 32);

  // Prepare input image
  const inputDir = resolveComfyInputDir(config);
  if (!fs.existsSync(inputDir)) fs.mkdirSync(inputDir, { recursive: true });
  let imgName = "example.png";
  if (image_url) {
    const prepared = await prepareReferenceImages([image_url], inputDir, log, storage_local_path);
    if (prepared.length > 0) imgName = prepared[0];
    else log.warn("[ComfyUI/Video] Failed to prepare input image: " + String(image_url).slice(0, 120));
  }

  // 动态工作流模式
  if (workflowFile) {
    const { loadWorkflow, prepareWorkflow, extractImageFromResult } = require('./workflowEngine');

    const wf = loadWorkflow(workflowFile);
    const seed = Math.floor(Math.random() * 9007199254740991);
    const isH3Ref = hasH3ReferenceNode(wf);

    // H3 的 `length` 训练范围是 124~362 帧（节点 tooltip 原文 "trained range is ~124-362"）。
    // 此前超限只告警不拦截，若时长被手填成 16s→384 帧 会直接送进模型，白跑一次几十分钟的渲染。
    // 这里夹到 362 帧（=15.08s）并重新对齐 17k+5 网格；362 % 17 === 5，本来就是合法网格点。
    const H3_MAX_FRAMES = 362;
    if (isH3Ref && frames > H3_MAX_FRAMES) {
      const clamped = snapToH3FrameGrid(H3_MAX_FRAMES);
      log.warn('[视频] 帧数超出 H3 已验证范围（124~362 帧），已夹到上限', {
        requested_duration: videoDuration,
        requested_frames: frames,
        clamped_frames: clamped,
        clamped_seconds: Number((clamped / fps).toFixed(2)),
      });
      frames = clamped;
    }

    log.info('[ComfyUI/Video/' + workflowFile + '] Starting (dynamic)', {
      frames,
      size: vidW + 'x' + vidH,
      megapixels: VIDEO_MEGAPIXELS,
      is_h3: isH3Ref,
    });

    // H3 参考生视频：准备多张参考图（场景/角色/道具）+ 标签；非 H3 工作流用首帧图
    let refImages;
    let refLabelsArr = [];
    let refAudios = [];
    let voiceRefLabels = [];
    if (isH3Ref) {
      const rawUrls = Array.isArray(reference_image_urls) ? reference_image_urls.filter(Boolean) : [];
      const rawLabels = Array.isArray(reference_labels) ? reference_labels : [];
      const items = rawUrls.map((u, i) => ({ url: u, label: rawLabels[i] || '' }));
      if (items.length) {
        const prepped = await prepareReferenceImages(items.map((it) => it.url), inputDir, log, storage_local_path);
        refImages = prepped;
        const srcIndices = prepped.srcIndices || items.map((_, i) => i);
        refLabelsArr = srcIndices.map((si) => (items[si] ? items[si].label : ''));
      }
      if (!refImages || !refImages.length) {
        if (image_url) {
          refImages = await prepareReferenceImages([image_url], inputDir, log, storage_local_path);
          refLabelsArr = [];
        } else {
          refImages = [];
        }
      }
      // 参考音频：准备进 input 目录，逐段接 ref_audio_0..N。
      // voice_reference_url（角色音色参考 / 旁白 TTS）也作为一段参考音频并入，让本地 H3 能用到音色。
      const audioUrls = (Array.isArray(reference_audio_urls) ? reference_audio_urls.filter(Boolean) : []);
      // 与 audioUrls 下标对齐的角色名，供 <Audio j> 说明行点名「这是谁的音色」
      const audioNames = (Array.isArray(reference_audio_names) ? reference_audio_names.slice() : []);
      const voiceUrl = voice_reference_url ? String(voice_reference_url).trim() : '';
      if (voiceUrl && !audioUrls.includes(voiceUrl)) {
        audioUrls.unshift(voiceUrl);
        audioNames.unshift(voice_reference_name ? String(voice_reference_name) : '');
      }
      if (audioUrls.length) {
        refAudios = await prepareReferenceAudios(audioUrls, inputDir, log, storage_local_path);
        voiceRefLabels = audioNames;
      }
    }

    const { prompt: apiPrompt, resolutionInjections } = prepareWorkflow(wf, {
      prompt: prompt || '',
      width: vidW,
      height: vidH,
      megapixels: VIDEO_MEGAPIXELS,
      aspectRatio: ratio,
      seed,
      videoFrames: frames,
      videoFps: fps,
      refImages: isH3Ref ? undefined : refImages,
    });

    // 分辨率对工作流的干预程度：semantic = 只改了上游分辨率节点的 megapixels（工作流的
    // aspect_ratio/multiple 等仍然生效）；direct = 没有语义上游，降级为覆盖 width/height。
    if (resolutionInjections.length) {
      const semantic = resolutionInjections.every((s) => s.endsWith(':semantic'));
      log.info('[ComfyUI/Video] 分辨率注入 ' + (semantic ? 'semantic' : 'direct'), {
        nodes: resolutionInjections,
        megapixels: VIDEO_MEGAPIXELS,
        aspect_ratio: ratio,
      });
    }

    // turbo 加速：按「AI 配置 → 视频服务 → turbo 加速」覆盖工作流内的开关。
    // settings.turbo 未设置时完全不动工作流（保持文件里的原值）；true/false 则强制覆盖。
    if (typeof svcTurbo === 'boolean') {
      const turboIds = findTurboSwitchIds(apiPrompt);
      if (turboIds.length) {
        for (const id of turboIds) apiPrompt[id].inputs.value = svcTurbo;
        log.info('[ComfyUI/Video] turbo 开关已覆盖', { turbo: svcTurbo, nodes: turboIds });
      } else {
        log.warn('[ComfyUI/Video] 该工作流没有 turbo 开关节点（PrimitiveBoolean/ComfySwitchNode），settings.turbo 不生效', {
          turbo: svcTurbo,
        });
      }
    }

    // H3 参考生视频：分组/拼图/说明头/动态槽位已由 applyH3RefsToApi 处理，跳过首帧图覆盖
    if (isH3Ref) {
      const header = applyH3RefsToApi(apiPrompt, refImages || [], refLabelsArr, prompt || '', refAudios, voiceRefLabels, dialogue_speakers, frames / fps, log);
      log.info("[ComfyUI/H3] 参考生视频，参考图 " + (refImages ? refImages.length : 0) + " 张，参考音频 " + (refAudios ? refAudios.length : 0) + " 段" + (header ? '（含说明头）' : ''));
    } else {
      // 非 H3 工作流的通用注入（RandomNoise / LoadImage / CLIPTextEncode 对任何工作流都适用）
      for (const [nid, node] of Object.entries(apiPrompt)) {
        if (node.class_type === 'RandomNoise') {
          node.inputs.noise_seed = seed;
        }
        if (node.class_type === 'LoadImage' && node.inputs.image != null) {
          node.inputs.image = imgName;
        }
        if (node.class_type === 'CLIPTextEncode' && !Array.isArray(node.inputs.text)) {
          node.inputs.text = prompt || '';
        }
      }
    }

    log.info("[ComfyUI/Video/" + workflowFile + "] Submitting " + Object.keys(apiPrompt).length + " nodes");
    const payload = { prompt: apiPrompt, client_id: "localminidrama_video_" + Date.now() };

    let submitResp;
    try {
      submitResp = await postJSON(baseUrl + "/prompt", payload, 30000);
    } catch (e) {
      throw new Error("ComfyUI submit failed: " + e.message);
    }
    const promptId = submitResp.prompt_id;
    if (!promptId) throw new Error("ComfyUI submit returned no prompt_id");
    log.info("[ComfyUI/Video] Submitted prompt_id=" + promptId);

    const result = await waitForComfyJob(baseUrl, promptId, log, {
      runningBudgetMs: 30 * 60 * 1000,
      absoluteCapMs: 4 * 3600 * 1000,
      tag: '/Video',
    });

    let videoFilename = null;
    let videoSubfolder = '';
    const outs = result.outputs || {};
    for (const key of Object.keys(outs)) {
      const out = outs[key];
      if (out.images && out.images.length > 0) { videoFilename = out.images[0].filename; videoSubfolder = out.images[0].subfolder || ''; break; }
      if (out.gifs && out.gifs.length > 0) { videoFilename = out.gifs[0].filename; videoSubfolder = out.gifs[0].subfolder || ''; break; }
      if (out.videos && out.videos.length > 0) { videoFilename = out.videos[0].filename; videoSubfolder = out.videos[0].subfolder || ''; break; }
    }
    if (!videoFilename) throw new Error("ComfyUI completed but no video found");

    // SaveVideo 的 filename_prefix 常含子目录（如 video/MiniMax_H3），ComfyUI 输出对象的 subfolder 字段
    // 记录该子目录；/view 必须带 subfolder 才能取到文件，否则 404。
    const viewParams = "filename=" + videoFilename + "&type=output" +
      (videoSubfolder ? "&subfolder=" + encodeURIComponent(videoSubfolder) : "");
    const videoUrl = baseUrl + "/view?" + viewParams;
    log.info("[ComfyUI/Video/" + workflowFile + "] Done: " + videoUrl);
    return { video_url: videoUrl };
  }

  // 未配置工作流：明确报错。
  // 注：此处原先会回退到硬编码的 LTX 2.3 工作流（src/services/workflows/ltx23-i2v-api.json），
  // 项目已不再支持 LTX，改为显式报错，避免「没选工作流却静默换模型出片」。
  throw new Error('ComfyUI 视频配置未选择工作流：请在「AI 配置 → 视频服务」中选择工作流文件（settings.workflow）');
}

module.exports = { callComfyUIImageApi, callComfyUIVideoApi, parseSize, hasH3ReferenceNode, applyH3RefsToApi, prepareReferenceAudios };
