// OpenAI 官方 gpt-image-2 云端图像通道（协议 openai_image）单元测试
// 用 stub global.fetch 的方式覆盖：URL / body / 头 / 尺寸映射 / 返回值形状 / 错误文案 / multipart。
const { describe, it, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const imageClient = require('../src/services/imageClient');

const silentLog = { info() {}, warn() {}, error() {} };
const recordedWarns = [];
const warnLog = {
  info() {},
  warn(msg, meta) { recordedWarns.push({ msg, meta }); },
  error() {},
};

let recordedCalls = [];
let originalFetch = null;
let stubbed = false;

function installFetch(handler) {
  if (!stubbed) {
    originalFetch = global.fetch;
    stubbed = true;
  }
  recordedCalls = [];
  global.fetch = async (url, options = {}) => {
    recordedCalls.push({ url: String(url), options });
    return handler(String(url), options);
  };
}

function restoreFetch() {
  if (stubbed) {
    global.fetch = originalFetch;
    stubbed = false;
  }
}

/** 最小可用的 Response stub */
function jsonRes(status, obj) {
  const text = typeof obj === 'string' ? obj : JSON.stringify(obj);
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: { get: () => 'application/json' },
    async text() { return text; },
    async json() { return JSON.parse(text); },
    async arrayBuffer() { return Uint8Array.from(Buffer.from(text)).buffer; },
  };
}

const baseConfig = {
  provider: 'openai_image',
  api_protocol: 'openai_image',
  base_url: 'https://api.openai.com/v1',
  api_key: 'sk-test-123',
  model: ['gpt-image-2'],
};

describe('openai_image: inferImageProtocol', () => {
  it('provider openai_image / gpt_image / gpt-image → openai_image', () => {
    assert.equal(imageClient.inferImageProtocol('openai_image', 'gpt-image-2'), 'openai_image');
    assert.equal(imageClient.inferImageProtocol('gpt_image', 'gpt-image-2'), 'openai_image');
    assert.equal(imageClient.inferImageProtocol('gpt-image', 'gpt-image-2'), 'openai_image');
  });

  it('provider=openai + model=gpt-image-2 → openai_image（其它模型不恢复通用云通道）', () => {
    assert.equal(imageClient.inferImageProtocol('openai', 'gpt-image-2'), 'openai_image');
    assert.equal(imageClient.inferImageProtocol('openai', ['gpt-image-2']), 'openai_image');
    assert.equal(imageClient.inferImageProtocol('openai', 'dall-e-3'), 'openai');
    assert.equal(imageClient.inferImageProtocol('openai', 'gpt-image-1'), 'openai');
  });

  it('comfyui 仍归 comfyui', () => {
    assert.equal(imageClient.inferImageProtocol('comfyui', 'anything'), 'comfyui');
    assert.equal(imageClient.inferImageProtocol('comfy', 'anything'), 'comfyui');
  });
});

describe('openai_image: mapOpenAIImageSize 尺寸映射', () => {
  it('项目比例 → OpenAI 支持的尺寸', () => {
    assert.equal(imageClient.mapOpenAIImageSize('9:16'), '1024x1536');
    assert.equal(imageClient.mapOpenAIImageSize('16:9'), '1536x1024');
    assert.equal(imageClient.mapOpenAIImageSize('1:1'), '1024x1024');
  });

  it('显式合法尺寸直接沿用', () => {
    assert.equal(imageClient.mapOpenAIImageSize('1024x1024'), '1024x1024');
    assert.equal(imageClient.mapOpenAIImageSize('1024x1536'), '1024x1536');
    assert.equal(imageClient.mapOpenAIImageSize('1536x1024'), '1536x1024');
    assert.equal(imageClient.mapOpenAIImageSize('1024X1536'), '1024x1536');
  });

  it('其它比例按长边就近；空/无法解析有确定兜底', () => {
    assert.equal(imageClient.mapOpenAIImageSize('3:4'), '1024x1536');
    assert.equal(imageClient.mapOpenAIImageSize('4:3'), '1536x1024');
    assert.equal(imageClient.mapOpenAIImageSize(''), '1024x1024');
    assert.equal(imageClient.mapOpenAIImageSize('weird'), '1536x1024');
  });
});

