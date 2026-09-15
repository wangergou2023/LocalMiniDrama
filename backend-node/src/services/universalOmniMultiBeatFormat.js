/**
 * 全能模式 universal_segment_text 统一格式：多子分镜段落（与 generate/polish 接口一致）
 */

const DEFAULT_LINE3 =
  // 注意：措辞必须与场景类型无关。此处原为「仅提取统一的室内空间与光线语义」，
  // 系上游从室内样板沿用（f50a2ee），对户外山道/街景等场景会与剧本直接冲突。
  '环境、光影与陈设定性参考 <Picture 1>。若 <Picture 1> 为宫格或多画面拼图，禁止成片复刻其分格或并列布局，仅提取统一的空间、光线与氛围语义；须单镜头完整连续画面。';

/**
 * 用于**分析**的正文：Ref2VA 六段结构只有 `detailed_description` 里有真正的镜头与剪辑点，
 * 直接拿整条文本去数 `[Shot N]` 会把 retention_analysis 里的「(appears in [Shot 1])」也算进来
 * （实测因此报出「镜内剪辑点 6 个 > 上限 4」「编号不连续 [Shot 1] → [Shot 1]」这类假警）。
 */
function analysisTextOf(ust) {
  const t = String(ust || '');
  if (!/^\s*subject_definitions\s*[:：]/im.test(t)) return t;
  try {
    const { parseRef2vaSections } = require('./ref2vaFormat');
    const dd = parseRef2vaSections(t).sections.detailed_description;
    if (dd && String(dd).trim()) return String(dd);
  } catch (_) {}
  return t;
}

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
const FIGHT_PAIR_RE = /(打斗|交手|交锋|厮杀|对打|恶战|混战|斗法|招架|迎战|迎击|格挡|过招|拳脚|激战|鏖战|打到|打上|打出|追打|厮打|乱斗|对战|交战|苦战|缠斗|就打|开打|相迎|相交|举棒|挥棒|抡起|一棒|火花|打死|击中|受伤|负伤)/g;
const FIGHT_VERB_RE = /(劈|砍|斩|刺|抡|砸|扫|架住|横架|挡|撞|踢|踹|捣|戳|猛击|出拳|一掌|兵器)/g;

/** 判定用的字段。**故意不含 description 与 dialogue**：
 *  description 是「镜头类型/运镜/动作/对话/结果」的合并文本，把 dialogue 也抄了进去 ——
 *  实测 drama4 镜16《八戒举耙对准悟空》本身只是举耙对峙，因 dialogue 里有一句
 *  「你一棒打昏师父」被 description 带进来，于是被判成打斗镜并报了「未切拍」的假警。
 *  dialogue 里的「一棒」是**别人在说发生过的事**，不代表本镜有打斗。 */
function detectFightShot(sb) {
  const src = [sb && sb.title, sb && sb.action, sb && sb.result]
    .filter(Boolean).join(' ');
  if (!src.trim()) return { fight: false, hits: [] };
  const pairs = src.match(FIGHT_PAIR_RE) || [];
  const verbs = Array.from(new Set(src.match(FIGHT_VERB_RE) || []));
  const hits = pairs.concat(verbs);
  return { fight: pairs.length > 0 || verbs.length >= 2, hits: Array.from(new Set(hits)) };
}

/**
 * 本镜正文里**第一个交锋动作**出现的位置（占正文长度的比例）。
 *
 * 这才是「打斗被定场吃掉」的可测特征。实测问题镜（drama2 镜10「花果山对峙」9 秒）的正文是
 * 一整段定场与运镜描写，直到 **91% 处**才出现「抡圆了当头劈下」——
 * 也就是说那次渲染把 8/9 秒花在介绍环境上，交锋只挤在最后 0.8 秒。
 *
 * 与之对照：正常打斗镜的正文在第一句就进入动作（比值约 0.2-0.35）。
 *
 * @param {string} text ust 正文（或整条 ust）
 * @returns {number|null} 0-1 的比例；正文里找不到交锋动作时返回 null
 */
function firstCombatRatio(text) {
  const t = String(text || '');
  const beat = (t.split('\n').find((l) => /^\s*分镜\s*1\s*[:：]/.test(l)) || t)
    .replace(/^\s*分镜\s*1\s*[:：]\s*[\d.]+\s*秒\s*[:：]\s*/, '');
  const body = beat.trim();
  if (body.length < 12) return null;
  // 复用打斗词表，但按「第一个命中的位置」取
  const re = new RegExp(FIGHT_PAIR_RE.source + '|' + FIGHT_VERB_RE.source.replace(/^\(|\)$/g, ''), 'g');
  const m = re.exec(body);
  if (!m) return null;
  return m.index / body.length;
}

