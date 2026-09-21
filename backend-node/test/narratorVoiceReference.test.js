const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const https = require('node:https');
const Database = require('better-sqlite3');

const aiConfigService = require('../src/services/aiConfigService');
const ttsService = require('../src/services/ttsService');
const videoClient = require('../src/services/videoClient');

/**
 * 「旁白参考音色」(service_type='tts') 回归：
 *
 * 背景 —— 宣传片里没有角色，旁白音色无法通过 characters.seedance2_voice_asset 绑定。
 * videoClient 的回退路径 resolveDefaultNarratorVoiceReferenceUrl 会读一条 service_type='tts'
 * 的配置，用它合成「一句 14 字」的音色样本，作为整个项目旁白的音色参考交给 MiniMax H3。
 *
 * 历史坑：ai_service_configs 表里**从来没有 voice_id / group_id 列**，而 ttsService 与
 * videoClient 一直在读它们（`ttsConfig.voice_id || ttsSettings.voice_id`）——
 * 于是这两个值只能塞进 settings JSON，界面上完全无法配置，旁白音色永远是厂商默认值。
 * 这里锁住「列存在 → rowToConfig 带出 → 真正发到 TTS 请求体里」这条链。
 */

const TTS_COLUMNS = `
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  service_type TEXT, provider TEXT, api_protocol TEXT, name TEXT,
  base_url TEXT, api_key TEXT, model TEXT, default_model TEXT,
  endpoint TEXT, query_endpoint TEXT, priority INTEGER DEFAULT 0,
  is_default INTEGER DEFAULT 0, is_active INTEGER DEFAULT 1, settings TEXT,
  voice_id TEXT, group_id TEXT,
  created_at TEXT, updated_at TEXT, deleted_at TEXT
`;

function createTestDb() {
  const db = new Database(':memory:');
  db.exec(`CREATE TABLE ai_service_configs (${TTS_COLUMNS});`);
  return db;
}

const silentLog = { info() {}, warn() {}, error() {}, debug() {} };

function tmpStorage() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'tts-ref-'));
}

/**
 * 拦截 http/https.request，捕获 TTS 请求的 URL 与 body，并回一个合法响应。
 * MiniMax 走 https（api.minimax.chat），OpenAI 兼容走 base_url 的协议。
 */
function interceptRequest(mod, respond) {
  const orig = mod.request;
  const captured = {};
  mod.request = (first, second, third) => {
    const cb = typeof second === 'function' ? second : third;
    const opts = typeof second === 'function' ? first : second;
    captured.url = typeof first === 'string'
      ? first
      : (first && first.href) || `http://${opts.hostname}:${opts.port}${opts.path}`;
    const handlers = {};
    const reqHandlers = {};
    const res = {
      statusCode: 200,
      on(ev, fn) { handlers[ev] = fn; return res; },
    };
    const req = {
      on(ev, fn) { reqHandlers[ev] = fn; return req; },
      write(b) { captured.body = b; return true; },
      end() {
        setImmediate(() => {
          const payload = respond(captured);
          if (payload !== undefined) handlers.data?.(Buffer.from(JSON.stringify(payload)));
          handlers.end?.();
          // synthesizeWithOpenai 在 req 'close' 上 clearTimeout，不触发就会留下 120s 定时器
          reqHandlers.close?.();
        });
        return req;
      },
      destroy() {},
    };
    setImmediate(() => cb(res));
    return req;
  };
  return { captured, restore() { mod.request = orig; } };
}

function minimaxOk() {
  // MiniMax T2A v2：data.audio 是 hex 字符串
  return { base_resp: { status_code: 0, status_msg: 'success' }, data: { audio: 'fffb90' } };
}

