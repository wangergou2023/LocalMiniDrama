const OFFICIAL_HOST_RE = /(^|\.)api\.deepseek\.com$/i;

const LEGACY_MODEL_OPTIONS = {
  'deepseek-chat': { model: 'deepseek-v4-flash', thinking: 'disabled' },
  'deepseek-reasoner': { model: 'deepseek-v4-flash', thinking: 'enabled' },
};

function parseSettings(settings) {
  if (!settings) return {};
  if (typeof settings === 'object') return settings;
  try {
    const parsed = JSON.parse(settings);
    return parsed && typeof parsed === 'object' ? parsed : {};
  } catch (_) {
    return {};
  }
}

function hasDeepSeekSettings(config = {}) {
  // 用户在配置 settings 里显式声明 thinking / reasoning 相关选项时，
  // 无论 provider / base_url 指向哪家（含公司内部中转网关、第三方中转站），都按 DeepSeek 语义应用。
  const s = parseSettings(config.settings);
  if (!s || typeof s !== 'object') return false;
  if (s.deepseek && typeof s.deepseek === 'object') return true;
  const keys = ['deepseek_thinking', 'thinking', 'deepseek_reasoning_effort', 'reasoning_effort'];
  return keys.some((k) => s[k] !== undefined && s[k] !== null && s[k] !== '');
}

function isDeepSeekOfficialConfig(config = {}) {
  const provider = String(config.provider || '').trim().toLowerCase();
  if (provider === 'deepseek') return true;
  // 非官方网关：仅当配置显式声明 deepseek 语义选项时才接管（避免给普通中转站强加参数）
  if (hasDeepSeekSettings(config)) return true;

  const rawBase = String(config.base_url || '').trim();
  if (!rawBase) return false;
  try {
    const url = new URL(rawBase);
    return OFFICIAL_HOST_RE.test(url.hostname);
  } catch (_) {
    return rawBase.toLowerCase().includes('api.deepseek.com');
  }
}

function normalizeThinking(value) {
  if (value == null || value === '') return null;
  if (typeof value === 'boolean') return value ? 'enabled' : 'disabled';
  const v = String(value).trim().toLowerCase();
  if (v === 'enabled' || v === 'enable' || v === 'on' || v === 'true' || v === 'thinking') return 'enabled';
  if (v === 'disabled' || v === 'disable' || v === 'off' || v === 'false' || v === 'non-thinking') return 'disabled';
  return null;
}

function normalizeReasoningEffort(value) {
  if (value == null || value === '') return null;
  const v = String(value).trim().toLowerCase();
  if (v === 'max' || v === 'xhigh') return 'max';
  if (v === 'high' || v === 'medium' || v === 'low') return 'high';
  return null;
}

function resolveDeepSeekOptions(config = {}, model) {
  const modelName = String(model || '').trim();
  const legacy = LEGACY_MODEL_OPTIONS[modelName.toLowerCase()] || null;
  const settings = parseSettings(config.settings);
  const nested = settings.deepseek && typeof settings.deepseek === 'object' ? settings.deepseek : {};

  const explicitThinking = normalizeThinking(
    settings.deepseek_thinking
      ?? settings.thinking
      ?? nested.thinking
      ?? nested.type
  );
  const reasoningEffort = normalizeReasoningEffort(
    settings.deepseek_reasoning_effort
      ?? settings.reasoning_effort
      ?? nested.reasoning_effort
      ?? nested.effort
  );

  return {
    model: legacy ? legacy.model : modelName,
    thinking: explicitThinking || legacy?.thinking || null,
    reasoning_effort: reasoningEffort,
  };
}

function applyDeepSeekChatOptions(config, body) {
  if (!isDeepSeekOfficialConfig(config)) return body;

  const opts = resolveDeepSeekOptions(config, body?.model);
  // 仅对 deepseek 系模型附加 thinking/reasoning 参数；同一配置里混用 gpt 等其他模型时保持原样，
  // 避免向不认该参数的模型发送多余字段（第三方中转站会 400）。
  if (!/^deepseek[-_:]?/i.test(String(body?.model || '').trim())) return body;

  const next = {
    ...body,
    model: opts.model || body.model,
  };

  if (opts.thinking) {
    next.thinking = { type: opts.thinking };
  }

  if (opts.thinking === 'enabled') {
    if (opts.reasoning_effort) next.reasoning_effort = opts.reasoning_effort;
    delete next.temperature;
  } else {
    delete next.reasoning_effort;
  }

  return next;
}

function applyDeepSeekConnectivityOptions(config, body) {
  if (!isDeepSeekOfficialConfig(config)) return body;
  const next = applyDeepSeekChatOptions(config, body);
  if (!next.thinking) {
    next.thinking = { type: 'disabled' };
  }
  delete next.reasoning_effort;
  return next;
}

/**
 * 通用「思考强度」透传。
 *
 * 背景：本地 Ollama / 部分 OpenAI 兼容端点用 `reasoning_effort` 控制思考强度，且模型模板
 * 可能把它默认拉满（实测 qwen3.8-27b 模板默认 xhigh）。思考 token **计入 max_tokens**，
 * 于是一个"只想让它写剧本"的请求会把预算全烧在思考上、正文一个字都不出：
 * 实测单集剧本 2000 预算被吃满；抬到 12000 后思考仍用掉 11999 token，正文依旧为 0。
 *
 * 设计：仅当配置**显式**声明 settings.reasoning_effort 时原样透传，
 * 例如 {"reasoning_effort":"none"} 关闭思考（实测同一提示词 378s 失败 → 25.6s 成功）。
 * 默认不生效 —— 既不打扰任何现有配置，也不会给不认该字段的第三方中转站发多余参数（避免 400）。
 *
 * 调用顺序：必须在 applyDeepSeekChatOptions **之后**执行，
 * 因为后者在非 thinking 分支里有 `delete next.reasoning_effort`。
 */
function applyExplicitReasoningEffort(config, body) {
  const raw = parseSettings(config && config.settings).reasoning_effort;
  if (raw == null || raw === '') return body;
  return { ...body, reasoning_effort: String(raw) };
}

module.exports = {
  applyDeepSeekChatOptions,
  applyDeepSeekConnectivityOptions,
  applyExplicitReasoningEffort,
  isDeepSeekOfficialConfig,
  parseSettings,
  resolveDeepSeekOptions,
};
