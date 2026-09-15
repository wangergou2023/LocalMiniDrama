'use strict';
/**
 * Agent 运行器：三层共用一套执行路径。
 *
 *   read 层  → 直接产出报告（只调用只读工具）
 *   write 层 → 只产出**建议**（绝不落库）；落库在 applySuggestions()，且那一步不再调用 LLM
 *   orchestrate 层 → 小步工具循环（每轮最多一次工具调用），工具权限同样受白名单约束
 *
 * 依赖注入：llm 可替换（测试用假模型），默认走 aiClient.generateText。
 */

const aiClient = require('../aiClient');
const { getAgent } = require('./agentRegistry');
const { executeTool, slimShot, analysisExcerpt, loadStoryboards } = require('./agentTools');
const { buildSystemPrompt, buildUserPrompt, parseJsonLoose } = require('./agentPrompts');

const DEFAULT_AUDIT_BATCH = 12;

async function defaultLlm(db, log, { systemPrompt, userPrompt, json = true, maxTokens = 8000, temperature = 0.2 }) {
  return aiClient.generateText(db, log, 'text', userPrompt, systemPrompt, {
    json_mode: json,
    max_tokens: maxTokens,
    temperature,
    scene_key: 'agent_review',
  });
}

/** 组装一次审查/优化所需的上下文（全部经由该角色的工具，权限自然受限） */
async function gatherContext(db, log, agentId, { episodeId, storyboardIds, withScript = false }) {
  const listRes = await executeTool(db, log, agentId, 'list_storyboards', { episode_id: episodeId });
  let shots = (listRes && listRes.data) || [];
  const idSet = Array.isArray(storyboardIds) && storyboardIds.length
    ? new Set(storyboardIds.map(Number))
    : null;
  if (idSet) shots = shots.filter((s) => idSet.has(Number(s.storyboard_id)));

  const full = loadStoryboards(db, episodeId);
  const byId = new Map(full.map((r) => [Number(r.id), r]));
  const enriched = shots.map((s) => {
    const r = byId.get(Number(s.storyboard_id)) || {};
    return { ...s, analysis: analysisExcerpt(r, 1500) };
  });

  let deterministic = null;
  try {
    const sum = await executeTool(db, log, agentId, 'summarize_episode', { episode_id: episodeId });
    const fmt = await executeTool(db, log, agentId, 'validate_formats', { episode_id: episodeId });
    deterministic = {
      summarize: sum && sum.data ? sum.data : null,
      noncompliant_count: fmt && fmt.data ? fmt.data.noncompliant : null,
      noncompliant: fmt && fmt.data ? fmt.data.items.slice(0, 5) : null,
    };
  } catch (_) { /* 自检失败不阻塞审查 */ }

  let script = '';
  if (withScript) {
    const s = await executeTool(db, log, agentId, 'get_episode_script', { episode_id: episodeId });
    script = (s && s.data && s.data.script) || '';
  }
  return { shots: enriched, deterministic, script };
}

/**
 * 跑一个角色。
 * @returns {Promise<{ok:boolean, agent_id:string, layer:string, report?:object, suggestions?:Array, skipped?:Array, meta:object, error?:string}>}
 */
