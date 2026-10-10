/**
 * 跨机 ComfyUI 的参考素材传输回归测试。
 *
 * 回归背景（实测）：后端跑在 192.168.1.110，ComfyUI 跑在 192.168.1.200。
 * 旧实现只把参考图写进「后端自己」的 ~/ComfyUI/input/，再把文件名提交给 ComfyUI；
 * ComfyUI 在它的 input 目录里找不到该文件，于是在**校验阶段**就失败：
 *   HTTP 400 prompt_outputs_failed_validation / "image - Invalid image file"
 * 实测证据：.110 的 input 目录里躺着 18 个 ref_*.png（两次尝试 × 6 张），
 * .200 的 input 目录里 0 个；工作流因此从未开始执行。
 *
 * 修法：新增 upload 模式，走 ComfyUI 自带的 POST /upload/image（跨机唯一可行手段）。
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const {
  prepareReferenceImages,
  prepareReferenceAudios,
  uploadFileToComfyUI,
  isLocalComfyHost,
  resolveReferenceTransfer,
} = require('../src/services/comfyuiClient');

/** 1x1 真 PNG，便于断言字节被原样上传 */
const PNG_1PX = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8DwHwAFAAH/q842iQAAAABJRU5ErkJggg==',
  'base64'
);
const DATA_URL = 'data:image/png;base64,' + PNG_1PX.toString('base64');

const silentLog = { info() {}, warn() {}, error() {} };

function tmpInputDir(tag) {
  return path.join(os.tmpdir(), 'lmd-test-input-' + tag + '-' + process.pid + '-' + Date.now());
}

/** 上传模式的临时目录：内部沿用最终文件名，所以断言的是目录本身是否残留 */
function tmpRefDir() {
  return path.join(os.tmpdir(), 'comfyui-ref-' + process.pid);
}

/** 假 ComfyUI：只实现 /upload/image，按真实接口形状返回 {name, subfolder, type} */
async function withFakeComfyUI(fn) {
  const received = [];
  const server = http.createServer((req, res) => {
    if (req.method === 'POST' && req.url === '/upload/image') {
      const chunks = [];
      req.on('data', (c) => chunks.push(c));
      req.on('end', () => {
        const body = Buffer.concat(chunks);
        const m = /filename="([^"]+)"/.exec(body.toString('latin1'));
        received.push({
          filename: m ? m[1] : 'unknown.bin',
          body,
          contentType: req.headers['content-type'] || '',
        });
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ name: m ? m[1] : 'unknown.bin', subfolder: '', type: 'input' }));
      });
      return;
    }
    res.writeHead(404);
    res.end('not found');
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  try {
    return await fn('http://127.0.0.1:' + server.address().port, received);
  } finally {
    server.close();
  }
}

/** 拿一个必定拒连的地址：先监听拿到端口，再关掉 */
async function getClosedBaseUrl() {
  const server = http.createServer(() => {});
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const port = server.address().port;
  await new Promise((r) => server.close(r));
  return 'http://127.0.0.1:' + port;
}

// ---------------------------------------------------------------------------
// 纯函数：本机判定与传输模式
// ---------------------------------------------------------------------------

test('isLocalComfyHost：本机地址为真，局域网/域名/远程为假', () => {
  for (const h of ['http://localhost:8188', 'http://127.0.0.1:8188', 'http://0.0.0.0:8188', 'http://[::1]:8188', 'http://foo.localhost:8188']) {
    assert.equal(isLocalComfyHost(h), true, h);
  }
  assert.equal(isLocalComfyHost('http://192.168.1.200:8188'), false);
  assert.equal(isLocalComfyHost('http://comfyui.lan:8188'), false);
  // 解析不出来时退回「本地」，保证改动前的既有行为不变
  assert.equal(isLocalComfyHost('not-a-url'), true);
  assert.equal(isLocalComfyHost(''), true);
  assert.equal(isLocalComfyHost(undefined), true);
});

test('resolveReferenceTransfer：远程默认 upload，本地默认 filesystem，可显式覆盖', () => {
  assert.equal(resolveReferenceTransfer({ settings: null }, 'http://192.168.1.200:8188'), 'upload');
  assert.equal(resolveReferenceTransfer({ settings: null }, 'http://127.0.0.1:8188'), 'filesystem');
  // 强制覆盖（排查用）
  assert.equal(resolveReferenceTransfer({ settings: JSON.stringify({ reference_transfer: 'filesystem' }) }, 'http://192.168.1.200:8188'), 'filesystem');
  assert.equal(resolveReferenceTransfer({ settings: { reference_transfer: 'upload' } }, 'http://127.0.0.1:8188'), 'upload');
  // 非法值忽略；畸形 JSON 不抛
  assert.equal(resolveReferenceTransfer({ settings: '{not json' }, 'http://192.168.1.200:8188'), 'upload');
  assert.equal(resolveReferenceTransfer({ settings: JSON.stringify({ reference_transfer: 'nope' }) }, 'http://127.0.0.1:8188'), 'filesystem');
  assert.equal(resolveReferenceTransfer(undefined, 'http://192.168.1.200:8188'), 'upload');
});

// ---------------------------------------------------------------------------
// 核心回归：upload 模式
// ---------------------------------------------------------------------------

