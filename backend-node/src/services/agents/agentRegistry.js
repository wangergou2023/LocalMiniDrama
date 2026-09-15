'use strict';
/**
 * Agent 三层架构 —— 角色注册表。
 *
 * 设计来源：字字动画（TypeTale）的 agent skills。它让 Agent"变聪明"的其实不是人设，
 * 而是角色附带的三样东西，这里逐条落地：
 *
 *   1. 工具白名单 = 权限边界 —— 只读角色的 toolNames 里**根本不存在**写工具，
 *      "只读"不是靠模型自觉（见 agentTools.executeTool 的强制校验）。
 *   2. 知识注入收敛 —— 每个角色只挂自己那份知识片段（knowledge 字段），
 *      而不是把所有规范塞进同一个巨型 prompt（我们的 ust 规范已经 4800 字，再加就会互相稀释）。
 *   3. 专用输出契约 —— outputContract 固定结构，下游可直接消费（低分镜清单 → 交给优化师）。
 *
 * 另外两条工程约束：
 *   - requiresConfirm：写操作分两段（先出建议 → 用户确认 → 再写回），
 *     applySuggestions 阶段**不再调用 LLM**，保证"预览 = 结果"。
 *   - layer：read（只读审查）/ write（可写优化）/ orchestrate（调度）。
 */

/** 三层定义 */
const LAYERS = {
  read: { id: 'read', name: '只读审查层', desc: '只打分、只列问题，物理上改不了数据' },
  write: { id: 'write', name: '可写优化层', desc: '能改分镜文本，但必须先出建议、经确认才写回' },
  orchestrate: { id: 'orchestrate', name: '调度层', desc: '自然语言指挥，可调用其它角色与既有工具' },
};

/**
 * 只读工具（任何角色都能用；写工具只给 write / orchestrate 层）
 * 名字与 agentTools.TOOLS 的 key 一一对应。
 */
const READ_TOOLS = [
  'list_storyboards',
  'get_episode_script',
  'get_storyboard_detail',
  'get_neighbors',
  'validate_formats',
  'summarize_episode',
  'check_dialogue_coverage',
];

/** 写工具（只有 write / orchestrate 层能用，且必须走确认流程） */
const WRITE_TOOLS = ['update_segment_text', 'update_storyboard_field'];

/** 调度层专属：调用另一个角色 */
const ORCHESTRATE_TOOLS = ['run_agent', 'list_agents'];

