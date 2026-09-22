/**
 * 分镜「全能片段正文」的英文版（H3 生视频专用）。
 *
 * 背景（实测结论，镜 3，同 seed / 同参考图 / 同参考音频，只改正文写法）：
 *
 *   中文正文 + 裸引号台词
 *     → 模型把 <d> 之后的描述也念出来（听到「话音落定，他抬手轻抚马鬃」），且角色嘴不动
 *   英文正文 + <d>[Chinese] 台词</d>
 *     → 台词正确、无多余语音、嘴部随台词开合 ✅
 *
 * 原因是官方规范的硬要求：正文英文、对白保留原语言。语言差异本身就是
 * 「描述」与「台词」的分界线；两者同为中文时边界模糊。
 *
 * 设计取舍：
 *   - **不改** storyboards.universal_segment_text（中文版保留，编辑器里可读）
 *   - 英文版单独存 universal_segment_text_en，渲染时优先用；缺失则按需翻译一次并缓存
 *   - 翻译前先做确定性的 <d>/(Sx) 标记（h3DialogueMark），让翻译只负责语言转换，
 *     不承担「判断哪句是台词」这种容易出错的活
 *   - 全程 best-effort：拿不到英文就回退中文，绝不因为翻译失败而挡住出片
 */
const aiClient = require('./aiClient');
const { markDialogue } = require('../utils/h3DialogueMark');
const { fixLegacySegmentText } = require('../utils/segmentTextNormalize');

/**
 * 把「X 的嗓音温和清朗：<台词>」这类**只有声音属性、没有说话动作**的中文写法，
 * 先改写成带动作的「X 用温和清朗的嗓音开口说话（嘴唇随台词开合、口型同步）：<台词>」。
 *
 * 为什么必须做 —— 实测对比：
 *   手写 "says in a gentle, clear voice: <d>…</d>"  → 嘴部随台词开合 ✅（00031）
 *   如实直译成 "X's voice is gentle and clear: <d>…</d>" → 只有声音描述，角色嘴不动 ❌
 * 中文原文里「的嗓音X：」是一个声音属性描述，不是动作；直接交给 LLM 翻译会忠实保留这个
 * 语义，于是丢失「在说话」这件事。所以这里用确定性改写把动作补回去，而不是指望模型自觉。
 *
 * 幂等：已经含「开口说话」的不再处理。
 */
