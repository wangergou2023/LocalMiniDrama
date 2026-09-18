/**
 * MiniMax H3 **Ref2VA（全参考）官方重写格式**：六段结构。
 *
 * 依据 h3-prompt-writing skill 的 references/ref-en.txt（§1-§6）：
 *
 *   subject_definitions → summary → retention_analysis → detailed_description
 *                       → overall_soundscape → non_diegetic_music
 *
 * 关键规则（此前我们用的是自造的四行块格式，与官方要求有四处不符）：
 *
 *  · **§2.1/§2.2 标签分层**：`<Subject N>` = 从参考素材抽象出来的**可复用可见内容**
 *    （人/动物/物体/场景/服装/道具/风格动作）；`<Picture N>` **只**用于「该图本身充当某个镜头的
 *    首帧/关键帧/尾帧/构图锚」。**只用来定义角色/场景/服装/风格的图，不应该单独列 <Picture N> 条目，
 *    而应作为来源写进对应的 <Subject N> 定义里**。
 *    我们此前给每张参考图都编一个 `<Picture N>` 并在正文里满篇引用 —— 这正是
 *    「镜1 只 @ 了唐僧」「镜3 把八戒绑到金箍棒槽」的根因（模型没有「角色」这个抽象层可用）。
 *  · **§2.4 音频**：`<Audio 1> is the voice-timbre reference for <Subject 1> (S1).`
 *  · **§4 retention_analysis**：逐条列标签 + **固定英文标记**
 *    可见内容：fully_preserved / partially_preserved / attribute_transfer / weak_reference
 *    音频：fully_copy / partially_copy / reference / weak_reference
 *    且**不写 (Sx)**。
 *  · **§5 detailed_description**：风格用 1-2 句英文写在 `[Shot 1]` **之前**；
 *    `[Shot 1]` 不带时间戳，后续 `[Shot N] At MM:SS.mmm, …`；说话人写 `<Subject N> (S1) says, <d>[Chinese] …</d>`；
 *    跨切镜台词用 `<scenetrans>`、被片尾截断用 `<cutoff>`。
 *
 * 语言：skill 要求**重写各段用英文**、台词保留原语言。我们的库内 ust 保持中文（界面可读），
 * 交给本地 H3 的英文版由 segmentTextI18nService 生成 —— 结构记号（段名/label/retention 标记/
 * [Shot N] 时间戳）在翻译时被掩码原样带回，见该文件的 MASK_* 定义。
 */

/** 六段顺序（必须固定，官方要求「section order」一致） */
const REF2VA_SECTIONS = [
  'subject_definitions',
  'summary',
  'retention_analysis',
  'detailed_description',
  'overall_soundscape',
  'non_diegetic_music',
];

/** 精简格式（本机折中版）段列表：不要 subject_definitions / summary / retention_analysis 三段元数据，
 *  也不再用 <Subject N> —— 参考图直接用 <Picture N> 指，编号 = 提交顺序。 */
const LEAN_SECTIONS = ['detailed_description', 'overall_soundscape', 'non_diegetic_music'];

/** 可见内容的保留关系标记（固定英文值） */
const VISIBLE_MARKERS = ['fully_preserved', 'partially_preserved', 'attribute_transfer', 'weak_reference'];
/** 音频的保留关系标记（固定英文值） */
const AUDIO_MARKERS = ['fully_copy', 'partially_copy', 'reference', 'weak_reference'];

const SECTION_HEADER_RE = new RegExp('^\\s*(' + REF2VA_SECTIONS.join('|') + ')\\s*[:：]\\s*', 'i');
const LABEL_RE = /<(Subject|Picture|Video|Audio)\s+(\d+)>/g;
/** `[Shot 1]` / `[Shot 3] At 00:03.200,` */
const SHOT_RE = /\[Shot\s+(\d+)\]\s*(?:At\s+((?:\d{1,2}:)?\d{2}:\d{2}\.\d{3})\s*,?)?/g;
/** retention_analysis 行：`<Subject 1> (appears in [Shot 1], [Shot 3]): fully_preserved - …` */
const RETENTION_LINE_RE = new RegExp(
  '^\\s*<(Subject|Picture|Video|Audio)\\s+(\\d+)>[^:：]*[:：]\\s*(' +
    VISIBLE_MARKERS.concat(AUDIO_MARKERS).join('|') + ')\\b',
  'i'
);

