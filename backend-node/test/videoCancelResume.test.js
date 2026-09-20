const { describe, it, after } = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const Database = require('better-sqlite3');
const comfyuiClient = require('../src/services/comfyuiClient');
const videoClient = require('../src/services/videoClient');
const videoService = require('../src/services/videoService');

const silentLog = { info() {}, warn() {}, error() {}, debug() {} };

/**
 * 假 ComfyUI：记录收到的所有请求，供断言「只续轮询、不重新提交」与「取消打到 /api/jobs/{id}/cancel」。
 */
function startFakeComfy() {
  const seen = [];
  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => {
      seen.push({ method: req.method, url: req.url, body });
      const json = (code, obj) => {
        res.writeHead(code, { 'content-type': 'application/json' });
        res.end(JSON.stringify(obj));
      };
      if (/^\/api\/jobs\/[^/]+\/cancel$/.test(req.url)) {
        return json(200, { cancelled: true, classification: 'running' });
      }
      if (req.url.startsWith('/history/')) {
        const promptId = decodeURIComponent(req.url.slice('/history/'.length));
        return json(200, {
          [promptId]: {
            status: { completed: true, status_str: 'success' },
            outputs: { 92: { gifs: [{ filename: 'MiniMax_H3_00212_.mp4', subfolder: 'video', type: 'output' }] } },
          },
        });
      }
      if (req.url === '/queue') return json(200, { queue_running: [], queue_pending: [] });
      return json(404, {});
    });
  });
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      resolve({ server, seen, baseUrl: `http://127.0.0.1:${server.address().port}` });
    });
  });
}

function createTestDb() {
  const db = new Database(':memory:');
  db.exec(`
    CREATE TABLE async_tasks (
      id TEXT PRIMARY KEY, type TEXT, status TEXT, progress INTEGER DEFAULT 0,
      message TEXT, error TEXT, result TEXT, resource_id TEXT,
      created_at TEXT, updated_at TEXT, completed_at TEXT, deleted_at TEXT
    );
    CREATE TABLE video_generations (
      id INTEGER PRIMARY KEY AUTOINCREMENT, drama_id INTEGER, storyboard_id INTEGER,
      provider TEXT, prompt TEXT, model TEXT, status TEXT, task_id TEXT,
      provider_task_id TEXT, error_msg TEXT, video_url TEXT, local_path TEXT,
      image_gen_id INTEGER, image_url TEXT, aspect_ratio TEXT, resolution TEXT,
      created_at TEXT, updated_at TEXT, completed_at TEXT, deleted_at TEXT
    );
    CREATE TABLE ai_service_configs (
      id INTEGER PRIMARY KEY AUTOINCREMENT, service_type TEXT, provider TEXT,
      api_protocol TEXT, name TEXT, base_url TEXT, api_key TEXT, model TEXT,
      default_model TEXT, endpoint TEXT, query_endpoint TEXT, priority INTEGER DEFAULT 0,
      is_default INTEGER DEFAULT 0, is_active INTEGER DEFAULT 1, settings TEXT,
      created_at TEXT, updated_at TEXT, deleted_at TEXT
    );
  `);
  return db;
}

function seedComfyConfig(db, baseUrl) {
  const now = new Date().toISOString();
  db.prepare(
    `INSERT INTO ai_service_configs
      (service_type, provider, api_protocol, name, base_url, model, is_default, is_active, priority, created_at, updated_at)
     VALUES ('video', 'comfyui', 'comfyui', 'ComfyUI 视频', ?, '[]', 1, 1, 0, ?, ?)`
  ).run(baseUrl, now, now);
}

