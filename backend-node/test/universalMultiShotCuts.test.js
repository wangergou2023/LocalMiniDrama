/**
 * H3 镜内剪辑点（同一次生成内的多镜头）格式回归测试。
 *
 * 背景：`universalOmniMultiBeatFormat.js` 里原先写着「H3 是单镜头连续画面模型，不支持切镜」，
 * 于是 `chooseBeatCount()` 恒返回 1、校验器把「>1 镜」直接判失败、修复函数还会把它折叠回单镜。
 * 但官方 H3 提示词规范明确支持一次生成内多镜头：
 *   `[Shot 1] … [Shot 2] At 00:05.000, the camera cuts to a close-up of …`
 * （Ref2VA 的 detailed_description 也是 shot by shot，带 `[Shot N] At MM:SS.mmm,` 剪辑点；
 *  全篇唯一的「偏好单镜」是 FL2VA 专属。）
 *
 * 实测代价：drama2 镜10「花果山对峙」9 秒写成单镜后，前 ~8 秒全被定场与运镜吃掉，
 * 真正的「抡起金箍棒当头劈下 / 抄棒横架」只挤在最后 ~0.8 秒。打斗要连续，就得靠一次生成内的切拍。
 *
 * 本测试锁住四件事：
 *   1. 合法的多镜正文通过校验（且必须配多镜形态的 LINE3）
 *   2. 非法的剪辑点序列被逐条指出（时间倒挂 / 超时长 / 跳号 / 首镜带时间戳 / 超过 4 镜）
 *   3. 修复函数**不会**把多镜折叠成单镜，只换掉自相矛盾的第 3 行
 *   4. 单镜（历史格式）行为完全不变 —— 向后兼容是硬要求
 */
const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const {
  DEFAULT_LINE3,
  LINE3_MULTI,
  MAX_INTRA_SHOTS,
  formatCutMarker,
  parseCutMarkers,
  checkCutMarkers,
  parseBeatDurationSec,
  pickUniversalLine3,
  isUniversalLine3,
  isMultiShotLine3,
  detectFightShot,
  firstCombatRatio,
  FIGHT_TAIL_CRUSH_RATIO,
  FIGHT_INTRA_SHOTS,
  summarizeUniversalSegmentFormat,
  validateUniversalSegmentText,
  repairUniversalSegmentText,
} = require('../src/services/universalOmniMultiBeatFormat');

const STYLE = '画面风格和类型: 中国传统水墨画风格，泼墨写意技法';
const DECL = '生成一个由以下 1 个分镜组成的视频。';

/** 拼一条 ust；beatBody 是「分镜1： T秒: 」之后的内容 */
function makeUst(beatBody, { durationSec = 9, line3 = LINE3_MULTI } = {}) {
  return [STYLE, DECL, line3, `分镜1： ${durationSec}秒: ${beatBody}`].join('\n');
}

/** 一段双猴对打的 3 镜正文 */
function fightBody() {
  return (
    formatCutMarker(1) + ' 承接上一镜余势，@图片2 悟空落在 @图片1 石台之前，众小猴惊叫四散。' +
    formatCutMarker(2, 3) + ', the camera cuts to 近景：@图片2 抡圆 @图片4 金箍棒当头劈下，棒身拉出凌厉弧线。' +
    formatCutMarker(3, 5.6) + ', the camera cuts to @图片3 抄棒横架，两棒相交迸出火星，气浪荡开一圈尘雾。无对白。'
  );
}

describe('H3 镜内剪辑点：记号本身', () => {
  it('formatCutMarker / parseCutMarkers 往返一致', () => {
    const body = fightBody();
    const cuts = parseCutMarkers(body);
    assert.equal(cuts.length, 3);
    assert.equal(cuts[0].n, 1);
    assert.equal(cuts[0].atSec, null, '首镜不带时间戳');
    assert.equal(cuts[1].atSec, 3);
    assert.equal(cuts[2].atSec, 5.6);
    assert.equal(cuts[1].raw, '[Shot 2] At 00:03.000');
  });

  it('兼容官方两位分钟格式与三位小时格式', () => {
    assert.equal(parseCutMarkers('[Shot 2] At 00:03.200')[0].atSec, 3.2);
    assert.equal(parseCutMarkers('[Shot 2] At 00:00:03.200')[0].atSec, 3.2);
    assert.equal(parseCutMarkers('[Shot 3] At 01:23.250')[0].atSec, 83.25);
  });

  it('从「分镜1： T秒:」行读到本镜时长', () => {
    assert.equal(parseBeatDurationSec(makeUst(fightBody())), 9);
    assert.equal(parseBeatDurationSec('没有时长行'), null);
  });

  it('MAX_INTRA_SHOTS 与官方示例一致地保守（4）', () => {
    assert.equal(MAX_INTRA_SHOTS, 4);
  });
});

