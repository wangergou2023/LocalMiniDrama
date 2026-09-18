/**
 * Ref2VA 官方六段结构的解析/校验/修复。
 *
 * 依据 h3-prompt-writing skill 的 references/ref-en.txt（§2-§6）。
 * 我们此前用自造的四行块格式，与官方有四处不符，最要命的是 §2.1/§2.2：
 * 把「只用来定义角色外貌的图」也当成 <Picture N> 在正文里满篇引用 —— 模型因此没有
 * 「角色」这个抽象层可用，才会出现「镜1 只 @ 了唐僧」「镜3 把八戒绑到金箍棒槽」。
 */
const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const {
  REF2VA_SECTIONS, parseRef2vaSections, validateRef2va, repairRef2va, buildRef2vaFallback,
} = require('../src/services/ref2vaFormat');

const GOOD = `subject_definitions:
<Subject 1> 是 <Picture 1> 中的「荒山野岭山道」——沿用其空间结构、光线与氛围。
<Subject 2> 是 <Picture 2> 中的角色「唐僧」——外貌、发型与服装来自该图。
<Audio 1> is the voice-timbre reference for <Subject 2> (S1).
summary:
黄昏山道上，<Subject 2> 骑马居中缓行。
retention_analysis:
<Subject 1> (appears in [Shot 1]): fully_preserved - 保留山道走向与昏黄光线。
<Subject 2> (appears in [Shot 1]): fully_preserved - 保留外貌与袈裟。
<Audio 1>: reference - 仅参考音色与语气。
detailed_description:
Ink-wash style with warm ochre dusk light over grey ink.
[Shot 1] <Subject 2> rides along <Subject 1> at an even pace, robes stirring in the wind.
[Shot 2] At 00:03.200, the camera cuts to a close shot of <Subject 2> (S1) saying, <d>[Chinese] 悟空住手！</d>
overall_soundscape:
风声与马蹄声贯穿全片。
non_diegetic_music:
无（不使用背景音乐）。`;

describe('Ref2VA 六段结构：解析与校验', () => {
  it('段顺序固定', () => {
    assert.deepEqual(REF2VA_SECTIONS, ['subject_definitions', 'summary', 'retention_analysis', 'detailed_description', 'overall_soundscape', 'non_diegetic_music']);
    assert.deepEqual(parseRef2vaSections(GOOD).order, REF2VA_SECTIONS);
  });

  it('合规样本通过', () => {
    const v = validateRef2va(GOOD, { availablePictures: 2, availableAudios: 1, durationSec: 8, maxShots: 4 });
    assert.deepEqual(v.problems, []);
    assert.equal(v.ok, true);
    assert.equal(v.shots.length, 2);
  });

  it('点出缺段与段顺序错误', () => {
    const bad = GOOD.replace('overall_soundscape:\n风声与马蹄声贯穿全片。\n', '');
    const v = validateRef2va(bad);
    assert.ok(v.problems.some((p) => /缺少段/.test(p) && /overall_soundscape/.test(p)), v.problems.join('|'));
  });

  it('retention_analysis 必须带固定英文标记，且不写 (Sx)', () => {
    const bad = GOOD.replace('<Subject 2> (appears in [Shot 1]): fully_preserved - 保留外貌与袈裟。', '<Subject 2> (appears in [Shot 1]): 保留了外貌 (S1)。');
    const v = validateRef2va(bad);
    assert.ok(v.problems.some((p) => /缺少 <标签>: 固定标记/.test(p)), v.problems.join('|'));
  });

  it('summary 不得引入未定义标签；<Audio j> 必须绑到 <Subject N>', () => {
    const v1 = validateRef2va(GOOD.replace('黄昏山道上，<Subject 2> 骑马居中缓行。', '黄昏山道上，<Subject 7> 骑马缓行。'));
    assert.ok(v1.problems.some((p) => /summary 引入了未定义的标签/.test(p)));
    const v2 = validateRef2va(GOOD.replace('<Audio 1> is the voice-timbre reference for <Subject 2> (S1).', '<Audio 1> is the voice-timbre reference.'));
    assert.ok(v2.problems.some((p) => /<Audio j> 定义未绑定/.test(p)));
  });

  it('[Shot 1] 不带时间戳、后续必须带且不能超出本镜时长', () => {
    const v1 = validateRef2va(GOOD.replace('[Shot 1] <Subject 2>', '[Shot 1] At 00:01.000, <Subject 2>'));
    assert.ok(v1.problems.some((p) => /\[Shot 1\] 不应带时间戳/.test(p)));
    const v2 = validateRef2va(GOOD, { durationSec: 3 });
    assert.ok(v2.problems.some((p) => /超出本镜时长/.test(p)));
  });

  it('检出越界标签与废弃的 @图片N', () => {
    const v = validateRef2va(GOOD + '\n@图片9 出现', { availablePictures: 2 });
    assert.ok(v.problems.some((p) => /废弃的 @图片N/.test(p)), v.problems.join('|'));
    const v2 = validateRef2va(GOOD.replace('<Picture 2> 中的角色', '<Picture 9> 中的角色'), { availablePictures: 2 });
    assert.ok(v2.problems.some((p) => /引用了不存在的/.test(p)));
  });
});

