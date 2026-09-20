const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const Database = require('better-sqlite3');
const sceneService = require('../src/services/sceneService');
const { buildExistingScenesHint } = require('../src/services/backgroundExtractionService');

/**
 * 跨集场景复用：
 *  - scenes 仍是「每集一行」，但新建本集场景时会继承本剧更早剧集里同一地点的
 *    提示词与图片资产（不重新生图）；
 *  - 提取提示词里附上本剧已有场景清单，避免同一地点被写成「河边 / 河边不远处」两个名字。
 */
function createTestDb() {
  const db = new Database(':memory:');
  db.exec(`
    CREATE TABLE scenes (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      drama_id INTEGER, episode_id INTEGER, location TEXT, time TEXT,
      prompt TEXT, image_url TEXT, local_path TEXT, storyboard_count INTEGER DEFAULT 0,
      status TEXT, created_at TEXT, updated_at TEXT, deleted_at TEXT,
      negative_prompt TEXT, polished_prompt TEXT, polished_prompt_single TEXT,
      extra_images TEXT, ref_image TEXT
    );
  `);
  return db;
}

const silentLog = { info() {}, warn() {}, error() {} };

function addScene(db, { dramaId = 9, episodeId = 24, location, time = '日 内', prompt = 'p', imageUrl = null, localPath = null, polished = null, refImage = null, deletedAt = null }) {
  const now = '2026-09-20T00:00:00.000Z';
  const info = db.prepare(
    `INSERT INTO scenes (drama_id, episode_id, location, time, prompt, image_url, local_path,
       storyboard_count, status, created_at, updated_at, deleted_at, polished_prompt, ref_image)
     VALUES (?, ?, ?, ?, ?, ?, ?, 1, 'pending', ?, ?, ?, ?, ?)`
  ).run(dramaId, episodeId, location, time, prompt, imageUrl, localPath, now, now, deletedAt, polished, refImage);
  return Number(info.lastInsertRowid);
}

describe('sceneService.findReusableScene（跨集找同一地点）', () => {
  it('命中更早剧集里同一地点的场景', () => {
    const db = createTestDb();
    const first = addScene(db, { episodeId: 24, location: '吴家', imageUrl: 'http://x/wu.png' });
    assert.equal(sceneService.findReusableScene(db, 9, { location: '吴家', time: '日 内', excludeEpisodeId: 28 }).id, first);
  });

  it('归一化后认为同一地点（括号补充、空格、大小写）', () => {
    const db = createTestDb();
    const first = addScene(db, { episodeId: 24, location: '吴家（客厅）', imageUrl: 'http://x/wu.png' });
    assert.equal(sceneService.findReusableScene(db, 9, { location: ' 吴家 ', time: '日 内', excludeEpisodeId: 28 }).id, first);
  });

  it('同地点多个候选：优先时间一致、其次带图', () => {
    const db = createTestDb();
    addScene(db, { episodeId: 24, location: '河边', time: '夜 外', imageUrl: 'http://x/river_night.png' });
    const day = addScene(db, { episodeId: 25, location: '河边', time: '日 外', imageUrl: 'http://x/river_day.png' });
    assert.equal(sceneService.findReusableScene(db, 9, { location: '河边', time: '日 外', excludeEpisodeId: 28 }).id, day);
    // 时间都对不上时退化为「带图的那条」，仍然复用而不是重新生成
    const night = sceneService.findReusableScene(db, 9, { location: '河边', time: '黄昏 外', excludeEpisodeId: 28 });
    assert.ok(night && night.time === '夜 外');
  });

  it('排除本集自己（重新提取时不要复用刚软删/本集的行）', () => {
    const db = createTestDb();
    addScene(db, { episodeId: 28, location: '主卫', imageUrl: 'http://x/bath.png' });
    assert.equal(sceneService.findReusableScene(db, 9, { location: '主卫', time: '日 内', excludeEpisodeId: 28 }), null);
  });

  it('不跨剧、不看已删除、地点为空时不复用', () => {
    const db = createTestDb();
    addScene(db, { dramaId: 8, episodeId: 20, location: '吴家', imageUrl: 'http://x/other.png' });
    addScene(db, { dramaId: 9, episodeId: 24, location: '客厅', imageUrl: 'http://x/x.png', deletedAt: '2026-09-20T01:00:00.000Z' });
    assert.equal(sceneService.findReusableScene(db, 9, { location: '吴家', excludeEpisodeId: 28 }), null);
    assert.equal(sceneService.findReusableScene(db, 9, { location: '客厅', excludeEpisodeId: 28 }), null);
    assert.equal(sceneService.findReusableScene(db, 9, { location: '', excludeEpisodeId: 28 }), null);
  });

  it('地点不同（河边 vs 河边不远处）不误复用', () => {
    const db = createTestDb();
    addScene(db, { episodeId: 24, location: '河边', imageUrl: 'http://x/river.png' });
    assert.equal(sceneService.findReusableScene(db, 9, { location: '河边不远处', time: '日 外', excludeEpisodeId: 28 }), null);
  });
});

