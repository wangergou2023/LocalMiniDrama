// 与 Go StoryboardService.GenerateStoryboard + processStoryboardGeneration 对齐
const taskService = require('./taskService');
const aiClient = require('./aiClient');
const promptI18n = require('./promptI18n');
const { syncStoryboardCharacters } = require('./imageService');
const safeJson = require('../utils/safeJson');
const { safeParseAIJSON, extractJsonCandidate, repairTruncatedJsonArray, extractFirstArray } = safeJson;
const loadConfig = require('../config').loadConfig;
const angleService = require('./angleService');
const { checkDialogueCoverage, extractScriptDialogue } = require('../utils/dialogueCoverage');
const { buildFallbackUniversalMultiBeatText, repairUniversalSegmentText, summarizeUniversalSegmentFormat } = require('./universalOmniMultiBeatFormat');
const { buildStoryboardQualityReport } = require('../utils/storyboardQualityReport');
const { checkBeatCoverage } = require('../utils/beatCoverageCheck');

/**
 * 分镜专用 generateText 包装：
 * 1. 默认携带 max_tokens:16384，让模型输出更长，减少截断续写次数。
 * 2. 若 API 立即返回参数错误（HTTP 4xx，且错误体提到 max_tokens/length/token），
 *    自动降级为不传 max_tokens 重试一次。
 * 3. 所有尝试均记录日志。
 */
const DEFAULT_STORYBOARD_MAX_TOKENS = 16384;

/**
 * 规划分镜数用的「平均单镜秒数」上限（秒）—— 必须与前端 FilmCreate.vue 的
 * STORYBOARD_PLAN_SECONDS 保持一致。
 *
 * 项目「每段秒数」(drama.metadata.video_clip_duration) 是**单镜时长上限**
 * （本地 MiniMax H3 单镜最长 362 帧 = 15.08s），不是每镜的目标值。
 * 若按「总时长 ÷ 每段秒数」规划镜数，配合「单镜 ≤ 每段」会形成代数死锁：
 *   镜数 = 总时长÷每段、单镜 ≤ 每段、Σ单镜 ≈ 总时长  ⟹  单镜 = 每段
 * 结果就是每个镜头都被顶到上限（全都 15s）。这里改用 8 秒平均折算镜数，
 * 单镜时长交给 AI 在 [5.2, 每段秒数] 内按内容浮动。
 */
const STORYBOARD_PLAN_SECONDS = 8;

/** 统一镜号（AI 可能返回字符串 "1"，须与 Set 去重键一致） */
function normalizeStoryboardShotNumber(rawOrSb) {
  const raw =
    rawOrSb != null && typeof rawOrSb === 'object'
      ? rawOrSb.shot_number ?? rawOrSb.storyboard_number
      : rawOrSb;
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : 0;
}

/** 同集相同 storyboard_number 多行时保留 id 最大的一条（通常为最新入库） */
function dedupeStoryboardRowsByNumber(rows) {
  const byNum = new Map();
  const extras = [];
  for (const r of rows || []) {
    const num = normalizeStoryboardShotNumber(r.storyboard_number ?? r);
    if (num > 0) {
      const prev = byNum.get(num);
      if (!prev || Number(r.id) > Number(prev.id)) byNum.set(num, r);
    } else {
      extras.push(r);
    }
  }
  return [...byNum.values(), ...extras].sort(
    (a, b) =>
      normalizeStoryboardShotNumber(a.storyboard_number) - normalizeStoryboardShotNumber(b.storyboard_number) ||
      Number(a.id) - Number(b.id)
  );
}

function isMaxTokensParamError(errMsg) {
  const m = (errMsg || '').toLowerCase();
  return (
    m.includes('max_tokens') ||
    m.includes('max_completion_tokens') ||
    m.includes('maximum_context_length') ||
    m.includes('context_length_exceeded') ||
    m.includes('maximum length') ||
    m.includes('token limit') ||
    (m.includes('http 4') && (m.includes('token') || m.includes('length') || m.includes('parameter')))
  );
}

async function generateTextForStoryboard(db, log, userPrompt, systemPrompt, options = {}) {
  const { model, streamCallback, temperature = 0.7 } = options;

  // 第一次尝试：带 max_tokens:16384
  log.info('Storyboard generateText attempt 1', { model: model || '(default)', max_tokens: DEFAULT_STORYBOARD_MAX_TOKENS });
  try {
    const text = await aiClient.generateText(db, log, 'text', userPrompt, systemPrompt, {
      scene_key: 'storyboard_extraction',
      model: model || undefined,
      temperature,
      max_tokens: DEFAULT_STORYBOARD_MAX_TOKENS,
      streamCallback,
    });
    return text;
  } catch (e) {
    if (isMaxTokensParamError(e.message)) {
      log.warn('Storyboard generateText: max_tokens rejected by model, retrying without it', {
        model: model || '(default)',
        error: e.message.slice(0, 200),
      });
      // 第二次尝试：不传 max_tokens，让模型用自己默认值
      log.info('Storyboard generateText attempt 2 (no max_tokens)', { model: model || '(default)' });
      const text = await aiClient.generateText(db, log, 'text', userPrompt, systemPrompt, {
        scene_key: 'storyboard_extraction',
        model: model || undefined,
        temperature,
        streamCallback,
      });
      log.info('Storyboard generateText attempt 2 succeeded');
      return text;
    }
    // 其他错误直接抛出
    throw e;
  }
}

function rowToScene(r) {
  if (!r) return null;
  return {
    id: r.id,
    drama_id: r.drama_id,
    location: r.location,
    time: r.time,
    prompt: r.prompt,
    storyboard_count: r.storyboard_count ?? 1,
    image_url: r.image_url,
    local_path: r.local_path,
    status: r.status || 'pending',
    created_at: r.created_at,
    updated_at: r.updated_at,
  };
}

/** 规范为数字秒：前端左侧用 {{ shot.duration }}s，右侧用 Math.round(duration)；避免 "5s" 导致 5ss，或非数字导致 NaN */
function normalizeDuration(v) {
  if (v == null || v === '') return 0;
  if (typeof v === 'number' && Number.isFinite(v)) return Math.round(v);
  const s = String(v).trim().replace(/s$/i, '');
  const n = Number(s);
  return Number.isFinite(n) && n >= 0 ? Math.round(n) : 0;
}

const _SB_PROMPT_LOG_CHUNK = 14000;

/**
 * 调试：完整打印分镜 system / user 提示词（可能很长，按块写入日志）。
 * 启动后端前设置环境变量：DEBUG_STORYBOARD_PROMPTS=1
 */
function logDebugStoryboardPrompts(log, tag, userPrompt, systemPrompt) {
  const on = String(process.env.DEBUG_STORYBOARD_PROMPTS || '').trim();
  if (on !== '1' && on.toLowerCase() !== 'true') return;
  const sp = systemPrompt != null ? String(systemPrompt) : '';
  const up = userPrompt != null ? String(userPrompt) : '';
  log.info(`[StoryboardPrompt:${tag}] system_prompt_bytes=${sp.length} user_prompt_bytes=${up.length}`);
  for (let i = 0; i < sp.length; i += _SB_PROMPT_LOG_CHUNK) {
    log.info(`[StoryboardPrompt:${tag}] system_part_${Math.floor(i / _SB_PROMPT_LOG_CHUNK) + 1}\n${sp.slice(i, i + _SB_PROMPT_LOG_CHUNK)}`);
  }
  for (let i = 0; i < up.length; i += _SB_PROMPT_LOG_CHUNK) {
    log.info(`[StoryboardPrompt:${tag}] user_part_${Math.floor(i / _SB_PROMPT_LOG_CHUNK) + 1}\n${up.slice(i, i + _SB_PROMPT_LOG_CHUNK)}`);
  }
}

function getStoryboardsForEpisode(db, episodeId) {
  const rows = dedupeStoryboardRowsByNumber(
    db.prepare(
      'SELECT * FROM storyboards WHERE episode_id = ? AND deleted_at IS NULL ORDER BY storyboard_number ASC, id ASC'
    ).all(episodeId)
  );
  return rows.map((r) => {
    let background = null;
    if (r.scene_id != null) {
      const sceneRow = db.prepare('SELECT * FROM scenes WHERE id = ? AND deleted_at IS NULL').get(r.scene_id);
      if (sceneRow) background = rowToScene(sceneRow);
    }
    return {
      id: r.id,
      episode_id: r.episode_id,
      scene_id: r.scene_id,
      storyboard_number: r.storyboard_number,
      title: r.title,
      description: r.description,
      location: r.location,
      time: r.time,
      duration: normalizeDuration(r.duration),
      dialogue: r.dialogue,
      narration: r.narration ?? null,
      action: r.action,
      result: r.result,
      atmosphere: r.atmosphere,
      image_prompt: r.image_prompt,
      video_prompt: r.video_prompt,
      shot_type: r.shot_type,
      angle: r.angle,
      angle_h: r.angle_h ?? null,
      angle_v: r.angle_v ?? null,
      angle_s: r.angle_s ?? null,
      movement: r.movement,
      segment_index: r.segment_index ?? 0,
      segment_title: r.segment_title ?? null,
      creation_mode: r.creation_mode === 'universal' ? 'universal' : 'classic',
      universal_segment_text: r.universal_segment_text ?? null,
      characters: (() => {
        if (!r.characters) return [];
        if (typeof r.characters !== 'string') return Array.isArray(r.characters) ? r.characters : [];
        try { return JSON.parse(r.characters); } catch (_) { return []; }
      })(),
      composed_image: r.composed_image,
      video_url: r.video_url,
      audio_local_path: r.audio_local_path ?? null,
      narration_audio_local_path: r.narration_audio_local_path ?? null,
      status: r.status || 'pending',
      created_at: r.created_at,
      updated_at: r.updated_at,
      background,
    };
  });
}

/** 运镜词：这些内容属于**动态**，不能进静帧首帧提示词 */
// 注意：**不要加 g 标志**。这两个正则会被反复 .test()，而带 g 的 .test() 是**有状态**的
// （会推进 lastIndex），于是同一句话第二次问就可能返回 false —— 实测因此漏掉了
// 「悟空驾云来到花果山」这类句子里的运镜/运动词，把动作整段留进了首帧提示词。
// 注意**不含** 俯拍/仰拍：首帧提示词里的「远景·俯拍·正面」是**机位角度标签**（由 angleLabelForFrame
// 生成），那是静帧本来就该有的信息；把它们当运镜会让自检对每一镜都误报。
// 真正表达运镜时会写「镜头俯拍」，由「镜头」命中。
const CAMERA_MOTION_RE = /(镜头|横摇|推镜|拉镜|跟拍|跟镜|环绕|甩镜|摇镜|升降|升镜|降镜|变焦|旋转|缓推|缓拉|缓摇|推近|拉远|升起|拉开|横移|下压)/;
/**
 * 运动/过程词：首帧要的是**动作发生前的初始状态**，不是过程。
 *
 * 一律用**多字词**，单字（走/行/飞/打/翻）会把静态成语一起切坏 ——
 * 实测「飞沙走石」被按「走」截成「飞沙」、「头戴金箍，手持铁棒」被整个丢掉。
 * 副词（忽然/突然/猛然）也不算运动：镜6 的动作以「山路转角忽然刮起一阵黑风」开头，
 * 那是**画面内容**而不是动作过程，首帧正需要它。
 */
const MOTION_WORD_RE = /(缓缓|徐徐|逐渐|慢慢|快速|飞快|纵身|腾空|跃起|跃上|降落|落下|落在|飞起|飞出|飞去|疾驰|疾飞|奔来|冲来|冲出|蹿出|走出|走向|前行|行走|转身|翻身|翻滚|就地一滚|捡起|回身|抡起|劈下|砸向|扫向|踢中|打死|倒地|倒下|扑向|逃去|追去|紧追|追出|跃下|直上|应声|行进|拔高|扫翻|翻倒|腾云|翻上|筋斗|疾行|驾云|砸来|翻出|飞掠)/;

/**
 * 从 action 里裁出「首帧那一刻」的**静止初始状态**。
 *
 * 原实现（extractInitialPose）只按一小组过程词（然后/向下/开始/慢慢…）切断，实测在
 * 「真假美猴王」65 镜上基本失效 —— 镜1《师徒行荒山》的 action 以运镜开头
 *   「镜头从远处山脊缓缓横摇，展现荒山野岭全貌，师徒四人的渺小身影沿山路缓缓前行，…」
 * 一个过程词都没命中，于是**整句照搬**进「首帧静止画面」，首帧提示词里出现了
 * 「镜头…横摇」和「缓缓前行」这种动态描述，末尾却又写着「首帧静止画面」——自相矛盾；
 * 而且它与同一镜 ust 的首拍（「开篇以大远景俯瞰荒山野岭」）机位也对不上。
 * 65 镜里有 4 条混入运镜、10 条混入运动，都是同一个原因。
 *
 * 现在的规则：
 *   ① 按逗号/分号切句；② 丢掉含运镜词的句子；③ 遇到第一个含运动/过程词的句子就停
 *   （那之后的都是「过程」，不属于首帧）；④ 一句都没留下时退回「第一条非运镜句」，仍为空则不写。
 *
 * @param {string} action
 * @returns {string} 首帧可用的静止状态描述（可能为空）
 */
