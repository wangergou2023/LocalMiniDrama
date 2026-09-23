// AI 配置 CRUD，与 Go application/services/ai_service.go 对齐
const fs = require('fs');
const path = require('path');

function normalizeApiKeyForService(_serviceType, apiKey) {
  return apiKey;
}
const { applyDeepSeekConnectivityOptions } = require('./deepseekConfig');
function modelToDb(model) {
  if (model == null) return null;
  if (Array.isArray(model)) return JSON.stringify(model);
  if (typeof model === 'string') return JSON.stringify([model]);
  return JSON.stringify([]);
}

function modelFromDb(val) {
  if (val == null || val === '') return [];
  try {
    const arr = JSON.parse(val);
    return Array.isArray(arr) ? arr : [String(arr)];
  } catch {
    return [String(val)];
  }
}

/** 每种服务类型只保留一个默认：若有多个 is_default=1，只保留优先级最高（同优先级取 id 最小）的那条 */
function ensureSingleDefaultPerType(db) {
  const types = ['text', 'image', 'storyboard_image', 'video'];
  for (const st of types) {
    const rows = db.prepare(
      // 同一类型出现多个默认时（例如前端批量保存、或从旧版升级）保留「最近设置过」的那条：
      // 以前按 id ASC 保留最老的一条，会把用户刚点选的默认悄悄改回去。
      'SELECT id, priority FROM ai_service_configs WHERE deleted_at IS NULL AND service_type = ? AND is_default = 1 ORDER BY priority DESC, updated_at DESC, id DESC'
    ).all(st);
    if (rows.length <= 1) continue;
    const keepId = rows[0].id;
    db.prepare(
      'UPDATE ai_service_configs SET is_default = 0 WHERE deleted_at IS NULL AND service_type = ? AND id != ?'
    ).run(st, keepId);
  }
}

function listConfigs(db, serviceType) {
  ensureSingleDefaultPerType(db);
  const order = 'ORDER BY is_default DESC, priority DESC, created_at DESC';
  let sql = 'SELECT * FROM ai_service_configs WHERE deleted_at IS NULL ' + order;
  const params = [];
  if (serviceType) {
    sql = 'SELECT * FROM ai_service_configs WHERE deleted_at IS NULL AND service_type = ? ' + order;
    params.push(serviceType);
  }
  const rows = params.length ? db.prepare(sql).all(...params) : db.prepare(sql).all();
  return rows.map(rowToConfig);
}

function clearOtherDefault(db, serviceType, exceptId) {
  const stmt = db.prepare(
    'UPDATE ai_service_configs SET is_default = 0 WHERE deleted_at IS NULL AND service_type = ? AND id != ?'
  );
  stmt.run(serviceType, exceptId);
}

function getConfig(db, id) {
  const row = db.prepare('SELECT * FROM ai_service_configs WHERE id = ? AND deleted_at IS NULL').get(id);
  return row ? rowToConfig(row) : null;
}

