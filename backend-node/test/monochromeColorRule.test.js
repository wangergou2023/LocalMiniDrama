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

test('规范只维护一套（中文）：英文设置下输出同一份文本', () => {
  const zhMono = spec('zh', MONO);
  assert.equal(spec('en', MONO), zhMono);
  assert.match(zhMono, /单色项目硬规则/);

  const zhPhoto = spec('zh', PHOTO);
  assert.equal(spec('en', PHOTO), zhPhoto);
  assert.equal(/单色项目硬规则/.test(zhPhoto), false);
});

test('判定覆盖中文画风词，且规范是精简三段', () => {
  const zhMono = spec('zh', '中国传统水墨画风格，泼墨写意技法，单色笔墨晕染');
  assert.match(zhMono, /单色项目硬规则/);
  for (const sec of ['detailed_description', 'overall_soundscape', 'non_diegetic_music']) {
    assert.ok(zhMono.includes(sec), '规范缺少段名 ' + sec);
  }
});

test('规范里不要出现未展开的模板占位（插入的是条件文案，不是 ${...} 字面量）', () => {
  for (const cfg of [spec('zh', MONO), spec('zh', PHOTO), spec('en', MONO), spec('en', PHOTO)]) {
    assert.equal(/\$\{monochromeStyle|\$\{_styleText|\$\{DEFAULT_LINE3\}/.test(cfg), false, cfg.slice(0, 200));
  }
});

test('单镜「生成全能提示词」这条路也吃到了硬规则（cfg 必须传进提示词构建器）', () => {
  const monoCfg = { app: { language: 'zh' }, style: { default_style_en: MONO } };
  assert.match(promptI18n.getUniversalOmniSegmentPrompt(monoCfg), /单色项目硬规则/);
  const photoCfg = { app: { language: 'zh' }, style: { default_style_en: PHOTO } };
  assert.equal(/单色项目硬规则/.test(promptI18n.getUniversalOmniSegmentPrompt(photoCfg)), false);
  // 无参调用不能炸（老调用点兼容）
  assert.ok(promptI18n.getUniversalOmniSegmentPrompt().length > 1000);
});

test('路由层给单镜提示词带上了项目画风 cfg', () => {
  const src = require('fs').readFileSync(require('path').join(__dirname, '../src/routes/storyboards.js'), 'utf8');
  assert.match(src, /styleCfgForStoryboard/);
  assert.match(src, /getUniversalOmniSegmentPrompt\(styleCfgForStoryboard\(db, sbId\)\)/);
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

/**
 * 分镜时长政策：一个分镜 = 一次连续拍摄；时长按内容动态给（上限＝项目「每段最大秒数」）。
 * 用户实测反馈：很多分镜本来就是**一个镜头、没有切镜**，却被按 5–10 秒硬切成了 26 个碎片。
 */
test('分镜规范：不再「宁多勿少/5 秒演不完就拆镜」，改为按内容动态给时长', () => {
  const p = require('../src/services/promptI18n');
  const suffix = p.getStoryboardUserPromptSuffix({ app: { language: 'zh' }, style: {} }, 15, { universalOmni: true });
  assert.match(suffix, /按内容动态决定/);
  assert.match(suffix, /上限 15 秒/);
  assert.equal(/宁多勿少/.test(suffix), false);
  assert.equal(/约15秒（项目配置），综合对话、动作、情绪可适当调整±1秒/.test(suffix), false, '旧的「约N秒±1」写法会鼓励切碎');
  const spec = p.getUniversalOmniMultiBeatFormatSpec({ app: { language: 'zh' }, style: { default_style_en: 'x' } });
  assert.equal(/5-10 秒目标/.test(spec), false);
  assert.match(spec, /动态决定/);
});

test('每集容量估算与新政策一致：740 字 ≈ 15 镜（不再是 22 镜 × 8 秒）', () => {
  const p = require('../src/services/promptI18n');
  assert.equal(p.EPISODE_TARGET_CHARS, 739);
  assert.equal(p.PLANNED_SHOT_SECONDS, 12);
  assert.equal(p.EPISODE_TARGET_SHOTS, 15);
  // 换算链自洽：镜数 × 规划秒数 × 4.2 字/秒 ≈ 每集字数
  const implied = p.EPISODE_TARGET_SHOTS * p.PLANNED_SHOT_SECONDS * 4.2;
  assert.ok(Math.abs(implied - p.EPISODE_TARGET_CHARS) < 60, `换算不自洽: ${implied} vs ${p.EPISODE_TARGET_CHARS}`);
});

/**
 * 碎镜的真瓶颈：光给"上限"不够。
 * 实测（drama7 ep21 重生成，01:38）：新政策只写"下限 3 秒、上限 15 秒"，
 * 模型照样按"拍"切成 25 条 5-6 秒的碎镜 —— 比改之前还碎。
 * 所以必须同时写死：常规 8-15 秒、对白时长换算、同一空间一镜到底。
 */
test('分镜规范：常规 8-15 秒 + 对白时长换算 + 同一空间一镜到底', () => {
  const p = require('../src/services/promptI18n');
  const suffix = p.getStoryboardUserPromptSuffix({ app: { language: 'zh' }, style: {} }, 15, { universalOmni: true });
  assert.match(suffix, /常规 8-15 秒/);
  assert.match(suffix, /台词字数 ÷ 4.2 \+ 1 秒/);
  assert.match(suffix, /一镜到底/);
  assert.match(suffix, /上限 15 秒/);
  const spec = p.getUniversalOmniMultiBeatFormatSpec({ app: { language: 'zh' }, style: { default_style_en: 'x' } });
  assert.match(spec, /常规 8-15 秒/);
  // 「不按拍拆镜 / 只有空间主体时间切换才拆镜」写在分镜系统提示里（不是通用六段规范里）
  const sys = p.getStoryboardSystemPrompt({ app: { language: 'zh' }, style: {} });
  assert.match(sys, /不要按拍拆镜/);
  assert.equal(/必须拆成多个分镜/.test(sys), false, '旧的「多动作必须拆镜」规则应已删除');
});

test('对白时长换算与项目既有语速常量一致（4.2 字/秒）', () => {
  const p = require('../src/services/promptI18n');
  const suffix = p.getStoryboardUserPromptSuffix({ app: { language: 'zh' }, style: {} }, 15, { universalOmni: true });
  assert.match(suffix, /4\.2 字\/秒/);
  // 12 字台词 ≈ 2.86s + 1 ≈ 3.9s → 四舍五入 8-15 秒常规区间内
  const need = Math.ceil(12 / 4.2) + 1;
  assert.ok(need >= 3 && need <= 15, String(need));
});

/**
 * 开思考后，分镜输出上限必须跟着放大。
 * 思考 token 计入 max_tokens：还按 16384 会让 JSON 正文更早被截断、续写更多（实测端点接受 32768+）。
 */
test('分镜 max_tokens：思考关闭 16384，思考开启 32768', () => {
  const fs = require('fs');
  const path = require('path');
  const src = fs.readFileSync(path.join(__dirname, '../src/services/episodeStoryboardService.js'), 'utf8');
  assert.match(src, /function storyboardMaxTokens\(db\)/);
  assert.match(src, /opts\.thinking === 'enabled'\) return 32768/);
  assert.match(src, /const maxTokens = storyboardMaxTokens\(db\)/);
  assert.match(src, /max_tokens: maxTokens/);
  // 常量仍是 16384（思考关闭时的值）
  const p = require('../src/services/episodeStoryboardService');
  assert.equal(p.DEFAULT_STORYBOARD_MAX_TOKENS, 16384);
});

test('deepseek 配置解析：enabled/disabled 都从 settings 正确读出', () => {
  const { resolveDeepSeekOptions } = require('../src/services/deepseekConfig');
  const base = { provider: 'deepseek', base_url: 'https://api.deepseek.com' };
  assert.equal(resolveDeepSeekOptions({ ...base, settings: '{"deepseek_thinking":"enabled","deepseek_reasoning_effort":"high"}' }, 'deepseek-v4-flash').thinking, 'enabled');
  assert.equal(resolveDeepSeekOptions({ ...base, settings: '{"deepseek_thinking":"disabled"}' }, 'deepseek-v4-flash').thinking, 'disabled');
  // 开思考时 reasoning_effort 生效、temperature 被删（DeepSeek 要求）
  const { applyDeepSeekChatOptions } = require('../src/services/deepseekConfig');
  const body = applyDeepSeekChatOptions({ ...base, settings: '{"deepseek_thinking":"enabled","deepseek_reasoning_effort":"high"}' },
    { model: 'deepseek-v4-flash', temperature: 0.7, messages: [] });
  assert.equal(body.thinking.type, 'enabled');
  assert.equal(body.reasoning_effort, 'high');
  assert.equal('temperature' in body, false);
});

/**
 * 运镜缺失（实测 drama7 ep21）：13 镜里只有 4 镜的 ust 提到运镜，而且是从 action 文本里碰巧漏进来的；
 * movement 字段有值的 9 镜（推镜/跟镜/升镜/甩镜/拉镜）一条没写；时间戳 0 —— 等于完全没给模型运镜信息。
 */
test('§5 规范：运镜按叙事需要（不硬凑）+ 镜内时间推进（起幅→过程→落幅）', () => {
  const p = require('../src/services/promptI18n');
  const spec = p.getUniversalOmniMultiBeatFormatSpec({ app: { language: 'zh' }, style: { default_style_en: 'x' } });
  assert.match(spec, /每镜必写清单/);
  assert.match(spec, /原样复用语义/);
  assert.match(spec, /镜内时间推进/);
  assert.match(spec, /起幅/);
  assert.match(spec, /落幅/);
  // 用户明确要求：别故意环绕 —— 没给 movement 就固定机位，禁止硬加运镜
  assert.match(spec, /严禁为了/);
  assert.match(spec, /固定机位同样合格/);
  assert.match(spec, /镜头怎么动（\*\*按叙事需要，不是必须动\*\*）/);
  // 反引号必须被处理掉（模板字符串内的裸反引号会让模块直接语法错误）
  assert.equal(/`/.test(spec.slice(spec.indexOf('每镜必写清单'), spec.indexOf('每镜必写清单') + 900)), false);
});

test('§5 规范是精简三段、模板变量正常展开', () => {
  const p = require('../src/services/promptI18n');
  const spec = p.getUniversalOmniMultiBeatFormatSpec({ app: { language: 'zh' }, style: { default_style_en: 'x' } });
  for (const k of ['detailed_description', 'overall_soundscape', 'non_diegetic_music']) {
    assert.ok(spec.includes(k), '缺段名 ' + k);
  }
  assert.equal(/\$\{[a-z]/i.test(spec), false, spec.slice(0, 200));
});

/**
 * 运镜缺失检查：movement 字段必须出现在 ust 正文里，否则成片是固定机位。
 * 实测 drama7 ep21：13 镜里 9 镜的 movement 被整段忽略。
 */
test('summarizeUniversalSegmentFormat 报出运镜缺失的镜', () => {
  const m = require('../src/services/universalOmniMultiBeatFormat');
  const mk = (id, movement, body) => ({
    id, creation_mode: 'universal', movement, duration: 10, storyboard_number: id,
    universal_segment_text: `subject_definitions:\n<Subject 1> x\nsummary:\ny\nretention_analysis:\nz\ndetailed_description:\n${body}\noverall_soundscape:\ns\nnon_diegetic_music:\nnone\n`,
  });
  const rows = [
    mk(1, '环绕orbit', 'The camera orbits around the cradle. [Shot 1] x'),
    mk(2, '推镜push', 'The camera holds still. [Shot 1] x'),
    mk(3, '跟镜tracking', 'A tracking shot follows the queen. [Shot 1] x'),
    mk(4, '', 'No movement field, should not be counted. [Shot 1] x'),
    mk(5, '固定static', 'A static locked-off frame. [Shot 1] x'),
  ];
  const r = m.summarizeUniversalSegmentFormat(rows);
  assert.equal(r.checked, 5);
  assert.equal(r.movement_missing, 1, JSON.stringify(r.movement_missing_sample));
  assert.equal(r.movement_missing_sample[0].id, 2);
});

test('长镜（≥8秒）没写镜内时间推进（第几秒）也会被报出来', () => {
  const m = require('../src/services/universalOmniMultiBeatFormat');
  const mk = (id, duration, body) => ({
    id, creation_mode: 'universal', movement: '', duration, storyboard_number: id,
    universal_segment_text: `subject_definitions:\n<Subject 1> x\nsummary:\ny\nretention_analysis:\nz\ndetailed_description:\n${body}\noverall_soundscape:\ns\nnon_diegetic_music:\nnone\n`,
  });
  const rows = [
    mk(1, 12, 'The camera holds, then in the first two seconds it starts a slow orbit. [Shot 1] x'),   // 有时间推进
    mk(2, 12, 'A static locked-off frame of the hall. [Shot 1] x'),                                     // 长镜但没时间推进
    mk(3, 5, 'A quick insert of the spindle. [Shot 1] x'),                                              // 短镜不检查
    mk(4, 13, '[Shot 1] x [Shot 2] At 00:03.200, the camera cuts to y'),                                // 有镜内剪辑点 = 有时间结构
  ];
  const r = m.summarizeUniversalSegmentFormat(rows);
  assert.equal(r.timeline_missing, 1, JSON.stringify(r.timeline_missing_sample));
  assert.equal(r.timeline_missing_sample[0].id, 2);
});

/**
 * 运镜动机库 + 剧情完整性优先 —— 适配自「字字动画」的镜头语言参考库/漫画分镜规范。
 * 用户明确说过"别故意环绕"，所以动机库把「固定镜头」列为默认，环绕只在关系/情绪转折点用。
 */
test('§5 规范：运镜必须带动机 + 反面清单', () => {
  const p = require('../src/services/promptI18n');
  const spec = p.getUniversalOmniMultiBeatFormatSpec({ app: { language: 'zh' }, style: { default_style_en: 'x' } });
  assert.match(spec, /运镜必须带动机/);
  assert.match(spec, /方向 \+ 速度 \+ 跟随对象 \+ 叙事目的/);
  assert.match(spec, /固定镜头＝让表演主导、克制观察（\*\*默认选择\*\*）/);
  assert.match(spec, /只在转折点用，不要每镜都绕/);
  assert.match(spec, /运镜反面清单/);
  assert.match(spec, /每镜都推近\/都环绕/);
});

test('§5 规范：剧情完整性优先（宁可加镜不省略剧情）', () => {
  const p = require('../src/services/promptI18n');
  const spec = p.getUniversalOmniMultiBeatFormatSpec({ app: { language: 'zh' }, style: { default_style_en: 'x' } });
  assert.match(spec, /剧情完整性优先/);
  assert.match(spec, /不得省略\/压缩原文的动作/);
  assert.match(spec, /4\.2 字\/秒/);
});

test('总时长覆盖统计：分镜总时长明显短于剧本朗读时长时能报出来', () => {
  const m = require('../src/services/universalOmniMultiBeatFormat');
  const rows = [1, 2].map((i) => ({ id: i, creation_mode: 'universal', duration: 10, storyboard_number: i, universal_segment_text: 'x' }));
  const r = m.summarizeUniversalSegmentFormat(rows, { scriptContent: '字'.repeat(420) }); // 420 字 ≈ 100 秒
  assert.equal(r.duration_coverage.script_seconds, 100);
  assert.equal(r.duration_coverage.shots_seconds, 20);
  assert.equal(r.duration_coverage.ratio, 0.2);
  assert.equal(r.duration_coverage.short_by, 80);
  // 没有剧本时不报（ratio=null）
  assert.equal(m.summarizeUniversalSegmentFormat(rows, {}).duration_coverage.ratio, null);
});

/**
 * 适配自「字字动画」的两条规范：
 *  #3 台词期间镜头固定（口型与运动叠加会糊掉嘴）
 *  #4 输出前必检（人物齐全/场景连贯/动作承接/台词合规/违禁内容）
 */
test('§5 规范：台词期间镜头固定 + 只有说话人有口型', () => {
  const p = require('../src/services/promptI18n');
  const zh = p.getUniversalOmniMultiBeatFormatSpec({ app: { language: 'zh' }, style: { default_style_en: 'x' } });
  assert.match(zh, /台词期间镜头固定/);
  assert.match(zh, /不切镜、不推拉、不环绕、不升降/);
  assert.match(zh, /要运镜就放在台词前后/);
  assert.match(zh, /只有当前说话人/);
  assert.match(zh, /不得/);
  // 规范只维护一套：英文设置下是同一份中文文本
  const en = p.getUniversalOmniMultiBeatFormatSpec({ app: { language: 'en' }, style: { default_style_en: 'x' } });
  assert.equal(en, zh);
});

test('§5 规范：输出前必检五项齐全', () => {
  const p = require('../src/services/promptI18n');
  const zh = p.getUniversalOmniMultiBeatFormatSpec({ app: { language: 'zh' }, style: { default_style_en: 'x' } });
  assert.match(zh, /输出前必检/);
  for (const k of ['人物齐全', '场景连贯', '动作承接', '台词合规', '违禁内容']) {
    assert.ok(zh.includes(k), '缺自检项 ' + k);
  }
  const en = p.getUniversalOmniMultiBeatFormatSpec({ app: { language: 'en' }, style: { default_style_en: 'x' } });
  assert.equal(en, zh);
  for (const k of ['人物齐全', '场景连贯', '动作承接', '台词合规', '违禁内容']) {
    assert.ok(en.includes(k), 'missing ' + k);
  }
});

test('对白镜运镜规则可执行化：默认固定机位 + 必须写台词时间点 + 台词窗内禁运动', () => {
  const p = require('../src/services/promptI18n');
  const zh = p.getUniversalOmniMultiBeatFormatSpec({ app: { language: 'zh' }, style: { default_style_en: 'x' } });
  assert.match(zh, /有台词的镜头默认固定机位/);
  assert.match(zh, /必须在正文里写出台词开始的时间点/);
  assert.match(zh, /禁止在台词时间窗内出现任何镜头运动词/);
});

test('分镜生成 user prompt 里带「本集总时长下限」硬数字', () => {
  const fs = require('fs');
  const path = require('path');
  const src = fs.readFileSync(path.join(__dirname, '../src/services/episodeStoryboardService.js'), 'utf8');
  assert.match(src, /durationFloorHint/);
  assert.match(src, /本集总时长下限 —— 硬性/);
  assert.match(src, /不得低于 \$\{minSec\} 秒/);
  assert.match(src, /TOTAL LENGTH FLOOR — HARD/);
  // 下限按 4.2 字/秒 × 95% 计算
  assert.match(src, /Math\.round\(scriptSec \* 0\.95\)/);
});

/**
 * [Shot N] 编号：每条 ust = 一次独立生成，第一拍永远是 [Shot 1]。
 * 实测 drama7 ep21（2026-09-15）：模型用分镜序号编号（镜2→[Shot 2]），15 镜里 14 镜被判不合规。
 */
test('规范写明：第一拍永远是 [Shot 1]，不得用分镜序号', () => {
  const p = require('../src/services/promptI18n');
  const zh = p.getUniversalOmniMultiBeatFormatSpec({ app: { language: 'zh' }, style: { default_style_en: 'x' } });
  assert.match(zh, /本镜第一拍永远是 \[Shot 1\]/);
  assert.match(zh, /不是 \[Shot 2\]/);
  const en = p.getUniversalOmniMultiBeatFormatSpec({ app: { language: 'en' }, style: { default_style_en: 'x' } });
  assert.equal(en, zh);
});

test('repairRef2va 会把误用的分镜序号重编号回 1..N', () => {
  const { repairRef2va, validateRef2va } = require('../src/services/ref2vaFormat');
  const bad = [
    'subject_definitions:', '- <Subject 1> 是 <Picture 1> 中的「宫殿」。',
    'summary:', '镜头自地面升起。',
    'retention_analysis:', '<Subject 1> (appears in [Shot 3]): fully_preserved - 沿用。',
    'detailed_description:', '[Shot 3] 中景。前三秒镜头前推。 [Shot 5] At 00:05.000, the camera cuts to 近景。',
    'overall_soundscape:', '环境声。', 'non_diegetic_music:', '无。',
  ].join('\n');
  const r = repairRef2va(bad, { durationSec: 12 });
  assert.equal(r.fatal, false);
  assert.ok(r.changes.some((c) => /重编号为 1\.\.2/.test(c)), JSON.stringify(r.changes));
  const dd = r.text.split('detailed_description:')[1];
  assert.match(dd, /\[Shot 1\]/);
  assert.match(dd, /\[Shot 2\] At 00:05\.000/);
  assert.equal(/\[Shot 3\]|\[Shot 5\]/.test(dd), false, dd);
  // 首拍已经是 [Shot 1] 时不动
  const good = bad.replace(/\[Shot 3\]/g, '[Shot 1]').replace('[Shot 5]', '[Shot 2]');
  const r2 = repairRef2va(good, { durationSec: 12 });
  assert.equal(r2.changes.some((c) => /重编号/.test(c)), false);
});

/**
 * 时间推进的写法识别：优化师补丁用「（0s→2s）」，人工可能写「（第0秒→第2秒）」。
 * 实测：补丁落库后检查器仍报"缺时间推进"，因为正则只认"前两秒/第3秒" —— 检查器与产出写法必须对齐。
 */
test('时间推进检查认区间写法：0s→2s / 第0秒→第2秒 / in the first two seconds', () => {
  const m = require('../src/services/universalOmniMultiBeatFormat');
  const mk = (id, duration, body) => ({
    id, creation_mode: 'universal', movement: '', duration, storyboard_number: id,
    universal_segment_text: `subject_definitions:\n<Subject 1> x\nsummary:\ny\nretention_analysis:\nz\ndetailed_description:\n${body}\noverall_soundscape:\ns\nnon_diegetic_music:\nnone\n`,
  });
  const rows = [
    mk(1, 12, '[Shot 1] 最早两秒静止（0s→2s），随后升起（2s→9s），最后定格（9s→12s）。'),
    mk(2, 12, '[Shot 1] 最早两秒静止（第0秒→第2秒），随后升起（第2秒→第9秒）。'),
    mk(3, 12, '[Shot 1] In the first two seconds the camera holds; from the third second onward it rises.'),
    mk(4, 12, '[Shot 1] 镜头缓缓升起，人物站在原地。'),   // 真的没写时间推进
    mk(5, 6, '[Shot 1] 短镜，一句话说完。'),             // 短镜不检查
  ];
  const r = m.summarizeUniversalSegmentFormat(rows);
  assert.equal(r.timeline_missing, 1, JSON.stringify(r.timeline_missing_sample));
  assert.equal(r.timeline_missing_sample[0].id, 4);
});

/**
 * 画面内禁止文字（实测 drama7《焚毁纺锤》vg95）：开场 0.1–1.2 秒把中文台词画成一片乱码字形贴在火焰上。
 * 台词只能靠口型+声音表达，绝不能靠画面文字。
 */
test('§5 规范：画面内禁止文字/乱码字，台词只靠口型+声音', () => {
  const p = require('../src/services/promptI18n');
  const zh = p.getUniversalOmniMultiBeatFormatSpec({ app: { language: 'zh' }, style: { default_style_en: 'x' } });
  assert.match(zh, /画面内禁止文字（硬规则）/);
  assert.match(zh, /不得出现任何文字/);
  assert.match(zh, /乱码字或伪字形/);
  assert.match(zh, /台词只能靠\*\*口型 \+ 声音\*\*表达/);
  assert.match(zh, /唯一例外/);
  const en = p.getUniversalOmniMultiBeatFormatSpec({ app: { language: 'en' }, style: { default_style_en: 'x' } });
  assert.equal(en, zh);
});

/**
 * 思考模式下的 max_tokens 下限（实测事故：storyboards/754 的全能提示词重生成给 2400，
 * 开思考后预算全被思考吃掉、正文 0 字 → 「AI 返回内容为空」，连续 3 次失败）。
 */
test('aiClient：思考模式下 max_tokens 自动抬到下限，并给空返回带上诊断信息', () => {
  const fs = require('fs');
  const path = require('path');
  const src = fs.readFileSync(path.join(__dirname, '../src/services/aiClient.js'), 'utf8');
  assert.match(src, /MIN_TOKENS_WITH_THINKING = 12000/);
  assert.match(src, /function isThinkingEnabled\(config, model\)/);
  assert.match(src, /思考模式下 max_tokens 过小，已上调/);
  assert.match(src, /reasoningChars \+= rc\.length/);
  assert.match(src, /思考输出 \$\{reasoningChars\} 字/);
  // 只有开启思考时才抬升
  assert.match(src, /isThinkingEnabled\(config, model\)/);
});

test('streamGenerateText 也吃到了思考模式的 max_tokens 下限（初版只补了 generateText）', () => {
  const fs = require('fs');
  const path = require('path');
  const src = fs.readFileSync(path.join(__dirname, '../src/services/aiClient.js'), 'utf8');
  const i = src.indexOf('async function streamGenerateText');
  assert.ok(i > 0);
  const seg = src.slice(i, i + 9000);
  assert.match(seg, /AI streamGenerateText: 思考模式下 max_tokens 过小，已上调/);
  assert.match(seg, /MIN_TOKENS_WITH_THINKING/);
  // 空返回诊断里的变量必须在本函数作用域内声明（初版引用了别的函数的变量 → ReferenceError）
  assert.match(seg, /let reasoningChars = 0/);
  assert.match(seg, /思考输出 \$\{reasoningChars\} 字/);
  assert.equal(/extraArgs/.test(seg), false, '不应再有未声明的 extraArgs');
});

/**
 * 对白镜切拍检查（实测 sb754《焚毁纺锤》）：44 字台词需要约 11 秒，却因 4 拍结构被切成两段 + <scenetrans>。
 * 判据是**台词长度**（超过单镜 15 秒上限才允许跨拍），不是"是不是打斗镜" —— 初版按打斗过滤，
 * 而这场对话戏被 detectFightShot 误判为打斗，于是真问题被静默吞掉。
 */
test('对白被切拍：台词能装下就必须单镜，超 15 秒才允许跨拍', () => {
  const m = require('../src/services/universalOmniMultiBeatFormat');
  const mk = (id, duration, body) => ({
    id, creation_mode: 'universal', movement: '', duration, storyboard_number: id, title: '对话戏',
    universal_segment_text: `subject_definitions:\n<Subject 1> x\nsummary:\ny\nretention_analysis:\nz\ndetailed_description:\n${body}\noverall_soundscape:\ns\nnon_diegetic_music:\nnone\n`,
  });
  const rows = [
    // 42 字 ≈ 11 秒 < 15 秒 → 不该跨拍（真问题）
    mk(1, 14, '[Shot 1] 中景。 [Shot 2] At 00:05.000, 切近景。 <d>[Chinese] 全国收缴所有纺锤，当众焚毁。士兵们闯入每一户人家，</d><scenetrans> [Shot 3] At 00:09.000, <d>[Chinese] 把纺锤扔进广场火堆，火焰冲天。</d>'),
    // 单句超 15 秒（>59 字）→ 允许跨拍
    mk(2, 15, `[Shot 1] 中景。 <d>[Chinese] ${'字'.repeat(70)}</d><scenetrans> [Shot 2] At 00:10.000, <d>[Chinese] 续句。</d>`),
    // 无切拍、有台词 → 不算
    mk(3, 10, '[Shot 1] 近景。 <d>[Chinese] 一句话。</d>'),
    // 有切拍但无台词 → 不算（打斗镜本来就允许切）
    mk(4, 12, '[Shot 1] 打斗。 [Shot 2] At 00:04.000, 反打。 [Shot 3] At 00:08.000, 收势。'),
  ];
  const list = m.checkDialogueCuts(rows);
  assert.equal(list.length, 2, JSON.stringify(list));
  const flagged = list.filter((x) => !x.allowed);
  assert.equal(flagged.length, 1, JSON.stringify(list));
  assert.equal(flagged[0].id, 1);
  assert.ok(flagged[0].need_sec <= 15, '需要的秒数应小于上限才判违规');
  assert.equal(list.find((x) => x.id === 2).allowed, true);
  const r = m.summarizeUniversalSegmentFormat(rows);
  assert.equal(r.dialogue_cut, 1);
});