function extractInitialPose(action) {
  if (!action || typeof action !== 'string') return '';
  const clauses = String(action)
    .split(/[，,；;。]/)
    .map((s) => s.trim())
    .filter(Boolean);
  if (!clauses.length) return '';
  const kept = [];
  for (const c of clauses) {
    if (CAMERA_MOTION_RE.test(c)) continue;        // 运镜不进静帧
    const mm = c.match(MOTION_WORD_RE);
    if (!mm || mm.index == null) { kept.push(c); continue; }  // 静态描述：保留
    // 含运动：只保留动作起点**之前**的部分（主体 + 位置），那才是首帧那一刻的画面。
    // 注意是「过滤」而不是「遇到就停」—— 停会把后面的静态描述（头戴金箍、手持铁棒、
    // 蟹竹摇曳、海浪拍岸）一起丢掉，而那些正是首帧需要的画面内容。
    // 截断处会留下悬空的介词短语（「…猴子从风中」「…身影沿山路」），只在这个被截断的句子里去尾。
    const head = c
      .slice(0, mm.index)
      .replace(/[从向往朝在沿被把将对跟][^，,]*$/, '')
      .replace(/[，。、；;\s]+$/, '')
      .trim();
    // 截得太短就只剩残词（「一脚」「身形」），宁可不写
    if (head.length >= 3) kept.push(head);
  }
  // 兜底：一句静态描述都没有时才退回「第一条不带运镜的句子」——
  // 但必须**同时**排除含运动词的句子，否则整段动作会被当成首帧。
  // 实测镜25《驾云花果山》的 action 只有一句「悟空驾云来到花果山」，
  // 截断后只剩「悟空」（不足 3 字被丢），兜底又把整句放回来，于是运镜/运动又漏进了首帧。
  const out = kept.length
    ? kept.join('，')
    : (clauses.find((c) => !CAMERA_MOTION_RE.test(c) && !MOTION_WORD_RE.test(c)) || '');
  return out.replace(/[，,、；;\s]+$/, '').trim();
}

/**
 * 景别标签：`angleService` 的枚举只有 特写/中景/远景 三档，
 * `大远景` 会被压成 `远景`（实测 65 镜里 5 条大远景全被压）。而分镜自己的 shot_type 是准的，
 * 所以这里**优先照抄 shot_type** 的景别词，只用 angleService 补俯仰与朝向。
 */
function shotScaleLabelZh(shotTypeText, fallback = '中景') {
  const t = String(shotTypeText || '');
  const m = t.match(/(大远景|大全景|远景|全景|中景|近景|特写|大特写)/);
  return m ? m[1] : fallback;
}

function angleLabelForFrame(sb) {
  const scale = shotScaleLabelZh(sb.shot_type);
  if (sb.angle_h && sb.angle_v && sb.angle_s) {
    const full = angleService.toChineseLabel(sb.angle_h, sb.angle_v, sb.angle_s);
    // toChineseLabel 形如「远景·平视·正面」，只取后两段，景别用 shot_type 的原文
    const segs = String(full).split('·');
    return segs.length === 3 ? `${scale}·${segs[1]}·${segs[2]}` : full;
  }
  if (sb.angle || sb.shot_type) {
    const { h, v, s } = angleService.parseFromLegacyText(sb.angle || '', sb.shot_type || '');
    const segs = String(angleService.toChineseLabel(h, v, s)).split('·');
    return segs.length === 3 ? `${scale}·${segs[1]}·${segs[2]}` : scale;
  }
  return '';
}

function generateImagePrompt(sb, style) {
  const parts = [];
  // 场景位置与时间
  if (sb.location) {
    let locationDesc = sb.location;
    if (sb.time) locationDesc += '，' + sb.time;
    parts.push(locationDesc);
  }
  // 镜头视角：优先结构化三元组（中文标签），降级到旧文本
  const angleLabel = angleLabelForFrame(sb);
  if (angleLabel) parts.push(angleLabel);
  // 画面动作（只取动作发生前的**静止**初始状态）
  if (sb.action) {
    const initialPose = extractInitialPose(sb.action);
    if (initialPose) parts.push(initialPose);
  }
  // 情绪
  if (sb.emotion) parts.push(sb.emotion);
  // 风格（英文 prompt token，保持英文以兼容图片 AI）
  const styleText = style && String(style).trim();
  if (styleText) parts.push(styleText);
  parts.push('首帧静止画面');
  return parts.join('，');
}

function generateVideoPrompt(sb, style, videoRatio) {
  const parts = [];
  // 场景与标题
  if (sb.scene_description) {
    parts.push('场景：' + sb.scene_description);
  } else if (sb.location) {
    const scene = sb.time ? sb.location + '，' + sb.time : sb.location;
    parts.push('场景：' + scene);
  }
  if (sb.title) parts.push('镜头标题：' + sb.title);
  // 动作与对白（核心叙事）
  if (sb.action) parts.push('动作：' + sb.action);
  if (sb.dialogue) parts.push('对话：' + sb.dialogue);
  if (sb.narration) parts.push('解说旁白：' + sb.narration);
  if (sb.result) parts.push('结果：' + sb.result);
  // 镜头与运镜
  const shotType = sb.shot_type || sb.camera_shot_type;
  if (shotType) parts.push('景别：' + shotType);
  // 结构化视角：中文标签 + 英文描述（兼顾中英文视频模型）
  if (sb.angle_h && sb.angle_v && sb.angle_s) {
    const chLabel = angleService.toChineseLabel(sb.angle_h, sb.angle_v, sb.angle_s);
    const angleFragment = angleService.toPromptFragment(sb.angle_h, sb.angle_v, sb.angle_s);
    parts.push(`镜头角度：${chLabel}（${angleFragment}）`);
  } else {
    const angle = sb.angle ?? sb.camera_angle;
    if (angle) parts.push('镜头角度：' + angle);
  }
  const movement = sb.movement ?? sb.camera_movement;
  if (movement) parts.push('运镜：' + movement);
  // 氛围与情绪
  if (sb.atmosphere) parts.push('氛围：' + sb.atmosphere);
  if (sb.emotion) parts.push('情绪：' + sb.emotion);
  if (sb.emotion_intensity != null && sb.emotion_intensity !== '') {
    parts.push('情绪强度：' + String(sb.emotion_intensity));
  }
  // 声音
  if (sb.bgm_prompt) parts.push('配乐：' + sb.bgm_prompt);
  if (sb.sound_effect) parts.push('音效：' + sb.sound_effect);
  // 时长
  const durationSec = normalizeDuration(sb.duration) || 5;
  parts.push('时长：' + durationSec + '秒');
  // 风格（英文 token 保持英文以兼容视频 AI）与画面比例
  if (style) parts.push('风格：' + style);
  if (videoRatio) parts.push('=VideoRatio: ' + videoRatio);
  return parts.length ? parts.join('。') : '视频场景';
}

/**
 * 从 AI 输出的单个分镜对象计算入库字段（INSERT/UPDATE 共用）。
 * 会就地写入 sb.location / sb.time（由 scene_description 拆分）。
 */
/**
 * 情绪强度归一化：写库的列是 INTEGER，而模型既可能给 3/2/1/0/-1，
 * 也可能给提示词里那套箭头（↑↑↑ / ↑↑ / ↑ / → / ↓）。给不出有效值时返回 null。
 */
function normalizeEmotionIntensity(v) {
  if (v == null || v === '') return null;
  const n = Number(v);
  if (Number.isFinite(n)) return Math.max(-1, Math.min(3, Math.round(n)));
  const str = String(v).trim();
  if (/↑\s*↑\s*↑/.test(str)) return 3;
  if (/↑\s*↑/.test(str)) return 2;
  if (/↑/.test(str)) return 1;
  if (/[→]/.test(str)) return 0;
  if (/↓/.test(str)) return -1;
  return null;
}

function deriveStoryboardFieldsFromAi(sb, style, videoRatio, opts = {}) {
  const universalOmni = !!opts.universalOmni;
  const angleValFn = (x) => x.angle ?? x.camera_angle ?? null;
  const shotNumber = normalizeStoryboardShotNumber(sb);
  const title = sb.title ?? '';
  const shotType = sb.shot_type ?? '';
  const movement = sb.movement ?? sb.camera_movement ?? '';
  const angle = angleValFn(sb);
  const action = sb.action ?? '';
  const dialogue = sb.dialogue ?? '';
  const narration = sb.narration ?? '';
  const result = sb.result ?? '';
  const emotion = sb.emotion ?? '';
  // emotion_intensity 列是 INTEGER，而模型可能给 3/2/1/0/-1，也可能给 ↑↑↑/↑↑/↑/→/↓ 这种箭头
  const emotionIntensity = normalizeEmotionIntensity(sb.emotion_intensity);
  const segmentIndex = sb.segment_index != null ? Number(sb.segment_index) : 0;
  const segmentTitle = sb.segment_title ?? null;
  const lightingStyle = sb.lighting_style ?? null;
  const depthOfField = sb.depth_of_field ?? null;
  let durationSec = normalizeDuration(sb.duration) || 5;
  const maxClip = opts.maxClipDuration != null ? Number(opts.maxClipDuration) : 0;
  // 只封顶、不抬升：避免每个镜头都被拉到目标时长（导致全都是最大时长）
  if (Number.isFinite(maxClip) && maxClip > 0) {
    durationSec = Math.min(durationSec, Math.round(maxClip));
  }
  durationSec = Math.min(120, Math.max(1, Math.round(durationSec)));
  sb.duration = durationSec;
  if (!sb.location && sb.scene_description) {
    const sceneDesc = String(sb.scene_description).trim();
    const sepIdx = sceneDesc.search(/[，,、]/);
    if (sepIdx > 0) {
      sb.location = sceneDesc.slice(0, sepIdx).trim();
      if (!sb.time) sb.time = sceneDesc.slice(sepIdx + 1).trim();
    } else {
      sb.location = sceneDesc;
    }
  }
  const { h: angleH, v: angleV, s: angleS } = (angle || shotType)
    ? angleService.parseFromLegacyText(angle || '', shotType || '')
    : { h: null, v: null, s: null };
  const description = `【镜头类型】${shotType}\n【运镜】${movement}\n【动作】${action}\n【对话】${dialogue}\n【解说】${narration}\n【结果】${result}\n【情绪】${emotion}`;
  const sbWithAngles = { ...sb, angle_h: angleH, angle_v: angleV, angle_s: angleS };
  const imagePrompt = generateImagePrompt(sbWithAngles, style);
  const videoPrompt = generateVideoPrompt(sbWithAngles, style, videoRatio);
  const sceneId = sb.scene_id != null ? Number(sb.scene_id) : null;
  const charactersJson = Array.isArray(sb.characters) ? JSON.stringify(sb.characters) : (sb.characters ? JSON.stringify([].concat(sb.characters)) : '[]');
  const propIds = Array.isArray(sb.props) ? sb.props.map(Number).filter(Number.isFinite) : [];
  let universalSegmentText = '';
  let universalSegmentFormatProblems = [];
  let universalSegmentFatal = false;
  if (sb.universal_segment_text != null && String(sb.universal_segment_text).trim()) {
    // 全能分镜是**多行块**格式（第1行风格 / 第2行「生成一个由以下 1 个分镜组成的视频。」/
    // 第3行 LINE3 / 第4行「分镜1： T秒: …」）。这里原先把换行压成空格，把块结构拍平成一行，
    // 与规范冲突；只规范换行符、保留行结构。
    const raw = String(sb.universal_segment_text).trim().replace(/\r\n?/g, '\n');
    // 格式合规此前完全没校验，而实测是抽签的（16 镜那轮全对、21 镜那轮全是废弃的灵境单行）。
    // 不合规时**只换骨架那几行**，保住模型写的第4行长句 —— 整条替换会把好内容一起扔掉。
    const rep = repairUniversalSegmentText(raw, { styleZh: opts.styleZh || '' });
    if (!rep.fatal) {
      universalSegmentText = rep.text;
      if (rep.changes.length) universalSegmentFormatProblems = rep.changes;
    } else {
      universalSegmentFormatProblems = rep.changes;
      universalSegmentFatal = true;
    }
  }
  if (universalOmni && !universalSegmentText) {
    // 兜底必须是**块格式**，与正常产出同格式。
    // 原先用的是本文件里的 buildFallbackUniversalSeedanceLine —— 产出已废弃的灵境/SoulLens
    // 单行格式（「主体：@人物1… 叙事动态：… [禁BGM][禁字幕]」），而规范明令禁止该格式与
    // @人物N。实测「真假美猴王」21 镜重生成时模型 21/21 都未返回 universal_segment_text，
    // 全部落到那个老兜底，用户拿到的「全能分镜」全是灵境单行格式。
    universalSegmentText = buildFallbackUniversalMultiBeatText(
      sb,
      {
        shotNumber,
        durationSec,
        shotType,
        movement,
        angle,
        action,
        dialogue,
        narration,
        result,
        emotion,
        lightingStyle,
        depthOfField,
      },
      // 项目**中文**风格（与提示词里的 STYLE_ZH 同源）。不能把入参 style 直接拼进来 ——
      // 前端传的是英文 PromptEn，且拼上「真人写实, 电影风格, 高清画质」会与项目风格冲突。
      opts.styleZh || style
    );
    // 走到这里说明整条换成了块格式兜底模板。两种来路都要报出来：
    //   · 模型压根没返回 universal_segment_text（此前完全静默）—— 实测「真假美猴王」21 镜
    //     那轮就是 21/21 没返回，用户只看到一堆模板文而日志里一行提示都没有
    //   · 模型返回了但正文立不住（fatal=true）
    universalSegmentFatal = true;
    if (!universalSegmentFormatProblems.length) {
      universalSegmentFormatProblems = ['模型未返回 universal_segment_text，已用块格式兜底模板生成'];
    }
  }
  const creationMode = universalOmni ? 'universal' : 'classic';
  if (!universalOmni) universalSegmentText = null;
  return {
    shotNumber,
    title,
    shotType,
    movement,
    angle,
    action,
    dialogue,
    narration,
    result,
    emotion,
    emotionIntensity,
    segmentIndex,
    segmentTitle,
    lightingStyle,
    depthOfField,
    description,
    imagePrompt,
    videoPrompt,
    sceneId,
    charactersJson,
    angleH,
    angleV,
    angleS,
    propIds,
    creationMode,
    universalSegmentText,
    universalSegmentFormatProblems,
    universalSegmentFatal,
  };
}

