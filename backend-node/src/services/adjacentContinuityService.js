'use strict';

/**
 * 相邻分镜「连续性」判定 + 提交视频前自动尾帧锚定（半自动尾帧衔接）。
 *
 * 为什么需要这个：
 *   本地 MiniMax H3（协议 comfyui，工作流 A03 Ref2VA）单镜最长 362 帧 = 15.08s，
 *   一段连续动作必然被时长限制切成多个分镜。要让它们接得上，就得把**上一镜的末帧**
 *   当成**下一镜的首帧**（MiniMaxH3AddGuide @frame_idx=0）。此前只有「尾帧衔接」按钮
 *   能这么做（services/tailFrameLinkService），65 镜的剧集就是 64 次人肉点击；漏点一次
 *   在成片里就是一个跳变，而发现它要等到整集渲染完（本地 H3 对 65 镜是八小时级）。
 *
 * 为什么不能「一律接上」：
 *   相邻两镜并不都是同一镜头的延续。剪辑点（换机位/换景别/换主体/换时间）如果也把上一镜
 *   末帧钉成本镜首帧，就等于用上一镜的画面**强行指定本镜起幅** —— 该切的地方被锁死，
 *   而且模型会顺着那张图把上一镜的构图/景别延续下去，剪辑节奏整个消失。
 *   所以必须先判定「这一对是承接还是剪辑点」，只给承接镜锚定。
 *
 * 判定分两层，先硬后软：
 *   硬条件（确定性、不花模型调用）：编号紧邻 + 同 location + 同 segment_index。
 *     不满足直接判 0。这三条是「同一个场景段落里紧挨着的两镜」的必要条件，
 *     用它们先砍掉大部分对，模型只看剩下的，省钱也省时间。
 *   语义判定（一次 LLM 调用）：同一地点的两镜仍可能是一次剪辑（正反打、切近景、时间跳跃），
 *     这类只能靠读 title/action/result/movement/shot_type 判 —— 规则式判定在这里一定会误报
 *     （参考 utils/beatCoverageCheck 顶部记录的关键词误判教训）。
 *     模型答 unsure 时**按 0 处理**：宁可少接（成片里最多是一个正常的剪辑），
 *     也不要错接（成片里是本镜起幅被上一镜锁死 + 剪辑节奏丢失）。
 *
 * 结果落 storyboards.link_prev_tail：1 = 承接（自动锚定候选）、0 = 剪辑点、NULL = 未判定。
 * 已判定（0 或 1）的对**不会**被后续重跑覆盖 —— 那样人工翻转的结论才留得住。
 */

const aiClient = require('./aiClient');
const { safeParseAIJSON, extractJsonCandidate } = require('../utils/safeJson');
const { extractVideoTailFrame } = require('./tailFrameLinkService');

/** 一次判定最多塞多少对（本地剧集 65 镜 = 64 对，正常都在上限内） */
const MAX_PAIRS_PER_PROMPT = 120;
/** 每段正文截断长度：判定「是否同一镜头延续」不需要全文 */
const FIELD_EXCERPT_CHARS = 200;

const SYSTEM_PROMPT = [
  'You are a film editor judging CUT vs CONTINUATION between consecutive shots of a short drama.',
  '',
  'You receive ADJACENT PAIRS of shots. For each pair, the PREV shot was rendered first,',
  'then the CUR shot is rendered as a separate generation. Because a single generation is',
  'limited in length (about 15 seconds), one continuous camera take is often split into',
  'several consecutive shots. Your job: decide, for each pair, whether CUR continues the exact',
  'same moment of the same take, or whether it is an edit.',
  '',
  'Verdicts:',
  '  "continues" = CUR picks up the very frame where PREV ended: same camera take, same',
  '                framing family, same location, action flowing on without a jump',
  '                (the take was merely cut by the length limit).',
  '  "cut"       = an edit: camera angle / shot size / subject / time / place changes,',
  '                or the story jumps to another moment.',
  '  "unsure"    = you cannot tell from the given text.',
  '',
  'Rules:',
  '1. Judge from the text: titles, actions, results, camera movement and shot type.',
  '2. A fight or a continuous dialogue exchange split across shots with the SAME subject and',
  '   SAME camera setup is normally "continues"; a reverse shot (over-the-shoulder A then B)',
  '   IS an edit -> "cut".',
  '3. Same location alone is NOT enough — a new angle at the same place is still "cut".',
  '4. When the text is too thin to justify "continues", answer "unsure" (it will be treated',
  '   as a cut; a wrong join is worse than a missing join).',
  '5. Output ONLY valid JSON, no markdown fences, no commentary.',
  '',
  'Output schema:',
  '{"pairs":[{"i":1,"verdict":"continues","reason":"..."}, ...]}',
  'Every input pair must appear exactly once, with its own "i" copied from the input.',
].join('\n');

