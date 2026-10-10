/**
 * 「提交 ComfyUI 前释放 Ollama 显存」的回归测试。
 *
 * 回归背景（实测于 192.168.1.200，双卡 4060Ti 16G + 3060 12G）：
 * Ollama 常驻 qwen3.8-27b 占 21.28 GB，与 ComfyUI 抢同一对显卡，此时 H3 视频的
 * 失败形态是**加载期 OOM**（工作流能提交、参数校验也过，倒在分配显存上）：
 *   H3VM Dev12 PRE-FLIGHT | cuda:0 free=1.65GiB used=13.93GiB
 *   !!! Allocation on device 0 would exceed allowed memory ... Free: 6.12 MiB
 * 同一条工作流在双卡腾空（239/213 MiB）时 352.91 秒正常出片。两者唯一差别就是 Ollama。
 *
 * Ollama 的卸载方式：POST /api/generate {"model": m, "keep_alive": 0}
 * （实测 2ms 返回，显存立刻释放；模型下次被调用时自动重载）。
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');

const {
  freeOllamaVramBeforeSubmit,
  resolveFreeOllamaMode,
} = require('../src/services/comfyuiClient');

const silentLog = { info() {}, warn() {}, error() {} };

/**
 * 假 Ollama：实现 /api/ps 与 /api/generate，记录收到的卸载请求。
 * 返回的 port 通过 settings.ollama_port 注入，避免依赖真实 11434 端口。
 */
