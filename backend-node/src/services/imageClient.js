// 与 Go pkg/image + ImageGenerationService 对齐：调用图片生成 API，更新 image_generations 与角色头像
const fs = require('fs');
const path = require('path');
const aiConfigService = require('./aiConfigService');
const uploadService = require('./uploadService');
const storageLayout = require('./storageLayout');
const taskService = require('./taskService');
const { loadConfig } = require('../config');
const { callComfyUIImageApi } = require("./comfyuiClient");

// ── OpenAI gpt-image 系列云端图像通道（协议名 openai_image，给无显卡用户）──────────
// 只接 OpenAI 的 gpt-image 系列；不做通用多模型，也不恢复任何其它云图像供应商。
//
// 模型名不再写死：公司网关会随时升级型号（gpt-image-2 已下架，现为
// gpt-image-2.5-flare / gpt-image-2.5-sunburst）。这里改成【前缀识别】，
// 并且发请求时用【配置里填的模型】，只有配置为空时才回退到这个默认值。
const OPENAI_IMAGE_MODEL = 'gpt-image-2.5-flare';
/** 是否属于 OpenAI gpt-image 系列（gpt-image / gpt-image-2.5-flare / 未来的 gpt-image-3 … 都算） */
function isOpenAIImageModelName(m) {
  return /^gpt-image/i.test(String(m == null ? '' : m).trim());
}
const OPENAI_IMAGE_DEFAULT_BASE_URL = 'https://api.openai.com/v1';
/** OpenAI gpt-image 仅支持这三种尺寸 */
const OPENAI_IMAGE_SIZES = ['1024x1024', '1024x1536', '1536x1024'];
/** /images/edits 的 image[] 上限 */
const OPENAI_IMAGE_MAX_REF_IMAGES = 8;
/** 生图/编辑单次请求超时（毫秒）——gpt-image 云端出图较慢，给足 5 分钟 */
const OPENAI_IMAGE_TIMEOUT_MS = 300000;
/** 异步任务轮询：间隔 / 次数（总等待 ≈ 3s × 60 = 3 分钟，仍受上面的整体超时约束） */
const OPENAI_IMAGE_POLL_INTERVAL_MS = 3000;
const OPENAI_IMAGE_POLL_ATTEMPTS = 60;

/** 角色/场景/道具资产生图：请求里显式传入 model 且资产上存有负面词时，与自动负面片段合并后传给图生 API */
function resolveAssetUserNegativeForApi(explicitModelName, storedNegative) {
  const hasModel = explicitModelName != null && String(explicitModelName).trim().length > 0;
  const neg = storedNegative != null ? String(storedNegative).trim() : '';
  return hasModel && neg ? neg : '';
}

// 惰性加载配置，避免循环依赖与启动顺序问题
let _appConfig = null;
function getAppConfig() {
  if (!_appConfig) {
    try { _appConfig = loadConfig(); } catch (_) { _appConfig = {}; }
  }
  return _appConfig;
}

/** 从配置读取图床 URL 有效期（小时），默认 23h 留出余量 */
function getProxyExpireHours() {
  return Number(getAppConfig()?.image_proxy?.expire_hours ?? 23);
}

/**
 * 根据 provider 名推断接口规范（api_protocol 未设置时的兜底逻辑）
 * 已明确设置 api_protocol 的配置不会走此函数。
 * 目前只支持两种图像后端：comfyui（本地/远程）与 openai_image（OpenAI 官方 gpt-image 云端）。
 * 其它 provider（包括 provider=openai 但模型不是 gpt-image 的）会返回 'openai'，
 * 由 callImageApi 兜底给出明确报错，绝不静默走通用多模型通道。
 */
function inferImageProtocol(provider, model) {
  const p = String(provider || '').toLowerCase().trim();
  if (p === 'comfyui' || p === 'comfy') return 'comfyui';
  if (p === 'openai_image' || p === 'gpt_image' || p === 'gpt-image') return 'openai_image';
  // provider=openai 且模型就是 gpt-image 时，也归入 OpenAI 官方云端图像通道
  const models = Array.isArray(model) ? model : (model != null ? [model] : []);
  const first = String(models[0] || '').toLowerCase().trim();
  if (p === 'openai' && isOpenAIImageModelName(first)) return 'openai_image';
  return 'openai';
}

/**
 * 获取默认图片配置：优先使用前端勾选的「默认」配置（is_default），同类型内按优先级（priority）排序；
 * 可选按 preferredProvider / preferredModel 进一步筛选。
 * @param {object} db
 * @param {string} [preferredModel] - 指定模型名时，在匹配到的配置中选含该模型的
 * @param {string} [preferredProvider] - 指定供应商（本软件只支持 comfyui）
 * @param {string} [imageServiceType] - 'image' 文本生成图片（角色/场景/道具），'storyboard_image' 分镜图片生成（支持参考图）；缺省为 'image'
 */