function str(v) {
  return v == null ? '' : String(v).trim();
}

function excerpt(v, n = FIELD_EXCERPT_CHARS) {
  return str(v).replace(/\s+/g, ' ').slice(0, n);
}

/**
 * 硬条件：不满足的对直接判 0，不给模型看。
 * @returns {{ok:boolean, reason:string}} reason 用于日志/解释（只在 ok=false 时有意义）
 */
function hardGate(prev, cur) {
  if (!prev || !cur) return { ok: false, reason: 'missing_row' };

  const pn = Number(prev.storyboard_number);
  const cn = Number(cur.storyboard_number);
  if (!Number.isFinite(pn) || !Number.isFinite(cn)) return { ok: false, reason: 'number_unknown' };
  if (cn !== pn + 1) return { ok: false, reason: 'number_not_adjacent' };

  // location 一律 trim 后比较：模型写「荒山野岭」和「荒山野岭 」是同一个地方。
  // 两边都为空（模型没填地点）时算「相等」放行，交给后面的语义判定 —— 那时模型能看到
  // title/action，比用一条「字段为空就判剪辑点」的规则硬砍要准（否则整集都是 0）。
  if (str(prev.location) !== str(cur.location)) return { ok: false, reason: 'location_changed' };

  const ps = Number(prev.segment_index ?? 0) || 0;
  const cs = Number(cur.segment_index ?? 0) || 0;
  if (ps !== cs) return { ok: false, reason: 'segment_changed' };

  return { ok: true, reason: '' };
}

/**
 * 按 storyboard_number 排序后取每一对相邻镜。
 * @returns {Array<{index:number, prev:object, cur:object}>} index 从 1 开始（给模型的编号）
 */
function buildAdjacentPairs(rows) {
  const list = (Array.isArray(rows) ? rows : [])
    .filter(Boolean)
    .slice()
    .sort((a, b) => {
      const d = (Number(a.storyboard_number) || 0) - (Number(b.storyboard_number) || 0);
      return d !== 0 ? d : (Number(a.id) || 0) - (Number(b.id) || 0);
    });
  const pairs = [];
  for (let i = 1; i < list.length; i++) {
    pairs.push({ index: pairs.length + 1, prev: list[i - 1], cur: list[i] });
  }
  return pairs;
}

/** 把待判定的对压成提示词正文（上一镜给 title/action/result/movement/shot_type，本镜给 title/action/movement/shot_type） */
function formatPairsForPrompt(pairs) {
  return (Array.isArray(pairs) ? pairs : [])
    .slice(0, MAX_PAIRS_PER_PROMPT)
    .map((p) => {
      const a = p.prev || {};
      const b = p.cur || {};
      return [
        `[Pair ${p.index}] location: ${str(a.location) || '(unknown)'}`,
        `  PREV  #${a.storyboard_number ?? '?'} title: ${excerpt(a.title, 120) || '(none)'}`,
        `        action: ${excerpt(a.action) || '(none)'}`,
        `        result: ${excerpt(a.result) || '(none)'}`,
        `        movement: ${excerpt(a.movement, 80) || '(none)'} | shot_type: ${excerpt(a.shot_type, 80) || '(none)'}`,
        `  CUR   #${b.storyboard_number ?? '?'} title: ${excerpt(b.title, 120) || '(none)'}`,
        `        action: ${excerpt(b.action) || '(none)'}`,
        `        movement: ${excerpt(b.movement, 80) || '(none)'} | shot_type: ${excerpt(b.shot_type, 80) || '(none)'}`,
      ].join('\n');
    })
    .join('\n');
}