/**
 * 把 ust 拆成六段。
 * @returns {{ok:boolean, sections:Object<string,string>, order:string[], missing:string[], extraHead:string[]}}
 */
function parseRef2vaSections(text, expectedSections = REF2VA_SECTIONS) {
  const src = String(text || '').replace(/\r\n?/g, '\n');
  const lines = src.split('\n');
  const sections = {};
  const order = [];
  const extraHead = [];
  let current = null;
  for (const line of lines) {
    const m = line.match(SECTION_HEADER_RE);
    if (m) {
      current = m[1].toLowerCase();
      if (!sections[current]) {
        sections[current] = '';
        order.push(current);
      }
      const inline = line.replace(SECTION_HEADER_RE, '').trim();
      if (inline) sections[current] += (sections[current] ? '\n' : '') + inline;
      continue;
    }
    if (current) {
      sections[current] += (sections[current] ? '\n' : '') + line;
    } else if (line.trim()) {
      extraHead.push(line.trim());
    }
  }
  for (const k of Object.keys(sections)) sections[k] = sections[k].trim();
  const missing = expectedSections.filter((s) => !(s in sections));
  // 顺序必须是官方顺序的子序列（允许省略，但出现了的必须按序）
  const expected = expectedSections.filter((s) => order.includes(s));
  const orderOk = expected.join('|') === order.join('|');
  return { ok: missing.length === 0 && orderOk && extraHead.length === 0, sections, order, missing, extraHead, orderOk };
}

/** 收集文本里用到的所有标签 */
function collectLabels(text) {
  const out = [];
  LABEL_RE.lastIndex = 0;
  let m;
  while ((m = LABEL_RE.exec(String(text || '')))) out.push({ kind: m[1], n: Number(m[2]), raw: m[0] });
  return out;
}

/**
 * 校验六段格式。
 *
 * @param {string} text
 * @param {{availablePictures?:number, availableAudios?:number, durationSec?:number, maxShots?:number,
 *          minWords?:number, maxWords?:number}} [opts]
 * @returns {{ok:boolean, problems:string[], sections:Object, shots:Array}}
 */
/**
 * 是否是精简格式（本机折中版）：没有 subject_definitions，只有 detailed_description + 声音两段。
 * 校验与修复必须用同一套判据 —— 之前 repairRef2va 没有这个分流，
 * 于是**规范要求的精简格式反而一律被判 fatal**（缺 subject_definitions），
 * 模型写的正文连同 <Picture N> 参考图映射行全被丢掉、换成零槽位兜底模板：
 * 表现就是「重新生成分镜后片段描述里没有角色」。
 */
function isLeanRef2va(text) {
  const src = String(text || '');
  return !/subject_definitions\s*[:：]/i.test(src) && /detailed_description\s*[:：]/i.test(src);
}