async function runAgent(db, log, params = {}) {
  const agentId = String(params.agentId || params.agent_id || '').trim();
  const agent = getAgent(agentId);
  if (!agent) return { ok: false, error: `未知角色：${agentId}`, agent_id: agentId };
  const episodeId = Number(params.episodeId || params.episode_id);
  if (!Number.isFinite(episodeId) || episodeId <= 0) return { ok: false, error: '缺少有效的 episode_id', agent_id: agentId };

  const llm = params.llm || defaultLlm;
  const targetIds = params.storyboardIds || params.storyboard_ids || null;
  const instruction = params.instruction || '';
  const started = Date.now();

  // 调度层：走小步工具循环
  if (agent.layer === 'orchestrate') {
    return runOrchestrator(db, log, agent, { episodeId, instruction, llm, targetIds, started });
  }

  const ctx = await gatherContext(db, log, agentId, {
    episodeId,
    storyboardIds: targetIds,
    withScript: agentId === 'auditor' || agentId === 'video_prompt_auditor',
  });

  const batchSize = agent.layer === 'write' ? Math.max(targetIds ? targetIds.length : 1, 1) : DEFAULT_AUDIT_BATCH;
  const batches = [];
  for (let i = 0; i < ctx.shots.length; i += batchSize) batches.push(ctx.shots.slice(i, i + batchSize));
  if (!batches.length) return { ok: true, agent_id: agentId, layer: agent.layer, report: { note: '该集合没有分镜' }, meta: { shots: 0, ms: Date.now() - started } };

  const systemPrompt = buildSystemPrompt(agentId);
  const reports = [];
  for (const shots of batches) {
    const userPrompt = buildUserPrompt({
      agentId, episodeId, storyboards: shots, deterministic: batches.length === 1 ? ctx.deterministic : null,
      script: ctx.script, targetIds: null, instruction,
    });
    const raw = await llm(db, log, { systemPrompt, userPrompt, json: agent.outputContract.type === 'json', maxTokens: 12000 });
    const parsed = agent.outputContract.type === 'json' ? parseJsonLoose(raw) : { text: String(raw || '') };
    reports.push(parsed || { parse_error: true, raw_excerpt: String(raw || '').slice(0, 600) });
  }

  // 合并多批结果
  const merged = mergeReports(reports);

  // **确定性结论强制并入**：LLM 对"规则符合性"不如代码可靠（实测：它把缺时间推进的 #3/#5/#8 判成干净）。
  // 所以把 summarize_episode / validate_formats 已经算出来的问题当作事实追加进报告，
  // LLM 只负责它擅长的语义判断（剧情完整性、连贯性、运镜动机是否说得通）。
  if (agent.layer === 'read' && ctx.deterministic) {
    merged.deterministic_violations = buildDeterministicViolations(ctx.deterministic, agentId);
    merged.deterministic_count = merged.deterministic_violations.length;
    if (agentId === 'video_prompt_auditor' || agentId === 'auditor') {
      merged.violations = (merged.violations || []).concat(merged.deterministic_violations);
      // 注意：集级别的违规（如总时长偏短）storyboard_id 为 null，不能当成 0 号镜
      const flagged = new Set(merged.deterministic_violations.map((v) => Number(v.storyboard_id)).filter((n) => Number.isFinite(n) && n > 0));
      merged.low_score_ids = Array.from(new Set((merged.low_score_ids || []).concat([...flagged])));
      if (Array.isArray(merged.clean_ids)) merged.clean_ids = merged.clean_ids.filter((id) => !flagged.has(Number(id)));
    }
  }
  const meta = {
    shots: ctx.shots.length,
    batches: batches.length,
    ms: Date.now() - started,
    deterministic_used: !!ctx.deterministic,
  };

  if (agent.layer === 'write') {
    const suggestions = enrichSuggestions(merged.suggestions || [], ctx.shots, db, log, agent);
    return {
      ok: true,
      agent_id: agentId,
      layer: agent.layer,
      requires_confirm: true,
      suggestions,
      skipped: merged.skipped || [],
      meta,
    };
  }
  return { ok: true, agent_id: agentId, layer: agent.layer, report: merged, meta };
}

/**
 * 把确定性自检结论翻译成与 LLM 同构的 violations（这样前端只需消费一种结构）。
 * 覆盖：运镜缺失 / 长镜缺时间推进 / 格式不合规 / 总时长偏短。
 */