function createConfig(db, log, req) {
  const now = new Date().toISOString();
  const model = modelToDb(req.model);
  const providerLower = String(req.provider || '').toLowerCase().trim();
  // OpenAI 官方 gpt-image 云端图像通道（协议名 openai_image）
  const isOpenAIImage = providerLower === 'openai_image' || providerLower === 'gpt_image' || providerLower === 'gpt-image';
  let endpoint = req.endpoint || '';
  let queryEndpoint = req.query_endpoint || '';
  let apiProtocol = req.api_protocol || '';
  if (isOpenAIImage) apiProtocol = 'openai_image';
  if (!endpoint && req.provider) {
    const p = req.provider.toLowerCase();
    const st = (req.service_type || 'text').toLowerCase();
    // 只支持四类后端：ComfyUI（本地/在线，靠 base_url 区分）、OpenAI 官方 gpt-image（云端图像）、
    // 云端 MiniMax H3、OpenAI 兼容（文本/DeepSeek 等）。
    // 其余云厂商（火山/即梦/可灵/通义/海螺/Vidu/Gemini…）已下线，不再推导端点。
    if (p === 'comfyui') {
      // ComfyUI 走 /prompt 等自有接口，由 comfyuiClient 处理，不需要 endpoint 字段
    } else if (isOpenAIImage) {
      // OpenAI 官方 gpt-image：文生图 /images/generations，带参考图自动切 /images/edits
      endpoint = '/images/generations';
    } else if (p === 'minimax_h3') {
      // 云端 MiniMax H3（Video Generation V2）
      apiProtocol = apiProtocol || 'minimax_h3';
      endpoint = '/v2/video_generation';
      queryEndpoint = '/v2/query/video_generation/{taskId}';
    } else if (st === 'text') {
      endpoint = '/chat/completions';
    } else if (st === 'image' || st === 'storyboard_image') {
      endpoint = '/images/generations';
    } else if (st === 'video') {
      endpoint = '/videos';
      queryEndpoint = '/videos/{taskId}';
    }
  }
  const baseUrl = req.base_url || (isOpenAIImage ? 'https://api.openai.com/v1' : '');
  const defaultModel = req.default_model != null ? String(req.default_model).trim() || null : null;
  // 「旁白参考音色」(service_type='tts')：voice_id / group_id 存正式列，ttsService 直接读。
  const voiceId = req.voice_id != null ? String(req.voice_id).trim() || null : null;
  const groupId = req.group_id != null ? String(req.group_id).trim() || null : null;
  const info = db.prepare(
    `INSERT INTO ai_service_configs (service_type, provider, api_protocol, name, base_url, api_key, model, default_model, endpoint, query_endpoint, priority, is_default, is_active, settings, voice_id, group_id, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?, ?, ?, ?)`
  ).run(
    req.service_type || 'text',
    req.provider || '',
    apiProtocol,
    req.name || '',
    baseUrl,
    normalizeApiKeyForService(req.service_type, req.api_key || ''),
    model,
    defaultModel,
    endpoint,
    queryEndpoint,
    req.priority ?? 0,
    req.is_default ? 1 : 0,
    req.settings || null,
    voiceId,
    groupId,
    now,
    now
  );
  log.info('AI config created', { config_id: info.lastInsertRowid, provider: req.provider });
  const newId = info.lastInsertRowid;
  if (req.is_default) clearOtherDefault(db, req.service_type || 'text', newId);
  return getConfig(db, newId);
}

function updateConfig(db, log, id, req) {
  const existing = getConfig(db, id);
  if (!existing) return null;
  const updates = [];
  const params = [];
  if (req.name != null) {
    updates.push('name = ?');
    params.push(req.name);
  }
  if (req.provider != null) {
    updates.push('provider = ?');
    params.push(req.provider);
  }
  if (req.api_protocol != null) {
    updates.push('api_protocol = ?');
    params.push(req.api_protocol);
  }
  if (req.base_url != null) {
    updates.push('base_url = ?');
    params.push(req.base_url);
  }
  if (req.api_key != null) {
    updates.push('api_key = ?');
    const st = req.service_type != null ? req.service_type : existing.service_type;
    params.push(normalizeApiKeyForService(st, req.api_key));
  }
  if (req.model != null) {
    updates.push('model = ?');
    params.push(modelToDb(req.model));
  }
  if (req.default_model !== undefined) {
    updates.push('default_model = ?');
    params.push(req.default_model != null ? String(req.default_model).trim() || null : null);
  }
  if (req.priority != null) {
    updates.push('priority = ?');
    params.push(req.priority);
  }
  if (req.endpoint !== undefined) {
    updates.push('endpoint = ?');
    params.push(req.endpoint || '');
  }
  if (req.query_endpoint !== undefined) {
    updates.push('query_endpoint = ?');
    params.push(req.query_endpoint || '');
  }
  if (req.settings != null) {
    updates.push('settings = ?');
    params.push(req.settings);
  }
  // 「旁白参考音色」专用（其余类型不传这两个字段，不受影响）
  if (req.voice_id !== undefined) {
    updates.push('voice_id = ?');
    params.push(req.voice_id != null ? String(req.voice_id).trim() || null : null);
  }
  if (req.group_id !== undefined) {
    updates.push('group_id = ?');
    params.push(req.group_id != null ? String(req.group_id).trim() || null : null);
  }
  if (typeof req.is_default === 'boolean') {
    updates.push('is_default = ?');
    params.push(req.is_default ? 1 : 0);
  }
  if (typeof req.is_active === 'boolean') {
    updates.push('is_active = ?');
    params.push(req.is_active ? 1 : 0);
  }
  if (updates.length === 0) return existing;
  params.push(new Date().toISOString(), id);
  db.prepare('UPDATE ai_service_configs SET ' + updates.join(', ') + ', updated_at = ? WHERE id = ?').run(...params);
  if (req.is_default === true) clearOtherDefault(db, existing.service_type, id);
  log.info('AI config updated', { config_id: id });
  return getConfig(db, id);
}

