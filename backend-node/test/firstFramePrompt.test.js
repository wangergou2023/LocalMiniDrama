/**
 * 首帧（图片）提示词回归测试。
 *
 * 用户实测反馈：分镜1 的「原始提示词」里出现了
 *   「远景·平视·正面，**镜头从远处山脊缓缓横摇**，展现荒山野岭全貌，师徒四人的渺小身影**沿山路缓缓前行**，…，**首帧静止画面**」
 * —— 一首帧静止图却写着运镜与运动，末尾还自称「首帧静止画面」，自相矛盾；
 * 而且景别从 shot_type 的「大远景」被压成了「远景」，机位与同一镜 ust 的首拍也对不上。
 *
 * 根因：`extractInitialPose` 只按一小组过程词（然后/向下/开始/慢慢…）切断，
 * 对「镜头从…缓缓横摇」这类**运镜开头**的 action 一刀不切，整句照搬。
 * 实测 65 镜里 4 条混入运镜、10 条混入运动，全部来自这个原因。
 */
const { describe, it } = require('node:test');
const assert = require('node:assert/strict');

const svc = require('../src/services/episodeStoryboardService');
const angleService = require('../src/services/angleService');

const STYLE = 'traditional Chinese ink wash painting, sumi-e style';

/** 按 buildStoryboardRecord 的方式把 shot_type/angle 补成结构化三元组后拼首帧提示词 */
function buildPrompt({ shot_type = '中景', angle = '平视', action = '', location = '荒山野岭的山路', time = '傍晚', emotion = '苍凉' }) {
  const { h, v, s } = angleService.parseFromLegacyText(angle, shot_type);
  const p = svc.generateImagePrompt(
    { location, time, shot_type, angle, angle_h: h, angle_v: v, angle_s: s, action, emotion },
    STYLE
  );
  return p.replace('，' + STYLE, '');
}

const CAMERA_MOTION_IN_PROMPT = /(镜头从|镜头自|横摇|推镜|拉镜|跟拍|环绕|甩镜|摇镜|缓推|缓摇|升降|升起|拉开|横移)/;
const MOTION_IN_PROMPT = /(缓缓前行|缓缓走来|缓缓开口|纵身|腾空|跃起|降落|落下|飞起|冲出|奔来|疾驰|踢中|打死|走出)/;

