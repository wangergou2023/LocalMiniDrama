#!/usr/bin/env node
/**
 * 把六段格式的 ust 重构成**精简格式（本机折中版）**。
 *
 * 为什么砍：`subject_definitions` / `summary` / `retention_analysis` 三段是给"多镜一次性生成"准备
 * 的元数据；我们是一镜一次生成，这三段只增加 LLM 写错编号的机会（`<Subject N>` 指哪张图全靠模型自己写对）。
 * 精简后：参考图直接由 `<Picture N>：…` 映射行指出（编号 = 提交顺序，没有中间层），
 * 正文里不再出现 `<Subject N>`；台词与环境声照旧。
 *
 * 用法:
 *   node tools/lean_ust.js --episode 24            # 预览（打印 diff 摘要，不写库）
 *   node tools/lean_ust.js --episode 24 --write    # 写库（自动备份）
 *   node tools/lean_ust.js --drama 9 --write
 *   node tools/lean_ust.js --sb 886,887 --write
 */
const fs = require('fs');
const path = require('path');
const Database = require('better-sqlite3');
const { buildSlotsForStoryboard } = require(path.join(__dirname, '..', 'src', 'utils', 'segmentRefBinding.js'));

const ROOT = path.resolve(__dirname, '..');
const DB_PATH = path.join(ROOT, 'data', 'drama_generator.db');

const argv = process.argv.slice(2);
const getArg = (k) => { const i = argv.indexOf(k); return i >= 0 ? argv[i + 1] : null; };
const WRITE = argv.includes('--write');
const epId = Number(getArg('--episode')) || null;
const dramaId = Number(getArg('--drama')) || null;
const sbIds = (getArg('--sb') || '').split(',').map(Number).filter(Boolean);
if (!epId && !dramaId && !sbIds.length) { console.error('需要 --episode / --drama / --sb 之一'); process.exit(2); }

const SECTIONS = ['subject_definitions', 'summary', 'retention_analysis', 'detailed_description', 'overall_soundscape', 'non_diegetic_music'];
const HEADER_RE = new RegExp('^\\s*(' + SECTIONS.join('|') + ')\\s*[:：]\\s*', 'i');

function parseSections(text) {
  const out = {};
  let cur = null;
  for (const line of String(text || '').replace(/\r\n?/g, '\n').split('\n')) {
    const m = line.match(HEADER_RE);
    if (m) { cur = m[1].toLowerCase(); out[cur] = out[cur] || ''; const inline = line.replace(HEADER_RE, '').trim(); if (inline) out[cur] += (out[cur] ? '\n' : '') + inline; continue; }
    if (cur) out[cur] += (out[cur] ? '\n' : '') + line;
  }
  for (const k of Object.keys(out)) out[k] = out[k].trim();
  return out;
}

