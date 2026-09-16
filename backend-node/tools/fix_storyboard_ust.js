#!/usr/bin/env node
'use strict';
/**
 * 确定性修正某个分镜的 §5（全能片段）—— 用于 LLM 只肯"部分听话"时收尾。
 *
 * 用法：
 *   node tools/fix_storyboard_ust.js <storyboard_id>          # dry-run，只打印将改动的内容
 *   node tools/fix_storyboard_ust.js <storyboard_id> --apply  # 写库（写前备份到 /tmp）
 *
 * 起因（drama7 ep21 sb754《焚毁纺锤》）：
 *   剧本原文「国王立刻下令：全国收缴所有纺锤，当众焚毁。士兵们闯入每一户人家，把纺锤扔进广场火堆，火焰冲天。」
 *   里只有第一句是台词，后半句是旁白。模型把整段写进 <d>，成片里国王念了一整段旁白；
 *   又因为台词被当成 44 字（约 11 秒），模型把镜头切成 4 拍用 <scenetrans> 跨拍念完；
 *   润色重跑后旁白、英文片段、多拍结构还会一起回来。LLM 每次都只修一部分，所以需要这个确定性收尾。
 *
 * 做四件事：
 *   ① 删掉"不是剧本台词"的 <d>…</d>（模型把旁白也包成了台词）
 *   ② 把成句的英文片段定向翻译成中文（只翻片段，其余文字不动）
 *   ③ 合并镜内多拍为单拍，并清理 At MM:SS.mmm / 中英切镜措辞 / 拍级用语
 *   ④ 补「台词期间锁机位」「画面内禁文字」两句硬规则（若缺）
 * 写库前：Ref2VA 格式校验 + 本镜 dialogue 字段台词必须完整保留。
 */
const fs = require('fs');
const path = require('path');
const ROOT = path.join(__dirname, '..');
const Database = require('better-sqlite3');
const db = new Database(path.join(ROOT, 'data/drama_generator.db'));
const ref2va = require(path.join(ROOT, 'src/services/ref2vaFormat'));
const { extractScriptDialogue } = require(path.join(ROOT, 'src/utils/dialogueCoverage'));

const SB_ID = Number(process.argv[2] || 0);
const APPLY = process.argv.includes('--apply');
if (!SB_ID) {
  console.error('用法: node tools/fix_storyboard_ust.js <storyboard_id> [--apply]');
  process.exit(1);
}

