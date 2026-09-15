'use strict';
/**
 * Agent 工具层 —— 带**权限强制**的工具注册表与执行器。
 *
 * 核心原则（来自字字动画）：只读角色拿不到写工具，不是靠模型自觉，而是执行器直接拒绝。
 * executeTool() 是唯一入口：先查角色白名单，再查工具是否写操作，任一不过就抛错。
 */

const { canUseTool, getAgent } = require('./agentRegistry');
const ref2va = require('../ref2vaFormat');
const universal = require('../universalOmniMultiBeatFormat');
const { getStoryboardsForEpisode } = require('../episodeStoryboardService');

/** 一次性取出该集分镜（工具都基于它） */
function loadStoryboards(db, episodeId) {
  const ep = Number(episodeId);
  if (!Number.isFinite(ep)) return [];
  try {
    return getStoryboardsForEpisode(db, ep) || [];
  } catch (_) {
    return db.prepare(
      `SELECT * FROM storyboards WHERE episode_id = ? AND deleted_at IS NULL ORDER BY storyboard_number`
    ).all(ep);
  }
}

function slimShot(r) {
  return {
    storyboard_id: r.id,
    shot_number: r.storyboard_number,
    title: r.title || '',
    duration: Number(r.duration) || 0,
    movement: r.movement || '',
    shot_type: r.shot_type || '',
    dialogue: r.dialogue || '',
    creation_mode: r.creation_mode || '',
    location: r.location || '',
  };
}

/** 供 LLM 阅读的正文摘要（截断，防止 prompt 爆掉） */
function analysisExcerpt(r, limit = 1600) {
  const body = universal.analysisTextOf(String(r.universal_segment_text || '')) || '';
  return body.length > limit ? `${body.slice(0, limit)}…（截断）` : body;
}

/**
 * 内容保全检查（写操作的安全网）—— 优化师最容易犯的错是"顺手重写"，把对白/参考标签/段落删掉。
 * 实测（drama7 ep21）：模型把 1048 字的六段文档改成 397 字的 §5 正文，14 个参考标签只剩 2 个。
 */
function checkContentPreservation(beforeText, afterText) {
  const before = String(beforeText || '');
  const after = String(afterText || '');
  const beforeSections = Object.keys(ref2va.parseRef2vaSections(before).sections || {});
  const afterSections = Object.keys(ref2va.parseRef2vaSections(after).sections || {});
  const lost = beforeSections.filter((k) => !afterSections.includes(k));
  if (lost.length) return { ok: false, error: `丢失段落：${lost.join('/')}` };

  // 对白逐字保留（<d>…</d> 内容集合必须是超集）
  const dlg = (t) => (t.match(/<d>[\s\S]*?<\/d>/g) || []).map((x) => x.replace(/\s+/g, ''));
  const beforeDlg = dlg(before);
  const afterDlg = new Set(dlg(after));
  const lostDlg = beforeDlg.filter((x) => !afterDlg.has(x));
  if (lostDlg.length) return { ok: false, error: `对白被改动/删除：${lostDlg[0].slice(0, 40)}` };

  // 参考标签不得丢失
  const labels = (t) => new Set(t.match(/<(Subject|Picture|Audio|Video) \d+>/g) || []);
  const beforeLabels = labels(before);
  const afterLabels = labels(after);
  const lostLabels = [...beforeLabels].filter((x) => !afterLabels.has(x));
  if (lostLabels.length) return { ok: false, error: `参考标签丢失：${lostLabels.slice(0, 6).join(',')}` };

  // 体量不得大幅缩水（防止"压缩式改写"）
  if (before.length >= 200 && after.length < before.length * 0.6) {
    return { ok: false, error: `正文被过度压缩：${before.length} → ${after.length} 字` };
  }
  return { ok: true, preserved_sections: afterSections.length, preserved_labels: afterLabels.size };
}

/** 把某一镜的单个段落替换掉（其余段落原样保留） */
function spliceSection(text, section, newBody) {
  const raw = String(text || '');
  const sections = ref2va.parseRef2vaSections(raw).sections || {};
  if (!Object.keys(sections).length) return { ok: false, error: '原文不是六段结构，无法按段落打补丁' };
  const out = ref2va.REF2VA_SECTIONS
    .map((k) => `${k}:\n${k === section ? String(newBody).trim() : String(sections[k] || '').trim()}`)
    .join('\n');
  return { ok: true, text: out };
}

/** 校验 + 机械修复 + 写库（所有写路径共用） */
function writeSegmentText(db, log, id, text, durationSec) {
  const rep = ref2va.repairRef2va(text, { durationSec });
  if (rep.fatal) return { ok: false, error: `格式无法修复：${rep.changes.join('; ')}` };
  const v = ref2va.validateRef2va(rep.text, { durationSec });
  if (!v.ok) return { ok: false, error: `校验未通过：${v.problems.slice(0, 3).join('; ')}` };
  db.prepare('UPDATE storyboards SET universal_segment_text = ?, updated_at = ? WHERE id = ?')
    .run(rep.text, new Date().toISOString(), id);
  return { ok: true, data: { storyboard_id: id, chars: rep.text.length, repairs: rep.changes } };
}