function addSpeakingAction(zhText) {
  const src = String(zhText || '');
  if (!src || src.indexOf('开口说话') >= 0) return src;
  // 前缀只吸收「纯中文」修饰词（如「苍老嗓音…」的「苍老」），不会吃掉 @图片2 里的数字，
  // 因为数字/空格不属于 [\u4e00-\u9fa5]。
  return src.replace(
    /([\u4e00-\u9fa5]{0,4})的?嗓音([^：:，。；、\n]{0,12})?[：:](?=\s*[\u201c"])/g,
    (_m, pre, desc) => {
      // pre 可能把「的」也吃进来（的 ∈ [\u4e00-\u9fa5]），拼好后去掉开头这个孤立的「的」
      const mod = (String(pre || '').trim() + String(desc || '').trim()).trim().replace(/^的/, '');
      return (mod ? '用' + mod + '的嗓音' : '') + '开口说话（嘴唇随台词清晰开合、口型与台词同步）：';
    }
  );
}

/**
 * 把「参考标签」和「<d> 对白块」挖出来换成占位符，翻完再填回。
 *
 * 为什么不能指望译模型自觉保留：实测它时而保留 `@图片N`、时而规范成 `<Picture N>`、
 * 时而整段丢掉，于是校验对不上（labels:[0,14] / [14,0]）→ 误判失败 → 白回退中文正文，
 * 而中文正文会重新引入「描述被念出来」的老问题。
 *
 * 改成确定性做法：翻译只负责散文，标签与对白**物理上**不参与翻译。
 * 占位符用不会被翻译的短 ASCII 串（#R7# / #D0#）。
 */
// 参考标签的三种等价写法：@图片N（旧）、参考图N（MiniMax 官方 r2va 用词）、<Picture N>（Ref2VA 官方）
// 另外 <Subject N>/<Audio j>/<Video k> 也是**结构性标签**，必须原样带回（翻译改了 = 参考绑定丢失）
const MASK_REF = /(?:@图片|参考图)<\s*(\d+)>?|<(Picture|Subject|Audio|Video)\s+(\d+)>/g;
const MASK_DLG = /<d>([\s\S]*?)<\/d>/g;
/**
 * H3 镜内剪辑记号（`[Shot 1]` / `[Shot 2] At 00:03.200,`）。
 *
 * 为什么要掩码：这是**结构性记号**，H3 靠它决定在哪里切镜。翻译模型一旦「顺手」把它译成
 * 「第二个镜头，从 3.2 秒起」之类的中文散文，剪辑点就没了 —— 打斗镜会退回一条连续运镜，
 * 又变成前 8 秒定场、最后 0.8 秒交锋。所以整个记号（含时间戳）物理上不参与翻译，翻完原样填回。
 */
const MASK_CUT = /\[Shot\s+(\d+)\](?:\s*At\s+(?:\d{1,2}:)?\d{2}:\d{2}\.\d{3})?(?:\s*,?\s*(?:the camera cuts to|the camera cut to|the shot cuts to|the shot cut to|we cut to|cutting to))?/g;
/**
 * Ref2VA 官方六段结构的**结构记号**，一律掩码、翻完原样带回：
 *   段名（subject_definitions / summary / retention_analysis / detailed_description /
 *        overall_soundscape / non_diegetic_music）、retention 的固定英文标记、
 *   `<scenetrans>` / `<cutoff>`、说话人编号 (S1)。
 * 这些只要被译成中文，格式校验就会失败或参考关系丢失。
 */
const MASK_STRUCT = /(subject_definitions|summary|retention_analysis|detailed_description|overall_soundscape|non_diegetic_music)\s*[:：]|\b(fully_preserved|partially_preserved|attribute_transfer|weak_reference|fully_copy|partially_copy|reference)\b|<\/?(?:scenetrans|cutoff)>|\(S\d+\)/g;

function maskSegmentText(text) {
  const refs = [];
  const dlgs = [];
  const cuts = [];
  const structs = [];
  let out = String(text || '');
  // 先挖对白（对白里可能含标签，必须先保护）
  out = out.replace(MASK_DLG, (_m, inner) => {
    dlgs.push(inner);
    return '#D' + (dlgs.length - 1) + '#';
  });
  out = out.replace(MASK_REF, (_m, n, kind, kn) => {
    refs.push(kind ? '<' + kind + ' ' + kn + '>' : n);
    return '#R' + (refs.length - 1) + '#';
  });
  // 剪辑记号放在标签之后挖，避免与 #Rn# 冲突
  out = out.replace(MASK_CUT, (m) => {
    cuts.push(m);
    return '#C' + (cuts.length - 1) + '#';
  });
  // 结构记号（段名 / retention 标记 / scenetrans / (Sx)）最后挖
  out = out.replace(MASK_STRUCT, (m) => {
    structs.push(m);
    return '#S' + (structs.length - 1) + '#';
  });
  return { masked: out, refs, dlgs, cuts, structs };
}

/** 还原占位符；参考标签统一规范成 <Picture N>（comfyuiClient 认这个形式） */
function unmaskSegmentText(text, refs, dlgs, cuts, structs) {
  let out = String(text || '');
  out = out.replace(/#R(\d+)#/g, (_m, i) => {
    const v = refs[Number(i)];
    if (v == null) return _m;
    // 原始形态是 <Subject N>/<Audio j> 时原样带回；纯数字（旧 @图片N）规范成 <Picture N>
    return /^</.test(String(v)) ? String(v) : '<Picture ' + v + '>';
  });
  out = out.replace(/#D(\d+)#/g, (_m, i) => {
    const inner = dlgs[Number(i)];
    return inner == null ? _m : '<d>' + inner + '</d>';
  });
  out = out.replace(/#C(\d+)#/g, (_m, i) => {
    const raw = (cuts || [])[Number(i)];
    return raw == null ? _m : raw;
  });
  out = out.replace(/#S(\d+)#/g, (_m, i) => {
    const raw = (structs || [])[Number(i)];
    return raw == null ? _m : raw;
  });
  return out;
}

