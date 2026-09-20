const { describe, it, after } = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const Database = require('better-sqlite3');
const videoClient = require('../src/services/videoClient');

/**
 * 云端 MiniMax H3 取消（官方 DELETE /v2/video_generation/{task_id}）：
 *   - 排队中（queued）→ 能取消
 *   - 运行中（running）→ 官方不允许，必须如实回报失败，不能假装成功
 * 文档：platform.minimax.cn/docs/api-reference/video-generation-v2-delete
 */
const silentLog = { info() {}, warn() {}, error() {} };

function startFakeMinimax() {
  const seen = [];
  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => {
      seen.push({ method: req.method, url: req.url, auth: req.headers.authorization || '' });
      const json = (code, obj) => {
        res.writeHead(code, { 'content-type': 'application/json' });
        res.end(JSON.stringify(obj));
      };
      const m = req.url.match(/^\/v2\/video_generation\/(.+)$/);
      if (req.method === 'DELETE' && m) {
        const id = decodeURIComponent(m[1]);
        if (id === 'running-task') {
          return json(400, { error: { message: 'task is running, cannot be cancelled' } });
        }
        return json(200, { task_id: id, action: 'cancelled' });
      }
      return json(404, { error: { message: 'not found' } });
    });
  });
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () =>
      resolve({ server, seen, baseUrl: `http://127.0.0.1:${server.address().port}` })
    );
  });
}

function createTestDb() {
  const db = new Database(':memory:');
  db.exec(`
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

function seedCloudConfig(db, baseUrl) {
  const now = new Date().toISOString();
  db.prepare(
    `INSERT INTO ai_service_configs
       (service_type, provider, api_protocol, name, base_url, api_key, model, default_model,
        endpoint, query_endpoint, is_default, is_active, created_at, updated_at)
     VALUES ('video', 'minimax', 'minimax_h3', 'MiniMax 视频', ?, 'sk-test', '["MiniMax-H3"]', 'MiniMax-H3',
             '/v2/video_generation', '/v2/query/video_generation/{taskId}', 1, 1, ?, ?)`
  ).run(baseUrl, now, now);
}

describe('云端 MiniMax H3 取消任务', () => {
  const servers = [];
  after(async () => {
    for (const s of servers) await new Promise((r) => s.close(r));
  });

  it('排队中的任务：DELETE /v2/video_generation/{id} 且带 Bearer', async () => {
    const fake = await startFakeMinimax();
    servers.push(fake.server);

    const r = await videoClient.cancelMinimaxH3Job(
      { base_url: fake.baseUrl, api_key: 'sk-abc' },
      silentLog,
      'queued-task-1'
    );

    assert.equal(r.ok, true);
    assert.equal(fake.seen.length, 1);
    assert.equal(fake.seen[0].method, 'DELETE');
    assert.equal(fake.seen[0].url, '/v2/video_generation/queued-task-1');
    assert.equal(fake.seen[0].auth, 'Bearer sk-abc');
  });

  it('运行中的任务：官方拒绝 → 如实回报失败（不假装成功）', async () => {
    const fake = await startFakeMinimax();
    servers.push(fake.server);

    const r = await videoClient.cancelMinimaxH3Job(
      { base_url: fake.baseUrl, api_key: 'sk-abc' },
      silentLog,
      'running-task'
    );

    assert.equal(r.ok, false);
    assert.match(String(r.error), /running/i);
  });

  it('缺少 task_id 时不发请求', async () => {
    const r = await videoClient.cancelMinimaxH3Job({ base_url: 'http://127.0.0.1:1' }, silentLog, '');
    assert.equal(r.ok, false);
    assert.match(String(r.error), /task_id/);
  });

  it('cancelUpstreamVideoTask 按协议路由到云端（而不是只标记本地）', async () => {
    const fake = await startFakeMinimax();
    servers.push(fake.server);
    const db = createTestDb();
    seedCloudConfig(db, fake.baseUrl);

    const r = await videoClient.cancelUpstreamVideoTask(db, silentLog, {
      id: 1,
      provider: 'minimax',
      model: 'MiniMax-H3',
      provider_task_id: 'queued-task-2',
    });

    assert.equal(r.ok, true);
    assert.equal(fake.seen[0].url, '/v2/video_generation/queued-task-2');
    assert.equal(fake.seen[0].method, 'DELETE');
  });

  it('官方基址末尾带 /v2 时也能拼对地址', async () => {
    const fake = await startFakeMinimax();
    servers.push(fake.server);
    const r = await videoClient.cancelMinimaxH3Job(
      { base_url: fake.baseUrl + '/v2', api_key: 'sk-abc' },
      silentLog,
      'queued-task-3'
    );
    assert.equal(r.ok, true);
    assert.equal(fake.seen[0].url, '/v2/video_generation/queued-task-3');
  });
});