const TOOLS = {
  // ─────────── 只读 ───────────
  list_storyboards: {
    kind: 'read',
    desc: '列出某集全部分镜的概览（镜号/时长/运镜/对白/模式）',
    params: { episode_id: 'number' },
    run: (db, log, a) => ({ ok: true, data: loadStoryboards(db, a.episode_id).map(slimShot) }),
  },

  get_episode_script: {
    kind: 'read',
    desc: '取某集剧本原文（分镜是否遗漏剧情的判定依据）',
    params: { episode_id: 'number' },
    run: (db, log, a) => {
      const row = db.prepare('SELECT script_content, description, title FROM episodes WHERE id = ? AND deleted_at IS NULL').get(Number(a.episode_id));
      if (!row) return { ok: false, error: '剧集不存在' };
      return { ok: true, data: { title: row.title || '', script: String(row.script_content || row.description || '') } };
    },
  },

  get_storyboard_detail: {
    kind: 'read',
    desc: '取单个分镜的完整信息（含 universal_segment_text 正文）',
    params: { storyboard_id: 'number' },
    run: (db, log, a) => {
      const r = loadStoryboards(db, db.prepare('SELECT episode_id FROM storyboards WHERE id = ?').get(Number(a.storyboard_id))?.episode_id)
        .find((x) => Number(x.id) === Number(a.storyboard_id));
      if (!r) return { ok: false, error: '分镜不存在' };
      return { ok: true, data: { ...slimShot(r), universal_segment_text: String(r.universal_segment_text || ''), action: r.action || '', narration: r.narration || '' } };
    },
  },

  get_neighbors: {
    kind: 'read',
    desc: '取某镜前后各 radius 镜的概览 + 正文摘要（判断连续性用）',
    params: { storyboard_id: 'number', radius: 'number' },
    run: (db, log, a) => {
      const sb = db.prepare('SELECT episode_id, storyboard_number FROM storyboards WHERE id = ?').get(Number(a.storyboard_id));
      if (!sb) return { ok: false, error: '分镜不存在' };
      const radius = Math.min(Math.max(Number(a.radius) || 1, 1), 2);
      const rows = loadStoryboards(db, sb.episode_id).filter((r) => Math.abs(Number(r.storyboard_number) - Number(sb.storyboard_number)) <= radius);
      return {
        ok: true,
        data: rows.map((r) => ({ ...slimShot(r), is_target: Number(r.id) === Number(a.storyboard_id), analysis: analysisExcerpt(r, 700) })),
      };
    },
  },

  validate_formats: {
    kind: 'read',
    desc: '按 Ref2VA 六段规范逐镜校验，返回不合规镜号与问题',
    params: { episode_id: 'number' },
    run: (db, log, a) => {
      const rows = loadStoryboards(db, a.episode_id);
      const bad = [];
      for (const r of rows) {
        const v = ref2va.validateRef2va(String(r.universal_segment_text || ''), { durationSec: Number(r.duration) || undefined });
        if (!v.ok) bad.push({ storyboard_id: r.id, shot_number: r.storyboard_number, problems: v.problems });
      }
      return { ok: true, data: { checked: rows.length, noncompliant: bad.length, items: bad } };
    },
  },

  summarize_episode: {
    kind: 'read',
    desc: '确定性自检汇总：运镜缺失 / 长镜缺时间推进 / 时长覆盖 / 多拍 / 切点 / 打斗节奏',
    params: { episode_id: 'number' },
    run: (db, log, a) => {
      const rows = loadStoryboards(db, a.episode_id);
      const ep = db.prepare('SELECT script_content FROM episodes WHERE id = ?').get(Number(a.episode_id));
      const s = universal.summarizeUniversalSegmentFormat(rows, { scriptContent: (ep && ep.script_content) || '' });
      return { ok: true, data: s };
    },
  },

  check_dialogue_coverage: {
    kind: 'read',
    desc: '剧本台词覆盖率（哪些台词没落进任何分镜）',
    params: { episode_id: 'number' },
    run: (db, log, a) => {
      const { runStoryboardSelfChecks } = require('../episodeStoryboardService');
      return runStoryboardSelfChecks(db, log, Number(a.episode_id), { skipBeats: true })
        .then((r) => ({ ok: true, data: r.dialogueCoverage || { note: '未取到' } }));
    },
  },

  // ─────────── 写（只有 write / orchestrate 层可用；正常路径走 applySuggestions） ───────────
  update_segment_text: {
    kind: 'write',
    desc: '整篇替换某镜的 universal_segment_text（会先做格式校验 + 内容保全检查：对白/参考标签/段落不得丢失）',
    params: { storyboard_id: 'number', text: 'string' },
    run: (db, log, a) => {
      const id = Number(a.storyboard_id);
      const row = db.prepare('SELECT duration, universal_segment_text FROM storyboards WHERE id = ? AND deleted_at IS NULL').get(id);
      if (!row) return { ok: false, error: '分镜不存在' };
      const text = String(a.text || '').trim();
      if (!text) return { ok: false, error: '文本为空' };
      const guard = checkContentPreservation(String(row.universal_segment_text || ''), text);
      if (!guard.ok) return { ok: false, error: `内容保全校验未通过：${guard.error}` };
      return writeSegmentText(db, log, id, text, Number(row.duration) || undefined);
    },
  },

  update_section_text: {
    kind: 'write',
    desc: '只替换某一镜的**单个段落**（如 detailed_description），其余段落原样保留 —— 优化师默认走这条路',
    params: { storyboard_id: 'number', section: 'string', text: 'string' },
    run: (db, log, a) => {
      const id = Number(a.storyboard_id);
      const section = String(a.section || '').trim();
      if (!ref2va.REF2VA_SECTIONS.includes(section)) {
        return { ok: false, error: `段落名不合法：${section}（可用：${ref2va.REF2VA_SECTIONS.join('/')}）` };
      }
      const row = db.prepare('SELECT duration, universal_segment_text FROM storyboards WHERE id = ? AND deleted_at IS NULL').get(id);
      if (!row) return { ok: false, error: '分镜不存在' };
      const text = String(a.text || '').trim();
      if (!text) return { ok: false, error: '段落文本为空' };
      const spliced = spliceSection(String(row.universal_segment_text || ''), section, text);
      if (!spliced.ok) return { ok: false, error: spliced.error };
      const guard = checkContentPreservation(String(row.universal_segment_text || ''), spliced.text);
      if (!guard.ok) return { ok: false, error: `内容保全校验未通过：${guard.error}` };
      const written = writeSegmentText(db, log, id, spliced.text, Number(row.duration) || undefined);
      if (!written.ok) return written;
      return { ok: true, data: { ...written.data, section, preserved: guard } };
    },
  },

  update_storyboard_field: {
    kind: 'write',
    desc: '写入某镜的单个白名单字段（duration / movement / action / title）',
    params: { storyboard_id: 'number', field: 'string', value: 'string|number' },
    run: (db, log, a) => {
      const ALLOWED = ['duration', 'movement', 'action', 'title'];
      const field = String(a.field || '').trim();
      if (!ALLOWED.includes(field)) return { ok: false, error: `字段 ${field} 不在白名单内：${ALLOWED.join('/')}` };
      const id = Number(a.storyboard_id);
      const row = db.prepare('SELECT id FROM storyboards WHERE id = ? AND deleted_at IS NULL').get(id);
      if (!row) return { ok: false, error: '分镜不存在' };
      let value = a.value;
      if (field === 'duration') {
        const n = Math.round(Number(value));
        if (!Number.isFinite(n) || n < 1 || n > 15) return { ok: false, error: 'duration 必须是 1-15 的整数' };
        value = n;
      } else {
        value = String(value == null ? '' : value);
      }
      db.prepare(`UPDATE storyboards SET ${field} = ?, updated_at = ? WHERE id = ?`).run(value, new Date().toISOString(), id);
      return { ok: true, data: { storyboard_id: id, field, value } };
    },
  },

  // ─────────── 调度层专属 ───────────
  list_agents: {
    kind: 'read',
    desc: '列出可用角色（含各角色的工具白名单）',
    params: {},
    run: () => ({ ok: true, data: require('./agentRegistry').listAgents() }),
  },

  run_agent: {
    kind: 'orchestrate',
    desc: '调用另一个角色（只读角色可自由调用；写角色只会产出建议，不会落库）',
    params: { agent_id: 'string', episode_id: 'number', storyboard_ids: 'number[]', instruction: 'string' },
    run: async (db, log, a, ctx) => {
      const { runAgent } = require('./agentRunner');
      const out = await runAgent(db, log, { ...a, agentId: a.agent_id, llm: ctx && ctx.llm });
      return { ok: out.ok !== false, data: out };
    },
  },
};

/**
 * 工具执行（唯一入口，含权限强制）
 * @throws {Error} 角色不存在 / 工具不存在 / 只读角色调用写工具
 */
async function executeTool(db, log, agentId, toolName, args, ctx = {}) {
  const agent = getAgent(agentId);
  if (!agent) throw new Error(`未知角色：${agentId}`);
  const name = String(toolName || '').trim();
  const tool = TOOLS[name];
  if (!tool) throw new Error(`未知工具：${name}`);
  if (!canUseTool(agentId, name)) {
    throw new Error(`角色 ${agentId}（${agent.layer} 层）无权使用工具 ${name}`);
  }
  return tool.run(db, log, args || {}, ctx);
}

/** 某角色实际能用的工具清单（前端展示 / 调试用） */
function toolsForAgent(agentId) {
  const agent = getAgent(agentId);
  if (!agent) return [];
  return agent.toolNames
    .filter((n) => TOOLS[n])
    .map((n) => ({ name: n, kind: TOOLS[n].kind, desc: TOOLS[n].desc }));
}

module.exports = { TOOLS, executeTool, toolsForAgent, loadStoryboards, slimShot, analysisExcerpt, checkContentPreservation, spliceSection };