const SYSTEM_PROMPT = [
  'You localize Chinese film-shot descriptions into English for a text-to-video model.',
  '',
  'The text you receive contains placeholders that MUST be preserved exactly as written:',
  '  #R0#, #R1#, #R2# …   stand for reference assets (scene / character / prop images)',
  '  #D0#, #D1#, #D2# …   stand for blocks of spoken dialogue',
  '  #C0#, #C1#, #C2# …   stand for on-screen cut markers (they carry the shot number and the exact',
  '                        cut timestamp of an intra-shot edit, e.g. [Shot 2] At 00:03.200,)',
  '',
  'RULES (follow exactly):',
  '1. Translate everything else into natural, concrete English.',
  '2. Copy every placeholder character-for-character. Never translate, rename, renumber, reorder,',
  '   drop, duplicate, split, or reformat a placeholder.',
  '3. A #Dn# placeholder stands for a line of dialogue that is already finalized. Leave it standing',
  '   alone exactly as-is: do NOT wrap it in tags, brackets or quotes, and do NOT write any <d> or',
  '   </d> tag anywhere in your output. Do not repeat or paraphrase the dialogue.',
  '4. Keep speaker IDs such as (S1), (S2) attached to the same sentence they were attached to.',
  '5. Keep the opening style sentence, the shot heading (e.g. "分镜1： 9秒:" → "Shot 1, 9 seconds:"),',
  '   and any "no split screen / no grid" constraints.',
  '5b. A #Cn# placeholder marks an editorial cut INSIDE the clip. Leave it exactly where it was, do not',
  '    translate or explain it, and make the prose right after it start the next shot (e.g.',
  '    "#C1# the camera cuts to a close-up of …"). Never drop it: dropping it turns a two-shot fight',
  '    sequence back into one unbroken take.',
  '6. Whenever a #Dn# placeholder follows, keep the spoken content exactly as it is, and describe how it',
  '   is delivered according to the wording already in the text:',
  '   - If the text says the line is a voice-over / narration / off-screen line, KEEP it off-screen:',
  '     never add a speaker on screen, never add mouth movement, never add a visible person.',
  '   - Otherwise treat it as on-screen diegetic speech and describe the speaker as actively speaking',
  '     with the mouth visibly moving, e.g. "#R3# says in a gentle, clear voice: #D0#".',
  '   The spoken content itself MUST stay in its original language (Chinese stays Chinese).',
  '   Never translate, summarize or paraphrase a #Dn# block.',
  '7. Output ONLY the translated description. No explanation, no markdown fences, no commentary.',
].join('\n');

/** 判定是否需要翻译：纯英文的不必翻（避免白白花一次 LLM 调用） */
function looksChinese(s) {
  return /[\u4e00-\u9fa5]/.test(String(s || ''));
}

/**
 * 取某分镜的英文正文；缺失则翻译并缓存。
 *
 * @param {object} db
 * @param {object} log
 * @param {number} storyboardId
 * @param {string} zhText 中文正文（调用方已拿到，避免重复查库）
 * @param {{force?: boolean}} [opts]
 * @returns {Promise<string|null>} 英文正文；任何环节失败返回 null（调用方回退中文）
 */