describe('ComfyUI 续轮询（重启不再判死在跑的任务）', () => {
  const servers = [];
  after(async () => {
    for (const s of servers) await new Promise((r) => s.close(r));
  });

  it('resumeComfyUIVideo 只读 history，不重新提交 /prompt', async () => {
    const fake = await startFakeComfy();
    servers.push(fake.server);
    const promptId = 'df5f6e91-a365-4e5d-aa9d-c7d45a5fb100';

    const r = await comfyuiClient.resumeComfyUIVideo(
      { base_url: fake.baseUrl },
      silentLog,
      { prompt_id: promptId, poll_interval_ms: 20 }
    );

    assert.equal(
      r.video_url,
      `${fake.baseUrl}/view?filename=MiniMax_H3_00212_.mp4&type=output&subfolder=video`
    );
    const submitted = fake.seen.filter((x) => x.method === 'POST' && x.url === '/prompt');
    assert.equal(submitted.length, 0, '恢复轮询绝不能重新提交 workflow');
    assert.equal(fake.seen.filter((x) => x.url === `/history/${promptId}`).length >= 1, true);
  });

  it('pollVideoTask 对 comfyui 协议走 history 续轮询，不落云端查询接口', async () => {
    const fake = await startFakeComfy();
    servers.push(fake.server);
    const db = createTestDb();
    const promptId = 'abc12345-0000-0000-0000-000000000000';

    const r = await videoClient.pollVideoTask(
      db,
      silentLog,
      1,
      promptId,
      { provider: 'comfyui', api_protocol: 'comfyui', base_url: fake.baseUrl },
      3,
      10
    );

    assert.equal(r.error, undefined);
    assert.match(r.video_url, /\/view\?filename=MiniMax_H3_00212_\.mp4/);
    assert.equal(fake.seen.some((x) => x.method === 'POST' && x.url === '/prompt'), false);
  });

  it('缺少 prompt_id 时明确报错，不静默成功', async () => {
    const r = await comfyuiClient.resumeComfyUIVideo({ base_url: 'http://127.0.0.1:1' }, silentLog, { prompt_id: '' });
    assert.match(String(r.error), /prompt_id/);
  });
});

describe('取消任务时真正取消上游 ComfyUI 任务', () => {
  const servers = [];
  after(async () => {
    for (const s of servers) await new Promise((r) => s.close(r));
  });

  it('cancelVideoGenerationByTask：标记本地已取消 + 精准取消上游 prompt', async () => {
    const fake = await startFakeComfy();
    servers.push(fake.server);
    const db = createTestDb();
    seedComfyConfig(db, fake.baseUrl);
    const now = new Date().toISOString();
    const promptId = '11111111-2222-3333-4444-555555555555';
    db.prepare(
      `INSERT INTO video_generations
        (drama_id, storyboard_id, provider, prompt, model, status, task_id, provider_task_id, created_at, updated_at)
       VALUES (9, 1096, 'comfyui', 'p', NULL, 'processing', 'task-uuid-9', ?, ?, ?)`
    ).run(promptId, now, now);
    const row = db.prepare('SELECT * FROM video_generations WHERE task_id = ?').get('task-uuid-9');

    const r = await videoService.cancelVideoGenerationByTask(db, silentLog, 'task-uuid-9', '用户取消生成');

    assert.equal(r.ok, true);
    assert.equal(r.upstream, true);
    const after = db.prepare('SELECT status, error_msg FROM video_generations WHERE id = ?').get(row.id);
    assert.equal(after.status, 'failed');
    assert.equal(after.error_msg, '用户取消生成');
    assert.equal(
      fake.seen.filter((x) => x.method === 'POST' && x.url === `/api/jobs/${promptId}/cancel`).length,
      1
    );
  });

  it('旧记录没有上游任务 ID：仍标记本地已取消，并如实回报未取消上游', async () => {
    const db = createTestDb();
    seedComfyConfig(db, 'http://127.0.0.1:1');
    const now = new Date().toISOString();
    db.prepare(
      `INSERT INTO video_generations
        (drama_id, storyboard_id, provider, prompt, status, task_id, provider_task_id, created_at, updated_at)
       VALUES (9, 1095, 'comfyui', 'p', 'processing', 'task-legacy', NULL, ?, ?)`
    ).run(now, now);

    const r = await videoService.cancelVideoGenerationByTask(db, silentLog, 'task-legacy');
    assert.equal(r.ok, true);
    assert.equal(r.upstream, false);
    const after = db.prepare("SELECT status, error_msg FROM video_generations WHERE task_id = 'task-legacy'").get();
    assert.equal(after.status, 'failed');
    assert.equal(after.error_msg, '用户取消生成');
  });

  it('非视频任务：不误伤（返回 not_video_generation）', async () => {
    const db = createTestDb();
    const r = await videoService.cancelVideoGenerationByTask(db, silentLog, 'not-a-video-task');
    assert.equal(r.ok, false);
    assert.equal(r.reason, 'not_video_generation');
  });
});