describe('createScene 继承既有场景的提示词与图片', () => {
  it('继承 image_url / local_path / prompt / polished_prompt / ref_image，不新建图片文件', () => {
    const db = createTestDb();
    const src = addScene(db, {
      episodeId: 24, location: '吴家', prompt: 'old prompt', imageUrl: 'http://x/wu.png',
      localPath: '/storage/scenes/75.png', polished: '四视图提示词', refImage: '/storage/ref/75.png',
    });

    const created = sceneService.createSceneForEpisode(db, silentLog, 9, 28, {
      location: '吴家', time: '日 内', prompt: '本集新描述', inherit_from_scene_id: src,
    });

    assert.equal(created.episode_id, 28, '仍为本集建独立行（前端按 episode_id 取场景）');
    assert.equal(created.image_url, 'http://x/wu.png');
    assert.equal(created.local_path, '/storage/scenes/75.png');
    assert.equal(created.prompt, 'old prompt', '同一地点沿用同一套场景定义');
    assert.equal(created.polished_prompt, '四视图提示词');
    const raw = db.prepare('SELECT ref_image FROM scenes WHERE id = ?').get(created.id);
    assert.equal(raw.ref_image, '/storage/ref/75.png');
  });

  it('没有命中时不继承（新场景保持空图，照旧生成）', () => {
    const db = createTestDb();
    const created = sceneService.createSceneForEpisode(db, silentLog, 9, 28, {
      location: '新地点', time: '夜 外', prompt: 'p', inherit_from_scene_id: null,
    });
    assert.equal(created.image_url, null);
    assert.equal(created.prompt, 'p');
  });
});

describe('buildExistingScenesHint（喂给提取模型的已有场景清单）', () => {
  it('列出地点/时间，并标出尚无图的场景', () => {
    const hint = buildExistingScenesHint(
      [
        { location: '吴家', time: '日 内', image_url: 'http://x/wu.png' },
        { location: '河边', time: '日 外', image_url: null, local_path: null },
      ],
      'zh'
    );
    assert.match(hint, /吴家 \/ 日 内/);
    assert.match(hint, /河边 \/ 日 外（尚无图）/);
    assert.match(hint, /沿用完全相同的 location 与 time 写法/);
  });

  it('没有已有场景时不插入任何内容（不改变原提示词）', () => {
    assert.equal(buildExistingScenesHint([], 'zh'), '');
    assert.equal(buildExistingScenesHint(null, 'zh'), '');
    assert.equal(buildExistingScenesHint([{ location: '  ' }], 'zh'), '');
  });

  it('英文语言下输出英文表头', () => {
    const hint = buildExistingScenesHint([{ location: 'Wu House', time: 'day' }], 'en');
    assert.match(hint, /\[Existing locations already used in this drama/);
    assert.match(hint, /no image yet/);
  });

  it('同一地点在多集重复时去重，并保留带图的那条', () => {
    const hint = buildExistingScenesHint(
      [
        { location: '吴家', time: '日 内', image_url: null, local_path: null },
        { location: '吴家', time: '日 内', image_url: 'http://x/wu.png' },
      ],
      'zh'
    );
    assert.equal((hint.match(/吴家/g) || []).length, 1);
    assert.equal(/尚无图/.test(hint), false, '去重后应保留带图的那条');
  });
});
