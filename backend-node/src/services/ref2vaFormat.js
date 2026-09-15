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
function parseRef2vaSections(text) {
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
  const missing = REF2VA_SECTIONS.filter((s) => !(s in sections));
  // 顺序必须是官方顺序的子序列（允许省略，但出现了的必须按序）
  const expected = REF2VA_SECTIONS.filter((s) => order.includes(s));
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
function validateRef2va(text, opts = {}) {
  const problems = [];
  const parsed = parseRef2vaSections(text);
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

  // <Audio j> 必须绑到 subject（§2.4）
  const audioDefs = (s.subject_definitions || '').split('\n').filter((l) => /<Audio\s+\d+>/i.test(l));
  for (const line of audioDefs) {
    if (!/<Subject\s+\d+>/i.test(line)) problems.push(`<Audio j> 定义未绑定 <Subject N>：${line.slice(0, 50)}`);
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

  // detailed_description：风格句在 [Shot 1] 之前；[Shot 1] 无时间戳；后续带时间戳（§5.1/§5.2）
  const dd = s.detailed_description || '';
  if (!dd.trim()) problems.push('detailed_description 为空');
  const shots = [];
  SHOT_RE.lastIndex = 0;
  let sm;
  while ((sm = SHOT_RE.exec(dd))) shots.push({ n: Number(sm[1]), at: sm[2] || null, index: sm.index });
  if (!shots.length) problems.push('detailed_description 里没有 [Shot N]');
  else {
    if (shots[0].n !== 1) problems.push('第一个镜头必须是 [Shot 1]');
    if (shots[0].at) problems.push('[Shot 1] 不应带时间戳');
    if (shots[0].index > 0 && dd.slice(0, shots[0].index).replace(/^[\s\S]*?\n/, '').trim().length === 0) {
      // 允许只写一段风格句，这里不做强制
    }
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

  // 字数（英文词；中文按空白/标点近似切分也能反映量级）
  const words = String(dd).split(/[\s,.;:!?，。；：！？、]+/).filter((w) => w.length > 1).length;
  if (opts.minWords && words < opts.minWords) problems.push(`detailed_description 偏短（${words} < ${opts.minWords}）`);
  if (opts.maxWords && words > opts.maxWords) problems.push(`detailed_description 偏长（${words} > ${opts.maxWords}）`);

  // <d> 配平
  const open = (String(text).match(/<d>/g) || []).length;
  const close = (String(text).match(/<\/d>/g) || []).length;
  if (open !== close) problems.push(`<d> 与 </d> 不配平（${open}/${close}）`);

  // 标签越界（引用了不存在的 <Picture N> / <Audio j>）
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

  // 已废弃格式的指纹
  if (/@图片\s*\d/.test(text)) problems.push('仍在使用废弃的 @图片N（应为 <Picture N> / <Subject N>）');
  if (/@人物\s*\d/.test(text)) problems.push('使用了禁止的 @人物N');
  if (/\[禁BGM\]|\[禁字幕\]/.test(text)) problems.push('含灵境格式标记');

  return { ok: problems.length === 0, problems, sections: s, shots, words };
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
  const subj = [];
  let n = 0;
  const sceneSlot = (slots || []).find((s) => s.kind === '场景');
  const charSlots = (slots || []).filter((s) => s.kind === '角色');
  const propSlots = (slots || []).filter((s) => s.kind === '道具');
  const numOf = (slot) => (slot ? slot.index : 0);

  if (sceneSlot) {
    n += 1;
    subj.push(`<Subject ${n}> 是 <Picture ${numOf(sceneSlot)}> 中的「${sceneSlot.name}」——沿用其空间结构、光线与氛围。`);
  }
  for (const c of charSlots) {
    n += 1;
    subj.push(`<Subject ${n}> 是 <Picture ${numOf(c)}> 中的角色「${c.name}」——其外貌、发型与服装来自该图。`);
  }
  for (const p of propSlots) {
    n += 1;
    subj.push(`<Subject ${n}> 是 <Picture ${numOf(p)}> 中的道具「${p.name}」——其外形来自该图。`);
  }
  for (const a of opts.audioSlots || []) {
    const target = charSlots.find((c) => c.name === a.name);
    const sid = a.speakerId ? ` (${a.speakerId})` : '';
    if (target) {
      const idx = (sceneSlot ? 1 : 0) + charSlots.indexOf(target) + 1;
      subj.push(`<Audio ${a.index}> is the voice-timbre reference for <Subject ${idx}>${sid}.`);
    } else {
      subj.push(`<Audio ${a.index}> is the voice-timbre reference${sid}.`);
    }
  }

  const loc = [sb?.location, sb?.time].filter(Boolean).join('，') || '本镜空间';
  const act = String(d.action || '').trim() || '人物在场景内完成本镜戏核动作';

  lines.push('subject_definitions:');
  lines.push(...(subj.length ? subj : ['<Subject 1> 为本镜场景的空间与光线来源。']));
  lines.push('summary:');
  lines.push(`${loc}；${act.slice(0, 120)}。`);
  lines.push('retention_analysis:');
  for (let i = 1; i <= n; i++) {
    lines.push(`<Subject ${i}> (appears in [Shot 1]): fully_preserved - 沿用参考素材定义的角色/空间特征。`);
  }
  for (const a of opts.audioSlots || []) {
    lines.push(`<Audio ${a.index}>: reference - 仅参考其音色与语气，不复述原音频内容。`);
  }
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
  buildRef2vaFallback,
  repairRef2va,
};