function deleteConfig(db, log, id) {
  const now = new Date().toISOString();
  const result = db.prepare('UPDATE ai_service_configs SET deleted_at = ? WHERE id = ? AND deleted_at IS NULL').run(now, id);
  if (result.changes === 0) return false;
  log.info('AI config deleted', { config_id: id });
  return true;
}

function rowToConfig(r) {
  const cfg = {
    id: r.id,
    service_type: r.service_type,
    provider: r.provider,
    api_protocol: r.api_protocol || '',
    name: r.name,
    base_url: r.base_url,
    api_key: r.api_key,
    model: modelFromDb(r.model),
    default_model: r.default_model ? String(r.default_model).trim() : null,
    endpoint: r.endpoint,
    query_endpoint: r.query_endpoint,
    priority: r.priority ?? 0,
    is_default: !!r.is_default,
    is_active: r.is_active == null ? true : !!r.is_active,
    settings: r.settings,
    voice_id: r.voice_id || '',
    group_id: r.group_id || '',
    created_at: r.created_at,
    updated_at: r.updated_at,
  };
  return cfg;
}

/**
 * 测试连接：与 Go AIService.TestConnection 对齐，根据 provider 发最小请求验证 base_url + api_key
 * @param opts { base_url, api_key, model (string|string[]), provider?, endpoint?, settings? }
 * @returns Promise<void> 成功 resolve，失败 reject(error)
 */