function buildDeterministicViolations(deterministic, agentId) {
  const out = [];
  const sum = (deterministic && deterministic.summarize) || {};
  for (const s of sum.movement_missing_sample || []) {
    out.push({
      storyboard_id: s.id, shot_number: s.n, rule: '规则1 运镜',
      severity: 'medium', source: 'deterministic',
      evidence: `movement 字段为「${s.movement || '未指定'}」，但 §5 正文里没有对应的运镜描述`,
      suggestion: '按 movement 字段补一句运镜（方向+速度+跟随对象+动机）；若不需要运镜就写固定机位',
    });
  }
  for (const s of sum.timeline_missing_sample || []) {
    out.push({
      storyboard_id: s.id, shot_number: s.n, rule: '规则3 镜内时间推进',
      severity: 'medium', source: 'deterministic',
      evidence: `${s.duration} 秒长镜，正文里没有「第几秒→第几秒」的时间推进`,
      suggestion: '补起幅→过程→落幅（可写 in the first two seconds … from the third second onward …；固定机位同样合格）',
    });
  }
  const cov = sum.duration_coverage || {};
  if (cov.ratio != null && cov.ratio < 0.9) {
    out.push({
      storyboard_id: null, shot_number: null, rule: '规则6 剧情完整性',
      severity: 'high', source: 'deterministic',
      evidence: `分镜总时长 ${cov.shots_seconds}s，剧本朗读时长 ${cov.script_seconds}s（覆盖率 ${cov.ratio}，短 ${cov.short_by}s）`,
      suggestion: '补镜或给足单镜时长；不得压缩/省略原文动作与台词',
    });
  }
  for (const item of (deterministic && deterministic.noncompliant) || []) {
    out.push({
      storyboard_id: item.storyboard_id, shot_number: item.shot_number, rule: '格式 Ref2VA 六段',
      severity: 'high', source: 'deterministic',
      evidence: (item.problems || []).slice(0, 2).join('; '),
      suggestion: '按六段结构补齐/修正结构记号（可由系统机械修复）',
    });
  }
  return out;
}

/** 审计类报告合并：scores/violations/breaks 追加，summary 以最后一批准 */
function mergeReports(reports) {
  const out = { parsed_batches: 0, failed_batches: 0 };
  const arrays = ['scores', 'violations', 'breaks', 'global_issues', 'suggestions', 'skipped'];
  for (const r of reports) {
    if (!r || r.parse_error) { out.failed_batches += 1; continue; }
    out.parsed_batches += 1;
    for (const k of arrays) {
      if (Array.isArray(r[k]) && r[k].length) out[k] = (out[k] || []).concat(r[k]);
    }
    if (r.summary) out.summary = Object.assign({}, out.summary || {}, r.summary);
    if (Array.isArray(r.low_score_ids) && r.low_score_ids.length) {
      out.low_score_ids = Array.from(new Set((out.low_score_ids || []).concat(r.low_score_ids)));
    }
    if (Array.isArray(r.clean_ids) && r.clean_ids.length) {
      out.clean_ids = Array.from(new Set((out.clean_ids || []).concat(r.clean_ids)));
    }
  }
  return out;
}

/** 给建议补上"改前"内容，便于前端做 diff（不落库） */
function enrichSuggestions(suggestions, shots, db, log, agent) {
  const allowed = agent.allowedFields || ['universal_segment_text'];
  const out = [];
  for (const s of Array.isArray(suggestions) ? suggestions : []) {
    const id = Number(s.storyboard_id);
    if (!Number.isFinite(id) || !s.after) continue;
    const field = String(s.field || 'universal_segment_text');
    if (!allowed.includes(field)) continue;
    const row = db.prepare(`SELECT ${field === 'duration' ? 'duration' : field} AS before FROM storyboards WHERE id = ?`).get(id);
    out.push({
      storyboard_id: id,
      shot_number: s.shot_number != null ? s.shot_number : null,
      field,
      before: row ? row.before : null,
      after: String(s.after),
      reason: s.reason || '',
      fixes: Array.isArray(s.fixes) ? s.fixes : [],
    });
  }
  return out;
}

