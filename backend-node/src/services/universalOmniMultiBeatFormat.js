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

/**
 * H3 原生**镜内剪辑记号**。
 *
 * 背景（本文件最重要的更正）：`chooseBeatCount` 顶部那段「H3 是单镜头模型、不支持切镜」的结论
 * **是错的**。官方 H3 提示词规范明确支持一次生成内多镜头，用 `[Shot N]` 标记每一镜、
 * 用 `At MM:SS.mmm, the camera cuts to …` 标记剪辑点，并给出完整示例：
 *   `[Shot 1] … says: <d>[English] First batch of the morning.</d>
 *    [Shot 2] At 00:05.000, the camera cuts to a close-up of steam rising from the sliced bread
 *    while the baker's final words carry over from the previous shot.`
 * 全篇唯一的「偏好单镜」是 **FL2VA 专属**（首末帧插值任务），Ref2VA 不受此限。
 *
 * 所以「分镜」（我们库里的 storyboard = 一次成片 API）与「[Shot N]」（这次生成内部的镜头）
 * 是**两个层级**，不冲突：一条 universal_segment_text 仍然只写一条「分镜1：」行，
 * 但它的正文里允许出现 `[Shot 2] At 00:03.000, the camera cuts to …` 这样的镜内剪辑点。
 *
 * 为什么必须放开：实测「花果山对峙」（drama2 镜10，9 秒）写成单镜后，前 ~8 秒全被定场与运镜
 * 吃掉，真正「抡起金箍棒当头劈下 / 抄棒横架」的打斗只挤在最后 0.8 秒。打斗要连续，
 * 只能靠一次生成内的多拍剪辑（空间、人物、光照、音轨天然一致），而不是跨 clip 硬接。
 */
const CUT_MARKER_RE = /\[Shot\s+(\d+)\]\s*(?:At\s+(?:(\d{1,2}):)?(\d{2}):(\d{2})\.(\d{3})\s*)?/g;

/** 一次生成内允许的最大镜数。官方示例都是 2-3 镜；8 秒塞 4 拍已是极限。 */
const MAX_INTRA_SHOTS = 4;

function cutTimeToSec(h, m, s) {
  return (Number(h) || 0) * 3600 + Number(m) * 60 + Number(s);
}

/**
 * 秒 → `00:03.200`（官方记号的写法：`MM:SS.mmm`，两位分钟）。
 * 官方示例全部是 `At 00:03.500` / `At 00:05.000` 这种两位分钟格式，
 * 本项目的片段都在 15 秒内，因此不需要小时位。
 */
function secToCutTime(sec) {
  const v = Math.max(0, Number(sec) || 0);
  const m = Math.floor(v / 60);
  const s = v % 60;
  return String(m).padStart(2, '0') + ':' + s.toFixed(3).padStart(6, '0');
}

/** `[Shot 3] At 00:05.600` 或首镜 `[Shot 1]` */
function formatCutMarker(n, atSec) {
  if (atSec == null) return '[Shot ' + Number(n) + ']';
  return '[Shot ' + Number(n) + '] At ' + secToCutTime(atSec);
}

/**
 * 抽出正文里的镜内剪辑点（按出现顺序）。
 * 同时接受官方两位分钟格式 `MM:SS.mmm` 与三位小时格式 `HH:MM:SS.mmm`。
 * @returns {Array<{n:number, atSec:number|null, raw:string, index:number}>}
 */
function parseCutMarkers(text) {
  const t = String(text || '');
  const out = [];
  CUT_MARKER_RE.lastIndex = 0;
  let m;
  while ((m = CUT_MARKER_RE.exec(t))) {
    out.push({
      n: Number(m[1]),
      // 组：1=镜号，2=小时(可选)，3=分，4=秒，5=毫秒 —— 秒与毫秒要拼成 "03.200" 再转数
      atSec: m[4] == null ? null : cutTimeToSec(m[2], m[3], m[4] + '.' + m[5]),
      raw: m[0],
      index: m.index,
    });
  }
  return out;
}

/**
 * 校验镜内剪辑点序列是否自洽（只在正文里确实写了 `[Shot N]` 时才检查）。
 *
 * @param {string} text 整条 universal_segment_text
 * @param {number} [durationSec] 本镜时长（来自「分镜1： T秒:」行）；未知时跳过时间检查
 * @returns {string[]} 问题列表（空数组 = 合规）
 */
