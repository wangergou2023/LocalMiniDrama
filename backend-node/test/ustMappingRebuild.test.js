/**
 * 全能片段（ust）参考图映射行的**确定性重建**回归。
 *
 * 真实 bug（用户实测，第四集 episode_id=27 前三镜「两个女生角色对调」）：
 *   ust 头部的 `<Picture N>：角色「…」` 映射行由 AI 写，与**提交时按 characters[] 算出的
 *   真实槽位顺序**不一致 —— 参考图接对了，文本却把人物指错，模型就照着错文本换脸。
 *   · sb1091：AI 写 2=韩悠兰、3=韩悠兰（同一名字重复）、4=刘美云；真实 2=刘美云、3=韩悠兰、4=吴家昌
 *   · sb1092：AI 写 2=韩悠兰、3=吴家昌、4=刘美云（整体错一位）；真实 2=吴家昌、3=刘美云、4=韩悠兰
 *   · sb1099：AI 写了根本不存在的 4 号槽位
 * 修复：**以槽位表为唯一真相，删掉头部已有映射行、按 slots 顺序整块重写**
 *      （utils/segmentRefBinding.replacePictureMappingLines），出片前
 *      comfyuiClient.applyH3RefsToApi 再用权威 labels 重建一次。
 */
const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const {
  repairSegmentRefBinding,
  checkSegmentRefBinding,
  replacePictureMappingLines,
} = require('../src/utils/segmentRefBinding');
const { applyH3RefsToApi } = require('../src/services/comfyuiClient');

// ── 真实 ust 文本（storyboards 表 episode_id=27，原样抄录，未做任何改写）──
const SB1091 = `<Picture 1>：场景「房间」——沿用其空间结构、光线与氛围。
<Picture 2>：角色「韩悠兰」——外貌、发型与服装来自该图。
<Picture 4>：角色「刘美云」——外貌、发型与服装来自该图。
<Picture 3>：角色「韩悠兰」——其外貌、发型与服装来自该图。
环境、光影与陈设定性参考 <Picture 1>。若 <Picture 1> 为宫格或多画面拼图，禁止成片复刻其分格或并列布局，仅提取统一的空间、光线与氛围语义；须单镜头完整连续画面。
detailed_description:
Live-action Chinese family melodrama, realistic interior daylight, muted warm tones, natural skin texture, no on-screen text anywhere in frame.
[Shot 1] 中景，平视，手持跟拍机位，镜头始终贴在两人之间。前两秒刘美云从画面右侧快步逼近坐在床沿的韩悠兰，五指扣住她的手臂猛地往床下拉；第三秒起韩悠兰反手撑住床沿、上半身后仰挣扎，两人拉扯间撞翻床头柜上的玻璃水杯，水杯砸落地面碎成几片。刘美云 (S3) says, <d>[Chinese] 我搞你？你败坏我们吴家的家风，今天我就要把你扫地出门！</d> 说话期间镜头保持基本稳定，只留极轻的手持呼吸起伏；她说完后镜头下压半尺，画面里韩悠兰被拽得半跪在地，右臂被碎玻璃划出一道血痕。表演细节：刘美云先是眉心拧紧、下颌绷住（起），看到血之后指尖一颤、呼吸变促（变）；韩悠兰则先咬住下唇死撑，随后睫毛猛地一抖、肩膀缩起。
overall_soundscape:
室内安静底噪，布料摩擦声、手臂拉扯的闷响、玻璃杯落地碎裂的清脆响声，两人急促的呼吸与低喘；除对白外无其他人声。
non_diegetic_music:
无（不使用背景音乐）。`;