function getDefaultImageConfig(db, preferredModel, preferredProvider, imageServiceType) {
  const serviceType = imageServiceType || 'image';
  const activeOf = (st) => aiConfigService.listConfigs(db, st).filter((c) => c.is_active);
  let active = activeOf(serviceType);
  if (serviceType === 'storyboard_image') {
    // 分镜图通道 = storyboard_image 类型 ∪ image 类型（图片配置对分镜图同样适用）。
    // 规则：只有 storyboard_image 配置被「显式设为默认」时才由它负责分镜图；
    //      否则沿用 image 类型的默认（本地 ComfyUI）。
    // 以前是「只要存在任意一条 storyboard_image 配置就完全不再看 image 配置」→
    // 新加一条云端分镜配置就会无声顶掉本地 ComfyUI；反过来本地那条被停用时又会
    // 直接报「未配置图片模型」（configs 非空但 active 为空）。
    const sbTyped = active;
    const imageTyped = activeOf('image');
    const sbDefault = sbTyped.find((c) => c.is_default);
    active = sbDefault
      ? [sbDefault, ...imageTyped, ...sbTyped.filter((c) => c !== sbDefault)]
      : [...imageTyped, ...sbTyped];
  }
  if (active.length === 0) return null;
  // 显式指定的模型最优先（用户/调用方就是要这个模型）
  if (preferredModel) {
    for (const c of active) {
      const models = Array.isArray(c.model) ? c.model : (c.model != null ? [c.model] : []);
      if (models.includes(preferredModel)) return c;
    }
  }
  // 其次是「AI 配置」里显式设的默认 —— 它代表用户当前意图，必须压过调用方传来的厂商偏好。
  // preferred_provider 来自配置文件的历史偏好（config.yaml 的 ai.default_image_provider，
  // 默认值是 'openai'）；曾经因为它优先级更高，把默认改成本地 ComfyUI 后，道具图仍然被发去
  // 云端 gpt-image，撞上安全策略拦截而报错。
  const defaultOne = active.find((c) => c.is_default);
  if (defaultOne) return defaultOne;
  // 没有设默认时才用厂商偏好兜底
  if (preferredProvider && String(preferredProvider).trim()) {
    const want = String(preferredProvider).trim().toLowerCase();
    const byProvider = active.filter((c) => (c.provider || '').toLowerCase() === want);
    if (byProvider.length > 0) active = byProvider;
  }
  return active[0];
}

function getModelFromConfig(config, preferredModel) {
  const models = Array.isArray(config.model) ? config.model : (config.model != null ? [config.model] : []);
  if (preferredModel && models.includes(preferredModel)) return preferredModel;
  if (config.default_model && models.includes(config.default_model)) return config.default_model;
  return models[0] || 'dall-e-3';
}

/**
 * 从 image_proxy_cache 表查询已缓存的图床 URL。
 * cache_key 规则：本地相对路径 或 data URL 的 sha256 前 16 字符。
 * 若缓存已过期（超过 config.image_proxy.expire_hours），自动删除并返回 null，触发重新上传。
 */
function getProxyCache(db, cacheKey) {
  try {
    const row = db.prepare('SELECT proxy_url, created_at FROM image_proxy_cache WHERE cache_key = ?').get(cacheKey);
    if (!row?.proxy_url) return null;

    const expireMs = getProxyExpireHours() * 3600 * 1000;
    const createdAt = new Date(row.created_at).getTime();
    if (isNaN(createdAt) || Date.now() - createdAt > expireMs) {
      // 过期或时间无效：删除旧记录，返回 null 触发重新上传
      deleteProxyCache(db, cacheKey);
      return null;
    }

    return row.proxy_url;
  } catch (_) { return null; }
}

function deleteProxyCache(db, cacheKey) {
  try { db.prepare('DELETE FROM image_proxy_cache WHERE cache_key = ?').run(cacheKey); } catch (_) {}
}

/** 写入 image_proxy_cache 缓存记录 */
function setProxyCache(db, cacheKey, proxyUrl) {
  try {
    db.prepare(
      'INSERT OR REPLACE INTO image_proxy_cache (cache_key, proxy_url, created_at) VALUES (?, ?, ?)'
    ).run(cacheKey, proxyUrl, new Date().toISOString());
  } catch (_) {}
}

// ─────────────────────────────────────────────────────────────────────────────
// OpenAI 官方 gpt-image（云端图像通道）
//   文生图：POST {base_url}/images/generations（JSON）
//   带参考图（分镜/角色一致性）：POST {base_url}/images/edits（multipart/form-data，image[]）
// 返回契约与 ComfyUI 图像通道一致：成功 { image_url }（data URL 或 http URL），失败 { error }。
// 落盘/写库由 imageService Step5 的 uploadService.downloadImageToLocal 统一处理，
// 本函数不自己写文件、不直接更新数据库（避免 base64 进库或双重落盘）。
// ─────────────────────────────────────────────────────────────────────────────

/**
 * 项目尺寸/画幅 → OpenAI gpt-image 支持的尺寸。
 * 9:16 → 1024x1536、16:9 → 1536x1024、1:1 → 1024x1024；
 * 显式给了合法尺寸（1024x1024 / 1024x1536 / 1536x1024）就直接沿用；
 * 其它：按长边就近（竖 → 1024x1536，横 → 1536x1024，无法解析 → 1536x1024）。
 */
function mapOpenAIImageSize(size) {
  const raw = String(size == null ? '' : size)
    .trim()
    .toLowerCase()
    .replace(/[×*]/g, 'x')
    .replace(/\s+/g, '');
  if (!raw) return '1024x1024';
  if (OPENAI_IMAGE_SIZES.includes(raw)) return raw;

  const px = raw.match(/^(\d+)x(\d+)$/);
  if (px) {
    const w = Number(px[1]);
    const h = Number(px[2]);
    if (!w || !h) return '1536x1024';
    if (w === h) return '1024x1024';
    return h > w ? '1024x1536' : '1536x1024';
  }

  const ratio = raw.match(/^(\d+(?:\.\d+)?):(\d+(?:\.\d+)?)$/);
  if (ratio) {
    const w = Number(ratio[1]);
    const h = Number(ratio[2]);
    if (!w || !h) return '1536x1024';
    if (Math.abs(w - h) < 1e-6) return '1024x1024';
    return h > w ? '1024x1536' : '1536x1024';
  }

  return '1536x1024';
}

/** OpenAI 图像 base_url：默认官方地址，去掉尾部斜杠，并容忍用户把完整端点写进 base_url */
/**
 * 归一化图像通道的 base_url：
 *   · 去掉末尾斜杠；若用户把完整端点（/images/generations|edits）填进来，也一并剥掉
 *   · **没写版本前缀时自动补 `/v1`** —— 公司内部网关常见写法是 `http://gw:port` 或 `http://gw:port/v1`，
 *     少了 /v1 会 404 到网关的静态路由上，排查起来很费时间。
 *     只要路径里已经出现 `/vN`（v1/v2/…）就原样保留（有的网关是 /api/v1、/openai/v1）。
 */
