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

test('确定性结论强制并入报告：LLM 漏判的规则问题也会出现在 violations 里', async () => {
  const { buildDeterministicViolations } = require('../src/services/agents/agentRunner');
  const ctx = {
    summarize: {
      movement_missing_sample: [{ id: 5, n: 5, movement: '推镜push' }],
      timeline_missing_sample: [{ id: 3, n: 3, duration: 13 }],
      duration_coverage: { script_seconds: 198, shots_seconds: 153, ratio: 0.77, short_by: 45 },
    },
    noncompliant: [{ storyboard_id: 9, shot_number: 9, problems: ['第一个镜头必须是 [Shot 1]'] }],
  };
  const v = buildDeterministicViolations(ctx, 'video_prompt_auditor');
  const rules = v.map((x) => x.rule).join(' | ');
  assert.match(rules, /规则1 运镜/);
  assert.match(rules, /规则3 镜内时间推进/);
  assert.match(rules, /规则6 剧情完整性/);
  assert.match(rules, /格式 Ref2VA/);
  assert.equal(v.every((x) => x.source === 'deterministic'), true);
  assert.equal(v.find((x) => x.rule === '规则3 镜内时间推进').storyboard_id, 3);
  // 覆盖率达标时不该报剧情完整性
  const ok = buildDeterministicViolations({ summarize: { duration_coverage: { ratio: 0.97, script_seconds: 198, shots_seconds: 193, short_by: 5 } } }, 'auditor');
  assert.equal(ok.some((x) => /剧情完整性/.test(x.rule)), false);
});

test('内容保全：丢段落/丢对白/丢参考标签/过度压缩 一律拒收', async () => {
  const { checkContentPreservation, spliceSection } = agentTools;
  const doc = [
    'subject_definitions:', '- <Subject 1> 是 <Picture 1> 中的「大厅」。- <Subject 2> 是 <Picture 2> 中的「国王」。',
    'summary:', '概述。',
    'retention_analysis:', '<Subject 1> (appears in [Shot 1]): fully_preserved - 沿用。',
    'detailed_description:', '[Shot 1] 中景。<d>[Chinese] 台词原文。</d>',
    'overall_soundscape:', '环境声。', 'non_diegetic_music:', '无。',
  ].join('\n');
  assert.equal(checkContentPreservation(doc, doc).ok, true);
  // 丢段落
  assert.match(checkContentPreservation(doc, '[Shot 1] 只剩正文').error, /丢失段落/);
  // 丢对白
  assert.match(checkContentPreservation(doc, doc.replace('<d>[Chinese] 台词原文。</d>', '')).error, /对白被改动\/删除/);
  // 丢参考标签
  assert.match(checkContentPreservation(doc, doc.replace('<Picture 2>', '')).error, /参考标签丢失/);
  // 段落补丁：只换 §5，其余段落原样保留
  const spliced = spliceSection(doc, 'detailed_description', '[Shot 1] 前三秒推近，第四秒起完全固定。<d>[Chinese] 台词原文。</d>');
  assert.equal(spliced.ok, true);
  assert.match(spliced.text, /subject_definitions/);
  assert.match(spliced.text, /台词原文/);
  assert.match(spliced.text, /第四秒起完全固定/);
  assert.equal(spliced.text.includes('旧正文'), false);
});

test('段落补丁落库：保全校验通过才写，写后其余段落与对白不变', async () => {
  const db = makeDb();
  const original = db.prepare('SELECT universal_segment_text t FROM storyboards WHERE id=1').get().t;
  const newBody = original.split('detailed_description:')[1].split('overall_soundscape:')[0].trim().replace('第四秒起固定', '第四秒起完全固定');
  const okRes = await applySuggestions(db, log, {
    suggestions: [{ storyboard_id: 1, field: 'universal_segment_text', section: 'detailed_description', after: newBody }],
  });
  assert.equal(okRes.applied_count, 1, JSON.stringify(okRes));
  const after = db.prepare('SELECT universal_segment_text t FROM storyboards WHERE id=1').get().t;
  assert.match(after, /第四秒起完全固定/);
  assert.match(after, /subject_definitions/);
  assert.match(after, /non_diegetic_music/);
  assert.equal(okRes.applied[0].section, 'detailed_description');

  // 整篇替换但丢段落 → 拒收
  const bad = await applySuggestions(db, log, {
    suggestions: [{ storyboard_id: 1, field: 'universal_segment_text', after: '只有一句正文' }],
  });
  assert.equal(bad.applied_count, 0);
  assert.match(bad.rejected[0].error, /内容保全校验未通过|丢失段落/);
});

test('模型把段名写在 field 里也算段落补丁（否则正确建议会被白名单误杀）', async () => {
  const db = makeDb();
  const original = db.prepare('SELECT universal_segment_text t FROM storyboards WHERE id=1').get().t;
  const newBody = original.split('detailed_description:')[1].split('overall_soundscape:')[0].trim().replace('第四秒起固定', '第四秒起完全固定');
  const fakeLlm = async () => JSON.stringify({
    suggestions: [{ storyboard_id: 1, shot_number: 1, field: 'detailed_description', after: newBody, reason: '补时间推进' }],
  });
  const out = await runAgent(db, log, { agentId: 'optimizer', episodeId: 1, storyboardIds: [1], llm: fakeLlm });
  assert.equal(out.suggestions.length, 1, JSON.stringify(out.suggestions));
  assert.equal(out.suggestions[0].section, 'detailed_description');
  assert.equal(out.suggestions[0].field, 'universal_segment_text');
  // 落库后其余段落仍在
  const res = await applySuggestions(db, log, { suggestions: out.suggestions });
  assert.equal(res.applied_count, 1, JSON.stringify(res));
  const after = db.prepare('SELECT universal_segment_text t FROM storyboards WHERE id=1').get().t;
  assert.match(after, /第四秒起完全固定/);
  assert.match(after, /subject_definitions/);
});