function checkCutMarkers(text, durationSec) {
  const problems = [];
  const cuts = parseCutMarkers(text);
  if (!cuts.length) return problems;
  if (cuts.length > MAX_INTRA_SHOTS) {
    problems.push(`镜内剪辑点 ${cuts.length} 个 > 上限 ${MAX_INTRA_SHOTS}`);
  }
  if (cuts[0].n !== 1) problems.push('首个镜内剪辑点必须是 [Shot 1]');
  if (cuts[0].atSec != null && cuts[0].atSec !== 0) {
    problems.push('[Shot 1] 不应带时间戳（首镜从 0.00 秒开始）');
  }
  for (let i = 1; i < cuts.length; i++) {
    if (cuts[i].n !== cuts[i - 1].n + 1) {
      problems.push(`镜内剪辑点编号不连续：[Shot ${cuts[i - 1].n}] → [Shot ${cuts[i].n}]`);
    }
    if (cuts[i].atSec == null) {
      problems.push(`[Shot ${cuts[i].n}] 缺少剪辑时间戳（应为 "At MM:SS.mmm,"）`);
      continue;
    }
    if (cuts[i - 1].atSec != null && cuts[i].atSec <= cuts[i - 1].atSec) {
      problems.push(`镜内剪辑点时间未递增：${cuts[i - 1].atSec}s → ${cuts[i].atSec}s`);
    }
    const dur = Number(durationSec);
    if (Number.isFinite(dur) && dur > 0 && cuts[i].atSec >= dur) {
      problems.push(`镜内剪辑点 ${cuts[i].atSec}s 超出本镜时长 ${dur}s`);
    }
  }
  return problems;
}

/** 从「分镜1： T秒:」行取本镜时长 */
function parseBeatDurationSec(text) {
  const m = String(text || '').match(/分镜\s*1\s*[:：]\s*([\d.]+)\s*秒/);
  const v = m ? Number(m[1]) : NaN;
  return Number.isFinite(v) && v > 0 ? v : null;
}

/**
 * 本镜是不是**打斗/动作爆发**镜 —— 决定要不要镜内切拍。
 *
 * 为什么要判：提示词里只说「打斗镜可以切拍」时，模型会保守地保持单镜（实测 sb349：
 * 明明写着「抡圆了当头劈下 / 抄棒横架相迎 / 两棒相交迸出火星」，输出仍是「单镜头连续画幅」一条）。
 * 要让打斗真的切拍，就得给一个**确定性**的判定，再据此下明确指令。
 *
 * 判定用**强动作词**而不是「打」这种泛词（否则「打发」「打听」会误判）：
 *   · 成对交锋词（交手/交锋/厮杀/对打/招架/举棒相迎/两棒相交/打到…）→ 命中一个即算
 *   · 单字动作动词（劈/砍/刺/抡/砸/扫/架住/击中…）→ 需命中 ≥2 个不同词
 *
 * 词表来自真实数据的对照。实测「真假美猴王」21 镜里，只靠单字动词会**漏掉一半打斗镜** ——
 * 镜10「抡起金箍棒当头就打」只命中「抡」一个，镜11/12/14「两猴打到南海/天宫/西天」一个都不命中
 * （它们用的词是「打到」），镜16「抡棒一棒将其打死」也只命中「抡」。
 *
 * @param {{action?:string, description?:string, title?:string, result?:string}} sb
 * @returns {{ fight: boolean, hits: string[] }}
 */
const FIGHT_PAIR_RE = /(打斗|交手|交锋|厮杀|对打|恶战|混战|斗法|招架|迎战|迎击|格挡|过招|拳脚|激战|鏖战|打到|就打|开打|相迎|相交|举棒|挥棒|抡起|一棒|火花|打死|击中|受伤|负伤)/g;
const FIGHT_VERB_RE = /(劈|砍|斩|刺|抡|砸|扫|架住|横架|挡|撞|踢|踹|捣|戳|猛击|出拳|一掌|兵器)/g;

function detectFightShot(sb) {
  const src = [sb && sb.title, sb && sb.action, sb && sb.description, sb && sb.result]
    .filter(Boolean).join(' ');
  if (!src.trim()) return { fight: false, hits: [] };
  const pairs = src.match(FIGHT_PAIR_RE) || [];
  const verbs = Array.from(new Set(src.match(FIGHT_VERB_RE) || []));
  const hits = pairs.concat(verbs);
  return { fight: pairs.length > 0 || verbs.length >= 2, hits: Array.from(new Set(hits)) };
}

