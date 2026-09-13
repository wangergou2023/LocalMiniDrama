/**
 * 提示词「单一来源」与关键规则回归测试。
 *
 * 两类真实踩过的坑，这里各锁一条：
 *
 * 1. **同一段提示词抄两份**：`getDefaultPromptBody(key)`（「提示词设置」页拿它当 placeholder
 *    显示给用户）曾是**手抄**的正文，与真正在跑的 `getStoryboardSystemPrompt` /
 *    `getStoryExpansionSystemPrompt` 长期不一致 —— 旧副本里还留着「宁可写细，不要压缩」
 *    的措辞、也缺「打斗按拍切镜」这条。用户照 placeholder 改一版保存，就等于把提示词回退，
 *    而且**没有任何报错**。现在两者都从同一个 builder 生成，这里断言它们恒等。
 *
 * 2. **模板字符串里内联反引号**：这些提示词都是模板字符串，正文里写 `` `[Shot N]` `` 会
 *    直接 SyntaxError（本文件所在模块 require 失败 → 整个后端起不来）。写这轮改动时连踩三次。
 *    要求本模块能 require，就等于给这类错误加了一道门。
 */
const { describe, it } = require('node:test');
const assert = require('node:assert/strict');

const promptI18n = require('../src/services/promptI18n');

const ZH = { language: 'zh', app: { language: 'zh' } };
const EN = { language: 'en', app: { language: 'en' } };

describe('提示词单一来源：页面默认值 = 真正在跑的提示词', () => {
  it('storyboard_system 的 default_body 与中文实际提示词逐字相同', () => {
    assert.equal(promptI18n.getDefaultPromptBody('storyboard_system'), promptI18n.getStoryboardSystemPrompt(ZH));
  });

  it('story_expansion_system 的 default_body 是实际提示词的前缀（差额只有输出格式说明）', () => {
    const def = promptI18n.getDefaultPromptBody('story_expansion_system');
    // default_body 用 ${n} 占位；实际提示词把 n 填成具体数字
    const defFilled = def.replace(/\$\{n\}/g, '1');
    const live = promptI18n.getStoryExpansionSystemPrompt(ZH, 1);
    assert.ok(live.startsWith(defFilled), '实际提示词必须以 default_body 开头');
    const tail = live.slice(defFilled.length);
    assert.match(tail, /输出格式（必须严格遵守）/, '多出来的只能是输出格式说明');
  });

  it('故事提示词的 default_body 仍是可填模板（保留 ${n} 占位）', () => {
    assert.ok(promptI18n.getDefaultPromptBody('story_expansion_system').includes('${n}'));
  });
});

describe('提示词关键规则：打斗按拍（不许悄悄回退）', () => {
  it('剧本创作提示词要求打斗按拍写（中英）', () => {
    assert.match(promptI18n.getStoryExpansionSystemPrompt(ZH, 1), /打斗按「拍」写/);
    assert.match(promptI18n.getStoryExpansionSystemPrompt(ZH, 1), /至少连续三到四拍/);
    assert.match(promptI18n.getStoryExpansionSystemPrompt(EN, 1), /Write fights beat by beat/);
  });

  it('分镜拆解提示词说明 H3 原生支持镜内切镜，且不再出现「严禁内部切镜」', () => {
    const zh = promptI18n.getStoryboardSystemPrompt(ZH);
    assert.match(zh, /原生支持一次生成内 2-4 个镜头/);
    assert.match(zh, /打斗／追击／连招／快速动作爆发/);
    assert.equal(/严禁内部切镜/.test(zh), false, '旧的单镜禁令不得回退');
    const en = promptI18n.getStoryboardSystemPrompt(EN);
    assert.match(en, /natively supports 2-4 cuts/);
    assert.equal(/internal cuts are forbidden/.test(en), false, '旧的单镜禁令不得回退');
  });

  it('分镜要素后缀与全能片段规范都带着镜内剪辑点写法', () => {
    assert.match(promptI18n.getStoryboardUserPromptSuffix(ZH, 8), /打斗\/追击\/连招镜可按拍镜内切镜/);
    const spec = promptI18n.getUniversalOmniMultiBeatFormatSpec(ZH);
    assert.match(spec, /镜内剪辑点/);
    assert.match(spec, /\[Shot N\] At MM:SS\.mmm/);
    assert.match(spec, /禁止出现「分镜2：」及之后的\*\*行\*\*/);
  });

  it('全能片段/润色提示词都要求保留剪辑记号', () => {
    assert.match(promptI18n.getUniversalOmniSegmentPrompt(), /Intra-shot cuts/);
    assert.match(promptI18n.getUniversalOmniPolishPrompt(), /Cut markers are structural/);
  });

  it('用户提示词的 JSON 字段清单覆盖系统提示词定义的所有必要字段', () => {
    // 这份 JSON 清单才是模型照着填的那份；漏写的字段模型就不返回，而且**静默为空**。
    // 实测：emotion_intensity 三个项目 0/99、layout_description 在 drama2 那批 0/21、
    // drama4 新批次连 lighting_style / depth_of_field 也一起丢了（0/65）。
    const zh = promptI18n.getStoryboardUserPromptSuffix(ZH, 8);
    const en = promptI18n.getStoryboardUserPromptSuffix(EN, 8);
    for (const f of ['lighting_style', 'depth_of_field', 'narration', 'emotion_intensity', 'layout_description']) {
      assert.match(zh, new RegExp('\\b' + f + '\\b'), 'zh 清单缺 ' + f);
      assert.match(en, new RegExp('\\b' + f + '\\b'), 'en 清单缺 ' + f);
    }
  });

  it('storyboard_user_suffix 的页面副本也从同一处拆（不再手抄字段清单）', () => {
    const body = promptI18n.getDefaultPromptBody('storyboard_user_suffix');
    const locked = promptI18n.getLockedSuffix('storyboard_user_suffix');
    const real = promptI18n.getStoryboardUserPromptSuffix(ZH, null).trim();
    // 两段拼起来就是真正发出去的提示词
    assert.equal((body + '\n\n' + locked).trim(), real);
    // 字段清单必须跟着走，否则设置页里那份会悄悄变旧
    for (const f of ['segment_index', 'lighting_style', 'depth_of_field', 'narration', 'emotion_intensity', 'layout_description']) {
      assert.match(locked, new RegExp('\\b' + f + '\\b'), 'locked_suffix 缺 ' + f);
    }
  });

  it('multiline 块格式没被压成单行（历史回归：曾被 replace(/\\r?\\n/g," ") 压平）', () => {
    const spec = promptI18n.getUniversalOmniMultiBeatFormatSpec(ZH);
    assert.ok(spec.split('\n').length > 20, '规范必须仍是多行');
  });
});