/**
 * 把「旁白 / 解说」标成 <d> 块，并显式写成「画外音」。
 *
 * 为什么必须做：按 H3 官方规则，翻译时只译散文，**台词/旁白要保留原语言**；
 * 而 markDialogue 只处理带引号的对白（而且要先从 dialogue 字段解析出说话人），
 * 写作「解说旁白：…」的旁白既没有引号也没有说话人 → 从来没被标记过 →
 * 被当成散文整段翻成英文 → H3 拿到英文旁白，成片里就念英文（实测就是这个现象）。
 *
 * 这里补上标记：统一写成「(S1) says as an off-screen voice-over (the speaker is never shown):
 * <d>[Chinese] …</d>」——既进入屏蔽（保持中文），又明确是画外音
 * （不会像 on-screen 台词那样在画面里长出一个人）。
 */
function markNarration(text) {
  const src = String(text || '');
  if (!src) return src;
  if (/off-screen voice-over/i.test(src)) return src; // 已处理过
  const re = new RegExp(
    '(解说旁白|旁白|画外音)\\s*[：:]\\s*([\\s\\S]*?)' +
      '(?=结果|景别|镜头角度|运镜|氛围|情绪|配乐|音效|时长|风格|场景|镜头标题|动作|解说旁白|旁白|画外音|$)',
    'g'
  );
  return src.replace(re, (_m, _label, body) => {
    const spoken = String(body || '').trim().replace(/[。\s]+$/, '');
    if (!spoken) return _m;
    return `(S1) says as an off-screen voice-over (the speaker is never shown): <d>[Chinese] ${spoken}。</d>`;
  });
}