/**
 * 落库建议（第二阶段，**不再调用 LLM**，保证"预览 = 结果"）。
 * 每条都走写工具 → 校验+机械修复 → 通过才写。
 */
async function applySuggestions(db, log, params = {}) {
  const agentId = String(params.agentId || 'optimizer');
  const suggestions = Array.isArray(params.suggestions) ? params.suggestions : [];
  const applied = [];
  const rejected = [];
  for (const s of suggestions) {
    const id = Number(s && s.storyboard_id);
    const field = String((s && s.field) || 'universal_segment_text');
    if (!Number.isFinite(id) || s.after == null) { rejected.push({ storyboard_id: s && s.storyboard_id, error: '参数不完整' }); continue; }
    try {
      const res = field === 'universal_segment_text'
        ? await executeTool(db, log, agentId, 'update_segment_text', { storyboard_id: id, text: s.after })
        : await executeTool(db, log, agentId, 'update_storyboard_field', { storyboard_id: id, field, value: s.after });
      if (res && res.ok) applied.push({ storyboard_id: id, field, repairs: (res.data && res.data.repairs) || [] });
      else rejected.push({ storyboard_id: id, field, error: (res && res.error) || '写入失败' });
    } catch (e) {
      rejected.push({ storyboard_id: id, field, error: e.message });
    }
  }
  log.info('[agent] 建议落库', { agent: agentId, applied: applied.length, rejected: rejected.length });
  return { ok: rejected.length === 0, applied, rejected, applied_count: applied.length, rejected_count: rejected.length };
}

/**
 * 调度层：小步工具循环。模型每轮返回 {"action":{"tool":..,"args":{..}}} 或 {"final":"..."}。
 * 工具权限同样受白名单约束（写工具会在 executeTool 里按 director 的权限判定）。
 */
async function runOrchestrator(db, log, agent, { episodeId, instruction, llm, targetIds, started }) {
  const systemPrompt = [
    buildSystemPrompt(agent.id),
    '',
    '## 工具循环协议',
    '每轮只输出一个 JSON 对象，二选一：',
    '{"thought":"...","action":{"tool":"工具名","args":{...}}}  —— 需要调用工具时',
    '{"thought":"...","final":"给用户的结论"}  —— 任务完成时',
    `可用工具：${agent.toolNames.join(', ')}`,
  ].join('\n');
  const transcript = [];
  let finalText = '';
  for (let round = 1; round <= 4; round++) {
    const userPrompt = buildUserPrompt({ agentId: agent.id, episodeId, instruction, storyboards: null, deterministic: null, script: '', targetIds })
      + (transcript.length ? `\n\n## 已执行的工具与结果\n${transcript.join('\n')}` : '');
    const raw = await llm(db, log, { systemPrompt, userPrompt, json: true, maxTokens: 6000 });
    const parsed = parseJsonLoose(raw) || {};
    if (parsed.final) { finalText = String(parsed.final); break; }
    const action = parsed.action;
    if (!action || !action.tool) { finalText = String(parsed.thought || raw || '').slice(0, 2000); break; }
    let result;
    try {
      result = await executeTool(db, log, agent.id, action.tool, action.args || {}, { llm });
    } catch (e) {
      result = { ok: false, error: e.message };
    }
    transcript.push(`- ${action.tool}(${JSON.stringify(action.args || {})}) → ${JSON.stringify(result).slice(0, 800)}`);
  }
  return {
    ok: true,
    agent_id: agent.id,
    layer: agent.layer,
    report: { final: finalText || '（达到工具轮次上限，未给出结论）', tool_calls: transcript.length },
    meta: { ms: Date.now() - started, rounds: transcript.length },
  };
}

module.exports = { runAgent, applySuggestions, gatherContext, mergeReports, buildDeterministicViolations, DEFAULT_AUDIT_BATCH };
