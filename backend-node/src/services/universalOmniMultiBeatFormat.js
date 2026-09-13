/**
 * 全能模式 universal_segment_text 统一格式：多子分镜段落（与 generate/polish 接口一致）
 */

const DEFAULT_LINE3 =
  // 注意：措辞必须与场景类型无关。此处原为「仅提取统一的室内空间与光线语义」，
  // 系上游从室内样板沿用（f50a2ee），对户外山道/街景等场景会与剧本直接冲突。
  '环境、光影与陈设定性参考 @图片1。若 @图片1 为宫格或多画面拼图，禁止成片复刻其分格或并列布局，仅提取统一的空间、光线与氛围语义；须单镜头完整连续画面。';

function trim(s) {
  return s != null && String(s).trim() ? String(s).trim() : '';
}

/** 保留多行，仅规范换行 */
function normalizeUniversalSegmentTextNewlines(text) {
  if (!text) return '';
  return String(text)
    .replace(/\r\n/g, '\n')
    .replace(/\r/g, '\n')
    .trim();
}

/**
 * 子分镜数恒为 1。本地 MiniMax H3 是**单镜头连续画面**模型，一次生成只拍一个连续镜头、
 * 不支持切镜；原先按「每 5 秒一拍」拆成 1–8 段，会把多个镜头塞进同一次生成导致画面崩坏。
 * 需要多个镜头时应在分镜层面拆成多条，而不是在这里再分子分镜。
 */
function chooseBeatCount() {
  return 1;
}

/** 将总秒数拆成 M 个正整数且和为 dur */
function splitDurationSeconds(dur, m) {
  const base = Math.floor(dur / m);
  const rem = dur - base * m;
  return Array.from({ length: m }, (_, i) => base + (i < rem ? 1 : 0));
}

/**
 * 分镜批量生成时模型未返回 universal_segment_text 时的**块格式**兜底。
 *
 * 历史教训：这里原先的对应实现在 episodeStoryboardService 里叫
 * buildFallbackUniversalSeedanceLine，产出的是**已废弃的灵境/SoulLens 单行格式**
 *   （主体：@人物1… 叙事动态：… 空间：前景-[…] 光影：… 镜头：… 音效：… [禁BGM][禁字幕]）
 * 而当前规范明令禁止该格式、也禁止 @人物N（见 promptI18n 的 universal spec）。
 * 实测「真假美猴王」重生成 21 镜时模型 21/21 都没返回 universal_segment_text，
 * 于是全部落到那个老兜底上 —— 用户拿到的「全能分镜」全是灵境单行格式，与预期完全不符。
 * 兜底的输出必须与正常产出**同格式**，否则兜底本身就变成脏数据来源。
 */