const SB1092 = `<Picture 1>：场景「房间」——沿用其空间结构、光线与氛围。
<Picture 2>：角色「韩悠兰」——外貌、发型与服装来自该图。
<Picture 3>：角色「吴家昌」——外貌、发型与服装来自该图。
<Picture 4>：角色「刘美云」——外貌、发型与服装来自该图。
环境、光影与陈设定性参考 <Picture 1>。若 <Picture 1> 为宫格或多画面拼图，禁止成片复刻其分格或并列布局，仅提取统一的空间、光线与氛围语义；须单镜头完整连续画面。
detailed_description:
Live-action Chinese family melodrama, realistic interior daylight, muted warm tones, natural skin texture, no on-screen text anywhere in frame.
[Shot 1] 远景起幅转中景，平视，手持跟拍。前两秒房门被猛地撞开撞在墙上，吴家昌冲进房间，镜头随他向屋内横移；第三秒起镜头跟着他蹲身扶起跌坐在地的刘美云，随后他猛地转身，一脚踢在蜷缩于床边的韩悠兰身上，镜头随这一脚轻微前送。表演细节：吴家昌进门前眉心紧锁、胸口起伏剧烈（起），扶起母亲时下颌骤然收紧、眼神变狠（变）；被踢中的韩悠兰整个人蜷成弓形、闷哼一声，手指抠进地板；刘美云借势抓紧吴家昌的手臂、肩膀上下发抖。本镜无人说话，画面中三人均无发声口型。
overall_soundscape:
门板撞墙的巨响、急促的脚步踩地声、衣料扑动、踢击闷响、身体倒地的钝响，以及三人粗重的呼吸；无对白。
non_diegetic_music:
无（不使用背景音乐）。`;

const SB1099 = `<Picture 1>：场景「河边不远处」——沿用其空间结构、光线与氛围。
<Picture 3>：角色「吴家昌」——外貌、发型与服装来自该图。
<Picture 4>：角色「刘美云」——外貌、发型与服装来自该图。
<Picture 2>：角色「刘美云」——其外貌、发型与服装来自该图。
环境、光影与陈设定性参考 <Picture 1>。若 <Picture 1> 为宫格或多画面拼图，禁止成片复刻其分格或并列布局，仅提取统一的空间、光线与氛围语义；须单镜头完整连续画面。
detailed_description:
Live-action Chinese family melodrama, bright riverside daylight with dappled tree shade, cool shadows against warm sunlight, no on-screen text anywhere in frame.
[Shot 1] 中景，侧面机位，轻微自然手持，树干把画面右侧切出一道暗边。刘美云 (S3) says, <d>[Chinese] 她真的跳了？</d> 说话期间镜头保持自然的手持起伏；随后画面里的吴家昌 (S2) says, <d>[Chinese] 跳了。</d> 他开口时镜头同样稳住不动。表演细节：刘美云发问时脖子前伸、手指扒着树皮（起），听到回答后眼睛睁大、嘴角先僵住再慢慢翘起（变）；吴家昌答话时目光始终钉在远处河面、喉结上下滚了一下，声音压得极低，说完嘴角有一丝极轻的抽动。
overall_soundscape:
树叶摩擦声、风掠过草坡的沙沙声、远处河水的流动声；两人对白音量压低，环境声占主导。
non_diegetic_music:
无（不使用背景音乐）。`;

// ── 真实槽位（顺序 = 提交时的参考图顺序：场景 → 角色，角色按 storyboard.characters[] 顺序）──
const SLOTS_1091 = [
  { index: 1, tag: '<Picture 1>', kind: '场景', name: '吴家' },
  { index: 2, tag: '<Picture 2>', kind: '角色', name: '刘美云' },
  { index: 3, tag: '<Picture 3>', kind: '角色', name: '韩悠兰' },
  { index: 4, tag: '<Picture 4>', kind: '角色', name: '吴家昌' },
];
const SLOTS_1092 = [
  { index: 1, tag: '<Picture 1>', kind: '场景', name: '吴家' },
  { index: 2, tag: '<Picture 2>', kind: '角色', name: '吴家昌' },
  { index: 3, tag: '<Picture 3>', kind: '角色', name: '刘美云' },
  { index: 4, tag: '<Picture 4>', kind: '角色', name: '韩悠兰' },
];
const SLOTS_1099 = [
  { index: 1, tag: '<Picture 1>', kind: '场景', name: '河边不远处' },
  { index: 2, tag: '<Picture 2>', kind: '角色', name: '刘美云' },
  { index: 3, tag: '<Picture 3>', kind: '角色', name: '吴家昌' },
];

const MAP_RE = /^\s*<Picture\s+(\d+)>\s*[:：]/;
const mappingLines = (t) => t.split('\n').filter((l) => MAP_RE.test(l));
const mappingNums = (t) => mappingLines(t).map((l) => l.match(/<Picture\s+(\d+)>/)[1]);
const bodyOf = (t) => t.slice(t.indexOf('detailed_description:'));
const constraintLine = (t) => t.split('\n').find((l) => /环境、光影与陈设定性参考/.test(l));

