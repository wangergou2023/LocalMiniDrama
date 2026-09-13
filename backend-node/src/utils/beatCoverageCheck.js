/**
 * 剧情点（叙事节拍）覆盖检查 —— 用一次 LLM 调用做「剧本节拍 → 分镜」的忠实度对照。
 *
 * 为什么不用关键词/规则：剧本的叙述部分没有确定性边界。实测用关键词自动判定会把
 *   「一棒挟风雷之势砸落钵上…钵内 @图片3 发出一声闷嘶，身形溃散，化作一道黑烟…
 *     在佛光中消融殆尽」  误判成「没打死六耳猕猴」
 *   「@图片4 八戒与 @图片5 沙僧一左一右俯身低语，把前事细细叙来」 误判成「没交代前事」
 * 两次都是**误报**（内容其实都在，只是措辞不同），误报比不报更糟，所以这类判定只能靠
 * 语义理解 —— 即 LLM。LLM 消耗很低，不必为省一次调用而放弃这道检查。
 *
 * 与台词覆盖率检查的分工：
 *   · 台词（utils/dialogueCoverage）：确定性字符串比对，可判「有没有」
 *   · 剧情点（本模块）：语义判定，判「叙述里的画面/动作/转折有没有落到某一镜」
 *
 * 注意本模块只做**检查**，不改分镜、不自动重跑：补镜会改变整集分镜、作废已渲染片段，
 * 那是有代价的决定，留给用户。
 */
const aiClient = require('../services/aiClient');
const { safeParseAIJSON, extractJsonCandidate } = require('./safeJson');

/** 每镜塞进提示词的正文上限（避免长剧本/多镜时爆 token；判定覆盖不需要全文） */
const UST_EXCERPT_CHARS = 320;
const MAX_SHOTS_IN_PROMPT = 120;

const SYSTEM_PROMPT = [
  'You are a strict script supervisor for a short-drama production.',
  '',
  'You will receive a SCRIPT and the SHOT LIST that was broken down from it.',
  'Your job: extract every narrative beat of the SCRIPT, then decide whether each beat is',
  'actually present in the SHOT LIST.',
  '',
  'A beat counts as COVERED only if the shot list shows it — in a shot title, action, result,',
  'dialogue, or the shot description. Wording does NOT need to match: paraphrase, different',
  'camera description, or a different synonym all count as covered.',
  'A beat counts as MISSING if nothing in the shot list depicts or states it.',
  '',
  'Rules:',
  '1. Be precise about what counts as a beat. Split the script into story beats a viewer would',
  '   notice: an action, a reaction, a reveal, a line of dialogue, a location change, a turn.',
  '2. Do NOT invent beats that are not in the script.',
  '3. Do NOT mark something missing just because the wording differs — read for meaning.',
  '4. Ignore pure style/pacing remarks that no shot could depict.',
  '5. For each beat give: the beat in Chinese (short), covered true/false, the shot number that',
  '   covers it (or null), and a one-line reason.',
  '6. Output ONLY valid JSON, no markdown fences, no commentary.',
  '',
  'Output schema:',
  '{"beats":[{"beat":"...","covered":true,"shot":3,"reason":"..."}, ...]}',
].join('\n');

/** 把分镜列表压成提示词里的紧凑清单 */
function formatShotsForPrompt(storyboards) {
  return storyboards
    .slice(0, MAX_SHOTS_IN_PROMPT)
    .map((s, i) => {
      const n = i + 1;
      const parts = [`[镜${n}] 标题：${(s.title || '').trim() || '（无）'}`];
      if (s.duration) parts.push(`时长：${s.duration}s`);
      if (s.dialogue && String(s.dialogue).trim()) parts.push(`对白：${String(s.dialogue).trim().replace(/\n/g, ' / ')}`);
      if (s.action && String(s.action).trim()) parts.push(`动作：${String(s.action).trim().slice(0, 160)}`);
      if (s.result && String(s.result).trim()) parts.push(`结果：${String(s.result).trim().slice(0, 160)}`);
      const ust = String(s.universal_segment_text || s.video_prompt || '').trim();
      if (ust) parts.push(`画面：${ust.replace(/\n/g, ' ').slice(0, UST_EXCERPT_CHARS)}`);
      return parts.join('\n    ');
    })
    .join('\n');
}

/**
 * @param {object} db
 * @param {object} log
 * @param {string} scriptText episodes.script_content
 * @param {Array<object>} storyboards 该集全部分镜行
 * @returns {Promise<{total:number, covered:number, missing:Array<{beat:string,reason:string}>,
 *                    annotated:Array<{beat:string,covered:boolean,shot:(number|null),reason:string}>} | null>}
 *          失败返回 null（绝不因为自检失败挡住出片）
 */
async function checkBeatCoverage(db, log, scriptText, storyboards) {
  const script = String(scriptText || '').trim();
  const rows = Array.isArray(storyboards) ? storyboards : [];
  if (!script || rows.length === 0) return null;

  const userPrompt = [
    '=== SCRIPT ===',
    script,
    '',
    '=== SHOT LIST ===',
    formatShotsForPrompt(rows),
    '',
    '=== TASK ===',
    'Extract every narrative beat of the SCRIPT and judge whether the SHOT LIST covers it.',
    'Output ONLY the JSON object described in the system prompt.',
  ].join('\n');

  let raw = null;
  try {
    raw = await aiClient.generateText(db, log, 'text', userPrompt, SYSTEM_PROMPT, {
      temperature: 0.1,
      min_max_tokens: 4096,
    });
  } catch (e) {
    log.warn('[分镜] 剧情点覆盖检查调用失败（不影响出片）', { error: e.message });
    return null;
  }
  const text = String(raw || '').trim();
  if (!text) {
    log.warn('[分镜] 剧情点覆盖检查返回空（不影响出片）');
    return null;
  }

  let parsed = null;
  try {
    parsed = safeParseAIJSON(text, null, log);
  } catch (_) {
    parsed = null;
  }
  if (!parsed) {
    try {
      const cand = extractJsonCandidate(text);
      parsed = cand ? JSON.parse(cand) : null;
    } catch (_) {
      parsed = null;
    }
  }
  const beats = parsed && Array.isArray(parsed.beats) ? parsed.beats : null;
  if (!beats) {
    log.warn('[分镜] 剧情点覆盖检查结果无法解析（不影响出片）', { preview: text.slice(0, 160) });
    return null;
  }

  const annotated = beats
    .filter((b) => b && (b.beat || b.剧情点))
    .map((b) => ({
      beat: String(b.beat || b.剧情点).trim(),
      covered: b.covered === true,
      shot: Number.isFinite(Number(b.shot)) ? Number(b.shot) : null,
      reason: String(b.reason || b.理由 || '').trim(),
    }));
  const missingList = annotated.filter((b) => !b.covered);

  return {
    total: annotated.length,
    covered: annotated.length - missingList.length,
    missing: missingList.map((b) => ({ beat: b.beat, reason: b.reason })),
    annotated,
  };
}

module.exports = { checkBeatCoverage, formatShotsForPrompt, SYSTEM_PROMPT };
