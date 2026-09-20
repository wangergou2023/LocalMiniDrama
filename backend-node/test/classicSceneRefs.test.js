const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { applyH3RefsToApi } = require('../src/services/comfyuiClient');
const { resolveLastFrameForSubmit } = require('../src/services/videoService');

/**
 * 经典 / 首尾帧镜头的场景参考：
 *  ① 参考说明头里必须是「场景」行 + 「本镜关键帧」行，不能被兜底成「道具」行
 *     （applyH3RefsToApi 是按标签关键词判断图类型的，没有对应分支就落到道具）；
 *  ② 经典镜头的尾帧不能被参考图顶掉（以前 `hasOmniRefs ? undefined : last_frame_url`
 *     会把尾帧无声丢弃）。
 */
const CLASSIC_PROMPT = [
  '场景：城郊河边土岸，杂草丛生。',
  '镜头标题：河边立誓。',
  '动作：韩悠兰抬起头，冷笑定格。',
].join('\n');

const makePrompt = () => ({ '136': { class_type: 'MiniMaxH3ReferenceToVideo', inputs: { prompt: '' } } });
const silentLog = { info() {}, warn() {} };

describe('经典镜头带场景参考时的 <Picture N> 说明头', () => {
  it('场景行 + 本镜关键帧行都写对，不出现「道具」兜底行', () => {
    const apiPrompt = makePrompt();
    const labels = ['scene background for "河边"', 'keyframe still for this shot'];
    applyH3RefsToApi(
      apiPrompt,
      ['scene.png', 'frame.png'],
      labels,
      CLASSIC_PROMPT,
      [],
      [],
      [],
      8,
      silentLog
    );
    const prompt = apiPrompt['136'].inputs.prompt;

    assert.match(prompt, /<Picture 1>：场景「河边」环境参考/);
    assert.match(prompt, /<Picture 2>：本镜关键帧参考/);
    assert.equal(/道具/.test(prompt), false, '本镜主图不能被写成道具参考');
    // 参考图接线顺序与标签一一对应
    assert.equal(apiPrompt['h3_ld_i0'].inputs.image, 'scene.png');
    assert.equal(apiPrompt['h3_ld_i1'].inputs.image, 'frame.png');
    assert.deepEqual(apiPrompt['136'].inputs['ref_images.ref_image_1'], ['h3_ld_i1', 0]);
  });

  it('只有场景图时（没有主图）只写一行场景说明', () => {
    const apiPrompt = makePrompt();
    applyH3RefsToApi(apiPrompt, ['scene.png'], ['scene background for "吴家"'], CLASSIC_PROMPT, [], [], [], 8, silentLog);
    const prompt = apiPrompt['136'].inputs.prompt;
    assert.match(prompt, /<Picture 1>：场景「吴家」环境参考/);
    assert.equal(/<Picture 2>/.test(prompt), false);
    assert.equal(/道具/.test(prompt), false);
  });

  it('英文说明头下也认关键帧标签（不落到道具）', () => {
    const apiPrompt = makePrompt();
    const enPrompt = 'Shot 1: she raises her head and sneers.\noverall_soundscape:\nriver wind.\n';
    applyH3RefsToApi(
      apiPrompt,
      ['scene.png', 'frame.png'],
      ['scene background for "Riverside"', 'keyframe still for this shot'],
      enPrompt,
      [],
      [],
      [],
      8,
      silentLog
    );
    const prompt = apiPrompt['136'].inputs.prompt;
    assert.match(prompt, /keyframe still for this shot/);
    assert.equal(/appearance reference for the prop/i.test(prompt), false);
  });
});

describe('resolveLastFrameForSubmit：经典/首尾帧的尾帧不能被参考图顶掉', () => {
  it('经典镜头：有参考图也保留尾帧（场景参考与首尾帧锚定共存）', () => {
    assert.equal(
      resolveLastFrameForSubmit({ hasRefs: true, isUniversalShot: false, lastFrameUrl: 'http://x/last.png' }),
      'http://x/last.png'
    );
  });

  it('全能镜头：有参考图时不带尾帧（保持原行为）', () => {
    assert.equal(
      resolveLastFrameForSubmit({ hasRefs: true, isUniversalShot: true, lastFrameUrl: 'http://x/last.png' }),
      undefined
    );
  });

  it('没有尾帧时永远是 undefined', () => {
    assert.equal(resolveLastFrameForSubmit({ hasRefs: false, isUniversalShot: false, lastFrameUrl: null }), undefined);
    assert.equal(resolveLastFrameForSubmit({ hasRefs: true, isUniversalShot: true, lastFrameUrl: '' }), undefined);
  });

  it('经典镜头没有参考图时照常带尾帧', () => {
    assert.equal(
      resolveLastFrameForSubmit({ hasRefs: false, isUniversalShot: false, lastFrameUrl: 'http://x/last.png' }),
      'http://x/last.png'
    );
  });
});