const brief = (t, n = 60) => JSON.stringify(String(t).slice(0, n));
const norm = (t) => String(t || '')
  .replace(/^\s*\[[^\]]*\]\s*/, '')
  .replace(/[\s“”"「」『』：:]/g, '')
  .trim();

/** 把 §5 里成句的英文片段译成中文（风格块那一行除外） */
async function translateEnglishRuns(text) {
  const styleLine = (text.match(/[A-Za-z][^\n]{0,120}(webtoon|style|anime|realistic|cinematic)[^\n]*/i) || [''])[0];
  const runs = [...new Set((text.match(/[A-Za-z][A-Za-z ,.'-]{29,}/g) || [])
    .map((x) => x.trim())
    .filter((x) => x && !styleLine.includes(x)))];
  if (!runs.length) return text;

  const aiClient = require(path.join(ROOT, 'src/services/aiClient'));
  const log = { info() {}, warn() {}, error() {} };
  const sys = '你是影视分镜翻译。把用户给的英文句子逐句译成**流畅的中文分镜语言**，'
    + '保持镜头/景别/运镜/动作/音效的准确，不加解释、不增删内容。只输出 JSON 数组，元素是 [英文原文, 中文译文]。';
  const out = await aiClient.generateText(db, log, 'text', JSON.stringify(runs), sys, {
    json_mode: true, max_tokens: 8000, temperature: 0.2,
  });

  const pickPairs = (v) => {
    if (Array.isArray(v)) {
      if (!v.length) return [];
      if (Array.isArray(v[0])) return v.filter((x) => x.length >= 2).map((x) => [x[0], x[1]]);
      if (v[0] && typeof v[0] === 'object') {
        return v.map((o) => [o.en || o.source || o.from || o.original || o.text,
          o.zh || o.target || o.to || o.translation || o.cn]).filter((x) => x[0] && x[1]);
      }
      return [];
    }
    if (v && typeof v === 'object') {
      for (const k of ['pairs', 'translations', 'items', 'result', 'data', 'output']) {
        if (v[k]) { const p = pickPairs(v[k]); if (p.length) return p; }
      }
    }
    return [];
  };
  let pairs = [];
  try { pairs = pickPairs(JSON.parse(out)); } catch (_) {
    const m = String(out).match(/\[[\s\S]*\]/);
    if (m) { try { pairs = pickPairs(JSON.parse(m[0])); } catch (_e) { pairs = []; } }
  }
  if (!pairs.length) {
    console.log('② 英文片段翻译返回无法解析，原文片段:', String(out).slice(0, 200));
    return text;
  }
  let next = text;
  let hit = 0;
  for (const pair of pairs) {
    const [en, zh] = pair;
    if (!en || !zh || !next.includes(en)) continue;
    next = next.split(en).join(String(zh));
    hit += 1;
  }
  console.log('② 英文片段定向翻译:', hit, '/', runs.length);
  return next;
}

(async () => {
  const row = db.prepare('SELECT id, episode_id, duration, dialogue, universal_segment_text t FROM storyboards WHERE id = ? AND deleted_at IS NULL').get(SB_ID);
  if (!row) throw new Error('分镜不存在: ' + SB_ID);

  const script = db.prepare('SELECT script_content FROM episodes WHERE id = ?').get(row.episode_id).script_content;
  const knownSpeakers = db.prepare(
    'SELECT name FROM characters WHERE drama_id = (SELECT drama_id FROM episodes WHERE id = ?) AND deleted_at IS NULL'
  ).all(row.episode_id).map((r) => r.name);
  const scriptLines = extractScriptDialogue(script, { knownSpeakers }).map((x) => x.line);
  const scriptKeys = scriptLines.map(norm);

  const parsed = ref2va.parseRef2vaSections(String(row.t || ''));
  const sec = parsed.sections;
  if (!Object.keys(sec).length) throw new Error('原文不是六段结构，无法修补');
  let dd = String(sec.detailed_description || '').trim();

  console.log('剧本台词:', JSON.stringify(scriptLines));
  console.log('改写前: 拍数', (dd.match(/\[Shot \d+\]/g) || []).length, '| <d> 数', (dd.match(/<d>/g) || []).length);

  // ① 删掉不是剧本台词的 <d> 块
  const removed = [];
  dd = dd.replace(/<d>([\s\S]*?)<\/d>/g, (full, inner) => {
    const k = norm(inner);
    const isScript = scriptKeys.some((s) => s && (k === s || k.startsWith(s)));
    if (isScript) return full;
    removed.push(String(inner).trim());
    return '';
  });
  dd = dd.replace(/<scenetrans>/g, '');
  console.log('① 移除旁白台词块:', removed.length, removed.map((x) => brief(x, 30)).join(' , '));
  console.log('   剩余 <d> 数:', (dd.match(/<d>/g) || []).length);

  // ② 英文片段定向翻译
  dd = await translateEnglishRuns(dd);

  // ③ 合并镜内多拍 → 单拍，并清理残留
  const markerRe = /\[Shot \d+\][^,，。;；]*?(?:At \d\d:\d\d\.\d\d\d[^,，。;；]*)?[,，]?/g;
  const markers = dd.match(markerRe) || [];
  if (markers.length > 1) {
    const bodies = dd.split(markerRe).map((x) => x.trim()).filter(Boolean);
    dd = '[Shot 1] ' + bodies.join(' ');
    dd = dd
      .replace(/\bAt \d\d:\d\d\.\d\d\d\s*[,，]?/g, ' ')
      .replace(/\[Shot \d+\]\s*/g, ' ')
      .replace(/(the camera cuts to|camera cuts to)\s*/gi, ' ')
      .replace(/(镜头)?切(至|到|向|换到)[^，。；]{0,24}[，,；]?/g, ' ')
      .replace(/本拍|这一拍|该拍/g, '本镜')
      .replace(/下一拍/g, '后段')
      .replace(/前一拍|上一拍/g, '前段')
      .replace(/\s{2,}/g, ' ')
      .replace(/\s+([。；，、])/g, '$1')
      .trim();
    dd = '[Shot 1] ' + dd.replace(/^\[Shot 1\]\s*/, '');
    console.log('③ 合并拍数:', markers.length, '→ 1');
  } else {
    console.log('③ 本来就是单拍');
  }

  // ④ 补硬规则
  if (!/台词期间镜头不推|台词期间镜头固定|只余极轻微自然手持|holds? (?:still|locked)/.test(dd)) {
    dd += ' 台词期间镜头不推、不拉、不摇、不环绕，只余极轻微自然手持，让表演主导画面。';
    console.log('④ 补：台词期间锁机位');
  }
  if (!/不得出现任何文字/.test(dd)) {
    dd += ' 画面内不得出现任何文字、字幕、招牌或浮字，也不得出现乱码字形；台词只靠口型与声音表达。';
    console.log('④ 补：画面内禁文字');
  }

  sec.detailed_description = dd;
  const out = ref2va.REF2VA_SECTIONS.map((k) => `${k}:\n${String(sec[k] || '').trim()}`).join('\n');

  const v = ref2va.validateRef2va(out, { durationSec: row.duration });
  const finalDlg = [...dd.matchAll(/<d>([\s\S]*?)<\/d>/g)].map((x) => x[1]);
  // 判据：**本镜 dialogue 字段里的台词**必须在（不能要求整集所有台词都出现在这一镜里）
  const quoted = [...String(row.dialogue || '').matchAll(/[“"「『]([^”"」』]+)[”"」』]/g)].map((x) => x[1]);
  const needLines = quoted.length ? quoted : scriptLines.filter((l) => out.includes(l));
  const kept = needLines.every((l) => norm(out).includes(norm(l)));

  console.log('\n格式校验:', v.ok ? '✅' : '❌ ' + v.problems.slice(0, 3).join('; '));
  console.log('最终台词:', finalDlg.map((x) => brief(x, 40)).join(' , ') || '（无）');
  console.log('本镜台词完整保留:', kept ? '✅' : '❌', needLines.map((x) => brief(x, 24)).join(' , '));
  console.log('拍数:', (dd.match(/\[Shot \d+\]/g) || []).length, '| scenetrans:', (dd.match(/<scenetrans>/g) || []).length, '| 总长', out.length);

  if (!v.ok || !kept) {
    console.log('❌ 校验未过，不写库');
    process.exit(1);
  }
  if (!APPLY) {
    console.log('\n（dry-run，加 --apply 才写库）');
    console.log('\n§5 新正文前 400 字：\n' + dd.slice(0, 400));
    return;
  }
  const bp = `/tmp/rollback_sb${SB_ID}_ust_${Date.now()}.json`;
  fs.writeFileSync(bp, JSON.stringify({ storyboard_id: SB_ID, before: row.t }, null, 1));
  db.prepare('UPDATE storyboards SET universal_segment_text = ?, updated_at = ? WHERE id = ?')
    .run(out, new Date().toISOString(), SB_ID);
  console.log('\n✅ 已写库（备份：' + bp + '）');
})().catch((e) => { console.error('失败:', e.message); process.exit(1); });
