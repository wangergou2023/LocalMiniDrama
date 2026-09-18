/**
 * 全能片段（universal_segment_text）保留与参考图绑定的回归。
 *
 * 用户在界面上实测到的现象：**重新生成分镜后，「片段描述」里少了角色**（右边只有一句
 * 「<Subject 1> 为本镜场景的空间与光线来源。」）。根因是两条各自独立、又都被静默吞掉的 bug：
 *
 *   ① `ref2vaFormat.repairRef2va` 没有精简格式分支。而当前规范（promptI18n 的
 *      universal_multi_beat_format）**明确要求**精简格式（三段落 + 段名前 <Picture N> 映射行，
 *      禁止 subject_definitions / <Subject N>）。于是模型照规范写的正文一律被判
 *      「缺少 subject_definitions，无法机械修复」→ fatal → 整条 ust 被丢弃、换成兜底模板。
 *
 *   ② 兜底模板构建槽位时写的是 `buildSlotsForStoryboard(db, sb, …)`，而 `db` 根本不在
 *      `deriveStoryboardFieldsFromAi` 的作用域里 → ReferenceError → 被 `catch (_) {}` 吞掉
 *      → fbSlots 永远是空数组 → 兜底模板永远没有 <Picture N>，角色/道具全部消失。
 *
 * 两条都在这里钉住：精简格式必须**原样保住**，兜底必须**带上槽位**。
 */
const { describe, it } = require('node:test');
const assert = require('node:assert/strict');

const ref2va = require('../src/services/ref2vaFormat');
const { checkSegmentRefBinding, repairSegmentRefBinding, isLeanUst } = require('../src/utils/segmentRefBinding');

const SLOTS = [
  { index: 1, tag: '<Picture 1>', kind: '场景', name: '吴家' },
  { index: 2, tag: '<Picture 2>', kind: '角色', name: '韩悠兰' },
  { index: 3, tag: '<Picture 3>', kind: '道具', name: '鸡汤保温桶' },
];

const leanUst = [
  '<Picture 1>：场景「吴家」——沿用其空间结构、光线与氛围。',
  '<Picture 2>：角色「韩悠兰」——外貌、发型与服装来自该图。',
  '<Picture 3>：道具「鸡汤保温桶」——外形与材质来自该图。',
  '',
  'detailed_description:',
  'Korean romance webtoon style, soft pastel gradients.',
  '[Shot 1] 韩悠兰系着旧围裙，双手捧着鸡汤保温桶从厨房走出。',
  'overall_soundscape:',
  '脚步与厨房环境声自然延续。',
  'non_diegetic_music:',
  '无（不使用背景音乐）。',
].join('\n');

describe('精简格式 ust：机械修复不能把它判死', () => {
  it('规范要求的精简格式必须非 fatal，且 <Picture N> 映射行原样保留', () => {
    const rep = ref2va.repairRef2va(leanUst, {});
    assert.equal(rep.fatal, false, JSON.stringify(rep.changes));
    assert.match(rep.text, /<Picture 2>：角色「韩悠兰」/);
    assert.match(rep.text, /<Picture 3>：道具「鸡汤保温桶」/);
    assert.doesNotMatch(rep.text, /subject_definitions/);
  });

  it('缺声音两段时机械补齐，正文一字不改', () => {
    const partial = ['<Picture 1>：场景「吴家」——沿用其结构。', '', 'detailed_description:', '[Shot 1] 韩悠兰端着鸡汤走过过道。'].join('\n');
    const rep = ref2va.repairRef2va(partial, {});
    assert.equal(rep.fatal, false);
    assert.match(rep.text, /overall_soundscape:/);
    assert.match(rep.text, /non_diegetic_music:/);
    assert.match(rep.text, /韩悠兰端着鸡汤走过过道/);
    assert.ok(rep.changes.some((c) => c.includes('overall_soundscape')));
  });

  it('正文（detailed_description）缺失才算 fatal', () => {
    const rep = ref2va.repairRef2va('<Picture 1>：场景「吴家」——沿用其结构。\noverall_soundscape:\n声', {});
    assert.equal(rep.fatal, true);
  });

  it('[Shot N] 会用分镜序号时重编号为 1 开始', () => {
    const bad = leanUst.replace('[Shot 1]', '[Shot 7] At 00:00.000,');
    const rep = ref2va.repairRef2va(bad, {});
    assert.equal(rep.fatal, false);
    assert.match(rep.text, /\[Shot 1\]/);
    assert.doesNotMatch(rep.text, /\[Shot 7\]/);
  });

  it('六段格式仍走原分支（新分流不能把它带跑）', () => {
    const six = [
      'subject_definitions:',
      '<Subject 1> 是 <Picture 1> 中的「吴家」——沿用其空间结构、光线与氛围。',
      'summary:',
      '吴家，日；她端着鸡汤走过。',
      'retention_analysis:',
      '<Subject 1> (appears in [Shot 1]): fully_preserved - 沿用定义。',
      'detailed_description:',
      '[Shot 1] 她端着鸡汤从厨房走出。',
      'overall_soundscape:',
      '脚步与厨房环境声。',
      'non_diegetic_music:',
      '无（不使用背景音乐）。',
    ].join('\n');
    const rep = ref2va.repairRef2va(six, {});
    assert.equal(rep.fatal, false, JSON.stringify(rep.changes));
    assert.match(rep.text, /<Subject 1> 是 <Picture 1>/);
  });
});

describe('精简格式 ust：缺 <Picture N> 映射行必须被补上', () => {
  it('槽位没有映射行 → 判定 missing（哪怕正文提到了名字）', () => {
    const one = ['<Picture 1>：场景「吴家」——沿用其结构。', '', 'detailed_description:', '[Shot 1] 韩悠兰端着鸡汤保温桶走出。'].join('\n');
    assert.equal(isLeanUst(one), true);
    const c = checkSegmentRefBinding(one, SLOTS, { knownNames: [] });
    assert.deepEqual(c.missing.map((x) => x.name).slice().sort(), ['韩悠兰', '鸡汤保温桶'].slice().sort());
  });

  it('补出的映射行带正确的槽位号、类型与名字，且不动正文', () => {
    const one = ['<Picture 1>：场景「吴家」——沿用其结构。', '', 'detailed_description:', '[Shot 1] 韩悠兰端着鸡汤保温桶走出。'].join('\n');
    const rep = repairSegmentRefBinding(one, SLOTS, { knownNames: [] });
    assert.match(rep.text, /<Picture 2>：角色「韩悠兰」/);
    assert.match(rep.text, /<Picture 3>：道具「鸡汤保温桶」/);
    assert.match(rep.text, /\[Shot 1\] 韩悠兰端着鸡汤保温桶走出。/);
    // 补完之后不应再有 missing
    assert.deepEqual(checkSegmentRefBinding(rep.text, SLOTS, { knownNames: [] }).missing, []);
  });

  it('完整的三行映射不会被重复补', () => {
    const rep = repairSegmentRefBinding(leanUst, SLOTS, { knownNames: [] });
    assert.deepEqual(rep.changes, []);
    assert.equal(rep.text, leanUst);
  });
});
