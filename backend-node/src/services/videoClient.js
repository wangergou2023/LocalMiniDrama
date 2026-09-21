// ? Go pkg/video + VideoGenerationService ????????? API??????(????)
const fs = require('fs');
const path = require('path');
const { callComfyUIVideoApi, resumeComfyUIVideo, cancelComfyUIJob } = require("./comfyuiClient");
const aiConfigService = require('./aiConfigService');
const { parseDialogueSpeakers } = require('../utils/h3DialogueMark');
const { ensureEnglishSegmentText } = require('./segmentTextI18nService');

/**
 * ?? provider ??????????api_protocol ??????????
 */
function inferVideoProtocol(provider) {
  const p = String(provider || '').toLowerCase();
  if (p === 'minimax_h3' || p === 'minimax') return 'minimax_h3';
  return 'openai';
}

/** 官方模型 ID：MiniMax-H3（Video Generation V2） */
function isMinimaxH3Model(name) {
  const m = String(name || '').trim().toLowerCase();
  return m === 'minimax-h3' || m === 'minimax_h3' || /^minimax[-_]?h3\b/.test(m);
}

/**
 * 显式 api_protocol 优先；未配置时推断。
 * MiniMax-H3 走 V2（/v2/video_generation），与旧海螺 V1 不同。
 */
function resolveVideoProtocol(config, modelHint) {
  const provider = (config.provider || '').toLowerCase();
  const explicit = String(config.api_protocol || '').trim();
  let protocol = explicit.toLowerCase() || inferVideoProtocol(provider);
  const modelCand =
    modelHint ||
    config.default_model ||
    (Array.isArray(config.model) ? config.model[0] : config.model) ||
    '';
  if ((!explicit || protocol === 'openai') && (provider === 'minimax_h3' || isMinimaxH3Model(modelCand))) {
    protocol = 'minimax_h3';
  }
  return protocol;
}

/** Omni-Video 文档支持的 aspect_ratio；有参考图时也必须传，否则接口易默认 16:9 */
const KLING_OMNI_ASPECT_RATIOS = new Set(['9:16', '16:9', '1:1', '4:3', '3:4', '3:2', '2:3']);

/**
 * 归一化前端/元数据里的画幅字符串，便于命中可灵枚举（全角冒号、别名等）
 * @returns {string|null} 可灵支持的比值，无法识别时返回 null
 */
function normalizeAspectRatioForApi(raw) {
  if (raw == null) return null;
  let s = String(raw)
    .trim()
    .replace(/\uFF1A/g, ':')
    .replace(/[×xX＊*]/g, ':')
    .replace(/\s+/g, '');
  if (!s) return null;
  const lower = s.toLowerCase();
  const aliases = {
    portrait: '9:16',
    landscape: '16:9',
    square: '1:1',
    vertical: '9:16',
    horizontal: '16:9',
  };
  if (aliases[lower]) s = aliases[lower];
  return KLING_OMNI_ASPECT_RATIOS.has(s) ? s : null;
}

// ??????????????????listConfigs ?? is_default DESC, priority DESC ??
function getDefaultVideoConfig(db, preferredModel, preferredProvider) {
  const configs = aiConfigService.listConfigs(db, 'video');
  let active = configs.filter((c) => c.is_active);
  if (active.length === 0) return null;
  // 按厂商优先：取消/恢复时需要定位当初用的那条配置，而不是当前默认那条
  if (preferredProvider && String(preferredProvider).trim()) {
    const want = String(preferredProvider).trim().toLowerCase();
    const byProvider = active.filter((c) => (c.provider || '').toLowerCase() === want);
    if (byProvider.length > 0) active = byProvider;
  }
  if (preferredModel) {
    for (const c of active) {
      const models = Array.isArray(c.model) ? c.model : (c.model != null ? [c.model] : []);
      if (models.includes(preferredModel)) return c;
    }
  }
  const defaultOne = active.find((c) => c.is_default);
  return defaultOne != null ? defaultOne : active[0];
}

function buildQueryUrl(config, taskId) {
  const proto = resolveVideoProtocol(config);
  if (proto === 'minimax_h3') return buildMinimaxH3PollUrl(config, taskId);
  const base = (config.base_url || '').replace(/\/$/, '');
  let defaultEp = '/video/task/{taskId}';
  let ep = config.query_endpoint || defaultEp;
  ep = String(ep).replace(/\{taskId\}/gi, encodeURIComponent(taskId)).replace(/\{task_id\}/gi, encodeURIComponent(taskId)).replace(/\{id\}/gi, encodeURIComponent(taskId));
  if (!ep.startsWith('/')) ep = '/' + ep;
  return base + ep;
}

function getModelFromConfig(config, preferredModel) {
  const models = Array.isArray(config.model) ? config.model : (config.model != null ? [config.model] : []);
  if (preferredModel && models.includes(preferredModel)) return preferredModel;
  if (config.default_model && models.includes(config.default_model)) return config.default_model;
  return models[0] || '';
}

/** 仅把 http(s) 当作可下载直链，避免方舟/中转让 result_url 填入错误文案 */
function isPlausibleHttpVideoUrl(s) {
  if (typeof s !== 'string') return false;
  const t = s.trim();
  return /^https?:\/\//i.test(t);
}

function coerceHttpVideoUrl(s) {
  return isPlausibleHttpVideoUrl(s) ? String(s).trim() : null;
}

/** 轮询 JSON 中的任务状态（兼容中转 data.data.status = FAILURE） */
function extractPollTaskStatus(data) {
  if (!data || typeof data !== 'object') return '';
  const candidates = [
    data.status,
    data.state,
    data.task_status,
    data.data?.status,
    data.data?.state,
    data.data?.task_status,
    data.output?.task_status,
  ];
  for (const c of candidates) {
    if (c != null && String(c).trim() !== '') return String(c).trim().toLowerCase();
  }
  return '';
}

function isPollTaskFailed(status) {
  return (
    status === 'failed' ||
    status === 'failure' ||
    status === 'error' ||
    status === 'cancelled' ||
    status === 'canceled' ||
    status === 'fail'
  );
}

