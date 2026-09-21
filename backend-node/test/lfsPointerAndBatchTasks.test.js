// 覆盖两处实测修出来的问题：
// 1) 示例 zip 走 Git LFS，没装 git-lfs 时检出的只是 ~130 字节指针文本，
//    旧代码报「ZIP 文件损坏」；现在要能识别并给可操作提示，列表里也要跳过。
// 2) 任务同步原本给每个角色/道具/场景各打一次 GET /tasks（实测 30 次/轮、单秒峰值 61 次），
//    现在走 resource_ids 批量，一次查完且结果必须与逐个查询完全一致。
const test = require('node:test');
const assert = require('node:assert/strict');
const Database = require('better-sqlite3');

const { parseLfsPointer, parseZip } = require('../src/services/dramaImportService');
const taskService = require('../src/services/taskService');

const log = { info() {}, warn() {}, error() {}, errorw() {}, debug() {} };

function createTaskDb() {
  const db = new Database(':memory:');
  db.exec(`
    CREATE TABLE async_tasks (
      id TEXT PRIMARY KEY,
      type TEXT,
      status TEXT,
      progress INTEGER,
      message TEXT,
      error TEXT,
      result TEXT,
      resource_id TEXT,
      created_at TEXT,
      updated_at TEXT,
      completed_at TEXT,
      deleted_at TEXT
    );
  `);
  return db;
}

function insertTask(db, { id, resourceId, status = 'running', createdAt }) {
  db.prepare(
    `INSERT INTO async_tasks (id, type, status, progress, message, resource_id, created_at, updated_at)
     VALUES (?, 'background_extraction', ?, 0, '', ?, ?, ?)`
  ).run(id, status, String(resourceId), createdAt, createdAt);
}

const LFS_POINTER = Buffer.from(
  [
    'version https://git-lfs.github.com/spec/v1',
    'oid sha256:f2aa6ec793270761b295e5ccc1fa5adb367dd36937db99e0b064667d8bb592f9',
    'size 82156132',
    '',
  ].join('\n'),
  'utf8'
);

test('parseLfsPointer 识别 Git LFS 指针并取出 size', () => {
  const info = parseLfsPointer(LFS_POINTER);
  assert.ok(info, '应识别为 LFS 指针');
  assert.equal(info.size, 82156132);
  assert.equal(info.oid, 'f2aa6ec793270761b295e5ccc1fa5adb367dd36937db99e0b064667d8bb592f9');
});

test('parseLfsPointer 不误判真实 ZIP 与普通文件', () => {
  // ZIP 魔数 PK\x03\x04
  assert.equal(parseLfsPointer(Buffer.from([0x50, 0x4b, 0x03, 0x04, 0x14, 0x00])), null);
  assert.equal(parseLfsPointer(Buffer.from('PK', 'utf8')), null);
  assert.equal(parseLfsPointer(Buffer.alloc(0)), null);
  assert.equal(parseLfsPointer(null), null);
  assert.equal(parseLfsPointer(Buffer.from('{"drama":{"title":"x"}}', 'utf8')), null);
  // 超过 1KB 的文本一律不当作指针（真 ZIP 也可能恰好含该字样）
  assert.equal(parseLfsPointer(Buffer.from('version https://git-lfs.github.com/spec/v1\n' + 'x'.repeat(2000), 'utf8')), null);
});

test('parseZip 对 LFS 指针给出可操作提示，而不是「ZIP 文件损坏」', () => {
  assert.throws(
    () => parseZip(LFS_POINTER),
    (err) => {
      assert.match(err.message, /Git LFS 指针/);
      assert.match(err.message, /78\.4 MB/, '应带真实文件大小');
      assert.match(err.message, /git lfs pull/, '应给出可操作命令');
      assert.doesNotMatch(err.message, /ZIP 文件损坏/);
      return true;
    }
  );
});

test('parseZip 对真正损坏的 ZIP 仍报「ZIP 文件损坏」', () => {
  assert.throws(
    () => parseZip(Buffer.from('not a zip at all, but longer than a pointer to be safe', 'utf8')),
    /ZIP 文件损坏/
  );
});

