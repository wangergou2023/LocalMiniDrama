#!/usr/bin/env node
/**
 * 把现存「同一地点、但本集没有图」的场景，接上本剧更早剧集已有场景的图与提示词。
 *
 * 背景：场景提取以前是「每集独立新建空行」，导致「吴家」在第1/2集有图、第5集是空行，
 *       同一地点要反复重生图。新提取流程已自动复用（sceneService.findReusableScene），
 *       这个脚本用于把历史数据补齐，不必重跑 AI 提取。
 *
 * 默认 dry-run（只打印计划），加 --write 才写库。
 *   node tools/reuse_previous_scene_images.js              # 预览
 *   node tools/reuse_previous_scene_images.js --write      # 执行（先自动备份 scenes 表）
 *   node tools/reuse_previous_scene_images.js --drama 9 --write
 */
const fs = require('fs');
const path = require('path');
const Database = require('better-sqlite3');
const sceneService = require('../src/services/sceneService');

const args = process.argv.slice(2);
const write = args.includes('--write');
const dramaArg = args.indexOf('--drama');
const onlyDrama = dramaArg >= 0 ? Number(args[dramaArg + 1]) : null;

const dbPath = path.join(__dirname, '..', 'data', 'drama_generator.db');
const db = new Database(dbPath);

const log = {
  info: (msg, meta) => console.log('[info]', msg, meta ? JSON.stringify(meta) : ''),
  warn: (msg, meta) => console.log('[warn]', msg, meta ? JSON.stringify(meta) : ''),
  error: (msg, meta) => console.log('[error]', msg, meta ? JSON.stringify(meta) : ''),
};

/** 没有图的本集场景（本集有没有图以 image_url/local_path 任一为空判断） */
function listEmptyScenes() {
  const sql = `SELECT s.id, s.drama_id, s.episode_id, s.location, s.time, e.episode_number
                 FROM scenes s LEFT JOIN episodes e ON e.id = s.episode_id
                WHERE s.deleted_at IS NULL
                  AND (s.image_url IS NULL OR s.image_url = '')
                  AND (s.local_path IS NULL OR s.local_path = '')
                  ${onlyDrama ? 'AND s.drama_id = ?' : ''}
                ORDER BY s.drama_id, e.episode_number, s.id`;
  return onlyDrama ? db.prepare(sql).all(onlyDrama) : db.prepare(sql).all();
}

const targets = listEmptyScenes();
console.log(`模式：${write ? '写入 (--write)' : '预览 (dry-run)'}    数据库：${dbPath}`);
console.log(`本集无图的场景共 ${targets.length} 条\n`);

const plan = [];
for (const s of targets) {
  const src = sceneService.findReusableScene(db, s.drama_id, {
    location: s.location,
    time: s.time,
    excludeEpisodeId: s.episode_id,
  });
  if (!src || !(src.image_url || src.local_path)) continue; // 源场景自己也没图，跳过
  const srcEp = src.episode_id
    ? db.prepare('SELECT episode_number FROM episodes WHERE id = ?').get(src.episode_id)
    : null;
  plan.push({ target: s, source: src, sourceEpisode: srcEp ? srcEp.episode_number : null });
}

if (plan.length === 0) {
  console.log('没有可回填的场景（要么都已有图，要么前面几集也没有同地点带图的场景）。');
  process.exit(0);
}

console.log(`可回填 ${plan.length} 条：\n`);
for (const p of plan) {
  console.log(
    `  drama${p.target.drama_id} 第${p.target.episode_number ?? '?'}集 scene#${p.target.id} ${p.target.location}/${p.target.time}` +
    `  ←  第${p.sourceEpisode ?? '?'}集 scene#${p.source.id} ${p.source.location}/${p.source.time}` +
    `  [${p.source.local_path ? '本地图' : '图 URL'}]`
  );
}

if (!write) {
  console.log('\n以上为预览，未写入。确认无误后加 --write 执行。');
  process.exit(0);
}

// 备份 scenes 表全量，便于回滚
const backupPath = path.join(__dirname, '..', 'data', `backup_scenes_before_reuse_${Date.now()}.json`);
fs.writeFileSync(backupPath, JSON.stringify(db.prepare('SELECT * FROM scenes').all(), null, 2));
console.log(`\n已备份 scenes 表 → ${backupPath}`);

let done = 0;
for (const p of plan) {
  const src = sceneService.inheritSceneAssets(db, log, p.target.id, p.source.id);
  if (src) done += 1;
}
console.log(`\n完成：${done}/${plan.length} 条场景已接上前几集的图与提示词（未生成任何图片、未调用 AI）。`);
