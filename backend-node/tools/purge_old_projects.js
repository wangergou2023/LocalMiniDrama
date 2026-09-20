#!/usr/bin/env node
/**
 * 硬删「旧项目」：数据库里 deleted_at 不为空的剧（drama 1-8）及其全部下级数据，
 * 并把它们的存储目录**移到回收目录**（不直接 rm，确认无误后再自己删）。
 *
 * 为什么要有这个脚本：这些项目已被软删（界面看不见），但行还在库里、媒体还占 1.16GB，
 * 而且我上一轮审计时它们的老格式 ust 还会被扫出来，混淆视听。
 *
 * 用法：
 *   node tools/purge_old_projects.js            # dry-run：只列出将删除的行数与存储目录
 *   node tools/purge_old_projects.js --write     # 执行（先整库备份 + 移动存储到回收目录）
 */
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');
const Database = require('better-sqlite3');

const WRITE = process.argv.includes('--write');
const DATA = path.join(__dirname, '..', 'data');
const dbPath = path.join(DATA, 'drama_generator.db');
const db = new Database(dbPath, { readonly: !WRITE });

const doomed = db.prepare('SELECT id,title FROM dramas WHERE deleted_at IS NOT NULL ORDER BY id').all();
const keep = db.prepare('SELECT id,title FROM dramas WHERE deleted_at IS NULL ORDER BY id').all();
if (!doomed.length) { console.log('没有软删的剧，无需处理'); process.exit(0); }

const dramaIds = doomed.map((d) => d.id);
const ph = dramaIds.map(() => '?').join(',');
const epIds = db.prepare(`SELECT id FROM episodes WHERE drama_id IN (${ph})`).all(...dramaIds).map((r) => r.id);
const sbIds = epIds.length
  ? db.prepare(`SELECT id FROM storyboards WHERE episode_id IN (${epIds.map(() => '?').join(',')})`).all(...epIds).map((r) => r.id)
  : [];

const count = (sql, ...a) => db.prepare(sql).get(...a).n;
const plan = [];
const inList = (arr) => arr.map(() => '?').join(',') || 'NULL';

// 子表 → 父表顺序删除
const steps = [
  ['storyboard_characters', sbIds.length, `DELETE FROM storyboard_characters WHERE storyboard_id IN (${inList(sbIds)})`, sbIds],
  ['storyboard_props', sbIds.length, `DELETE FROM storyboard_props WHERE storyboard_id IN (${inList(sbIds)})`, sbIds],
  ['frame_prompts', sbIds.length, `DELETE FROM frame_prompts WHERE storyboard_id IN (${inList(sbIds)})`, sbIds],
  ['image_generations', dramaIds.length, `DELETE FROM image_generations WHERE drama_id IN (${ph})`, dramaIds],
  ['video_generations', dramaIds.length, `DELETE FROM video_generations WHERE drama_id IN (${ph})`, dramaIds],
  ['video_merges', dramaIds.length, `DELETE FROM video_merges WHERE drama_id IN (${ph})`, dramaIds],
  ['episode_characters', epIds.length, `DELETE FROM episode_characters WHERE episode_id IN (${inList(epIds)})`, epIds],
  ['storyboards', epIds.length, `DELETE FROM storyboards WHERE episode_id IN (${inList(epIds)})`, epIds],
  ['scenes', dramaIds.length, `DELETE FROM scenes WHERE drama_id IN (${ph})`, dramaIds],
  ['props', dramaIds.length, `DELETE FROM props WHERE drama_id IN (${ph})`, dramaIds],
  ['characters', dramaIds.length, `DELETE FROM characters WHERE drama_id IN (${ph})`, dramaIds],
  ['character_libraries', dramaIds.length, `DELETE FROM character_libraries WHERE drama_id IN (${ph})`, dramaIds],
  ['scene_libraries', dramaIds.length, `DELETE FROM scene_libraries WHERE drama_id IN (${ph})`, dramaIds],
  ['prop_libraries', dramaIds.length, `DELETE FROM prop_libraries WHERE drama_id IN (${ph})`, dramaIds],
  ['assets', dramaIds.length, `DELETE FROM assets WHERE drama_id IN (${ph})`, dramaIds],
  ['episodes', dramaIds.length, `DELETE FROM episodes WHERE drama_id IN (${ph})`, dramaIds],
  ['async_tasks', 0, `DELETE FROM async_tasks WHERE resource_id IN (${[...dramaIds, ...epIds, ...sbIds].map(() => '?').join(',')})`, [...dramaIds, ...epIds, ...sbIds].map(String)],
  ['dramas', dramaIds.length, `DELETE FROM dramas WHERE id IN (${ph})`, dramaIds],
];

console.log('将硬删的旧项目：');
for (const d of doomed) console.log(`  id=${d.id} ${d.title}`);
console.log(`保留：${keep.map((k) => `id=${k.id} ${k.title}`).join('、') || '(无)'}`);
console.log(`\n涉及 ${epIds.length} 集 / ${sbIds.length} 分镜\n`);
let total = 0;
for (const [name, , sql, args] of steps) {
  const n = args.length ? count(`SELECT COUNT(*) n FROM (${sql.replace(/^DELETE FROM\s+(\w+)/, 'SELECT 1 FROM $1')})`, ...args) : 0;
  plan.push([name, n, sql, args]); total += n;
  console.log(`  ${name.padEnd(24)} ${String(n).padStart(6)} 行`);
}
console.log(`\n合计 ${total} 行`);

const storageRoot = path.join(DATA, 'storage', 'projects');
const oldDirs = fs.existsSync(storageRoot)
  ? fs.readdirSync(storageRoot).filter((d) => {
      const m = /^(\d{4})_/.exec(d); if (!m) return false;
      return doomed.some((x) => Number(m[1]) === Number(x.id));
    })
  : [];
console.log('\n存储目录（将移到回收目录）：');
for (const d of oldDirs) {
  const p = path.join(storageRoot, d);
  const mb = Number(execFileSync('du', ['-sm', p]).toString().split('\t')[0]);
  console.log(`  ${d}  ${mb} MB`);
}

if (!WRITE) { console.log('\n（dry-run，未落库。加 --write 执行）'); process.exit(0); }

// ① 整库备份（先关只读连接，用文件拷贝）
db.close();
const stamp = Date.now();
const backupPath = path.join(DATA, `backup_before_purge_${stamp}.db`);
fs.copyFileSync(dbPath, backupPath);
console.log('\n整库备份 →', backupPath);

// ② 行删除（事务）
const wdb = new Database(dbPath);
const run = wdb.transaction(() => { for (const [, , sql, args] of steps) if (args.length) wdb.prepare(sql).run(...args); });
run();
const left = wdb.prepare('SELECT COUNT(*) n FROM dramas').get().n;
const leftEp = wdb.prepare('SELECT COUNT(*) n FROM episodes').get().n;
const leftSb = wdb.prepare('SELECT COUNT(*) n FROM storyboards').get().n;
console.log(`删除完成：dramas 剩 ${left}、episodes 剩 ${leftEp}、storyboards 剩 ${leftSb}`);
wdb.close();

// ③ 存储移到回收目录
const trash = path.join(DATA, `_purged_projects_${stamp}`);
fs.mkdirSync(trash, { recursive: true });
for (const d of oldDirs) {
  fs.renameSync(path.join(storageRoot, d), path.join(trash, d));
}
console.log(`存储已移到 ${trash}（确认没问题后 rm -rf 它即可释放空间）`);