function buildFallbackUniversalMultiBeatText(sb, d, styleHint) {
  const dur = Math.max(1, Number(d.durationSec) || 5);
  const M = chooseBeatCount(dur);
  const secs = splitDurationSeconds(dur, M);
  const loc = [sb?.location, sb?.time].filter(Boolean).join('，').trim() || '叙事空间';
  const act = trim(d.action) || '人物在场景内完成本镜戏核动作';
  const res = trim(d.result);
  const dia = trim(d.dialogue);
  const narr = trim(d.narration);
  const atm = trim(sb?.atmosphere);
  const styleTail = trim(styleHint);
  // 项目给了风格就**只用它** —— 规范要求风格句内部自洽，禁止再叠加「真人写实/电影风格/高清画质」
  // 这类与项目风格（如水墨）冲突的修饰词。没有风格时才退回通用标签。
  const styleLine = styleTail
    ? `画面风格和类型: ${styleTail}`
    : '画面风格和类型: 真人写实, 电影风格, 高清画质';

  // 第 2 行的措辞必须与规范逐字一致（数字两侧有空格）
  const lines = [styleLine, `生成一个由以下 ${M} 个分镜组成的视频。`, DEFAULT_LINE3];

  for (let k = 0; k < M; k++) {
    const tk = secs[k];
    const isFirst = k === 0;
    const isLast = k === M - 1;
    let body = '';
    if (isFirst) {
      body = `镜头从 @图片1 的${loc}建立画面起，平稳缓推向戏眼；@图片2 处于${act.slice(0, 80)}，${atm ? `${atm}，` : ''}光影随空间纵深拉开。`;
    } else if (isLast) {
      body = `镜头徐徐拉回或推近收束；@图片2 ${res || '完成本镜动作阶段'}，情绪落点明确。`;
    } else {
      body = `镜头继续推进，跟住 @图片2 的动作节奏，${act.slice(0, 100)}，运镜含定镜与缓推轨衔接。`;
    }
    if (dia && (isLast || (M <= 2 && k === M - 1))) {
      body += ` @图片2 说："${dia.replace(/"/g, '')}"`;
    } else if (!dia && k === M - 1) {
      body += ' 无对白。';
    } else if (!dia && k < M - 1) {
      body += ' 无对白。';
    }
    if (narr && isLast) {
      body += ` 旁白（画面无声）："${narr.replace(/"/g, '')}"`;
    }
    lines.push(`分镜${k + 1}： ${tk}秒: ${body}`);
  }
  return lines.join('\n');
}

/**
 * LINE3 的**第二种**合法形态：本镜没有场景参考图时（`scene_id` 为空，@图片1 是角色/道具），
 * 提示词里的 LINE3_REQUIRED 就是这一句（见 universalSegmentPromptBundle 的 line3Required）。
 * 校验时必须认它，否则会把完全正确的正文误判为不合规。
 */
const LINE3_NO_SCENE = '本片段以首张参考图 @图片1 作为画面锚点展开。';

/** LINE3 是否属于任一合法形态 */
function isUniversalLine3(text) {
  const t = String(text || '');
  if (!t) return false;
  if (t.includes(DEFAULT_LINE3) || t.includes(LINE3_NO_SCENE)) return true;
  // 场景槽位不一定是 @图片1（极少见），按句式认
  return /环境、光影与陈设定性参考 @图片\d+。若 @图片\d+ 为宫格或多画面拼图[^\n]*须单镜头完整连续画面。/.test(t)
    || /本片段以首张参考图 @图片\d+ 作为画面锚点展开。/.test(t);
}

const SINGLE_SHOT_DECL_RE = /生成一个由以下\s*1\s*个分镜组成的视频/;

/**
 * 校验 universal_segment_text 是否符合当前规范的**块格式**。
 *
 * 为什么需要：格式合规此前完全靠模型自觉，实测是**抽签**的 —— 同样两轮生成，
 * 「真假美猴王」16 镜那轮 16/16 合规，21 镜那轮 21/21 全变成已废弃的灵境/SoulLens
 * 单行格式（主体：/叙事动态：/空间：/@人物1/[禁BGM]）。不校验就会把脏格式静默存库，
 * 用户拿到的「全能分镜」根本不是全能分镜。
 *
 * @param {string} text
 * @param {{styleZh?: string}} [opts] styleZh 给定时，第 1 行不得再叠加与它冲突的通用标签
 * @returns {{ ok: boolean, problems: string[] }}
 */