/** 失败时的可读错误（fail_reason、非 http 的 result_url 等） */
function extractPollFailureMessage(data) {
  if (!data || typeof data !== 'object') return '';
  const inner = data.data && typeof data.data === 'object' && !Array.isArray(data.data) ? data.data : null;
  const deep = inner?.data && typeof inner.data === 'object' ? inner.data : null;
  const candidates = [
    inner?.fail_reason,
    data.fail_reason,
    inner?.message,
    deep?.msg,
    data.error?.message,
    typeof data.error === 'string' ? data.error : null,
    data.message,
    typeof data.msg === 'string' ? data.msg : null,
  ];
  for (const c of candidates) {
    if (c == null) continue;
    const s = String(c).trim();
    if (s && !/^https?:\/\//i.test(s)) return s;
  }
  for (const rec of [inner, data]) {
    if (!rec || typeof rec !== 'object') continue;
    for (const k of ['result_url', 'video_url']) {
      const u = rec[k];
      if (typeof u === 'string' && u.trim() && !isPlausibleHttpVideoUrl(u)) return u.trim();
    }
  }
  return '';
}

/** 单层对象上的视频地址：兼容中转站使用 result_url 而非 video_url */
function videoUrlFromRecord(rec) {
  if (!rec || typeof rec !== 'object') return null;
  return (
    coerceHttpVideoUrl(rec.video_url) ||
    coerceHttpVideoUrl(rec.result_url) ||
    coerceHttpVideoUrl(rec.url) ||
    coerceHttpVideoUrl(rec.output_url) ||
    // Agnes Video V2.0 完成态有时将 MP4 直链放在 remixed_from_video_id
    coerceHttpVideoUrl(rec.remixed_from_video_id) ||
    null
  );
}

/** 方舟 / 豆包 Seedance 等：video.transcoded_video.origin.video_url，或 play/download 直链 */
function videoUrlFromArkVideoNode(video) {
  if (!video || typeof video !== 'object') return null;
  const origin =
    video.transcoded_video && typeof video.transcoded_video === 'object' ? video.transcoded_video.origin : null;
  if (origin && typeof origin === 'object' && typeof origin.video_url === 'string') {
    const u = coerceHttpVideoUrl(origin.video_url);
    if (u) return u;
  }
  for (const k of ['download_url', 'play_url', 'url', 'video_url']) {
    const u = coerceHttpVideoUrl(video[k]);
    if (u) return u;
  }
  return null;
}

/** 查询结果里 item_list[0] 形态（与中转站 videos 控制器一致） */
function pickVideoUrlFromItemList(list) {
  if (!Array.isArray(list) || !list.length) return null;
  const item = list[0];
  if (!item || typeof item !== 'object') return null;
  const ca = item.common_attr;
  const fromCommon =
    ca &&
    ca.transcoded_video &&
    typeof ca.transcoded_video === 'object' &&
    ca.transcoded_video.origin &&
    typeof ca.transcoded_video.origin.video_url === 'string' &&
    ca.transcoded_video.origin.video_url.trim()
      ? ca.transcoded_video.origin.video_url.trim()
      : null;
  const fromVideo = videoUrlFromArkVideoNode(item.video);
  const fromResult = coerceHttpVideoUrl(item.result_url);
  const flat = videoUrlFromRecord(item);
  return fromCommon || fromVideo || fromResult || flat || null;
}

/**
 * 方舟类「任务查询」里常见：result 本体无 video_url，而在 result.content.video_url
 */
function pickVideoUrlFromResultShape(obj) {
  if (!obj || typeof obj !== 'object') return null;
  let x = videoUrlFromRecord(obj);
  if (x) return typeof x === 'string' ? x.trim() : x;
  const inner = obj.content;
  if (inner && typeof inner === 'object') {
    x = videoUrlFromRecord(inner);
    if (x) return typeof x === 'string' ? x.trim() : x;
    const il = pickVideoUrlFromItemList(inner.item_list);
    if (il) return il;
    if (inner.video && typeof inner.video === 'object') {
      const v = videoUrlFromArkVideoNode(inner.video) || inner.video.url || inner.video.video_url;
      if (v && typeof v === 'string') return v.trim();
    }
  }
  return null;
}

/**
 * OpenAI/Veo/Sora 类中转 JSON 中解析直链（含各层 result_url）
 */
function pickProxyVideoUrl(data) {
  if (!data || typeof data !== 'object') return null;
  const topList = pickVideoUrlFromItemList(data.item_list);
  if (topList) return topList;
  if (data.video && typeof data.video === 'object') {
    const vu =
      videoUrlFromArkVideoNode(data.video) ||
      coerceHttpVideoUrl(data.video.url) ||
      coerceHttpVideoUrl(data.video.video_url);
    if (vu) return vu;
  }
  let u = videoUrlFromRecord(data);
  if (u) return u;
  // 中转站 / Seedance 完成态常见：直链在 metadata.url（非顶层 video_url）
  const meta = data.metadata;
  if (meta && typeof meta === 'object' && !Array.isArray(meta)) {
    u = videoUrlFromRecord(meta);
    if (u) return u;
  }
  const d = data.data;
  if (d && typeof d === 'object' && !Array.isArray(d)) {
    const nestedList = pickVideoUrlFromItemList(d.item_list);
    if (nestedList) return nestedList;
    u = videoUrlFromRecord(d);
    if (u) return u;
    if (d.metadata && typeof d.metadata === 'object' && !Array.isArray(d.metadata)) {
      u = videoUrlFromRecord(d.metadata);
      if (u) return u;
    }
    if (d.video && typeof d.video === 'object') {
      const dv =
        videoUrlFromArkVideoNode(d.video) ||
        coerceHttpVideoUrl(d.video.url) ||
        coerceHttpVideoUrl(d.video.video_url);
      if (dv) return dv;
    }
    if (d.result && typeof d.result === 'object') {
      const dr = pickVideoUrlFromResultShape(d.result);
      if (dr) return dr;
    }
  }
  const r = data.result;
  if (r && typeof r === 'object') {
    const pr = pickVideoUrlFromResultShape(r);
    if (pr) return pr;
  }
  const c = data.content;
  if (c && typeof c === 'object') {
    const cl = pickVideoUrlFromItemList(c.item_list);
    if (cl) return cl;
    u = videoUrlFromRecord(c);
    if (u) return u;
    if (c.video && typeof c.video === 'object') {
      const cv =
        videoUrlFromArkVideoNode(c.video) ||
        coerceHttpVideoUrl(c.video.url) ||
        coerceHttpVideoUrl(c.video.video_url);
      if (cv) return cv;
    }
  }
  for (const k of ['videos', 'generations', 'works']) {
    const arr = data[k];
    if (Array.isArray(arr) && arr[0]) {
      u = videoUrlFromRecord(arr[0]);
      if (u) return u;
      const res = arr[0].resource;
      if (res && res.resource) return res.resource;
    }
  }
  if (Array.isArray(d) && d[0]) {
    u = videoUrlFromRecord(d[0]);
    if (u) return u;
  }
  return null;
}

function parseJsonColumnForVideo(v) {
  if (v == null || v === '') return null;
  try {
    return typeof v === 'string' ? JSON.parse(v) : v;
  } catch (_) {
    return null;
  }
}

/**
 * 收集剧中所有 active 状态的 Seedance 2.0 角色音色参考
 * @returns {Map<number, string>} charId -> publicUrl
 */
function collectActiveCharacterVoiceRefs(db, dramaId) {
  const map = new Map();
  if (!db || !dramaId) return map;
  try {
    const rows = db.prepare(
      'SELECT id, name, seedance2_voice_asset FROM characters WHERE drama_id = ? AND deleted_at IS NULL'
    ).all(Number(dramaId));
    for (const row of rows) {
      const asset = parseJsonColumnForVideo(row.seedance2_voice_asset);
      if (!asset || String(asset.status || '').toLowerCase() !== 'active') continue;
      const url = String(asset.url || '').trim();
      // 值为 { url, name }：name 供 H3 的 <Audio j> 说明行点名「这是谁的音色」，
      // 否则模型无法把参考音频对应到具体角色（会照着参考音频把开头「续读」出来）。
      if (url) map.set(Number(row.id), { url, name: String(row.name || '').trim() });
    }
  } catch (_) {}
  return map;
}

const narratorVoiceRefCache = new Map();

async function resolveDefaultNarratorVoiceReferenceUrl(db, log, storageLocalPath, videoGenId) {
  if (!db || !storageLocalPath) return '';
  try {
    const configs = aiConfigService.listConfigs(db, 'tts').filter((c) => c && c.is_active !== false);
    const ttsConfig = configs.find((c) => c.is_default) || configs[0] || null;
    if (!ttsConfig) return '';

    const ttsSettings = (() => {
      try { return JSON.parse(ttsConfig.settings || '{}') || {}; } catch (_) { return {}; }
    })();
    const voiceId = String(ttsConfig.voice_id || ttsSettings.voice_id || '').trim();
    if (!voiceId) return '';

    const ttsModel = String(ttsConfig.default_model || (Array.isArray(ttsConfig.model) ? ttsConfig.model[0] : ttsConfig.model) || '').trim();
    const cacheKey = [String(ttsConfig.id || ttsConfig.name || 'tts'), voiceId, ttsModel, String(ttsConfig.provider || '').toLowerCase()].join('|');
    const cachedRel = narratorVoiceRefCache.get(cacheKey);
    if (cachedRel) {
      const cachedAbs = path.join(storageLocalPath, cachedRel.replace(/\//g, path.sep));
      if (fs.existsSync(cachedAbs)) return cachedRel;
      narratorVoiceRefCache.delete(cacheKey);
    }

    const ttsService = require('./ttsService');
    const result = await ttsService.synthesize(db, log, {
      text: '大家好，下面开始介绍本产品。',
      storyboard_id: null,
      config: ttsConfig,
      storage_base: storageLocalPath,
      voice_id: voiceId,
      speed: 1,
    });
    if (result && result.local_path) {
      narratorVoiceRefCache.set(cacheKey, result.local_path);
      log?.info?.('[视频][音色] 已生成 TTS 默认旁白参考音频', {
        video_gen_id: videoGenId,
        voice_id: voiceId,
        local_path: String(result.local_path).slice(0, 120),
      });
      return result.local_path;
    }
  } catch (e) {
    log?.warn?.('[视频][音色] 生成 TTS 默认旁白参考音频失败', {
      video_gen_id: videoGenId,
      error: e && e.message ? e.message : String(e),
    });
  }
  return '';
}

/**
 * 把图片 URL 变成云端 API 能拉取的形式：公网直链原样返回；
 * 本机/内网（localhost、127.0.0.1、相对路径）且文件在本地存储里时，读文件转 base64 内嵌。
 * 同时支持 first_frame / last_frame 专用字段，以及回退到 image_url。
 */
function resolveImageForCloudApi(rawUrl, files_base_url, storage_local_path, log, video_gen_id, roleHint) {
  let u = String(rawUrl || '').trim();
  if (!u) return null;
  if (u.startsWith('data:') || u.startsWith('asset://')) return u;

  // 已经是公网 https 且不含 localhost 的，直接返回
  if (/^https?:\/\//i.test(u) && !/localhost|127\.0\.0\.1/i.test(u)) return u;

  const fb = (files_base_url || '').replace(/\/$/, '');
  const baseIndicatesLocal = fb && /localhost|127\.0\.0\.1/i.test(fb);
  const urlIndicatesLocal = /localhost|127\.0\.0\.1/i.test(u);

  if ((baseIndicatesLocal || urlIndicatesLocal) && storage_local_path) {
    let rel = null;
    const marker = '/static/';
    const idx = u.toLowerCase().indexOf(marker);
    if (idx >= 0) {
      rel = u.slice(idx + marker.length).replace(/^\//, '').split('?')[0];
    } else if (fb) {
      rel = u.replace(fb + '/', '').replace(fb, '').replace(/^\//, '').split('?')[0];
    } else if (!/^https?:\/\//i.test(u)) {
      // 纯相对路径（来自 local_path 兜底）
      rel = u.replace(/^\//, '').split('?')[0];
    }
    if (rel) {
      const filePath = path.join(storage_local_path, rel);
      try {
        if (fs.existsSync(filePath)) {
          const buf = fs.readFileSync(filePath);
          const ext = path.extname(filePath).toLowerCase();
          const mime = { '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.webp': 'image/webp', '.bmp': 'image/bmp' }[ext] || 'image/png';
          const b64 = 'data:' + mime + ';base64,' + buf.toString('base64');
          if (log && log.info) {
            log.info('[云端API] 本地图片已转为 base64 提交', { video_gen_id, role: roleHint, rel: rel.slice(0, 80) });
          }
          return b64;
        }
      } catch (_) {}
    }
  }
  // 兜底返回原始值（中转或公网会处理）
  return u;
}

/** MiniMax 国内/海外根域名：去掉末尾 /v1 /v2，便于拼 V2 路径 */
function getMinimaxApiRoot(baseUrl) {
  let root = String(baseUrl || 'https://api.minimaxi.com').trim().replace(/\/$/, '');
  for (const suf of ['/v2', '/v1']) {
    if (root.toLowerCase().endsWith(suf)) {
      root = root.slice(0, -suf.length).replace(/\/$/, '');
      break;
    }
  }
  return root || 'https://api.minimaxi.com';
}

function normalizeMinimaxH3Duration(duration) {
  const n = Math.round(Number(duration));
  const safe = Number.isFinite(n) && n > 0 ? n : 5;
  return Math.min(15, Math.max(4, safe));
}

function normalizeMinimaxH3Resolution(resolution) {
  const s = String(resolution || '').trim().toLowerCase();
  if (!s) return '768P';
  if (s === '2k' || s.includes('2k') || s.includes('1080') || s === '1080p') return '2K';
  if (s.includes('768') || s === '768p') return '768P';
  return '768P';
}

function buildMinimaxH3CreateUrl(config) {
  const root = getMinimaxApiRoot(config.base_url);
  let ep = (config.endpoint || '/v2/video_generation').toString().trim();
  if (!ep.startsWith('/')) ep = '/' + ep;
  // 用户若误配旧海螺 /video_generation，在 H3 协议下纠正为 V2
  if (/^\/video_generation\/?$/i.test(ep) || /^\/v1\/video_generation\/?$/i.test(ep)) {
    ep = '/v2/video_generation';
  }
  return root + ep;
}

function buildMinimaxH3PollUrl(config, taskId) {
  const root = getMinimaxApiRoot(config.base_url);
  const id = String(taskId || '').trim();
  let ep = (config.query_endpoint || '/v2/query/video_generation/{taskId}').toString().trim();
  if (!ep.startsWith('/')) ep = '/' + ep;
  if (/query\/video_generation\?task_id=/i.test(ep) || /^\/v1\/query\//i.test(ep)) {
    ep = '/v2/query/video_generation/{taskId}';
  }
  ep = ep
    .replace(/\{taskId\}/gi, encodeURIComponent(id))
    .replace(/\{task_id\}/gi, encodeURIComponent(id))
    .replace(/\{id\}/gi, encodeURIComponent(id));
  // 兼容仅写目录的配置：/v2/query/video_generation → 追加 /{taskId}
  if (/\/v2\/query\/video_generation\/?$/i.test(ep) && id) {
    ep = ep.replace(/\/?$/, '/') + encodeURIComponent(id);
  }
  return root + ep;
}

function extractMinimaxH3VideoUrl(data) {
  if (!data || typeof data !== 'object') return null;
  const task = data.task && typeof data.task === 'object' ? data.task : data;
  const content = task.content && typeof task.content === 'object' ? task.content : null;
  return (
    coerceHttpVideoUrl(content?.url) ||
    coerceHttpVideoUrl(task.video_url) ||
    coerceHttpVideoUrl(task.url) ||
    pickProxyVideoUrl(data) ||
    null
  );
}

function extractMinimaxH3TaskStatus(data) {
  if (!data || typeof data !== 'object') return '';
  const task = data.task && typeof data.task === 'object' ? data.task : data;
  const s = task.status || task.state || data.status;
  return s != null ? String(s).trim().toLowerCase() : '';
}

/**
 * MiniMax-H3：POST /v2/video_generation（content[] 多模态），轮询 GET /v2/query/video_generation/{task_id}
 * @returns {Promise<{ task_id?: string, video_url?: string, error?: string }>}
 */
async function callMinimaxH3VideoApi(config, log, opts) {
  const {
    prompt,
    model,
    duration,
    aspect_ratio,
    resolution,
    image_url,
    first_frame_url,
    last_frame_url,
    reference_urls,
    files_base_url,
    storage_local_path,
    video_gen_id,
    voice_reference_url,
  } = opts || {};
  const url = buildMinimaxH3CreateUrl(config);
  const finalModel = isMinimaxH3Model(model) ? 'MiniMax-H3' : model || 'MiniMax-H3';
  const dur = normalizeMinimaxH3Duration(duration);
  const res = normalizeMinimaxH3Resolution(resolution);
  const ratio = normalizeAspectRatioForApi(aspect_ratio) || String(aspect_ratio || '16:9').trim() || '16:9';

  const content = [{ type: 'text', text: String(prompt || '').trim() || 'cinematic scene' }];

  const rawFirst = (first_frame_url || image_url || '').toString().trim();
  const rawLast = (last_frame_url || '').toString().trim();
  const firstForApi = resolveImageForCloudApi(
    rawFirst,
    files_base_url,
    storage_local_path,
    log,
    video_gen_id,
    'first_frame'
  );
  let lastForApi = null;
  if (rawLast) {
    lastForApi = resolveImageForCloudApi(rawLast, files_base_url, storage_local_path, log, video_gen_id, 'last_frame');
  }
  if (firstForApi && lastForApi && firstForApi === lastForApi) lastForApi = null;

  const refs = Array.isArray(reference_urls) ? reference_urls.filter(Boolean).map(String) : [];
  const useFirstLast = !!(firstForApi || lastForApi);
  let hasVoiceReference = false;

  if (useFirstLast) {
    if (firstForApi) {
      content.push({ type: 'image_url', image_url: { url: firstForApi }, role: 'first_frame' });
    }
    if (lastForApi) {
      content.push({ type: 'image_url', image_url: { url: lastForApi }, role: 'last_frame' });
    }
  } else if (refs.length) {
    for (let i = 0; i < Math.min(refs.length, 9); i++) {
      const refUrl = resolveImageForCloudApi(
        refs[i],
        files_base_url,
        storage_local_path,
        log,
        video_gen_id,
        `reference_${i}`
      );
      if (refUrl) {
        content.push({ type: 'image_url', image_url: { url: refUrl }, role: 'reference_image' });
      }
    }
    // 人声音色参考（多模态参考生视频：可直接与 reference_image 组合；与首尾帧互斥）
    let voiceUrl = (voice_reference_url || '').toString().trim();
    if (voiceUrl) {
      // 本地相对路径/本地 URL → 读文件转 base64（MiniMax 云端访问不到本机 localhost，须内嵌）
      const isLocal = /localhost|127\.0\.0\.1/i.test(voiceUrl) || !/^https?:\/\//i.test(voiceUrl) || /\/static\//i.test(voiceUrl);
      if (isLocal && storage_local_path) {
        const baseUrl = (files_base_url || '').replace(/\/$/, '');
        const afterStatic = voiceUrl.split('/static/')[1] || (baseUrl ? voiceUrl.replace(baseUrl + '/', '').replace(baseUrl, '') : null);
        const relPath = afterStatic ? afterStatic.replace(/^\//, '') : (voiceUrl.replace(/^\//, '') || null);
        if (relPath) {
          const filePath = path.join(storage_local_path, relPath);
          try {
            if (fs.existsSync(filePath)) {
              const buf = fs.readFileSync(filePath);
              const ext = path.extname(filePath).toLowerCase();
              const mime = { '.mp3': 'audio/mp3', '.wav': 'audio/wav', '.m4a': 'audio/mp4', '.ogg': 'audio/ogg' }[ext] || 'audio/mp3';
              voiceUrl = 'data:' + mime + ';base64,' + buf.toString('base64');
              log.info('[MiniMaxH3][音色] 本地音色已转 base64 提交', { video_gen_id, rel: relPath.slice(0, 80) });
            }
          } catch (_) {}
        }
      }
      content.push({ type: 'audio_url', audio_url: { url: voiceUrl }, role: 'reference_audio' });
      hasVoiceReference = true;
    }
  }

  const body = {
    model: finalModel,
    content,
    duration: dur,
    resolution: res,
  };
  // 文生视频 ratio 必填且不能 adaptive；有图时官方示例可省略或 adaptive
  if (!useFirstLast && !refs.length) {
    body.ratio = ratio === 'adaptive' ? '16:9' : ratio;
  } else if (useFirstLast) {
    body.ratio = 'adaptive';
  }

  // POST 请求摘要（url / model / 有无首尾帧 / 参考图数量 / 有无音色参考 / 请求体大小），
  // 不打印完整 body 以免日志过大。
  //
  // body_bytes 是排查「fetch failed」的关键线索：参考图走的是原图 PNG base64 内嵌，实测单次请求
  // 可达 5MB，大 body 上传中途被重置时日志里只剩一个空壳 "fetch failed"，完全看不出与体积有关。
  const payload = JSON.stringify(body);
  log.info('[MiniMaxH3] Video POST 摘要', {
    video_gen_id,
    url,
    model: finalModel,
    duration: dur,
    resolution: res,
    has_first_frame: !!firstForApi,
    has_last_frame: !!lastForApi,
    reference_count: useFirstLast ? 0 : Math.min(refs.length, 9),
    has_voice_reference: hasVoiceReference,
    body_bytes: Buffer.byteLength(payload),
  });

  const resHttp = await fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: 'Bearer ' + (config.api_key || ''),
    },
    body: payload,
  });
  const raw = await resHttp.text();
  log.info('[MiniMaxH3] raw response', { video_gen_id, status: resHttp.status, raw: raw.slice(0, 1000) });
  if (!resHttp.ok) {
    let errMsg = 'MiniMax H3 请求失败: ' + resHttp.status;
    try {
      const errJson = JSON.parse(raw);
      const msg = errJson.error?.message || errJson.message || errJson.base_resp?.status_msg;
      if (msg) errMsg += ' - ' + (typeof msg === 'string' ? msg : JSON.stringify(msg).slice(0, 200));
    } catch (_) {
      if (raw) errMsg += ' - ' + raw.slice(0, 200);
    }
    return { error: errMsg };
  }
  let data;
  try {
    data = JSON.parse(raw);
  } catch (e) {
    return { error: 'MiniMax H3 响应非 JSON: ' + e.message };
  }
  const taskId = data.task_id || data.task?.id || data.id || data.data?.task_id;
  const directUrl = extractMinimaxH3VideoUrl(data);
  if (directUrl) {
    log.info('[MiniMaxH3] 直接返回 video_url', { video_gen_id, video_url: directUrl });
    return { video_url: directUrl };
  }
  if (taskId) {
    log.info('[MiniMaxH3] 返回 task_id', { video_gen_id, task_id: taskId });
    return { task_id: String(taskId), status: 'processing' };
  }
  return { error: 'MiniMax H3 未返回 task_id: ' + JSON.stringify(data).slice(0, 300) };
}

/**
 * ?????? API?ChatFire/?? ? ?????
 * @returns {Promise<{ task_id?: string, video_url?: string, error?: string }>}
 */
async function callVideoApi(db, log, opts) {
  const {
    prompt,
    model: preferredModel,
    duration,
    aspect_ratio,
    resolution,
    seed,
    camera_fixed,
    watermark,
    image_url,
    first_frame_url,
    last_frame_url,
    first_frame_local_path,
    last_frame_local_path,
    files_base_url,
    storage_local_path,
    video_gen_id
  } = opts;
  const config = getDefaultVideoConfig(db, preferredModel);
  if (!config) {
    throw new Error('???????????AI ?????? video ?????????');
  }
  const model = getModelFromConfig(config, preferredModel);
  const provider = (config.provider || '').toLowerCase();
  const protocol = resolveVideoProtocol(config, preferredModel);
  // 自动注入角色音色参考（MiniMax H3 多模态参考；未显式指定 voice_reference_url 时）。
  // 本地 comfyui 工作流（尤其 A03 H3 参考生视频）也走此注入，由 callComfyUIVideoApi 在有 H3 参考节点时才接 ref_audios；
  // 其余 comfyui 工作流（纯图/视频）不接收音频，不受影响。
  const isMinimaxH3 = protocol === 'minimax_h3' || protocol === 'comfyui' || (protocol === 'comfyui' && isMinimaxH3Model(model));
  // 台词说话人顺序（供 H3 渲染阶段给台词加 (Sx) 编号与 <d> 标记）。
  // 与音色注入无关地独立解析：即使本镜没有可用音色，台词标记本身也有价值。
  if (isMinimaxH3 && opts.storyboard_id && !opts.dialogue_speakers) {
    try {
      const sbDlg = db.prepare('SELECT dialogue FROM storyboards WHERE id = ? AND deleted_at IS NULL')
        .get(Number(opts.storyboard_id));
      const spk = parseDialogueSpeakers(sbDlg && sbDlg.dialogue);
      if (spk.length) {
        opts.dialogue_speakers = spk;
        log.info('[视频][台词] 解析出说话人顺序，将标 (Sx) 与 <d>', {
          video_gen_id,
          storyboard_id: opts.storyboard_id,
          speakers: spk,
        });
      }
    } catch (_) {}
  }

  if (isMinimaxH3 && db && opts.drama_id && !opts.voice_reference_url) {
    const voiceMap = collectActiveCharacterVoiceRefs(db, opts.drama_id);
    if (voiceMap.size > 0) {
      // 只绑「本镜真正开口、且名字能对上角色」的那条音色。
      //
      // 原来的策略是「分镜角色列表里第一个有音色的」，不看谁在说话，结果错误不小：
      //   镜 9 老妇哭喊 —— 说话人是「老妇人」，角色表里没这个名字，于是退回绑了「悟空」；
      //   镜 10 老翁现身 —— 同理也是悟空。等于把悟空的音色配给了老妇/老翁的台词。
      //
      // 而这类名字对不上是有意义的：白骨精化身为村姑 / 老妇人 / 老翁时，化身的声音本就
      // 应该和本体不同，绑白骨精（更别提退回绑悟空）反而错。所以**对不上就不绑**。
      // 同理，无对白的镜头也不绑 —— 只需要环境音，音色参考没有意义。
      //
      // 另外，H3 把参考音频当作「目标音频的前缀」注入（见 comfyuiClient 里
      // H3_VOICE_REF_SKIP_HEAD_SECONDS 的注释），多余的参考音频只会带来副作用。
      let chosenId = null;
      const speakers = Array.isArray(opts.dialogue_speakers) ? opts.dialogue_speakers : [];
      if (speakers.length) {
        const idByName = new Map();
        for (const [cid, v] of voiceMap) {
          const nm = String(v.name || '').trim();
          if (nm && !idByName.has(nm)) idByName.set(nm, cid);
        }
        for (const sp of speakers) {
          const hit = idByName.get(String(sp || '').trim());
          if (hit != null) { chosenId = hit; break; }
        }
      }
      if (chosenId != null && voiceMap.has(chosenId)) {
        const chosen = voiceMap.get(chosenId);
        opts.voice_reference_url = chosen.url;
        opts.voice_reference_name = chosen.name || '';
        log.info('[视频][音色] 自动注入角色音色参考（来自角色 seedance2_voice_asset）', {
          video_gen_id,
          storyboard_id: opts.storyboard_id,
          character_id: chosenId,
          character_name: chosen.name || '',
          voice_ref_url: String(chosen.url).slice(0, 100)
        });
      } else {
        log.info('[视频][音色] 本镜不绑音色参考（说话人对不上角色，或本镜无对白）', {
          video_gen_id,
          storyboard_id: opts.storyboard_id,
          speakers,
          available_voice_characters: Array.from(voiceMap.values()).map((v) => v.name),
        });
      }
    } else {
      log.info('[视频][音色] 本剧暂无 active 角色音色参考（角色编辑页「音色库」可绑定）', {
        video_gen_id, drama_id: opts.drama_id, is_h3: isMinimaxH3,
      });
      if (isMinimaxH3 && Array.isArray(opts.reference_urls) && opts.reference_urls.length > 0) {
        const narratorRef = await resolveDefaultNarratorVoiceReferenceUrl(db, log, opts.storage_local_path, video_gen_id);
        if (narratorRef && !opts.voice_reference_url) {
          opts.voice_reference_url = narratorRef;
          log.info('[视频][音色] 已回退为 TTS 默认旁白音色参考', {
            video_gen_id,
            drama_id: opts.drama_id,
            voice_ref_url: String(narratorRef).slice(0, 100),
          });
        }
      }
    }
  }
  log.info('[视频] 路由协议', {
    video_gen_id,
    provider,
    api_protocol_raw: config.api_protocol || '(empty→auto)',
    protocol_used: protocol,
    model,
    endpoint: config.endpoint || '(auto)',
  });

  // 正文改用英文版（对白仍以中文留在 <d>[Chinese] …</d> 内）—— **ComfyUI 与云端 MiniMax H3 都要用**：
  // 它们是同一个模型，中文正文 + <d> 会让模型把描述一起念出来（实测：镜 3 同 seed/参考图/参考音频，
  // 中文正文 → 多念一截且嘴不动；英文正文 → 台词正确、无多余语音）。中文原文仍存在
  // storyboards.universal_segment_text，英文版缓存在 universal_segment_text_en，只翻一次；
  // 失败则回退中文，不挡出片。
  let apiPrompt = prompt;
  if (db && opts.storyboard_id) {
    try {
      const en = await ensureEnglishSegmentText(db, log, opts.storyboard_id, prompt);
      if (en) apiPrompt = en;
    } catch (e) {
      log.warn('[视频][英译] 取得英文正文失败，回退中文正文', {
        video_gen_id, storyboard_id: opts.storyboard_id, error: e.message,
      });
    }
  }

  if (protocol === 'comfyui') {
    // 本地 H3 路径：正文改用英文版（对白仍以中文留在 <d>[Chinese] …</d> 内）。
    //
    // 这不是「偏好英文」，而是 <d> 能生效的机制 —— 实测（镜 3，同 seed/参考图/参考音频）：
    //   中文正文 + 裸引号台词 → 模型把 <d> 之后的描述也念出来，且角色嘴不动（当成旁白）
    //   英文正文 + <d>[Chinese] 台词</d> → 台词正确、无多余语音、嘴部随台词开合
    // 语言差异本身就是「描述」与「台词」的分界线。
    //
    // 中文原文仍存在 storyboards.universal_segment_text，编辑器里照常可读；
    // 英文版缓存在 universal_segment_text_en，只需翻译一次。失败则回退中文，不挡出片。
    const comfyPrompt = apiPrompt;
    // 半自动尾帧衔接：本镜判定为「承接上一镜」（link_prev_tail=1）、项目开关开（默认开）、
    // 且本镜还没绑定首帧时，自动抽上一镜视频的末帧当本镜首帧。
    //
    // 为什么放在这里（comfyui 分支内）而不是 videoService：协议判定（api_protocol）只在本函数里
    // 发生，而这条自动锚定**只对本地 H3（A03 Ref2VA，走 MiniMaxH3AddGuide）有意义** ——
    // 其它 provider 的图生视频语义不同（首帧往往就是主图），跟着一起改会污染它们的出片。
    // 落在分支内就天然只在 protocol === 'comfyui' 时生效。
    //
    // 失败一律静默跳过（maybeAutoAnchorPrevTailFrame 内部 warn + 返回 null），
    // 绝不因为「多加了一道自动锚定」让视频生成失败。
    let comfyFirstFrameUrl = opts.first_frame_url;
    if (!comfyFirstFrameUrl && opts.storyboard_id) {
      try {
        const { maybeAutoAnchorPrevTailFrame } = require('./adjacentContinuityService');
        const autoFirst = maybeAutoAnchorPrevTailFrame(db, log, {
          storyboardId: opts.storyboard_id,
          submittedFirstFrameUrl: opts.first_frame_url,
        });
        if (autoFirst) comfyFirstFrameUrl = autoFirst;
      } catch (e) {
        log.warn('[尾帧衔接] 自动锚定入口异常，本镜按无首帧渲染（不影响出片）', {
          video_gen_id, storyboard_id: opts.storyboard_id, error: e.message,
        });
      }
    }
    return callComfyUIVideoApi(config, log, {
      prompt: comfyPrompt,
      model,
      image_url: opts.image_url || opts.first_frame_url,
      // 首尾帧：H3 参考路径用它们做 MiniMaxH3AddGuide 关键帧锚定（首帧 @frame_idx=0、尾帧 @-1）。
      // 此前只传了 image_url，storyboards.first_frame_image_id / last_frame_image_id 在本地渲染里
      // 完全没被用上 —— 用户绑定了尾帧也不会生效。
      first_frame_url: comfyFirstFrameUrl,
      last_frame_url: opts.last_frame_url,
      reference_image_urls: opts.reference_urls,
      reference_labels: opts.reference_labels,
      reference_audio_urls: opts.reference_audio_urls,
      reference_audio_names: opts.reference_audio_names,
      voice_reference_url: opts.voice_reference_url,
      voice_reference_name: opts.voice_reference_name,
      dialogue_speakers: opts.dialogue_speakers,
      onSubmitted: opts.onSubmitted,
      aspect_ratio,
      duration: opts.duration,
      files_base_url: opts.files_base_url,
      storage_local_path: opts.storage_local_path,
      video_gen_id: opts.video_gen_id,
    });
  }

  // MiniMax H3 Video Generation V2（云端）
  if (protocol === 'minimax_h3') {
    return callMinimaxH3VideoApi(config, log, {
      // 云端官方 V2 的示例用「参考图N」指代参考图；本地节点用 <Picture N>。
      // 这里只改**提交出去的文字**，数据库里的 ust 仍保留 <Picture N>。
      prompt: String(apiPrompt || '').replace(/<Picture\s+(\d+)>/g, '参考图$1'),
      model,
      duration: opts.duration,
      aspect_ratio,
      resolution: opts.resolution,
      image_url: opts.image_url,
      first_frame_url: opts.first_frame_url,
      last_frame_url: opts.last_frame_url,
      reference_urls: opts.reference_urls,
      files_base_url: opts.files_base_url,
      storage_local_path: opts.storage_local_path,
      video_gen_id: opts.video_gen_id,
      voice_reference_url: opts.voice_reference_url,
    });
  }

  // 只支持 ComfyUI（本地或远程 ComfyUI 地址）与云端 MiniMax H3。其它 api_protocol 在这里明确报错 ——
  // 以前会一路落到函数末尾返回 undefined，调用方读 result.error 时抛 TypeError，
  // 报错文案变成「Cannot read properties of undefined」，根本定位不到是配置问题。
  return {
    error: `不支持的视频接口规范 api_protocol=${protocol}（本软件只支持 ComfyUI 与云端 MiniMax H3）`,
  };


}

/**
 * ??????????????????/ChatFire ? ???? DashScope?
 */
async function pollVideoTask(db, log, videoGenId, taskId, config, maxAttempts = 300, intervalMs = 10000) {
  const protocol = resolveVideoProtocol(config);
  const isMinimaxH3 = protocol === 'minimax_h3';
  // ComfyUI 的产出从 /history/<prompt_id> 取，和云端查询接口不同：
  // 重启恢复时凭已持久化的 prompt_id 继续等，绝不重新提交（否则等于偷偷多烧一次显卡）。
  if (protocol === 'comfyui') {
    return resumeComfyUIVideo(config, log, { prompt_id: taskId });
  }
  /** 轮询日志里响应体最大字符数（即梦/方舟等 JSON 可能较长）；0 表示不截断（慎用） */
  const pollLogBodyMax = (() => {
    const v = String(process.env.VIDEO_POLL_LOG_MAX || '16384').trim();
    if (v === '0' || v.toLowerCase() === 'full') return Infinity;
    const n = parseInt(v, 10);
    return Number.isFinite(n) && n > 0 ? Math.min(n, 512 * 1024) : 16384;
  })();
  let pollTaskId = taskId;
  const queryUrl = () => buildQueryUrl(config, pollTaskId);
  log.info('[poll] 开始', { video_gen_id: videoGenId, task_id: pollTaskId, protocol, poll_url: queryUrl() });
  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    await new Promise((r) => setTimeout(r, intervalMs));
    try {
      let url, headers;
      url = queryUrl();
      headers = { Authorization: 'Bearer ' + (config.api_key || '') };
      const pollRound = attempt + 1;
      log.info('[poll] 发起查询', { video_gen_id: videoGenId, round: pollRound, url });
      const res = await fetch(url, { method: 'GET', headers });
      const raw = await res.text();
      const bodyLogged =
        pollLogBodyMax === Infinity
          ? raw
          : raw.length <= pollLogBodyMax
            ? raw
            : raw.slice(0, pollLogBodyMax) + `\n... [poll 响应已截断 前${pollLogBodyMax}字符 / 共${raw.length}字符，可设环境变量 VIDEO_POLL_LOG_MAX=0 输出全文]`;
      log.info('[poll] 查询 HTTP 结果', {
        video_gen_id: videoGenId,
        round: pollRound,
        http_status: res.status,
        bytes: raw.length,
        body: bodyLogged,
      });
      if (!res.ok) {
        log.warn('[poll] 查询非 2xx', {
          video_gen_id: videoGenId,
          round: pollRound,
          http_status: res.status,
          body: bodyLogged.slice(0, 4000),
        });
        continue;
      }
      let data;
      try {
        data = JSON.parse(raw);
      } catch (parseErr) {
        log.warn('[poll] 响应非 JSON', {
          video_gen_id: videoGenId,
          round: pollRound,
          error: parseErr.message,
          body_head: raw.slice(0, 800),
        });
        continue;
      }

      if (isMinimaxH3) {
        const status = extractMinimaxH3TaskStatus(data);
        const videoUrl = extractMinimaxH3VideoUrl(data);
        const taskObj = data.task && typeof data.task === 'object' ? data.task : data;
        log.info('[MiniMaxH3 poll] 状态', {
          video_gen_id: videoGenId,
          attempt,
          status,
          has_url: !!videoUrl,
          id: taskObj.id || taskId,
        });
        if (status === 'failed' || status === 'cancelled' || status === 'canceled' || status === 'error') {
          const err = taskObj.error;
          const msg =
            (err && (err.message || err.code)) ||
            extractPollFailureMessage(data) ||
            status ||
            'MiniMax H3 任务失败';
          log.warn('[MiniMaxH3 poll] 任务失败', { video_gen_id: videoGenId, msg });
          return { error: String(msg).slice(0, 500) };
        }
        if (videoUrl && isPlausibleHttpVideoUrl(videoUrl)) {
          log.info('[MiniMaxH3 poll] 完成', { video_gen_id: videoGenId, video_url: videoUrl });
          return { video_url: videoUrl };
        }
        if (status === 'succeeded' || status === 'completed' || status === 'success' || status === 'done') {
          log.warn('[MiniMaxH3 poll] 成功但无视频地址', {
            video_gen_id: videoGenId,
            data: JSON.stringify(data).slice(0, 500),
          });
          return { error: 'MiniMax H3 任务完成但未返回视频地址' };
        }
        continue;
      }

      const status = extractPollTaskStatus(data);
      const videoUrl = pickProxyVideoUrl(data);
      const failMsg = extractPollFailureMessage(data);
      const errMsg = data.error && (typeof data.error === 'string' ? data.error : data.error.message);
      if (isPollTaskFailed(status) || errMsg) {
        const msg = failMsg || errMsg || status || '任务失败';
        log.warn('[poll] 任务失败', { video_gen_id: videoGenId, round: pollRound, status, msg });
        return { error: String(msg).slice(0, 500) };
      }
      if (videoUrl && isPlausibleHttpVideoUrl(videoUrl)) return { video_url: videoUrl };
      if (failMsg) {
        log.warn('[poll] 上游返回失败文案', { video_gen_id: videoGenId, round: pollRound, msg: failMsg.slice(0, 200) });
        return { error: failMsg.slice(0, 500) };
      }
    } catch (e) {
      log.warn('Video poll request failed', { attempt, error: e.message });
    }
  }
  return { error: '视频任务轮询结束仍未拿到可下载的视频地址（疑似上游超时或返回体结构变化）' };
}

/**
 * 取消云端 MiniMax H3 任务：官方 `DELETE /v2/video_generation/{task_id}`
 *   - queued（排队中）→ 取消任务（action=cancelled）
 *   - succeeded / failed → 删除任务记录（action=deleted）
 *   - running / cancelled → 官方不支持，返回错误（如实回报，不假装成功）
 * 文档：platform.minimax.cn/docs/api-reference/video-generation-v2-delete
 */
async function cancelMinimaxH3Job(config, log, taskId) {
  const id = String(taskId || '').trim();
  if (!id) return { ok: false, error: '缺少 task_id' };
  const url = getMinimaxApiRoot(config.base_url) + '/v2/video_generation/' + encodeURIComponent(id);
  let res;
  try {
    res = await fetch(url, {
      method: 'DELETE',
      headers: { Authorization: 'Bearer ' + (config.api_key || '') },
    });
  } catch (e) {
    log.warn('[MiniMaxH3] 取消任务请求失败', { task_id: id, error: e.message });
    return { ok: false, error: '取消请求失败：' + e.message };
  }
  const raw = await res.text().catch(() => '');
  let data = null;
  try { data = JSON.parse(raw); } catch (_) {}
  if (!res.ok) {
    const msg =
      data?.error?.message || data?.message || data?.base_resp?.status_msg || `HTTP ${res.status}`;
    log.warn('[MiniMaxH3] 云端未取消', { task_id: id, http_status: res.status, msg: String(msg).slice(0, 200) });
    return { ok: false, error: `云端未取消：${String(msg).slice(0, 200)}` };
  }
  log.info('[MiniMaxH3] 已取消/删除云端任务', { task_id: id, response: String(raw).slice(0, 200) });
  return { ok: true, response: data };
}

/**
 * 取消上游视频任务：ComfyUI 可中断运行中；云端 MiniMax H3 只能取消排队中的。
 * 云端 MiniMax H3 没有取消接口，只标记本地状态，不给用户「已取消」的错觉。
 */
async function cancelUpstreamVideoTask(db, log, row) {
  const upstreamId = row && row.provider_task_id ? String(row.provider_task_id).trim() : '';
  if (!upstreamId) return { ok: false, error: '缺少上游任务 ID' };
  const config = getDefaultVideoConfig(db, row.model, row.provider);
  if (!config) return { ok: false, error: '未配置视频模型' };
  const protocol = resolveVideoProtocol(config, row.model);
  if (protocol === 'comfyui') return cancelComfyUIJob(config, log, upstreamId);
  if (protocol === 'minimax_h3') return cancelMinimaxH3Job(config, log, upstreamId);
  log.info('[video] 该通道没有取消接口，仅标记本地状态', { video_gen_id: row.id, protocol });
  return { ok: false, error: '该通道不支持取消上游任务' };
}

module.exports = {
  cancelUpstreamVideoTask,
  cancelMinimaxH3Job,
  getDefaultVideoConfig,
  callVideoApi,
  collectActiveCharacterVoiceRefs,
  resolveDefaultNarratorVoiceReferenceUrl,
  pollVideoTask,
  normalizeAspectRatioForApi,
  isPlausibleHttpVideoUrl,
  pickProxyVideoUrl,
  isMinimaxH3Model,
  getMinimaxApiRoot,
  buildMinimaxH3PollUrl,
  extractMinimaxH3VideoUrl,
  normalizeMinimaxH3Duration,
  normalizeMinimaxH3Resolution,
};

// 云端取消：DELETE /v2/video_generation/{task_id}（排队中可取消，运行中官方不允许）