function validateRef2va(text, opts = {}) {
  const src = String(text || '');
  const problems = [];

  // 精简格式（本机折中版）：没有 subject_definitions，只有 detailed_description + 声音两段。
  // 走独立校验，不再要求 <Subject N> / retention_analysis。
  if (isLeanRef2va(src)) return validateLeanRef2va(src, opts, problems);

  const parsed = parseRef2vaSections(src);
  if (parsed.extraHead.length) problems.push(`段名之前有多余内容：${parsed.extraHead[0].slice(0, 40)}`);
  if (parsed.missing.length) problems.push(`缺少段：${parsed.missing.join(', ')}`);
  if (!parsed.orderOk) problems.push(`段顺序不符（应为 ${REF2VA_SECTIONS.join(' → ')}）`);

  const s = parsed.sections;
  const defined = collectLabels(s.subject_definitions || '');
  const subjectDefs = defined.filter((l) => l.kind === 'Subject');
  if (!subjectDefs.length) problems.push('subject_definitions 里没有任何 <Subject N> 定义');

  // summary 不得引入新标签（§3）
  const summaryLabels = collectLabels(s.summary || '');
  const defKeys = new Set(defined.map((l) => l.raw));
  for (const l of summaryLabels) if (!defKeys.has(l.raw)) problems.push(`summary 引入了未定义的标签 ${l.raw}`);

  // <Audio j> 必须绑到主体或明确的说话人（§2.4）
  // 例外：画外解说 / 旁白在画面里**没有对应主体**，只能绑说话人标签 ——
  // 实测宣传片项目（ep23）10/10 镜都写成「<Audio 1> 是画外解说的人声音色参考，对应说话人 (S1)」，
  // 旧校验一律判不合规，属于规范缺口而非产出问题。
  const audioDefs = (s.subject_definitions || '').split('\n').filter((l) => /<Audio\s+\d+>/i.test(l));
  for (const line of audioDefs) {
    const boundToSubject = /<Subject\s+\d+>/i.test(line);
    const boundToSpeaker = /\(S\d+\)/.test(line) || /(off-screen|narrator|voice-over|画外|旁白|解说)/i.test(line);
    if (!boundToSubject && !boundToSpeaker) {
      problems.push(`<Audio j> 定义未绑定 <Subject N> 或说话人：${line.slice(0, 50)}`);
    }
  }

  // retention_analysis：每条固定标记，且不写 (Sx)（§4）
  const raLines = (s.retention_analysis || '').split('\n').map((l) => l.trim()).filter(Boolean);
  if (!raLines.length) problems.push('retention_analysis 为空');
  const raLabels = new Set();
  for (const line of raLines) {
    const m = line.match(RETENTION_LINE_RE);
    if (!m) { problems.push(`retention_analysis 行缺少 <标签>: 固定标记 —— ${line.slice(0, 50)}`); continue; }
    raLabels.add(`<${m[1]} ${m[2]}>`);
    const marker = m[3].toLowerCase();
    const isAudio = m[1].toLowerCase() === 'audio';
    if (isAudio && !AUDIO_MARKERS.includes(marker)) problems.push(`音频标记非法：${marker}`);
    if (!isAudio && !VISIBLE_MARKERS.includes(marker)) problems.push(`可见内容标记非法：${marker}`);
    if (/\(S\d+\)/.test(line)) problems.push('retention_analysis 里不应出现 (Sx)');
  }
  for (const l of subjectDefs) {
    if (!raLabels.has(l.raw)) problems.push(`<Subject ${l.n}> 缺少 retention_analysis 行`);
  }

  const { shots, words } = checkShotsAndTimeline(s.detailed_description || '', opts, problems);
  checkCommonSyntax(src, opts, problems);

  return { ok: problems.length === 0, problems, sections: s, shots, words, format: 'six_section' };
}

/**
 * 镜头与时间戳检查（两种格式共用）。
 * @returns {{shots:Array, words:number}}
 */
