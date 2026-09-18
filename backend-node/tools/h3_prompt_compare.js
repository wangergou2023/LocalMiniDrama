#!/usr/bin/env node
/**
 * 对比打印：**库里存的片段描述** vs **最终交给 ComfyUI 的提示词**。
 *
 * 最终文本 = applyH3RefsToApi() 的产物（走应用本体的真实逻辑，不复制实现），
 * 所以这里打出来的就是要提交给 MiniMaxH3ReferenceToVideo 的那一份。
 *
 * 用法:
 *   node tools/h3_prompt_compare.js --sb 886
 *   node tools/h3_prompt_compare.js --vg 141        # 用某次生成记录的实际参考图/标签
 */
const path = require('path');
const fs = require('fs');
const Database = require('better-sqlite3');

const ROOT = path.resolve(__dirname, '..');
const db = new Database(path.join(ROOT, 'data', 'drama_generator.db'), { readonly: true });
const { applyH3RefsToApi } = require(path.join(ROOT, 'src', 'services', 'comfyuiClient.js'));

const argv = process.argv.slice(2);
const getArg = (k) => { const i = argv.indexOf(k); return i >= 0 ? argv[i + 1] : null; };
const sbId = Number(getArg('--sb')) || null;
const vgId = Number(getArg('--vg')) || null;
if (!sbId && !vgId) { console.error('需要 --sb <分镜 id> 或 --vg <生成记录 id>'); process.exit(2); }

const gen = vgId
  ? db.prepare('SELECT * FROM video_generations WHERE id = ?').get(vgId)
  : db.prepare('SELECT * FROM video_generations WHERE storyboard_id = ? ORDER BY id DESC LIMIT 1').get(sbId);
const sb = db.prepare('SELECT id, storyboard_number, episode_id, duration, universal_segment_text, video_prompt FROM storyboards WHERE id = ?').get(gen ? gen.storyboard_id : sbId);
if (!sb) { console.error('找不到分镜'); process.exit(2); }

let refs = [];
try { refs = gen && gen.reference_image_urls ? JSON.parse(gen.reference_image_urls) : []; } catch (_) {}
let audios = [];
try { audios = gen && gen.reference_audio_urls ? JSON.parse(gen.reference_audio_urls) : []; } catch (_) {}

const stored = String(sb.universal_segment_text || sb.video_prompt || '');
const refNames = refs.map((r, i) => `ref_${i}_${String(r.url || r).split('/').pop()}`);
const labels = refs.map((r) => (typeof r === 'object' ? r.type || '' : ''));

const apiPrompt = { '136': { class_type: 'MiniMaxH3ReferenceToVideo', inputs: {} } };
const header = applyH3RefsToApi(apiPrompt, refNames, labels, stored, [], [], [], Number(sb.duration) || 12, { info() {}, warn() {} }, null);
const finalPrompt = String(apiPrompt['136'].inputs.prompt || '');

function lineDiff(a, b) {
  // 逐行对齐比较（不用 includes 做 O(n²) 扫描，长行会卡死）
  const A = String(a).split('\n');
  const B = String(b).split('\n');
  const out = [];
  const n = Math.max(A.length, B.length);
  for (let i = 0; i < n; i++) {
    const x = A[i];
    const y = B[i];
    if (x === y) { if (x !== undefined) out.push('  ' + x); continue; }
    if (x !== undefined) out.push('- ' + x);
    if (y !== undefined) out.push('+ ' + y);
  }
  return out.join('\n');
}

console.log(`分镜 #${sb.storyboard_number}（id=${sb.id}）| 时长 ${sb.duration}s | 参考图 ${refs.length} 张 | 参考音频 ${audios.length} 段`);
console.log(`生成记录 vg${gen ? gen.id : '?'} | 状态 ${gen ? gen.status : '?'}`);
console.log('\n参考图接线（顺序 = <Picture N> 编号）：');
refNames.forEach((n, i) => console.log(`  <Picture ${i + 1}>  ← ${n}   [${labels[i] || '无标签'}]`));

console.log('\n════════ ① 库里存的片段描述（' + stored.length + ' 字）════════');
console.log(stored);
console.log('\n════════ ② 最终交给 ComfyUI 的提示词（' + finalPrompt.length + ' 字）════════');
console.log(finalPrompt);
console.log('\n════════ ③ 差异（- 片段描述独有 / + 最终提示词独有）════════');
console.log(lineDiff(stored, finalPrompt));

const stats = (t) => `长度 ${t.length} | <Picture N> ${(t.match(/<Picture \d+>/g) || []).length} | <Subject N> ${(t.match(/<Subject \d+>/g) || []).length} | <Audio j> ${(t.match(/<Audio \d+>/g) || []).length} | @图片 ${(t.match(/@图片/g) || []).length} | <d> ${(t.match(/<d>/g) || []).length}/${(t.match(/<\/d>/g) || []).length}`;
console.log('\n════════ ④ 统计 ════════');
console.log('  片段描述 : ' + stats(stored));
console.log('  最终提示词: ' + stats(finalPrompt));
console.log('  自动说明头: ' + (header ? JSON.stringify(header).slice(0, 60) : '(空 —— 正文自带 <Picture N> 映射，跳过自动说明头)'));
db.close();