describe('openai_image: 文生图 POST /images/generations', () => {
  afterEach(() => restoreFetch());

  it('URL / JSON body / Bearer 头 / size 映射都正确', async () => {
    for (const [ratio, expected] of [['9:16', '1024x1536'], ['16:9', '1536x1024'], ['1:1', '1024x1024']]) {
      installFetch(() => jsonRes(200, { data: [{ b64_json: 'QUJD' }] }));
      const res = await imageClient.callOpenAIGptImageApi(baseConfig, silentLog, {
        prompt: '一只猫在窗台上', size: ratio, model: 'gpt-image-2',
      });
      assert.equal(recordedCalls.length, 1);
      const { url, options } = recordedCalls[0];
      assert.equal(url, 'https://api.openai.com/v1/images/generations');
      assert.equal(options.method, 'POST');
      assert.equal(options.headers['Content-Type'], 'application/json');
      assert.equal(options.headers.Authorization, 'Bearer sk-test-123');
      const body = JSON.parse(options.body);
      assert.equal(body.model, 'gpt-image-2');
      assert.equal(body.prompt, '一只猫在窗台上');
      assert.equal(body.size, expected);
      assert.equal(body.n, 1);
      // b64_json → data URL（交给 imageService Step5 落盘，不进数据库）
      assert.ok(res.image_url.startsWith('data:image/png;base64,'));
      assert.equal(res.error, undefined);
    }
  });

  it('base_url 尾斜杠被规范化', async () => {
    installFetch(() => jsonRes(200, { data: [{ b64_json: 'QUJD' }] }));
    await imageClient.callOpenAIGptImageApi(
      { ...baseConfig, base_url: 'https://api.openai.com/v1/' },
      silentLog,
      { prompt: 'x', size: '1:1', model: 'gpt-image-2' }
    );
    assert.equal(recordedCalls[0].url, 'https://api.openai.com/v1/images/generations');
    assert.equal(
      imageClient.resolveOpenAIImageBaseUrl({ base_url: 'https://api.openai.com/v1/images/generations' }),
      'https://api.openai.com/v1'
    );
  });

  it('配置模型不是 gpt-image-2 时被规范化并记 warn', async () => {
    recordedWarns.length = 0;
    installFetch(() => jsonRes(200, { data: [{ b64_json: 'QUJD' }] }));
    await imageClient.callOpenAIGptImageApi(baseConfig, warnLog, {
      prompt: 'x', size: '1:1', model: 'dall-e-3',
    });
    assert.equal(JSON.parse(recordedCalls[0].options.body).model, 'gpt-image-2');
    assert.ok(recordedWarns.some((w) => /规范化/.test(w.msg) && w.meta?.requested === 'dall-e-3'));
  });

  it('返回 url 时原样透传（由 imageService 下载落盘）', async () => {
    installFetch(() => jsonRes(200, { data: [{ url: 'https://oaidalleapiprodscus.blob.core.windows.net/x.png' }] }));
    const res = await imageClient.callOpenAIGptImageApi(baseConfig, silentLog, {
      prompt: 'x', size: '16:9', model: 'gpt-image-2',
    });
    assert.equal(res.image_url, 'https://oaidalleapiprodscus.blob.core.windows.net/x.png');
    assert.equal(res.error, undefined);
  });

  it('响应无法解析时报错并带响应前 300 字', async () => {
    installFetch(() => jsonRes(200, { unexpected: 'nope' }));
    const res = await imageClient.callOpenAIGptImageApi(baseConfig, silentLog, {
      prompt: 'x', size: '1:1', model: 'gpt-image-2',
    });
    assert.ok(res.error.includes('无法解析'));
    assert.ok(res.error.includes('unexpected'));
  });
});