function validateUniversalSegmentText(text, opts = {}) {
  const t = String(text || '');
  const problems = [];
  if (!t.trim()) return { ok: false, problems: ['内容为空'] };

  const lines = t.split('\n').map((l) => l.trim()).filter(Boolean);
  const head = lines[0] || '';
  if (lines.length < 4) problems.push(`行数 ${lines.length} < 4`);
  if (!/^画面风格和类型\s*[:：]/.test(head)) problems.push('第1行不是「画面风格和类型:」');
  if (!SINGLE_SHOT_DECL_RE.test(t)) problems.push('第2行不是单分镜声明（应为「生成一个由以下 1 个分镜组成的视频。」）');
  if (!isUniversalLine3(t)) problems.push('第3行不是任一合法形态的 LINE3');

  const beats = t.match(/分镜\s*\d+\s*[:：]/g) || [];
  if (beats.length !== 1) problems.push(`分镜行数 ${beats.length} ≠ 1`);

  // 已废弃格式的指纹
  if (/@人物\s*\d/.test(t)) problems.push('使用了禁止的 @人物N（应用 @图片N）');
  if (/叙事动态\s*[:：]/.test(t) || /^主体\s*[:：]/.test(t)) problems.push('疑似已废弃的灵境/SoulLens 单行格式');
  if (/\[禁BGM\]|\[禁字幕\]/.test(t)) problems.push('含灵境格式的 [禁BGM]/[禁字幕] 标记');

  // 项目已给中文风格时，第 1 行不得再叠加与它冲突的通用写实标签
  const styleZh = String(opts.styleZh || '').trim();
  if (styleZh && !/真人写实/.test(styleZh) && /真人写实/.test(head)) {
    problems.push('第1行含「真人写实」，与项目风格冲突');
  }
  return { ok: problems.length === 0, problems };
}

/**
 * 就地把不合规的块**修好**，而不是整条丢掉用模板兜底。
 *
 * 为什么不能一丢了之：块格式的前 3 行是**固定骨架**，而第 4 行（分镜1 的长句）是模型写的
 * 真正有价值的部分 —— 上百字的电影化描写、@图片N 绑定、运镜链。只要骨架错了就整条替换，
 * 等于把模型写的好东西也一起扔了，换回模板句子（实测就是这样：23 条因为第1行多了「真人写实」
 * 被全部替换成模板，全靠后续润色步骤才救回来；如果没跑润色，用户拿到的就是 23 条模板文）。
 *
 * 所以：骨架错 → 只换骨架那几行；只有结构根本立不住（灵境单行 / 没有分镜行）才判 fatal，
 * 交由调用方走完整兜底。
 *
 * @param {string} text
 * @param {{styleZh?: string}} [opts]
 * @returns {{ fatal: boolean, text: string, changes: string[] }}
 */
