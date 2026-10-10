const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');

const {
  applyDeepSeekChatOptions,
  applyExplicitReasoningEffort,
  isDeepSeekOfficialConfig,
} = require('../src/services/deepseekConfig');

const { postJSONStream } = require('../src/services/aiClient');

function baseBody(model) {
  return {
    model,
    messages: [{ role: 'user', content: 'Hello' }],
    temperature: 0.7,
    max_tokens: 5,
  };
}

/** 复刻线上那台本地 Ollama：provider=openai，base_url 指向局域网，模型名不是 deepseek 系 */
function ollamaConfig(settings) {
  return {
    provider: 'openai',
    api_protocol: 'openai',
    base_url: 'http://192.168.1.200:11434/v1',
    settings: settings === undefined ? null : settings,
  };
}

const LOCAL_MODEL = 'qwen3.8-27b-uncensored:latest';

test('detects official DeepSeek configs by provider or base URL', () => {
  assert.equal(isDeepSeekOfficialConfig({ provider: 'deepseek' }), true);
  assert.equal(isDeepSeekOfficialConfig({ base_url: 'https://api.deepseek.com' }), true);
  assert.equal(isDeepSeekOfficialConfig({ provider: 'xy', base_url: 'https://api.302.ai/v1' }), false);
});

test('maps deprecated deepseek-chat to deepseek-v4-flash non-thinking mode', () => {
  const body = applyDeepSeekChatOptions(
    { provider: 'deepseek', base_url: 'https://api.deepseek.com' },
    baseBody('deepseek-chat')
  );

  assert.equal(body.model, 'deepseek-v4-flash');
  assert.deepEqual(body.thinking, { type: 'disabled' });
  assert.equal(body.reasoning_effort, undefined);
  assert.equal(body.temperature, 0.7);
});

test('maps deprecated deepseek-reasoner to deepseek-v4-flash thinking mode', () => {
  const body = applyDeepSeekChatOptions(
    { provider: 'deepseek', base_url: 'https://api.deepseek.com' },
    baseBody('deepseek-reasoner')
  );

  assert.equal(body.model, 'deepseek-v4-flash');
  assert.deepEqual(body.thinking, { type: 'enabled' });
  assert.equal(body.temperature, undefined);
});

test('applies explicit DeepSeek thinking settings for V4 models', () => {
  const body = applyDeepSeekChatOptions(
    {
      provider: 'deepseek',
      base_url: 'https://api.deepseek.com',
      settings: JSON.stringify({
        deepseek_thinking: 'enabled',
        deepseek_reasoning_effort: 'max',
      }),
    },
    baseBody('deepseek-v4-pro')
  );

  assert.equal(body.model, 'deepseek-v4-pro');
  assert.deepEqual(body.thinking, { type: 'enabled' });
  assert.equal(body.reasoning_effort, 'max');
  assert.equal(body.temperature, undefined);
});

// ---------------------------------------------------------------------------
// 本地 Ollama / OpenAI 兼容端点的「思考强度」透传
//
// 回归背景（实测于 192.168.1.200:11434 的 qwen3.8-27b-uncensored）：
// 模板默认 reasoning_effort=xhigh，思考 token 计入 max_tokens，导致
//   单集剧本 2000 预算 → 正文 0 字（85s 失败）
//   抬到 12000 预算  → 思考仍用掉 11999 token，正文依旧 0 字（378s 失败）
//   显式 reasoning_effort="none" → 正文 730 字（25.6s 成功）
// ---------------------------------------------------------------------------

test('本地 Ollama：未显式声明时不注入任何思考参数（不打扰现有配置、不给中转站发多余字段）', () => {
  const cfg = ollamaConfig(null);
  const body = applyDeepSeekChatOptions(cfg, baseBody(LOCAL_MODEL));
  assert.equal(body.reasoning_effort, undefined);
  assert.equal(body.thinking, undefined);

  // 透传函数也必须保持沉默
  const after = applyExplicitReasoningEffort(cfg, body);
  assert.equal(after.reasoning_effort, undefined);
  assert.deepEqual(after, body);
});

test('本地 Ollama：显式 reasoning_effort=none 被透传，且不夹带 deepseek 专有参数', () => {
  const cfg = ollamaConfig(JSON.stringify({ reasoning_effort: 'none' }));
  let body = applyDeepSeekChatOptions(cfg, baseBody(LOCAL_MODEL));
  body = applyExplicitReasoningEffort(cfg, body);

  assert.equal(body.reasoning_effort, 'none');
  // 关键：模型名不是 deepseek 系，绝不能塞 thinking 字段（Ollama 不认，中转站会 400）
  assert.equal(body.thinking, undefined);
  // 也不该像 deepseek thinking 分支那样删掉 temperature
  assert.equal(body.temperature, 0.7);
  assert.equal(body.model, LOCAL_MODEL);
});

