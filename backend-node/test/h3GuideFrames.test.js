/**
 * H3 首尾帧关键帧锚定（MiniMaxH3AddGuide 接线）单测。
 *
 * 背景：storyboards 里的 first_frame_image_id / last_frame_image_id 由用户在画布上绑定，
 * 但本地渲染（协议 comfyui → A03 Ref2VA）此前**完全忽略**它们 —— videoClient 只传了 image_url，
 * comfyuiClient 的 H3 分支也明确「跳过首帧图覆盖」。于是首尾帧模式下用户绑了尾帧也不生效。
 *
 * 做法：在 136 MiniMaxH3ReferenceToVideo → 126 BasicGuider 之间插 MiniMaxH3AddGuide。
 * 校验点：接线确实插在中间、latent/vae 复用主链、frame_idx 分别是 0 与 -1、
 * 没有首尾帧时**完全不改动**图（向后兼容是硬要求，不能影响现有出片）。
 */
const test = require('node:test');
const assert = require('node:assert');
const path = require('path');
const fs = require('fs');

const { applyH3GuideFramesToApi, hasH3ReferenceNode } = require('../src/services/comfyuiClient');

const WF = path.join(__dirname, '..', '..', 'workflows', 'A视频-LTX', 'A03-参考生视频-H3-r2v-dualgpu.json');

function loadA03() {
  return JSON.parse(fs.readFileSync(WF, 'utf8'));
}

/** 找出所有指向 (nodeId, slot) 的入边 */
function inbound(prompt, nodeId, slot) {
  const out = [];
  for (const [nid, node] of Object.entries(prompt)) {
    for (const [k, v] of Object.entries((node && node.inputs) || {})) {
      if (Array.isArray(v) && v.length === 2 && String(v[0]) === String(nodeId) && Number(v[1]) === Number(slot)) {
        out.push(nid + '.' + k);
      }
    }
  }
  return out;
}

test('A03 是 H3 参考工作流，且结构符合接关键帧的前提', () => {
  const wf = loadA03();
  assert.ok(hasH3ReferenceNode(wf), 'A03 应含 H3 参考节点');
  const h3Id = Object.keys(wf).find((k) => wf[k].class_type === 'MiniMaxH3ReferenceToVideo');
  assert.ok(h3Id, 'A03 应有 MiniMaxH3ReferenceToVideo');
  assert.ok(Array.isArray(wf[h3Id].inputs.vae), 'H3 节点应有 vae 源（关键帧编码要用视频 VAE）');
  // conditioning(0) 的下游消费者必须存在，否则没法把 guide 插进去
  assert.ok(inbound(wf, h3Id, 0).length > 0, 'H3 conditioning 必须有下游消费者');
});

test('无首尾帧时不改动工作流（向后兼容）', () => {
  const wf = loadA03();
  const before = JSON.stringify(wf);
  assert.strictEqual(applyH3GuideFramesToApi(wf, '136', null), '');
  assert.strictEqual(applyH3GuideFramesToApi(wf, '136', {}), '');
  assert.strictEqual(applyH3GuideFramesToApi(wf, '136', { first: null, last: null }), '');
  assert.strictEqual(JSON.stringify(wf), before, '空参数不得修改工作流');
});

test('只有首帧：frame_idx=0，链尾接回 guider', () => {
  const wf = loadA03();
  const note = applyH3GuideFramesToApi(wf, '136', { first: 'kf_first.png' }, { warn() {} });
  assert.match(note, /首帧/);
  const ld = wf['h3_kf_ld_first'];
  const g = wf['h3_kf_guide_first'];
  assert.ok(ld && g, '应新增 LoadImage 与 AddGuide 节点');
  assert.strictEqual(ld.class_type, 'LoadImage');
  assert.strictEqual(ld.inputs.image, 'kf_first.png');
  assert.strictEqual(g.class_type, 'MiniMaxH3AddGuide');
  assert.strictEqual(g.inputs.frame_idx, 0);
  assert.deepStrictEqual(g.inputs.positive, ['136', 0], 'positive 来自 H3 的 conditioning 输出');
  assert.deepStrictEqual(g.inputs.latent, ['136', 1], 'latent 复用 H3 的 latent 输出');
  assert.deepStrictEqual(g.inputs.vae, wf['136'].inputs.vae, 'vae 复用主链的视频 VAE');
  assert.deepStrictEqual(g.inputs.image, ['h3_kf_ld_first', 0]);
  // guider 必须改接到 guide，而不是还直连 136
  assert.deepStrictEqual(wf['126'].inputs.conditioning, ['h3_kf_guide_first', 0]);
  assert.deepStrictEqual(inbound(wf, '136', 0), ['h3_kf_guide_first.positive']);
  assert.ok(!wf['h3_kf_guide_last'], '没给尾帧就不应生成尾帧节点');
});

test('首尾帧都有：首帧 0、尾帧 -1，链式串起来', () => {
  const wf = loadA03();
  const note = applyH3GuideFramesToApi(wf, '136', { first: 'a.png', last: 'b.png' }, { warn() {} });
  assert.match(note, /首帧/);
  assert.match(note, /尾帧/);
  assert.deepStrictEqual(wf['h3_kf_guide_first'].inputs.positive, ['136', 0]);
  assert.deepStrictEqual(wf['h3_kf_guide_last'].inputs.positive, ['h3_kf_guide_first', 0]);
  assert.strictEqual(wf['h3_kf_guide_last'].inputs.frame_idx, -1, '尾帧用负索引从片尾数');
  assert.strictEqual(wf['h3_kf_ld_last'].inputs.image, 'b.png');
  assert.deepStrictEqual(wf['126'].inputs.conditioning, ['h3_kf_guide_last', 0]);
});

test('首尾帧是同一张图时只锚一次（节点会拒绝重叠的关键帧）', () => {
  const wf = loadA03();
  applyH3GuideFramesToApi(wf, '136', { first: 'same.png', last: 'same.png' }, { warn() {} });
  assert.ok(wf['h3_kf_guide_first']);
  assert.ok(!wf['h3_kf_guide_last']);
});

test('H3 节点没有 vae 输入时不硬接，并告警', () => {
  const wf = loadA03();
  delete wf['136'].inputs.vae;
  const warns = [];
  const note = applyH3GuideFramesToApi(wf, '136', { first: 'a.png' }, { warn: (m) => warns.push(m) });
  assert.strictEqual(note, '');
  assert.ok(!wf['h3_kf_guide_first']);
  assert.ok(warns.some((m) => /vae/.test(m)));
});

test('找不到 conditioning 消费者时不硬接', () => {
  const wf = loadA03();
  // 把 guider 的 conditioning 换成别的来源
  wf['126'].inputs.conditioning = ['999', 0];
  const warns = [];
  const note = applyH3GuideFramesToApi(wf, '136', { first: 'a.png' }, { warn: (m) => warns.push(m) });
  assert.strictEqual(note, '');
  assert.ok(!wf['h3_kf_guide_first']);
  assert.ok(warns.some((m) => /下游/.test(m)));
});