describe('旁白参考音色：voice_id / group_id 走正式列', () => {
  it('createConfig 落库 voice_id / group_id，rowToConfig 带出来', () => {
    const db = createTestDb();
    const cfg = aiConfigService.createConfig(db, silentLog, {
      service_type: 'tts',
      provider: 'minimax',
      name: '旁白参考音色',
      api_key: 'k',
      default_model: 'speech-02-hd',
      voice_id: 'male-qn-qingse',
      group_id: 'G-123',
    });
    assert.equal(cfg.voice_id, 'male-qn-qingse');
    assert.equal(cfg.group_id, 'G-123');
    // listConfigs 也走 rowToConfig —— videoClient 正是靠它取值的
    const listed = aiConfigService.listConfigs(db, 'tts');
    assert.equal(listed.length, 1);
    assert.equal(listed[0].voice_id, 'male-qn-qingse');
    assert.equal(listed[0].group_id, 'G-123');
  });

  it('updateConfig 能改 voice_id，也能清空', () => {
    const db = createTestDb();
    const cfg = aiConfigService.createConfig(db, silentLog, {
      service_type: 'tts', provider: 'minimax', name: 'n', api_key: 'k', voice_id: 'old',
    });
    const updated = aiConfigService.updateConfig(db, silentLog, cfg.id, { voice_id: 'new-voice' });
    assert.equal(updated.voice_id, 'new-voice');
    const cleared = aiConfigService.updateConfig(db, silentLog, cfg.id, { voice_id: '' });
    assert.equal(cleared.voice_id, '');  // 空值归一化成 null，rowToConfig 再转回 ''
  });

  it('MiniMax：voice_id 列优先于 settings.voice_id，并带上 GroupId', async () => {
    const db = createTestDb();
    aiConfigService.createConfig(db, silentLog, {
      service_type: 'tts',
      provider: 'minimax',
      name: 'n',
      api_key: 'k',
      default_model: 'speech-02-hd',
      voice_id: 'male-qn-qingse',                              // 正式列
      group_id: 'G-abc',
      settings: JSON.stringify({ voice_id: 'should-lose' }),   // 旧写法，应被列覆盖
    });
    const ic = interceptRequest(https, minimaxOk);
    try {
      await ttsService.synthesize(db, silentLog, { text: '大家好。', storage_base: tmpStorage() });
    } finally {
      ic.restore();
    }
    const body = JSON.parse(ic.captured.body);
    assert.equal(body.voice_setting.voice_id, 'male-qn-qingse');
    assert.match(ic.captured.url, /GroupId=G-abc/);
  });

  it('OpenAI 兼容：voice_id 列进 body.voice', async () => {
    const db = createTestDb();
    aiConfigService.createConfig(db, silentLog, {
      service_type: 'tts',
      provider: 'openai',
      name: 'n',
      api_key: 'k',
      base_url: 'http://127.0.0.1:9/v1',
      default_model: 'tts-1',
      voice_id: 'nova',
    });
    const ic = interceptRequest(http, () => undefined);  // OpenAI 回的是裸音频，不回 JSON
    try {
      await ttsService.synthesize(db, silentLog, { text: '大家好。', storage_base: tmpStorage() });
    } finally {
      ic.restore();
    }
    const body = JSON.parse(ic.captured.body);
    assert.equal(body.voice, 'nova');
    assert.match(ic.captured.url, /\/v1\/audio\/speech$/);
  });

  it('没有 voice_id 列值时回落 settings.voice_id（向后兼容）', async () => {
    const db = createTestDb();
    aiConfigService.createConfig(db, silentLog, {
      service_type: 'tts',
      provider: 'minimax',
      name: 'n',
      api_key: 'k',
      settings: JSON.stringify({ voice_id: 'from-settings' }),
    });
    const ic = interceptRequest(https, minimaxOk);
    try {
      await ttsService.synthesize(db, silentLog, { text: '大家好。', storage_base: tmpStorage() });
    } finally {
      ic.restore();
    }
    assert.equal(JSON.parse(ic.captured.body).voice_setting.voice_id, 'from-settings');
  });
});

