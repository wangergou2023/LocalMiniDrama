'use strict';
/**
 * Agent 三层回归测试（不调用真实 LLM：llm 以依赖注入方式替换）。
 *
 * 锁住的是**架构约束**，不是提示词文案：
 *   1. 权限强制：只读角色的工具白名单里没有写工具，执行器直接拒绝
 *   2. 写角色（优化师）只产出建议、绝不落库；落库走 applySuggestions 且不调 LLM
 *   3. 落库前逐条校验（格式不合规的文本必须被拒或机械修复）
 *   4. 审计报告的合并与 JSON 容错解析
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const Database = require('better-sqlite3');

const registry = require('../src/services/agents/agentRegistry');
const agentTools = require('../src/services/agents/agentTools');
const { runAgent, applySuggestions, mergeReports } = require('../src/services/agents/agentRunner');
const { parseJsonLoose } = require('../src/services/agents/agentPrompts');

const ROOT = path.join(__dirname, '..');
const log = { info() {}, warn() {}, error() {}, debug() {} };

/** 建一个临时库：episodes + storyboards（只放 agent 层用到的列） */
function makeDb() {
  const db = new Database(':memory:');
  db.exec(`
    CREATE TABLE episodes (id INTEGER PRIMARY KEY, title TEXT, script_content TEXT, description TEXT, deleted_at TEXT);
    CREATE TABLE storyboards (
      id INTEGER PRIMARY KEY, episode_id INTEGER, storyboard_number INTEGER, title TEXT, duration INTEGER,
      movement TEXT, shot_type TEXT, dialogue TEXT, action TEXT, narration TEXT, location TEXT,
      creation_mode TEXT, universal_segment_text TEXT, updated_at TEXT, deleted_at TEXT
    );
  `);
  db.prepare('INSERT INTO episodes (id,title,script_content) VALUES (1,?,?)').run('测试集', '字'.repeat(400));
  const good = [
    'subject_definitions:', '- <Subject 1> 是 <Picture 1> 中的「大厅」。',
    'summary:', '镜头自地面升起。',
    'retention_analysis:', '<Subject 1> (appears in [Shot 1]): fully_preserved - 沿用。',
    'detailed_description:', '前三秒镜头缓慢前推，第四秒起固定。 [Shot 1] 中景。',
    'overall_soundscape:', '环境声。', 'non_diegetic_music:', '无。',
  ].join('\n');
  db.prepare(`INSERT INTO storyboards (id,episode_id,storyboard_number,title,duration,movement,shot_type,dialogue,creation_mode,universal_segment_text)
              VALUES (1,1,1,'镜一',12,'推镜push','中景','','universal',?)`).run(good);
  db.prepare(`INSERT INTO storyboards (id,episode_id,storyboard_number,title,duration,movement,shot_type,dialogue,creation_mode,universal_segment_text)
              VALUES (2,1,2,'镜二',10,'跟镜tracking','全景','国王：测试台词。','universal',?)`).run(
    good.replace('[Shot 1] 中景。', '[Shot 2] 全景。').replace('前三秒镜头缓慢前推，第四秒起固定。', '镜头跟着人物走。'));
  return db;
}

test('注册表：三层齐全，只读角色的工具白名单里没有写工具', () => {
  const ids = registry.listAgents().map((a) => a.id);
  for (const id of ['auditor', 'video_prompt_auditor', 'continuity_auditor', 'optimizer', 'director']) {
    assert.ok(ids.includes(id), '缺角色 ' + id);
  }
  assert.equal(registry.getAgent('auditor').layer, 'read');
  assert.equal(registry.getAgent('optimizer').layer, 'write');
  assert.equal(registry.getAgent('director').layer, 'orchestrate');
  for (const id of ['auditor', 'video_prompt_auditor', 'continuity_auditor']) {
    const agent = registry.getAgent(id);
    for (const w of registry.WRITE_TOOLS) {
      assert.equal(agent.toolNames.includes(w), false, `${id} 不应有写工具 ${w}`);
    }
  }
  // 优化师必须有写工具，且要求确认
  assert.ok(registry.getAgent('optimizer').toolNames.includes('update_segment_text'));
  assert.equal(registry.getAgent('optimizer').requiresConfirm, true);
});

