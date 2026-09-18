#!/usr/bin/env node
/**
 * 一次性数据修复：把《重生后过上了大女主生活》(drama_id=9) 的导入结果修正干净。
 *
 * 修两件事：
 *   ① 第一集（episode 24）里塞着 5992 字的策划案前言（基本信息/人物小传/故事大纲）——
 *      挪进「故事梗概」(dramas.description)，第一集只留第一集正文。
 *      不修的话第一集 6671 字，按「每集约 740 字」折算 ≈ 200 个分镜（实际也真生成了 200 条）。
 *   ② 第十二集的标题在原文里写成「十二集」（漏「第」），导入时被并进第十一集（episode 34）——
 *      按裸标题把它切开，新增一条「第十二集」，后续集号顺延。
 *
 * 分镜（storyboards）/角色（characters）都按 episode_id 关联，集号顺延不影响它们。
 *
 * 用法：
 *   node tools/fix_drama9_split.js            # dry-run，只打印将要做的改动
 *   node tools/fix_drama9_split.js --write     # 落库（自动先备份成 data/fix_drama9_backup_*.json）
 */
const fs = require('fs');
const path = require('path');
const Database = require('better-sqlite3');

const DRAMA_ID = 9;
const WRITE = process.argv.includes('--write');
const dbPath = path.join(__dirname, '..', 'data', 'drama_generator.db');
const db = new Database(dbPath, { readonly: !WRITE });

// 与前端 parseScriptIntoEpisodes 一致的两条规则
const BARE_RE = /^((?:[零一二三四五六七八九十百千]|\d|[\uFF10-\uFF19]){1,4}\s*(?:集|章|节))\s*$/;
// 分集正文的第一个场景行（这份剧本里每个分集都以「1.景：xxx」开头）
const SCENE_ONE_RE = /^\s*1\s*[\.、]\s*景\s*[:：]/;

function splitAtFirstHeader(text, re, from = 0) {
  const lines = text.split('\n');
  for (let i = from; i < lines.length; i++) {
    const t = lines[i].trim();
    if (re.test(t)) {
      return {
    before: lines.slice(0, i).join('\n').trim(),
    header: t,
    // 标题行本身不进 after：调用方决定要不要把它接回去（第一集要，第十二集不要）
    after: lines.slice(i + 1).join('\n').trim(),
  };
    }
  }
  return null;
}

const episodes = db.prepare('SELECT id, episode_number, title, script_content FROM episodes WHERE drama_id = ? AND deleted_at IS NULL ORDER BY episode_number').all(DRAMA_ID);
const ep1 = episodes.find((e) => e.episode_number === 1);
const ep11 = episodes.find((e) => e.episode_number === 11);
if (!ep1 || !ep11) throw new Error('找不到第一集/第十一集，脚本与当前数据不匹配，已中止');

// ① 第一集：前言 vs 正文。
// 注意：导入时「第一集」标题只写进了 episodes.title，正文里没有这一行，
// 所以这里按「分集正文的第一个场景行 1.景：」来切，而不是按标题行。
const s1 = splitAtFirstHeader(ep1.script_content, SCENE_ONE_RE);
if (!s1) throw new Error('第一集里找不到「1.景：」开头的正文，已中止');
if (s1.before.length < 2000) throw new Error(`第一集前言只有 ${s1.before.length} 字，看起来不像策划案，已中止`);
// 「1.景：xxx」是正文的第一行，不属于前言，要接回去
const ep1Body = `${s1.header}\n${s1.after}`;
// ② 第十一集：十二集正文
const s11 = splitAtFirstHeader(ep11.script_content, BARE_RE);
if (!s11) throw new Error('第十一集里找不到「十二集」裸标题行，已中止');

const drama = db.prepare('SELECT id, description FROM dramas WHERE id = ?').get(DRAMA_ID);
const newTitle = `第${s11.header.replace(/\s+/g, '')}`;

