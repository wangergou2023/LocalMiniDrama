/**
 * 台词提取回归：**无引号的独立台词行**必须能被抽出来。
 *
 * 原实现只认 `…道：“台词”` 的引号形式。而新剧本（1200-1600 字那版提示词之后）把对白写成
 *   唐僧：悟空，天色将晚，你去化些斋饭来。
 * 独立成行、不带引号 —— 于是 extractScriptDialogue 返回 []，台词覆盖自检**静默失效**：
 * drama4 的 29 句台词被报成 total 0，自检「通过」，实际一句都没查。
 * 这正是当年「21 句只保住 13 句」那类静默丢台词的场景，自检必须看得见。
 */
const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { extractScriptDialogue, checkDialogueCoverage } = require('../src/utils/dialogueCoverage');

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

describe('台词覆盖：无引号剧本也能算出覆盖率', () => {
  const script = '唐僧：悟空，天色将晚，你去化些斋饭来。\n假悟空：师父，斋饭化来了。';
  it('分镜里写了台词 → 覆盖', () => {
    const rows = [{ dialogue: '唐僧：悟空，天色将晚，你去化些斋饭来。' }, { dialogue: '假悟空：师父，斋饭化来了。' }];
    const c = checkDialogueCoverage(script, rows);
    assert.equal(c.total, 2);
    assert.equal(c.covered, 2);
  });
  it('分镜里只写了概括（没写原话）→ 报缺失，不再静默通过', () => {
    const rows = [{ action: '悟空满脸委屈地辩解。', dialogue: '' }, { dialogue: '假悟空：师父，斋饭化来了。' }];
    const c = checkDialogueCoverage(script, rows);
    assert.equal(c.total, 2);
    assert.equal(c.covered, 1);
    assert.equal(c.missing.length, 1);
  });
});
