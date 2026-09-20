#!/usr/bin/env node
/**
 * 一次性数据修复：把 ust 头部的 <Picture N> 映射行按**权威槽位表**重建。
 *
 * 背景（用户实测「第四集前三镜两个女生角色对调」）：
 *   ust 里的映射行是 AI 写的，可能与提交时按 characters[] 算出的真实槽位顺序不一致
 *   （sb1091 把 2/3 号都写成韩悠兰、4 号写刘美云；真实是 2=刘美云 3=韩悠兰 4=吴家昌）
 *   → 模型把参考图绑错人，成片人物张冠李戴。
 *
 * 新代码已在「保存时」和「提交时」确定性重建映射行；本脚本修的是**库里已有的旧文本**，
 * 免得界面上显示的编号还是错的。
 *
 * 用法：
 *   node tools/fix_ust_mapping.js            # dry-run，只列出将被改动的分镜
 *   node tools/fix_ust_mapping.js --write     # 落库（自动先备份到 data/fix_ust_mapping_backup_*.json）
 */
const fs = require('fs');
const path = require('path');
const Database = require('better-sqlite3');
const { buildSlotsForStoryboard, replacePictureMappingLines, checkSegmentRefBinding } = require('../src/utils/segmentRefBinding');

const WRITE = process.argv.includes('--write');
const db = new Database(path.join(__dirname, '..', 'data', 'drama_generator.db'), { readonly: !WRITE });

/** 与 ref2vaFormat.buildRef2vaFallback / repairLeanBinding 同一套文案 */
const KIND_HINT = { 场景: '沿用其空间结构、光线与氛围。', 角色: '其外貌、发型与服装来自该图。', 道具: '其外形来自该图。' };
const blockLinesFor = (slots) => slots.map((s) => `<Picture ${s.index}>：${s.kind}「${s.name}」——${KIND_HINT[s.kind] || '沿用其外观与设定。'}`);

const rows = db.prepare(
  `SELECT id, episode_id, storyboard_number, title, universal_segment_text, characters, scene_id
   FROM storyboards WHERE deleted_at IS NULL AND creation_mode='universal'
     AND universal_segment_text IS NOT NULL ORDER BY episode_id, storyboard_number`
).all();

const targets = [];
for (const r of rows) {
  const slots = buildSlotsForStoryboard(db, r);
  if (!slots.length) continue;
  const rep = replacePictureMappingLines(r.universal_segment_text, blockLinesFor(slots));
  if (!rep.changed) continue;
  // 只修**真正错绑**的：缺行 / 名字对不上 / 引用了不存在的槽位。
  // 仅场景名措辞不同（「吴家客厅」vs 库里 location「吴家」）不改 —— 那是模型写得更具体，
  // 不影响接图，重写只会制造无谓 churn。
  const chk0 = checkSegmentRefBinding(r.universal_segment_text, slots, { knownNames: [] });
  if (chk0.missing.length + chk0.mismatched.length + chk0.unknown.length === 0) continue;
  const after = checkSegmentRefBinding(rep.text, slots, { knownNames: [] });
  const before = checkSegmentRefBinding(r.universal_segment_text, slots, { knownNames: [] });
  targets.push({ row: r, after: rep.text, beforeBad: before.missing.length + before.mismatched.length + before.unknown.length,
    afterBad: after.missing.length + after.mismatched.length + after.unknown.length });
}

console.log(`扫描 ${rows.length} 条全能分镜 → 需要重建映射行的 ${targets.length} 条`);
for (const t of targets) {
  const head = (s) => String(s).split('\n').filter((l) => /^\s*<Picture\s+\d+>\s*[:：]/.test(l)).map((l) => l.trim().replace(/——.*/, '')).join(' | ');
  console.log(`\n  sb${t.row.id} ep${t.row.episode_id} #${t.row.storyboard_number} ${t.row.title}  [错 ${t.beforeBad} → ${t.afterBad}]`);
  console.log(`    前: ${head(t.row.universal_segment_text)}`);
  console.log(`    后: ${head(t.after)}`);
}

if (!WRITE) {
  console.log('\n（dry-run，未落库。加 --write 执行）');
  process.exit(0);
}

const backupPath = path.join(__dirname, '..', 'data', `fix_ust_mapping_backup_${Date.now()}.json`);
fs.writeFileSync(backupPath, JSON.stringify(targets.map((t) => ({ id: t.row.id, before: t.row.universal_segment_text, after: t.after })), null, 2));
console.log('\n备份 →', backupPath);

const now = new Date().toISOString();
const upd = db.prepare('UPDATE storyboards SET universal_segment_text = ?, universal_segment_text_en = NULL, updated_at = ? WHERE id = ?');
const run = db.transaction(() => { for (const t of targets) upd.run(t.after, now, t.row.id); });
run();
console.log(`已更新 ${targets.length} 条（并清空 universal_segment_text_en，让英译按新文本重算）`);
