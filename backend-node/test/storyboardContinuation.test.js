/**
 * 分镜「续写」提示词回归测试。
 *
 * 为什么值得单独测：首轮响应受 `DEFAULT_STORYBOARD_MAX_TOKENS = 16384` 限制，
 * 实测约 **945 字/镜**（「真假美猴王」24 镜那次原始响应 22684 字），也就是单次最多约 24 个分镜。
 * 因此镜数一多，续写就**必然**发生：
 *   65 镜 ≈ 1 次首轮（24）+ 2 次续写（24 + 17）—— 占大部分的分镜都由续写产生。
 *
 * 而 `buildContinuationPrompt` 里的全能格式要求曾经是一句写死的**废弃文案**：
 *   「非空 universal_segment_text（单行：须含「叙事动态」时间线+「镜头」运镜链…）」
 * 那正是 universalOmniMultiBeatFormat 明令禁止、校验器会判脏的灵境/SoulLens 单行格式。
 * 首轮基本不触发续写时它一直没暴露；镜数一多就会让**大部分**分镜按旧格式生成，
 * 跑完（对 65 镜来说是八小时）才发现格式全是脏的。这里把它钉住。
 */
const { describe, it } = require('node:test');
const assert = require('node:assert/strict');

const svc = require('../src/services/episodeStoryboardService');
const { LINE3_MULTI } = require('../src/services/universalOmniMultiBeatFormat');

const ZH = { language: 'zh', app: { language: 'zh' } };

/** 造一个「已生成 24 个」的续写场景 */
function saved(count) {
  return Array.from({ length: count }, (_, i) => ({
    shot_number: i + 1,
    segment_title: '段落' + (i + 1),
    title: '镜头' + (i + 1),
    location: '荒山野岭',
    action: '悟空抡起金箍棒当头劈下。',
  }));
}

describe('分镜续写提示词', () => {
  const prompt = svc.buildContinuationPrompt('【剧本内容】…', saved(24), 24, 1, false, true, ZH, 65);

  it('不再要求已废弃的灵境/SoulLens 单行格式', () => {
    // 旧的写死文案：非空 universal_segment_text（单行：须含「叙事动态」时间线+「镜头」运镜链…）
    assert.equal(/单行：须含/.test(prompt), false, '旧的单行格式指令必须消失');
    // 「叙事动态」只允许作为**被禁止的格式**出现在规范里（禁止清单那一条），不能作为要求
    const mentions = (prompt.match(/叙事动态/g) || []).length;
    assert.ok(mentions <= 1, '「叙事动态」最多在禁止清单里出现一次，实际 ' + mentions);
    if (mentions === 1) assert.match(prompt, /禁止\*\*使用已废弃的灵境\/SoulLens/);
  });

  it('续写的全能格式要求与首轮同一套（块格式 + 剪辑点写法）', () => {
    assert.match(prompt, /生成一个由以下 1 个分镜组成的视频/);
    assert.match(prompt, /universal_segment_text/);
    assert.match(prompt, /\[Shot N\] At MM:SS\.mmm/);
    assert.match(prompt, /打斗／追击／连招／快速动作爆发/);
  });

  it('写明还需多少个分镜（65 镜必须靠续写凑齐，不能只补几个就收尾）', () => {
    assert.match(prompt, /本次请求总镜数为 65/);
    assert.match(prompt, /已生成 24 个/);
    assert.match(prompt, /还需约 41 个/);
  });

  it('未给 requestedCount 时不输出剩余数量行（不编造）', () => {
    const p2 = svc.buildContinuationPrompt('x', saved(5), 5, 1, false, true, ZH, null);
    assert.equal(/还需约/.test(p2), false);
  });

  it('非全能模式不注入全能格式段（经典模式不受影响）', () => {
    const p2 = svc.buildContinuationPrompt('x', saved(5), 5, 1, false, false, ZH, 10);
    assert.equal(/universal_segment_text/.test(p2), false);
  });

  it('续写要求从上一镜的下一号开始、并要求禁止重复', () => {
    assert.match(prompt, /shot_number 从 25 开始递增/);
    assert.match(prompt, /严禁重复已生成列表中的任何情节或场景/);
  });

  it('开启解说时要求每条都有非空 narration', () => {
    const p2 = svc.buildContinuationPrompt('x', saved(5), 5, 1, true, true, ZH, 10);
    assert.match(p2, /每条新增分镜必须含非空字符串 narration/);
  });
});

describe('分镜单次响应的容量前提', () => {
  it('token 上限仍是 16384（约 24 镜/次 —— 镜数超过它就必须靠续写）', () => {
    assert.equal(svc.DEFAULT_STORYBOARD_MAX_TOKENS, 16384);
  });
});

describe('多镜 LINE3 在多镜正文下的自洽（与续写相关的格式规则）', () => {
  it('多镜形态 LINE3 允许镜内切镜、但仍禁止成片宫格', () => {
    assert.match(LINE3_MULTI, /允许镜内切镜/);
    assert.match(LINE3_MULTI, /禁止成片宫格/);
  });
});
