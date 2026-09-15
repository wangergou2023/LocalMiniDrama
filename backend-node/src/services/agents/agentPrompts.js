'use strict';
/**
 * Agent 提示词构建：把「角色 + 它的知识片段 + 任务上下文」拼成一次 LLM 调用。
 *
 * 这里刻意做窄：每个角色只注入 agentRegistry 里它自己那份 knowledge，
 * 不把整套 ust 规范（4800 字）塞给所有角色 —— 上下文越窄判断越准。
 * 输出一律要求严格 JSON（json_mode），并给出字段形状与取值约束。
 */

const { getAgent } = require('./agentRegistry');

/** 把对象形状说明渲染成可读的 JSON 模板（给模型当格式范例） */
function shapeToExample(shape) {
  if (typeof shape === 'string') return `<${shape}>`;
  if (Array.isArray(shape)) return shape.length ? [shapeToExample(shape[0])] : [];
  if (shape && typeof shape === 'object') {
    const out = {};
    for (const [k, v] of Object.entries(shape)) out[k] = shapeToExample(v);
    return out;
  }
  return shape;
}

function contractBlock(agent) {
  const c = agent.outputContract;
  if (!c || c.type !== 'json') return '';
  const example = JSON.stringify(shapeToExample(c.shape), null, 1);
  const lines = [
    '## 输出契约（必须严格遵守）',
    '- 只输出一个 JSON 对象，不要 markdown 代码块、不要解释文字。',
    '- 字段名与层级必须与下面范例一致；没有问题的项就留空数组。',
  ];
  if (c.threshold != null) lines.push(`- 低分阈值：总分 < ${c.threshold} 的镜号放进 low_score_ids。`);
  lines.push('', '范例格式：', example);
  return lines.join('\n');
}

function knowledgeBlock(agent) {
  const k = agent.knowledge || [];
  if (!k.length) return '';
  return ['## 你的判断依据（只依据这些）', ...k.map((x) => `- ${x}`)].join('\n');
}

/** 角色的 system prompt：身份 + 依据 + 契约 + 行为准则 */
function buildSystemPrompt(agentId) {
  const agent = getAgent(agentId);
  if (!agent) throw new Error(`未知角色：${agentId}`);
  const parts = [
    `你是「${agent.name}」。${agent.summary}`,
    '',
    knowledgeBlock(agent),
    '',
  ];
  if (agent.layer === 'read') {
    parts.push('## 行为准则');
    parts.push('- 你**没有写权限**（工具白名单里没有任何写工具），绝不要建议之外声称"已修改"。');
    parts.push('- 评分/判定必须引用镜内原文片段作为依据，不许凭空扣分或编造问题。');
    parts.push('- 信息不足时宁可少报，不要臆测剧情。');
    parts.push('');
  } else if (agent.layer === 'write') {
    parts.push('## 行为准则');
    parts.push('- 你只**产出建议**，不落库；写回由用户在界面上确认后系统执行。');
    parts.push('- 只改被指定的镜与允许的字段，未指定的不动。');
    parts.push('- 必须保持六段结构与全部结构记号原样（<Subject N>/<Picture N>/<Audio j>、retention 标记、[Shot N] At MM:SS.mmm、<d>…</d>）。');
    parts.push('- 台词逐字保留；不得删减动作、因果、情绪转折。');
    parts.push('');
  }
  const cb = contractBlock(agent);
  if (cb) parts.push(cb);
  return parts.join('\n');
}

/**
 * 用户消息：任务 + 上下文（分镜清单 / 确定性自检结论 / 剧本片段 / 指定镜号）
 */
function buildUserPrompt({ agentId, episodeId, storyboards, deterministic, script, targetIds, instruction }) {
  const agent = getAgent(agentId);
  const lines = [];
  lines.push(`## 任务`);
  if (instruction) lines.push(instruction);
  else if (agent && agent.layer === 'write') lines.push(`请针对指定分镜产出优化建议（只出建议，不落库）。`);
  else lines.push(`请审查第 ${episodeId} 集的分镜并给出结论。`);
  lines.push('');

  if (targetIds && targetIds.length) {
    lines.push(`## 只处理这些分镜（storyboard_id）`);
    lines.push(targetIds.join(', '));
    lines.push('');
  }

  if (deterministic) {
    lines.push('## 系统确定性自检结论（已由代码算出，可直接采信）');
    lines.push(JSON.stringify(deterministic, null, 1));
    lines.push('');
  }

  if (Array.isArray(storyboards) && storyboards.length) {
    lines.push(`## 分镜清单（共 ${storyboards.length} 镜）`);
    for (const s of storyboards) {
      lines.push(`### storyboard_id=${s.storyboard_id} 第${s.shot_number}镜 「${s.title}」 时长=${s.duration}s 运镜=${s.movement || '未指定'} 景别=${s.shot_type || '未指定'}`);
      if (s.dialogue) lines.push(`台词：${String(s.dialogue).slice(0, 120)}`);
      if (s.analysis) lines.push('正文（§5）：');
      lines.push(s.analysis);
      lines.push('');
    }
  }

  if (script) {
    lines.push('## 剧本原文（判定是否遗漏剧情的唯一依据）');
    lines.push(String(script).slice(0, 6000));
    lines.push('');
  }
  return lines.join('\n');
}

/** 从 LLM 返回文本里稳健地取出 JSON（容忍 ```json 包裹与前后废话） */
function parseJsonLoose(text) {
  const raw = String(text || '').trim();
  if (!raw) return null;
  const tryParse = (s) => { try { return JSON.parse(s); } catch (_) { return null; } };
  let v = tryParse(raw);
  if (v) return v;
  const fence = raw.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fence) { v = tryParse(fence[1].trim()); if (v) return v; }
  const first = raw.indexOf('{');
  const last = raw.lastIndexOf('}');
  if (first >= 0 && last > first) { v = tryParse(raw.slice(first, last + 1)); if (v) return v; }
  return null;
}

module.exports = { buildSystemPrompt, buildUserPrompt, parseJsonLoose, contractBlock };