/** 超过这个比例就认为「本镜大部分时长花在定场，交锋只在最后一瞬」 */
const FIGHT_TAIL_CRUSH_RATIO = 0.55;
/** 低于这个时长的镜头不报「定场挤压」——太短，藏不住多少定场（实测问题镜是 9 秒） */
const FIGHT_TAIL_CRUSH_MIN_SECONDS = 7;

/**
 * 打斗镜节奏自检：分清「真的坏了」和「本来就该单镜」。
 *
 * 初版规则是「打斗镜没有镜内切拍就报警」，实测在 drama4 上产生 **8 条假警**（真问题 0 条）：
 *   · 镜10 一棒打昏唐僧、镜12 扫翻行李、镜29 举棒格挡 —— 本就 1-2 拍的短交锋，单镜正确
 *   · 镜24-27 水帘洞/花果山连打 —— 分镜层面已拆成**连续 7 镜**（镜24-30），
 *     每镜一拍、同空间连续，比在同一次生成里切拍更专业（还能有景别变化）。
 *     这种「已在分镜层面拆开」的打斗**不需要**再镜内切拍。
 *   · 镜16 举耙对峙 —— 假警，见 detectFightShot 注释
 * 假警比不检查更糟：它会让用户去重写本来正确的分镜，并教会用户忽略这个报告。
 *
 * 所以规则改成：
 *   ① 已切拍（≥2 个剪辑点）→ 通过
 *   ② 相邻镜（±1）也是打斗镜且同地点 → 说明这场打斗已在分镜层面拆成连续镜 → 通过
 *   ③ 否则看正文节奏：第一个交锋动作出现在正文 55% 之后 → **定场挤压**（真问题）
 *   ④ 其余（短交锋、单拍）→ 通过
 *
 * @param {Array<object>} rows storyboards（需含 storyboard_number/action/result/title/universal_segment_text）
 * @returns {{fights:number, cut:number, split_sequence:number, single_beat:number, tail_crushed:Array, cuts_without_fight:Array}}
 */
