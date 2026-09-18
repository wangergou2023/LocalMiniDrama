#!/usr/bin/env node
/**
 * 摘掉 ust 里"声明了但没接线"的参考音频引用。
 *
 * 背景：Ref2VA 规范里 `<Audio j>` 指的是**已接入的第 j 段参考音频**。我们多数项目没有
 * 参考音频（voice_reference_url / reference_audio_urls 都为空），但 ust 仍然写着
 * 「<Audio 1> 为画外解说提供音色基准」——模型会去"续"一段不存在的音色参考，
 * 实测表现为台词前后多念一段听不懂的话。这里把这类悬空声明清掉，
 * 保留其余文本与结构不变（不按官方六段格式硬套，能读通就行）。
 *
 * 用法:
 *   node tools/strip_unwired_audio_refs.js --episode 23            # 预览（只打印，不写库）
 *   node tools/strip_unwired_audio_refs.js --episode 23 --write    # 真正写库（自动备份）
 */
const fs = require('fs');
const path = require('path');
const Database = require('better-sqlite3');

const ROOT = path.resolve(__dirname, '..');
const DB_PATH = path.join(ROOT, 'data', 'drama_generator.db');

const argv = process.argv.slice(2);
const getArg = (k) => { const i = argv.indexOf(k); return i >= 0 ? argv[i + 1] : null; };
const episodeId = Number(getArg('--episode'));
const WRITE = argv.includes('--write');
if (!episodeId) { console.error('缺少 --episode <集 id>'); process.exit(2); }

/** 一行文本里所有 <Audio j> 的编号 */
function audioRefsIn(text) {
  const out = new Set();
  const re = /<Audio\s+(\d+)>/g;
  let m;
  while ((m = re.exec(text))) out.add(Number(m[1]));
  return out;
}

/**
 * 改写规则（只动悬空引用，不重写别的内容）：
 *  1. 整行就是 `<Audio j>…` 声明（subject_definitions 的音色声明行、retention_analysis 的条目行）→ 删掉该行；
 *  2. 行内提到 `<Audio j>` → 换成「画外解说的人声」，句子照样读得通；
 *  3. 顺带收掉「不复用其原有语句」这类为参考音频写的从句（没有参考音频就无从"复用"）。
 */
function stripUnwired(text, wired) {
  const kept = [];
  let removedLines = 0;
  let inlineReplaced = 0;
  for (const line of String(text || '').split('\n')) {
    const refs = [...audioRefsIn(line)];
    if (refs.length && refs.every((j) => !wired.has(j))) {
      const trimmed = line.trim();
      const isDeclaration = /^<Audio\s+\d+>\s*[:：]/.test(trimmed)
        || /^<Audio\s+\d+>\s+is\s/i.test(trimmed)
        || /^<Subject\s+\d+>.*<Audio\s+\d+>.*(reference|音色)/i.test(trimmed);
      if (isDeclaration) { removedLines++; continue; }
    }
    let out = line;
    for (const j of refs) {
      if (wired.has(j)) continue;
      out = out.replace(new RegExp(`<Audio\\s+${j}>\\s*`, 'g'), () => { inlineReplaced++; return '画外解说的人声'; });
    }
    out = out.replace(/，?不复用其原有语句/g, '');
    kept.push(out);
  }
  return { text: kept.join('\n').replace(/\n{3,}/g, '\n\n'), removedLines, inlineReplaced };
}

const db = new Database(DB_PATH);
const rows = db.prepare(
  `SELECT id, storyboard_number, universal_segment_text, video_prompt
     FROM storyboards WHERE episode_id = ? AND deleted_at IS NULL ORDER BY storyboard_number, id`
).all(episodeId);
if (!rows.length) { console.error('该集没有分镜'); process.exit(2); }

let touched = 0;
let totalRemoved = 0;
let totalInline = 0;
const backup = [];
for (const r of rows) {
  const src = r.universal_segment_text || '';
  if (!src.trim()) continue;
  const wired = new Set(); // 本机这些项目没有接参考音频
  const res = stripUnwired(src, wired);
  if (res.text === src) continue;
  touched++;
  totalRemoved += res.removedLines;
  totalInline += res.inlineReplaced;
  backup.push({ id: r.id, storyboard_number: r.storyboard_number, before: src, after: res.text });
  console.log(`#${r.storyboard_number} 删声明行 ${res.removedLines}、行内替换 ${res.inlineReplaced}`);
  if (WRITE) db.prepare('UPDATE storyboards SET universal_segment_text = ?, updated_at = ? WHERE id = ?')
    .run(res.text, new Date().toISOString(), r.id);
}

if (WRITE && backup.length) {
  const bak = path.join(ROOT, 'data', `ust_audio_ref_backup_${Date.now()}.json`);
  fs.writeFileSync(bak, JSON.stringify(backup, null, 1));
  console.log('备份: ' + bak);
}
console.log(`\n${WRITE ? '已写入' : '预览'}：分镜 ${touched} 个，删声明行 ${totalRemoved}，行内替换 ${totalInline}`);
if (!WRITE) console.log('（加 --write 才真正写库）');
db.close();