const EXPECT_1091 = [
  '<Picture 1>：场景「吴家」——沿用其空间结构、光线与氛围。',
  '<Picture 2>：角色「刘美云」——其外貌、发型与服装来自该图。',
  '<Picture 3>：角色「韩悠兰」——其外貌、发型与服装来自该图。',
  '<Picture 4>：角色「吴家昌」——其外貌、发型与服装来自该图。',
];
const EXPECT_1092 = [
  '<Picture 1>：场景「吴家」——沿用其空间结构、光线与氛围。',
  '<Picture 2>：角色「吴家昌」——其外貌、发型与服装来自该图。',
  '<Picture 3>：角色「刘美云」——其外貌、发型与服装来自该图。',
  '<Picture 4>：角色「韩悠兰」——其外貌、发型与服装来自该图。',
];

describe('ust 映射行按槽位表重建（真实文本回归）', () => {
  it('修复前的错文本必须被校验器报成 mismatch（不是只有 missing）', () => {
    const c1 = checkSegmentRefBinding(SB1091, SLOTS_1091, {});
    assert.ok(c1.mismatched.length > 0, 'sb1091 把 2/4 号名字写错，必须报 mismatch');
    const c2 = checkSegmentRefBinding(SB1092, SLOTS_1092, {});
    assert.ok(c2.mismatched.length > 0, 'sb1092 整体错一位，必须报 mismatch');
    const c3 = checkSegmentRefBinding(SB1099, SLOTS_1099, {});
    assert.deepEqual(c3.unknown, [4], 'sb1099 写了不存在的 4 号槽位');
  });

  it('sb1091：重复+错位 → 1=场景、2=刘美云、3=韩悠兰、4=吴家昌，无重复号，正文与约束句不变', () => {
    const rep = repairSegmentRefBinding(SB1091, SLOTS_1091, {});
    assert.ok(rep.changes.length > 0, '应当报告重建');
    assert.match(rep.changes[0], /映射行已按槽位表重建/);
    // 头部 4 行就是权威映射行块
    assert.deepEqual(mappingLines(rep.text), EXPECT_1091);
    // 没有重复号、没有越界号
    const nums = mappingNums(rep.text);
    assert.deepEqual(nums, ['1', '2', '3', '4']);
    assert.equal(new Set(nums).size, nums.length, '映射行编号不得重复');
    // 正文一字未改（detailed_description 及之后全部内容）
    assert.equal(bodyOf(rep.text), bodyOf(SB1091));
    // 环境约束句（含 <Picture 1> 的那句内联引用）还在，且未被当成映射行删掉
    assert.equal(constraintLine(rep.text), constraintLine(SB1091));
    assert.match(rep.text, /环境、光影与陈设定性参考 <Picture 1>。/);
    // 修复后校验全绿
    const c = checkSegmentRefBinding(rep.text, SLOTS_1091, {});
    assert.deepEqual([c.missing.length, c.unknown.length, c.mismatched.length], [0, 0, 0]);
  });

  it('sb1092：整体错一位 → 1=场景、2=吴家昌、3=刘美云、4=韩悠兰，正文与约束句不变', () => {
    const rep = repairSegmentRefBinding(SB1092, SLOTS_1092, {});
    assert.match(rep.changes[0], /映射行已按槽位表重建/);
    assert.deepEqual(mappingLines(rep.text), EXPECT_1092);
    assert.equal(bodyOf(rep.text), bodyOf(SB1092));
    assert.equal(constraintLine(rep.text), constraintLine(SB1092));
    const c = checkSegmentRefBinding(rep.text, SLOTS_1092, {});
    assert.deepEqual([c.missing.length, c.unknown.length, c.mismatched.length], [0, 0, 0]);
  });

  it('sb1099：不存在的 4 号槽位被删掉，只留 1/2/3', () => {
    const rep = repairSegmentRefBinding(SB1099, SLOTS_1099, {});
    assert.deepEqual(mappingNums(rep.text), ['1', '2', '3']);
    assert.equal(/<Picture 4>/.test(mappingLines(rep.text).join('\n')), false);
    assert.equal(bodyOf(rep.text), bodyOf(SB1099));
    const c = checkSegmentRefBinding(rep.text, SLOTS_1099, {});
    assert.deepEqual([c.missing.length, c.unknown.length, c.mismatched.length], [0, 0, 0]);
  });

  it('没有任何映射行时按槽位补全（保持原行为）', () => {
    // 把 sb1092 头部 4 行映射行删掉，模拟模型完全漏写
    const noMap = SB1092.split('\n').filter((l) => !MAP_RE.test(l)).join('\n');
    assert.equal(mappingLines(noMap).length, 0);
    const rep = repairSegmentRefBinding(noMap, SLOTS_1092, {});
    assert.deepEqual(mappingLines(rep.text), EXPECT_1092);
    assert.equal(bodyOf(rep.text), bodyOf(SB1092));
    assert.equal(constraintLine(rep.text), constraintLine(SB1092));
  });

  it('slots 为空时原样返回（没有任何参考图，不许动文本）', () => {
    const rep = repairSegmentRefBinding(SB1091, [], {});
    assert.equal(rep.text, SB1091);
    assert.deepEqual(rep.changes, []);
    assert.equal(repairSegmentRefBinding(SB1091, null).text, SB1091);
  });

  it('幂等：修好的文本再修一次不动', () => {
    const once = repairSegmentRefBinding(SB1091, SLOTS_1091, {});
    const twice = repairSegmentRefBinding(once.text, SLOTS_1091, {});
    assert.equal(twice.text, once.text);
    assert.deepEqual(twice.changes, []);
  });

  it('保留 <Audio j> 行与正文内联 <Picture N> 引用，只替换映射行', () => {
    const withAudio = SB1091.replace(
      '<Picture 3>：角色「韩悠兰」——其外貌、发型与服装来自该图。',
      '<Picture 3>：角色「韩悠兰」——其外貌、发型与服装来自该图。\n<Audio 1>：角色「刘美云」(S3) 的音色参考。'
    );
    assert.match(withAudio, /<Audio 1>：/);
    const rep = repairSegmentRefBinding(withAudio, SLOTS_1091, {});
    assert.deepEqual(mappingLines(rep.text), EXPECT_1091, '映射行重建为权威块');
    assert.match(rep.text, /<Audio 1>：角色「刘美云」\(S3\) 的音色参考。/, '<Audio 1> 行必须原样保留');
    assert.equal(bodyOf(rep.text), bodyOf(SB1091));
    // 正文段落里的内联 <Picture N>（不是行首映射行）不能被删
    const inline = 'detailed_description:\n[Shot 1] 环境、光影与陈设定性参考 <Picture 1>。走位见 <Picture 2>。\noverall_soundscape:\n无。\nnon_diegetic_music:\n无。';
    const two = [
      '<Picture 9>：角色「假人」——外貌来自该图。',
      inline,
    ].join('\n');
    const r2 = replacePictureMappingLines(two, ['<Picture 1>：场景「吴家」——沿用其空间结构、光线与氛围。']);
    assert.deepEqual(mappingLines(r2.text), ['<Picture 1>：场景「吴家」——沿用其空间结构、光线与氛围。']);
    assert.match(r2.text, /走位见 <Picture 2>。/, '正文里内联的 <Picture 2> 是引用，不能删');
    assert.equal(r2.text.slice(r2.text.indexOf('detailed_description:')), inline.slice(inline.indexOf('detailed_description:')));
  });

  it('replacePictureMappingLines：没有映射行或没有权威块时原样返回（changed=false）', () => {
    const r = replacePictureMappingLines('detailed_description:\n无。', ['<Picture 1>：场景「吴家」——沿用其空间结构、光线与氛围。']);
    assert.equal(r.changed, false);
    assert.equal(r.had, 0);
    const r2 = replacePictureMappingLines(SB1091, []);
    assert.equal(r2.changed, false);
    assert.equal(r2.text, SB1091);
  });
});