/** 打斗镜的目标镜内镜头数（3 拍：起势/交锋/结果。官方示例也都是 2-3 镜） */
const FIGHT_INTRA_SHOTS = 3;

/** 保留多行，仅规范换行 */
function normalizeUniversalSegmentTextNewlines(text) {
  if (!text) return '';
  return String(text)
    .replace(/\r\n/g, '\n')
    .replace(/\r/g, '\n')
    .trim();
}

/**
 * 「分镜行」数恒为 1（一条 universal_segment_text = 一次成片 API = 一块骨架）。
 *
 * 注意这里说的是**分镜行**（`分镜1： T秒:` 那种整行），不是 H3 的镜内剪辑点。
 * 历史上「每 5 秒一拍」拆成 1–8 **行** 的做法确实会把画面塞崩，因为拆出来的每一行都自带
 * `分镜k： Tk秒:` 前缀，而 H3 从未被这样告知剪辑点在哪 —— 它只看到 8 段文字，于是同时演出。
 * 正确写法见 CUT_MARKER_RE 的注释：仍然只有 1 行，但行内用官方记号
 * `[Shot N] At MM:SS.mmm, the camera cuts to …` 明确标出每一拍与剪辑时刻。
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

/**
 * LINE3 的**多镜形态**：本镜正文里会出现 `[Shot N] At MM:SS.mmm,` 镜内剪辑点时使用。
 *
 * 为什么必须换句而不能沿用 DEFAULT_LINE3：后者结尾是「须单镜头完整连续画面」，
 * 与正文里的 `[Shot 2] At 00:03.000, the camera cuts to …` **直接冲突** ——
 * 正是本项目反复吃亏的那类自相矛盾指令（一如「真人写实」撞上水墨风格）。
 * 换成多镜形态后，「禁止复刻参考图宫格/分屏」这个**原意**（防的是把参考拼图搬进成片）
 * 仍然保留，只是不再禁止镜内剪辑。
 */
const LINE3_MULTI = '环境、光影与陈设定性参考 @图片1。若 @图片1 为宫格或多画面拼图，禁止成片复刻其分格或并列布局，仅提取统一的空间、光线与氛围语义；本条为一次生成内的连续多镜头剪辑，允许镜内切镜（见 [Shot N] 剪辑点），但禁止成片宫格、分屏与多画面并列。';

/** 多镜形态：本镜没有场景参考图时（scene_id 为空） */
const LINE3_NO_SCENE_MULTI = '本片段以首张参考图 @图片1 作为画面锚点展开；本条为一次生成内的连续多镜头剪辑，允许镜内切镜（见 [Shot N] 剪辑点），但禁止成片宫格与分屏。';

/** 4 种合法 LINE3（单镜/多镜 × 有场景图/无场景图） */
const LINE3_VARIANTS = [DEFAULT_LINE3, LINE3_NO_SCENE, LINE3_MULTI, LINE3_NO_SCENE_MULTI];

/** 给定时长与镜内镜数时，该用哪一句 LINE3 */
function pickUniversalLine3(hasScene, intraShots) {
  const multi = Number(intraShots) >= 2;
  if (multi) return hasScene ? LINE3_MULTI : LINE3_NO_SCENE_MULTI;
  return hasScene ? DEFAULT_LINE3 : LINE3_NO_SCENE;
}

/** LINE3 是否属于任一合法形态 */
function isUniversalLine3(text) {
  let t = String(text || '');
  if (!t) return false;
  // 参考图标签可能被写成「参考图N」（MiniMax 官方 r2va 用词，见 universalSegmentPromptBundle 的 imgRef）
  // 或 <Picture N>；比对前一律归一成 @图片N，否则完全正确的第3行会被误判为不合规。
  t = t.replace(/参考图\s*(\d+)/g, '@图片$1').replace(/<Picture\s*(\d+)>/g, '@图片$1');
  if (LINE3_VARIANTS.some((v) => t.includes(v))) return true;
  // 场景槽位不一定是 @图片1（极少见），按句式认
  return /环境、光影与陈设定性参考 @图片\d+。若 @图片\d+ 为宫格或多画面拼图[^\n]*(须单镜头完整连续画面|允许镜内切镜)[^\n]*。/.test(t)
    || /本片段以首张参考图 @图片\d+ 作为画面锚点展开。/.test(t)
    || /本片段以首张参考图 @图片\d+ 作为画面锚点展开；[^\n]*允许镜内切镜[^\n]*。/.test(t);
}