function checkShotsAndTimeline(ddRaw, opts, problems) {
  const dd = String(ddRaw || '');
  if (!dd.trim()) problems.push('detailed_description 为空');
  const shots = [];
  SHOT_RE.lastIndex = 0;
  let sm;
  while ((sm = SHOT_RE.exec(dd))) shots.push({ n: Number(sm[1]), at: sm[2] || null, index: sm.index });
  if (!shots.length) problems.push('detailed_description 里没有 [Shot N]');
  else {
    if (shots[0].n !== 1) problems.push('第一个镜头必须是 [Shot 1]');
    if (shots[0].at) problems.push('[Shot 1] 不应带时间戳');
    for (let i = 1; i < shots.length; i++) {
      if (shots[i].n !== shots[i - 1].n + 1) problems.push(`镜头编号不连续：[Shot ${shots[i - 1].n}] → [Shot ${shots[i].n}]`);
      if (!shots[i].at) problems.push(`[Shot ${shots[i].n}] 缺少 At MM:SS.mmm, 时间戳`);
    }
    const dur = Number(opts.durationSec);
    if (Number.isFinite(dur) && dur > 0) {
      for (const sh of shots.slice(1)) {
        if (!sh.at) continue;
        const sec = sh.at.split(':').map(Number);
        const total = sec.length === 3 ? sec[0] * 3600 + sec[1] * 60 + sec[2] : sec[0] * 60 + sec[1];
        if (total >= dur) problems.push(`[Shot ${sh.n}] 时间戳 ${sh.at} 超出本镜时长 ${dur}s`);
      }
    }
  }
  if (opts.maxShots && shots.length > opts.maxShots) problems.push(`镜头数 ${shots.length} > 上限 ${opts.maxShots}`);
  const words = dd.split(/[\s,.;:!?，。；：！？、]+/).filter((w) => w.length > 1).length;
  if (opts.minWords && words < opts.minWords) problems.push(`detailed_description 偏短（${words} < ${opts.minWords}）`);
  if (opts.maxWords && words > opts.maxWords) problems.push(`detailed_description 偏长（${words} > ${opts.maxWords}）`);
  return { shots, words };
}

/** <d> 配平 / 标签越界 / 废弃语法（两种格式共用） */
function checkCommonSyntax(text, opts, problems) {
  const open = (String(text).match(/<d>/g) || []).length;
  const close = (String(text).match(/<\/d>/g) || []).length;
  if (open !== close) problems.push(`<d> 与 </d> 不配平（${open}/${close}）`);

  const maxPic = Number(opts.availablePictures);
  const maxAud = Number(opts.availableAudios);
  if (Number.isFinite(maxPic) && maxPic >= 0) {
    for (const l of collectLabels(text)) {
      if (l.kind === 'Picture' && l.n > maxPic) problems.push(`引用了不存在的 ${l.raw}（可用 ${maxPic} 张图）`);
    }
  }
  if (Number.isFinite(maxAud) && maxAud >= 0) {
    for (const l of collectLabels(text)) {
      if (l.kind === 'Audio' && l.n > maxAud) problems.push(`引用了不存在的 ${l.raw}（可用 ${maxAud} 段音频）`);
    }
  }

  // H3 只认 <Picture N> / <Subject N>。@图片N（含「（@图片N）」人类标注）一律不接受：
  // 后端 toPictureTags 会把 @图片N 再转一次，正文里就出现 <Picture 1>（<Picture 1>） 重复参考标签。
  if (/@图片\s*\d/.test(text)) problems.push('仍在使用废弃的 @图片N（应为 <Picture N>，正文里也不要写「（@图片N）」标注）');
  if (/@人物\s*\d/.test(text)) problems.push('使用了禁止的 @人物N');
  if (/\[禁BGM\]|\[禁字幕\]/.test(text)) problems.push('含灵境格式标记');
}

/**
 * 精简格式（本机折中版）校验。
 * 只要三段：detailed_description → overall_soundscape → non_diegetic_music；
 * 段名前可以写 `<Picture N>：…` 参考映射行；不再需要 <Subject N> 与 retention_analysis。
 */
function validateLeanRef2va(text, opts, problems) {
  const parsed = parseRef2vaSections(text, LEAN_SECTIONS);
  if (parsed.missing.length) problems.push(`缺少段：${parsed.missing.join(', ')}`);
  if (!parsed.orderOk) problems.push(`段顺序不符（应为 ${LEAN_SECTIONS.join(' → ')}）`);
  // 段名前允许写参考映射与约束：映射行、环境参考约束（提到 <Picture N>），
  // 以及参考音频的音色绑定行（规范允许，且**只有** <Audio j> 时也必须允许 ——
  // 兜底模板在没有任何画外解说音频时只有这一行，判它多余会让自己的兜底不合规）：
  //   <Picture 1>：场景「吴家客厅」——沿用…
  //   环境、光影与陈设定性参考 <Picture 1>。若为宫格/拼图，仅取统一空间…
  //   <Audio 1> is the voice-timbre reference for the character “唐僧” (S1).
  const badHead = parsed.extraHead.filter((l) => !/<Picture\s+\d+>/.test(l) && !/<Audio\s+\d+>/i.test(l));
  if (badHead.length) problems.push(`段名之前有多余内容：${badHead[0].slice(0, 40)}`);

  const s2 = parsed.sections;
  const { shots, words } = checkShotsAndTimeline(s2.detailed_description || '', opts, problems);
  checkCommonSyntax(text, opts, problems);
  for (const k of ['overall_soundscape', 'non_diegetic_music']) {
    if (!(s2[k] || '').trim()) problems.push(`${k} 为空`);
  }
  return { ok: problems.length === 0, problems, sections: s2, shots, words, format: 'lean' };
}