test('透传顺序不可颠倒：必须先 applyDeepSeekChatOptions 再透传，否则被它的 delete 抹掉', () => {
  const cfg = {
    provider: 'deepseek',
    base_url: 'https://api.deepseek.com',
    settings: JSON.stringify({ deepseek_thinking: 'disabled', reasoning_effort: 'none' }),
  };
  const input = baseBody('deepseek-v4-pro');

  // 线上顺序：先 deepseek 处理，再透传 → 保留
  const correct = applyExplicitReasoningEffort(cfg, applyDeepSeekChatOptions(cfg, { ...input }));
  assert.equal(correct.reasoning_effort, 'none');

  // 颠倒顺序 → 被 applyDeepSeekChatOptions 的 `delete next.reasoning_effort` 抹掉
  const reversed = applyDeepSeekChatOptions(cfg, applyExplicitReasoningEffort(cfg, { ...input }));
  assert.equal(reversed.reasoning_effort, undefined);
});

test('reasoning_effort 的取值边界：缺失/空串/null/畸形 JSON 均不注入，对象形式可用', () => {
  const body = () => baseBody(LOCAL_MODEL);
  assert.equal(applyExplicitReasoningEffort(ollamaConfig(undefined), body()).reasoning_effort, undefined);
  assert.equal(applyExplicitReasoningEffort(ollamaConfig(''), body()).reasoning_effort, undefined);
  assert.equal(applyExplicitReasoningEffort(ollamaConfig(JSON.stringify({ reasoning_effort: '' })), body()).reasoning_effort, undefined);
  assert.equal(applyExplicitReasoningEffort(ollamaConfig(JSON.stringify({ reasoning_effort: null })), body()).reasoning_effort, undefined);
  assert.equal(applyExplicitReasoningEffort(ollamaConfig(JSON.stringify({})), body()).reasoning_effort, undefined);
  assert.equal(applyExplicitReasoningEffort({ provider: 'openai' }, body()).reasoning_effort, undefined);
  // 畸形 JSON 不能抛
  assert.equal(applyExplicitReasoningEffort(ollamaConfig('{not json'), body()).reasoning_effort, undefined);
  // settings 直接是对象（DB 里存对象而非字符串）也要能用
  assert.equal(applyExplicitReasoningEffort({ provider: 'openai', settings: { reasoning_effort: 'none' } }, body()).reasoning_effort, 'none');
  // 非字符串值安全字符串化
  assert.equal(applyExplicitReasoningEffort(ollamaConfig(JSON.stringify({ reasoning_effort: 'low' })), body()).reasoning_effort, 'low');
});

// ---------------------------------------------------------------------------
// SSE 解析：思考内容字段名兼容
// Ollama 的 OpenAI 兼容层在流式下用 delta.reasoning（不是 reasoning_content）。
// 原先只读 reasoning_content，导致 reasoningChars 恒为 0 —— 空返回时报错丢失关键诊断线索。
// ---------------------------------------------------------------------------

/** 起一个回放固定 SSE 事件序列的假服务，回调拿到 url 后自行调用被测函数 */
async function withFakeSSE(events, fn) {
  const server = http.createServer((req, res) => {
    res.writeHead(200, { 'Content-Type': 'text/event-stream' });
    for (const e of events) res.write('data: ' + JSON.stringify(e) + '\n\n');
    res.write('data: [DONE]\n\n');
    res.end();
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port;
  try {
    return await fn('http://127.0.0.1:' + port + '/v1/chat/completions');
  } finally {
    server.close();
  }
}

function streamOnce(events) {
  let lastReasoning = null;
  return withFakeSSE(events, (url) =>
    postJSONStream(url, {}, { model: 'm', messages: [] }, 5000,
      (receivedLen, event, accumulated, reasoningChars) => {
        if (typeof reasoningChars === 'number') lastReasoning = reasoningChars;
      }
    ).then((res) => ({ res, getReasoning: () => lastReasoning }))
  );
}

test('SSE 解析：Ollama 的 delta.reasoning 被计入思考字数（原先恒为 0）', async () => {
  const { res, getReasoning } = await streamOnce([
    { choices: [{ delta: { content: '', reasoning: '思考一' }, finish_reason: null }] },
    { choices: [{ delta: { content: '', reasoning: '思考二' }, finish_reason: null }] },
    { choices: [{ delta: { content: '' }, finish_reason: 'length' }] },
  ]);
  assert.equal(res.body, '', '正文应为空 —— 正是思考吃满预算时的真实形状');
  assert.equal(getReasoning(), 6, '「思考一」+「思考二」= 6 字必须被统计');
});

test('SSE 解析：reasoning_content 仍然兼容，且思考内容不混入正文', async () => {
  const { res, getReasoning } = await streamOnce([
    { choices: [{ delta: { reasoning_content: '想一想' }, finish_reason: null }] },
    { choices: [{ delta: { content: '正文' }, finish_reason: null }] },
    { choices: [{ delta: { content: '来了' }, finish_reason: 'stop' }] },
  ]);
  assert.equal(res.body, '正文来了');
  assert.equal(getReasoning(), 3);
});