describe('openai_image: 错误文案', () => {
  afterEach(() => restoreFetch());

  it('401 → API Key 无效或无权限', async () => {
    installFetch(() => jsonRes(401, { error: { message: 'Incorrect API key provided' } }));
    const res = await imageClient.callOpenAIGptImageApi(baseConfig, silentLog, {
      prompt: 'x', size: '1:1', model: 'gpt-image-2',
    });
    assert.equal(res.error, 'OpenAI API Key 无效或无权限');
  });

  it('403 → API Key 无效或无权限', async () => {
    installFetch(() => jsonRes(403, { error: { message: 'forbidden' } }));
    const res = await imageClient.callOpenAIGptImageApi(baseConfig, silentLog, {
      prompt: 'x', size: '1:1', model: 'gpt-image-2',
    });
    assert.equal(res.error, 'OpenAI API Key 无效或无权限');
  });

  it('429 → 额度不足/触发限流', async () => {
    installFetch(() => jsonRes(429, { error: { message: 'rate limit' } }));
    const res = await imageClient.callOpenAIGptImageApi(baseConfig, silentLog, {
      prompt: 'x', size: '1:1', model: 'gpt-image-2',
    });
    assert.equal(res.error, '额度不足/触发限流');
  });

  it('400 moderation → 明确指出内容策略拒绝', async () => {
    installFetch(() => jsonRes(400, { error: { message: 'Your request was rejected as a result of our safety system. moderation_blocked' } }));
    const res = await imageClient.callOpenAIGptImageApi(baseConfig, silentLog, {
      prompt: 'x', size: '1:1', model: 'gpt-image-2',
    });
    assert.ok(res.error.includes('内容策略拒绝'));
    assert.ok(/moderation|content policy/i.test(res.error));
  });

  it('网络异常 → 明确指出超时', async () => {
    installFetch(() => { const e = new Error('The operation was aborted'); e.name = 'AbortError'; throw e; });
    const res = await imageClient.callOpenAIGptImageApi(baseConfig, silentLog, {
      prompt: 'x', size: '1:1', model: 'gpt-image-2',
    });
    assert.ok(res.error.includes('超时'));
  });

  it('未配置 API Key → 明确提示', async () => {
    installFetch(() => jsonRes(200, { data: [{ b64_json: 'QUJD' }] }));
    const res = await imageClient.callOpenAIGptImageApi({ ...baseConfig, api_key: '' }, silentLog, {
      prompt: 'x', size: '1:1', model: 'gpt-image-2',
    });
    assert.ok(res.error.includes('API Key'));
    assert.equal(recordedCalls.length, 0);
  });
});

describe('openai_image: 带参考图 → POST /images/edits multipart', () => {
  let tmpDir;
  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gptimg-'));
    fs.mkdirSync(path.join(tmpDir, 'projects', '0001_demo', 'images'), { recursive: true });
    fs.writeFileSync(
      path.join(tmpDir, 'projects', '0001_demo', 'images', 'ig_ref.png'),
      Buffer.from('89504e470d0a1a0a', 'hex')
    );
  });
  afterEach(() => {
    restoreFetch();
    try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch (_) {}
  });

  it('走 /images/edits、body 是 FormData、不手写 JSON Content-Type', async () => {
    installFetch(() => jsonRes(200, { data: [{ b64_json: 'QUJD' }] }));
    const res = await imageClient.callOpenAIGptImageApi(baseConfig, silentLog, {
      prompt: '同一角色的分镜图',
      size: '9:16',
      model: 'gpt-image-2',
      storage_local_path: tmpDir,
      reference_image_urls: ['/static/projects/0001_demo/images/ig_ref.png'],
    });

    assert.equal(recordedCalls.length, 1, '本机参考图不应再产生额外下载请求');
    const { url, options } = recordedCalls[0];
    assert.equal(url, 'https://api.openai.com/v1/images/edits');
    assert.equal(options.method, 'POST');
    assert.ok(options.body instanceof FormData, 'body 必须是 FormData 实例');
    assert.notEqual(options.headers['Content-Type'], 'application/json');
    assert.equal(options.headers['Content-Type'], undefined, 'multipart 的 Content-Type 必须交给 FormData 生成 boundary');
    assert.equal(options.headers.Authorization, 'Bearer sk-test-123');
    assert.equal(options.body.get('model'), 'gpt-image-2');
    assert.equal(options.body.get('prompt'), '同一角色的分镜图');
    assert.equal(options.body.get('size'), '1024x1536');
    assert.equal(options.body.getAll('image[]').length, 1);
    assert.ok(res.image_url.startsWith('data:image/png;base64,'));
  });

  it('本地文件读不到时跳过该张；全部不可用则明确报错且不发请求', async () => {
    recordedWarns.length = 0;
    installFetch(() => jsonRes(200, { data: [{ b64_json: 'QUJD' }] }));
    const res = await imageClient.callOpenAIGptImageApi(baseConfig, warnLog, {
      prompt: 'x',
      size: '1:1',
      model: 'gpt-image-2',
      storage_local_path: tmpDir,
      reference_image_urls: ['/static/projects/0001_demo/images/missing.png'],
    });
    assert.equal(recordedCalls.length, 0);
    assert.ok(res.error.includes('参考图全部不可用'));
    assert.ok(recordedWarns.some((w) => /读不到/.test(w.msg)));
  });
});

