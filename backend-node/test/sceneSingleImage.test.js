'use strict';
/**
 * 单幅场景图登记为视频参考图。
 *
 * 事故背景：场景图默认是四/六宫格拼图，H3 的 ref_image_size:match 会把整张拼图缩到生成面积，
 * 每格只剩约 570×320，空间语义传不过去（vg76/vg77 成片背景成了通用森林）。
 * 单幅图才是 H3 想吃的 <Picture 1>。这里锁住「local_path 换成单幅图、旧拼图进 extra_images」的契约。
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const Database = require('better-sqlite3');
const sceneService = require('../src/services/sceneService');

function makeDb() {
  const db = new Database(':memory:');
  db.exec(`CREATE TABLE scenes (id INTEGER PRIMARY KEY, local_path TEXT, extra_images TEXT, updated_at TEXT, deleted_at TEXT)`);
  return db;
}

test('单幅场景图替换 local_path，旧拼图搬进 extra_images', () => {
  const db = makeDb();
  db.prepare('INSERT INTO scenes (id, local_path) VALUES (43, ?)').run('projects/p/scenes/ig_grid.png');
  const r = sceneService.applySingleViewSceneImage(db, null, 43, 'projects/p/scenes/scene_single_43.png');
  assert.equal(r.ok, true);
  const row = db.prepare('SELECT * FROM scenes WHERE id = 43').get();
  assert.equal(row.local_path, 'projects/p/scenes/scene_single_43.png');
  assert.deepEqual(JSON.parse(row.extra_images), ['projects/p/scenes/ig_grid.png']);
  assert.ok(row.updated_at, 'updated_at 应被刷新');
});

test('重复登记同一张单幅图不会重复堆积 extra_images（幂等）', () => {
  const db = makeDb();
  db.prepare('INSERT INTO scenes (id, local_path) VALUES (44, ?)').run('projects/p/scenes/ig_grid.png');
  sceneService.applySingleViewSceneImage(db, null, 44, 'projects/p/scenes/single_44.png');
  sceneService.applySingleViewSceneImage(db, null, 44, 'projects/p/scenes/single_44.png');
  const row = db.prepare('SELECT * FROM scenes WHERE id = 44').get();
  assert.equal(row.local_path, 'projects/p/scenes/single_44.png');
  assert.deepEqual(JSON.parse(row.extra_images), ['projects/p/scenes/ig_grid.png']);
});

test('已有 extra_images 时保留既有内容，且开头斜杠被归一化', () => {
  const db = makeDb();
  db.prepare('INSERT INTO scenes (id, local_path, extra_images) VALUES (45, ?, ?)')
    .run('projects/p/scenes/ig_grid.png', JSON.stringify(['projects/p/scenes/old_extra.png']));
  const r = sceneService.applySingleViewSceneImage(db, null, 45, '/projects/p/scenes/single_45.png');
  assert.equal(r.local_path, 'projects/p/scenes/single_45.png', '开头斜杠应去掉');
  const extras = JSON.parse(db.prepare('SELECT extra_images FROM scenes WHERE id = 45').get().extra_images);
  assert.deepEqual(extras, ['projects/p/scenes/ig_grid.png', 'projects/p/scenes/old_extra.png']);
});

test('场景不存在 / 参数不合法时返回失败而不是抛错', () => {
  const db = makeDb();
  assert.equal(sceneService.applySingleViewSceneImage(db, null, 999, 'a/b.png').ok, false);
  assert.equal(sceneService.applySingleViewSceneImage(db, null, 43, '').ok, false);
  assert.equal(sceneService.applySingleViewSceneImage(db, null, 'x', 'a/b.png').ok, false);
});

test('buildSceneSingleImagePrompt 里带画风块，且明确是单幅（不含四格字样）', () => {
  const p = sceneService.buildSceneSingleImagePrompt('险峻山道，古木参天。', 'ink wash, sumi-e', '水墨画');
  assert.match(p, /ink wash, sumi-e/);
  assert.match(p, /水墨画/);
  assert.equal(/四格|four panels|all 4 panels/i.test(p), false, p.slice(0, 200));
});
