'use strict';
/**
 * 风格块注入位置（实测定稿）。
 *
 * 事故现场：vg76/vg77（drama 6 盘丝洞），风格块被贴在提示词最末尾（§6 之后），
 * 模型忽略它，画面按 §5 里 LLM 写的「warm green forest hues」画成彩色森林 —— 参考图（水墨场景）等于白给。
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const { injectStyleIntoVideoPrompt } = require('../src/utils/videoPromptStyle');

const STYLE = 'traditional Chinese ink wash painting, sumi-e style, monochrome brushwork';
const SIX = [
  'subject_definitions:',
  '<Subject 1> 是 <Picture 1> 中的「险山山道」。',
  'summary:',
  '师徒四人行于山道。',
  'retention_analysis:',
  '<Subject 1> (appears in [Shot 1]): fully_preserved - 保留山道结构。',
  'detailed_description:',
  'A mystical forest in ink tones. [Shot 1] A wide crane shot begins low.',
  'overall_soundscape:',
  '山风穿林声。',
  'non_diegetic_music:',
  '无（不使用背景音乐）。',
].join('\n');

test('风格块写进 §5 段首（[Shot 1] 之前），不再贴末尾', () => {
  const out = injectStyleIntoVideoPrompt(SIX, STYLE);
  const iSection = out.indexOf('detailed_description:');
  const iStyle = out.indexOf('Style: ' + STYLE);
  const iShot = out.indexOf('[Shot 1]', iSection);   // retention 段里也有 [Shot 1]，只看 §5 之后的
  assert.ok(iStyle > iSection, out);
  assert.ok(iStyle < iShot, '风格句必须在 [Shot 1] 之前：' + out);
  assert.equal(out.trimEnd().endsWith('无（不使用背景音乐）。'), true, '末尾不该再有 Style 尾巴：' + out);
});

test('已经包含风格块时不重复注入', () => {
  const once = injectStyleIntoVideoPrompt(SIX, STYLE);
  const twice = injectStyleIntoVideoPrompt(once, STYLE);
  assert.equal(twice, once);
  assert.equal(twice.split(STYLE).length - 1, 1);
});

test('大小写不同也算已包含（避免重复）', () => {
  const withUpper = SIX.replace('detailed_description:', `detailed_description:\nStyle: ${STYLE.toUpperCase()}`);
  assert.equal(injectStyleIntoVideoPrompt(withUpper, STYLE), withUpper);
});

test('非六段结构退回旧行为：贴末尾，且不产生空提示词', () => {
  const out = injectStyleIntoVideoPrompt('一只猴子在云上翻跟头。', STYLE);
  assert.equal(out, `一只猴子在云上翻跟头。. Style: ${STYLE}`);
  assert.equal(injectStyleIntoVideoPrompt('', STYLE), `Style: ${STYLE}`);
  assert.equal(injectStyleIntoVideoPrompt('原文', ''), '原文');
  assert.equal(injectStyleIntoVideoPrompt(null, STYLE), `Style: ${STYLE}`);
});

test('实际提交过的坏提示词会被纠正到 §5', () => {
  // 复刻 vg76 提交时的形态：六段 + 末尾 Style 尾巴
  const bad = `${SIX}. Style: ${STYLE}`;
  const fixed = injectStyleIntoVideoPrompt(bad, STYLE);
  const iSection = fixed.indexOf('detailed_description:');
  assert.ok(iSection >= 0, fixed);
  assert.ok(fixed.indexOf('Style: ' + STYLE) > iSection, fixed);
  assert.ok(fixed.indexOf('Style: ' + STYLE) < fixed.indexOf('[Shot 1]', iSection), fixed);
  assert.equal(/Style: .*monochrome brushwork\s*$/.test(fixed), false, '风格块不该还留在末尾：' + fixed);
});

test('不再出现「末尾追加风格块」的旧实现', () => {
  const src = require('fs').readFileSync(require('path').join(__dirname, '../src/routes/videos.js'), 'utf8');
  assert.equal(/prompt = prompt \? `\$\{prompt\}\. Style:/.test(src), false, 'videos.js 仍有末尾拼接风格块的旧代码');
  assert.match(src, /injectStyleIntoVideoPrompt/);
});