test('权限强制：只读角色调用写工具会被执行器拒绝（不是靠自觉）', async () => {
  const db = makeDb();
  await assert.rejects(
    () => agentTools.executeTool(db, log, 'auditor', 'update_segment_text', { storyboard_id: 1, text: 'x' }),
    /无权使用工具/
  );
  await assert.rejects(() => agentTools.executeTool(db, log, 'nobody', 'list_storyboards', {}), /未知角色/);
  await assert.rejects(() => agentTools.executeTool(db, log, 'auditor', 'no_such_tool', {}), /未知工具/);
});

test('审计员：只跑只读工具，返回解析后的报告，且库里数据没有任何变化', async () => {
  const db = makeDb();
  const before = db.prepare('SELECT universal_segment_text t FROM storyboards WHERE id=1').get().t;
  const fakeLlm = async () => JSON.stringify({
    scores: [
      { storyboard_id: 1, shot_number: 1, dims: { specificity: 0.8, camera: 0.7, continuity: 0.9, completeness: 1 }, total: 0.85, issues: [] },
      { storyboard_id: 2, shot_number: 2, dims: { specificity: 0.5, camera: 0.4, continuity: 0.6, completeness: 0.9 }, total: 0.6, issues: ['运镜无动机'], fix_hint: '补动机' },
    ],
    summary: { shots: 2, average: 0.72, grade: 'B', worst: [2] },
    low_score_ids: [2],
  });
  const out = await runAgent(db, log, { agentId: 'auditor', episodeId: 1, llm: fakeLlm });
  assert.equal(out.ok, true);
  assert.equal(out.layer, 'read');
  assert.equal(out.report.scores.length, 2);
  assert.deepEqual(out.report.low_score_ids, [2]);
  assert.equal(db.prepare('SELECT universal_segment_text t FROM storyboards WHERE id=1').get().t, before, '只读角色不应改动数据');
});

test('优化师：只出建议（含 before/after 供 diff），绝不落库', async () => {
  const db = makeDb();
  const beforeRow = db.prepare('SELECT universal_segment_text t FROM storyboards WHERE id=2').get().t;
  const newText = beforeRow.replace('镜头跟着人物走。', '前三秒镜头跟拍人物行进，第四秒起固定机位；台词期间镜头完全固定。');
  const fakeLlm = async () => JSON.stringify({
    suggestions: [{ storyboard_id: 2, shot_number: 2, field: 'universal_segment_text', after: newText, reason: '补运镜动机与时间推进', fixes: ['时间推进', '运镜动机'] }],
    skipped: [],
  });
  const out = await runAgent(db, log, { agentId: 'optimizer', episodeId: 1, storyboardIds: [2], llm: fakeLlm });
  assert.equal(out.ok, true);
  assert.equal(out.requires_confirm, true);
  assert.equal(out.suggestions.length, 1);
  const s = out.suggestions[0];
  assert.equal(s.storyboard_id, 2);
  assert.equal(s.before, beforeRow, '建议里必须带改动前内容');
  assert.notEqual(s.after, beforeRow);
  assert.ok(s.reason.length > 0);
  assert.equal(db.prepare('SELECT universal_segment_text t FROM storyboards WHERE id=2').get().t, beforeRow, '优化师阶段不应落库');
});

test('落库阶段：校验+机械修复后才写，格式坏到无法修复则拒绝', async () => {
  const db = makeDb();
  const bad = '这里完全不是六段结构。';
  const res = await applySuggestions(db, log, {
    suggestions: [{ storyboard_id: 2, field: 'universal_segment_text', after: bad }],
  });
  assert.equal(res.applied_count, 0);
  assert.equal(res.rejected_count, 1);
  assert.match(res.rejected[0].error, /无法修复|校验未通过/);

  const goodRow = db.prepare('SELECT universal_segment_text t FROM storyboards WHERE id=1').get().t;
  const okText = goodRow.replace('第四秒起固定。', '第四秒起完全固定，让台词主导。');
  const res2 = await applySuggestions(db, log, {
    suggestions: [{ storyboard_id: 1, field: 'universal_segment_text', after: okText }],
  });
  assert.equal(res2.applied_count, 1, JSON.stringify(res2));
  assert.match(db.prepare('SELECT universal_segment_text t FROM storyboards WHERE id=1').get().t, /第四秒起完全固定/);
});

