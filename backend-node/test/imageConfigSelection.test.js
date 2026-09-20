const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const Database = require('better-sqlite3');
const imageClient = require('../src/services/imageClient');
const aiConfigService = require('../src/services/aiConfigService');

/**
 * 图片 / 分镜图 AI 配置选择规则（回归）：
 *  - 分镜图通道 = storyboard_image 类型 ∪ image 类型
 *  - 只有 storyboard_image 配置「显式设为默认」时才由它负责分镜图，否则沿用 image 类型的默认（本地 ComfyUI）
 *  - 分镜图配置被停用/缺失时回落到 image 配置，而不是报「未配置图片模型」
 * 历史坑：只要存在任意一条 storyboard_image 配置就不再回落到 image，
 *        新加一条云端分镜配置会无声顶掉本地 ComfyUI。
 */
function createTestDb() {
  const db = new Database(':memory:');
  db.exec(`
    CREATE TABLE ai_service_configs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      service_type TEXT, provider TEXT, api_protocol TEXT, name TEXT,
      base_url TEXT, api_key TEXT, model TEXT, default_model TEXT,
      endpoint TEXT, query_endpoint TEXT, priority INTEGER DEFAULT 0,
      is_default INTEGER DEFAULT 0, is_active INTEGER DEFAULT 1, settings TEXT,
      created_at TEXT, updated_at TEXT, deleted_at TEXT
    );
  `);
  return db;
}

function addConfig(db, { serviceType, provider, apiProtocol, model = '[]', isDefault = 0, isActive = 1, updatedAt = '2026-09-20T00:00:00.000Z' }) {
  const info = db.prepare(
    `INSERT INTO ai_service_configs
      (service_type, provider, api_protocol, name, base_url, api_key, model, default_model,
       endpoint, query_endpoint, priority, is_default, is_active, settings, created_at, updated_at)
     VALUES (?, ?, ?, ?, 'http://x', '', ?, NULL, '', '', 0, ?, ?, NULL, ?, ?)`
  ).run(serviceType, provider, apiProtocol, `${serviceType}-${provider}`, model, isDefault, isActive, updatedAt, updatedAt);
  return Number(info.lastInsertRowid);
}

const pick = (db, model, serviceType) => imageClient.getDefaultImageConfig(db, model, null, serviceType);

describe('分镜图 / 图片 AI 配置选择', () => {
  it('只有 storyboard_image 配置（朋友的无显卡机器）：分镜图与图片都用它', () => {
    const db = createTestDb();
    const id = addConfig(db, { serviceType: 'storyboard_image', provider: 'openai', apiProtocol: 'openai_image', model: '["gpt-image-2"]', isDefault: 1 });
    assert.equal(pick(db, null, 'storyboard_image').id, id);
    // 没有 image 类型配置时分镜配置不该被忽略
    assert.equal(pick(db, 'gpt-image-2', 'storyboard_image').id, id);
  });

  it('image 默认 + 存在非默认的分镜配置：本地 ComfyUI 仍负责分镜图', () => {
    const db = createTestDb();
    const comfy = addConfig(db, { serviceType: 'image', provider: 'comfyui', apiProtocol: 'comfyui', isDefault: 1 });
    addConfig(db, { serviceType: 'storyboard_image', provider: 'openai', apiProtocol: 'openai_image', model: '["gpt-image-2"]', isDefault: 0 });
    assert.equal(pick(db, null, 'storyboard_image').id, comfy);
  });

  it('分镜配置显式设为默认：由它负责分镜图', () => {
    const db = createTestDb();
    addConfig(db, { serviceType: 'image', provider: 'comfyui', apiProtocol: 'comfyui', isDefault: 1 });
    const sb = addConfig(db, { serviceType: 'storyboard_image', provider: 'openai', apiProtocol: 'openai_image', model: '["gpt-image-2"]', isDefault: 1 });
    assert.equal(pick(db, null, 'storyboard_image').id, sb);
  });

  it('分镜配置被停用：回落到 image 配置，不返回 null', () => {
    const db = createTestDb();
    const comfy = addConfig(db, { serviceType: 'image', provider: 'comfyui', apiProtocol: 'comfyui', isDefault: 1 });
    addConfig(db, { serviceType: 'storyboard_image', provider: 'openai', apiProtocol: 'openai_image', model: '["gpt-image-2"]', isDefault: 1, isActive: 0 });
    assert.equal(pick(db, null, 'storyboard_image').id, comfy);
  });

  it('指定模型时按模型命中配置（分镜图可选 gpt-image-2）', () => {
    const db = createTestDb();
    addConfig(db, { serviceType: 'image', provider: 'comfyui', apiProtocol: 'comfyui', model: '[]', isDefault: 1 });
    const sb = addConfig(db, { serviceType: 'storyboard_image', provider: 'openai', apiProtocol: 'openai_image', model: '["gpt-image-2"]', isDefault: 0 });
    assert.equal(pick(db, 'gpt-image-2', 'storyboard_image').id, sb);
  });
});