describe('首帧提示词：必须是静止画面', () => {
  const CASES = [
    ['运镜开头（镜1 师徒行荒山）', '大远景', '平视', '镜头从远处山脊缓缓横摇，展现荒山野岭全貌，师徒四人的渺小身影沿山路缓缓前行，悟空执棒开路，八戒扛钉耙，沙僧挑担，唐僧骑马居中。'],
    ['升镜开头（镜45 玉帝端坐灵霄殿）', '大远景', '平视', '镜头从殿门缓缓升起，展现灵霄宝殿的恢宏全貌，玉帝端坐龙椅之上，众神将分列两侧，两猴立于殿中。'],
    ['拉镜开头（镜39 南海观音道场）', '大远景', '平视', '镜头从海面缓缓拉开，展现南海观音道场的全貌，紫竹摇曳，海浪拍岸，莲台之上观音端坐，手持玉净瓶。'],
    ['腾空（镜3 悟空纵身跃云）', '远景', '仰视', '悟空将金箍棒往地上一杵，纵身一跃，身形腾空而起，直上云端。'],
    ['降落（镜5 按下云头落山坳）', '远景', '俯视', '悟空按下云头，身形从空中缓缓降落，落在茅屋前的空地上。'],
    ['后续动作（镜28 踢飞铁棒）', '中景', '侧面', '悟空后仰翻身，一脚踢中假猴手腕，铁棒脱手飞出，假猴就地一滚捡起铁棒回身便打。'],
  ];

  for (const [name, shot_type, angle, action] of CASES) {
    it(`${name}：不含运镜与运动`, () => {
      const p = buildPrompt({ shot_type, angle, action });
      assert.equal(CAMERA_MOTION_IN_PROMPT.test(p), false, '首帧提示词里出现了运镜：' + p);
      assert.equal(MOTION_IN_PROMPT.test(p), false, '首帧提示词里出现了运动：' + p);
      assert.match(p, /首帧静止画面$/);
    });
  }

  it('镜1：景别保留「大远景」，不再被压成「远景」', () => {
    const p = buildPrompt({ shot_type: '大远景', angle: '平视', action: '镜头从远处山脊缓缓横摇，展现荒山野岭全貌。' });
    assert.match(p, /大远景·平视·正面/);
  });

  it('中景/近景/特写的标签不受影响', () => {
    assert.match(buildPrompt({ shot_type: '中景', angle: '侧面', action: '唐僧勒住缰绳。' }), /中景·平视·左侧/);
    assert.match(buildPrompt({ shot_type: '近景', angle: '俯视', action: '唐僧低头。' }), /近景·俯拍·正面/);
    assert.match(buildPrompt({ shot_type: '特写', angle: '平视', action: '双手特写。' }), /特写·平视·正面/);
  });

  it('静态成语不被切坏（「飞沙走石」曾按「走」被截成「飞沙」）', () => {
    const p = buildPrompt({ shot_type: '中景', angle: '平视', action: '山路转角忽然刮起一阵黑风，飞沙走石，枯草乱舞，唐僧的白马受惊嘶鸣。' });
    assert.match(p, /飞沙走石/);
    assert.match(p, /枯草乱舞/);
    assert.equal(/忽然/.test(p), true, '副词不是运动，「忽然刮起黑风」是画面内容，首帧正需要它');
  });

  it('动作之后的静态外观描述要保留（头戴金箍、手持铁棒）', () => {
    const p = buildPrompt({ shot_type: '中景', angle: '平视', action: '黑风散尽，一个与悟空一般模样的猴子从风中走出，头戴金箍，手持铁棒，大步走向唐僧马前，双手合十。' });
    assert.match(p, /头戴金箍/);
    assert.match(p, /手持铁棒/);
    assert.equal(/走出|大步走向/.test(p), false, p);
  });

  it('大远景建立镜保留画面内容（紫竹摇曳 / 海浪拍岸 / 观音端坐）', () => {
    const p = buildPrompt({ shot_type: '大远景', angle: '平视', action: '镜头从海面缓缓拉开，展现南海观音道场的全貌，紫竹摇曳，海浪拍岸，莲台之上观音端坐，手持玉净瓶。' });
    assert.match(p, /紫竹摇曳/);
    assert.match(p, /海浪拍岸/);
    assert.match(p, /观音端坐/);
    assert.equal(/拉开/.test(p), false, p);
  });

  it('不在半句处留下悬空的介词短语', () => {
    const p = buildPrompt({ shot_type: '中景', angle: '平视', action: '黑风散尽，一个与悟空一般模样的猴子从风中走出，头戴金箍。' });
    assert.equal(/[从向往朝在沿被把将对跟][^，]*$/.test(p.replace(/，首帧静止画面$/, '')), false, p);
  });

  it('保留姿态本身（该保留的动作起点不被误删）', () => {
    const p = buildPrompt({ shot_type: '远景', angle: '仰视', action: '悟空将金箍棒往地上一杵，纵身一跃。' });
    assert.match(p, /悟空将金箍棒往地上一杵/);
  });

  it('action 为空时不写出空的动作段', () => {
    const p = buildPrompt({ shot_type: '中景', angle: '平视', action: '' });
    assert.equal(/，，/.test(p), false, p);
    assert.match(p, /首帧静止画面$/);
  });

  it('extractInitialPose 对纯运镜描述返回空（不把镜头语言当画面）', () => {
    assert.equal(svc.extractInitialPose('镜头从远处山脊缓缓横摇。'), '');
  });

  it('整句都是动作时返回空，而不是把整段动作当首帧', () => {
    // 兜底曾把整句放回来（只排除了运镜、没排除运动），于是「悟空驾云来到花果山」整句进了首帧
    assert.equal(svc.extractInitialPose('悟空驾云来到花果山'), '');
  });

  it('词表不带 g 标志，且同一输入重复调用结果一致', () => {
    // 带 g 的正则用 .test() 是**有状态**的（lastIndex 会推进），实测因此漏判过
    // 「悟空驾云来到花果山」里的运动词，把动作整段留进了首帧提示词。
    assert.equal(svc.MOTION_WORD_RE.global, false);
    assert.equal(svc.CAMERA_MOTION_RE.global, false);
    const inputs = ['悟空驾云来到花果山', '镜头从山脊缓缓横摇', '他落在水帘洞外', '师徒四人沿山路行进'];
    const once = inputs.map((x) => svc.extractInitialPose(x));
    const twice = inputs.map((x) => svc.extractInitialPose(x));
    assert.deepEqual(once, twice);
    // 连续 .test() 也必须稳定
    const t = inputs.map((x) => svc.MOTION_WORD_RE.test(x));
    const t2 = inputs.map((x) => svc.MOTION_WORD_RE.test(x));
    assert.deepEqual(t, t2);
  });
});
