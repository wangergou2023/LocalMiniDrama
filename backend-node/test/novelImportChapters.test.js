/**
 * 小说导入分章回归。
 *
 * 实测缺陷（《重生后过上了大女主生活》策划案 16249 字）：
 *   ① 第十二集的标题在原文里写成「十二集」——**漏了「第」字** → 没被识别，
 *      整集正文被并进第十一集（20 集变 19 集，第十一集 945 字，是别集的两倍）。
 *   ② 后端规则里有 `^\d+[\.、].{2,20}$` 这种松散模式，把策划案/剧本里的
 *      `1.基本信息`、`1.景：吴家`、`2.1女主-韩悠兰` 全当章节 → 切出 48 个假章节。
 *       （前端会因为「识别出的集数更多」而覆盖它，但那是侥幸，不是设计。）
 *
 * 注意：检测器要求每段正文 > 20 字才算一章，所以下面的测试正文都写长一点。
 */
const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { detectChaptersByRules, importNovel } = require('../src/services/novelImportService');

const body = (s) => `${s}${'正文'.repeat(12)}`;   // >20 字

const novel = [
  ' 短剧《测试剧》策划案',
  '',
  '1.基本信息',
  '【类型】都市',
  '',
  '2.1女主-小兰',
  '视觉年龄25岁，长相清丽。',
  '',
  '3.故事大纲',
  '小兰重生后开始搞事业，势必要把失去的都拿回来。',
  '',
  '第一集',
  '1.景：吴家',
  '时：日 内',
  '人：小兰',
  body('小兰在床边醒来。'),
  '',
  '第二集',
  '1.景：公司',
  body('小兰走进公司大门。'),
  '',
  '十二集',
  '1.景：车库',
  body('小兰开车离开车库。'),
  '',
  '第十三集',
  '1.景：餐厅',
  body('小兰在餐厅吃饭。'),
].join('\n');

describe('小说分章：漏写「第」字的集标题', () => {
  it('「十二集」要被认成第十二集', () => {
    const titles = detectChaptersByRules(novel).map((c) => c.title);
    assert.ok(titles.includes('第十二集'), JSON.stringify(titles));
  });

  it('策划案里的 1.基本信息 / 1.景：吴家 / 2.1女主-小兰 不算章节', () => {
    const titles = detectChaptersByRules(novel).map((c) => c.title);
    const bad = titles.filter((t) => /^1\.|^2\.1|基本信息|故事大纲|景：/.test(t));
    assert.deepEqual(bad, [], `不该被当章节：${JSON.stringify(bad)}`);
  });

  it('有命名型章节时，只按命名型切，不再启用松散模式', () => {
    const titles = detectChaptersByRules(novel).map((c) => c.title);
    assert.deepEqual(titles.filter((t) => t !== '序章'), ['第一集', '第二集', '第十二集', '第十三集']);
  });

  it('完全没有命名型章节时，松散模式仍然生效（【标题】形式的老小说）', () => {
    const loose = ['【雨夜】', body('他站在雨里。'), '', '【清晨】', body('天亮了。')].join('\n');
    const titles = detectChaptersByRules(loose).map((c) => c.title);
    assert.deepEqual(titles, ['【雨夜】', '【清晨】']);
  });
});

describe('小说导入：前言不占一集', () => {
  it('第一个标题之前的策划案被单独摘出，第一集只留正文', async () => {
    const log = { info() {}, warn() {} };
    const r = await importNovel(null, log, { text: novel, title: '测试剧', maxChapters: 20, aiSummarize: false });
    assert.equal(r.chapters.length, 4);
    assert.equal(r.chapters[0].title, '第一集');
    assert.match(r.chapters[0].script, /小兰在床边醒来/);
    assert.doesNotMatch(r.chapters[0].script, /策划案|故事大纲/);
    assert.match(r.preamble, /策划案/);
    assert.match(r.preamble, /故事大纲/);
  });

  it('正文里真的有「序章」时，它仍是一章，不被当成前言摘走', async () => {
    const log = { info() {}, warn() {} };
    const text = ['序章', body('很多年前的一个雨夜，他还只是个孩子。'), '', '第一集', body('故事从这里开始。'), '', '第二集', body('故事继续。')].join('\n');
    const r = await importNovel(null, log, { text, title: '测试', maxChapters: 20, aiSummarize: false });
    assert.equal(r.preamble, '');
    assert.equal(r.chapters.length, 3);
    assert.match(r.chapters[0].script, /很多年前的一个雨夜/);
  });
});