async function testConnection(opts) {
  const base = (opts.base_url || '').replace(/\/$/, '');
  if (!base) throw new Error('base_url 必填');
  if (!opts.api_key) throw new Error('api_key 必填');
  const models = Array.isArray(opts.model) ? opts.model : opts.model != null ? [opts.model] : [];
  const model = models[0] || '';
  const provider = (opts.provider || 'openai').toLowerCase();
  const serviceType = (opts.service_type || '').toLowerCase();
  let endpoint = opts.endpoint || '';

  // --- NanoBanana ---

  // --- OpenAI 官方 gpt-image（云端图像）---
  // 轻量校验：GET /models 验证 Key 与网络，不触发真实生图（不产生费用）
  // 模型名按前缀识别（gpt-image / gpt-image-2.5-flare / … ）—— 写死具体型号会在网关升级后失效
  if (provider === 'openai_image' || provider === 'gpt_image' || provider === 'gpt-image'
    || (provider === 'openai' && /^gpt-image/i.test(String(model || '')))) {
    // 与图像通道用同一套归一化：内部网关常填 http://gw:port（缺 /v1），这里也要补，否则探针 404
    let modelBase = base;
    try { modelBase = require('./imageClient').resolveOpenAIImageBaseUrl({ base_url: base }); } catch (_) {}
    const url = modelBase + '/models';
    console.log('[testConnection] OpenAI gpt-image 图像服务', { url, serviceType, model });
    let res;
    try {
      res = await fetch(url, {
        method: 'GET',
        headers: { Authorization: 'Bearer ' + (opts.api_key || '') },
      });
    } catch (e) {
      throw new Error('网络错误：无法连接 OpenAI（' + (e?.message || e) + '）');
    }
    if (res.status === 401 || res.status === 403) {
      const text = await res.text().catch(() => '');
      let errMsg = `OpenAI API Key 无效或无权限 (${res.status})`;
      try { const j = JSON.parse(text); errMsg = j.error?.message || j.message || errMsg; } catch {}
      throw new Error(errMsg);
    }
    if (res.status === 429) throw new Error('额度不足/触发限流');
    // 其它状态（含部分中转不支持 /models 的 404）说明网络已连通、Key 已送达，视为可用
    return;
  }


  // ComfyUI（本地或远程）：只探 /system_stats，不触发任何生成、不占显存。
  // 以前这里对图像/视频配置走的是 chat/completions 探针，而裁剪时把 treatAsImage /
  // looksLikeVideoModel 两个标识符一起删了、判断语句却留着 → 点「测试连接」直接 ReferenceError。
  const isMediaService = serviceType === 'image' || serviceType === 'storyboard_image' || serviceType === 'video';
  if (provider === 'comfyui' || /comfyui/i.test(opts.api_protocol || '')) {
    const url = base + '/system_stats';
    console.log('[testConnection] ComfyUI 服务', { url, serviceType });
    let res;
    try {
      res = await fetch(url, { method: 'GET' });
    } catch (e) {
      throw new Error('无法连接 ComfyUI（' + (e?.message || e) + '）—— 请确认地址可达、ComfyUI 已启动');
    }
    if (!res.ok) throw new Error(`ComfyUI 返回 ${res.status} —— 请确认 ${base} 是 ComfyUI 地址`);
    return;
  }
  // 云端 MiniMax H3（视频）：轻量探 /v1/models 验 Key 与网络，不触发真实生成（不产生费用）。
  // 401/403 → Key 无效；429 → 额度/限流；其余状态（含中转不支持 /models 的 404）说明网络已连通。
  if (provider === 'minimax_h3' || opts.api_protocol === 'minimax_h3') {
    let root = String(base || 'https://api.minimaxi.com').trim().replace(/\/$/, '');
    for (const suf of ['/v2', '/v1']) {
      if (root.toLowerCase().endsWith(suf)) { root = root.slice(0, -suf.length).replace(/\/$/, ''); break; }
    }
    const url = root + '/v1/models';
    console.log('[testConnection] MiniMax H3 云端服务', { url, serviceType, model });
    let res;
    try {
      res = await fetch(url, { method: 'GET', headers: { Authorization: 'Bearer ' + (opts.api_key || '') } });
    } catch (e) {
      throw new Error('网络错误：无法连接 MiniMax（' + (e?.message || e) + '）');
    }
    if (res.status === 401 || res.status === 403) {
      const text = await res.text().catch(() => '');
      let errMsg = `MiniMax API Key 无效或无权限 (${res.status})`;
      try { const j = JSON.parse(text); errMsg = j.error?.message || j.message || errMsg; } catch {}
      throw new Error(errMsg);
    }
    if (res.status === 429) throw new Error('额度不足/触发限流');
    return;
  }

  if (isMediaService) {
    throw new Error(
      '图像/视频只支持两种接口规范：ComfyUI（本地或远程）与 OpenAI gpt-image（图像）/ 云端 MiniMax H3（视频）。' +
      `当前 provider=${opts.provider || '-'} api_protocol=${opts.api_protocol || '-'}`
    );
  }

  // --- OpenAI / 默认：chat completions ---
  endpoint = endpoint || '/chat/completions';
  const path = endpoint.startsWith('/') ? endpoint : '/' + endpoint;
  const url = base + path;
  let body = {
    model: model || 'gpt-3.5-turbo',
    messages: [{ role: 'user', content: 'Hello' }],
    max_tokens: 5,
  };
  body = applyDeepSeekConnectivityOptions(
    { provider, base_url: base, settings: opts.settings },
    body
  );
  console.log('[testConnection] 文本/chat 服务', { url, serviceType, model });
  const res = await fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: 'Bearer ' + (opts.api_key || ''),
    },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const text = await res.text();
    let errMsg = `请求失败: ${res.status}`;
    try {
      const j = JSON.parse(text);
      errMsg += ' - ' + (j.error?.message || j.message || j.error || text.slice(0, 150));
    } catch {
      if (text) errMsg += ' - ' + text.slice(0, 150);
    }
    throw new Error(errMsg);
  }
  const data = await res.json().catch(() => ({}));
  if (data.choices == null && data.error != null) {
    throw new Error(data.error.message || data.error || '接口返回错误');
  }
}