test('上下文按镜号收敛：指定 storyboard_ids 后，确定性结论里不能出现别的镜（bug3 回归）', async () => {
  const { gatherContext } = require('../src/services/agents/agentRunner');
  const db = makeDb();
  // 造两条"有毛病"的镜：movement 有值但 §5 没写运镜 / 长镜没写时间推进
  const body = (shotTag) => [
    'subject_definitions:', '- <Subject 1> 是 <Picture 1> 中的「大厅」。',
    'summary:', '概述。',
    'retention_analysis:', '<Subject 1> (appears in [Shot 1]): fully_preserved - 沿用。',
    'detailed_description:', `${shotTag} 中景，画面保持不动。`,
    'overall_soundscape:', '环境声。', 'non_diegetic_music:', '无。',
  ].join('\n');
  db.prepare(`INSERT INTO storyboards (id,episode_id,storyboard_number,title,duration,movement,shot_type,dialogue,creation_mode,universal_segment_text)
              VALUES (11,1,11,'镜十一',12,'推镜push','中景','','universal',?)`).run(body('[Shot 1]'));
  db.prepare(`INSERT INTO storyboards (id,episode_id,storyboard_number,title,duration,movement,shot_type,dialogue,creation_mode,universal_segment_text)
              VALUES (12,1,12,'镜十二',13,'拉镜pull','全景','','universal',?)`).run(body('[Shot 1]'));

  const ctxAll = await gatherContext(db, log, 'optimizer', { episodeId: 1, storyboardIds: null });
  assert.ok(ctxAll.deterministic.summarize.movement_missing_sample.length >= 2, JSON.stringify(ctxAll.deterministic.summarize.movement_missing_sample));

  const ctxScoped = await gatherContext(db, log, 'optimizer', { episodeId: 1, storyboardIds: [11] });
  const ids = ctxScoped.deterministic.summarize.movement_missing_sample.map((x) => Number(x.id));
  assert.deepEqual(ids, [11], '收敛后只应包含目标镜：' + JSON.stringify(ids));
  assert.equal(ctxScoped.deterministic.summarize.movement_missing, 1);
  assert.equal(ctxScoped.deterministic.summarize.timeline_missing_sample.every((x) => Number(x.id) === 11), true);
  // 指定的镜本身也要出现在上下文里
  assert.deepEqual(ctxScoped.shots.map((s) => Number(s.storyboard_id)), [11]);
});

test('显式空 storyboard_ids 不等于"整集"（否则会白烧一次全片 LLM）', async () => {
  const db = makeDb();
  let called = 0;
  const fakeLlm = async () => { called += 1; return '{}'; };
  const out = await runAgent(db, log, { agentId: 'optimizer', episodeId: 1, storyboardIds: [], llm: fakeLlm });
  assert.equal(out.ok, true);
  assert.equal(called, 0, '空数组时不应调用 LLM');
  assert.equal(out.meta.skipped_all, true);
  assert.match(out.report.note, /空数组/);
});

test('Agent 预算跟随思考设置 + 批次 6 + 空返回拆分重试', () => {
  const src = require('fs').readFileSync(path.join(__dirname, '../src/services/agents/agentRunner.js'), 'utf8');
  assert.match(src, /DEFAULT_AUDIT_BATCH = 6/);
  assert.match(src, /function agentTokenBudget\(db\)/);
  assert.match(src, /storyboardMaxTokens\(db\)/);
  assert.match(src, /批次返回为空，拆分重试/);
  assert.match(src, /mid = Math\.ceil\(shots\.length \/ 2\)/);
});

test('模型把 shot_number 写成 1 时，findings 仍能挂回真实 storyboard_id', () => {
  const { attachStoryboardIds } = require('../src/services/agents/agentRunner');
  const shots = [
    { storyboard_id: 748, shot_number: 1 }, { storyboard_id: 749, shot_number: 2 },
    { storyboard_id: 750, shot_number: 3 },
  ];
  const rep = attachStoryboardIds({
    violations: [
      { shot_number: 1, rule: 'A' }, { shot_number: 1, rule: 'B' }, { shot_number: 1, rule: 'C' },
    ],
    scores: [{ storyboard_id: 750, shot_number: 3, total: 0.5 }],
  }, shots);
  assert.deepEqual(rep.violations.map((v) => v.storyboard_id), [748, 749, 750], '同号时按批内顺序回退，避免全部挤到 0 号镜');
  assert.equal(rep.scores[0].storyboard_id, 750);
  // 无法定位时不硬塞：标 null + unmatched
  const rep2 = attachStoryboardIds({ violations: [{ shot_number: 99 }, {}] }, shots);
  assert.equal(rep2.violations.every((v) => v.storyboard_id !== undefined), true);
});