function checkFightPacing(rows) {
  const list = (Array.isArray(rows) ? rows : []).filter(Boolean);
  const info = list.map((r) => ({
    row: r,
    n: Number(r.storyboard_number) || 0,
    loc: String(r.location || '').trim(),
    fight: detectFightShot(r),
    cuts: parseCutMarkers(analysisTextOf(r.universal_segment_text)).length,
  }));
  const byN = new Map(info.map((x) => [x.n, x]));
  const isFightSeqNeighbour = (x) => {
    for (const d of [-1, 1]) {
      const nb = byN.get(x.n + d);
      if (nb && nb.fight.fight && (!x.loc || !nb.loc || nb.loc === x.loc)) return true;
    }
    return false;
  };

  const out = { fights: 0, cut: 0, split_sequence: 0, single_beat: 0, tail_crushed: [], cuts_without_fight: [] };
  for (const x of info) {
    if (x.fight.fight) {
      out.fights += 1;
      if (x.cuts >= 2) { out.cut += 1; continue; }
      if (isFightSeqNeighbour(x)) { out.split_sequence += 1; continue; }
      const ratio = firstCombatRatio(x.row.universal_segment_text);
      // 只有**够长的镜头**才可能把交锋挤到最后：实测的问题镜是 9 秒（8 秒定场 + 0.8 秒交锋）。
      // 5-6 秒的镜头就算前面铺垫多，剩下的时间也不至于「交锋只在一瞬」，
      // 对它们报警只会制造假警（drama4 镜26「洞外追至山顶」6 秒、比值 0.63 就是这种）。
      const dur = Number(x.row.duration) || 0;
      if (ratio != null && ratio > FIGHT_TAIL_CRUSH_RATIO && dur >= FIGHT_TAIL_CRUSH_MIN_SECONDS) {
        out.tail_crushed.push({
          id: x.row.id ?? null,
          storyboard_number: x.n || null,
          title: x.row.title || '',
          combat_at_percent: Math.round(ratio * 100),
          hits: x.fight.hits.slice(0, 4),
        });
      } else {
        out.single_beat += 1;
      }
    } else if (x.cuts >= 2) {
      out.cuts_without_fight.push({ id: x.row.id ?? null, storyboard_number: x.n || null, title: x.row.title || '', cuts: x.cuts });
    }
  }
  return out;
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
const LINE3_NO_SCENE = '本片段以首张参考图 <Picture 1> 作为画面锚点展开。';

/**
 * LINE3 的**多镜形态**：本镜正文里会出现 `[Shot N] At MM:SS.mmm,` 镜内剪辑点时使用。
 *
 * 为什么必须换句而不能沿用 DEFAULT_LINE3：后者结尾是「须单镜头完整连续画面」，
 * 与正文里的 `[Shot 2] At 00:03.000, the camera cuts to …` **直接冲突** ——
 * 正是本项目反复吃亏的那类自相矛盾指令（一如「真人写实」撞上水墨风格）。
 * 换成多镜形态后，「禁止复刻参考图宫格/分屏」这个**原意**（防的是把参考拼图搬进成片）
 * 仍然保留，只是不再禁止镜内剪辑。
 */
const LINE3_MULTI = '环境、光影与陈设定性参考 <Picture 1>。若 <Picture 1> 为宫格或多画面拼图，禁止成片复刻其分格或并列布局，仅提取统一的空间、光线与氛围语义；本条为一次生成内的连续多镜头剪辑，允许镜内切镜（见 [Shot N] 剪辑点），但禁止成片宫格、分屏与多画面并列。';

/** 多镜形态：本镜没有场景参考图时（scene_id 为空） */
const LINE3_NO_SCENE_MULTI = '本片段以首张参考图 <Picture 1> 作为画面锚点展开；本条为一次生成内的连续多镜头剪辑，允许镜内切镜（见 [Shot N] 剪辑点），但禁止成片宫格与分屏。';

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
  // 参考图标签的三种等价写法都要认：@图片N（我们旧版）、参考图N（MiniMax 官方 r2va 用词）、
  // <Picture N>（Ref2VA 官方六段结构）—— 比对前统一归一成 @图片N，否则正确的第3行会被误判。
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
/**
 * 运镜词表：分镜的 `movement` 字段（如「环绕orbit」）必须体现在 ust 正文里。
 *
 * 实测（drama7 ep21，13 镜）：只有 4 镜提到运镜，而且是从 action 文本里碰巧漏进来的；
 * movement 有值的 9 镜（推镜/跟镜/升镜/甩镜/拉镜）**一条都没写** ——
 * 等于完全没给视频模型运镜信息，成片自然全是固定机位。
 */
/**
 * 运镜词表：分镜的 `movement` 字段（如「环绕orbit」）必须体现在 **§5 正文** 里。
 *
 * 实测（drama7 ep21，13 镜）：只有 4 镜提到运镜，而且是从 action 文本里碰巧漏进来的；
 * movement 有值的 9 镜（推镜/跟镜/升镜/甩镜/拉镜）**一条都没写** ——
 * 等于完全没给视频模型运镜信息，成片自然全是固定机位。
 *
 * 判定要求"镜头上下文"：中文单字（推/拉/跟/升/甩）在正文里到处都是
 *（推开、拉住、跟着、升起），只靠单字命中会把"没写运镜"误判成"写了"
 * —— 第一版就是这样，13 镜里明明 9 镜缺失却报 0。
 */
const MOVEMENT_PATTERNS = [
  [/push|推进|推镜|前推|dolly_track|dolly in/i,
   /(镜头|画面|机位|摄影机)[^。；\n]{0,12}(前?推|推进)|\b(push(?:es|ing)? (?:in|forward|toward)|dolly[- ]?(?:in|forward)|dollies? (?:in|forward)|trucks? (?:in|forward))\b/i],
  [/pull|拉远|拉镜|后拉|dolly out/i,
   /(镜头|画面|机位|摄影机)[^。；\n]{0,12}(后?拉|拉远)|\b(pull(?:s|ing)? (?:back(?:ward)?|out|away)|dolly[- ]?(?:out|back)|dollies? (?:out|back)|withdraw(?:s|ing)?)\b/i],
  [/orbit|环绕|盘旋|slowmo_orbit/i,
   /(镜头|画面|机位|摄影机)[^。；\n]{0,14}(环绕|盘旋|绕[^。；\n]{0,6}一圈)|\b(orbit(?:s|ing)?|circl(?:e|es|ing)|arc(?:s|ing)?|swirl(?:s|ing)?)\b/i],
  [/track|跟拍|跟镜|dolly_track/i,
   /(镜头|画面|机位|摄影机)[^。；\n]{0,12}(跟拍|跟镜|跟随)|\b(track(?:s|ing)?|lateral track|tracking shot|follow(?:s|ing)?|dolly[- ]?(?:in|out)? and (?:a )?(?:lateral )?track)\b/i],
  [/crane|升镜|升起/i,
   /(镜头|画面|机位|摄影机)[^。；\n]{0,12}(升起|上升|升降)|\b(crane(?:s|ing)?|ris(?:e|es|ing)|lift(?:s|ing)?)\b/i],
  [/whip|甩镜|甩/i, /(镜头|画面|机位)[^。；\n]{0,10}甩|\bwhip pan\b/i],
  [/pan|摇镜|横摇|平移/i,
   /(镜头|画面|机位|摄影机)[^。；\n]{0,12}(横摇|摇镜|平移|摇过)|\b(pan(?:s|ning)?|swivel(?:s|ing)?|glid(?:e|es|ing))\b/i],
  [/tilt|俯仰|上下/i, /(镜头|画面|机位)[^。；\n]{0,12}(上摇|下摇|俯仰)|\btilt(?:s|ing)? (?:up|down)\b/i],
  [/zoom|变焦/i, /(镜头|画面)[^。；\n]{0,10}变焦|\bzoom(?:s|ing)?\b/i],
  [/handheld|手持/i, /手持|\bhand-?held\b/i],
  [/static|固定|定机位/i, /(固定机位|机位固定|定机位|静止镜头)|\b(static shot|locked-?off|fixed frame|holds? steady)\b/i],
];

/**
 * movement 字段的语义是否出现在 **§5 正文** 里。
 * 只看 §5：那才是视频模型读的正文；写在 summary/retention 里对成片没有约束力。
 */
function movementMentioned(text, movement) {
  const mv = String(movement || '').trim();
  if (!mv) return true;                                   // 没写运镜字段就不检查
  const body = analysisTextOf(String(text || ''));        // Ref2VA → 只取 detailed_description
  if (!body || !body.trim()) return false;
  for (const [trigger, re] of MOVEMENT_PATTERNS) {
    if (!trigger.test(mv)) continue;
    return re.test(body);
  }
  return true;                                            // 词表认不出的运镜词不误报
}

/**
 * 镜内时间推进（"第几秒"）是否写出来了。
 *
 * 实测 drama7 ep21：13 镜全为单镜单拍、0 个时间戳，正文里没有任何
 * 「起幅→过程→落幅」的时间推进 —— 视频模型拿不到"什么时候该动镜头"的信息。
 * 只对**长镜（≥8 秒）**要求：短镜一句话就演完了，不写时间推进是正常的。
 */
const TIMELINE_RE = /(前[一二三四五六七八九十\d]+秒|第[一二三四五六七八九十\d]+秒|\d\d:\d\d|起幅|落幅|\bin the first\b|\bfrom the (?:[\w]+|\d+(?:\.\d+)?) second\b|\bby the end\b|\bhalfway\b|\bseconds? (?:in|later)\b|\bat 0?\d)/i;

function hasTimelineCue(text) {
  const body = analysisTextOf(String(text || ''));
  if (!body) return false;
  const cuts = parseCutMarkers(body).length;
  // 注意：parseCutMarkers 把 [Shot 1] 也算一个，所以"有镜内剪辑点"必须是 >= 2（[Shot 2] 起才是真切点）；
  // 初版写成 >= 1，导致每一镜都判定为"有时间结构"，13 镜缺时间推进却报 0。
  if (cuts >= 2) return true;
  return TIMELINE_RE.test(body);
}

/**
 * 剧情完整性：本集所有镜的 duration 之和 vs 剧本按 4.2 字/秒朗读所需秒数。
 *
 * 来自「字字动画」的分镜规范（其漫画分镜第 15 条）：**情节和对白完整性优先** ——
 * 格数/时长不够时要增加分镜，而不是省略剧情。
 * 实测 drama7 ep21：13 镜合计 152 秒，而剧本 857 字 ≈ 204 秒朗读时长，提示剧情被压缩。
 */
const CHARS_PER_SECOND = 4.2;

function summarizeDurationCoverage(storyboards, scriptContent) {
  const rows = (Array.isArray(storyboards) ? storyboards : []).filter((r) => r && r.creation_mode === 'universal');
  const totalSec = rows.reduce((a, r) => a + (Number(r.duration) || 0), 0);
  const chars = String(scriptContent || '').replace(/\s+/g, '').length;
  if (!chars || !rows.length) return { script_seconds: 0, shots_seconds: totalSec, ratio: null, short_by: 0 };
  const scriptSec = Math.round(chars / CHARS_PER_SECOND);
  return {
    script_seconds: scriptSec,
    shots_seconds: totalSec,
    ratio: Number((totalSec / scriptSec).toFixed(2)),
    short_by: Math.max(0, scriptSec - totalSec),
  };
}

function summarizeUniversalSegmentFormat(storyboards, opts = {}) {
  const rows = (Array.isArray(storyboards) ? storyboards : []).filter(
    (r) => r && r.creation_mode === 'universal'
  );
  const samples = [];
  let multiShot = 0;
  let cutTotal = 0;
  /** 运镜缺失：movement 字段有值但正文完全没写运镜 */
  const movementMissing = [];
  /** 长镜缺时间推进："第几秒 / 起幅→落幅"完全没写 */
  const timelineMissing = [];
  // 打斗节奏自检（见 checkFightPacing）：只报**真的坏了**的 —— 定场挤压。
  // 初版规则「打斗镜没切拍就报警」在 drama4 上产生 8 条假警、0 条真问题，已废弃。
  let pacing = { fights: 0, cut: 0, split_sequence: 0, single_beat: 0, tail_crushed: [], cuts_without_fight: [] };
  // 只有一种格式：Ref2VA 官方六段结构（旧四行块格式已废弃）
  const { validateRef2va } = require('./ref2vaFormat');
  for (const r of rows) {
    const raw = String(r.universal_segment_text || '');
    const v = validateRef2va(raw, { durationSec: Number(r.duration) || undefined });
    if (!v.ok) samples.push({ id: r.id ?? null, title: r.title || '', problems: v.problems });
    const cuts = parseCutMarkers(analysisTextOf(raw)).length;
    if (cuts >= 2) multiShot += 1;
    cutTotal += cuts;
    if (!movementMentioned(raw, r.movement)) {
      movementMissing.push({ id: r.id ?? null, n: r.storyboard_number ?? null, movement: String(r.movement || '') });
    }
    if ((Number(r.duration) || 0) >= 8 && !hasTimelineCue(raw)) {
      timelineMissing.push({ id: r.id ?? null, n: r.storyboard_number ?? null, duration: Number(r.duration) || 0 });
    }
  }
  try {
    pacing = checkFightPacing(rows);
  } catch (_) { /* 自检失败不影响格式复核 */ }
  return {
    checked: rows.length,
    noncompliant: samples.length,
    samples: samples.slice(0, 5),
    multi_shot: multiShot,
    cut_total: cutTotal,
    // 运镜缺失（真问题）：movement 字段被整段忽略 —— 成片会变成基本不动的固定机位
    duration_coverage: summarizeDurationCoverage(rows, opts.scriptContent),
    movement_missing: movementMissing.length,
    movement_missing_sample: movementMissing.slice(0, 5),
    // 长镜缺时间推进（"第几秒"）：模型不知道什么时候该动镜头，容易变成全程固定机位
    timeline_missing: timelineMissing.length,
    timeline_missing_sample: timelineMissing.slice(0, 5),
    // 打斗统计：fights 全部打斗镜 / cut 已切拍 / split_sequence 已被分镜层面拆成连续镜 /
    // single_beat 短交锋单镜正确 / tail_crushed **定场挤压（真问题）**
    fight_total: pacing.fights,
    fight_cut: pacing.cut,
    fight_split_sequence: pacing.split_sequence,
    fight_single_beat: pacing.single_beat,
    fights_without_cuts: pacing.tail_crushed.length,
    fights_without_cuts_samples: pacing.tail_crushed.slice(0, 5),
    cuts_without_fight: pacing.cuts_without_fight.length,
    cuts_without_fight_samples: pacing.cuts_without_fight.slice(0, 5),
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
  firstCombatRatio,
  FIGHT_TAIL_CRUSH_RATIO,
  FIGHT_TAIL_CRUSH_MIN_SECONDS,
  checkFightPacing,
  parseCutMarkers,
  checkCutMarkers,
  parseBeatDurationSec,
  formatCutMarker,
  secToCutTime,
  cutTimeToSec,
  normalizeUniversalSegmentTextNewlines,
  analysisTextOf,
  chooseBeatCount,
  splitDurationSeconds,
  buildFallbackUniversalMultiBeatText,
  validateUniversalSegmentText,
  repairUniversalSegmentText,
  summarizeUniversalSegmentFormat,
};
