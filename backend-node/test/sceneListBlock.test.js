const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { buildSceneListBlock } = require('../src/services/episodeStoryboardService');

/**
 * 生成分镜时给模型的场景清单必须「本集优先且单独成块」。
 * 历史坑：只给全剧一份清单且不含所属剧集，同一地点多行（吴家在第1/2/5集各一行）
 * 时模型挑到最靠前的老剧集场景行，分镜就绑到了别的集。
 */
function parseBlocks(text) {
  // 每个块形如「标题:\n[{...}]」，把数组都取出来
  return (text.match(/\[[^\]]*\]/g) || []).map((s) => JSON.parse(s));
}

describe('buildSceneListBlock（生成分镜的场景清单）', () => {
  const scenes = [
    { id: 75, location: '吴家', time: '日 内', episode_id: 24 },
    { id: 81, location: '吴家', time: '日 内', episode_id: 25 },
    { id: 86, location: '河边', time: '日 外', episode_id: 27 },
    { id: 94, location: '河边', time: '日 外', episode_id: 28 },
    { id: 95, location: '吴家', time: '日 内', episode_id: 28 },
    { id: 96, location: '主卫', time: '日 内', episode_id: 28 },
  ];

  it('本集场景单独成块并排在最前', () => {
    const text = buildSceneListBlock(scenes, 28);
    const firstBlockHeader = text.split('\n')[0];
    assert.match(firstBlockHeader, /本集场景/);
    const [own, others] = parseBlocks(text);
    assert.deepEqual(own.map((s) => s.id), [94, 95, 96]);
    assert.deepEqual(others.map((s) => s.id), [75, 81, 86]);
    assert.match(text, /本剧其它剧集的场景/);
    // 每一块都是合法 JSON（模型要按 id 选）
    assert.equal(own[0].location, '河边');
    assert.equal(own[0].time, '日 外');
  });

  it('只有本集场景时不出现「其它剧集」块', () => {
    const text = buildSceneListBlock(scenes.filter((s) => s.episode_id === 28), 28);
    assert.equal(/其它剧集/.test(text), false);
    assert.deepEqual(parseBlocks(text).map((b) => b.map((s) => s.id)), [[94, 95, 96]]);
  });

  it('没有任何场景时返回「无场景」', () => {
    assert.equal(buildSceneListBlock([], 28), '无场景');
    assert.equal(buildSceneListBlock(null, 28), '无场景');
    assert.equal(buildSceneListBlock(undefined, 28), '无场景');
  });

  it('地点里的引号被转义，块仍是合法 JSON', () => {
    const text = buildSceneListBlock(
      [{ id: 1, location: '吴家"客厅"', time: '夜 内', episode_id: 28 }],
      28
    );
    const [own] = parseBlocks(text);
    assert.equal(own[0].location, '吴家"客厅"');
  });

  it('episode_id 缺失/为 null 的场景归入「其它剧集」块（不会混进本集）', () => {
    const text = buildSceneListBlock(
      [
        { id: 7, location: '旧场景', time: '', episode_id: null },
        { id: 8, location: '主卫', time: '日 内', episode_id: 28 },
      ],
      28
    );
    const [own, others] = parseBlocks(text);
    assert.deepEqual(own.map((s) => s.id), [8]);
    assert.deepEqual(others.map((s) => s.id), [7]);
  });
});