console.log('=== 将要做的事 ===');
console.log(`① 第一集 (episode ${ep1.id})`);
console.log(`     前言 ${s1.before.length} 字 → dramas.description（当前 description ${drama.description ? drama.description.length + ' 字' : '为空'}）`);
console.log(`     正文 ${ep1.script_content.length} 字 → ${ep1Body.length} 字`);
console.log(`② 第十一集 (episode ${ep11.id})`);
console.log(`     ${ep11.script_content.length} 字 → ${s11.before.length} 字`);
console.log(`     新增一条：${newTitle}（${s11.after.length} 字），插在第 12 位`);
console.log(`③ 集号顺延：现有 episode_number >= 12 的行 +1（共 ${episodes.filter((e) => e.episode_number >= 12).length} 条，标题已经是「第十三集…第二十集」，不用改）`);
console.log(`④ dramas.total_episodes: ${db.prepare('SELECT total_episodes FROM dramas WHERE id=?').get(DRAMA_ID).total_episodes} → ${episodes.length + 1}`);

if (!WRITE) {
  console.log('\n（dry-run，未落库。加 --write 执行）');
  process.exit(0);
}

// ── 备份 ──────────────────────────────────────────────────────────────────
const backup = {
  created_at: new Date().toISOString(),
  drama: db.prepare('SELECT * FROM dramas WHERE id = ?').get(DRAMA_ID),
  episodes: db.prepare('SELECT * FROM episodes WHERE drama_id = ?').all(DRAMA_ID),
  episode_characters: db.prepare(
    `SELECT ec.* FROM episode_characters ec JOIN episodes e ON e.id = ec.episode_id WHERE e.drama_id = ?`
  ).all(DRAMA_ID),
};
const backupPath = path.join(__dirname, '..', 'data', `fix_drama9_backup_${Date.now()}.json`);
fs.writeFileSync(backupPath, JSON.stringify(backup, null, 2));
console.log('\n备份 →', backupPath);

// ── 落库（单事务）────────────────────────────────────────────────────────
const now = new Date().toISOString();
const run = db.transaction(() => {
  db.prepare('UPDATE dramas SET description = ?, total_episodes = ?, updated_at = ? WHERE id = ?')
    .run(s1.before, episodes.length + 1, now, DRAMA_ID);
  db.prepare('UPDATE episodes SET script_content = ?, updated_at = ? WHERE id = ?').run(ep1Body, now, ep1.id);
  db.prepare('UPDATE episodes SET script_content = ?, updated_at = ? WHERE id = ?').run(s11.before, now, ep11.id);
  db.prepare('UPDATE episodes SET episode_number = episode_number + 1, updated_at = ? WHERE drama_id = ? AND episode_number >= 12')
    .run(now, DRAMA_ID);
  const info = db.prepare(
    `INSERT INTO episodes (drama_id, episode_number, title, script_content, status, created_at, updated_at)
     VALUES (?, 12, ?, ?, 'draft', ?, ?)`
  ).run(DRAMA_ID, newTitle, s11.after, now, now);
  return info.lastInsertRowid;
});
const newId = run();
console.log('新增分集 id =', newId);

// ── 校验 ──────────────────────────────────────────────────────────────────
const after = db.prepare('SELECT episode_number, title, length(script_content) len FROM episodes WHERE drama_id = ? AND deleted_at IS NULL ORDER BY episode_number').all(DRAMA_ID);
console.log('\n=== 修好后 ===');
for (const e of after) console.log(` ep${String(e.episode_number).padStart(2)} ${e.title.padEnd(6)} ${String(e.len).padStart(5)} 字`);
const nums = after.map((e) => e.episode_number);
const ok = after.length === 20 && nums.every((n, i) => n === i + 1);
console.log('\n集数:', after.length, '| 集号连续:', ok ? '是' : '否 ← 有问题，用备份回滚');
if (!ok) process.exitCode = 1;