function resolveOpenAIImageBaseUrl(config) {
  let base = String(config?.base_url || '').trim() || OPENAI_IMAGE_DEFAULT_BASE_URL;
  base = base.replace(/\/+$/, '');
  base = base.replace(/\/images\/(generations|edits)$/i, '');
  base = base.replace(/\/+$/, '');
  let pathPart = '';
  try { pathPart = new URL(base).pathname || ''; } catch (_) { pathPart = base; }
  if (!/\/v\d+(\/|$)/i.test(pathPart)) base += '/v1';
  return base.replace(/\/+$/, '');
}

/** 判断参考图是否为本机资源（相对路径 / /static/... / 127.0.0.1 等本机 http 地址 / data URL） */
function isLocalImageRef(ref) {
  const s = String(ref || '').trim();
  if (!s) return false;
  if (/^data:/i.test(s)) return true;
  if (/^https?:\/\//i.test(s)) {
    try {
      const host = new URL(s).hostname.toLowerCase();
      return host === '127.0.0.1' || host === 'localhost' || host === '0.0.0.0' || host === '::1' || host === '[::1]';
    } catch (_) {
      return false;
    }
  }
  return true;
}

/** 把参考图路径规范成 storage 内的相对路径（/static/xxx、本机 http URL 均还原为 xxx） */
function normalizeLocalRefPath(ref) {
  let s = String(ref || '').trim().replace(/\\/g, '/');
  if (!s) return '';
  s = s.replace(/^https?:\/\/[^/]+/i, '');
  s = s.replace(/^\/?static\//i, '');
  s = s.replace(/^\/+/, '');
  return s.split('?')[0].split('#')[0];
}

/** 从 storage_local_path（或绝对路径）读取本机参考图；读不到返回 null */
function readLocalImageBuffer(ref, storageLocalPath) {
  const raw = String(ref || '').trim().replace(/\\/g, '/');
  const rel = normalizeLocalRefPath(raw);
  if (!rel) return null;
  const candidates = [];
  if (path.isAbsolute(raw)) candidates.push(raw);
  const root = storageLocalPath ? String(storageLocalPath) : '';
  if (root) {
    candidates.push(path.join(root, rel));
    candidates.push(path.join(root, '..', rel));
  }
  candidates.push(path.join(process.cwd(), rel));
  for (const candidate of candidates) {
    try {
      if (candidate && fs.existsSync(candidate) && fs.statSync(candidate).isFile()) {
        return fs.readFileSync(candidate);
      }
    } catch (_) {}
  }
  return null;
}

function guessImageMime(refOrName) {
  const s = String(refOrName || '').toLowerCase();
  if (s.includes('.jpg') || s.includes('.jpeg') || s.includes('image/jpeg')) return 'image/jpeg';
  if (s.includes('.webp') || s.includes('image/webp')) return 'image/webp';
  if (s.includes('.gif') || s.includes('image/gif')) return 'image/gif';
  return 'image/png';
}

function extFromMime(mime) {
  const sub = String(mime || '').split('/')[1] || 'png';
  const clean = sub.split(';')[0].trim().replace(/[^a-z0-9]/gi, '') || 'png';
  return clean === 'jpeg' ? 'jpg' : clean;
}

/**
 * 把一张参考图准备成 multipart 可上传的 Blob。
 * - 本机相对路径 / /static/... / 本机 http：从 storage_local_path 读文件；读不到记 warn 跳过
 * - 公网 URL：下载后转 Blob
 * - data URL：解 base64
 * @returns {Promise<{blob: Blob, filename: string}|null>}
 */
async function buildOpenAIRefBlob(ref, storageLocalPath, log) {
  const s = String(ref || '').trim();
  if (!s) return null;

  if (/^data:/i.test(s)) {
    const m = s.match(/^data:(image\/[\w.+-]+);base64,(.+)$/i);
    if (!m) {
      log.warn('[OpenAI图生] 参考图 data URL 无法解析，跳过该张', { ref: s.slice(0, 60) });
      return null;
    }
    const mime = m[1];
    return { blob: new Blob([Buffer.from(m[2], 'base64')], { type: mime }), filename: `ref.${extFromMime(mime)}` };
  }

  if (isLocalImageRef(s)) {
    const buf = readLocalImageBuffer(s, storageLocalPath);
    if (!buf) {
      log.warn('[OpenAI图生] 参考图本地文件读不到，跳过该张', {
        ref: s.slice(0, 120),
        storage_local_path: storageLocalPath || '(空)',
      });
      return null;
    }
    const mime = guessImageMime(s);
    return { blob: new Blob([buf], { type: mime }), filename: `ref.${extFromMime(mime)}` };
  }

  try {
    const res = await fetch(s);
    if (!res.ok) {
      log.warn('[OpenAI图生] 参考图下载失败，跳过该张', { ref: s.slice(0, 120), status: res.status });
      return null;
    }
    const ab = await res.arrayBuffer();
    const mime = String(res.headers?.get?.('content-type') || guessImageMime(s)).split(';')[0].trim() || 'image/png';
    return { blob: new Blob([Buffer.from(ab)], { type: mime }), filename: `ref.${extFromMime(mime)}` };
  } catch (e) {
    log.warn('[OpenAI图生] 参考图下载异常，跳过该张', { ref: s.slice(0, 120), error: e?.message || String(e) });
    return null;
  }
}

/** 解析 OpenAI 图像响应：data[0].b64_json（默认）或 data[0].url；解析不出返回 null */
function extractOpenAIImage(text) {
  let data = null;
  try {
    data = JSON.parse(String(text || ''));
  } catch (_) {
    return null;
  }
  const item = data && Array.isArray(data.data) ? data.data[0] : null;
  if (item && typeof item.b64_json === 'string' && item.b64_json) {
    return { image_url: `data:image/png;base64,${item.b64_json}`, kind: 'b64_json' };
  }
  if (item && typeof item.url === 'string' && item.url) {
    return { image_url: item.url, kind: 'url' };
  }
  return null;
}

/** HTTP 状态 → 可读中文报错 */
function describeOpenAIImageHttpError(status, text) {
  const body = String(text || '');
  const lower = body.toLowerCase();
  if (status === 401 || status === 403) return 'OpenAI API Key 无效或无权限';
  if (status === 429) return '额度不足/触发限流';
  if (status === 400 && /moderation|content[_ ]?policy|safety|violat/.test(lower)) {
    return '内容策略拒绝：OpenAI 判定提示词或参考图违反内容政策（moderation/content policy），请修改后重试';
  }
  let detail = '';
  try {
    const j = JSON.parse(body);
    detail = j?.error?.message || j?.message || '';
  } catch (_) {}
  const tail = detail || body.slice(0, 300);
  return `OpenAI gpt-image 请求失败（HTTP ${status}）${tail ? '：' + tail : ''}`;
}

/** 网络异常 → 可读中文报错（超时单独指出） */
function describeOpenAIImageNetworkError(err) {
  const name = err?.name || '';
  const msg = String(err?.message || err || '');
  if (name === 'AbortError' || /abort|timeout|timed out/i.test(msg)) {
    return 'OpenAI gpt-image 请求超时（网络超时），请检查网络或代理后重试';
  }
  if (/fetch failed|ENOTFOUND|ECONNREFUSED|ECONNRESET|EAI_AGAIN|socket hang up|network/i.test(msg)) {
    return `网络错误：无法连接 OpenAI（${msg.slice(0, 200)}）`;
  }
  return `OpenAI gpt-image 请求失败：${msg.slice(0, 300)}`;
}

/**
 * 调用 OpenAI 官方 gpt-image：
 * - 无参考图 → POST {base_url}/images/generations（JSON: model/prompt/size/n=1）
 * - 有参考图 → POST {base_url}/images/edits（multipart/form-data: model/prompt/size/image[]，最多 8 张）
 * @returns {Promise<{image_url?: string, error?: string}>}
 */
/**
 * 仅对**网络层**失败重试（连接被重置 / DNS 抖动 / socket hang up）。
 *
 * 为什么需要：实测这个中转（aicost.me）的 /images/edits 会偶发 `fetch failed` —— 同一份请求
 * 立刻重跑就成功（1024x1024 58s、1024x1536 48s）。云端接口偶发断连是常态，
 * 一次失败就把整张角色图判死、还让用户以为配置错了，代价太大。
 *
 * 不重试的情况：超时（AbortError，整体预算已经等很久了）与 HTTP 4xx/5xx（那是接口/参数问题，
 * 重试只会重复计费）。
 */
/** 轮询异步任务：文档里 gpt-image 可能返回 {task_id, status:"pending"|"processing"} */
function extractOpenAITaskId(obj) {
  if (!obj || typeof obj !== 'object') return null;
  const id = obj.task_id || obj.taskId || (obj.data && (obj.data.task_id || obj.data.taskId)) || obj.id;
  return id ? String(id) : null;
}
function extractOpenAIStatus(obj) {
  if (!obj || typeof obj !== 'object') return '';
  const s = obj.status || obj.state || (obj.data && obj.data.status) || '';
  return String(s || '').trim().toLowerCase();
}
/**
 * 异步任务轮询：`GET {base}/images/generations/{task_id}`（中转文档 §2.3/§3.3 明确写的就是这条，
 * edits 的异步任务也用同一个查询路径）。拿到图片或失败即返回。
 */
async function pollOpenAIImageTask({ base, apiKey, taskId, safeLog, signal, imageGenId }) {
  const url = `${base}/images/generations/${encodeURIComponent(taskId)}`;
  safeLog.info('[OpenAI图生] 返回异步任务，开始轮询', { image_gen_id: imageGenId, task_id: taskId, url });
  for (let attempt = 1; attempt <= OPENAI_IMAGE_POLL_ATTEMPTS; attempt++) {
    await new Promise((r) => setTimeout(r, OPENAI_IMAGE_POLL_INTERVAL_MS));
    let text = '';
    try {
      const res = await fetch(url, { method: 'GET', headers: { Authorization: `Bearer ${apiKey}` }, signal });
      text = await res.text().catch(() => '');
      if (res.ok) {
        const img = extractOpenAIImage(text);
        if (img) return { ok: true, image: img };
        let obj = null;
        try { obj = JSON.parse(text); } catch (_) {}
        const st = extractOpenAIStatus(obj);
        if (['failed', 'error', 'cancelled', 'canceled'].includes(st)) {
          const msg = (obj && (obj.error?.message || obj.message || obj.error)) || text.slice(0, 200);
          return { ok: false, error: `异步任务失败：${String(msg).slice(0, 200)}` };
        }
      } else if (res.status === 401 || res.status === 403) {
        return { ok: false, error: 'OpenAI API Key 无效或无权限（异步查询被拒）' };
      }
      safeLog.info('[OpenAI图生] 异步任务未完成', { image_gen_id: imageGenId, attempt, task_id: taskId });
    } catch (e) {
      if (e?.name === 'AbortError') return { ok: false, error: 'OpenAI gpt-image 请求超时（等待异步任务超时）' };
      safeLog.warn('[OpenAI图生] 异步查询失败，继续重试', { image_gen_id: imageGenId, attempt, error: String(e?.message || e).slice(0, 120) });
    }
  }
  return { ok: false, error: `异步任务轮询 ${OPENAI_IMAGE_POLL_ATTEMPTS} 次仍未拿到图片（task_id=${taskId}）` };
}

async function fetchOpenAIImageWithRetry(makeRequest, safeLog, { attempts = 3, url = '' } = {}) {
  let lastErr;
  for (let attempt = 1; attempt <= attempts; attempt++) {
    try {
      return await makeRequest();
    } catch (e) {
      lastErr = e;
      const aborted = e?.name === 'AbortError';
      if (aborted || attempt === attempts) throw e;
      const wait = 1500 * attempt;
      safeLog.warn('[OpenAI图生] 网络错误，准备重试', {
        url, attempt, attempts, error: String(e?.message || e).slice(0, 120), wait_ms: wait,
      });
      await new Promise((r) => setTimeout(r, wait));
    }
  }
  throw lastErr;
}

async function callOpenAIGptImageApi(config, log, opts = {}) {
  const safeLog = (log && typeof log.info === 'function')
    ? log
    : { info() {}, warn() {}, error() {} };

  const apiKey = String(config?.api_key || '').trim();
  if (!apiKey) {
    return { error: 'OpenAI gpt-image 未配置 API Key，请在「AI 配置」中填写 OpenAI 的 API Key' };
  }

  // 模型用【配置里填的那个】（公司网关会换型号，写死会导致新模型发不出去）；
  // 只有配置为空、或填的不是 gpt-image 系列时才回退到默认值并记 warn。
  const requestedModel = String(opts.model || '').trim();
  const model = isOpenAIImageModelName(requestedModel) ? requestedModel : OPENAI_IMAGE_MODEL;
  if (model !== requestedModel) {
    safeLog.warn('[OpenAI图生] 模型回退为默认值', {
      requested: requestedModel || '(空)',
      used: model,
    });
  }

  const prompt = String(opts.prompt || '');
  if (!prompt.trim()) {
    return { error: 'OpenAI gpt-image 提示词为空，无法生成图片' };
  }

  const size = mapOpenAIImageSize(opts.size);
  const base = resolveOpenAIImageBaseUrl(config);

  const rawRefs = Array.isArray(opts.reference_image_urls)
    ? opts.reference_image_urls.filter((r) => r != null && String(r).trim() !== '')
    : [];
  const refs = rawRefs.slice(0, OPENAI_IMAGE_MAX_REF_IMAGES);
  if (rawRefs.length > OPENAI_IMAGE_MAX_REF_IMAGES) {
    safeLog.warn('[OpenAI图生] 参考图数量超上限，已截断', {
      total: rawRefs.length,
      used: refs.length,
      max: OPENAI_IMAGE_MAX_REF_IMAGES,
    });
  }
  const hasRefs = refs.length > 0;
  const url = base + (hasRefs ? '/images/edits' : '/images/generations');
  // 中转文档（aicost.me/api-docs §1.2/§2.1/§3.1）把 quality / output_format / moderation 标为必填；
  // 我们现在补齐，并且**显式要 png** —— 返回的 b64 我们按 image/png 落盘，若中转默认给 jpeg，
  // 字节与后缀就会不一致。缺这些字段这次能过只是中转宽容，不该依赖。
  const COMMON_FIELDS = { quality: 'auto', output_format: 'png', moderation: 'auto' };

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), OPENAI_IMAGE_TIMEOUT_MS);
  let res;
  try {
    if (hasRefs) {
      // 先把可用的参考图读成 Blob（读一次），重试时重建 FormData —— multipart body 不要复用
      const blobs = [];
      for (const ref of refs) {
        const built = await buildOpenAIRefBlob(ref, opts.storage_local_path, safeLog);
        if (built) blobs.push(built);
      }
      if (blobs.length === 0) {
        clearTimeout(timer);
        return { error: 'OpenAI gpt-image 参考图全部不可用（本地文件读不到或下载失败），无法调用 /images/edits' };
      }
      const buildForm = (fieldName = 'image[]') => {
        const form = new FormData();
        form.append('model', model);
        form.append('prompt', prompt);
        form.append('n', '1');
        form.append('size', size);
        for (const [k, v] of Object.entries(COMMON_FIELDS)) form.append(k, v);
        for (const b of blobs) form.append(fieldName, b.blob, b.filename);
        return form;
      };
      // multipart/form-data：不要手写 Content-Type，交给 FormData 生成 boundary
      res = await fetchOpenAIImageWithRetry(() => fetch(url, {
        method: 'POST',
        headers: { Authorization: `Bearer ${apiKey}` },
        body: buildForm('image[]'),
        signal: controller.signal,
      }), safeLog, { url });
      // 文档 §3.1：服务端不接受 `image[]` 字段时，改用单数 `image` 重试一次
      if (!res.ok) {
        const probe = await res.clone().text().catch(() => '');
        const looksLikeFieldIssue = /image(\[\])?/i.test(probe) || res.status === 400 || res.status === 422;
        if (looksLikeFieldIssue) {
          safeLog.warn('[OpenAI图生] image[] 未被接受，改用单数 image 重试一次', {
            image_gen_id: opts.image_gen_id, status: res.status, body: probe.slice(0, 160),
          });
          res = await fetchOpenAIImageWithRetry(() => fetch(url, {
            method: 'POST',
            headers: { Authorization: `Bearer ${apiKey}` },
            body: buildForm('image'),
            signal: controller.signal,
          }), safeLog, { url });
        }
      }
    } else {
      res = await fetchOpenAIImageWithRetry(() => fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${apiKey}` },
        body: JSON.stringify({ model, prompt, size, n: 1, ...COMMON_FIELDS }),
        signal: controller.signal,
      }), safeLog, { url });
    }
  } catch (e) {
    clearTimeout(timer);
    const msg = describeOpenAIImageNetworkError(e);
    safeLog.error('[OpenAI图生] 请求异常', {
      url, model, size, has_ref_images: hasRefs, error: e?.message || String(e),
    });
    return { error: msg };
  }
  clearTimeout(timer);

  let text = '';
  try { text = await res.text(); } catch (_) {}

  if (!res.ok) {
    const msg = describeOpenAIImageHttpError(res.status, text);
    safeLog.error('[OpenAI图生] API 返回错误', {
      url, model, size, has_ref_images: hasRefs, status: res.status, error: msg,
    });
    return { error: msg };
  }

  let parsed = extractOpenAIImage(text);

  // 异步任务（文档 §2.3/§3.3：{task_id, status:"pending"|"processing"}）→ 轮询查询接口
  if (!parsed) {
    let obj = null;
    try { obj = JSON.parse(text); } catch (_) {}
    const taskId = extractOpenAITaskId(obj);
    const st = extractOpenAIStatus(obj);
    const looksAsync = taskId && (!st || ['pending', 'processing', 'queued', 'in_progress', 'running', 'submitted'].includes(st));
    if (looksAsync) {
      const polled = await pollOpenAIImageTask({
        base, apiKey, taskId, safeLog, signal: controller.signal, imageGenId: opts.image_gen_id,
      });
      if (polled.ok) {
        parsed = polled.image;
      } else {
        safeLog.error('[OpenAI图生] 异步任务未取到图片', { url, task_id: taskId, error: polled.error });
        return { error: polled.error };
      }
    }
  }
  if (!parsed) {
    return {
      error: `OpenAI gpt-image 返回无法解析（响应前 300 字）：${String(text || '').slice(0, 300)}`,
    };
  }

  safeLog.info('[OpenAI图生] gpt-image 生成成功', {
    url,
    model,
    size,
    has_ref_images: hasRefs,
    response_kind: parsed.kind,
  });
  return { image_url: parsed.image_url };
}

/**
 * 调用提供商图片生成 API（OpenAI /images/generations 风格 或 通义万象 multimodal-generation）
 * @param {object} db - database
 * @param {object} log - logger
 * @param {object} opts - { prompt, model?, size?, quality?, drama_id, preferred_provider?, character_id?, image_type?, image_gen_id, user_negative_prompt? }
 * @returns {Promise<{ image_url?: string, error?: string }>}
 */
async function callImageApi(db, log, opts) {
  const {
    prompt,
    model: preferredModel,
    size,
    quality,
    drama_id,
    preferred_provider,
    character_id,
    image_type,
    image_gen_id,
    imageServiceType,
    reference_image_urls,
    files_base_url,
    storage_local_path,
    system_prompt,
    user_negative_prompt,
  } = opts;
  const preferredProvider = preferred_provider ?? opts.preferredProvider;
  const config = getDefaultImageConfig(db, preferredModel, preferredProvider, imageServiceType);
  if (!config) {
    throw new Error('未配置图片模型，请在「AI 配置」中添加 image 类型且已启用的配置');
  }
  const model = getModelFromConfig(config, preferredModel);
  const provider = (config.provider || '').toLowerCase();
  // api_protocol 显式指定接口规范，优先级高于 provider 推断；未设置时按 provider 自动判断
  const protocol = (config.api_protocol || '').toLowerCase() || inferImageProtocol(provider, model);

  // ── 参考图标签注入：为所有非 Gemini 模型将标签注入 prompt 文本 ─────────────────────────────
  // Gemini 通过 parts 结构处理（interleaved text+image），不需要文字注入。
  // 其他所有模型（Doubao/DashScope/NanoBanana/OpenAI-compat 等）通过文字告知模型各参考图用途，
  // 避免模型模仿参考图的宫格/四视图布局，同时抑制生成分割画面。
  let effectivePrompt = prompt || '';
  if (
    Array.isArray(reference_image_urls) && reference_image_urls.length > 0 &&
    system_prompt
  ) {
    const refLines = String(system_prompt).split('\n').filter(l => /^Image\s+\d+:/i.test(l));
    if (refLines.length > 0) {
      const refHeader = refLines
        .map(l => `[${l} — FOR REFERENCE ONLY, DO NOT copy its layout or framing]`)
        .join('\n');
      effectivePrompt = `${refHeader}\n\n[GENERATE THIS SCENE — single continuous image, no grid, no split panels]:\n${effectivePrompt}`;
    }
  }

  log.info('[图生] callImageApi 路由', {
    image_gen_id,
    protocol,
    api_protocol_raw: config.api_protocol || '(empty→auto)',
    provider,
    model,
    size,
    imageServiceType,
    ref_count: Array.isArray(opts.reference_image_urls) ? opts.reference_image_urls.length : 0,
    ref_label_injected: effectivePrompt !== (prompt || ''),
    effectivePrompt
  });

  if (protocol === 'comfyui') {
    return callComfyUIImageApi(config, log, {
      prompt: effectivePrompt, model, size, image_gen_id,
      reference_image_urls: opts.reference_image_urls,
      files_base_url: opts.files_base_url,
      storage_local_path: opts.storage_local_path,
      raw_prompt: prompt,
      reference_labels: (system_prompt ? String(system_prompt).split('\n').filter(l => /^Image\s+/i.test(l)) : []),
    });
  }

  // OpenAI 官方 gpt-image 云端图像通道（文生图 / 带参考图的分镜图）
  if (protocol === 'openai_image') {
    return callOpenAIGptImageApi(config, log, {
      prompt: effectivePrompt, model, size, image_gen_id,
      reference_image_urls: opts.reference_image_urls,
      files_base_url: opts.files_base_url,
      storage_local_path: opts.storage_local_path,
      raw_prompt: prompt,
      reference_labels: (system_prompt ? String(system_prompt).split('\n').filter(l => /^Image\s+/i.test(l)) : []),
    });
  }

  // 同上：只支持 ComfyUI 与 OpenAI gpt-image，其它 api_protocol 明确报错（不要静默返回 undefined）
  return {
    error: `不支持的图片接口规范 api_protocol=${protocol}（本软件支持 ComfyUI 与 OpenAI gpt-image）`,
  };


}

/**
 * 创建 image_generation 记录并异步调用 API，完成后更新记录与角色 image_url。
 * 与场景图一致：创建 task 并写入 task_id，便于前端轮询 /tasks/:task_id 获知完成或报错。
 */
function createAndGenerateImage(db, log, opts) {
  const {
    drama_id,
    character_id,
    scene_id,
    image_type,
    prompt,
    model,
    size,
    quality,
    provider,
    user_negative_prompt,
  } = opts;
  const negRow = (user_negative_prompt && String(user_negative_prompt).trim()) || null;
  const now = new Date().toISOString();
  const dramaIdNum = Number(drama_id) || 0;
  const charIdNum = character_id != null ? Number(character_id) : null;
  const sceneIdNum = scene_id != null ? Number(scene_id) : null;

  let resourceId;
  if (charIdNum != null) resourceId = `character_${charIdNum}`;
  else if (sceneIdNum != null) resourceId = `scene_${sceneIdNum}`;
  else resourceId = String(dramaIdNum);
  const task = taskService.createTask(db, log, 'image_generation', resourceId);
  const taskId = task.id;

  let imageGenId;
  try {
    const info = db.prepare(
      `INSERT INTO image_generations (drama_id, character_id, scene_id, provider, prompt, negative_prompt, model, size, quality, status, task_id, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending', ?, ?, ?)`
    ).run(
      dramaIdNum,
      charIdNum,
      sceneIdNum,
      provider || 'openai',
      prompt || '',
      negRow,
      model || null,
      size || null,
      quality || null,
      taskId,
      now,
      now
    );
    imageGenId = info.lastInsertRowid;
  } catch (e) {
    if ((e.message || '').includes('scene_id') || (e.message || '').includes('character_id')) {
      const info = db.prepare(
        `INSERT INTO image_generations (drama_id, provider, prompt, model, size, quality, status, task_id, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, 'pending', ?, ?, ?)`
      ).run(dramaIdNum, provider || 'openai', prompt || '', model || null, size || null, quality || null, taskId, now, now);
      imageGenId = info.lastInsertRowid;
    } else {
      throw e;
    }
  }

  setImmediate(async () => {
    try {
      db.prepare('UPDATE image_generations SET status = ? WHERE id = ?').run('processing', imageGenId);
      taskService.updateTaskStatus(db, taskId, 'processing', 0, '正在生成图片...');
      const result = await callImageApi(db, log, {
        prompt,
        model,
        size,
        quality,
        drama_id: drama_id,
        character_id: character_id,
        image_type,
        image_gen_id: imageGenId,
        user_negative_prompt: user_negative_prompt || undefined,
      });
      const now2 = new Date().toISOString();
      if (result.error) {
        db.prepare(
          'UPDATE image_generations SET status = ?, error_msg = ?, updated_at = ? WHERE id = ?'
        ).run('failed', result.error, now2, imageGenId);
        taskService.updateTaskError(db, taskId, result.error);
        if (charIdNum != null) {
          try {
            db.prepare('UPDATE characters SET error_msg = ?, updated_at = ? WHERE id = ?').run(result.error, now2, charIdNum);
          } catch (_) {}
        }
        if (sceneIdNum != null) {
          try {
            db.prepare('UPDATE scenes SET error_msg = ?, updated_at = ? WHERE id = ?').run(result.error, now2, sceneIdNum);
          } catch (_) {}
        }
        log.error('Image generation failed', { image_gen_id: imageGenId, error: result.error });
        return;
      }
      let localPath = null;
      try {
        const loadConfig = require('../config').loadConfig;
        const cfg = loadConfig();
        const storagePath = path.isAbsolute(cfg.storage?.local_path)
          ? cfg.storage.local_path
          : path.join(process.cwd(), cfg.storage?.local_path || './data/storage');
        const category = sceneIdNum != null ? 'scenes' : (charIdNum != null ? 'characters' : 'images');
        const projectSubdir = storageLayout.getProjectStorageSubdir(db, dramaIdNum);
        localPath = await uploadService.downloadImageToLocal(
          storagePath,
          result.image_url,
          category,
          log,
          'ig',
          projectSubdir
        );
      } catch (_) {}
      // 兼容旧库无 completed_at：先试完整 UPDATE，失败则只更新必有列
      try {
        db.prepare(
          'UPDATE image_generations SET status = ?, image_url = ?, local_path = ?, completed_at = ?, updated_at = ? WHERE id = ?'
        ).run('completed', result.image_url, localPath, now2, now2, imageGenId);
      } catch (e) {
        if ((e.message || '').includes('completed_at')) {
          db.prepare(
            'UPDATE image_generations SET status = ?, image_url = ?, local_path = ?, updated_at = ? WHERE id = ?'
          ).run('completed', result.image_url, localPath, now2, imageGenId);
        } else {
          throw e;
        }
      }
      taskService.updateTaskResult(db, taskId, { image_generation_id: imageGenId, image_url: result.image_url, local_path: localPath, status: 'completed' });
      if (charIdNum != null) {
        try {
          // 旧图追加到 extra_images，与上传逻辑保持一致
          const oldChar = db
            .prepare('SELECT local_path, image_url, extra_images, seedance2_asset FROM characters WHERE id = ?')
            .get(charIdNum);
          const oldPath = oldChar?.local_path || oldChar?.image_url || '';
          let extras = [];
          try { extras = oldChar?.extra_images ? JSON.parse(oldChar.extra_images) : []; } catch (_) {}
          if (!Array.isArray(extras)) extras = [];
          if (oldPath && !extras.includes(oldPath)) extras.push(oldPath);
          const extraJson = extras.length ? JSON.stringify(extras) : null;

          db.prepare('UPDATE characters SET image_url = ?, local_path = ?, extra_images = ?, updated_at = ? WHERE id = ?').run(
            result.image_url,
            localPath,
            extraJson,
            now2,
            charIdNum
          );
        } catch (e) {
          if ((e.message || '').includes('local_path') || (e.message || '').includes('extra_images')) {
            db.prepare('UPDATE characters SET image_url = ?, updated_at = ? WHERE id = ?').run(result.image_url, now2, charIdNum);
          } else {
            throw e;
          }
        }
        log.info('Character image updated', { character_id: charIdNum, image_url: result.image_url, local_path: localPath });
      }
      if (sceneIdNum != null) {
        try {
          // 旧图追加到 extra_images，与上传逻辑保持一致
          const oldScene = db.prepare('SELECT local_path, image_url, extra_images FROM scenes WHERE id = ?').get(sceneIdNum);
          const oldPath = oldScene?.local_path || oldScene?.image_url || '';
          let extras = [];
          try { extras = oldScene?.extra_images ? JSON.parse(oldScene.extra_images) : []; } catch (_) {}
          if (!Array.isArray(extras)) extras = [];
          if (oldPath && !extras.includes(oldPath)) extras.push(oldPath);
          const extraJson = extras.length ? JSON.stringify(extras) : null;
          db.prepare('UPDATE scenes SET image_url = ?, local_path = ?, extra_images = ?, updated_at = ? WHERE id = ?').run(
            result.image_url,
            localPath,
            extraJson,
            now2,
            sceneIdNum
          );
        } catch (e) {
          if ((e.message || '').includes('local_path') || (e.message || '').includes('extra_images')) {
            db.prepare('UPDATE scenes SET image_url = ?, updated_at = ? WHERE id = ?').run(result.image_url, now2, sceneIdNum);
          } else {
            throw e;
          }
        }
        log.info('Scene image updated', { scene_id: sceneIdNum, image_url: result.image_url, local_path: localPath });
      }
      log.info('Image generation completed', { image_gen_id: imageGenId, local_path: localPath });
    } catch (err) {
      const now2 = new Date().toISOString();
      const errMsg = (err && err.message) ? String(err.message).slice(0, 500) : 'Unknown error';
      try {
        db.prepare(
          'UPDATE image_generations SET status = ?, error_msg = ?, updated_at = ? WHERE id = ?'
        ).run('failed', errMsg, now2, imageGenId);
      } catch (e) {
        log.error('Image generation: failed to update image_generations', { image_gen_id: imageGenId, error: e.message });
      }
      try {
        taskService.updateTaskError(db, taskId, errMsg);
      } catch (e) {
        log.error('Image generation: failed to update task status', { task_id: taskId, error: e.message });
      }
      if (charIdNum != null) {
        try {
          db.prepare('UPDATE characters SET error_msg = ?, updated_at = ? WHERE id = ?').run(errMsg, now2, charIdNum);
        } catch (_) {}
      }
      if (sceneIdNum != null) {
        try {
          db.prepare('UPDATE scenes SET error_msg = ?, updated_at = ? WHERE id = ?').run(errMsg, now2, sceneIdNum);
        } catch (_) {}
      }
      log.error('Image generation error', { image_gen_id: imageGenId, task_id: taskId, error: err.message });
    }
  });

  const row = db.prepare('SELECT * FROM image_generations WHERE id = ?').get(imageGenId);
  return row ? rowToItem(row) : { id: imageGenId, task_id: taskId, status: 'pending', drama_id: dramaIdNum, character_id: charIdNum, scene_id: sceneIdNum, prompt, model, size, quality, created_at: now, updated_at: now };
}

function rowToItem(r) {
  return {
    id: r.id,
    storyboard_id: r.storyboard_id,
    drama_id: r.drama_id,
    character_id: r.character_id,
    provider: r.provider,
    prompt: r.prompt,
    model: r.model,
    size: r.size,
    quality: r.quality,
    image_url: r.image_url,
    local_path: r.local_path,
    status: r.status,
    task_id: r.task_id,
    error_msg: r.error_msg,
    created_at: r.created_at,
    updated_at: r.updated_at,
    completed_at: r.completed_at,
  };
}

/** 分镜参考图上限 */
function getStoryboardReferenceLimits(config, modelName) {
  const provider = (config?.provider || '').toLowerCase();
  const protocol = (config?.api_protocol || '').toLowerCase() || inferImageProtocol(provider, modelName || config?.model);
  if (protocol === 'comfyui') {
    // Qwen-Image-Edit 三通道：image1..3 = 场景整图 / 全部角色拼图 / 全部道具拼图（工作流内 ImageStitch）
    // 每张原图独立全分辨率进入拼图：场景1 + 角色至多3 + 道具至多2
    return { total: 6, maxCharacters: 3, maxObjects: 3 };
  }
  return { total: 4, maxCharacters: 3, maxObjects: 4 };
}

function countStoryboardRefsFromLabels(refLabels) {
  let characters = 0;
  let objects = 0;
  for (const lbl of refLabels || []) {
    if (/character appearance/i.test(lbl)) characters += 1;
    else if (/scene background|prop\/object/i.test(lbl)) objects += 1;
  }
  return { characters, objects };
}

function canAddStoryboardCharacterRef(refLabels, limits) {
  const { characters } = countStoryboardRefsFromLabels(refLabels);
  return refLabels.length < limits.total && characters < limits.maxCharacters;
}

function canAddStoryboardObjectRef(refLabels, limits) {
  const { objects } = countStoryboardRefsFromLabels(refLabels);
  return refLabels.length < limits.total && objects < limits.maxObjects;
}

/** 去重：同一本地路径或 URL（忽略 query）不重复加入参考图列表 */
function canonicalRefKey(ref) {
  if (ref == null || ref === '') return '';
  let s = String(ref).trim().replace(/\\/g, '/');
  if (s.startsWith('data:')) return s.slice(0, 120);
  if (/^https?:\/\//i.test(s)) {
    try {
      const u = new URL(s);
      return `${u.origin}${u.pathname}`.toLowerCase();
    } catch (_) {
      return s.split('?')[0].toLowerCase();
    }
  }
  try {
    return path.normalize(s).toLowerCase();
  } catch (_) {
    return s.toLowerCase();
  }
}

function refListHasCanonical(list, ref) {
  const key = canonicalRefKey(ref);
  if (!key) return false;
  return (list || []).some((item) => canonicalRefKey(item) === key);
}

module.exports = {
  getDefaultImageConfig,
  callImageApi,
  callOpenAIGptImageApi,
  inferImageProtocol,
  mapOpenAIImageSize,
  resolveOpenAIImageBaseUrl,
  createAndGenerateImage,
  resolveAssetUserNegativeForApi,
  getStoryboardReferenceLimits,
  canAddStoryboardCharacterRef,
  canAddStoryboardObjectRef,
  refListHasCanonical,
  /** 图床 URL 缓存（image_proxy_cache），供 SD2 认证等复用 */
  getProxyCache,
  deleteProxyCache,
  setProxyCache,
};

// 图像配置选择优先级：显式 model > 显式默认 > 厂商偏好兜底（详见 getDefaultImageConfig）