function repairUniversalSegmentText(text, opts = {}) {
  const raw = String(text || '');
  const changes = [];
  if (!raw.trim()) return { fatal: true, text: '', changes: ['内容为空'] };

  const lines = raw.split('\n').map((l) => l.trim()).filter(Boolean);
  const beatIdx = lines.findIndex((l) => /^分镜\s*1\s*[:：]/.test(l));
  const extraBeats = lines.filter((l) => /^分镜\s*[2-9]\s*[:：]/.test(l));
  // 结构立不住：没有分镜行，或出现多个子分镜（H3 单镜头模型不支持）
  if (beatIdx < 0 || extraBeats.length > 0) {
    return { fatal: true, text: raw, changes: [beatIdx < 0 ? '缺少「分镜1：」行' : '出现多个子分镜行'] };
  }
  // 灵境单行格式：整条都是废弃格式，救不了
  if (lines.length < 3 && (/叙事动态\s*[:：]/.test(raw) || /^主体\s*[:：]/.test(raw))) {
    return { fatal: true, text: raw, changes: ['疑似已废弃的灵境/SoulLens 单行格式'] };
  }

  const styleZh = String(opts.styleZh || '').trim();
  const beatLine = lines[beatIdx];
  // 第4行之前的都算骨架。按**位置**定位第1/2/3行（不能用值比较 —— 第2行被替换后，
  // 原值就不再等于新值，用值比较会错位把真正的第3行当成第2行丢掉）。
  const skeleton = lines.slice(0, beatIdx);
  const i1 = skeleton.findIndex((l) => /^画面风格和类型\s*[:：]/.test(l));
  const i2 = skeleton.findIndex((l) => /生成一个由以下/.test(l));
  const usedIdx = new Set([i1, i2].filter((i) => i >= 0));
  const i3 = skeleton.findIndex((_, i) => !usedIdx.has(i));
  usedIdx.add(i3);
  // 骨架里多余的说明行不算错误，原样保留（不丢模型写的东西）
  const extras = skeleton.filter((_, i) => !usedIdx.has(i));

  let line1 = i1 >= 0 ? skeleton[i1] : '';
  if (!line1) {
    line1 = `画面风格和类型: ${styleZh || '真人写实, 电影风格, 高清画质'}`;
    changes.push('补齐第1行风格句');
  } else if (styleZh) {
    const cur = line1.replace(/^画面风格和类型\s*[:：]\s*/, '').trim();
    // 项目给了风格：与项目风格不一致（例如多了「真人写实」这类冲突词）就整行换成项目风格。
    // 判定用「去掉所有标点后是否相等」，避免模型只改了标点就被误换。
    const stripPunct = (s) => s.replace(/[，,、。；;\s]/g, '');
    if (stripPunct(cur) !== stripPunct(styleZh)) {
      line1 = `画面风格和类型: ${styleZh}`;
      changes.push('第1行风格句与项目风格不一致，已替换为项目风格');
    }
  }

  let line2 = i2 >= 0 ? skeleton[i2] : '';
  if (!SINGLE_SHOT_DECL_RE.test(line2)) {
    line2 = '生成一个由以下 1 个分镜组成的视频。';
    changes.push('第2行不是单分镜声明，已规范化');
  }

  let line3 = i3 >= 0 ? skeleton[i3] : '';
  if (!isUniversalLine3(line3)) {
    line3 = DEFAULT_LINE3;
    changes.push('第3行不是合法 LINE3，已替换为规范原文');
  }

  const fixed = [line1, line2, line3, ...extras, ...lines.slice(beatIdx)].join('\n').replace(/\r\n?/g, '\n');
  // 修完还不合规（例如正文里混进了 @人物N 或 [禁BGM]）就交给调用方走兜底
  const after = validateUniversalSegmentText(fixed, { styleZh });
  if (!after.ok) return { fatal: true, text: raw, changes: after.problems };
  return { fatal: false, text: fixed, changes };
}

/**
 * 以**库里实际存下来的文本**为准，汇总全能提示词格式合规情况。
 *
 * 与 saveStoryboards 里那个「入库时修复了几个」的累加器不同：这个是对落库结果做只读
 * 复核，因此在**任何**路径上都能算（包括分镜 JSON 解析失败后的「部分恢复」路径 ——
 * 那条路不经过 saveStoryboards，此前完全没有自检）。两者互补：
 *   · repaired（入库时修复数）说明模型偏离了规范，但已被修正
 *   · noncompliant（落库后仍不合规数）说明有东西漏过去了，必须处理
 *
 * @param {Array<object>} storyboards
 * @param {{styleZh?: string}} [opts]
 */
function summarizeUniversalSegmentFormat(storyboards, opts = {}) {
  const rows = (Array.isArray(storyboards) ? storyboards : []).filter(
    (r) => r && r.creation_mode === 'universal'
  );
  const samples = [];
  for (const r of rows) {
    const v = validateUniversalSegmentText(r.universal_segment_text, opts);
    if (!v.ok) samples.push({ id: r.id ?? null, title: r.title || '', problems: v.problems });
  }
  return { checked: rows.length, noncompliant: samples.length, samples: samples.slice(0, 5) };
}

module.exports = {
  DEFAULT_LINE3,
  LINE3_NO_SCENE,
  isUniversalLine3,
  normalizeUniversalSegmentTextNewlines,
  chooseBeatCount,
  splitDurationSeconds,
  buildFallbackUniversalMultiBeatText,
  validateUniversalSegmentText,
  repairUniversalSegmentText,
  summarizeUniversalSegmentFormat,
};