async function ensureEnglishSegmentText(db, log, storyboardId, zhText, opts = {}) {
  const text = String(zhText || '').trim();
  if (!text) return null;
  const id = Number(storyboardId);

  // 1. 命中缓存
  if (id && !opts.force) {
    try {
      const row = db.prepare('SELECT universal_segment_text_en AS en FROM storyboards WHERE id = ?').get(id);
      const cached = row && String(row.en || '').trim();
      if (cached) return cached;
    } catch (_) { /* 列不存在时退化为每次翻译 */ }
  }

  // 2. 正文本来就是英文 → 直接采用，不调 LLM
  if (!looksChinese(text)) {
    if (id) {
      try {
        db.prepare('UPDATE storyboards SET universal_segment_text_en = ?, updated_at = ? WHERE id = ?')
          .run(text, new Date().toISOString(), id);
      } catch (_) {}
    }
    return text;
  }

  // 3. 标记（幂等）+ 翻译
  let speakers = [];
  try {
    const sb = db.prepare('SELECT dialogue FROM storyboards WHERE id = ?').get(id);
    const { parseDialogueSpeakers } = require('../utils/h3DialogueMark');
    speakers = parseDialogueSpeakers(sb && sb.dialogue);
  } catch (_) {}
  // 先修历史措辞再翻译：否则「室内」会被如实翻成 interior space，
  // 而渲染阶段的修正只匹配中文，就再也修不到了。
  const marked = markNarration(markDialogue(addSpeakingAction(fixLegacySegmentText(text)), speakers));

  // 标签与对白先挖成占位符，翻译只处理散文 → 翻完再填回，保证它们逐字不变。
  // 不能指望译模型自觉保留：实测它会时而保留 @图片N、时而规范成 <Picture N>、时而整段丢掉，
  // 导致校验对不上（labels:[0,14] / [14,0]）→ 误判失败 → 白回退中文正文。
  const { masked, refs, dlgs, cuts, structs } = maskSegmentText(marked);

  let en = null;
  try {
    en = await aiClient.generateText(db, log, 'text', masked, SYSTEM_PROMPT, {
      temperature: 0.2,
      min_max_tokens: 4096,
    });
  } catch (e) {
    log.warn('[分镜英译] 调用文本模型失败，本次回退中文正文', { storyboard_id: id, error: e.message });
    return null;
  }
  en = String(en || '').trim();
  if (!en) {
    log.warn('[分镜英译] 模型返回空，本次回退中文正文', { storyboard_id: id });
    return null;
  }
  en = en.replace(/^```[a-zA-Z]*\s*/, '').replace(/```\s*$/, '').trim();

  // 还原前先确认译模型没弄坏占位符（丢了任何一个就说明翻译不可信）
  const gotRef = (en.match(/#R\d+#/g) || []).length;
  const gotDlg = (en.match(/#D\d+#/g) || []).length;
  const gotCut = (en.match(/#C\d+#/g) || []).length;
  const gotStruct = (en.match(/#S\d+#/g) || []).length;
  if (gotRef !== refs.length || gotDlg !== dlgs.length || gotCut !== cuts.length || gotStruct !== structs.length) {
    log.warn('[分镜英译] 占位符数量不符，回退中文正文', {
      storyboard_id: id, ref_expect: refs.length, ref_got: gotRef,
      dlg_expect: dlgs.length, dlg_got: gotDlg,
      cut_expect: cuts.length, cut_got: gotCut,
      struct_expect: structs.length, struct_got: gotStruct,
    });
    return null;
  }
  // 译模型有时会照着自己的理解补一对 <d> 标签（掩码后它看不到真标签，只能靠猜）。
  // 真对白已被掩码，所以此时出现的任何 <d>/</d> 都是多余的；先剥掉，避免还原后嵌套成
  // <d>[Chinese] <d>[Chinese] 台词</d></d>。
  const strayD = (en.match(/<\/?d>/g) || []).length;
  if (strayD) {
    log.warn('[分镜英译] 译模型擅自添加了 <d> 标签，已剥除', { storyboard_id: id, stray: strayD });
    en = en.replace(/<\/?d>/g, '');
  }
  en = unmaskSegmentText(en, refs, dlgs, cuts, structs);

  // 4. 校验：参考标签与台词块必须原样保留，否则不采用（宁可回退中文也不要用坏的 prompt）
  //
  // 注意：库里存的中文正文用的是「@图片N」，而 <Picture N> 的转换是后面 comfyuiClient
  // 里由 toPictureTags 做的。所以**必须先归一化再比**，否则中文侧永远是 0 个标签、
  // 英译侧是 N 个（译模型按指令把它们规范成了 <Picture N>），校验必然误判失败 →
  // 白白回退中文正文（这正是 镜4/镜5/镜7 一度用中文正文出片的原因）。
  const normLabels = (x) => String(x || '')
    .replace(/@图片\s*(\d+)/g, '<Picture $1>')
    .replace(/参考图\s*(\d+)/g, '<Picture $1>');
  const count = (s, re) => (String(s).match(re) || []).length;
  const labelsZh = count(normLabels(marked), /<(?:Picture|Audio|Video)\s*\d+>/g);
  const labelsEn = count(normLabels(en), /<(?:Picture|Audio|Video)\s*\d+>/g);
  // 用闭合标签计数：开标签 <d> 可能出现在正文的说明性文字里，闭合标签只会属于真正的台词块
  const dZh = count(marked, /<\/d>/g);
  const dEn = count(en, /<\/d>/g);
  if (labelsZh !== labelsEn || dZh !== dEn) {
    log.warn('[分镜英译] 校验不通过（参考标签或 <d> 数量不一致），回退中文正文', {
      storyboard_id: id, labels: [labelsZh, labelsEn], d_tags: [dZh, dEn],
    });
    return null;
  }

  if (id) {
    try {
      db.prepare('UPDATE storyboards SET universal_segment_text_en = ?, updated_at = ? WHERE id = ?')
        .run(en, new Date().toISOString(), id);
    } catch (e) {
      log.warn('[分镜英译] 写入缓存失败（不影响本次生成）', { storyboard_id: id, error: e.message });
    }
  }
  log.info('[分镜英译] 已生成英文正文', {
    storyboard_id: id, zh_chars: marked.length, en_chars: en.length, speakers,
  });
  return en;
}

module.exports = { ensureEnglishSegmentText, addSpeakingAction, maskSegmentText, unmaskSegmentText, SYSTEM_PROMPT };