test('落库阶段：非白名单字段被拒绝（update_storyboard_field 白名单）', async () => {
  const db = makeDb();
  const res = await applySuggestions(db, log, {
    suggestions: [{ storyboard_id: 1, field: 'image_prompt', after: '偷偷改图片提示词' }],
  });
  assert.equal(res.applied_count, 0);
  assert.match(res.rejected[0].error, /白名单/);
  // duration 白名单内且范围受限
  const ok = await applySuggestions(db, log, { suggestions: [{ storyboard_id: 1, field: 'duration', after: 14 }] });
  assert.equal(ok.applied_count, 1);
  const tooLong = await applySuggestions(db, log, { suggestions: [{ storyboard_id: 1, field: 'duration', after: 60 }] });
  assert.equal(tooLong.applied_count, 0);
  assert.match(tooLong.rejected[0].error, /1-15/);
});

test('报告合并：多批结果拼接、低分镜去重、坏批次计入 failed', () => {
  const merged = mergeReports([
    { scores: [{ storyboard_id: 1 }], low_score_ids: [1], summary: { average: 0.8 } },
    { scores: [{ storyboard_id: 2 }, { storyboard_id: 3 }], low_score_ids: [1, 3], summary: { average: 0.7 } },
    { parse_error: true },
  ]);
  assert.equal(merged.scores.length, 3);
  assert.deepEqual(merged.low_score_ids.sort(), [1, 3]);
  assert.equal(merged.failed_batches, 1);
  assert.equal(merged.parsed_batches, 2);
  assert.equal(merged.summary.average, 0.7);
});

test('JSON 容错解析：容忍 ```json 包裹与前后废话', () => {
  assert.deepEqual(parseJsonLoose('{"a":1}'), { a: 1 });
  assert.deepEqual(parseJsonLoose('```json\n{"a":2}\n```'), { a: 2 });
  assert.deepEqual(parseJsonLoose('好的，结果如下：{"a":3} 以上。'), { a: 3 });
  assert.equal(parseJsonLoose('完全不是 JSON'), null);
});

test('调度层：按 {"action":{...}} / {"final":...} 协议跑工具循环', async () => {
  const db = makeDb();
  let round = 0;
  const fakeLlm = async () => {
    round += 1;
    if (round === 1) return JSON.stringify({ thought: '先看分镜清单', action: { tool: 'list_storyboards', args: { episode_id: 1 } } });
    return JSON.stringify({ thought: '够了', final: '本集 2 镜，第 2 镜运镜缺动机。' });
  };
  const out = await runAgent(db, log, { agentId: 'director', episodeId: 1, instruction: '看看这集', llm: fakeLlm });
  assert.equal(out.ok, true);
  assert.match(out.report.final, /2 镜/);
  assert.equal(out.report.tool_calls, 1);
});

test('路由模块能加载（未注册也不报错）', () => {
  const factory = require('../src/routes/agents');
  assert.equal(typeof factory, 'function');
  const handlers = factory(makeDb(), {}, log);
  for (const k of ['list', 'tools', 'run', 'apply']) assert.equal(typeof handlers[k], 'function', '缺 handler ' + k);
  // 只读角色的 run 不该带任何写副作用：handler 只是转发，不含直接的 SQL 写语句
  const src = require('fs').readFileSync(path.join(ROOT, 'src/routes/agents.js'), 'utf8');
  assert.equal(/UPDATE\s+storyboards|INSERT\s+INTO|DELETE\s+FROM/i.test(src), false, '路由层不应直接写库');
});