/** 从各种可能的返回形状里取出条目数组（模型/中转可能包一层） */
function extractVerdictItems(parsed) {
  if (!parsed) return [];
  if (Array.isArray(parsed)) return parsed;
  for (const key of ['pairs', 'results', 'verdicts', 'items', '判定', '结果']) {
    if (Array.isArray(parsed[key])) return parsed[key];
  }
  return [];
}

/** 单条判定归一化成 continues | cut | unsure（未知一律 unsure → 后面按 0 处理） */
function normalizeVerdict(item) {
  if (item && typeof item === 'object') {
    // 布尔式写法也认（continues: true/false）
    if (item.continues === true) return 'continues';
    if (item.continues === false) return 'cut';
    const v = str(item.verdict || item.result || item.judgement || item.判定 || item.结论).toLowerCase();
    if (v === 'continues' || v === 'continue' || v === 'same' || v === '承接') return 'continues';
    if (v === 'cut' || v === 'edit' || v === '剪辑' || v === '剪辑点') return 'cut';
    return 'unsure';
  }
  const v = str(item).toLowerCase();
  if (v === 'continues' || v === 'continue' || v === '承接') return 'continues';
  if (v === 'cut' || v === 'edit' || v === '剪辑') return 'cut';
  return 'unsure';
}

/**
 * 把模型的判定套回各对（纯函数，测试不碰网络）。
 *
 * 为什么按 "i" 对齐而不是纯按位置：模型漏答/多答一条时，纯按位置会**整体错位** ——
 * 第 7 对漏答会把后面每一对的结论都挪到前一对上，于是「承接/剪辑点」全部张冠李戴，
 * 而且看起来毫无异常。按 i 取、取不到就按 0（剪辑点）处理，错位不会传播。
 *
 * @param {Array<{index:number, prev:object, cur:object}>} pairs
 * @param {object|Array|null} verdictsJson 模型返回并解析后的 JSON
 * @returns {Array<{storyboard_id:number, prev_storyboard_id:number, link_prev_tail:0|1, verdict:string, reason:string}>}
 */
function applyVerdicts(pairs, verdictsJson) {
  const list = Array.isArray(pairs) ? pairs : [];
  const items = extractVerdictItems(verdictsJson);
  const byIndex = new Map();
  items.forEach((item, pos) => {
    const raw = item && typeof item === 'object' ? (item.i ?? item.index ?? item.pair ?? item.id) : null;
    const n = Number(raw);
    const key = Number.isFinite(n) && n > 0 ? n : pos + 1;
    if (!byIndex.has(key)) byIndex.set(key, item);
  });

  return list.map((p) => {
    const item = byIndex.get(p.index);
    const verdict = item === undefined ? 'unsure' : normalizeVerdict(item);
    return {
      storyboard_id: p.cur ? p.cur.id : null,
      prev_storyboard_id: p.prev ? p.prev.id : null,
      // 只有明确的 continues 才锚定；cut / unsure / 缺答 一律 0（保守）
      link_prev_tail: verdict === 'continues' ? 1 : 0,
      verdict,
      reason: item && typeof item === 'object' ? excerpt(item.reason || item.理由, 120) : '',
    };
  });
}

/**
 * 项目开关 dramas.metadata.auto_tail_frame_link：**默认开**。
 * 读不到（无 metadata / 字段缺失 / 解析失败）一律当 true —— 这是本功能的主用途，
 * 默认关会让绝大多数项目「判定做完了却什么都没发生」，用户只会觉得功能坏了。
 * 显式写 false 才关。
 */