describe('旁白参考音色：MiniMax T2A 地址', () => {
  async function urlFor(db, opts) {
    aiConfigService.createConfig(db, silentLog, {
      service_type: 'tts', provider: 'minimax', name: 'n', api_key: 'sk-api-x', ...opts,
    });
    const ic = interceptRequest(https, minimaxOk);
    try {
      await ttsService.synthesize(db, silentLog, { text: '大家好。', storage_base: tmpStorage() });
    } finally {
      ic.restore();
    }
    return ic.captured.url;
  }

  it('默认走当前官方地址，且不带 GroupId', async () => {
    // 旧代码写死 api.minimax.chat + GroupId=<空>，新版 sk-api- Key 会直接失败
    const url = await urlFor(createTestDb(), {});
    assert.equal(url, 'https://api.minimaxi.com/v1/t2a_v2');
  });

  it('只填域名时自动补 /v1', async () => {
    const url = await urlFor(createTestDb(), { base_url: 'https://api.minimaxi.com' });
    assert.equal(url, 'https://api.minimaxi.com/v1/t2a_v2');
  });

  it('已是 /v1 结尾的 base_url 不重复拼接', async () => {
    const url = await urlFor(createTestDb(), { base_url: 'https://api.minimax.chat/v1' });
    assert.equal(url, 'https://api.minimax.chat/v1/t2a_v2');
  });

  it('填了 GroupId 才拼上（旧账号向后兼容）', async () => {
    const url = await urlFor(createTestDb(), { group_id: 'G-9', base_url: 'https://api.minimax.chat/v1' });
    assert.equal(url, 'https://api.minimax.chat/v1/t2a_v2?GroupId=G-9');
  });

  it('base_url 直接填到 /t2a_v2 也不会拼歪', async () => {
    const url = await urlFor(createTestDb(), { base_url: 'https://api.minimaxi.com/v1/t2a_v2' });
    assert.equal(url, 'https://api.minimaxi.com/v1/t2a_v2');
  });

  it('响应不含 base_resp 时也能取到音频（新版响应形态）', async () => {
    const db = createTestDb();
    aiConfigService.createConfig(db, silentLog, {
      service_type: 'tts', provider: 'minimax', name: 'n', api_key: 'k',
    });
    const storage = tmpStorage();
    const ic = interceptRequest(https, () => ({ data: { audio: 'fffb90', status: 2 } }));
    let res;
    try {
      res = await ttsService.synthesize(db, silentLog, { text: '大家好。', storage_base: storage });
    } finally {
      ic.restore();
    }
    assert.ok(res.local_path);
    assert.ok(fs.existsSync(path.join(storage, res.local_path)));
  });
});

describe('旁白参考音色：无角色时也能拿到音色参考', () => {
  it('resolveDefaultNarratorVoiceReferenceUrl 用 tts 配置合成一句话样本并返回相对路径', async () => {
    const db = createTestDb();
    aiConfigService.createConfig(db, silentLog, {
      service_type: 'tts',
      provider: 'minimax',
      name: '旁白参考音色',
      api_key: 'k',
      default_model: 'speech-02-hd',
      voice_id: 'male-qn-qingse',
      group_id: 'G-1',
      is_default: true,
    });
    const storage = tmpStorage();
    const ic = interceptRequest(https, minimaxOk);
    let rel;
    try {
      rel = await videoClient.resolveDefaultNarratorVoiceReferenceUrl(db, silentLog, storage, 999);
    } finally {
      ic.restore();
    }
    assert.match(rel, /^audio\/tts_sbx_/);
    assert.ok(fs.existsSync(path.join(storage, rel)), '音色样本文件应已落盘');
    // 生成样本用的就是配置里的音色
    assert.equal(JSON.parse(ic.captured.body).voice_setting.voice_id, 'male-qn-qingse');
  });

  it('没有任何 tts 配置时返回空字符串（不抛错，静默降级）', async () => {
    const db = createTestDb();
    const rel = await videoClient.resolveDefaultNarratorVoiceReferenceUrl(db, silentLog, tmpStorage(), 1);
    assert.equal(rel, '');
  });
});