/** `<Subject 2> 是 <Picture 2> 中的角色「韩悠兰」——外貌…` → { subject:2, picture:2, name:'韩悠兰', line:'<Picture 2>：角色「韩悠兰」——外貌…' } */
function parseSubjectLine(line) {
  const m = String(line).match(/^\s*[-*·•]?\s*<Subject\s+(\d+)>\s*(?:是|is)\s*(.*)$/i);
  if (!m) return null;
  const subjectN = Number(m[1]);
  const rest = m[2].trim();
  const img = rest.match(/<Picture\s+(\d+)>/i);
  const nameM = rest.match(/[「『"]([^」』"]+)[」』"]/);
  const name = nameM ? nameM[1].trim() : '';
  let lean = '';
  if (img) {
    // 把「<Subject N> 是 <Picture M> 中的X」压成「<Picture M>：X」
    lean = rest.replace(new RegExp('^<Picture\\s+' + img[1] + '>\\s*中的?\\s*', 'i'), '<Picture ' + img[1] + '>：').trim();
    if (!/^<Picture\s+\d+>/.test(lean)) lean = `<Picture ${img[1]}>：` + lean;
    else if (!/^<Picture\s+\d+>\s*[:：]/.test(lean)) lean = lean.replace(/^(<Picture\s+\d+>)/, '$1：');
  } else {
    lean = '画面主体' + (name ? `「${name}」` : '') + '——' + rest.replace(/^画面中的?|^本片|^本镜/, '').trim();
  }
  return { subjectN, pictureN: img ? Number(img[1]) : null, name, lean };
}

function toLean(text, opts = {}) {
  const maxPic = Number(opts.maxPictures);
  const sec = parseSections(text);
  if (!sec.detailed_description) return { ok: false, reason: 'no detailed_description' };
  if (!sec.subject_definitions && /^\s*detailed_description\s*[:：]/i.test(text)) return { ok: false, reason: 'already-lean' };

  const map = new Map();       // subjectN -> { name, pictureN, lean }
  const pictureLines = [];     // 保序
  for (const raw of (sec.subject_definitions || '').split('\n')) {
    const line = raw.trim();
    if (!line) continue;
    const p = parseSubjectLine(line);
    if (p) {
      map.set(p.subjectN, p);
      // 越界的 <Picture N>（该镜根本没有第 N 张图）不写进映射行，否则质检会判「引用了不存在的参考图」
      if (p.pictureN && (!Number.isFinite(maxPic) || p.pictureN <= maxPic)) pictureLines.push({ n: p.pictureN, line: p.lean });
      continue;
    }
    // 环境约束行 / 音频声明行：环境约束保留，悬空 <Audio> 声明丢弃
    if (/<Audio\s+\d+>/i.test(line)) continue;
    if (/<Picture\s+\d+>/i.test(line)) {
      const n = Number((line.match(/<Picture\s+(\d+)/) || [])[1]) || 999;
      if (!Number.isFinite(maxPic) || n <= maxPic) pictureLines.push({ n, line });
    }
  }
  pictureLines.sort((a, b) => a.n - b.n);

  const nameOf = (subjectN) => {
    const e = map.get(subjectN);
    if (!e) return '';
    return e.name || (e.pictureN ? `参考图${e.pictureN}` : `主体${subjectN}`);
  };
  const swapSubjects = (t) => {
    let out = String(t || '').replace(/<Subject\s+(\d+)>/gi, (m, n) => nameOf(Number(n)) || m);
    if (Number.isFinite(maxPic)) {
      // 正文里越界的 <Picture N> 换成名字（认识就换名字，不认识就删掉引用）
      out = out.replace(/<Picture\s+(\d+)>/gi, (m, n) => {
        const idx = Number(n);
        if (idx <= maxPic) return m;
        for (const [, e] of map) if (e.pictureN === idx) return e.name || '';
        return '';
      });
    }
    return out.replace(/\s{2,}/g, ' ');
  };

  // 去重复：「禁止宫格/分屏/并列」这类约束只在映射行后那条环境约束里写一次，
  // 正文里重复的那半句删掉（否则提交时应用还会再加一行 lead，一共三遍）。
  const hasEnvConstraint = /禁止成片复刻其分格或并列布局|禁止成片复刻参考图/.test(text);
  const stripGridClause = (t) => {
    if (!hasEnvConstraint) return t;
    return String(t || '')
      .replace(/，?\s*无分格、?无分屏/g, '')
      .replace(/，?\s*无宫格分屏、?无并列构图/g, '')
      .replace(/，?\s*也不存在宫格或分屏画面/g, '')
      .replace(/，?\s*无任何分格或并列布局/g, '')
      .replace(/，?\s*无宫格\/分屏|，?\s*禁止成片复刻参考图的多宫格\/分屏\/并列布局/g, '');
  };

  const out = [
    ...pictureLines.map((p) => p.line),
    '',
    'detailed_description:',
    stripGridClause(swapSubjects(sec.detailed_description)),
    '',
    'overall_soundscape:',
    swapSubjects(sec.overall_soundscape || ''),
    '',
    'non_diegetic_music:',
    (sec.non_diegetic_music || '无（不使用背景音乐）。').trim(),
  ];
  return { ok: true, text: out.join('\n').replace(/\n{3,}/g, '\n\n').trim() };
}

const db = new Database(DB_PATH);
const where = [];
const args = [];
if (sbIds.length) { where.push(`id IN (${sbIds.map(() => '?').join(',')})`); args.push(...sbIds); }
else if (epId) { where.push('episode_id = ?'); args.push(epId); }
else if (dramaId) { where.push('episode_id IN (SELECT id FROM episodes WHERE drama_id = ? AND deleted_at IS NULL)'); args.push(dramaId); }
const rows = db.prepare(
  `SELECT id, storyboard_number, episode_id, scene_id, characters, creation_mode, universal_segment_text FROM storyboards
    WHERE deleted_at IS NULL AND ${where.join(' AND ')} ORDER BY episode_id, storyboard_number, id`
).all(...args);
if (!rows.length) { console.error('没有匹配的分镜'); process.exit(2); }

const backup = [];
let converted = 0, skippedLean = 0, skippedOther = 0;
for (const r of rows) {
  const src = String(r.universal_segment_text || '');
  if (!src.trim()) { skippedOther++; continue; }
  const res = toLean(src, { maxPictures: buildSlotsForStoryboard(db, r).length });
  if (!res.ok) { (res.reason === 'already-lean' ? skippedLean++ : skippedOther++); continue; }
  converted++;
  if (converted <= 2) {
    console.log(`\n──── 例：分镜 #${r.storyboard_number}（id=${r.id}） ${src.length} → ${res.text.length} 字`);
    console.log(res.text.split('\n').slice(0, 6).map((l) => '  ' + l.slice(0, 120)).join('\n'));
  }
  backup.push({ id: r.id, before: src, after: res.text });
  if (WRITE) db.prepare('UPDATE storyboards SET universal_segment_text = ?, updated_at = ? WHERE id = ?')
    .run(res.text, new Date().toISOString(), r.id);
}
if (WRITE && backup.length) {
  const bak = path.join(ROOT, 'data', `lean_ust_backup_${Date.now()}.json`);
  fs.writeFileSync(bak, JSON.stringify(backup, null, 1));
  console.log('\n备份: ' + bak);
}
console.log(`\n${WRITE ? '已写入' : '预览'}：转成精简格式 ${converted} 条；已是精简格式 ${skippedLean} 条；跳过 ${skippedOther} 条`);
if (!WRITE) console.log('（加 --write 才真正写库）');
db.close();