/**
 * 精简格式的**机械修复**：段名前的参考图映射行（`<Picture N>：<kind>「名字」——…`）原样保留，
 * 只补缺失的声音两段、并把 [Shot N] 归一到从 1 开始。
 *
 * 正文（detailed_description）缺失 → fatal（没法凭空造镜头），与六段格式同一判据。
 *
 * @returns {{fatal:boolean, text:string, changes:string[]}}
 */
function repairLeanRef2va(text, opts = {}) {
  const raw = String(text || '');
  const changes = [];
  const head = [];
  const sec = { detailed_description: [], overall_soundscape: [], non_diegetic_music: [] };
  let cur = null;
  for (const line of raw.split('\n')) {
    const m = line.match(/^\s*(detailed_description|overall_soundscape|non_diegetic_music)\s*[:：]\s*/i);
    if (m) {
      cur = m[1].toLowerCase();
      const rest = line.slice(m[0].length).trim();
      if (rest) sec[cur].push(rest);
      continue;
    }
    if (cur) sec[cur].push(line);
    else head.push(line);            // 段名前：参考图映射行 + 环境参考约束
  }

  const ddRaw = sec.detailed_description.join('\n').trim();
  if (!ddRaw) return { fatal: true, text: raw, changes: ['缺少 detailed_description，无法机械修复'] };

  // [Shot N] 重编号（同六段格式：每条 ust 都是独立一次生成，首拍永远是 [Shot 1]）
  let dd = ddRaw;
  {
    SHOT_RE.lastIndex = 0;
    const nums = [];
    let m2;
    while ((m2 = SHOT_RE.exec(dd))) nums.push(Number(m2[1]));
    if (nums.length > 0 && nums[0] !== 1) {
      const map = new Map();
      nums.forEach((n, i) => { if (!map.has(n)) map.set(n, i + 1); });
      dd = dd.replace(/\[Shot\s+(\d+)\]/g, (full, d) => (map.get(Number(d)) ? `[Shot ${map.get(Number(d))}]` : full));
      changes.push(`[Shot N] 重编号为 1..${map.size}（原首拍为 ${nums[0]}）`);
    }
  }

  const ss = sec.overall_soundscape.join('\n').trim()
    || String(opts.soundscapeFallback || '').trim()
    || '环境声与动作音效自然延续。';
  const nm = sec.non_diegetic_music.join('\n').trim() || '无（不使用背景音乐）。';
  if (!sec.overall_soundscape.join('\n').trim()) changes.push('补 overall_soundscape');
  if (!sec.non_diegetic_music.join('\n').trim()) changes.push('补 non_diegetic_music');

  const headText = head.join('\n').replace(/\s+$/, '');
  const out = [
    headText,
    'detailed_description:',
    dd,
    'overall_soundscape:',
    ss,
    'non_diegetic_music:',
    nm,
  ].filter((x, i) => !(i === 0 && !x)).join('\n');
  return { fatal: false, text: out, changes };
}

/**
 * 模型没返回可用六段时的**同格式兜底**（不得退回旧块格式：兜底与正常产出必须同格式，
 * 否则兜底本身就是脏数据来源 —— 这是本项目已经吃过一次的教训）。
 *
 * @param {object} sb 分镜行
 * @param {object} d  { durationSec, action, result, dialogue, narration, atmosphere, movement, shotType }
 * @param {Array}  slots [{index, tag, kind, name}] 参考图槽位（顺序 = 成片参考图顺序）
 * @param {{styleHint?:string, audioSlots?:Array<{index:number,name:string,speakerId?:string}>}} [opts]
 */
