/**
 * 剧本台词抽取：把剧本里**真正被说出来**的台词逐句抽出来。
 *
 * 用途只有一个 —— 生成分镜时把这份清单塞进 system prompt，要求模型逐字保留
 * （见 episodeStoryboardService 的「必须逐字保留的台词清单」）。
 *
 * 抽取规则的两处坑（都在真实剧本上踩过，见下方各函数注释）：
 *   ① 只认 `…道：“台词”` 的引号形式 → 新剧本把对白写成「角色：台词」独立成行，
 *      于是抽出空清单，必保台词清单形同不存在；
 *   ② 说话人抓成描述词、「下令：台词。旁白句」把旁白一起吞成台词
 *      → 成片里角色把旁白念了出来。
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
/**
 * 说话人短语里夹着动作/说话动词时，把动词剥掉只留名字。
 * 实测剧本：「国王立刻下令：全国收缴所有纺锤，当众焚毁。士兵们闯入每一户人家，把纺锤扔进广场火堆，火焰冲天。」
 * 旧实现把「国王立刻下令」当成说话人、把冒号后**整段**（含旁白句）当成台词，
 * 于是国王在成片里把「士兵们闯入每一户人家…火焰冲天」这段**旁白**念了出来。
 */
const SPEAKER_VERB_RE = /(立刻|随即|当即|当场|转身|忽然|突然|冷冷地|低声|高声|厉声|大声|沉声)?(下令|命令|吩咐|宣布|宣告|说道|道|说|问|答|喊|喝道|叫道|低声道|开口道|补充道|叹道|笑道|冷笑道)$/;

function stripSpeakerVerb(speaker) {
  const raw = String(speaker || '').trim();
  if (!raw) return raw;
  const m = raw.match(SPEAKER_VERB_RE);
  if (!m) return raw;
  const name = raw.slice(0, raw.length - m[0].length).replace(/[，,、\s]+$/, '');
  // 剥完还要剩 2 个字以上才认（避免「下令」被剥成空）
  return name.length >= 1 ? name : raw;
}

/**
 * 这一句是不是"旁白/动作描述"（不是角色说出口的话）。
 * 判据：第三方群体/环境主语 + 动作动词，或叙事性标志词。
 */
const NARRATION_SUBJECT_RE = /(士兵|众人|人群|大家|所有人|两个孩子|他们|她们|街上|广场上|远处|身后|台下|周围)/;
const NARRATION_VERB_RE = /(闯|扔|跑|冲|走|搬|抬|出现|离去|散去|升起|亮起|响起|燃烧|燃烧|倒下|围|挤|奔|逃|掠过|吹过|下起)/;
const NARRATION_MARK_RE = /^(随后|接着|此时|只见|镜头|画面|空气|天色|火势|烟|风)/;

function looksLikeNarration(sentence) {
  const t = String(sentence || '').trim();
  if (!t) return false;
  if (NARRATION_MARK_RE.test(t)) return true;
  return NARRATION_SUBJECT_RE.test(t) && NARRATION_VERB_RE.test(t);
}

/** 无引号台词：只取冒号后连续"像台词"的句子，遇到叙述句就停 */
function takeSpokenRun(rest) {
  const parts = String(rest || '').split(/(?<=[。！？!?])/).map((x) => x.trim()).filter(Boolean);
  if (!parts.length) return String(rest || '').trim();
  const keep = [];
  for (const p of parts) {
    if (keptIsSpeech(keep) && looksLikeNarration(p)) break;   // 已经取到台词，遇到叙述就停
    keep.push(p);
  }
  return keep.join('') || parts[0];
}
/** 至少有一句"像台词"时才允许被后续叙述句截断（避免第一句就误判成叙述而全部丢掉） */
function keptIsSpeech(keep) {
  return keep.length > 0 && !keep.every((k) => looksLikeNarration(k));
}

/**
 * 说话人净化：引号分支会连描述词一起抓到（实测「声音嘶哑」「杖轻点爱洛的额头」）。
 * 有已知角色名时，取"以角色名结尾"的最长名字作为说话人；否则退回剥掉常见描述词。
 */
const SPEAKER_DESC_RE = /(声音|声|语气|口吻|嗓子|嗓音|嘶哑|沙哑|冷冷地?|低声|大声|高声|厉声|沉声|轻声道?|缓缓|忽然|随即)+/g;
function refineSpeaker(captured, knownSpeakers) {
  const raw = String(captured || '').trim();
  if (!raw) return raw;
  if (Array.isArray(knownSpeakers) && knownSpeakers.length) {
    const hits = knownSpeakers
      .map((x) => String(x || '').trim())
      .filter((x) => x && raw.endsWith(x))
      .sort((a, b) => b.length - a.length);
    if (hits.length) return hits[0];
  }
  const cleaned = raw.replace(SPEAKER_DESC_RE, '').replace(/[的了着]+$/, '').trim();
  return cleaned || raw;
}

function extractScriptDialogue(scriptText, opts = {}) {
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
  // 引号形式：中英文引号 “” " 与角引号 「」『』 都要认 ——
  // 初版只认 “”/" ，而新剧本用的是「」，于是「必保台词」被静默抽成空数组，覆盖率自检形同虚设。
  const re = /([\u4e00-\u9fa5]{0,8})[:：]\s*[“"「『]([^”"」』]{1,200})[”"」』]/g;
  const names = (Array.isArray(opts.knownSpeakers) ? opts.knownSpeakers : [])
    .map((x) => String(x || '').trim()).filter(Boolean).sort((a, b) => b.length - a.length);
  /** 引号前 8 字窗口常常抓不到名字（「…魔杖轻点爱洛的额头：「台词」」），
   *  所以往前 60 字里找**最靠近引号**的角色名；找不到才退回窗口捕获。 */
  const nearestSpeaker = (at) => {
    if (!names.length) return null;
    const ctx = src.slice(Math.max(0, at - 120), at);   // 120 字窗口：台词前的动作句可能插在中间
    let best = null;
    for (const n of names) {
      const idx = ctx.lastIndexOf(n);
      if (idx < 0) continue;
      if (!best || idx > best.idx) best = { idx, name: n };
    }
    return best ? best.name : null;
  };
  let m;
  while ((m = re.exec(src)) !== null) {
    push(nearestSpeaker(m.index) || refineSpeaker(m[1], opts.knownSpeakers), m[2]);
  }

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
    push(stripSpeakerVerb(lm[1]), takeSpokenRun(rest));
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

module.exports = {
  extractScriptDialogue,
  normalizeForMatch,
};