// ── 按中转文档（aicost.me/api-docs）对齐的三项 ────────────────────────────────
describe('对齐中转文档：必填字段 / 异步任务轮询 / image[] 回落', () => {
  const base = { base_url: 'https://relay.example.com', api_key: 'sk-test', endpoint: '' };

  it('文生图 body 带 quality=auto / output_format=png / moderation=auto', async () => {
    installFetch(() => new Response(JSON.stringify({ data: [{ b64_json: 'AAAA' }] }), { status: 200 }));
    const r = await imageClient.callOpenAIGptImageApi(base, silentLog, { prompt: 'x', size: '1024x1024' });
    const body = JSON.parse(recordedCalls[0].options.body);
    assert.equal(body.quality, 'auto');
    assert.equal(body.output_format, 'png');
    assert.equal(body.moderation, 'auto');
    assert.equal(body.n, 1);
    assert.ok(r.image_url.startsWith('data:image/png;base64,'));
  });

  it('带参考图时 multipart 也带这些字段与 n="1"、字段名为 image[]', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'oai-'));
    const p = path.join(dir, 'ref.png');
    fs.writeFileSync(p, Buffer.from([0x89, 0x50, 0x4e, 0x47]));
    installFetch(() => new Response(JSON.stringify({ data: [{ b64_json: 'AAAA' }] }), { status: 200 }));
    await imageClient.callOpenAIGptImageApi(base, silentLog, {
      prompt: 'x', size: '1024x1024', reference_image_urls: ['ref.png'], storage_local_path: dir,
    });
    const fd = recordedCalls[0].options.body;
    assert.ok(fd instanceof FormData);
    assert.equal(fd.get('quality'), 'auto');
    assert.equal(fd.get('output_format'), 'png');
    assert.equal(fd.get('moderation'), 'auto');
    assert.equal(fd.get('n'), '1');
    assert.ok(fd.getAll('image[]').length === 1, '应使用 image[] 字段名');
  });

  it('返回异步任务 {task_id,status:pending} 时会轮询查询接口直到拿到图片', async () => {
    let polled = 0;
    installFetch((url) => {
      if (url.includes('/images/generations/task_abc')) {
        polled += 1;
        if (polled < 2) return new Response(JSON.stringify({ status: 'processing' }), { status: 200 });
        return new Response(JSON.stringify({ data: [{ b64_json: 'BBBB' }] }), { status: 200 });
      }
      return new Response(JSON.stringify({ task_id: 'task_abc', status: 'pending' }), { status: 200 });
    });
    const r = await imageClient.callOpenAIGptImageApi(base, silentLog, { prompt: 'x', size: '1024x1024' });
    assert.equal(polled, 2, '应轮询两次才拿到结果');
    assert.ok(r.image_url.startsWith('data:image/png;base64,'));
    assert.ok(recordedCalls.some((c) => c.url.includes('/images/generations/task_abc')));
  });

  it('image[] 被拒（400 提及 image）时用单数 image 重试一次并成功', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'oai-'));
    fs.writeFileSync(path.join(dir, 'ref.png'), Buffer.from([0x89, 0x50, 0x4e, 0x47]));
    let n = 0;
    installFetch(() => {
      n += 1;
      if (n === 1) {
        return new Response(JSON.stringify({ error: { message: 'image[] is not supported, use image' } }), { status: 400 });
      }
      return new Response(JSON.stringify({ data: [{ b64_json: 'CCCC' }] }), { status: 200 });
    });
    const r = await imageClient.callOpenAIGptImageApi(base, silentLog, {
      prompt: 'x', size: '1024x1024', reference_image_urls: ['ref.png'], storage_local_path: dir,
    });
    assert.equal(n, 2, '应重试一次');
    const second = recordedCalls[1].options.body;
    assert.equal(second.getAll('image[]').length, 0);
    assert.equal(second.getAll('image').length, 1, '第二次应改用单数 image');
    assert.ok(r.image_url.startsWith('data:image/png;base64,'));
  });
});