function buildRef2vaFallback(sb, d, slots, opts = {}) {
  const styleHint = String(opts.styleHint || '').trim();
  const dur = Math.max(1, Number(d.durationSec) || 8);
  const lines = [];
  const sceneSlot = (slots || []).find((s) => s.kind === '场景');
  const charSlots = (slots || []).filter((s) => s.kind === '角色');
  const propSlots = (slots || []).filter((s) => s.kind === '道具');
  const numOf = (slot) => (slot ? slot.index : 0);

  const loc = [sb?.location, sb?.time].filter(Boolean).join('，') || '本镜空间';
  const act = String(d.action || '').trim() || '人物在场景内完成本镜戏核动作';

  // 与规范同格式：**精简格式**（段名前 <Picture N> 映射行 + 三段落）。
  // 以前这里产出的是旧六段格式（subject_definitions / summary / retention_analysis + <Subject N>），
  // 而规范早已明令禁止 <Subject N> 与那三段元数据 —— 兜底格式与正产不一致，
  // 兜底本身就成了脏数据源（本项目已经吃过一次这个教训，见文件顶部注释）。
  const mapLine = [];
  if (sceneSlot) mapLine.push(`<Picture ${numOf(sceneSlot)}>：场景「${sceneSlot.name}」——沿用其空间结构、光线与氛围。`);
  for (const c of charSlots) mapLine.push(`<Picture ${numOf(c)}>：角色「${c.name}」——其外貌、发型与服装来自该图。`);
  for (const p of propSlots) mapLine.push(`<Picture ${numOf(p)}>：道具「${p.name}」——其外形来自该图。`);
  for (const a of opts.audioSlots || []) {
    const target = charSlots.find((c) => c.name === a.name);
    const sid = a.speakerId ? ` (${a.speakerId})` : '';
    mapLine.push(
      target
        ? `<Audio ${a.index}> is the voice-timbre reference for the character “${target.name}”${sid}.`
        : `<Audio ${a.index}> is the voice-timbre reference for the off-screen narrator${sid}.`
    );
  }
  lines.push(...mapLine);
  lines.push('detailed_description:');
  if (styleHint) lines.push(styleHint);
  lines.push(`[Shot 1] ${act}`);
  if (String(d.dialogue || '').trim()) {
    lines.push(`<d>[Chinese] ${String(d.dialogue).trim()}</d>`);
  }
  lines.push('overall_soundscape:');
  lines.push(String(d.atmosphere || '').trim() || '环境声与动作音效自然延续。');
  lines.push('non_diegetic_music:');
  lines.push('无（不使用背景音乐）。');
  return lines.join('\n');
}


/**
 * 缺段的**机械补齐**（尽量保住模型写的内容）。
 *
 * 为什么不整条换成模板：六段里 `detailed_description` 是模型写的最有价值的部分（上百词镜头描写），
 * 缺个 soundscape 就把它一起扔掉、换成兜底模板，正是本项目已经吃过的亏。
 * 所以：`detailed_description` 缺失 → fatal（没法凭空造镜头）；其余缺段 → 机械补齐。
 *
 * @returns {{fatal:boolean, text:string, changes:string[]}}
 */