describe('H3 镜内剪辑点：校验', () => {
  it('合法的 3 镜打斗正文通过', () => {
    assert.deepEqual(validateUniversalSegmentText(makeUst(fightBody())), { ok: true, problems: [] });
  });

  it('时间未递增被指出', () => {
    const body = fightBody().replace('At 00:05.600', 'At 00:02.600');
    const v = validateUniversalSegmentText(makeUst(body));
    assert.equal(v.ok, false);
    assert.ok(v.problems.some((p) => /未递增/.test(p)), v.problems.join('|'));
  });

  it('剪辑点超出本镜时长被指出', () => {
    const body = fightBody().replace('At 00:05.600', 'At 00:12.600');
    const v = validateUniversalSegmentText(makeUst(body));
    assert.equal(v.ok, false);
    assert.ok(v.problems.some((p) => /超出本镜时长/.test(p)), v.problems.join('|'));
  });

  it('编号跳号被指出', () => {
    const body = fightBody().replace('[Shot 3]', '[Shot 4]');
    const v = validateUniversalSegmentText(makeUst(body));
    assert.equal(v.ok, false);
    assert.ok(v.problems.some((p) => /不连续/.test(p)), v.problems.join('|'));
  });

  it('首镜带时间戳被指出', () => {
    const body = fightBody().replace('[Shot 1] ', '[Shot 1] At 00:01.000, ');
    const v = validateUniversalSegmentText(makeUst(body));
    assert.equal(v.ok, false);
    assert.ok(v.problems.some((p) => /\[Shot 1\] 不应带时间戳/.test(p)), v.problems.join('|'));
  });

  it('缺少时间戳被指出', () => {
    const body = '[Shot 1] 起势。[Shot 2] 直接劈下。';
    const v = validateUniversalSegmentText(makeUst(body));
    assert.equal(v.ok, false);
    assert.ok(v.problems.some((p) => /缺少剪辑时间戳/.test(p)), v.problems.join('|'));
  });

  it('超过 4 镜被指出', () => {
    const extra = ' [Shot 4] At 00:07.000, the camera cuts to x。 [Shot 5] At 00:08.000, the camera cuts to y。';
    const v = validateUniversalSegmentText(makeUst(fightBody() + extra));
    assert.equal(v.ok, false);
    assert.ok(v.problems.some((p) => /上限/.test(p)), v.problems.join('|'));
  });

  it('多镜正文配单镜形态 LINE3（自相矛盾）被指出', () => {
    const v = validateUniversalSegmentText(makeUst(fightBody(), { line3: DEFAULT_LINE3 }));
    assert.equal(v.ok, false);
    assert.ok(v.problems.some((p) => /单镜形态 LINE3/.test(p)), v.problems.join('|'));
  });

  it('checkCutMarkers 不误报单镜正文', () => {
    assert.deepEqual(checkCutMarkers('镜头缓推，无剪辑点。', 9), []);
  });
});

describe('H3 镜内剪辑点：修复', () => {
  it('不会把多镜折叠成单镜，只把第 3 行换成多镜形态', () => {
    const bad = makeUst(fightBody(), { line3: DEFAULT_LINE3 });
    const rep = repairUniversalSegmentText(bad, { styleZh: '中国传统水墨画风格，泼墨写意技法' });
    assert.equal(rep.fatal, false);
    assert.equal(parseCutMarkers(rep.text).length, 3, '三个剪辑点必须原样保留');
    assert.equal(isMultiShotLine3(rep.text), true, '第3行应换成多镜形态');
    assert.equal(validateUniversalSegmentText(rep.text, { styleZh: '中国传统水墨画风格，泼墨写意技法' }).ok, true);
  });

  it('单镜正文不动骨架（向后兼容）', () => {
    const single = makeUst('镜头从 @图片1 缓缓推近，@图片2 抬头，无对白。', { line3: DEFAULT_LINE3 });
    const rep = repairUniversalSegmentText(single, { styleZh: '中国传统水墨画风格，泼墨写意技法' });
    assert.equal(rep.fatal, false);
    assert.deepEqual(rep.changes, []);
    assert.equal(rep.text, single);
  });

  it('仍然把「分镜2：」多行判为 fatal（那是我们库里的分镜条目，不是 H3 的镜头）', () => {
    const legacy = [STYLE, DECL, DEFAULT_LINE3, '分镜1： 5秒: 甲。', '分镜2： 5秒: 乙。'].join('\n');
    const rep = repairUniversalSegmentText(legacy);
    assert.equal(rep.fatal, true);
    assert.ok(rep.changes.some((c) => /多个子分镜行/.test(c)), rep.changes.join('|'));
  });
});