const AGENTS = [
  {
    id: 'auditor',
    name: '分镜审计员',
    icon: '🔍',
    layer: 'read',
    summary: '对整集分镜做四维打分，找出低分镜与问题清单（只读）',
    /** 只读工具 —— 没有任何写工具 */
    toolNames: [...READ_TOOLS],
    /** 只注入审计知识 */
    knowledge: [
      '四维评分：画面具体性 / 镜头语言 / 故事连贯性 / 提示词完整性。',
      '画面具体性：主体、环境、光线、构图是否具体到可生成；空泛形容词（史诗感、高级质感）扣分。',
      '镜头语言：景别与机位是否明确；运镜是否有动机（说不出动机就用固定机位，硬加环绕/推拉扣分）；长镜是否写了"第几秒→第几秒"的时间推进。',
      '故事连贯性：与前后镜的场景（时间/地点/光线）、角色、动作是否承接；关键道具是否延续。',
      '提示词完整性：六段结构是否齐全、retention 标记是否合规、台词是否逐字保留（<d>…</d>）、<Picture N>/<Subject N> 引用是否正确。',
      '评分要有依据：必须引用镜内原文片段说明问题，不许凭空扣分。',
    ],
    outputContract: {
      type: 'json',
      shape: {
        scores: [{ storyboard_id: 'number', shot_number: 'number', dims: { specificity: '0-1', camera: '0-1', continuity: '0-1', completeness: '0-1' }, total: '0-1', issues: ['string'], fix_hint: 'string' }],
        summary: { shots: 'number', average: '0-1', grade: 'A/B/C/D', worst: ['storyboard_id'] },
        low_score_ids: ['number'],
        global_issues: ['string'],
      },
      threshold: 0.65,
    },
  },
  {
    id: 'video_prompt_auditor',
    name: '视频提示词审查员',
    icon: '🎬',
    layer: 'read',
    summary: '专查视频提示词规则：运镜动机、台词锁机位、时间推进、[Shot 1] 编号、时长与台词匹配（只读）',
    toolNames: [...READ_TOOLS],
    knowledge: [
      '规则1 运镜必须带动机：写清方向+速度+跟随对象+叙事目的；说不出动机就用固定机位；严禁为了"有运镜"硬加环绕/推拉/甩镜。',
      '规则2 台词期间镜头固定：说话人开口期间不切镜、不推拉、不环绕、不升降；运镜必须压在该台词开始时间点之前；只有当前说话人有口型。',
      '规则3 镜内时间推进：单镜也要写起幅→过程→落幅（第几秒开始变化、变的是什么）；变化主体可以是画面内容而非镜头，固定机位同样合格。',
      '规则4 [Shot N] 编号：每条 universal_segment_text 是独立一次生成，第一拍永远是 [Shot 1]；后续拍必须带 At MM:SS.mmm 且时间严格递增、小于本镜时长；最多 4 拍。',
      '规则5 时长与台词：含对白镜头 duration ≥ 台词字数 ÷ 4.2 + 1 秒。',
      '规则6 剧情完整性：不得压缩/省略原文动作、因果、情绪转折与任何一句对白。',
    ],
    outputContract: {
      type: 'json',
      shape: {
        violations: [{ storyboard_id: 'number', shot_number: 'number', rule: 'string', evidence: 'string', severity: 'high/medium/low', suggestion: 'string' }],
        summary: { checked: 'number', clean: 'number', violated: 'number' },
        clean_ids: ['number'],
      },
    },
  },
  {
    id: 'continuity_auditor',
    name: '连续性审查员',
    icon: '🔗',
    layer: 'read',
    summary: '找相邻镜之间的断裂点：动作不接、道具消失、光线跳变、空间方向矛盾（只读）',
    toolNames: [...READ_TOOLS],
    knowledge: [
      '看相邻镜的衔接：上一镜结束状态 → 下一镜起始状态，动作/位置/视线必须接得上。',
      '时空一致：时间（晨/午/夜）、地点、光线不得无故跳变（除非剧本明确切换场景）。',
      '道具与角色状态连续：关键道具位置、伤势、服装破损、血迹等要延续。',
      '空间方向：轴线两侧不能乱跳（正反打要方向一致），人物站位不要无故互换。',
      '只报真断裂：情绪起伏、景别变化、剪辑点都是正常叙事手段，不算断裂。',
    ],
    outputContract: {
      type: 'json',
      shape: {
        breaks: [{ from_storyboard_id: 'number', to_storyboard_id: 'number', kind: 'action/prop/lighting/axis/time', evidence: 'string', severity: 'high/medium/low', suggestion: 'string' }],
        summary: { pairs_checked: 'number', clean_pairs: 'number', broken_pairs: 'number' },
      },
    },
  },
  {
    id: 'optimizer',
    name: '分镜优化师',
    icon: '✍️',
    layer: 'write',
    summary: '只修低分镜的文本（默认只改 universal_segment_text），先出建议 + diff，确认后才写回',
    toolNames: [...READ_TOOLS, ...WRITE_TOOLS],
    requiresConfirm: true,
    /** 默认只允许改这些字段 */
    defaultFields: ['universal_segment_text'],
    allowedFields: ['universal_segment_text', 'duration', 'movement', 'action', 'title'],
    knowledge: [
      '只改被指定的镜，未指定的不动；只改 allowFields 里的字段。',
      '保持六段结构完整：subject_definitions / summary / retention_analysis / detailed_description / overall_soundscape / non_diegetic_music 一个都不能少。',
      '保持所有结构记号原样：<Subject N>/<Picture N>/<Audio j>、retention 固定标记、[Shot N] At MM:SS.mmm、<d>…</d>、<scenetrans>/<cutoff>。',
      '补内容而不是重写剧情：台词逐字保留，不得删减动作/因果/情绪转折。',
      '每条建议必须给 reason（为什么这么改），并给出改动范围（改了哪段）。',
    ],
    outputContract: {
      type: 'json',
      shape: {
        suggestions: [{ storyboard_id: 'number', shot_number: 'number', field: 'string', before_chars: 'number', after: 'string', reason: 'string', fixes: ['string'] }],
        skipped: [{ storyboard_id: 'number', reason: 'string' }],
      },
    },
  },
  {
    id: 'director',
    name: '总导演',
    icon: '🎭',
    layer: 'orchestrate',
    summary: '用自然语言指挥：跑审查、修低分镜、批量生成；可调用其它角色',
    toolNames: [...READ_TOOLS, ...WRITE_TOOLS, ...ORCHESTRATE_TOOLS],
    knowledge: [
      '先查状态再动手：不确定镜号就先 list_storyboards / summarize_episode。',
      '写操作一律走"建议 → 用户确认"两段式，不允许直接落库。',
      '如实播报：调用失败或没有产出要直说，不要编造结果。',
      '成本意识：整集审查按批处理，避免逐镜单独调用。',
    ],
    outputContract: { type: 'text' },
  },
];

const byId = new Map(AGENTS.map((a) => [a.id, a]));

function getAgent(agentId) {
  return byId.get(String(agentId || '').trim()) || null;
}

function listAgents() {
  return AGENTS.map((a) => ({
    id: a.id, name: a.name, icon: a.icon, layer: a.layer, summary: a.summary,
    toolNames: a.toolNames, requiresConfirm: !!a.requiresConfirm,
  }));
}

/** 某角色是否允许用某工具（权限判定的唯一入口） */
function canUseTool(agentId, toolName) {
  const agent = getAgent(agentId);
  if (!agent) return false;
  return agent.toolNames.includes(String(toolName || '').trim());
}

module.exports = { LAYERS, READ_TOOLS, WRITE_TOOLS, ORCHESTRATE_TOOLS, AGENTS, getAgent, listAgents, canUseTool };
