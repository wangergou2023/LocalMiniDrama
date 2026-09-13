/**
 * 剧本 → 分镜 的「台词覆盖率」自检。
 *
 * 为什么需要这个 —— 实测两次：
 *   三打白骨精   剧本 21 句台词 → 分镜只保住 13 句，丢 10 句
 *   真假美猴王   剧本 10 句台词 → 分镜保住  9 句，丢  1 句
 *
 * 而且丢失是**静默**的：丢掉的那几句既不在 storyboards.dialogue，也不在
 * universal_segment_text，也不在 video_prompt —— 整个剧情点在分镜里根本不存在。
 * 「三打白骨精」丢的正是「你连杀三人，佛门慈悲何在？」「你这泼猴，连伤两命！」
 * 这类台词，结果是「唐僧为什么最后要赶走悟空」的因果链被挖空，而全流程零告警。
 *
 * 成因是容量：实测 **分镜能承载的台词数 ≈ 1 句/镜**。镜数不足时模型会合并节拍，
 * 而合并时优先保画面动作、牺牲台词（分镜数由「总时长÷单镜秒数」推得，见前端
 * estimateVideoDurationSecFromCharLen —— 该公式原先按 10 字/秒折算，比中文口播
 * 的 4.2 字/秒快一倍多，于是镜数偏少、台词被挤掉）。
 *
 * 本模块只做**只读自检**，不改分镜、不重试、不挡出片：缺句就返回清单，由调用方告警。
 * 真正的修复是「加镜」，那需要人判断，不适合自动做。
 */

/**
 * 抽出剧本里**真正被说出来**的台词。
 *
 * 判定依据是冒号：中文剧本的对白几乎总是以 `…道：“台词”` 形式引入。只用「引号」
 * 会误抓被引号括起来的**人名**，例如
 *   「身边还有一个“唐僧”和“八戒”“沙僧”——全是假的！」
 * 这两处就没有冒号前缀，因此不会被当成台词。
 *
 * @param {string} scriptText
 * @returns {Array<{ index: number, speaker: string, line: string }>}
 */
function extractScriptDialogue(scriptText) {
  const src = String(scriptText || '');
  if (!src.trim()) return [];
  const out = [];
  const seen = new Set();
  const push = (speaker, line) => {
    const clean = String(line || '')
      .trim()
      .replace(/^[“"「『]+/, '')
      .replace(/[”"」』]+$/, '')
      .trim();
    if (!clean) return;
    const key = normalizeForMatch(clean);
    if (!key || seen.has(key)) return;
    seen.add(key);
    out.push({ index: out.length, speaker: String(speaker || '').trim(), line: clean });
  };

  // ① 引号形式：`…道：“台词”`
  const re = /([\u4e00-\u9fa5]{0,8})[:：]\s*[“"]([^”"]{1,200})[”"]/g;
  let m;
  while ((m = re.exec(src)) !== null) push(m[1], m[2]);

  // ② **无引号的独立台词行**：`说话人：台词`
  //
  // 为什么必须加这一条 —— 新剧本（1200-1600 字那版提示词之后）把对白写成
  //   唐僧：悟空，天色将晚，你去化些斋饭来。
  // 独立成行、**不带引号**。而原来只认引号形式，于是在这种剧本上
  // extractScriptDialogue 返回 []，台词覆盖自检**一声不响地失效**：
  // drama4 的 29 句台词被报成 total 0、covered 0 —— 自检通过，但实际上什么都没检查。
  // 这正是当初「21 句只保住 13 句、丢 10 句」那类静默丢台词的场景，自检必须看得见。
  //
  // 行首锚定（^）避免误抓正文里的冒号；说话人限 2-6 个汉字，且其后必须有实际内容。
  const lineRe = /^[ \t]*([\u4e00-\u9fa5]{2,6})[：:][ \t]*(\S.{1,200})$/;
  for (const rawLine of src.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith('【')) continue;
    const lm = lineRe.exec(line);
    if (!lm) continue;
    // 排除「说话人：」后面跟着的又是元信息的情况（如 `场景：荒山` 这类场记行）
    const rest = lm[2];
    if (/^[（(【\[]/.test(rest)) continue;
    // **含引号的行交给 pass ①** —— 否则一行里多段对白会被拼成一条垃圾
    // （实测抽出过「悟空！你为何无故伤人！”悟空指着白骨：“」这种拼接残句）
    if (/[“”"「」『』]/.test(rest)) continue;
    push(lm[1], rest);
  }
  return out;
}

/**
 * 归一化：只留汉字与字母数字，丢掉全部标点与空白。
 *
 * 因为分镜正文常常照抄台词但改动标点（「，」→「。」、省略号写法不一），
 * 直接字符串相等会误报。
 */
function normalizeForMatch(s) {
  return String(s || '').replace(/[^\u4e00-\u9fa5A-Za-z0-9]/g, '');
}

/**
 * 把一个分镜行的所有可见文本拼起来 —— 台词可能在 dialogue，也可能只被写进正文，
 * 两者都算「覆盖到了」。video_prompt / narration 也一并纳入，宁可漏报不可误报。
 */
function storyboardSearchText(sb) {
  if (!sb) return '';
  return [
    sb.title,
    sb.dialogue,
    sb.narration,
    sb.action,
    sb.result,
    sb.video_prompt,
    sb.universal_segment_text,
  ]
    .filter(Boolean)
    .join('\n');
}

/**
 * 检查剧本台词是否都被分镜覆盖。
 *
 * @param {string} scriptText  episodes.script_content
 * @param {Array<object>} storyboards 该集全部分镜行（含 dialogue / universal_segment_text 等）
 * @returns {{ total: number, covered: number, missing: Array<{index:number,speaker:string,line:string}>,
 *             located: Array<{line:string, storyboard_id:(number|null)}> } | null}
 *         剧本没有台词时返回 null（无从校验）
 */
function checkDialogueCoverage(scriptText, storyboards) {
  const script = extractScriptDialogue(scriptText);
  if (script.length === 0) return null;

  const rows = Array.isArray(storyboards) ? storyboards : [];
  const haystacks = rows.map((sb) => ({ id: sb && sb.id != null ? sb.id : null, text: normalizeForMatch(storyboardSearchText(sb)) }));
  const all = haystacks.map((h) => h.text).join('\n');

  const missing = [];
  const located = [];
  for (const item of script) {
    const needle = normalizeForMatch(item.line);
    if (!needle) continue;
    if (all.includes(needle)) {
      // 定位到具体是哪一镜覆盖的，便于人工核对归属是否合理
      const hit = haystacks.find((h) => h.text.includes(needle));
      located.push({ line: item.line, storyboard_id: hit ? hit.id : null });
    } else {
      missing.push(item);
    }
  }

  return {
    total: script.length,
    covered: script.length - missing.length,
    missing,
    located,
  };
}

module.exports = {
  extractScriptDialogue,
  checkDialogueCoverage,
  normalizeForMatch,
};