describe('Ref2VA 机械修复：保住 detailed_description', () => {
  it('缺 retention/soundscape/music 时补齐，不整条替换', () => {
    const partial = GOOD
      .replace(/retention_analysis:[\s\S]*?detailed_description:/, 'detailed_description:')
      .replace(/overall_soundscape:[\s\S]*$/, '');
    const r = repairRef2va(partial, { soundscapeFallback: '山风呜咽。' });
    assert.equal(r.fatal, false);
    const v = validateRef2va(r.text, { availablePictures: 2, availableAudios: 1, durationSec: 8 });
    assert.equal(v.ok, true, v.problems.join('|'));
    assert.match(r.text, /Ink-wash style with warm ochre dusk light/, '模型写的正文必须还在');
    assert.match(r.text, /fully_preserved/);
  });

  it('缺 detailed_description 判 fatal（不凭空造镜头）', () => {
    const r = repairRef2va('subject_definitions:\n<Subject 1> 是 <Picture 1> 中的「山道」。\n');
    assert.equal(r.fatal, true);
  });
});

describe('Ref2VA 兜底模板：与正常产出同格式（精简格式）', () => {
  it('产出能通过自己的校验，且槽位全部映射', () => {
    const slots = [
      { index: 1, tag: '<Picture 1>', kind: '场景', name: '荒山野岭山道' },
      { index: 2, tag: '<Picture 2>', kind: '角色', name: '唐僧' },
      { index: 3, tag: '<Picture 3>', kind: '道具', name: '金箍棒' },
    ];
    const t = buildRef2vaFallback({ location: '荒山野岭的山道', time: '傍晚' },
      { durationSec: 8, action: '唐僧勒马', atmosphere: '山风呼啸', dialogue: '唐僧：天色将晚。' },
      slots, { styleHint: 'Ink-wash style.', audioSlots: [{ index: 1, name: '唐僧', speakerId: 'S1' }] });
    const v = validateRef2va(t, { availablePictures: 3, availableAudios: 1, durationSec: 8, maxShots: 4 });
    assert.equal(v.ok, true, v.problems.join('|'));
    assert.equal(v.format, 'lean');
    // 兜底必须是精简格式：段名前三条映射行（场景/角色/道具），且不再出现被禁的 <Subject N>
    assert.match(t, /<Picture 1>：场景「荒山野岭山道」/);
    assert.match(t, /<Picture 2>：角色「唐僧」/);
    assert.match(t, /<Picture 3>：道具「金箍棒」/);
    assert.doesNotMatch(t, /<Subject\s+\d+>/);
    assert.doesNotMatch(t, /subject_definitions/);
    assert.match(t, /<Audio 1> is the voice-timbre reference for the character “唐僧” \(S1\)\./);
  });

  it('没有可用槽位时不编造 <Picture N>（只留三段正文）', () => {
    const t = buildRef2vaFallback({ location: '荒山野岭', time: '傍晚' },
      { durationSec: 8, action: '唐僧勒马', atmosphere: '山风呼啸' }, [], {});
    assert.doesNotMatch(t, /<Picture\s+\d+>/);
    assert.match(t, /detailed_description:/);
    assert.equal(validateRef2va(t, { durationSec: 8 }).ok, true, '无槽位的兜底也要自洽');
  });
});
