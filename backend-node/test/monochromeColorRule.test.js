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

/**
 * 角色参考表：版面必须**无文字**。
 * 实测：旧规范强制「标题栏文字必须清晰可读 + 各分区英文标签 + 材质短标签」，
 * Z-Image 画出来的是乱码字（FACE HERO CHOSE-UP / REXHIENT NOTAL / 竖排拼音垃圾）。
 */
test('角色参考表系统提示词：禁止任何文字，且不再要求标题栏/标签', () => {
  const en = promptI18n.getRoleGenerateImagePrompt();
  assert.equal(/title text must be legible/i.test(en), false, '不该再要求标题文字清晰可读');
  assert.equal(/Panel titles and material tags printed ON the reference sheet are required/i.test(en), false);
  assert.match(en, /ZERO lettering/);
  assert.match(en, /no title bar/i);
  assert.match(en, /separated by thin light-gray lines ONLY/);
  // 材质那格改成"画面表达"而不是"文字标签"
  assert.equal(/MATERIAL & TEXTURE NOTES \(short tags only/i.test(en), false);
  assert.match(en, /MATERIAL \/ TEXTURE DETAIL/);
});

test('角色参考表文本AI提示词：不再指定标题文字与分区标签名', () => {
  const zh = promptI18n.getRolePolishPrompt({ app: { language: 'zh' }, style: { default_style_en: 'ink wash' } });
  assert.equal(/【标题栏】/.test(zh), false, '输出格式里不该再有标题栏');
  assert.equal(/标题条应显示的标题文字/.test(zh), false);
  assert.match(zh, /版面禁止任何文字/);
  assert.match(zh, /材质细节特写/);
  for (const caps of ['FRONT VIEW', 'BACK VIEW', 'SIDE PROFILE CLOSE-UP', 'FACE HERO CLOSE-UP', 'MATERIAL & TEXTURE NOTES']) {
    assert.equal(new RegExp(caps.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).test(zh), false, '输出格式里还残留英文标签 ' + caps);
  }
});