function repairRef2va(text, opts = {}) {
  const raw = String(text || '');
  if (isLeanRef2va(raw)) return repairLeanRef2va(raw, opts);
  const changes = [];
  const parsed = parseRef2vaSections(raw);
  const s = parsed.sections;
  if (!String(s.detailed_description || '').trim()) {
    return { fatal: true, text: raw, changes: ['缺少 detailed_description，无法机械修复'] };
  }
  if (!String(s.subject_definitions || '').trim()) {
    return { fatal: true, text: raw, changes: ['缺少 subject_definitions，无法机械修复'] };
  }

  const subjects = collectLabels(s.subject_definitions).filter((l) => l.kind === 'Subject');
  const subjectKeys = Array.from(new Set(subjects.map((l) => l.raw)));

  // retention_analysis：缺行或标记非法 → 按 <Subject N> 补齐/改写
  const raLines = String(s.retention_analysis || '').split('\n').map((l) => l.trim()).filter(Boolean);
  const raByLabel = new Map();
  const raGood = [];
  for (const line of raLines) {
    const m = line.match(RETENTION_LINE_RE);
    if (m) {
      const key = `<${m[1]} ${m[2]}>`;
      if (!raByLabel.has(key)) { raByLabel.set(key, true); raGood.push(line); }
    } else {
      changes.push(`丢弃不合规的 retention 行：${line.slice(0, 30)}`);
    }
  }
  const shotsInDd = [];
  SHOT_RE.lastIndex = 0;
  let sm;
  while ((sm = SHOT_RE.exec(s.detailed_description))) shotsInDd.push(Number(sm[1]));
  const appears = shotsInDd.length ? `[Shot ${shotsInDd.join('], [Shot ')}]` : '[Shot 1]';
  for (const k of subjectKeys) {
    if (raByLabel.has(k)) continue;
    raGood.push(`${k} (appears in ${appears}): fully_preserved - 沿用参考素材定义的角色、空间与道具特征。`);
    changes.push(`补 retention 行 ${k}`);
  }

  // [Shot N] 重编号：每条 universal_segment_text 都是**独立的一次生成**，所以第一拍永远是 [Shot 1]。
  // 实测（drama7 ep21，2026-09-15）：模型把镜头编号写成了分镜序号（镜2 → [Shot 2]、镜7 → [Shot 7]），
  // 15 镜里 14 镜因此被判「第一个镜头必须是 [Shot 1]」不合规。这里做确定性重编号（保留剪辑时间戳）。
  let dd = String(s.detailed_description || '').trim();
  {
    SHOT_RE.lastIndex = 0;
    const nums = [];
    let m2;
    while ((m2 = SHOT_RE.exec(dd))) nums.push(Number(m2[1]));
    const needsRenumber = nums.length > 0 && nums[0] !== 1;
    if (needsRenumber) {
      const map = new Map();
      nums.forEach((n, i) => { if (!map.has(n)) map.set(n, i + 1); });
      dd = dd.replace(/\[Shot\s+(\d+)\]/g, (full, d) => {
        const to = map.get(Number(d));
        return to ? `[Shot ${to}]` : full;
      });
      changes.push(`[Shot N] 重编号为 1..${map.size}（原首拍为 ${nums[0]}，模型误用了分镜序号）`);
    }
  }

  const sections = {
    subject_definitions: String(s.subject_definitions || '').trim(),
    summary: String(s.summary || '').trim() || `${String(opts.summaryFallback || '').trim() || '本镜沿用参考素材定义的主体与空间。'}`,
    retention_analysis: raGood.join('\n'),
    detailed_description: dd,
    overall_soundscape:
      String(s.overall_soundscape || '').trim() ||
      String(opts.soundscapeFallback || '').trim() ||
      '环境声与动作音效自然延续。',
    non_diegetic_music: String(s.non_diegetic_music || '').trim() || '无（不使用背景音乐）。',
  };
  if (!String(s.summary || '').trim()) changes.push('补 summary');
  if (!String(s.overall_soundscape || '').trim()) changes.push('补 overall_soundscape');
  if (!String(s.non_diegetic_music || '').trim()) changes.push('补 non_diegetic_music');

  const out = REF2VA_SECTIONS.map((k) => `${k}:\n${sections[k]}`).join('\n');
  return { fatal: false, text: out, changes };
}

module.exports = {
  REF2VA_SECTIONS,
  VISIBLE_MARKERS,
  AUDIO_MARKERS,
  RETENTION_LINE_RE,
  parseRef2vaSections,
  validateRef2va,
  collectLabels,
  isLeanRef2va,
  buildRef2vaFallback,
  repairRef2va,
};