test('跨机参考图：走 /upload/image 送进 ComfyUI，且不再写本地 input 目录', async () => {
  const inputDir = tmpInputDir('upload');
  await withFakeComfyUI(async (baseUrl, received) => {
    const names = await prepareReferenceImages([DATA_URL], inputDir, silentLog, null, { baseUrl, transfer: 'upload' });

    assert.equal(names.length, 1, '应当返回 1 个已就绪的参考图名');
    assert.match(names[0], /^ref_\d+_0\.png$/);
    assert.equal(received.length, 1, 'ComfyUI 应当收到恰好 1 次上传');
    assert.equal(received[0].filename, names[0], '返回的名字应与上传时的文件名一致');
    assert.match(received[0].contentType, /^multipart\/form-data; boundary=/, '应为 multipart 上传');
    assert.ok(received[0].body.includes(PNG_1PX), 'multipart 体内应含原始 PNG 字节（原样透传）');
  });

  // 关键断言：绝不往本地 input 目录写 —— 那正是跨机时 ComfyUI 看不到的那一份
  assert.equal(fs.existsSync(inputDir), false, 'upload 模式不应创建/写入本地 input 目录');
  // 临时文件必须清理干净
  assert.equal(fs.existsSync(tmpRefDir()), false, '临时目录应被清理干净');
});

test('跨机参考音频：upload 模式同样经 /upload/image 上传（ffmpeg 缺失时不裁剪也要能传）', async () => {
  const inputDir = tmpInputDir('audio');
  const audioDataUrl = 'data:audio/mpeg;base64,' + Buffer.from('ID3-fake-audio-bytes').toString('base64');
  await withFakeComfyUI(async (baseUrl, received) => {
    const names = await prepareReferenceAudios([audioDataUrl], inputDir, silentLog, null, { baseUrl, transfer: 'upload' });
    assert.equal(names.length, 1, '应当返回 1 个已就绪的参考音频名');
    assert.equal(received.length, 1);
    assert.match(received[0].filename, /^ref_audio_\d+_0\.mp3$/);
    assert.ok(received[0].body.includes(Buffer.from('ID3-fake-audio-bytes')));
  });
  assert.equal(fs.existsSync(inputDir), false);
  assert.equal(fs.existsSync(tmpRefDir()), false, '临时目录应被清理干净');
});

// ---------------------------------------------------------------------------
// 回退与向后兼容
// ---------------------------------------------------------------------------

test('上传失败时回退写 input 目录，保证同机/共享文件系统部署仍可用', async () => {
  const inputDir = tmpInputDir('fallback');
  const baseUrl = await getClosedBaseUrl();
  try {
    const names = await prepareReferenceImages([DATA_URL], inputDir, silentLog, null, { baseUrl, transfer: 'upload' });
    assert.equal(names.length, 1, '回退后仍应返回可用文件名');
    const written = path.join(inputDir, names[0]);
    assert.ok(fs.existsSync(written), '回退后文件应落在 input 目录: ' + written);
    assert.deepEqual(fs.readFileSync(written), PNG_1PX, '回退写入的内容应与源一致');
  } finally {
    fs.rmSync(inputDir, { recursive: true, force: true });
  }
});

test('filesystem 模式行为不变：直接写入 input 目录（本地 ComfyUI 路径不受影响）', async () => {
  const inputDir = tmpInputDir('fs');
  fs.mkdirSync(inputDir, { recursive: true });
  try {
    const names = await prepareReferenceImages([DATA_URL], inputDir, silentLog, null, { baseUrl: 'http://192.168.1.200:8188', transfer: 'filesystem' });
    assert.equal(names.length, 1);
    assert.deepEqual(fs.readFileSync(path.join(inputDir, names[0])), PNG_1PX);
  } finally {
    fs.rmSync(inputDir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// uploadFileToComfyUI 自身
// ---------------------------------------------------------------------------

test('uploadFileToComfyUI：带 subfolder 时拼成 "subfolder/name"（LoadImage 认的写法）', async () => {
  const file = path.join(os.tmpdir(), 'lmd-subfolder-' + process.pid + '.png');
  fs.writeFileSync(file, PNG_1PX);
  const server = http.createServer((req, res) => {
    req.resume();
    req.on('end', () => {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ name: 'probe.png', subfolder: 'lmd/sub', type: 'input' }));
    });
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  try {
    const name = await uploadFileToComfyUI('http://127.0.0.1:' + server.address().port, file, silentLog);
    assert.equal(name, 'lmd/sub/probe.png');
  } finally {
    server.close();
    fs.unlinkSync(file);
  }
});

test('uploadFileToComfyUI：非 2xx 与返回异常都抛错（交给上层回退）', async () => {
  const file = path.join(os.tmpdir(), 'lmd-err-' + process.pid + '.png');
  fs.writeFileSync(file, PNG_1PX);
  const mk = (status, payload) => http.createServer((req, res) => {
    req.resume();
    req.on('end', () => { res.writeHead(status, { 'Content-Type': 'application/json' }); res.end(payload); });
  });
  for (const [status, payload, re] of [[400, '{"error":"bad"}', /HTTP 400/], [200, '{"nope":1}', /返回异常/]]) {
    const server = mk(status, payload);
    await new Promise((r) => server.listen(0, '127.0.0.1', r));
    try {
      await assert.rejects(
        () => uploadFileToComfyUI('http://127.0.0.1:' + server.address().port, file, silentLog),
        re
      );
    } finally {
      server.close();
    }
  }
  fs.unlinkSync(file);
});