async function withFakeOllama({ models = [], psStatus = 200, genStatus = 200, onGenerate = null } = {}, fn) {
  const calls = [];
  const server = http.createServer((req, res) => {
    if (req.method === 'GET' && req.url === '/api/ps') {
      res.writeHead(psStatus, { 'Content-Type': 'application/json' });
      res.end(psStatus === 200 ? JSON.stringify({ models }) : '{"error":"boom"}');
      return;
    }
    if (req.method === 'POST' && req.url === '/api/generate') {
      const chunks = [];
      req.on('data', (c) => chunks.push(c));
      req.on('end', () => {
        let body = null;
        try { body = JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch (_) {}
        calls.push(body);
        if (onGenerate) onGenerate(body);
        res.writeHead(genStatus, { 'Content-Type': 'application/json' });
        res.end(genStatus === 200 ? '{"done":true}' : '{"error":"nope"}');
      });
      return;
    }
    res.writeHead(404);
    res.end('not found');
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const port = server.address().port;
  try {
    return await fn(port, calls);
  } finally {
    server.close();
  }
}

/** 拿一个必定拒连的端口 */
async function getClosedPort() {
  const server = http.createServer(() => {});
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const port = server.address().port;
  await new Promise((r) => server.close(r));
  return port;
}

const COMFY = 'http://127.0.0.1:8188';
const cfg = (settings) => ({ base_url: COMFY, settings: settings === undefined ? null : settings });

// ---------------------------------------------------------------------------
// 策略解析
// ---------------------------------------------------------------------------

test('resolveFreeOllamaMode：默认 auto，布尔与字符串写法都认，畸形 JSON 不抛', () => {
  assert.equal(resolveFreeOllamaMode(cfg(null)), 'auto');
  assert.equal(resolveFreeOllamaMode({}), 'auto');
  assert.equal(resolveFreeOllamaMode(undefined), 'auto');

  assert.equal(resolveFreeOllamaMode(cfg(JSON.stringify({ free_ollama_vram: true }))), 'always');
  assert.equal(resolveFreeOllamaMode(cfg(JSON.stringify({ free_ollama_vram: false }))), 'never');
  assert.equal(resolveFreeOllamaMode(cfg(JSON.stringify({ free_ollama_vram: 'always' }))), 'always');
  assert.equal(resolveFreeOllamaMode(cfg(JSON.stringify({ free_ollama_vram: 'never' }))), 'never');
  assert.equal(resolveFreeOllamaMode(cfg(JSON.stringify({ free_ollama_vram: 'auto' }))), 'auto');
  assert.equal(resolveFreeOllamaMode(cfg({ free_ollama_vram: false })), 'never');

  // 未知值 / 畸形 JSON 一律退回 auto
  assert.equal(resolveFreeOllamaMode(cfg(JSON.stringify({ free_ollama_vram: 'whatever' }))), 'auto');
  assert.equal(resolveFreeOllamaMode(cfg('{not json')), 'auto');
});

// ---------------------------------------------------------------------------
// 卸载行为
// ---------------------------------------------------------------------------

test('发现常驻模型时，对每个模型发一次 keep_alive:0 的卸载请求', async () => {
  const models = [
    { name: 'qwen3.8-27b-uncensored:latest', size_vram: 21.28e9 },
    { name: 'all-minilm:latest', size_vram: 0.05e9 },
  ];
  await withFakeOllama({ models }, async (port, calls) => {
    const r = await freeOllamaVramBeforeSubmit(COMFY, cfg(JSON.stringify({ ollama_port: port })), silentLog);
    assert.equal(calls.length, 2, '每个常驻模型各发一次卸载请求');
    assert.deepEqual(calls.map((c) => c.model).sort(), ['all-minilm:latest', 'qwen3.8-27b-uncensored:latest']);
    for (const c of calls) assert.equal(c.keep_alive, 0, '必须用 keep_alive:0 才会真正卸载');
    assert.equal(r.unloaded, 2);
    assert.equal(r.failed.length, 0);
    assert.ok(Math.abs(r.freedGb - 21.33) < 0.01, '应统计让出的显存 GB 数: ' + r.freedGb);
  });
});

test('没有常驻模型时不发卸载请求', async () => {
  await withFakeOllama({ models: [] }, async (port, calls) => {
    const r = await freeOllamaVramBeforeSubmit(COMFY, cfg(JSON.stringify({ ollama_port: port })), silentLog);
    assert.equal(calls.length, 0);
    assert.equal(r.skipped, 'nothing-loaded');
  });
});

test('never 策略下连探测都不做', async () => {
  await withFakeOllama({ models: [{ name: 'x', size_vram: 1e9 }] }, async (port, calls) => {
    const r = await freeOllamaVramBeforeSubmit(COMFY, cfg(JSON.stringify({ ollama_port: port, free_ollama_vram: 'never' })), silentLog);
    assert.equal(calls.length, 0);
    assert.equal(r.skipped, 'never');
  });
});

// ---------------------------------------------------------------------------
// best-effort：任何故障都不能影响本次生成
// ---------------------------------------------------------------------------

test('同机没有 Ollama（拒连）时静默跳过，不抛错', async () => {
  const port = await getClosedPort();
  const r = await freeOllamaVramBeforeSubmit(COMFY, cfg(JSON.stringify({ ollama_port: port })), silentLog);
  assert.equal(r.skipped, 'no-ollama');
  assert.ok(r.error, '应带上失败原因供排查');
});

test('/api/ps 返回非 2xx 时跳过，不抛错', async () => {
  await withFakeOllama({ psStatus: 500 }, async (port) => {
    const r = await freeOllamaVramBeforeSubmit(COMFY, cfg(JSON.stringify({ ollama_port: port })), silentLog);
    assert.equal(r.skipped, 'no-ollama');
    assert.match(r.error, /HTTP 500/);
  });
});

test('卸载请求失败时记入 failed，仍不抛错（显存可能没让出来，但不拦生成）', async () => {
  const models = [{ name: 'm1', size_vram: 1e9 }, { name: 'm2', size_vram: 1e9 }];
  await withFakeOllama({ models, genStatus: 500 }, async (port) => {
    const r = await freeOllamaVramBeforeSubmit(COMFY, cfg(JSON.stringify({ ollama_port: port })), silentLog);
    assert.equal(r.failed.length, 2);
    assert.equal(r.unloaded, 0);
    assert.match(r.failed[0], /HTTP 500/);
  });
});

test('base_url 非法时直接跳过', async () => {
  const r = await freeOllamaVramBeforeSubmit('not-a-url', cfg(null), silentLog);
  assert.equal(r.skipped, 'bad-base-url');
});

test('地址按 ComfyUI 主机推断：跨机 ComfyUI 会去探那台机器的 Ollama', async () => {
  const closed = await getClosedPort();   // 用确定关闭的端口，避免依赖跑测机器上有没有真 Ollama
  const r = await freeOllamaVramBeforeSubmit('http://127.0.0.1:8199', cfg(JSON.stringify({ ollama_port: closed })), silentLog);
  assert.equal(r.origin, 'http://127.0.0.1:' + closed);
  assert.equal(r.skipped, 'no-ollama');
});
