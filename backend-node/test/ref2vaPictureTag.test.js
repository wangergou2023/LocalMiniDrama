/**
 * H3 参考标签约定：正文只认 <Picture N> / <Subject N>，@图片N 一律不接受。
 *
 * 背景：官方 Ref2VA 只认字面量 token `<Picture N>` / `<Subject N>`。曾经为了让界面能看出
 * 「这是第几张参考图」，规范要求在每个 `<Picture N>` 后加括号标注 `（@图片N）`；
 * 但后端的 `toPictureTags` 会把 `@图片N` 再转一次 `<Picture N>`，正文里就出现
 * `<Picture 1>（<Picture 1>）` 这种重复参考标签。现在改成由应用按编号自己显示素材对照，
 * 正文保持干净。这里锁住三条：
 *   ① 干净写法（只有 <Picture N> / <Subject N>）必须通过
 *   ② 裸 @图片N 必须报错
 *   ③ 旧的「（@图片N）」标注形态也必须报错，避免重复标签回归
 */
const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { validateRef2va } = require('../src/services/ref2vaFormat');
const { getUniversalOmniSegmentPrompt } = require('../src/services/promptI18n');

/** 拼一份结构完整的最小 Ref2VA 文档，只替换 §2 那一行 */
function doc(subjectLine) {
  return [
    'subject_definitions:',
    subjectLine,
    'summary:',
    '概述 <Subject 1>。',
    'retention_analysis:',
    '<Subject 1> (appears in [Shot 1]): fully_preserved - 沿用。',
    'detailed_description:',
    '[Shot 1] 中景。前三秒推近，第四秒起固定。',
    'overall_soundscape:',
    '环境声。',
    'non_diegetic_music:',
    '无（不使用背景音乐）。',
  ].join('\n');
}

describe('H3 参考标签：<Picture N> / <Subject N>', () => {
  it('干净写法通过校验', () => {
    const r = validateRef2va(doc('<Subject 1> 是 <Picture 1> 中的「山道」——沿用其空间与光线。'));
    assert.equal(r.problems.filter((p) => p.includes('@图片')).length, 0);
  });

  it('裸 @图片N 报错', () => {
    const r = validateRef2va(doc('@图片1 是「山道」——沿用其空间与光线。'));
    assert.ok(r.problems.some((p) => p.includes('@图片')));
  });

  it('旧的「（@图片N）」标注形态同样报错', () => {
    const r = validateRef2va(doc('<Subject 1> 是 <Picture 1>（@图片1）中的「山道」。'));
    assert.ok(r.problems.some((p) => p.includes('@图片')));
  });

  it('生成规范明确要求 H3 原生标签、禁止 @图片 与括号标注', () => {
    const spec = getUniversalOmniSegmentPrompt();
    assert.match(spec, /禁止\*\* @图片N/);
    assert.match(spec, /不要\*\*写「（@图片N）」/);
  });

  it('生成规范禁止在没有参考音频时出现 <Audio j>', () => {
    const spec = getUniversalOmniSegmentPrompt();
    assert.match(spec, /一律不要出现 <Audio j>/);
  });
});