function resolveAutoTailLinkSwitch(metadata) {
  let meta = metadata;
  if (typeof meta === 'string') {
    try {
      meta = JSON.parse(meta);
    } catch (_) {
      return true; // 解析失败当默认开
    }
  }
  if (!meta || typeof meta !== 'object') return true;
  const v = meta.auto_tail_frame_link;
  if (v === undefined || v === null) return true;
  if (typeof v === 'string') return !['false', '0', 'off', 'no'].includes(v.trim().toLowerCase());
  return !!v;
}

/** 该分镜是否已经绑定首帧（绑定过就不自动锚定，用户的选择优先） */
function hasBoundFirstFrame(cur) {
  if (!cur) return false;
  if (cur.first_frame_image_id != null && cur.first_frame_image_id !== '') return true;
  // 这两列目前不在 schema 里（首帧绑定以 first_frame_image_id 为准，见 storyboardFrameBinding），
  // 但前端会读 sb.first_frame_image_url/local_path，这里一并兼容，避免以后加列时漏判。
  if (str(cur.first_frame_image_url)) return true;
  if (str(cur.first_frame_local_path)) return true;
  // 本次提交已经带了首帧（前端「尾帧衔接」/连贯帧/首尾帧模式算出来的）
  if (str(cur.first_frame_url)) return true;
  return false;
}

/**
 * 上一镜的视频里，哪个路径能用来抽末帧。
 * 只认本地路径：ffmpeg 抽帧要读文件，而 http 视频要先下载 —— 下载会给「自动锚定」
 * 引入一个新的失败面（网络/鉴权/大小），而本地 H3 这条路本来就会落 local_path。
 * 拿不到本地路径就静默跳过（当成剪辑点渲染），不让整个视频生成失败。
 */