/** 用最终解析的分镜对象覆盖已存在的行（修正流式增量先入库时缺 narration 等字段的问题） */
function updateStoryboardRowFromDerived(db, existingId, episodeIdNum, d, sb, now) {
  db.prepare(
    `UPDATE storyboards SET
      scene_id = ?, title = ?, description = ?, location = ?, time = ?, duration = ?,
      dialogue = ?, narration = ?, action = ?, result = ?, atmosphere = ?,
      image_prompt = ?, video_prompt = ?, characters = ?,
      shot_type = ?, angle = ?, angle_h = ?, angle_v = ?, angle_s = ?, movement = ?,
      lighting_style = ?, depth_of_field = ?, segment_index = ?, segment_title = ?,
      creation_mode = ?, universal_segment_text = ?, universal_segment_text_en = NULL,
      updated_at = ?
     WHERE id = ? AND episode_id = ? AND deleted_at IS NULL`
  ).run(
    d.sceneId,
    d.title || null,
    d.description,
    sb.location ?? null,
    sb.time ?? null,
    sb.duration ?? 5,
    d.dialogue || null,
    d.narration || null,
    d.action || null,
    d.result || null,
    sb.atmosphere ?? null,
    d.imagePrompt,
    d.videoPrompt,
    d.charactersJson,
    d.shotType || null,
    d.angle,
    d.angleH,
    d.angleV,
    d.angleS,
    d.movement || null,
    d.lightingStyle,
    d.depthOfField,
    d.segmentIndex,
    d.segmentTitle,
    d.creationMode || 'classic',
    d.universalSegmentText != null ? d.universalSegmentText : null,
    now,
    existingId,
    episodeIdNum
  );
  try {
    db.prepare('DELETE FROM storyboard_props WHERE storyboard_id = ?').run(existingId);
    if (d.propIds.length > 0) {
      const insProp = db.prepare('INSERT OR IGNORE INTO storyboard_props (storyboard_id, prop_id) VALUES (?, ?)');
      for (const pid of d.propIds) insProp.run(existingId, pid);
    }
  } catch (_) {}
}

/**
 * 将单个分镜对象插入 DB，供增量流式保存使用。
 * 返回插入后的 id，出错则返回 null（不抛异常）。
 */
function insertOneStoryboard(db, episodeIdNum, sb, style, videoRatio, now, deriveOpts = {}) {
  const d = deriveStoryboardFieldsFromAi(sb, style, videoRatio, deriveOpts);
  const shotNumber = d.shotNumber;
  try {
    db.prepare(
      `INSERT INTO storyboards (episode_id, scene_id, storyboard_number, title, description, location, time, duration, dialogue, narration, action, result, atmosphere, image_prompt, video_prompt, characters, shot_type, angle, angle_h, angle_v, angle_s, movement, lighting_style, depth_of_field, segment_index, segment_title, creation_mode, universal_segment_text, status, created_at, updated_at, emotion, emotion_intensity)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending', ?, ?, ?, ?)`
    ).run(
      episodeIdNum, d.sceneId, shotNumber, d.title || null, d.description,
      sb.location ?? null, sb.time ?? null, sb.duration ?? 5,
      d.dialogue || null, d.narration || null, d.action || null, d.result || null, sb.atmosphere ?? null,
      d.imagePrompt, d.videoPrompt, d.charactersJson,
      d.shotType || null, d.angle, d.angleH, d.angleV, d.angleS,
      d.movement || null, d.lightingStyle, d.depthOfField, d.segmentIndex, d.segmentTitle,
      d.creationMode || 'classic',
      d.universalSegmentText != null ? d.universalSegmentText : null,
      now, now,
      // 情绪此前**完全没入库**：三个项目 99 条分镜的 emotion 全是 NULL，而模型一直在返回它
      // （它已写进 description 的【情绪】，也参与首帧图片提示词）。INSERT 里漏了这两列。
      d.emotion || null, d.emotionIntensity ?? null
    );
    const newId = db.prepare('SELECT last_insert_rowid() as id').get().id;
    if (d.propIds.length > 0) {
      try {
        const insProp = db.prepare('INSERT OR IGNORE INTO storyboard_props (storyboard_id, prop_id) VALUES (?, ?)');
        for (const pid of d.propIds) insProp.run(newId, pid);
      } catch (_) {}
    }
    return newId;
  } catch (_) {
    return null;
  }
}

/**
 * 在流式输出过程中，从已积累的文本尝试解析并保存尚未保存的分镜。
 * savedNums：已保存的 storyboard_number Set，用于去重。
 */
