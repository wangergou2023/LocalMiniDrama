/**
 * 「自动分集」提示词回归。
 *
 * 动机：一集塞满整段故事会产出 65 个分镜 —— 成片近 8 分钟、本地 H3 渲染 7-8 小时。
 * 自动分集让模型按内容决定集数，但**每集容量是硬约束**（由「每集目标镜数」推出）：
 * 否则只是让模型自由发挥，它又会写出一集 2000 字。
 */
const { describe, it } = require('node:test');
const assert = require('node:assert/strict');

const p = require('../src/services/promptI18n');
const ZH = { language: 'zh', app: { language: 'zh' } };
const EN = { language: 'en', app: { language: 'en' } };

describe('单集容量：由每集目标镜数推出', () => {
  it('换算链固定：镜数 × 8 秒 × 4.2 字/秒', () => {
    assert.equal(p.EPISODE_TARGET_CHARS, Math.round(p.EPISODE_TARGET_SHOTS * 8 * 4.2));
  });
  it('区间围绕目标值（±15%）', () => {
    assert.ok(p.EPISODE_CHARS_MIN < p.EPISODE_TARGET_CHARS);
    assert.ok(p.EPISODE_CHARS_MAX > p.EPISODE_TARGET_CHARS);
    assert.ok(p.EPISODE_CHARS_MAX - p.EPISODE_CHARS_MIN < 400);
  });
  it('目标镜数量级合理（十几到二十几个，不能再出现 65 镜一集）', () => {
    assert.ok(p.EPISODE_TARGET_SHOTS >= 12 && p.EPISODE_TARGET_SHOTS <= 30, String(p.EPISODE_TARGET_SHOTS));
  });
});

describe('自动分集提示词', () => {
  const auto = p.getStoryExpansionSystemPrompt(ZH, 1, { autoEpisodes: true });
  const manual = p.getStoryExpansionSystemPrompt(ZH, 2);

  it('正文按单集容量约束字数（不再是写死的 1200-1600）', () => {
    assert.match(auto, new RegExp(`${p.EPISODE_CHARS_MIN}-${p.EPISODE_CHARS_MAX} 字`));
    assert.equal(/1200-1600 字/.test(auto), false);
  });
  it('要求模型自己决定集数，并给出区间与「每集独立成篇 + 钩子」', () => {
    assert.match(auto, /集数由你决定/);
    assert.match(auto, /超出容量就必须拆到下一集/);
    assert.match(auto, /每一集都要能被单独看懂/);
  });
  it('输出格式说明不再要求固定 N 集', () => {
    assert.match(auto, /集数由你根据内容决定/);
    assert.equal(/返回一个 JSON 数组，包含 1 个对象/.test(auto), false);
  });
  it('手填集数时行为不变（仍是固定 N 集，且没有自动分集段）', () => {
    assert.match(manual, /包含 2 个对象/);
    assert.equal(/集数由你决定/.test(manual), false);
  });
  it('用户提示词也区分两种模式', () => {
    assert.match(p.buildStoryExpansionUserPrompt(ZH, '梗概', null, 'drama', 1, { autoEpisodes: true }), /自动分集/);
    assert.match(p.buildStoryExpansionUserPrompt(ZH, '梗概', null, 'drama', 3), /创作 3 集短片剧本/);
  });
  it('英文分支同步', () => {
    const en = p.getStoryExpansionSystemPrompt(EN, 1, { autoEpisodes: true });
    assert.match(en, /YOU decide the episode count/);
    assert.match(en, new RegExp(`${p.EPISODE_CHARS_MIN}-${p.EPISODE_CHARS_MAX} characters`));
  });
  it('提示词设置页的默认正文跟着单集容量走（不再手抄旧字数）', () => {
    const body = p.getDefaultPromptBody('story_expansion_system');
    assert.match(body, new RegExp(`${p.EPISODE_CHARS_MIN}-${p.EPISODE_CHARS_MAX}`));
    assert.equal(/1200-1600/.test(body), false);
  });
});