/** LINE3 是不是**多镜**形态（正文有 [Shot 2]+ 时必须是） */
function isMultiShotLine3(text) {
  const t = String(text || '').replace(/参考图\s*(\d+)/g, '@图片$1');
  return t.includes(LINE3_MULTI) || t.includes(LINE3_NO_SCENE_MULTI) || /允许镜内切镜/.test(t);
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

  // 镜内剪辑点（H3 原生多镜记号）：只在正文确实写了 [Shot N] 时才检查。
  // 多镜正文必须配多镜形态的 LINE3 —— 「须单镜头完整连续画面」和
  // 「[Shot 2] At 00:03.000, the camera cuts to …」是自相矛盾的指令。
  const cuts = parseCutMarkers(t);
  if (cuts.length) {
    for (const p of checkCutMarkers(t, parseBeatDurationSec(t))) problems.push(p);
    if (cuts.length >= 2 && !isMultiShotLine3(t)) {
      problems.push('正文有多个 [Shot N] 剪辑点，但第3行仍是单镜形态 LINE3（须单镜头完整连续画面）');
    }
  }

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
  // 正文写了镜内剪辑点，第3行却还是单镜形态（「须单镜头完整连续画面」）→ 换成多镜形态。
  // 这是**格式自相矛盾**，不是内容问题，属于「骨架错 → 只换骨架那几行」的范畴。
  const cutCount = parseCutMarkers(lines.slice(beatIdx).join('\n')).length;
  if (cutCount >= 2 && !isMultiShotLine3(line3)) {
    line3 = pickUniversalLine3(/环境、光影与陈设定性参考/.test(line3), 2);
    changes.push('正文含镜内剪辑点，第3行已换成多镜形态 LINE3');
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
  let multiShot = 0;
  let cutTotal = 0;
  // 打斗镜与镜内切拍的一致性：**打斗镜没切拍**是最该被点出来的问题 ——
  // 实测单镜打斗会把 ~90% 的时长花在定场与运镜上，真正的交锋只挤在最后一瞬。
  // 只有调用方给的 row 里带 action/title 时才能判（saveStoryboards 的概要路径不一定带）。
  const fightsWithoutCuts = [];
  const cutsWithoutFight = [];
  for (const r of rows) {
    const v = validateUniversalSegmentText(r.universal_segment_text, opts);
    if (!v.ok) samples.push({ id: r.id ?? null, title: r.title || '', problems: v.problems });
    const cuts = parseCutMarkers(r.universal_segment_text).length;
    if (cuts >= 2) multiShot += 1;
    cutTotal += cuts;
    if (r.action || r.title) {
      const f = detectFightShot(r);
      if (f.fight && cuts < 2) {
        fightsWithoutCuts.push({
          id: r.id ?? null, title: r.title || '', storyboard_number: r.storyboard_number ?? null,
          hits: f.hits.slice(0, 4),
        });
      } else if (!f.fight && cuts >= 2) {
        cutsWithoutFight.push({
          id: r.id ?? null, title: r.title || '', storyboard_number: r.storyboard_number ?? null, cuts,
        });
      }
    }
  }
  return {
    checked: rows.length,
    noncompliant: samples.length,
    samples: samples.slice(0, 5),
    multi_shot: multiShot,
    cut_total: cutTotal,
    fights_without_cuts: fightsWithoutCuts.length,
    fights_without_cuts_samples: fightsWithoutCuts.slice(0, 5),
    cuts_without_fight: cutsWithoutFight.length,
    cuts_without_fight_samples: cutsWithoutFight.slice(0, 5),
  };
}

module.exports = {
  DEFAULT_LINE3,
  LINE3_NO_SCENE,
  LINE3_MULTI,
  LINE3_NO_SCENE_MULTI,
  LINE3_VARIANTS,
  isUniversalLine3,
  isMultiShotLine3,
  pickUniversalLine3,
  MAX_INTRA_SHOTS,
  FIGHT_INTRA_SHOTS,
  detectFightShot,
  parseCutMarkers,
  checkCutMarkers,
  parseBeatDurationSec,
  formatCutMarker,
  secToCutTime,
  cutTimeToSec,
  normalizeUniversalSegmentTextNewlines,
  chooseBeatCount,
  splitDurationSeconds,
  buildFallbackUniversalMultiBeatText,
  validateUniversalSegmentText,
  repairUniversalSegmentText,
  summarizeUniversalSegmentFormat,
};