describe('H3 镜内剪辑点：LINE3 形态', () => {
  it('pickUniversalLine3 依据镜内镜头数选句子', () => {
    assert.equal(pickUniversalLine3(true, 1), DEFAULT_LINE3);
    assert.equal(pickUniversalLine3(true, 3), LINE3_MULTI);
    assert.match(pickUniversalLine3(false, 3), /允许镜内切镜/);
  });

  it('多镜形态的 LINE3 不含「须单镜头完整连续画面」', () => {
    assert.equal(/须单镜头完整连续画面/.test(LINE3_MULTI), false);
    assert.equal(/禁止成片宫格/.test(LINE3_MULTI), true, '防复刻参考拼图的原意必须保留');
  });

  it('isUniversalLine3 认「参考图N」写法的第3行（MiniMax 官方 r2va 用词）', () => {
    const withRefWord = LINE3_MULTI.replace(/@图片1/g, '参考图1');
    assert.equal(isUniversalLine3(withRefWord), true);
  });
});

describe('H3 镜内剪辑点：打斗镜判定', () => {
  // 词表按「真假美猴王」21 镜的真实字段标定：只靠单字动词会漏掉一半打斗镜。
  const CASES = [
    ['一棒打晕', '假悟空抡起金箍棒横扫，一棒击中唐僧后脑，唐僧应声倒地。', '唐僧倒在枯草中昏迷不醒。', true],
    ['花果山对峙', '真悟空一个筋斗翻到花果山，见假悟空高坐石台正教小猴念经，抡起金箍棒当头就打。', '假悟空举棒相迎，两棒相交迸出火花，两猴怒目相对。', true],
    ['打到南海', '两猴从云端打到南海，落在观音菩萨面前，齐齐跪地请菩萨辨明真假。', '观音菩萨端坐莲台。', true],
    ['金钵罩猴', '假悟空腾身要走，如来将金钵盂抛下罩住猕猴，真悟空抡棒一棒将其打死。', '六耳猕猴现出原形倒地。', true],
    // 非打斗：只有「金箍棒」这个道具不该被判成打斗
    ['金箍棒画圈', '悟空手持金箍棒在师徒四人周围地面画出一个金色光圈，随后纵身驾云腾空而去。', '悟空的身影消失在天际云层中。', false],
    ['假猴辱骂', '假悟空手提金箍棒从空中落下，对着唐僧恶狠狠地开口辱骂。', '假悟空面目狰狞，金箍棒高举。', false],
    ['火冒三丈', '悟空听完沙僧讲述，双目圆睁，毛发倒竖，握紧金箍棒怒吼。', '悟空一个筋斗翻上云端。', false],
    ['悟空含泪', '悟空跪在唐僧面前，抬起头，眼中含泪，声音哽咽。', '悟空眼中泪水滑落。', false],
    ['重新上路', '师徒四人重新上路，夕阳下四道身影缓缓前行。', '四人身影渐行渐远。', false],
  ];

  for (const [title, action, result, want] of CASES) {
    it(`${want ? '打斗' : '非打斗'}：${title}`, () => {
      assert.equal(detectFightShot({ title, action, result }).fight, want);
    });
  }

  it('FIGHT_INTRA_SHOTS 在 2-4 的合法区间内', () => {
    assert.ok(FIGHT_INTRA_SHOTS >= 2 && FIGHT_INTRA_SHOTS <= MAX_INTRA_SHOTS);
  });

  it('空字段不误判', () => {
    assert.equal(detectFightShot({}).fight, false);
    assert.equal(detectFightShot(null).fight, false);
  });
});

