'use strict';
/**
 * 单色项目的「颜色词」硬规则。
 *
 * 实测（drama 6 盘丝洞 vg77/vg79/vg81）：风格块写进 §5.1 后饱和从 0.358 降到 0.282，
 * 但 §5 正文里残留的 Warm / green / red 一直把成片拉回彩色森林 —— 一句风格块压不过整段散文。
 * 所以规范里必须按画风**条件性**禁止颜色形容词：单色项目只准写墨色浓淡与明暗。
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const promptI18n = require('../src/services/promptI18n');

const MONO = 'traditional Chinese ink wash painting, sumi-e style, monochrome brushwork';
const PHOTO = 'photorealistic, ultra-detailed, 8k uhd, sharp focus';

function spec(lang, styleEn) {
  return promptI18n.getUniversalOmniMultiBeatFormatSpec({ app: { language: lang }, style: { default_style_en: styleEn } });
}

test('中文规范：单色项目带硬规则，写实项目只带软规则', () => {
  const mono = spec('zh', MONO);
  assert.match(mono, /单色项目硬规则/);
  assert.match(mono, /warm \/ cool \/ golden/);
  assert.match(mono, /deep ink wash \/ pale ink/);

  const photo = spec('zh', PHOTO);
  assert.equal(/单色项目硬规则/.test(photo), false);
  assert.match(photo, /色彩基调以风格块为准/);
});

test('英文规范：同样条件性生效', () => {
  const mono = spec('en', MONO);
  assert.match(mono, /HARD RULE \(this project is monochrome\)/);
  assert.match(mono, /INK VALUES/);

  const photo = spec('en', PHOTO);
  assert.equal(/HARD RULE \(this project is monochrome\)/.test(photo), false);
  assert.match(photo, /Palette: follow the style block/);
});

test('判定覆盖中文画风词，且规范仍是六段结构', () => {
  const zhMono = spec('zh', '中国传统水墨画风格，泼墨写意技法，单色笔墨晕染');
  assert.match(zhMono, /单色项目硬规则/);
  for (const sec of ['subject_definitions', 'summary', 'retention_analysis', 'detailed_description', 'overall_soundscape', 'non_diegetic_music']) {
    assert.ok(zhMono.includes(sec), '规范缺少段名 ' + sec);
  }
});

test('规范里不要出现未展开的模板占位（插入的是条件文案，不是 ${...} 字面量）', () => {
  for (const cfg of [spec('zh', MONO), spec('zh', PHOTO), spec('en', MONO), spec('en', PHOTO)]) {
    assert.equal(/\$\{monochromeStyle|\$\{_styleText|\$\{DEFAULT_LINE3\}/.test(cfg), false, cfg.slice(0, 200));
  }
});

test('单镜「生成全能提示词 / 润色」这条路也吃到了硬规则（cfg 必须传进提示词构建器）', () => {
  const monoCfg = { app: { language: 'zh' }, style: { default_style_en: MONO } };
  assert.match(promptI18n.getUniversalOmniSegmentPrompt(monoCfg), /单色项目硬规则/);
  assert.match(promptI18n.getUniversalOmniPolishPrompt(monoCfg), /单色项目硬规则/);
  const photoCfg = { app: { language: 'zh' }, style: { default_style_en: PHOTO } };
  assert.equal(/单色项目硬规则/.test(promptI18n.getUniversalOmniSegmentPrompt(photoCfg)), false);
  // 无参调用不能炸（老调用点兼容）
  assert.ok(promptI18n.getUniversalOmniSegmentPrompt().length > 1000);
});

test('路由层给单镜提示词带上了项目画风 cfg', () => {
  const src = require('fs').readFileSync(require('path').join(__dirname, '../src/routes/storyboards.js'), 'utf8');
  assert.match(src, /styleCfgForStoryboard/);
  assert.match(src, /getUniversalOmniSegmentPrompt\(styleCfgForStoryboard\(db, sbId\)\)/);
  assert.match(src, /getUniversalOmniPolishPrompt\(styleCfgForStoryboard\(db, sbId\)\)/);
});
