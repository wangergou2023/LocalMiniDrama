/**
 * 台词提取回归：**无引号的独立台词行**必须能被抽出来。
 *
 * 原实现只认 `…道：“台词”` 的引号形式。而新剧本（1200-1600 字那版提示词之后）把对白写成
 *   唐僧：悟空，天色将晚，你去化些斋饭来。
 * 独立成行、不带引号 —— 于是 extractScriptDialogue 返回 []，「必须逐字保留的台词清单」
 * 变成空清单，台词被静默丢掉（21 句只保住 13 句就是这么来的）。
 */
const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { extractScriptDialogue } = require('../src/utils/dialogueCoverage');

describe('剧本台词提取', () => {
  it('无引号的独立台词行也能抽出来', () => {
    const script = [
      '唐僧师徒四人行至一处荒山野岭。悟空执棒在前开路。',
      '',
      '唐僧：悟空，天色将晚，你去化些斋饭来。',
      '',
      '假悟空大步走到唐僧马前，双手合十。',
      '假悟空：师父，斋饭化来了。',
    ].join('\n');
    const d = extractScriptDialogue(script);
    assert.equal(d.length, 2);
    assert.equal(d[0].speaker, '唐僧');
    assert.equal(d[0].line, '悟空，天色将晚，你去化些斋饭来。');
  });

  it('引号形式仍然有效（老剧本不受影响）', () => {
    const script = '八戒扛着钉耙嘟囔：“这地方阴森森的，连个野果都没有。”';
    const d = extractScriptDialogue(script);
    assert.equal(d.length, 1);
    assert.equal(d[0].speaker, '八戒扛着钉耙嘟囔'.slice(-8));
  });

  it('一行多段对白不会拼成垃圾句', () => {
    const script = '唐僧：“悟空！你为何无故伤人！”悟空指着白骨：“它是妖怪变的！”';
    const d = extractScriptDialogue(script);
    assert.equal(d.length, 2, JSON.stringify(d));
    assert.equal(d.some((x) => x.line.includes('悟空指着白骨')), false);
  });

  it('正文里的冒号不会被当成台词', () => {
    const script = '他想起师父的叮嘱：出家人不可妄语。山风穿过枯林。';
    assert.equal(extractScriptDialogue(script).length, 0);
  });

  it('场景/元信息行不算台词', () => {
    const script = '【镜头类型】近景\n【运镜】推镜\n场景：（荒山野岭，傍晚）';
    assert.equal(extractScriptDialogue(script).length, 0);
  });

  it('同一句重复出现只算一次', () => {
    const script = '悟空：师父等我。\n悟空：师父等我。';
    assert.equal(extractScriptDialogue(script).length, 1);
  });
});

/**
 * 剧本台词抽取的三处真实缺陷（都在 drama7 ep21 上实测出来）：
 *  ① 引号只认 “”/" ，不认剧本常用的「」→ 必保台词被静默抽成空数组，覆盖率自检形同虚设
 *  ② 「国王立刻下令：整段」被当成"说话人：台词"，冒号后的**旁白句**被吞成台词
 *     → 成片里国王把「士兵们闯入每一户人家…火焰冲天」念了出来
 *  ③ 说话人抓成了描述词（「声音嘶哑」「杖轻点爱洛的额头」）
 */

describe('剧本台词抽取的真实缺陷回归', () => {
  it('角引号「」的台词要被抽出来', () => {
  const script = '仙女展开银白翅膀，魔杖轻点爱洛的额头：「我不能解除诅咒，但可以减轻它。」';
  const lines = extractScriptDialogue(script, { knownSpeakers: ['仙女', '爱洛'] });
  assert.equal(lines.length, 1);
  assert.equal(lines[0].line, '我不能解除诅咒，但可以减轻它。');
  assert.equal(lines[0].speaker, '仙女', '应取引号前最近的角色名，而不是窗口里的描述词');
});

  it('无引号的「下令：台词。旁白句」只取台词，旁白不算台词', () => {
  const script = '国王立刻下令：全国收缴所有纺锤，当众焚毁。士兵们闯入每一户人家，把纺锤扔进广场火堆，火焰冲天。';
  const lines = extractScriptDialogue(script, { knownSpeakers: ['国王'] });
  assert.equal(lines.length, 1);
  assert.equal(lines[0].speaker, '国王', '说话人里的动作动词（立刻下令）要剥掉');
  assert.equal(lines[0].line, '全国收缴所有纺锤，当众焚毁。');
  assert.equal(/士兵们闯入/.test(lines[0].line), false, '旁白句不得进台词');
});

});