/**
 * 返回 vendor_lock 状态
 */
function getVendorLockStatus(cfg) {
  const lock = cfg?.vendor_lock;
  return {
    enabled: !!(lock?.enabled),
    config_file: lock?.config_file || '',
  };
}

/**
 * 启动时同步 vendor_lock 指定的配置文件到数据库。
 * - 软删除所有现有配置，按文件重新导入
 * - 若同 service_type + provider 在 DB 中已有记录，则保留用户修改过的 api_key
 */
function applyVendorLock(db, log, cfg) {
  const status = getVendorLockStatus(cfg);
  if (!status.enabled) return;

  const configFile = status.config_file;
  if (!configFile) {
    log.warn && log.warn('vendor_lock enabled but config_file is empty');
    return;
  }

  const candidates = [
    path.join(process.cwd(), 'configs', configFile),
    path.join(__dirname, '..', '..', 'configs', configFile),
  ];
  let raw = null;
  for (const p of candidates) {
    if (fs.existsSync(p)) { raw = fs.readFileSync(p, 'utf8'); break; }
  }
  if (!raw) {
    console.warn('[vendor_lock] config file not found:', configFile);
    return;
  }

  let configs;
  try {
    configs = JSON.parse(raw);
    if (!Array.isArray(configs)) throw new Error('config file must be a JSON array');
  } catch (e) {
    console.error('[vendor_lock] failed to parse config file:', e.message);
    return;
  }

  // 保存现有 api_key（key: "service_type:provider"）
  const existing = db.prepare('SELECT service_type, provider, api_key FROM ai_service_configs WHERE deleted_at IS NULL').all();
  const savedKeys = new Map();
  for (const row of existing) {
    savedKeys.set(`${row.service_type}:${row.provider}`, row.api_key);
  }

  const now = new Date().toISOString();
  db.prepare('UPDATE ai_service_configs SET deleted_at = ? WHERE deleted_at IS NULL').run(now);

  for (const item of configs) {
    const mapKey = `${item.service_type}:${item.provider}`;
    const apiKey = savedKeys.get(mapKey) ?? item.api_key ?? '';
    const model = Array.isArray(item.model)
      ? JSON.stringify(item.model)
      : item.model ? JSON.stringify([item.model]) : '[]';
    db.prepare(
      `INSERT INTO ai_service_configs
        (service_type, provider, api_protocol, name, base_url, api_key, model, default_model, endpoint, query_endpoint, priority, is_default, is_active, settings, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?, ?)`
    ).run(
      item.service_type || 'text',
      item.provider || '',
      item.api_protocol || '',
      item.name || '',
      item.base_url || '',
      apiKey,
      model,
      item.default_model || null,
      item.endpoint || '',
      item.query_endpoint || '',
      item.priority ?? 0,
      item.is_default ? 1 : 0,
      item.settings || null,
      now,
      now
    );
  }
  for (const item of configs) {
    console.log(`[vendor_lock] loaded: service_type=${item.service_type} provider=${item.provider} api_protocol=${item.api_protocol || '(auto)'} endpoint=${item.endpoint || '(auto)'}`);
  }
  console.log(`[vendor_lock] synced ${configs.length} configs from ${configFile}`);
}

/**
 * 批量替换所有配置的 api_key（仅限锁定模式下使用）
 */
function bulkUpdateApiKey(db, log, newKey) {
  const now = new Date().toISOString();
  const info = db.prepare(
    'UPDATE ai_service_configs SET api_key = ?, updated_at = ? WHERE deleted_at IS NULL'
  ).run(newKey, now);
  log.info('Bulk update api_key', { updated: info.changes });
  return info.changes;
}

module.exports = {
  listConfigs,
  getConfig,
  createConfig,
  updateConfig,
  deleteConfig,
  testConnection,
  getVendorLockStatus,
  applyVendorLock,
  bulkUpdateApiKey,
};
