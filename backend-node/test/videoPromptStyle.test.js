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

test('非六段结构（经典自由文本）不再追加风格 —— 界面所见即实际发送', () => {
  // 2026-09-22 需求变更：经典自由文本（「场景：…动作：…=VideoRatio: 16:9」）不再自动贴风格。
  // 旧行为 `prompt + '. Style: ' + style` 会让界面显示的提示词与实际发送的不一致
  // （实测分镜#280 末尾被贴上整段晶圆风格，用户无从判断到底发了什么）。
  const out = injectStyleIntoVideoPrompt('一只猴子在云上翻跟头。', STYLE);
  assert.equal(out, '一只猴子在云上翻跟头。', '自由文本应原样返回，不得追加风格');
  assert.equal(injectStyleIntoVideoPrompt('', STYLE), '', '空文本仍返回空，不产生 "Style: …"');
  assert.equal(injectStyleIntoVideoPrompt('原文', ''), '原文');
  assert.equal(injectStyleIntoVideoPrompt(null, STYLE), '');
  // 正文里若残留旧写法留下的尾巴，仍应被摘掉
  const legacy = `一只猴子在云上翻跟头。. Style: ${STYLE}`;
  assert.equal(injectStyleIntoVideoPrompt(legacy, STYLE), '一只猴子在云上翻跟头。', '旧尾巴应被摘掉');
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

test('LLM 自己写的风格句被替换掉（否则散文会压过风格块，画面变彩色）', () => {
  const withColor = SIX.replace(
    'A mystical forest in ink tones.',
    'The film is a fantasy rendered in ink-wash tones, with warm green forest hues.'
  );
  const out = injectStyleIntoVideoPrompt(withColor, STYLE);
  assert.equal(/warm green forest hues/.test(out), false, out);
  assert.equal(/A mystical forest in ink tones\./.test(out), false, out);
  const iSection = out.indexOf('detailed_description:');
  const iStyle = out.indexOf('Style: ' + STYLE);
  assert.ok(iStyle > iSection && iStyle < out.indexOf('[Shot 1]', iSection), out);
});

test('§5 里没有 [Shot N] 时退回「段首插入」，不删内容', () => {
  const noShot = SIX.replace('A mystical forest in ink tones. [Shot 1] A wide crane shot begins low.', 'A single still lake at dawn.');
  const out = injectStyleIntoVideoPrompt(noShot, STYLE);
  assert.match(out, /A single still lake at dawn\./);
  assert.match(out, /Style: traditional Chinese ink wash painting/);
});