function tryIncrementalSave(db, log, episodeIdNum, accumulated, savedNums, style, videoRatio, deriveOpts = {}) {
  try {
    let cleaned = accumulated.trim()
      .replace(/^```json\s*/gm, '').replace(/^```\s*/gm, '').replace(/```\s*$/gm, '').trim();
    // 转义字符串字段里的原始换行符，防止 JSON.parse 报 "Unterminated string"
    cleaned = safeJson.escapeNewlinesInStrings(cleaned);
    let candidate = extractJsonCandidate(cleaned);
    if (!candidate) return;

    // 如果 AI 将数组包在对象里（如 doubao 的 {"storyboards":[...]}），提取内部数组
    const innerArray = safeJson.extractWrappedArrayStr(candidate);
    const arrayCandidate = innerArray || candidate;

    // 策略A：截断修复（找到已完整闭合的顶层元素）
    let parsed = null;
    const repaired = repairTruncatedJsonArray(arrayCandidate);
    if (repaired) {
      try { parsed = JSON.parse(repaired); } catch (_) {}
      // 策略B：截断修复 + jsonrepair
      if (!parsed && safeJson._jsonrepair) {
        try { parsed = JSON.parse(safeJson._jsonrepair(repaired)); } catch (_) {}
      }
    }
    // 策略C：直接 jsonrepair 整体修复
    if (!parsed && safeJson._jsonrepair) {
      try { parsed = JSON.parse(safeJson._jsonrepair(arrayCandidate)); } catch (_) {}
    }
    if (!parsed) return;
    const items = Array.isArray(parsed) ? parsed : extractFirstArray(parsed);
    if (!items || items.length === 0) return;
    const now = new Date().toISOString();
    let newCount = 0;
    for (const sb of items) {
      const shotNumber = normalizeStoryboardShotNumber(sb);
      if (shotNumber > 0 && savedNums.has(shotNumber)) continue;
      const id = insertOneStoryboard(db, episodeIdNum, sb, style, videoRatio, now, deriveOpts);
      if (id !== null) {
        savedNums.add(shotNumber);
        newCount++;
      }
    }
    if (newCount > 0) {
      log.info('Storyboard incremental save', { episode_id: episodeIdNum, new_count: newCount, total_saved: savedNums.size });
    }
  } catch (_) { /* 流式解析错误静默忽略，等待最终完整解析 */ }
}

/**
 * @param {Set|null} skipShotNumbers - 已通过增量流式保存的 storyboard_number 集合，跳过重复插入
 */
/**
 * 把一批分镜的 duration 按「AI 内容权重」比例归一化：和≈总时长、单镜封顶 maxSec，
 * 避免每个分镜都被抬到最大时长。
 * @param {Array<{duration:any}>} storyboards
 * @param {{totalSec?:number, maxSec?:number, minSec?:number}} opts
 */
function redistributeShotDurations(storyboards, opts = {}) {
  const n = storyboards.length;
  if (!n) return;
  const minSec = Number(opts.minSec) > 0 ? Number(opts.minSec) : 1;
  const maxSec = Number(opts.maxSec) > 0 ? Number(opts.maxSec) : 15;
  const weights = storyboards.map((sb) => Math.max(0.05, Number(sb.duration) || minSec));
  const wsum = weights.reduce((a, b) => a + b, 0) || 1;
  const aiSum = weights.reduce((a, b) => a + b, 0);
  const target = Number(opts.totalSec) > 0 ? Math.min(Number(opts.totalSec), n * maxSec) : Math.min(aiSum, n * maxSec);
  if (target <= 0) return;
  // 按 AI 内容权重比例分配并封顶（不强行补满，避免每个镜头都被拉到最大时长）；最后一个吸收尾差
  let allocated = 0;
  const out = weights.map((w, i) => {
    if (i === n - 1) {
      return Math.max(minSec, Math.min(maxSec, Math.round((target - allocated) * 10) / 10));
    }
    const v = Math.max(minSec, Math.min(maxSec, Math.round((target * w / wsum) * 10) / 10));
    allocated += v;
    return v;
  });
  for (let i = 0; i < n; i++) storyboards[i].duration = out[i];
}

function saveStoryboards(db, log, episodeId, storyboards, cfg, styleOverride, skipShotNumbers = null, deriveOpts = {}) {
  const episodeIdNum = Number(episodeId);
  if (storyboards.length === 0) {
    throw new Error('AI生成分镜失败：返回的分镜数量为0');
  }
  // 把各分镜时长按内容权重比例归一化，单镜封顶（H3=15s 或项目每段时长），避免每个都是最大时长
  redistributeShotDurations(storyboards, {
    totalSec: deriveOpts.video_duration || deriveOpts.total_duration,
    maxSec: deriveOpts.maxClipDuration || deriveOpts.max_duration,
    // 下限取本地 MiniMax H3 的官方验证下限：124 帧 ÷ 24fps = 5.17 秒。
    // 低于此值时模型行为未经验证（画面崩坏/动作做不完）。若总时长不足以按此下限分配，
    // 分配结果会超过 totalSec —— 这是有意为之：宁可总时长超一点，也不产出无效短片。
    minSec: 5.2,
  });
  const style = (styleOverride && String(styleOverride).trim()) || cfg?.style?.default_style || '';
  const videoRatio = cfg?.style?.default_video_ratio || '16:9';
  const now = new Date().toISOString();

  // 项目**中文**画风，供全能分镜兜底文案的第 1 行使用（与提示词里的 STYLE_ZH 同源，
  // 走同一套 mergeCfgStyleWithDrama）。不能拿上面的 style 顶替 —— 前端传的是英文
  // PromptEn，直接当风格句会把英文混进中文正文。
  let styleZh = '';
  try {
    const { mergeCfgStyleWithDrama } = require('../utils/dramaStyleMerge');
    const dramaRow = db.prepare(
      'SELECT d.style AS style, d.metadata AS metadata FROM dramas d JOIN episodes e ON e.drama_id = d.id WHERE e.id = ?'
    ).get(episodeIdNum);
    const merged = mergeCfgStyleWithDrama(cfg || {}, dramaRow || {});
    styleZh = String(merged?.style?.default_style_zh || '').trim();
  } catch (_) { /* 取不到就退回英文 style，不影响出片 */ }
  const deriveOptsEff = styleZh ? { ...deriveOpts, styleZh } : deriveOpts;
  /** 全能提示词格式不合规的分镜（模型返回的正文不是块格式，已用兜底替换），供末尾告警 */
  const fmtProblems = [];

  // 仅在非增量模式下才删除旧数据（增量模式时已在流式开始前删除）
  if (skipShotNumbers === null) {
    const existing = db.prepare('SELECT id FROM storyboards WHERE episode_id = ? AND deleted_at IS NULL').all(episodeIdNum);
    if (existing.length > 0) {
      db.prepare('UPDATE storyboards SET deleted_at = ? WHERE episode_id = ?').run(now, episodeIdNum);
    }
  }

  const saved = [];
  const processedInSave = new Set();
  for (const sb of storyboards) {
    const shotNumber = normalizeStoryboardShotNumber(sb);
    if (shotNumber > 0 && processedInSave.has(shotNumber)) {
      log.warn('Duplicate storyboard_number in final AI batch, skipping extra row', {
        episode_id: episodeIdNum,
        storyboard_number: shotNumber,
      });
      continue;
    }

    // 已由增量流式保存过的分镜：必须用**最终完整 JSON** 再 UPDATE 一行（否则首镜常在流式阶段缺 narration 等字段且永不修正）
    if (skipShotNumbers && skipShotNumbers.has(shotNumber)) {
      const existing = db.prepare(
        'SELECT * FROM storyboards WHERE episode_id = ? AND storyboard_number = ? AND deleted_at IS NULL'
      ).get(episodeIdNum, shotNumber);
      if (existing) {
        const d = deriveStoryboardFieldsFromAi(sb, style, videoRatio, deriveOptsEff);
        if (d.universalSegmentFormatProblems?.length) fmtProblems.push({ id: existing.id, title: d.title, fatal: !!d.universalSegmentFatal, reasons: d.universalSegmentFormatProblems });
        updateStoryboardRowFromDerived(db, existing.id, episodeIdNum, d, sb, now);
        log.info('Storyboard merged from final parse after incremental save', {
          episode_id: episodeIdNum,
          storyboard_id: existing.id,
          storyboard_number: shotNumber,
        });
        const refreshed = db.prepare(
          'SELECT * FROM storyboards WHERE id = ? AND deleted_at IS NULL'
        ).get(existing.id);
        let propIds = [];
        try {
          const propLinks = db.prepare('SELECT prop_id FROM storyboard_props WHERE storyboard_id = ?').all(refreshed.id);
          propIds = propLinks.map((p) => p.prop_id);
        } catch (_) {}
        saved.push({
          id: refreshed.id,
          episode_id: episodeIdNum,
          scene_id: refreshed.scene_id,
          storyboard_number: shotNumber,
          title: refreshed.title,
          description: refreshed.description,
          location: refreshed.location,
          time: refreshed.time,
          duration: refreshed.duration,
          dialogue: refreshed.dialogue,
          narration: refreshed.narration ?? null,
          action: refreshed.action,
          result: refreshed.result,
          atmosphere: refreshed.atmosphere,
          image_prompt: refreshed.image_prompt,
          video_prompt: refreshed.video_prompt,
          shot_type: refreshed.shot_type,
          angle: refreshed.angle,
          movement: refreshed.movement,
          segment_index: refreshed.segment_index ?? 0,
          segment_title: refreshed.segment_title ?? null,
          creation_mode: refreshed.creation_mode === 'universal' ? 'universal' : 'classic',
          universal_segment_text: refreshed.universal_segment_text ?? null,
          characters: (() => { try { return JSON.parse(refreshed.characters || '[]'); } catch (_) { return []; } })(),
          prop_ids: propIds,
          status: refreshed.status,
          created_at: refreshed.created_at,
          updated_at: refreshed.updated_at,
        });
        if (shotNumber > 0) processedInSave.add(shotNumber);
        continue;
      }
      // 流式阶段已登记镜号但库中无行（竞态/异常）：不再 INSERT 重复行
      if (shotNumber > 0) {
        log.warn('Incremental shot missing in DB at final save, skipping insert', {
          episode_id: episodeIdNum,
          storyboard_number: shotNumber,
        });
        continue;
      }
    }

    const d = deriveStoryboardFieldsFromAi(sb, style, videoRatio, deriveOptsEff);
    if (d.universalSegmentFormatProblems?.length) fmtProblems.push({ id: null, title: d.title, fatal: !!d.universalSegmentFatal, reasons: d.universalSegmentFormatProblems });

    try {
      db.prepare(
        `INSERT INTO storyboards (episode_id, scene_id, storyboard_number, title, description, location, time, duration, dialogue, narration, action, result, atmosphere, image_prompt, video_prompt, characters, shot_type, angle, angle_h, angle_v, angle_s, movement, lighting_style, depth_of_field, segment_index, segment_title, creation_mode, universal_segment_text, status, created_at, updated_at, emotion, emotion_intensity)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending', ?, ?, ?, ?)`
      ).run(
        episodeIdNum, d.sceneId, shotNumber, d.title || null, d.description,
        sb.location ?? null, sb.time ?? null, sb.duration ?? 5,
        d.dialogue || null, d.narration || null, d.action || null, d.result || null, sb.atmosphere ?? null,
        d.imagePrompt, d.videoPrompt, d.charactersJson,
        d.shotType || null, d.angle, d.angleH, d.angleV, d.angleS,
        d.movement || null, d.lightingStyle, d.depthOfField, d.segmentIndex, d.segmentTitle,
        d.creationMode || 'classic',
        d.universalSegmentText != null ? d.universalSegmentText : null,
        now, now,
        d.emotion || null, d.emotionIntensity ?? null
      );
    } catch (e) {
      if ((e.message || '').includes('shot_type') || (e.message || '').includes('angle') || (e.message || '').includes('movement') || (e.message || '').includes('result') || (e.message || '').includes('segment') || (e.message || '').includes('narration')) {
        db.prepare(
          `INSERT INTO storyboards (episode_id, scene_id, storyboard_number, title, description, location, time, duration, dialogue, action, atmosphere, image_prompt, video_prompt, characters, creation_mode, universal_segment_text, status, created_at, updated_at, emotion, emotion_intensity)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending', ?, ?, ?, ?)`
        ).run(
          episodeIdNum, d.sceneId, shotNumber, d.title || null, d.description,
          sb.location ?? null, sb.time ?? null, sb.duration ?? 5,
          d.dialogue || null, d.action || null, sb.atmosphere ?? null,
          d.imagePrompt, d.videoPrompt, d.charactersJson,
          d.creationMode || 'classic',
          d.universalSegmentText != null ? d.universalSegmentText : null,
          now, now,
          d.emotion || null, d.emotionIntensity ?? null
        );
      } else {
        throw e;
      }
    }
    const id = db.prepare('SELECT last_insert_rowid() as id').get().id;
    if (d.propIds.length > 0) {
      try {
        const insProp = db.prepare('INSERT OR IGNORE INTO storyboard_props (storyboard_id, prop_id) VALUES (?, ?)');
        for (const pid of d.propIds) insProp.run(id, pid);
      } catch (_) {}
    }
    saved.push({
      id,
      episode_id: episodeIdNum,
      scene_id: d.sceneId,
      storyboard_number: shotNumber,
      title: d.title || null,
      description: d.description,
      location: sb.location ?? null,
      time: sb.time ?? null,
      duration: sb.duration ?? 5,
      dialogue: d.dialogue || null,
      narration: d.narration || null,
      action: d.action || null,
      result: d.result || null,
      atmosphere: sb.atmosphere ?? null,
      image_prompt: d.imagePrompt,
      video_prompt: d.videoPrompt,
      shot_type: d.shotType || null,
      angle: d.angle,
      movement: d.movement || null,
      segment_index: d.segmentIndex,
      segment_title: d.segmentTitle,
      creation_mode: d.creationMode || 'classic',
      universal_segment_text: d.universalSegmentText != null ? d.universalSegmentText : null,
      characters: Array.isArray(sb.characters) ? sb.characters : [],
      prop_ids: d.propIds,
      status: 'pending',
      created_at: now,
      updated_at: now,
    });
    if (shotNumber > 0) processedInSave.add(shotNumber);
  }
  log.info('Storyboards saved', { episode_id: episodeId, count: saved.length });

  // 全能分镜格式自检。两种情况必须分开报：
  //   · 骨架错但正文立得住 → 只把骨架几行换掉，模型写的第 4 行长句保留（常见，危害小）
  //   · 正文根本不成块（灵境单行 / 多子分镜 / 混入 @人物N）→ 整条换成块格式模板兜底
  //     （危害大，出片质量明显低于模型正常产出，必须让人重跑）
  // 汇总随任务结果返回，供界面「生成质量报告」展示 —— 此前只进后端日志，
  // 用户要翻 /tmp/lmd-backend.log 才知道这版能不能用。
  const fmtRepaired = fmtProblems.filter((x) => !x.fatal);
  const fmtFatal = fmtProblems.filter((x) => x.fatal);
  const formatReport = {
    checked: saved.filter((r) => r.creation_mode === 'universal').length,
    repaired: fmtRepaired.length,
    fatal: fmtFatal.length,
    repaired_sample: fmtRepaired.slice(0, 5),
    fatal_sample: fmtFatal.slice(0, 5),
  };

  if (fmtRepaired.length > 0) {
    log.warn('[分镜] 部分分镜的全能提示词骨架不合规，已就地修复（正文保留）', {
      episode_id: episodeId,
      count: fmtRepaired.length,
      total: saved.length,
      sample: fmtRepaired.slice(0, 3),
    });
  }
  if (fmtFatal.length > 0) {
    log.warn('[分镜] 部分分镜的全能提示词无法修复，已整条换成块格式兜底模板（建议重新生成这几条）', {
      episode_id: episodeId,
      count: fmtFatal.length,
      total: saved.length,
      sample: fmtFatal.slice(0, 3),
    });
  }
  return { saved, formatReport };
}

/**
 * 构建续写 prompt：当首次响应被截断时，携带已生成分镜完整列表 + 末尾详情作为上下文，
 * 请求 AI 从 lastShotNum+1 继续生成剩余分镜。
 * 关键：必须把所有已生成分镜的 shot_number + segment_title + title 全部列出，
 * 防止 AI 因不知道哪些情节已覆盖而重复生成相同内容。
 */
