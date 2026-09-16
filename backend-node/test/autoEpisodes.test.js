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
  it('换算链固定：镜数 × 规划单镜秒数 × 4.2 字/秒', () => {
    // 规划单镜秒数由 8 提到 12：分镜 = 一次连续拍摄，时长按内容动态给，
    // 否则「一镜演不完就拆镜」会把一个连续镜头切成一堆 7-8 秒碎片。
    assert.equal(p.PLANNED_SHOT_SECONDS, 12);
    const implied = p.EPISODE_TARGET_SHOTS * p.PLANNED_SHOT_SECONDS * 4.2;
    assert.ok(Math.abs(implied - p.EPISODE_TARGET_CHARS) < 60, `${implied} vs ${p.EPISODE_TARGET_CHARS}`);
    assert.equal(p.EPISODE_TARGET_SHOTS, 15);
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

describe('全能模式的必填字段：必须写在用户提示词里（模型只认那份清单）', () => {
  const ZH2 = { language: 'zh', app: { language: 'zh' } };
  const off = p.getStoryboardUserPromptSuffix(ZH2, 8);
  const on = p.getStoryboardUserPromptSuffix(ZH2, 8, { universalOmni: true });

  it('关闭全能模式时不要求这两个字段（经典模式不受影响）', () => {
    assert.equal(/creation_mode/.test(off), false);
    assert.equal(/universal_segment_text/.test(off), false);
  });

  it('开启全能模式时把它们写进【输出格式】字段清单', () => {
    assert.match(on, /creation_mode/);
    assert.match(on, /universal_segment_text/);
  });

  it('并在用户提示词结尾再用独立段落强调一次（实测只放系统提示词会被整批漏掉）', () => {
    const r = p.getStoryboardUniversalOmniUserReminder(ZH2);
    assert.match(r, /最高优先级/);
    assert.match(r, /每个镜头对象都必须同时包含/);
    assert.match(r, /缺少 universal_segment_text 的镜头只能退化成通用模板文/);
    assert.match(p.getStoryboardUniversalOmniUserReminder({ app: { language: 'en' } }), /TWO MORE REQUIRED FIELDS/);
  });

  it('系统提示词里的全能说明也仍保留（双保险）', () => {
    const sys = p.getStoryboardUniversalOmniModeSuffix(ZH2);
    assert.match(sys, /creation_mode/);
    assert.match(sys, /universal_segment_text/);
    assert.match(sys, /每个镜头都必须有/);
  });
});

/**
 * 分镜总数：没指定时按「剧本时长 ÷ 项目每段最大秒数」推导。
 * 实测 drama7 ep21：不传数量 → 没有任何总数约束 → 857 字切出 26 个 7-8 秒碎片。
 */
describe('分镜数量自动推导', () => {
  const svc = require('../src/services/episodeStoryboardService');
  it('857 字（≈204 秒）÷ 每段 15 秒 ≈ 14 镜', () => {
    assert.equal(svc.deriveStoryboardCount('字'.repeat(857), null, 15), 14);  // 物理下限
  });
  it('1037 字（≈247 秒）÷ 每段 15 秒 ≈ 16 镜', () => {
    assert.equal(svc.deriveStoryboardCount('字'.repeat(1037), null, 15), 16);
  });
  it('显式指定数量时以指定值为准', () => {
    assert.equal(svc.deriveStoryboardCount('字'.repeat(857), 20, 15), 20);
  });
  it('没有项目配置时退回规划单镜 12 秒；空剧本返回 null；极端值被夹到 6–40', () => {
    assert.equal(svc.deriveStoryboardCount('字'.repeat(857), null, null), 17);
    assert.equal(svc.deriveStoryboardCount('', null, 15), null);
    assert.equal(svc.deriveStoryboardCount('字'.repeat(50), null, 15), 6);
    assert.equal(svc.deriveStoryboardCount('字'.repeat(50000), null, 15), 40);
  });
});

/**
 * TDZ 回归：generateStoryboard 里 effectiveStoryboardCount 必须先声明后使用。
 * 实测（ep23 宣传片，带 video_duration 调用 /episodes/:id/storyboards）：
 *   Cannot access 'effectiveStoryboardCount' before initialization → HTTP 500。
 * 只有传了总时长才会走到那行表达式，所以之前一直没暴露。
 */
test('generateStoryboard：effectiveStoryboardCount 声明早于使用（TDZ 回归）', () => {
  const fs = require('fs');
  const path = require('path');
  const src = fs.readFileSync(path.join(__dirname, '../src/services/episodeStoryboardService.js'), 'utf8');
  const start = src.indexOf('function generateStoryboard(db, log, episodeId');
  assert.ok(start > 0, '未找到 generateStoryboard');
  const body = src.slice(start, start + 60000);
  const decl = body.indexOf('const effectiveStoryboardCount = deriveStoryboardCount');
  const use = body.indexOf('effectiveStoryboardCount');
  assert.ok(decl > 0 && use > 0, '未找到声明或使用');
  assert.ok(decl < use, `声明(${decl}) 必须早于首次使用(${use})`);
  // 该使用点必须就是那段基于 videoDuration 的表达式（说明我们锁的是真实触发路径）
  assert.match(body.slice(use - 20, use + 60), /videoDuration && effectiveStoryboardCount/);
});
