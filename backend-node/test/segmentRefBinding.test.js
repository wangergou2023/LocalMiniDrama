/**
 * 全能提示词的**参考图绑定**自检 / 修正。
 *
 * 用户实测截图报的问题：ep1 镜1 有唐僧/悟空/八戒/沙僧四个角色槽位，
 * 正文却**只用 @图片2 引了唐僧**，另外三人是裸名字 → 他们拿不到参考图绑定，身份一致性丢失。
 * 同批 镜3 反向错：把 @图片4（金箍棒槽）写成「八戒」。
 */
const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { checkSegmentRefBinding, repairSegmentRefBinding } = require('../src/utils/segmentRefBinding');

const SLOTS = [
  { index: 1, tag: '@图片1', kind: '场景', name: '荒山野岭山道' },
  { index: 2, tag: '@图片2', kind: '角色', name: '唐僧' },
  { index: 3, tag: '@图片3', kind: '角色', name: '悟空' },
  { index: 4, tag: '@图片4', kind: '角色', name: '八戒' },
  { index: 5, tag: '@图片5', kind: '角色', name: '沙僧' },
];
const KNOWN = ['唐僧', '悟空', '八戒', '沙僧', '假悟空', '金箍棒'];

const UST = (body) => ['画面风格和类型: 水墨', '生成一个由以下 1 个分镜组成的视频。', '环境、光影与陈设定性参考 @图片1。', '分镜1： 8秒: ' + body].join('\n');
const beat = (t) => String(t).split('\n').find((l) => l.startsWith('分镜1：')) || '';

describe('参考图绑定自检', () => {
  it('点出「提到角色却没引用」', () => {
    const u = UST('大远景起幅，@图片1 的荒山野岭铺开，@图片2 的唐僧端坐马上，悟空扛棒走在最前，八戒牵马，沙僧挑担。无对白。');
    const c = checkSegmentRefBinding(u, SLOTS, { knownNames: KNOWN });
    assert.deepEqual(c.missing.map((x) => x.name), ['悟空', '八戒', '沙僧']);
  });

  it('「假悟空」里的「悟空」不算提到悟空（不能误补引用）', () => {
    const u = UST('@图片1 的云端，@图片2 的唐僧抬头，假悟空落在面前。无对白。');
    const slots = [{ index: 1, tag: '@图片1', kind: '场景', name: '云端' }, { index: 2, tag: '@图片2', kind: '角色', name: '唐僧' }, { index: 3, tag: '@图片3', kind: '角色', name: '悟空' }];
    const c = checkSegmentRefBinding(u, slots, { knownNames: KNOWN });
    assert.deepEqual(c.missing, [], '假悟空 不是 悟空，不该要求 @图片3');
  });

  it('点出「序号写错」（引用了没有槽位的角色）', () => {
    const u = UST('@图片1 的山道，@图片2 的悟空横扫，@图片4 的八戒缩肩屏息。无对白。');
    const slots = [{ index: 1, tag: '@图片1', kind: '场景', name: '荒山野岭山道' }, { index: 2, tag: '@图片2', kind: '角色', name: '悟空' }, { index: 3, tag: '@图片3', kind: '角色', name: '唐僧' }, { index: 4, tag: '@图片4', kind: '道具', name: '金箍棒' }];
    const c = checkSegmentRefBinding(u, slots, { knownNames: KNOWN });
    assert.equal(c.mismatched.length, 1);
    assert.equal(c.mismatched[0].written, '八戒');
    assert.equal(c.mismatched[0].expectedTag, null, '八戒 在本镜没有槽位');
  });
});

describe('参考图绑定修正', () => {
  it('补漏引，且不动台词与骨架', () => {
    const u = UST('@图片1 的荒山野岭，@图片2 的唐僧端坐马上，悟空扛棒走在最前。@图片2 的嗓音低沉："悟空，你这是做什么？"无对白。');
    const rep = repairSegmentRefBinding(u, SLOTS, { knownNames: KNOWN });
    assert.match(beat(rep.text), /@图片3 悟空扛棒/);
    assert.match(rep.text, /<d>|"悟空，你这是做什么？"/);
    // 台词里的「悟空」不能被插引用
    assert.equal(/@图片3 悟空，你这是做什么/.test(rep.text), false);
    assert.equal(checkSegmentRefBinding(rep.text, SLOTS, { knownNames: KNOWN }).missing.length, 0);
  });

  it('序号写错时改成正确槽位；没有对应槽位则去掉引用（宁可不引用也不能绑错图）', () => {
    const slots = [{ index: 1, tag: '@图片1', kind: '场景', name: '山道' }, { index: 2, tag: '@图片2', kind: '角色', name: '悟空' }, { index: 3, tag: '@图片3', kind: '角色', name: '唐僧' }, { index: 4, tag: '@图片4', kind: '道具', name: '金箍棒' }];
    // ① 写成 @图片4 但后随唐僧 → 应该是 @图片3
    const a = UST('@图片1 的山道，@图片2 的悟空收棒，@图片4 的唐僧在马背上身形一僵。无对白。');
    const ra = repairSegmentRefBinding(a, slots, { knownNames: KNOWN });
    assert.match(beat(ra.text), /@图片3 的唐僧/);
    assert.equal(/@图片4 的唐僧/.test(ra.text), false);
    // ② 写成 @图片4 但后随八戒（无槽位）→ 去掉引用
    const b = UST('@图片1 的山道，@图片2 的悟空收棒，@图片4 的八戒缩肩屏息。无对白。');
    const rb = repairSegmentRefBinding(b, slots, { knownNames: KNOWN });
    assert.match(beat(rb.text), /八戒缩肩屏息/);
    assert.equal(/@图片4 的八戒/.test(rb.text), false);
    assert.equal(rb.changes.some((c) => /去掉错误引用/.test(c)), true);
  });

  it('已经正确引用的不动（幂等）', () => {
    const u = UST('@图片1 的荒山野岭，@图片2 的唐僧端坐马上，@图片3 悟空扛棒走在最前，@图片4 八戒牵马，@图片5 沙僧挑担。无对白。');
    const rep = repairSegmentRefBinding(u, SLOTS, { knownNames: KNOWN });
    assert.deepEqual(rep.changes, []);
    assert.equal(rep.text, u);
  });

  it('修正后校验必须通过', () => {
    const u = UST('大远景起幅，@图片1 的荒山野岭铺开，@图片2 的唐僧端坐马上，悟空扛棒走在最前，八戒牵马，沙僧挑担。无对白。');
    const rep = repairSegmentRefBinding(u, SLOTS, { knownNames: KNOWN });
    const after = checkSegmentRefBinding(rep.text, SLOTS, { knownNames: KNOWN });
    assert.deepEqual([after.missing.length, after.unknown.length, after.mismatched.length], [0, 0, 0]);
  });
});