function buildContinuationPrompt(originalUserPrompt, alreadySaved, lastShotNum, attempt, includeNarration, universalOmni = false, cfg = null, requestedCount = null) {
  const narrLine = includeNarration
    ? '\n- 每条新增分镜必须含非空字符串 narration（至少一句解说，与首次任务一致；禁止留空）'
    : '';
  // 全能模式下续写的格式要求，必须与**首轮完全同一套**。
  //
  // 这里原先是一句写死的旧文案：「非空 universal_segment_text（单行：须含「叙事动态」时间线+
  // 「镜头」运镜链至少两步如定镜/缓推轨/横移从遮挡后滑出）」—— 那是**已废弃的灵境/SoulLens
  // 单行格式**，正是 universalOmniMultiBeatFormat 明令禁止、并会被校验器判为脏格式的那一种
  // （实测「真假美猴王」21 镜重生成时就是 21/21 落到该格式）。
  //
  // 本来首轮基本不会触发续写，所以这句一直没暴露；但镜数一多（例如 65 镜）续写是**必然**发生的：
  // 单次响应 16384 token 只够约 24 个分镜（实测 24 镜的原始响应 22684 字），
  // 其余 40 多镜全部走续写 —— 也就是说**大部分分镜**会按这句旧文案去写，跑完才发现格式全是脏的。
  // 现在改为直接复用首轮那份规范，杜绝两处描述再分歧。
  const uniLine = universalOmni
    ? require('./promptI18n').getStoryboardUniversalOmniModeSuffix(cfg || {})
    : '';

  // 还要写多少个：65 镜必须靠 1 次首轮 + 2 次续写凑齐，明确告诉模型剩余数量，
  // 否则它容易只补几个就收尾，最后镜数远少于请求值。
  const remaining = Number(requestedCount) > 0 ? Math.max(0, Number(requestedCount) - alreadySaved.length) : null;
  const remainLine = remaining != null
    ? `\n- 本次请求总镜数为 ${Number(requestedCount)}，已生成 ${alreadySaved.length} 个，**还需约 ${remaining} 个**（不要只补几个就收尾）`
    : '';

  // 全量已生成分镜摘要（每行一个，仅 shot_number + segment + title）
  const allSummary = alreadySaved.map((sb) => {
    const num = sb.shot_number ?? sb.storyboard_number ?? 0;
    const seg = (sb.segment_title || '').replace(/"/g, '\\"');
    const title = (sb.title || '').replace(/"/g, '\\"');
    return `  ${num}. [${seg}] ${title}`;
  }).join('\n');

  // 末尾 5 个分镜的详细内容（供衔接用）
  const lastCtx = alreadySaved.slice(-5).map((sb) => {
    const num = sb.shot_number ?? sb.storyboard_number ?? 0;
    const title = (sb.title || '').replace(/"/g, '\\"');
    const loc = (sb.location || '').replace(/"/g, '\\"');
    const action = (sb.action || '').slice(0, 120).replace(/"/g, '\\"');
    return `  {"shot_number": ${num}, "title": "${title}", "location": "${loc}", "action": "${action}"}`;
  }).join(',\n');

  return `[续写指令 - 第${attempt}次续写]
之前的分镜生成因长度限制在 shot_number ${lastShotNum} 处中断，已生成 ${alreadySaved.length} 个分镜。

━━━ 已生成分镜完整列表（绝对不能重复以下内容）━━━
${allSummary}
━━━ 列表结束 ━━━

以上所有情节均已覆盖，请勿重复。末尾几个分镜详情供衔接参考：
[
${lastCtx}
]

请从 shot_number ${lastShotNum + 1} 继续生成剩余分镜，直至剧本全部场景覆盖完毕。
要求：
- 仅返回新增分镜（JSON数组），shot_number 从 ${lastShotNum + 1} 开始递增
- 格式与之前完全相同，字段保持一致${narrLine}${remainLine}
- 严禁重复已生成列表中的任何情节或场景
- 不要输出任何解释文字，直接输出 JSON${uniLine}

原始剧本与任务说明：
${originalUserPrompt}`;
}

async function processStoryboardGeneration(db, log, cfg, taskId, episodeId, model, style, userPrompt, systemPrompt, includeNarration, universalOmni, targetClipDurationSec = null, requestedCount = null, requestedDuration = null) {
  // 增量保存状态放在 try 外，catch 里可用于部分恢复
  const episodeIdNum = Number(episodeId);
  const streamSavedNums = new Set();
  const streamStyle = (style && String(style).trim()) || cfg?.style?.default_style || '';
  const streamVideoRatio = cfg?.style?.default_video_ratio || '16:9';
  const deriveOpts = {
    universalOmni: !!universalOmni,
    targetClipDuration: targetClipDurationSec != null && Number(targetClipDurationSec) > 0 ? Number(targetClipDurationSec) : null,
    maxClipDuration: targetClipDurationSec != null && Number(targetClipDurationSec) > 0 ? Number(targetClipDurationSec) : null,
  };
  let streamThrottle = 0;

  try {
    taskService.updateTaskStatus(db, taskId, 'processing', 10, '开始生成分镜头...');
    log.info('Processing storyboard generation', { task_id: taskId, episode_id: episodeId });
    log.info('Storyboard prompt preview', {
      user_prompt_len: userPrompt ? userPrompt.length : 0,
      system_prompt_len: systemPrompt ? systemPrompt.length : 0,
      user_prompt_head: userPrompt ? userPrompt.slice(0, 200) : '',
    });
    logDebugStoryboardPrompts(log, `task-${taskId}-initial`, userPrompt, systemPrompt);

    // 提前删除旧分镜，为增量流式保存腾出位置
    const deleteNow = new Date().toISOString();
    db.prepare('UPDATE storyboards SET deleted_at = ? WHERE episode_id = ? AND deleted_at IS NULL').run(deleteNow, episodeIdNum);

    // 不使用 json_mode：response_format:json_object 要求返回 JSON 对象而非数组，会导致模型包装成
    // {"storyboards":[...]} 或产生乱码 key，改由 extractFirstArray 统一处理任意包装格式。
    const text = await generateTextForStoryboard(db, log, userPrompt, systemPrompt, {
      model: model || undefined,
      // 每积累约 400 字符触发一次增量解析，尝试提前保存已完成的分镜
      streamCallback: (accumulated) => {
        if (accumulated.length - streamThrottle < 400) return;
        streamThrottle = accumulated.length;
        tryIncrementalSave(db, log, episodeIdNum, accumulated, streamSavedNums, streamStyle, streamVideoRatio, deriveOpts);
        // 同步更新任务进度（根据已保存分镜数量）
        if (streamSavedNums.size > 0) {
          taskService.updateTaskStatus(db, taskId, 'processing', 30,
            `已解析 ${streamSavedNums.size} 个分镜，生成中...`);
        }
      },
    });

    taskService.updateTaskStatus(db, taskId, 'processing', 50, '分镜头生成完成，正在解析结果...');

    log.info('AI raw response received', {
      task_id: taskId,
      text_type: typeof text,
      text_length: text ? String(text).length : 0,
      text_preview: text ? String(text).slice(0, 2000) : '(empty)',
    });

    let storyboards = [];
    const parseMeta = {};
    try {
      const parsed = safeParseAIJSON(text, null, log, parseMeta);
      storyboards = extractFirstArray(parsed) || [];
    } catch (e) {
      log.error('Parse storyboard JSON failed', {
        error: e.message,
        task_id: taskId,
        text_type: typeof text,
        text_length: text ? String(text).length : 0,
        raw_text: text ? String(text).slice(0, 2000) : '(empty)',
      });

      // 解析失败时，若流式增量保存已有部分分镜，视为截断的部分成功
      if (streamSavedNums.size > 0) {
        const partialBoards = getStoryboardsForEpisode(db, episodeIdNum);
        if (partialBoards.length > 0) {
          const totalDuration = partialBoards.reduce((s, sb) => s + (Number(sb.duration) || 0), 0);
          log.warn('Parse failed but partial storyboards already saved incrementally, treating as truncated success', {
            task_id: taskId, recovered_count: partialBoards.length, parse_error: e.message,
          });
          // 部分恢复也必须带自检 —— 否则「生成其实成功了」的结果里会一片空白
          const partialChecks = await runStoryboardSelfChecks(db, log, episodeIdNum, {
            requestedCount, requestedDuration, styleZh: deriveOpts?.styleZh || '',
          });
          taskService.updateTaskResult(db, taskId, {
            storyboards: partialBoards,
            total: partialBoards.length,
            total_duration: totalDuration,
            duration_minutes: Math.ceil((totalDuration + 59) / 60),
            truncated: true,
            error_message: `AI输出含JSON格式缺陷（${e.message}），已恢复 ${partialBoards.length} 个分镜`,
            dialogue_coverage: partialChecks.dialogueCoverage,
            universal_segment_format: partialChecks.formatReport,
            beat_coverage: partialChecks.beatCoverage,
            quality_report: partialChecks.qualityReport,
          });
          return;
        }
      }

      taskService.updateTaskError(db, taskId, '解析分镜头结果失败: ' + (e.message || ''));
      return;
    }

    if (storyboards.length === 0) {
      // 最终解析为空，但流式已保存了内容，同样回退使用增量结果
      if (streamSavedNums.size > 0) {
        const partialBoards = getStoryboardsForEpisode(db, episodeIdNum);
        if (partialBoards.length > 0) {
          const totalDuration = partialBoards.reduce((s, sb) => s + (Number(sb.duration) || 0), 0);
          log.warn('Final parse returned 0 items but incremental saves exist, using those', {
            task_id: taskId, recovered_count: partialBoards.length,
          });
          taskService.updateTaskResult(db, taskId, {
            storyboards: partialBoards,
            total: partialBoards.length,
            total_duration: totalDuration,
            duration_minutes: Math.ceil((totalDuration + 59) / 60),
            truncated: true,
          });
          return;
        }
      }
      log.error('AI returned 0 storyboards', { task_id: taskId });
      taskService.updateTaskError(db, taskId, 'AI生成分镜失败：返回的分镜数量为0');
      return;
    }

    if (parseMeta.truncated) {
      log.warn('Storyboard JSON was truncated by AI (max_tokens limit), will attempt continuation', {
        task_id: taskId, episode_id: episodeId,
        rescued_count: storyboards.length,
        raw_text_length: text ? String(text).length : 0,
      });
    }
    log.info('Storyboard initial parse', { task_id: taskId, episode_id: episodeId, count: storyboards.length, truncated: parseMeta.truncated || false });

    // ── 自动续写：若 AI 输出被截断，最多续写 3 次直到完整 ──────────────────
    const MAX_CONTINUATION = 3;
    let contAttempt = 0;
    while (parseMeta.truncated && storyboards.length > 0 && contAttempt < MAX_CONTINUATION) {
      contAttempt++;
      const lastShot = Math.max(...storyboards.map(s => Number(s.shot_number ?? s.storyboard_number) || 0));
      log.info('Storyboard continuation start', { task_id: taskId, attempt: contAttempt, last_shot: lastShot, current_count: storyboards.length });
      taskService.updateTaskStatus(db, taskId, 'processing', 50 + contAttempt * 5,
        `已生成 ${storyboards.length} 个分镜，正在续写剩余部分（第${contAttempt}次）...`);

      const contPrompt = buildContinuationPrompt(userPrompt, storyboards, lastShot, contAttempt, !!includeNarration, !!universalOmni, cfg, requestedCount);
      logDebugStoryboardPrompts(log, `task-${taskId}-continuation-${contAttempt}`, contPrompt, systemPrompt);
      streamThrottle = 0; // 重置节流，让续写段落也能增量保存

      // 等待 3 秒后再发续写请求：避免流式请求刚结束服务端连接未释放导致 "socket hang up"
      await new Promise(r => setTimeout(r, 3000));

      let contText;
      try {
        contText = await generateTextForStoryboard(db, log, contPrompt, systemPrompt, {
          model: model || undefined,
          streamCallback: (accumulated) => {
            if (accumulated.length - streamThrottle < 400) return;
            streamThrottle = accumulated.length;
            tryIncrementalSave(db, log, episodeIdNum, accumulated, streamSavedNums, streamStyle, streamVideoRatio, deriveOpts);
          },
        });
      } catch (e) {
        log.warn('Continuation request failed', { task_id: taskId, attempt: contAttempt, error: e.message });
        break;
      }

      const contMeta = {};
      let contItems = [];
      try {
        const contParsed = safeParseAIJSON(contText, null, log, contMeta);
        contItems = extractFirstArray(contParsed) || [];
      } catch (e) {
        log.warn('Continuation parse failed', { task_id: taskId, attempt: contAttempt, error: e.message });
        break;
      }

      if (contItems.length === 0) {
        log.warn('Continuation returned 0 items', { task_id: taskId, attempt: contAttempt });
        break;
      }

      // 按 shot_number 去重，防止 AI 重复已生成的分镜
      const existingNums = new Set(storyboards.map((s) => normalizeStoryboardShotNumber(s)));
      const newItems = contItems.filter((s) => !existingNums.has(normalizeStoryboardShotNumber(s)));
      if (newItems.length === 0) {
        log.warn('Continuation returned only duplicate items', { task_id: taskId, attempt: contAttempt });
        break;
      }

      storyboards = [...storyboards, ...newItems];
      parseMeta.truncated = contMeta.truncated || false;
      log.info('Storyboard continuation done', {
        task_id: taskId, attempt: contAttempt,
        new_items: newItems.length, total_count: storyboards.length, still_truncated: parseMeta.truncated,
      });
    }
    // ── 续写结束 ────────────────────────────────────────────────────────────

    const totalDuration = storyboards.reduce((sum, sb) => sum + (Number(sb.duration) || 0), 0);
    if (parseMeta.truncated) {
      log.warn('Storyboard still truncated after max continuations', {
        task_id: taskId, final_count: storyboards.length, continuation_attempts: contAttempt,
      });
    }
    log.info('Storyboard generated', { task_id: taskId, episode_id: episodeId, count: storyboards.length, total_duration_seconds: totalDuration, truncated: parseMeta.truncated || false, continuation_attempts: contAttempt });

    taskService.updateTaskStatus(db, taskId, 'processing', 70, '正在保存分镜头...');

    // 传入 streamSavedNums：已增量保存的项目直接从 DB 读取，跳过重复 INSERT
    const { saved, formatReport: saveFormatReport } = saveStoryboards(db, log, episodeId, storyboards, cfg, style, streamSavedNums, deriveOpts);

    // ── 分镜角色补全（字符串匹配，无 AI，极快）──────────────────────────────────
    taskService.updateTaskStatus(db, taskId, 'processing', 75, '正在校验分镜角色关联...');
    let totalCharAdded = 0;
    for (const sb of saved) {
      if (!sb?.id) continue;
      const { added } = syncStoryboardCharacters(db, log, sb.id);
      totalCharAdded += added.length;
    }
    if (totalCharAdded > 0) {
      log.info('[分镜] 角色补全完成', { episode_id: episodeId, total_added: totalCharAdded });
    }

    // ── 生成后自检 + 质量报告（正常路径与「部分恢复」路径共用）────────────────────
    // 抽成 runStoryboardSelfChecks 的原因：分镜 JSON 解析失败/连接中断时会走「部分恢复」
    // 分支，那条分支以前直接写一份不含任何自检的结果 —— 实测就出现过「生成实际成功、却因
    // 一处变量作用域错误被降级成部分恢复，所有自检字段全部消失」的情况。自检不能因为
    // 走了哪条分支就消失。
    const selfChecks = await runStoryboardSelfChecks(db, log, episodeIdNum, {
      requestedCount,
      requestedDuration,
      styleZh: deriveOpts?.styleZh || '',
      saveRepaired: saveFormatReport ? saveFormatReport.repaired : 0,
      saveFatal: saveFormatReport ? saveFormatReport.fatal : 0,
    });

    taskService.updateTaskStatus(db, taskId, 'processing', 94, '正在更新剧集时长...');

    const durationMinutes = Math.ceil((totalDuration + 59) / 60);
    db.prepare('UPDATE episodes SET duration = ?, updated_at = ? WHERE id = ?').run(durationMinutes, new Date().toISOString(), Number(episodeId));
    log.info('Episode duration updated', { episode_id: episodeId, duration_seconds: totalDuration, duration_minutes: durationMinutes });

    const resultData = {
      storyboards: saved,
      total: saved.length,
      total_duration: totalDuration,
      duration_minutes: durationMinutes,
      truncated: parseMeta.truncated || false,
      // 剧本台词覆盖率：前端可据此提示「有 N 句台词没进分镜」
      dialogue_coverage: selfChecks.dialogueCoverage,
      // 全能提示词格式自检（骨架修正/无法修复各几条 + 落库后仍不合规几条）
      universal_segment_format: selfChecks.formatReport,
      // 剧情点（叙事节拍）覆盖：LLM 语义判定
      beat_coverage: selfChecks.beatCoverage,
      // 汇总报告：镜数/时长/台词覆盖/格式自检/节拍覆盖 + 一句话结论，供界面「生成质量报告」展示
      quality_report: selfChecks.qualityReport,
    };
    taskService.updateTaskResult(db, taskId, resultData);
    log.info('Storyboard generation completed', { task_id: taskId, episode_id: episodeId });
  } catch (err) {
    log.error('Storyboard generation failed', { error: err.message, task_id: taskId });

    // 若连接中断（ECONNRESET 等）但已通过增量流式保存了部分分镜，视为部分成功而非彻底失败
    if (streamSavedNums.size > 0) {
      try {
        const partialBoards = getStoryboardsForEpisode(db, episodeIdNum);
        if (partialBoards.length > 0) {
          const totalDuration = partialBoards.reduce((s, sb) => s + (Number(sb.duration) || 0), 0);
          log.warn('Partial storyboards recovered after error, treating as truncated success', {
            task_id: taskId, recovered_count: partialBoards.length, error: err.message,
          });
          // 同理：走异常分支也不能让自检消失（实测这里曾把一次成功生成降级成空白结果）
          const errChecks = await runStoryboardSelfChecks(db, log, episodeIdNum, {
            requestedCount, requestedDuration, styleZh: deriveOpts?.styleZh || '',
          });
          taskService.updateTaskResult(db, taskId, {
            storyboards: partialBoards,
            total: partialBoards.length,
            total_duration: totalDuration,
            duration_minutes: Math.ceil((totalDuration + 59) / 60),
            truncated: true,
            error_message: `连接中断（${err.message}），已恢复 ${partialBoards.length} 个分镜`,
            dialogue_coverage: errChecks.dialogueCoverage,
            universal_segment_format: errChecks.formatReport,
            beat_coverage: errChecks.beatCoverage,
            quality_report: errChecks.qualityReport,
          });
          return;
        }
      } catch (_) {}
    }

    taskService.updateTaskError(db, taskId, (err.message || '生成分镜头失败'));
  }
}

/**
 * 生成后的自检 + 质量报告（正常路径与「部分恢复」路径共用）。
 *
 * 抽出来的理由：分镜 JSON 解析失败 / 连接中断时会走「部分恢复」分支，那条分支以前直接
 * 写一份**不含任何自检字段**的结果。实测就踩过：一次生成实际成功了，却因为一处变量作用域
 * 错误（引用了内层函数里不存在的 scriptContent/storyboardCount）被外层 catch 降级成
 * 「部分恢复」，结果里既没有 quality_report 也没有台词覆盖 —— 而日志只显示「连接中断」。
 * 自检不能因为走了哪条分支就消失。
 *
 * 本函数**绝不抛异常**：任何一步失败都记 warn 并返回 null 字段，不影响出片。
 *
 * @param {object} db
 * @param {object} log
 * @param {number} episodeIdNum
 * @param {{requestedCount?:number|null, requestedDuration?:number|null, styleZh?:string,
 *          saveRepaired?:number, saveFatal?:number, stage?:string, skipBeats?:boolean}} [opts]
 *   stage: 'generation' 生成任务结束时 | 'after_polish' 前端润色完成后的复核 | 'manual' 手动重新自检
 *   skipBeats: 跳过剧情点那次 LLM 调用（只做确定性的台词/格式复核）
 */
async function runStoryboardSelfChecks(db, log, episodeIdNum, opts = {}) {
  const requestedCount = opts.requestedCount != null ? Number(opts.requestedCount) : null;
  const requestedDuration = opts.requestedDuration != null ? Number(opts.requestedDuration) : null;

  let storyboards = [];
  try {
    storyboards = getStoryboardsForEpisode(db, episodeIdNum);
  } catch (e) {
    log.warn('[分镜] 自检读取分镜失败（不影响出片）', { episode_id: episodeIdNum, error: e.message });
    return { dialogueCoverage: null, beatCoverage: null, formatReport: null, qualityReport: null };
  }

  let scriptContent = '';
  try {
    const epRow = db.prepare('SELECT script_content FROM episodes WHERE id = ? AND deleted_at IS NULL').get(episodeIdNum);
    scriptContent = (epRow && epRow.script_content) || '';
  } catch (_) { /* 取不到剧本就只能跳过台词/节拍检查 */ }

  // 1) 台词覆盖 —— 确定性字符串比对
  let dialogueCoverage = null;
  try {
    dialogueCoverage = checkDialogueCoverage(scriptContent, storyboards);
    if (dialogueCoverage && dialogueCoverage.missing.length > 0) {
      log.warn('[分镜] 剧本台词未全部覆盖 —— 以下台词在全部分镜里都找不到，必要时请增加分镜数重新生成', {
        episode_id: episodeIdNum,
        total: dialogueCoverage.total,
        covered: dialogueCoverage.covered,
        missing_count: dialogueCoverage.missing.length,
        missing: dialogueCoverage.missing.map((m) => m.line),
      });
    } else if (dialogueCoverage) {
      log.info('[分镜] 剧本台词覆盖率自检通过', { episode_id: episodeIdNum, total: dialogueCoverage.total });
    }
  } catch (e) {
    log.warn('[分镜] 台词覆盖率自检失败（不影响出片）', { episode_id: episodeIdNum, error: e.message });
  }

  // 2) 剧情点（叙事节拍）覆盖 —— LLM 语义判定。为什么不能用规则见 utils/beatCoverageCheck
  let beatCoverage = null;
  try {
    if (opts.skipBeats) {
      // 明确跳过：报告里 beat_total 会是 0，界面显示「未检查」而不是伪造一个结论
    } else {
    beatCoverage = await checkBeatCoverage(db, log, scriptContent, storyboards);
    if (beatCoverage && beatCoverage.missing.length > 0) {
      log.warn('[分镜] 剧情点未全部覆盖 —— 语义判定认为以下剧本节拍没有落到任何分镜（请人工确认，必要时补镜）', {
        episode_id: episodeIdNum,
        total: beatCoverage.total,
        covered: beatCoverage.covered,
        missing: beatCoverage.missing.map((m) => m.beat),
      });
    } else if (beatCoverage) {
      log.info('[分镜] 剧情点覆盖检查通过', { episode_id: episodeIdNum, total: beatCoverage.total });
    }
    }
  } catch (e) {
    log.warn('[分镜] 剧情点覆盖检查失败（不影响出片）', { episode_id: episodeIdNum, error: e.message });
  }

  // 3) 格式：以**库里实际存下来的文本**为准做只读复核（任何路径都能算，包括部分恢复）
  let formatReport = null;
  try {
    const stored = summarizeUniversalSegmentFormat(storyboards, { styleZh: opts.styleZh || '' });
    formatReport = {
      checked: stored.checked,
      noncompliant: stored.noncompliant,
      noncompliant_sample: stored.samples,
      // 镜内剪辑点（H3 原生多镜头）与打斗节奏。这几个 key 必须**逐个列出** ——
      // summarizeUniversalSegmentFormat 的返回值不会自动透传，漏一个在界面上就是 0。
      // 初版就漏了 fight_* 四个，于是页面把 12 个打斗镜显示成「无打斗镜」、报告里
      // 「有多少打斗镜定场过长」也永远是 0（真问题会被静默吞掉）。
      multi_shot: stored.multi_shot,
      cut_total: stored.cut_total,
      fight_total: stored.fight_total,
      fight_cut: stored.fight_cut,
      fight_split_sequence: stored.fight_split_sequence,
      fight_single_beat: stored.fight_single_beat,
      fights_without_cuts: stored.fights_without_cuts,
      fights_without_cuts_sample: stored.fights_without_cuts_samples,
      cuts_without_fight: stored.cuts_without_fight,
      cuts_without_fight_sample: stored.cuts_without_fight_samples,
      // 入库时被自动修复/换成兜底的数量由 saveStoryboards 侧提供；部分恢复路径拿不到，记 0
      repaired: Number(opts.saveRepaired) || 0,
      fatal: Number(opts.saveFatal) || 0,
    };
    if (stored.noncompliant > 0) {
      log.warn('[分镜] 落库后仍有分镜的全能提示词不合规（格式自检没兜住）', {
        episode_id: episodeIdNum,
        noncompliant: stored.noncompliant,
        checked: stored.checked,
        sample: stored.samples,
      });
    }
    if (stored.fights_without_cuts > 0) {
      log.warn('[分镜] 有打斗镜把大部分时长花在定场（交锋只在最后一瞬）——见 checkFightPacing', {
        episode_id: episodeIdNum,
        count: stored.fights_without_cuts,
        sample: stored.fights_without_cuts_samples,
      });
    }
    if (stored.fight_total > 0) {
      log.info('[分镜] 打斗镜构成', {
        episode_id: episodeIdNum,
        fight_total: stored.fight_total,
        cut: stored.fight_cut,
        split_sequence: stored.fight_split_sequence,
        single_beat: stored.fight_single_beat,
      });
    }
  } catch (e) {
    log.warn('[分镜] 提示词格式复核失败（不影响出片）', { episode_id: episodeIdNum, error: e.message });
  }

  // 4) 汇总报告
  let qualityReport = null;
  try {
    qualityReport = buildStoryboardQualityReport({
      storyboards,
      coverage: dialogueCoverage,
      beatCoverage,
      formatReport,
      requestedCount,
      requestedDuration,
      stage: opts.stage || 'generation',
    });
  } catch (e) {
    log.warn('[分镜] 质量报告生成失败（不影响出片）', { episode_id: episodeIdNum, error: e.message });
  }

  return { dialogueCoverage, beatCoverage, formatReport, qualityReport };
}

function generateStoryboard(db, log, episodeId, model, style, storyboardCount, videoDuration, aspectRatio, includeNarration, universalOmni) {
  const cfg = loadConfig();
  const episode = db.prepare(
    'SELECT id, script_content, description, drama_id FROM episodes WHERE id = ? AND deleted_at IS NULL'
  ).get(Number(episodeId));
  if (!episode) {
    throw new Error('剧集不存在或无权限访问');
  }

  // 获取剧集风格和比例（如果未指定，则从 drama metadata / style 中获取完整提示词）
  const drama = db.prepare('SELECT style, metadata FROM dramas WHERE id = ?').get(episode.drama_id);
  const { resolvedStreamStyleFromDrama } = require('../utils/dramaStyleMerge');
  const finalStyle = resolvedStreamStyleFromDrama(style, drama);

  // 图片比例 + 每镜时长：优先用传入值，再从 drama.metadata 读，最后兜底全局配置
  let dramaAspectRatio = null;
  let videoClipDuration = null;
  try {
    if (drama && drama.metadata) {
      const meta = typeof drama.metadata === 'string' ? JSON.parse(drama.metadata) : drama.metadata;
      if (meta && meta.aspect_ratio) dramaAspectRatio = meta.aspect_ratio;
      if (meta && meta.video_clip_duration) videoClipDuration = Number(meta.video_clip_duration) || null;
    }
  } catch (_) {}
  const imageRatio = aspectRatio || dramaAspectRatio || cfg?.style?.default_video_ratio || '16:9';

  // 计算单镜建议时长（秒）：
  // 项目 metadata 中的 video_clip_duration（如 15 秒/段）优先于「总时长÷镜数」，
  // 否则前端同时传总时长+镜数时会把每镜压成过短（与「每段秒数」配置矛盾）。
  // 无项目配置时再使用总时长÷镜数；再否则 null。
  let effectiveShotDuration = null;
  const impliedFromTotal =
    videoDuration && storyboardCount
      ? Math.round(Number(videoDuration) / Number(storyboardCount))
      : null;
  if (videoClipDuration && Number(videoClipDuration) > 0) {
    effectiveShotDuration = Number(videoClipDuration);
  } else if (impliedFromTotal && impliedFromTotal > 0) {
    effectiveShotDuration = impliedFromTotal;
  } else {
    effectiveShotDuration = null;
  }

  let scriptContent = (episode.script_content && String(episode.script_content).trim())
    ? String(episode.script_content)
    : (episode.description && String(episode.description).trim())
      ? String(episode.description)
      : '';
  if (!scriptContent) {
    throw new Error('剧本内容为空，请先生成剧集内容');
  }

  const characters = db.prepare(
    'SELECT id, name FROM characters WHERE drama_id = ? AND deleted_at IS NULL ORDER BY name ASC'
  ).all(episode.drama_id);
  let characterList = '无角色';
  if (characters.length > 0) {
    characterList = '[' + characters.map((c) => `{"id": ${c.id}, "name": "${(c.name || '').replace(/"/g, '\\"')}"}`).join(', ') + ']';
  }

  const scenes = db.prepare(
    'SELECT id, location, time FROM scenes WHERE drama_id = ? AND deleted_at IS NULL ORDER BY location ASC, time ASC'
  ).all(episode.drama_id);
  let sceneList = '无场景';
  if (scenes.length > 0) {
    sceneList = '[' + scenes.map((s) => `{"id": ${s.id}, "location": "${(s.location || '').replace(/"/g, '\\"')}", "time": "${(s.time || '').replace(/"/g, '\\"')}"}`).join(', ') + ']';
  }

  const props = db.prepare(
    'SELECT id, name, type FROM props WHERE drama_id = ? AND deleted_at IS NULL ORDER BY id ASC'
  ).all(episode.drama_id);
  let propList = '无道具';
  if (props.length > 0) {
    propList = '[' + props.map((p) => `{"id": ${p.id}, "name": "${(p.name || '').replace(/"/g, '\\"')}"${p.type ? `, "type": "${p.type.replace(/"/g, '\\"')}"` : ''}}`).join(', ') + ']';
  }

  const scriptLabel = promptI18n.formatUserPrompt(cfg, 'script_content_label');
  const taskLabel = promptI18n.formatUserPrompt(cfg, 'task_label');
  const taskInstruction = promptI18n.formatUserPrompt(cfg, 'task_instruction');
  
  // 处理分镜数量和时长约束
  let extraConstraint = '';
  // 宽松判断：只要有值（包括字符串形式的数字），就尝试转换并添加约束
  if (storyboardCount) {
    const countVal = Number(storyboardCount);
    if (Number.isFinite(countVal) && countVal > 0) {
      const countLabel = promptI18n.formatUserPrompt(cfg, 'storyboard_count_constraint', countVal);
      if (countLabel) extraConstraint += `\n${countLabel}`;
    }
  }
  if (videoDuration) {
    const durationVal = Number(videoDuration);
    if (Number.isFinite(durationVal) && durationVal > 0) {
      const durationLabel = promptI18n.formatUserPrompt(cfg, 'video_duration_constraint', durationVal);
      if (durationLabel) extraConstraint += `\n${durationLabel}`;
    }
  }
  // 当同时指定总时长和数量时，补充单镜 duration 说明（与项目「每段秒数」一致时勿用总÷镜压短）
  if (storyboardCount && videoDuration && effectiveShotDuration) {
    const isEn = promptI18n.isEnglish(cfg);
    const clipFromProject = videoClipDuration && Number(videoClipDuration) > 0;
    const implied =
      impliedFromTotal && impliedFromTotal > 0 ? impliedFromTotal : Math.round(Number(videoDuration) / Number(storyboardCount));
    if (clipFromProject) {
      const clip = Number(videoClipDuration);
      // 「每段秒数」是单镜上限；规划镜数按 min(上限, 8s) 平均折算，避免每个镜头都被顶到上限
      const plan = Math.min(clip, STORYBOARD_PLAN_SECONDS);
      const shotCountHint = storyboardCount ? `（本次约 ${Number(storyboardCount)} 个）` : '';
      if (isEn) {
        extraConstraint += `\nEach shot's "duration" MUST land within **5.2-${clip}s**:\n- **${clip}s is the per-shot CEILING**, not the target for every shot (the target model caps one continuous take at 362 frames = 15.08s)\n- The shot count is planned as total ÷ ${plan}${shotCountHint}, so durations should hover around **${plan}s** — do NOT max out every shot at ${clip}s\n- Shots with room for a full action arc or dialogue may take 10-${clip}s; lighter shots (one gesture, one short line) may take 5.2-7s\n- Do NOT pile several independent actions into one shot just to fill time, and do NOT write content that cannot finish inside ${clip}s — that is the signal to split it into another shot\n- **Floor is 5.2s** (the model's shortest single clip is 124 frames = 5.17s); never go below it\nThe total of all shot durations should come to about ${Number(videoDuration)}s.`;
      } else {
        extraConstraint += `\n每个镜头的 **duration** 必须落在 **5.2-${clip} 秒** 区间内：\n- **${clip} 秒是单镜上限，不是每个镜头的目标值**（目标模型一次连续运镜最长 362 帧 = 15.08 秒）\n- 分镜数按「总时长 ÷ ${plan}」规划${shotCountHint}，所以单镜时长应围绕 **${plan} 秒** 上下浮动，**不要每个镜头都写满 ${clip} 秒**\n- 内容撑得起完整动作弧线或对白的镜头可给 10-${clip} 秒；内容轻的镜头（一个动作、一句短对白）给 5.2-7 秒\n- 不要为填满时长而在一镜里堆砌多个互不相关的动作；也不要写 ${clip} 秒演不完的内容 —— 那是该再拆一个分镜的信号\n- **下限 5.2 秒**（目标模型单镜最短 124 帧 = 5.17 秒），任何镜头都不要更短\n全片所有镜头时长之和约为 ${Number(videoDuration)} 秒。`;
      }
    } else if (isEn) {
      extraConstraint += `\nEach shot target duration: approximately ${effectiveShotDuration}s (= total ${Number(videoDuration)}s ÷ ${Number(storyboardCount)} shots). Set each shot's duration field to this value, adjusting ±1s for dialogue/action length.`;
    } else {
      extraConstraint += `\n每镜头目标时长：约 ${effectiveShotDuration} 秒（= 总时长 ${Number(videoDuration)}s ÷ ${Number(storyboardCount)} 个镜头）。每个镜头的 duration 字段请设为此值，可根据对话/动作长短适当调整 ±1 秒。`;
    }
  }

  log.info('Storyboard generation params', {
    storyboard_count: storyboardCount,
    video_duration: videoDuration,
    video_clip_duration: videoClipDuration,
    effective_shot_duration: effectiveShotDuration,
  });

  const charListLabel = promptI18n.formatUserPrompt(cfg, 'character_list_label');
  const charConstraint = promptI18n.formatUserPrompt(cfg, 'character_constraint');
  const sceneListLabel = promptI18n.formatUserPrompt(cfg, 'scene_list_label');
  const sceneConstraint = promptI18n.formatUserPrompt(cfg, 'scene_constraint');
  const propListLabel = promptI18n.formatUserPrompt(cfg, 'prop_list_label');
  const propConstraint = promptI18n.formatUserPrompt(cfg, 'prop_constraint');
  // 全能模式判断必须在拼后缀**之前**（后缀里的字段清单要据此加上 creation_mode /
  // universal_segment_text —— 模型只认那份清单，见 getStoryboardUserPromptSuffix 注释）
  const wantUniversalOmni = universalOmni === true || universalOmni === 1 || String(universalOmni || '').toLowerCase() === 'true';
  const suffix = promptI18n.getStoryboardUserPromptSuffix(cfg, effectiveShotDuration, { universalOmni: wantUniversalOmni });

  let userPrompt =
    `${scriptLabel}\n${scriptContent}\n\n${taskLabel}\n${taskInstruction}${extraConstraint}\n\n${charListLabel}\n${characterList}\n\n${charConstraint}\n\n${sceneListLabel}\n${sceneList}\n\n${sceneConstraint}\n\n${propListLabel}\n${propList}\n\n${propConstraint}\n\n${suffix}`;

  // 全能模式：把两个必填字段的提醒放在**用户提示词结尾**（模型最后读到的、也是最权威的位置）。
  // 这一条是实测逼出来的 —— 只写在系统提示词末尾时，模型会整批漏掉 universal_segment_text。
  if (wantUniversalOmni) {
    userPrompt += promptI18n.getStoryboardUniversalOmniUserReminder(cfg);
  }

  const wantNarration = includeNarration === true || includeNarration === 1 || String(includeNarration).toLowerCase() === 'true';
  if (wantNarration) {
    userPrompt += promptI18n.getStoryboardNarrationExtraInstructions(cfg);
  }

  let systemPrompt = promptI18n.getStoryboardSystemPrompt(cfg);

  // 当用户指定了分镜数量时，在系统提示词后追加最高优先级覆盖指令，
  // 使"目标数量"优先于默认的"一动作一镜头、禁止合并"原则
  if (storyboardCount && Number(storyboardCount) > 0) {
    const targetCount = Number(storyboardCount);
    const isEn = systemPrompt.includes('[Role]');
    if (isEn) {
      systemPrompt += `\n\n[HIGHEST PRIORITY — USER SPECIFIED COUNT]
The user requires exactly ${targetCount} shots (±10% tolerance is acceptable).
This requirement OVERRIDES the "one action = one shot, no merging" rule above.
You MUST merge related consecutive actions into fewer shots OR split key moments into more shots to reach this target.
Do NOT produce a shot count far from ${targetCount} under any circumstance.`;
    } else {
      systemPrompt += `\n\n【最高优先级——用户指定分镜数量】
用户要求生成恰好 ${targetCount} 个分镜（允许 ±10% 的偏差，即 ${Math.floor(targetCount * 0.9)}~${Math.ceil(targetCount * 1.1)} 个均可接受）。
此要求优先级高于上述所有原则，包括"一动作一镜头、禁止合并"的规则。
- 若动作较多、自然拆分超过目标数量，请将相关联的连续小动作合并为一个镜头
- 若动作较少、自然拆分不足目标数量，请将重要场景或情绪转折拆分为多个镜头
- 严禁生成数量与 ${targetCount} 相差悬殊的分镜方案`;
    }
  }

  if (wantNarration) {
    const isEn = systemPrompt.includes('[Role]');
    if (isEn) {
      systemPrompt += `\n\n[HIGHEST PRIORITY — NARRATION / VO MODE]
The user enabled narrator voice-over for the whole episode. Every shot object MUST include non-empty "narration" (≥1 sentence). Shot 1 MUST have an opening VO hook (time/place/mood). Shots 1 and 2 MUST NOT both have empty narration. Empty "narration" is NOT allowed in this mode.`;
    } else {
      systemPrompt += `\n\n【最高优先级——解说旁白已开启】
用户已开启全片解说：每个分镜的 narration 必须为非空字符串（至少一句）。第 1 镜必须有开场解说。第 1、2 镜禁止同时留空 narration。本模式下不允许 narration 为空。`;
    }
  }

  // ── 必须逐字保留的台词清单（最高优先级）──────────────────────────────────────
  //
  // 这一步此前**从没把台词清单交给模型** —— 只有后续单镜「全能提示词」那一步才有
  // DIALOGUE_VERBATIM 约束，可那时分镜的 dialogue 字段早已定型，丢了就找不回来。
  //
  // 后果实测：「三打白骨精」21 句丢 10 句、「真假美猴王」10 句丢 2 句，而且丢失是静默的
  // —— 不止 dialogue 字段，连 universal_segment_text / video_prompt / action / result 里
  // 都没有，等于整个剧情点不存在。三打白骨精丢的正是「你连杀三人，佛门慈悲何在？」
  // 这类台词，把「唐僧为什么最后要赶走悟空」的因果链挖空了。
  //
  // 成因是容量（实测分镜能承载的台词数 ≈ 1 句/镜）**叠加没被告知台词不可删**：模型合并
  // 节拍时把台词当成了可选项。所以这里把清单摆出来，并明确「不够装就加镜，不许删台词」。
  try {
    const mustKeepDialogue = extractScriptDialogue(scriptContent);
    if (mustKeepDialogue.length > 0) {
      const isEn = systemPrompt.includes('[Role]');
      const items = mustKeepDialogue
        .map((d, i) => `  ${i + 1}. ${d.speaker ? d.speaker + '：' : ''}"${d.line}"`)
        .join('\n');
      systemPrompt += isEn
        ? `\n\n[HIGHEST PRIORITY — VERBATIM DIALOGUE CHECKLIST]
The script contains exactly ${mustKeepDialogue.length} spoken lines. **Every one of them MUST appear verbatim**
(character-for-character) inside some shot's "dialogue" field. Do not reword, summarise, merge or drop any:
${items}
- A line may NOT be paraphrased into narration or action. If you are tempted to summarise it, keep the original words.
- If the shot count is too small to hold them all, **split dialogue-heavy beats into more shots** — that is the
  correct fix. Dropping a line is a hard error.`
        : `\n\n【最高优先级——必须逐字保留的台词清单】
剧本中共有 ${mustKeepDialogue.length} 句对白。**每一句都必须原样（逐字）出现在某一条分镜的 "dialogue" 字段里**，
不得改写、不得概括、不得合并、不得遗漏：
${items}
- 台词**不允许**被改写成 narration 或 action 里的转述。想概括的时候，请保留原话。
- 若分镜数量不足以容纳全部台词，**把对白密集的节拍拆成更多分镜** —— 这才是正确做法；
  删掉台词属于严重错误。`;
      log.info('[分镜] 已注入必保台词清单', {
        episode_id: episodeId,
        dialogue_lines: mustKeepDialogue.length,
      });
    }
  } catch (e) {
    log.warn('[分镜] 注入必保台词清单失败（不影响生成）', { episode_id: episodeId, error: e.message });
  }

  if (wantUniversalOmni) {
    systemPrompt += promptI18n.getStoryboardUniversalOmniModeSuffix(cfg);
  }

  const task = taskService.createTask(db, log, 'storyboard_generation', String(episodeId));
  log.info('Generating storyboard asynchronously', {
    task_id: task.id,
    episode_id: episodeId,
    drama_id: episode.drama_id,
    script_length: scriptContent.length,
    character_count: characters.length,
    scene_count: scenes.length,
    storyboard_count: storyboardCount,
    video_duration: videoDuration,
    universal_omni_storyboard: wantUniversalOmni,
  });

  setImmediate(() => {
    // 传入 imageRatio 同时覆盖 default_video_ratio 和 default_image_ratio，
    // 确保分镜图/视频提示词、场景提取提示词都使用项目设定的比例
    const runCfg = { ...cfg, style: { ...(cfg?.style || {}), default_video_ratio: imageRatio, default_image_ratio: imageRatio } };
    // 如果 model 为 null，则传 undefined，让 generateText 内部去兜底找默认配置
    const clipSec =
      videoClipDuration && Number(videoClipDuration) > 0 ? Number(videoClipDuration) : null;
    processStoryboardGeneration(
      db,
      log,
      runCfg,
      task.id,
      String(episodeId),
      model || undefined,
      finalStyle,
      userPrompt,
      systemPrompt,
      wantNarration,
      wantUniversalOmni,
      clipSec,
      storyboardCount,
      videoDuration
    );
  });

  return { task_id: task.id, status: 'pending', message: '分镜生成任务已创建，正在后台处理...' };
}


function rebuildVideoPromptForStoryboard(db, log, storyboardId) {
  const sbId = Number(storyboardId);
  if (!Number.isFinite(sbId) || sbId <= 0) return null;

  const row = db.prepare(
    `SELECT s.*, e.drama_id
     FROM storyboards s
     JOIN episodes e ON e.id = s.episode_id AND e.deleted_at IS NULL
     WHERE s.id = ? AND s.deleted_at IS NULL`
  ).get(sbId);
  if (!row) return null;

  const loadConfig = require('../config').loadConfig;
  const cfg = loadConfig();
  const drama = row.drama_id
    ? db.prepare('SELECT style, metadata FROM dramas WHERE id = ? AND deleted_at IS NULL').get(row.drama_id)
    : null;
  const { resolvedStreamStyleFromDrama } = require('../utils/dramaStyleMerge');
  const finalStyle = resolvedStreamStyleFromDrama('', drama) || cfg?.style?.default_style || '';

  let dramaAspectRatio = null;
  try {
    if (drama?.metadata) {
      const meta = typeof drama.metadata === 'string' ? JSON.parse(drama.metadata) : drama.metadata;
      if (meta?.aspect_ratio) dramaAspectRatio = meta.aspect_ratio;
    }
  } catch (_) {}

  const videoRatio = dramaAspectRatio || cfg?.style?.default_video_ratio || '16:9';

  let charNames = [];
  if (row.characters) {
    try {
      const arr = typeof row.characters === 'string' ? JSON.parse(row.characters) : row.characters;
      if (Array.isArray(arr)) {
        charNames = arr
          .map((c) => {
            if (typeof c === 'string') return c;
            if (c && typeof c === 'object') return c.name;
            return null;
          })
          .filter(Boolean);
      }
    } catch (_) {}
  }

  function loadCharactersForStoryboardPrompt(db, sbId, names) {
    if (!names || names.length === 0) return [];
    const placeholders = names.map(() => "?").join(",");
    return db.prepare("SELECT * FROM characters WHERE drama_id = (SELECT ep.drama_id FROM storyboards sb JOIN episodes ep ON ep.id = sb.episode_id WHERE sb.id = ?) AND name IN (" + placeholders + ") AND deleted_at IS NULL").all(sbId, ...names);
  }
  const charRows = loadCharactersForStoryboardPrompt(db, sbId, charNames);
  function buildCharacterAppearanceText(db, sbId, names) { return ""; }
  function buildVoiceAnchorMap(rows) { return {}; }
  function buildCharacterVoiceAnchors(db, sbId, names) { return []; }
  const characterAppearances = buildCharacterAppearanceText(db, sbId, charNames);
  const characterVoiceMap = buildVoiceAnchorMap(charRows);
  const characterVoiceAnchors = buildCharacterVoiceAnchors(db, sbId, charNames);

  const sbForPrompt = {
    ...row,
    character_appearances: characterAppearances,
    character_voice_map: characterVoiceMap,
    character_voice_anchors: characterVoiceAnchors,
  };

  const videoPrompt = generateVideoPrompt(sbForPrompt, finalStyle, videoRatio);
  const now = new Date().toISOString();
  db.prepare('UPDATE storyboards SET video_prompt = ?, updated_at = ? WHERE id = ?').run(videoPrompt, now, sbId);

  if (log?.info) {
    log.info('[分镜] 已按最新规则重建 video_prompt', {
      id: sbId,
      len: videoPrompt.length,
      has_voice_anchors: !!characterVoiceAnchors,
    });
  }

  const storyboardService = require('./storyboardService');
  return storyboardService.getStoryboardById(db, sbId);
}

function copyStoryboardAssetLinks(db, fromSbId, toSbId) {
  const from = Number(fromSbId);
  const to = Number(toSbId);
  const now = new Date().toISOString();
  try {
    const chars = db.prepare('SELECT character_id FROM storyboard_characters WHERE storyboard_id = ?').all(from);
    const insC = db.prepare(
      'INSERT OR IGNORE INTO storyboard_characters (storyboard_id, character_id, created_at) VALUES (?, ?, ?)'
    );
    for (const c of chars) insC.run(to, c.character_id, now);
  } catch (_) {}
  try {
    const props = db.prepare('SELECT prop_id FROM storyboard_props WHERE storyboard_id = ?').all(from);
    const insP = db.prepare('INSERT OR IGNORE INTO storyboard_props (storyboard_id, prop_id) VALUES (?, ?)');
    for (const p of props) insP.run(to, p.prop_id);
  } catch (_) {}
}

function durationForSplitSegment(type, text) {
  const w = charSpeechWeight(text);
  if (type === 'narration') return Math.min(12, Math.max(6, Math.round(w + 2)));
  return Math.min(10, Math.max(5, Math.round(w)));
}

function buildSplitPlansFromStoryboard(row) {
  const dialogueEntries = parseDialogueToEntries(row.dialogue);
  const narrationText = row.narration != null ? String(row.narration).trim() : '';
  const segmentCount = dialogueEntries.length + (narrationText ? 1 : 0);
  if (segmentCount < 2) {
    throw new Error('当前分镜仅有一段对白或旁白，无需拆镜');
  }
  if (dialogueEntries.length === 0 && narrationText) {
    throw new Error('仅有旁白无法按对白拆镜');
  }

  const allSpeakers = dialogueEntries.map((d) => d.speaker).filter(Boolean);
  const plans = [];

  for (const { speaker, text } of dialogueEntries) {
    const who = speaker || '角色';
    const others = allSpeakers.filter((n) => n && n !== who);
    const closed = others.length ? others.join('、') : '对方';
    const isReporter = /记者/.test(who) || who === '小雅';
    plans.push({
      type: 'dialogue',
      speaker: who,
      dialogue: `${who}：${text}`,
      narration: null,
      title: `${(row.title || '分镜').trim()}·${who}对白`,
      duration: durationForSplitSegment('dialogue', text),
      action: isReporter
        ? `采访场景，${who}面向对方发问，仅${who}开口说话，${closed}闭口聆听无口型。`
        : `镜头聚焦${who}，仅${who}开口对口型说话，${closed}全程闭口无口型。`,
      result: isReporter ? `${closed}保持静默聆听。` : `${who}完成台词，情绪鲜明。`,
      shot_type: isReporter ? row.shot_type || '中景' : '近景',
      movement: isReporter ? row.movement || '固定' : '推镜',
    });
  }

  if (narrationText) {
    const focus =
      inferPrimaryOnScreenCharacter(
        { action: row.action, result: row.result, title: row.title, dialogue: row.dialogue },
        allSpeakers
      ) || allSpeakers[allSpeakers.length - 1] || '角色';
    plans.push({
      type: 'narration',
      speaker: null,
      dialogue: null,
      narration: narrationText,
      title: `${(row.title || '分镜').trim()}·画外旁白`,
      duration: durationForSplitSegment('narration', narrationText),
      action: `${focus}在画面中保持静止，双唇闭合，无口型，听画外纪录片旁白。`,
      result: `${focus}表情维持强硬自信，无唇动。`,
      shot_type: '近景',
      movement: row.movement || '固定',
    });
  }

  return plans;
}

function persistSplitStoryboardRow(db, episodeId, storyboardNumber, baseRow, plan, now) {
  const info = db.prepare(
    `INSERT INTO storyboards (
      episode_id, scene_id, storyboard_number, title, description, layout_description,
      location, time, duration, dialogue, narration, action, result, atmosphere,
      image_prompt, characters, shot_type, angle, angle_h, angle_v, angle_s,
      movement, lighting_style, depth_of_field, segment_index, segment_title,
      creation_mode, universal_segment_text, status, created_at, updated_at,
      emotion, emotion_intensity
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending', ?, ?, ?, ?)`
  ).run(
    episodeId,
    baseRow.scene_id ?? null,
    storyboardNumber,
    plan.title,
    baseRow.description ?? null,
    baseRow.layout_description ?? null,
    baseRow.location ?? null,
    baseRow.time ?? null,
    plan.duration,
    plan.dialogue,
    plan.narration,
    plan.action,
    plan.result,
    baseRow.atmosphere ?? null,
    baseRow.image_prompt ?? null,
    baseRow.characters ?? null,
    plan.shot_type ?? baseRow.shot_type ?? null,
    baseRow.angle ?? null,
    baseRow.angle_h ?? null,
    baseRow.angle_v ?? null,
    baseRow.angle_s ?? null,
    plan.movement ?? baseRow.movement ?? null,
    baseRow.lighting_style ?? null,
    baseRow.depth_of_field ?? null,
    baseRow.segment_index ?? null,
    baseRow.segment_title ?? null,
    baseRow.creation_mode === 'universal' ? 'universal' : 'classic',
    null,
    now,
    now,
    baseRow.emotion ?? null,
    baseRow.emotion_intensity ?? null
  );
  return info.lastInsertRowid;
}

function updateStoryboardAsSplitSegment(db, sbId, baseRow, plan, now) {
  db.prepare(
    `UPDATE storyboards SET
      title = ?, duration = ?, dialogue = ?, narration = ?, action = ?, result = ?,
      shot_type = ?, movement = ?, universal_segment_text = NULL,
      video_prompt = NULL, video_url = NULL, audio_local_path = NULL,
      narration_audio_local_path = NULL, status = 'pending', updated_at = ?
     WHERE id = ? AND deleted_at IS NULL`
  ).run(
    plan.title,
    plan.duration,
    plan.dialogue,
    plan.narration,
    plan.action,
    plan.result,
    plan.shot_type ?? baseRow.shot_type ?? null,
    plan.movement ?? baseRow.movement ?? null,
    now,
    sbId
  );
}

/**
 * 按对白/旁白拆成多条分镜（每条仅一人说话或仅旁白），解决多角色同镜串音。
 * @returns {{ source_id, storyboard_ids, created_count, plans_summary }}
 */
function splitStoryboardByAudio(db, log, storyboardId) {
  const sbId = Number(storyboardId);
  if (!Number.isFinite(sbId) || sbId <= 0) throw new Error('无效的分镜 id');

  const row = db
    .prepare('SELECT * FROM storyboards WHERE id = ? AND deleted_at IS NULL')
    .get(sbId);
  if (!row) throw new Error('分镜不存在');

  const plans = buildSplitPlansFromStoryboard(row);
  const extraCount = plans.length - 1;
  const now = new Date().toISOString();
  const episodeId = row.episode_id;
  const baseNumber = Number(row.storyboard_number) || 0;

  if (extraCount > 0) {
    db.prepare(
      `UPDATE storyboards SET storyboard_number = storyboard_number + ?, updated_at = ?
       WHERE episode_id = ? AND storyboard_number > ? AND deleted_at IS NULL`
    ).run(extraCount, now, episodeId, baseNumber);
  }

  const storyboardIds = [];
  updateStoryboardAsSplitSegment(db, sbId, row, plans[0], now);
  storyboardIds.push(sbId);

  for (let i = 1; i < plans.length; i++) {
    const newNum = baseNumber + i;
    const newId = persistSplitStoryboardRow(db, episodeId, newNum, row, plans[i], now);
    copyStoryboardAssetLinks(db, sbId, newId);
    storyboardIds.push(newId);
  }

  for (const id of storyboardIds) {
    rebuildVideoPromptForStoryboard(db, log, id);
  }

  const summary = plans.map((p) => `${p.duration}s ${p.title}`).join('；');
  if (log?.info) {
    log.info('[分镜] 按对白拆镜完成', { source_id: sbId, storyboard_ids: storyboardIds, plans: summary });
  }

  const storyboardService = require('./storyboardService');
  return {
    source_id: sbId,
    storyboard_ids: storyboardIds,
    created_count: extraCount,
    plans_summary: summary,
    storyboards: storyboardIds.map((id) => storyboardService.getStoryboardById(db, id)),
  };
}

module.exports = {
  normalizeStoryboardShotNumber,
  dedupeStoryboardRowsByNumber,
  getStoryboardsForEpisode,
  generateStoryboard,
  /** 与分镜入库时一致的「视频提示词」拼装（供经典模式润色等复用） */
  composeStoryboardVideoPrompt: generateVideoPrompt,
  rebuildVideoPromptForStoryboard,
  splitStoryboardByAudio,
  /** 供测试在数据库副本上验证入库行为（返回 { saved, formatReport }） */
  saveStoryboards,
  /** 按需重算自检 + 质量报告（「重新自检」按钮 / 润色完成后的复核都走它） */
  runStoryboardSelfChecks,
  /** 续写提示词（供测试验证「续写的格式要求 == 首轮」——镜数多时续写是必然发生的） */
  buildContinuationPrompt,
  /** 首帧图提示词的机械拼装（供测试：静帧提示词里不得出现运镜/运动） */
  generateImagePrompt,
  extractInitialPose,
  /** 运镜词 / 运动词表（自检与测试直接复用，别再抄一份） */
  CAMERA_MOTION_RE,
  MOTION_WORD_RE,
  /** 单次响应的 token 上限与它换算出的分镜数上限（供测试锁住「65 镜必须靠续写凑齐」这个前提） */
  DEFAULT_STORYBOARD_MAX_TOKENS,
};