describe('H3 镜内剪辑点：打斗节奏自检（只报真问题）', () => {
  const row = (over) => ({ creation_mode: 'universal', universal_segment_text: makeUst(fightBody()), ...over });
  /** 造一条「定场很长、交锋在最后面」的 9 秒 ust —— 实测问题镜的形态 */
  const tailCrushed = () => {
    const preamble = '单镜头连续画幅，参考拼图只用于把握空间层次与明亮日光走向；' +
      '承接上一镜腾云破空而去的余势，云头墨气尚未散尽，@图片2 已落在 @图片1 石台之前，' +
      '机位自石阶下缘缓缓向前推近，暖阳斜照，洞口瀑布如帘垂落，水雾被光切成细碎银点；' +
      '@图片3 高坐石台之上，正闭目教小猴诵经，众小猴环坐两侧，见生人闯入纷纷惊叫四散；' +
      '@图片2 定睛一看，怒从心起，掌中 @图片4 金箍棒抡圆了当头劈下。无对白。';
    return makeUst(preamble, { line3: DEFAULT_LINE3 });
  };

  it('打斗镜定场挤压（交锋在正文 55% 之后、且镜头够长）→ 报出来', () => {
    const s = summarizeUniversalSegmentFormat([
      row({ id: 1, storyboard_number: 10, title: '花果山对峙', duration: 9, action: '抡起金箍棒当头就打', result: '两棒相交迸出火花', universal_segment_text: tailCrushed() }),
    ]);
    assert.equal(s.fights_without_cuts, 1);
    assert.ok(s.fights_without_cuts_samples[0].combat_at_percent > 55, JSON.stringify(s.fights_without_cuts_samples));
  });

  it('短交锋单镜**不报**（1-2 拍本来就该单镜）——初版规则在这里报过 8 条假警', () => {
    // 注意 ust 必须是**单镜**写法：默认的 row() 用的是 3 镜打斗正文，那会被算成「已切拍」
    const single = makeUst('镜头甩拍，@图片2 假悟空抡起 @图片4 铁棒狠狠朝 @图片3 唐僧肩头砸去，@图片3 应声落马。无对白。', { durationSec: 6, line3: DEFAULT_LINE3 });
    const s = summarizeUniversalSegmentFormat([
      row({ id: 10, storyboard_number: 10, title: '一棒打昏唐僧', duration: 6, action: '假悟空抡起铁棒，狠狠朝唐僧肩头砸去，唐僧应声落马。', result: '唐僧昏死过去。', universal_segment_text: single }),
      row({ id: 12, storyboard_number: 12, title: '假猴扫翻行李腾云', duration: 6, action: '假悟空一棒扫翻行李担子，腾云而去。', result: '身影没入暮色云层。', universal_segment_text: single }),
    ]);
    assert.equal(s.fights_without_cuts, 0);
    assert.equal(s.fight_single_beat, 2);
  });

  it('已在分镜层面拆成连续镜的打斗段**不报**（相邻镜也是打斗镜且同地点）', () => {
    const loc = '花果山水帘洞内';
    const single = makeUst('镜头甩拍，@图片2 悟空一棒砸向 @图片3 假猴肩头，@图片3 矮身避过。无对白。', { durationSec: 6, line3: DEFAULT_LINE3 });
    const fights = [24, 25, 26].map((n, i) => row({
      id: n, storyboard_number: n, location: loc, duration: 6,
      title: '连打' + (i + 1), action: '悟空一棒砸向假猴肩头，假猴矮身避过。', result: '两棒相交迸出火花。',
      universal_segment_text: single,
    }));
    const s = summarizeUniversalSegmentFormat(fights);
    assert.equal(s.fights_without_cuts, 0, '分镜层面已拆开就不需要镜内切拍');
    assert.ok(s.fight_split_sequence >= 2);
  });

  it('非打斗镜却切了拍 → 仍然报（可能是模型自行加的）', () => {
    const s = summarizeUniversalSegmentFormat([row({ id: 2, title: '如来嘱托', duration: 8, action: '如来端坐莲台，缓缓开口嘱托。', result: '悟空躬身行礼。' })]);
    assert.equal(s.cuts_without_fight, 1);
    assert.equal(s.multi_shot, 1);
  });

  it('description 里抄进去的台词语不能当成打斗（drama4 镜16 的假警来源）', () => {
    const sb = {
      title: '八戒举耙对准悟空',
      action: '八戒举起钉耙对准悟空胸口，满脸怒容。',
      result: '钉耙尖齿抵近悟空胸前，悟空愣住。',
      dialogue: '八戒：你还装！方才你一棒打昏师父，抢了行李就跑！',
      description: '【动作】八戒举起钉耙对准悟空胸口。【对话】八戒：你还装！方才你一棒打昏师父！',
    };
    assert.equal(detectFightShot(sb).fight, false, 'dialogue 是在说「发生过的事」，不代表本镜有打斗');
  });

  it('firstCombatRatio 能定位交锋出现的相对位置', () => {
    assert.ok(firstCombatRatio(tailCrushed()) > FIGHT_TAIL_CRUSH_RATIO);
    const early = makeUst('镜头甩拍，@图片2 假悟空抡起铁棒狠狠朝 @图片3 唐僧肩头砸去。无对白。');
    assert.ok(firstCombatRatio(early) < FIGHT_TAIL_CRUSH_RATIO);
    assert.equal(firstCombatRatio('没有动作的纯风景镜。'), null);
  });
});