describe('applyH3RefsToApi：提交前用权威 labels 重建映射行（旧库文本也能出对片）', () => {
  const LABELS = [
    'scene background for "吴家"',
    'character appearance for "刘美云"',
    'character appearance for "韩悠兰"',
    'character appearance for "吴家昌"',
  ];
  const makePrompt = () => ({ '136': { class_type: 'MiniMaxH3ReferenceToVideo', inputs: { prompt: '' } } });

  it('库里的旧文本映射行写错 → 提交的 prompt 里被按参考图顺序重建', () => {
    const apiPrompt = makePrompt();
    const logs = [];
    const log = { info: (m, d) => logs.push([m, d]), warn: (m, d) => logs.push([m, d]) };
    applyH3RefsToApi(apiPrompt, ['p1.png', 'p2.png', 'p3.png', 'p4.png'], LABELS, SB1091, [], [], ['刘美云'], 8, log);
    const prompt = apiPrompt['136'].inputs.prompt;
    const head = prompt.split('\n').filter((l) => MAP_RE.test(l));
    assert.equal(head.length, 4, '映射行块应为 4 行');
    assert.match(head[0], /<Picture 1>：场景「吴家」环境参考/);
    assert.match(head[1], /角色「刘美云」/);
    assert.match(head[2], /角色「韩悠兰」/);
    assert.match(head[3], /角色「吴家昌」/);
    // 旧的错行被删掉，没有残留
    assert.equal(/<Picture 2>：角色「韩悠兰」/.test(prompt), false);
    assert.equal(/<Picture 4>：角色「刘美云」/.test(prompt), false);
    // 约束句与正文保留
    assert.match(prompt, /环境、光影与陈设定性参考 <Picture 1>。/);
    assert.match(prompt, /刘美云 \(S3\) says, <d>\[Chinese\] 我搞你？/);
    // 参考图接入顺序与 ref_image_* 编号一个字都没动
    for (let i = 0; i < 4; i++) {
      assert.deepEqual(apiPrompt['136'].inputs['ref_images.ref_image_' + i], ['h3_ld_i' + i, 0]);
      assert.equal(apiPrompt['h3_ld_i' + i].inputs.image, 'p' + (i + 1) + '.png');
    }
    // 日志
    const hit = logs.find(([m]) => /映射行已按槽位表重建/.test(m));
    assert.ok(hit, '必须记录「映射行已按槽位表重建」');
    assert.equal(hit[1].replaced_lines, 4);
    assert.equal(hit[1].rebuilt_lines, 4);
  });

  it('提交时保留正文里的 <Audio j> 行（只重写 Picture 映射行）', () => {
    const apiPrompt = makePrompt();
    const withAudio = SB1092.replace(
      '<Picture 4>：角色「刘美云」——外貌、发型与服装来自该图。',
      '<Picture 4>：角色「刘美云」——外貌、发型与服装来自该图。\n<Audio 1>：角色「韩悠兰」的音色参考。'
    );
    const logs = [];
    const log = { info: (m, d) => logs.push([m, d]), warn: (m, d) => logs.push([m, d]) };
    applyH3RefsToApi(apiPrompt, ['p1.png', 'p2.png', 'p3.png', 'p4.png'], LABELS, withAudio, ['a1.wav'], ['韩悠兰'], ['韩悠兰'], 8, log);
    const prompt = apiPrompt['136'].inputs.prompt;
    assert.match(prompt, /<Audio 1>：角色「韩悠兰」的音色参考。/, '<Audio j> 行必须保留');
    const head = prompt.split('\n').filter((l) => MAP_RE.test(l));
    assert.match(head[0], /<Picture 1>：场景「吴家」环境参考/, '1 号 = 场景（labels[0]）');
    assert.deepEqual(
      head.slice(1).map((l) => (l.match(/「([^」]+)」/) || [])[1]),
      ['刘美云', '韩悠兰', '吴家昌'],
      '角色映射行名字顺序 = 参考图提交顺序（labels[1..3]）'
    );
    assert.equal(apiPrompt['136'].inputs['ref_audios.ref_audio_0'][0], 'h3_ad_0');
  });

  it('labels 缺席（旧记录只有 URL 列表）时不动正文，沿用自带映射行', () => {
    const apiPrompt = makePrompt();
    const logs = [];
    const log = { info: (m, d) => logs.push([m, d]), warn: (m, d) => logs.push([m, d]) };
    applyH3RefsToApi(apiPrompt, ['p1.png', 'p2.png'], [], SB1091, [], [], [], 8, log);
    const prompt = apiPrompt['136'].inputs.prompt;
    assert.match(prompt, /<Picture 2>：角色「韩悠兰」/, '没有权威 labels 时不改正文');
    assert.ok(logs.some(([m]) => /缺少 labels，跳过映射行重建/.test(m)));
  });
});