function pickTailFrameVideoPath(video) {
  if (!video) return null;
  const local = str(video.local_path);
  if (local) return local;
  const url = str(video.video_url);
  // 非 http 的 video_url（/static/... 或 storage 相对路径）仍指向本地文件
  if (url && !/^https?:\/\//i.test(url)) return url.replace(/^\/+/, '');
  return null;
}

/**
 * 是否该给本镜自动锚定上一镜末帧（纯判定，不碰库/不抽帧 —— 便于单测）。
 *
 * 四条同时成立才做：
 *   ① 项目开关开（默认开）
 *   ② 本镜 link_prev_tail === 1（判定为承接）
 *   ③ 本镜还没绑定首帧
 *   ④ 上一镜（storyboard_number - 1）存在，且有能抽帧的本地视频
 *
 * @returns {{ok:true, source:string, reason:string} | {ok:false, reason:string}}
 */
function shouldAutoAnchorPrevTail({ cur, prev, prevVideo, enabled } = {}) {
  if (!enabled) return { ok: false, reason: 'switch_off' };
  if (!cur) return { ok: false, reason: 'no_current_storyboard' };
  if (Number(cur.link_prev_tail) !== 1) return { ok: false, reason: 'not_continues' };
  if (hasBoundFirstFrame(cur)) return { ok: false, reason: 'first_frame_bound' };
  if (!prev) return { ok: false, reason: 'no_prev_storyboard' };

  const pn = Number(prev.storyboard_number);
  const cn = Number(cur.storyboard_number);
  if (!Number.isFinite(pn) || !Number.isFinite(cn) || pn !== cn - 1) {
    return { ok: false, reason: 'prev_not_adjacent' };
  }

  const source = pickTailFrameVideoPath(prevVideo);
  if (!source) return { ok: false, reason: 'prev_video_missing' };
  return { ok: true, source, reason: '' };
}

/** 读项目开关（DB 包装） */
function isAutoTailFrameLinkEnabled(db, dramaId) {
  try {
    const row = db.prepare('SELECT metadata FROM dramas WHERE id = ? AND deleted_at IS NULL').get(Number(dramaId));
    return resolveAutoTailLinkSwitch(row && row.metadata);
  } catch (_) {
    return true;
  }
}

/**
 * 找上一镜及其可用视频：优先 storyboards 上已落库的视频（finalizeSuccessfulVideo 会同步写回），
 * 再退回 video_generations 里最新的 completed 记录。
 * 为什么两处都查：重渲过/手动上传过的分镜，storyboards 与 video_generations 未必同源。
 */
function findPrevStoryboardVideo(db, cur) {
  const cn = Number(cur && cur.storyboard_number);
  if (!Number.isFinite(cn)) return { prev: null, prevVideo: null };
  const prev = db.prepare(
    `SELECT id, storyboard_number, video_url, local_path FROM storyboards
     WHERE episode_id = ? AND storyboard_number = ? AND deleted_at IS NULL
     ORDER BY id ASC LIMIT 1`
  ).get(cur.episode_id, cn - 1);
  if (!prev) return { prev: null, prevVideo: null };

  let prevVideo = { local_path: prev.local_path, video_url: prev.video_url };
  if (!pickTailFrameVideoPath(prevVideo)) {
    const gen = db.prepare(
      `SELECT local_path, video_url FROM video_generations
       WHERE storyboard_id = ? AND status = 'completed' AND deleted_at IS NULL
       ORDER BY created_at DESC LIMIT 1`
    ).get(prev.id);
    if (gen) prevVideo = { local_path: gen.local_path, video_url: gen.video_url };
  }
  return { prev, prevVideo };
}

/**
 * 判定一集里所有相邻镜的连续性，写回 link_prev_tail。
 *
 * 已判定（0/1）的对默认跳过：这套判定会在「生成分镜自检」和「手动重算质量报告」里被反复调到，
 * 每次都重判不仅白花模型调用，还会把用户人工翻转的结论冲掉。opts.force = true 才全部重判。
 *
 * **绝不抛错**：它是出片链路上的附加工序，判定失败只记 warn，全部按剪辑点（0）处理。
 *
 * @returns {Promise<{pairs:number, hard_failed:number, judged:number, continues:number,
 *                    cut:number, llm_failed:boolean, skipped:number, verdicts:Map<number, 0|1>}>}
 */
async function classifyEpisodeContinuity(db, log, episodeId, opts = {}) {
  const ai = opts.aiClient || aiClient;
  const force = opts.force === true;
  const summary = {
    pairs: 0, hard_failed: 0, judged: 0, continues: 0, cut: 0,
    llm_failed: false, skipped: 0, verdicts: new Map(),
  };

  try {
    const rows = db.prepare(
      `SELECT id, storyboard_number, location, segment_index, title, action, result, movement, shot_type, link_prev_tail
       FROM storyboards WHERE episode_id = ? AND deleted_at IS NULL
       ORDER BY storyboard_number ASC, id ASC`
    ).all(Number(episodeId));
    if (rows.length < 2) return summary;

    const pairs = buildAdjacentPairs(rows);
    summary.pairs = pairs.length;

    const updates = [];   // { storyboard_id, link_prev_tail }
    const gated = [];     // 通过硬条件、要交给模型的对
    let hardFailed = 0;   // 被硬条件直接判 0 的对数（日志/统计用）
    for (const p of pairs) {
      if (!force && p.cur.link_prev_tail != null) {
        // 已判定过：保留原值（含人工翻转）
        summary.skipped++;
        summary.verdicts.set(p.cur.id, Number(p.cur.link_prev_tail) === 1 ? 1 : 0);
        continue;
      }
      const gate = hardGate(p.prev, p.cur);
      if (!gate.ok) {
        updates.push({ storyboard_id: p.cur.id, link_prev_tail: 0, via: gate.reason });
        hardFailed++;
      } else {
        gated.push(p);
      }
    }

    if (gated.length > 0) {
      if (gated.length > MAX_PAIRS_PER_PROMPT) {
        // 超上限的对不会进提示词 → 解析回来缺答 → 按剪辑点（0）落库。明确告警，
        // 不要让「一次调用的上限」变成静默的判定缺失。
        log.warn('[尾帧衔接] 待判定对数超过单次上限，超出部分按剪辑点处理', {
          episode_id: Number(episodeId), pairs: gated.length, cap: MAX_PAIRS_PER_PROMPT,
        });
      }
      const userPrompt = [
        '=== ADJACENT SHOT PAIRS ===',
        formatPairsForPrompt(gated),
        '',
        '=== TASK ===',
        'For every pair, decide "continues" or "cut" (use "unsure" if the text is not enough).',
        'Output ONLY the JSON object described in the system prompt, one entry per pair.',
      ].join('\n');

      let parsed = null;
      try {
        const raw = await ai.generateText(db, log, 'text', userPrompt, SYSTEM_PROMPT, {
          temperature: 0.1,
          min_max_tokens: 4096,
          // scene_key 走 ai_model_map 的路由；没配这个 key 时 getConfigFromModelMap 返回 null，
          // 自动退回默认文本模型 —— 所以这里用新 key 不会让没配过的项目失败。
          scene_key: 'beat_check',
        });
        const text = str(raw);
        if (text) {
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
        }
        if (!parsed) {
          summary.llm_failed = true;
          log.warn('[尾帧衔接] 相邻连续性判定结果无法解析，全部按剪辑点处理（不影响出片）', {
            episode_id: Number(episodeId), pairs: gated.length, preview: text.slice(0, 160),
          });
        }
      } catch (e) {
        summary.llm_failed = true;
        log.warn('[尾帧衔接] 相邻连续性判定调用失败，全部按剪辑点处理（不影响出片）', {
          episode_id: Number(episodeId), pairs: gated.length, error: e.message,
        });
      }

      const applied = summary.llm_failed ? null : applyVerdicts(gated, parsed);
      if (applied) {
        for (const a of applied) {
          if (a.storyboard_id == null) continue;
          updates.push({ storyboard_id: a.storyboard_id, link_prev_tail: a.link_prev_tail, via: a.verdict });
          summary.judged++;
          if (a.link_prev_tail === 1) summary.continues++; else summary.cut++;
        }
      } else {
        // 调不通/解析不了：整批按剪辑点（0）落库。宁可写成「不接」，也不要留一堆 NULL ——
        // NULL 会让界面一直显示「未判定」，而重跑又会再花一次模型调用。
        for (const p of gated) {
          if (p.cur.id == null) continue;
          updates.push({ storyboard_id: p.cur.id, link_prev_tail: 0, via: 'llm_failed' });
        }
      }
    }

    if (updates.length > 0) {
      const now = new Date().toISOString();
      const stmt = db.prepare('UPDATE storyboards SET link_prev_tail = ?, updated_at = ? WHERE id = ?');
      for (const u of updates) {
        stmt.run(u.link_prev_tail, now, u.storyboard_id);
        summary.verdicts.set(u.storyboard_id, u.link_prev_tail);
      }
    }
    summary.hard_failed = hardFailed;

    // 汇总日志：几对、几对 continues、几对 cut（硬条件砍掉的和模型判不出的都算 0）
    log.info('[尾帧衔接] 相邻镜连续性判定完成', {
      episode_id: Number(episodeId),
      pairs: summary.pairs,
      hard_failed: summary.hard_failed,
      judged: summary.judged,
      continues: summary.continues,
      cut: summary.cut,
      skipped_already_judged: summary.skipped,
      llm_failed: summary.llm_failed,
    });
    return summary;
  } catch (e) {
    log.warn('[尾帧衔接] 相邻连续性判定失败（不影响出片）', {
      episode_id: Number(episodeId), error: e.message,
    });
    return summary;
  }
}

/**
 * 提交视频前的自动锚定：抽上一镜末帧，返回可直接交给视频接口的 first_frame_url。
 *
 * 只返回路径、**不改库**：
 *   · 不写 storyboards.first_frame_image_id —— 那会让「已绑定首帧」成立，把这一镜从此
 *     钉死在这个首帧上（重渲也换不掉），而自动锚定本来就该在每次渲染前重新抽
 *     （用户可能已经重渲过上一镜，末帧变了）。
 *   · 不做级联：重渲镜 N 绝不自动重渲镜 N+1（那会让一次点击变成连锁渲染）。
 *
 * 任何不满足/抽帧失败都返回 null 并记 warn —— 调用方拿不到就走原来的无首帧路径，
 * 绝不能因为「加了个自动锚定」把视频生成弄失败。
 *
 * @param {object} db
 * @param {object} log
 * @param {{storyboardId:number, submittedFirstFrameUrl?:string}} opts
 * @returns {string|null} 抽出的末帧**绝对路径**（comfyuiClient.prepareReferenceImages 认绝对路径，
 *                        不需要配置 base_url，比走 URL 少一个失败点）
 */
function maybeAutoAnchorPrevTailFrame(db, log, opts = {}) {
  const sbId = Number(opts.storyboardId);
  if (!Number.isFinite(sbId) || sbId <= 0) return null;
  try {
    const cur = db.prepare(
      `SELECT s.id, s.episode_id, s.storyboard_number, s.first_frame_image_id, s.link_prev_tail,
              e.drama_id
       FROM storyboards s
       JOIN episodes e ON e.id = s.episode_id AND e.deleted_at IS NULL
       WHERE s.id = ? AND s.deleted_at IS NULL`
    ).get(sbId);
    if (!cur) return null;
    // 快速短路：不是承接镜就什么都不做（连 dramas 都不查）
    if (Number(cur.link_prev_tail) !== 1) return null;

    const enabled = isAutoTailFrameLinkEnabled(db, cur.drama_id);
    const { prev, prevVideo } = findPrevStoryboardVideo(db, cur);
    const decision = shouldAutoAnchorPrevTail({
      cur: { ...cur, first_frame_url: opts.submittedFirstFrameUrl },
      prev,
      prevVideo,
      enabled,
    });
    if (!decision.ok) {
      log.info('[尾帧衔接] 本镜不自动锚定上一镜末帧', {
        storyboard_id: sbId, storyboard_number: cur.storyboard_number, reason: decision.reason,
      });
      return null;
    }

    const cfg = require('../config').loadConfig();
    const outputFileName = `tailframe_auto_${prev.id}_to_${cur.id}_${Date.now()}.jpg`;
    const extracted = extractVideoTailFrame(cfg, log, { videoPath: decision.source, outputFileName });
    if (!extracted.ok) {
      log.warn('[尾帧衔接] 自动抽上一镜末帧失败，本镜按无首帧渲染（不影响出片）', {
        storyboard_id: sbId, prev_storyboard_id: prev.id, error: extracted.error,
      });
      return null;
    }

    log.info('[尾帧衔接] 已自动把上一镜末帧接为本镜首帧', {
      storyboard_id: sbId,
      storyboard_number: cur.storyboard_number,
      prev_storyboard_id: prev.id,
      source_video: decision.source,
      output: extracted.outputRelPath,
      width: extracted.width,
      height: extracted.height,
    });
    return extracted.outputAbsPath;
  } catch (e) {
    log.warn('[尾帧衔接] 自动锚定异常，本镜按无首帧渲染（不影响出片）', {
      storyboard_id: sbId, error: e.message,
    });
    return null;
  }
}

module.exports = {
  // 纯函数（单测直接调，不需要网络/数据库）
  hardGate,
  buildAdjacentPairs,
  formatPairsForPrompt,
  applyVerdicts,
  normalizeVerdict,
  resolveAutoTailLinkSwitch,
  hasBoundFirstFrame,
  pickTailFrameVideoPath,
  shouldAutoAnchorPrevTail,
  // 需要 db / 模型
  classifyEpisodeContinuity,
  isAutoTailFrameLinkEnabled,
  findPrevStoryboardVideo,
  maybeAutoAnchorPrevTailFrame,
  // 常量
  SYSTEM_PROMPT,
  MAX_PAIRS_PER_PROMPT,
};