test('getTasksByResources 与逐个 getTasksByResource 结果完全一致', () => {
  const db = createTaskDb();
  insertTask(db, { id: 't1', resourceId: 1, createdAt: '2026-01-01T00:00:01.000Z' });
  insertTask(db, { id: 't2', resourceId: 1, createdAt: '2026-01-01T00:00:02.000Z' });
  insertTask(db, { id: 't3', resourceId: 2, createdAt: '2026-01-01T00:00:03.000Z' });
  insertTask(db, { id: 't4', resourceId: 3, createdAt: '2026-01-01T00:00:04.000Z' });
  insertTask(db, { id: 't9', resourceId: 9, createdAt: '2026-01-01T00:00:05.000Z' });
  // 软删除的不应出现
  db.prepare("UPDATE async_tasks SET deleted_at = '2026-01-01T00:00:09.000Z' WHERE id = 't3'").run();

  const ids = [1, 2, 3, 9, 42];
  // 逐个查询按生产调用方式传字符串（前端就是 String(resourceId)，原因见下一条用例）
  const perResource = ids.flatMap((id) => taskService.getTasksByResource(db, String(id)));
  const batch = taskService.getTasksByResources(db, ids);

  const key = (t) => t.id;
  assert.deepEqual(
    batch.map(key).sort(),
    perResource.map(key).sort(),
    '批量结果必须与逐个查询的并集一致'
  );
  assert.equal(batch.length, 4, 't3 已软删除，不应计入');
});

test('resource_id 是 TEXT 列：旧的单值查询收数字会静默查不到，批量接口已归一化', () => {
  // 真实库里 async_tasks.resource_id 声明为 TEXT，存的是文本。
  // SQLite 不会把数字绑定参数按 TEXT affinity 转换 —— 传数字 1 匹配不上文本 '1'，返回空且不报错。
  // 旧的 getTasksByResource 因此依赖调用方自觉传字符串（前端写了 String(resourceId)）。
  const db = createTaskDb();
  insertTask(db, { id: 't1', resourceId: 1, createdAt: '2026-01-01T00:00:01.000Z' });

  assert.equal(taskService.getTasksByResource(db, 1).length, 0, '数字入参：TEXT 列匹配不上（旧接口的坑）');
  assert.equal(taskService.getTasksByResource(db, '1').length, 1, '字符串入参才是正确用法');

  // 批量接口内部统一 String() 归一化，数字、字符串、混合都能命中
  assert.equal(taskService.getTasksByResources(db, [1]).length, 1);
  assert.equal(taskService.getTasksByResources(db, ['1']).length, 1);
  assert.equal(taskService.getTasksByResources(db, [1, '1']).length, 1, '同一个 id 的两种写法不应重复');
});

test('getTasksByResources 处理空输入、去重、数字与字符串 id', () => {
  const db = createTaskDb();
  insertTask(db, { id: 't1', resourceId: 7, createdAt: '2026-01-01T00:00:01.000Z' });

  assert.deepEqual(taskService.getTasksByResources(db, []), []);
  assert.deepEqual(taskService.getTasksByResources(db, null), []);
  assert.deepEqual(taskService.getTasksByResources(db, ['', null, undefined]), []);

  // 重复 id 不应导致重复行
  const dup = taskService.getTasksByResources(db, [7, '7', 7]);
  assert.equal(dup.length, 1);

  // 数字与字符串等价
  assert.equal(taskService.getTasksByResources(db, ['7']).length, 1);
  assert.equal(taskService.getTasksByResources(db, [7]).length, 1);
});

test('getTasksByResources 超过单批 500 个 id 时仍能全部取回', () => {
  const db = createTaskDb();
  const total = 620;
  for (let i = 1; i <= total; i++) {
    insertTask(db, { id: `t${i}`, resourceId: i, createdAt: `2026-01-01T00:00:${String(i % 60).padStart(2, '0')}.000Z` });
  }
  const ids = Array.from({ length: total }, (_, i) => i + 1);
  const batch = taskService.getTasksByResources(db, ids);
  assert.equal(batch.length, total, '跨批次分片查询不应漏数据');
});

test('getTasksByResources 不返回其它 resource 的任务', () => {
  const db = createTaskDb();
  insertTask(db, { id: 't1', resourceId: 5, createdAt: '2026-01-01T00:00:01.000Z' });
  insertTask(db, { id: 't2', resourceId: 6, createdAt: '2026-01-01T00:00:02.000Z' });
  const rows = taskService.getTasksByResources(db, [5]);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].id, 't1');
});