describe('同类型多个默认：保留最近设置的那条', () => {
  it('不再按 id 保留最老的一条（会把用户刚点选的默认悄悄改回去）', () => {
    const db = createTestDb();
    const oldOne = addConfig(db, { serviceType: 'image', provider: 'comfyui', apiProtocol: 'comfyui', isDefault: 1, updatedAt: '2026-09-12T11:52:34.759Z' });
    const newOne = addConfig(db, { serviceType: 'image', provider: 'openai', apiProtocol: 'openai_image', model: '["gpt-image-2"]', isDefault: 1, updatedAt: '2026-09-20T13:15:05.578Z' });

    aiConfigService.listConfigs(db, 'image');

    const kept = db.prepare('SELECT id FROM ai_service_configs WHERE is_default = 1 AND service_type = ?').all('image');
    assert.deepEqual(kept.map((r) => r.id), [newOne]);
    assert.equal(db.prepare('SELECT is_default FROM ai_service_configs WHERE id = ?').get(oldOne).is_default, 0);
  });
});

describe('厂商偏好（config.yaml 的 ai.default_image_provider）不能顶掉显式默认', () => {
  it('默认是本地 ComfyUI 时，即使传入 preferred_provider=openai 也走 ComfyUI', () => {
    const db = createTestDb();
    const comfy = addConfig(db, { serviceType: 'image', provider: 'comfyui', apiProtocol: 'comfyui', isDefault: 1 });
    addConfig(db, { serviceType: 'image', provider: 'openai', apiProtocol: 'openai_image', model: '["gpt-image-2"]', isDefault: 0 });
    // 道具图生成正是这样调用的（model 为空 → 用 YAML 的 default_image_provider 兜底）
    assert.equal(imageClient.getDefaultImageConfig(db, null, 'openai', 'image').id, comfy);
  });

  it('没有任何默认时，厂商偏好兜底仍然生效', () => {
    const db = createTestDb();
    addConfig(db, { serviceType: 'image', provider: 'comfyui', apiProtocol: 'comfyui', isDefault: 0 });
    const openai = addConfig(db, { serviceType: 'image', provider: 'openai', apiProtocol: 'openai_image', model: '["gpt-image-2"]', isDefault: 0 });
    assert.equal(imageClient.getDefaultImageConfig(db, null, 'openai', 'image').id, openai);
  });

  it('显式指定模型时仍然优先于默认（用户就是要这个模型）', () => {
    const db = createTestDb();
    addConfig(db, { serviceType: 'image', provider: 'comfyui', apiProtocol: 'comfyui', isDefault: 1 });
    const openai = addConfig(db, { serviceType: 'image', provider: 'openai', apiProtocol: 'openai_image', model: '["gpt-image-2"]', isDefault: 0 });
    assert.equal(imageClient.getDefaultImageConfig(db, 'gpt-image-2', null, 'image').id, openai);
  });

  it('把云端设为默认时，厂商偏好不会把它换回本地', () => {
    const db = createTestDb();
    addConfig(db, { serviceType: 'image', provider: 'comfyui', apiProtocol: 'comfyui', isDefault: 0 });
    const openai = addConfig(db, { serviceType: 'image', provider: 'openai', apiProtocol: 'openai_image', model: '["gpt-image-2"]', isDefault: 1 });
    assert.equal(imageClient.getDefaultImageConfig(db, null, 'comfyui', 'image').id, openai);
  });
});
