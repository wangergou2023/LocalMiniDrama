/**
 * 全能片段（Omni / Seedance 多图参考）用户消息构建：供「生成」与「润色」共用。
 * @param {import('better-sqlite3').Database} db
 * @param {number} sbId
 * @param {object} reqBody 可选 duration、force_without_reference_images（为 true 时不校验场景/角色/道具是否已上图，仍构建提示词）
 * @param {{ universalSegmentOverride?: string | undefined }} opts 若传入则覆盖库中的 universal 写入 CURRENT_UNIVERSAL_SEGMENT
 * @returns {{ ok:true, userPrompt:string, durationLabel:string, durationSec:number, sbId:number, episodeId:number, storyboardNumber:number } | { ok:false, code:'not_found'|'bad_request', message:string }}
 */
function buildUniversalSegmentUserPromptBundle(db, sbId, reqBody, opts = {}) {
  const {
    pickUniversalLine3, parseCutMarkers, MAX_INTRA_SHOTS, LINE3_NO_SCENE_MULTI,
    detectFightShot, FIGHT_INTRA_SHOTS,
  } = require('./universalOmniMultiBeatFormat');
  const bodyIn = reqBody && typeof reqBody === 'object' ? reqBody : {};
  const forceWithoutReferenceImages = !!bodyIn.force_without_reference_images;

  // MiniMax H3 参考图引用适配：官方 r2va 示例用「参考图N」而非「@图片N」。
  // 判断当前视频默认配置的 provider，若是 MiniMax 则生成/润色时直接教 AI 用「参考图N」。
  let imageRefWord = '@图片';
  try {
    const aiConfigService = require('./aiConfigService');
    const vcfg = aiConfigService.listConfigs(db, 'video');
    const activeV = (vcfg || []).filter((c) => c.is_active);
    const def = activeV.find((c) => c.is_default) || activeV[0] || null;
    const vp = String((def && def.provider) || '').toLowerCase();
    if (vp === 'minimax_h3' || /minimax[-_]?h3/.test(vp)) imageRefWord = '参考图';
  } catch (_) {}
  // 把 /@图片(\d+)/ 里的词替换为 imageRefWord（仅 @图片 -> imageRefWord，数字保留）
  const imgRef = (s) => String(s || '').replace(/@图片/g, imageRefWord);

  const sb = db.prepare(
    `SELECT id, episode_id, storyboard_number, scene_id, title, description, location, time,
      action, dialogue, narration, result, atmosphere,
      image_prompt, polished_prompt, video_prompt, universal_segment_text,
      shot_type, angle, angle_h, angle_v, angle_s, movement, lighting_style, depth_of_field,
      characters, local_path, duration, segment_index, segment_title
     FROM storyboards WHERE id = ? AND deleted_at IS NULL`
  ).get(sbId);
  if (!sb) return { ok: false, code: 'not_found', message: '分镜不存在' };

  let dramaId = null;
  let dramaRow = null;
  try {
    const epRow = db.prepare('SELECT drama_id FROM episodes WHERE id = ? AND deleted_at IS NULL').get(sb.episode_id);
    dramaId = epRow?.drama_id ?? null;
    if (dramaId) {
      dramaRow = db.prepare('SELECT title, genre, style, metadata FROM dramas WHERE id = ? AND deleted_at IS NULL').get(dramaId);
    }
  } catch (_) {}

  let styleZh = '';
  let styleEn = '';
  try {
    const loadConfig = require('../config').loadConfig;
    const { mergeCfgStyleWithDrama } = require('../utils/dramaStyleMerge');
    let cfg = loadConfig();
    cfg = mergeCfgStyleWithDrama(cfg, dramaRow || {});
    styleEn = (cfg?.style?.default_style_en || cfg?.style?.default_style || '').trim();
    styleZh = (cfg?.style?.default_style_zh || '').trim();
  } catch (_) {}

  const chunk = (k, v) => {
    const s = v != null && String(v).trim() ? String(v).trim() : '';
    return s ? `${k}: ${s}` : null;
  };

  const universalForLine =
    opts.universalSegmentOverride !== undefined ? opts.universalSegmentOverride : sb.universal_segment_text;

  const lines = [
    chunk('TITLE', sb.title),
    chunk('DESCRIPTION', sb.description),
    chunk('LOCATION', sb.location),
    chunk('TIME', sb.time),
    chunk('ACTION', sb.action),
    chunk('DIALOGUE', sb.dialogue),
    chunk('NARRATION', sb.narration),
    chunk('RESULT', sb.result),
    chunk('ATMOSPHERE', sb.atmosphere),
    chunk('IMAGE_PROMPT', sb.image_prompt),
    chunk('POLISHED_IMAGE_PROMPT', sb.polished_prompt),
    chunk('VIDEO_PROMPT', sb.video_prompt),
    chunk('SHOT_TYPE', sb.shot_type),
    chunk('ANGLE', sb.angle),
    chunk('ANGLE_H', sb.angle_h),
    chunk('ANGLE_V', sb.angle_v),
    chunk('ANGLE_S', sb.angle_s),
    chunk('MOVEMENT', sb.movement),
    chunk('LIGHTING', sb.lighting_style),
    chunk('DEPTH_OF_FIELD', sb.depth_of_field),
    chunk('CURRENT_UNIVERSAL_SEGMENT', universalForLine),
  ].filter(Boolean);

  const hasMediaRef = (row) =>
    row && (String(row.local_path || '').trim() !== '' || String(row.image_url || '').trim() !== '');

  let sceneRow = null;
  let sceneBlock = '';
  if (sb.scene_id) {
    try {
      sceneRow = db
        .prepare('SELECT location, time, prompt, image_url, local_path FROM scenes WHERE id = ? AND deleted_at IS NULL')
        .get(sb.scene_id);
      if (sceneRow) {
        const scBits = [
          chunk('SCENE_LOCATION', sceneRow.location),
          chunk('SCENE_TIME', sceneRow.time),
          chunk('SCENE_PROMPT', sceneRow.prompt),
          hasMediaRef(sceneRow) ? 'SCENE_HAS_REFERENCE_IMAGE: yes' : 'SCENE_HAS_REFERENCE_IMAGE: no',
        ].filter(Boolean);
        sceneBlock = scBits.join('\n');
      }
    } catch (_) {}
  }

  const charOrderEntries = [];
  const charKeySeen = new Set();
  const pushCharEntry = (key, nameHint) => {
    if (!key || charKeySeen.has(key)) return;
    charKeySeen.add(key);
    charOrderEntries.push({
      key,
      nameHint: nameHint != null && String(nameHint).trim() ? String(nameHint).trim() : '',
    });
  };
  /** 与前端 collectSbOmniReferenceAbsoluteUrls / 视频 API 参考图顺序一致：仅以分镜 characters JSON 的本剧角色顺序为准，避免再追加 storyboard_characters 导致槽位与界面 @图片N 错位。 */
  let charOrderFromDramaJson = false;
  try {
    if (sb.characters) {
      const parsed = JSON.parse(sb.characters);
      if (Array.isArray(parsed)) {
        for (const item of parsed) {
          const cid = typeof item === 'object' && item != null ? item.id : item;
          const idNum = Number(cid);
          if (!Number.isFinite(idNum)) continue;
          const nm =
            typeof item === 'object' && item != null && item.name != null ? String(item.name).trim() : '';
          pushCharEntry(`drama:${idNum}`, nm);
        }
        if (charOrderEntries.length > 0) charOrderFromDramaJson = true;
      }
    }
    if (!charOrderFromDramaJson) {
      const libLinks = db
        .prepare('SELECT character_id FROM storyboard_characters WHERE storyboard_id = ? ORDER BY id ASC')
        .all(sbId);
      for (const link of libLinks) {
        const lid = Number(link.character_id);
        if (!Number.isFinite(lid)) continue;
        pushCharEntry(`lib:${lid}`, '');
      }
    }
  } catch (_) {}

  const charNamesOrdered = [];
  const nameSeen = new Set();
  for (const ent of charOrderEntries) {
    let row = null;
    if (ent.key.startsWith('drama:')) {
      row = db.prepare('SELECT name FROM characters WHERE id = ? AND deleted_at IS NULL').get(Number(ent.key.slice(6)));
    } else if (ent.key.startsWith('lib:')) {
      row = db.prepare('SELECT name FROM character_libraries WHERE id = ? AND deleted_at IS NULL').get(Number(ent.key.slice(4)));
    }
    const nm = (row?.name || ent.nameHint || '').trim();
    if (nm && !nameSeen.has(nm)) {
      nameSeen.add(nm);
      charNamesOrdered.push(nm);
    }
  }
  const charNames = charNamesOrdered.join(', ');

  let propRows = [];
  try {
    propRows =
      db
        .prepare(
          `SELECT p.id, p.name, p.local_path, p.image_url FROM storyboard_props sp
         JOIN props p ON p.id = sp.prop_id AND p.deleted_at IS NULL
         WHERE sp.storyboard_id = ?
         ORDER BY sp.prop_id ASC`
        )
        .all(sbId) || [];
  } catch (_) {
    propRows = [];
  }
  const propNamesOrdered = [];
  const propSeen = new Set();
  for (const r of propRows) {
    const n = r?.name != null && String(r.name).trim() ? String(r.name).trim() : '';
    if (n && !propSeen.has(n)) {
      propSeen.add(n);
      propNamesOrdered.push(n);
    }
  }
  const propNames = propNamesOrdered;

  let prevDesc = '(first shot)';
  let nextDesc = '(last shot)';
  if (sb.episode_id != null && sb.storyboard_number != null) {
    const prevShot = db
      .prepare(
        'SELECT action, location, time FROM storyboards WHERE episode_id = ? AND storyboard_number < ? AND deleted_at IS NULL ORDER BY storyboard_number DESC LIMIT 1'
      )
      .get(sb.episode_id, sb.storyboard_number);
    const nextShot = db
      .prepare(
        'SELECT action, location, time FROM storyboards WHERE episode_id = ? AND storyboard_number > ? AND deleted_at IS NULL ORDER BY storyboard_number ASC LIMIT 1'
      )
      .get(sb.episode_id, sb.storyboard_number);
    if (prevShot) {
      prevDesc =
        (prevShot.action || [prevShot.location, prevShot.time].filter(Boolean).join(' ')).slice(0, 160).trim() ||
        '(first shot)';
    }
    if (nextShot) {
      nextDesc =
        (nextShot.action || [nextShot.location, nextShot.time].filter(Boolean).join(' ')).slice(0, 160).trim() ||
        '(last shot)';
    }
  }

  const slots = [];
  const pushSlot = (kind, summary) => {
    const num = slots.length + 1;
    const brief = String(summary || '').trim() || kind;
    slots.push({ num, tag: `@图片${num}`, kind, summary: brief });
  };
  // 逐张独立：场景、每个角色、每个道具各占一个槽（@图片1、@图片2、@图片3…），
  // 与前端 collectSbOmniReferenceItems（场景→角色→道具，逐张）及视频 API 参考图顺序完全一致；
  // 本地 H3 节点逐张接到 ref_image_0..N，正文 @图片N -> <Picture N>。
  if (sceneRow && hasMediaRef(sceneRow)) {
    pushSlot('场景', String(sceneRow.location || '').trim() || '场景环境');
  }
  const charNameArr = [];
  for (const ent of charOrderEntries) {
    let row = null;
    if (ent.key.startsWith('drama:')) {
      row = db
        .prepare('SELECT name, local_path, image_url FROM characters WHERE id = ? AND deleted_at IS NULL')
        .get(Number(ent.key.slice(6)));
    } else if (ent.key.startsWith('lib:')) {
      row = db
        .prepare('SELECT name, local_path, image_url FROM character_libraries WHERE id = ? AND deleted_at IS NULL')
        .get(Number(ent.key.slice(4)));
    }
    if (!hasMediaRef(row)) continue;
    const nm = String(row.name || ent.nameHint || '角色').trim();
    charNameArr.push(nm);
    if (slots.length >= 9) break; // 视频 API / H3 节点最多 9 张
    pushSlot('角色', nm);
  }
  const propNameArr = [];
  for (const pr of propRows) {
    if (!hasMediaRef(pr)) continue;
    const nm = String(pr.name || '道具').trim();
    if (slots.length >= 9) break;
    propNameArr.push(nm);
    pushSlot('道具', nm);
  }
  const propSlotTags = slots.filter((s) => s.kind === '道具').map((s) => s.tag);

  const charSlots = slots.filter((s) => s.kind === '角色');
  const sceneFirst = slots.length > 0 && slots[0].kind === '场景';
  const charBindingBlock =
    charSlots.length > 0
      ? [
          sceneFirst
            ? 'CHARACTER_IMAGE_BINDING（@图片1 仅为场景/环境；人物从 @图片2 起依次对应下列姓名，勿把人绑在 @图片1）:'
            : 'CHARACTER_IMAGE_BINDING（首张参考图非场景，以 IMAGE_SLOT_MAP 为准；人物与下列 @图片N 一一对应）:',
          ...charSlots.map((s) =>
            sceneFirst
              ? `「${s.summary}」→ ${s.tag}（外貌/动作绑定 ${s.tag} ，示例：${s.tag} 的侧脸；禁止「@图片1 中的${s.summary}」）`
              : `「${s.summary}」→ ${s.tag}（外貌/动作绑定 ${s.tag} ，示例：${s.tag} 的侧脸）`
          ),
        ].join('\n')
      : slots.length === 0 && forceWithoutReferenceImages
        ? [
            'CHARACTER_IMAGE_BINDING（无图强制模式）:',
            '- 尚无已解析的 @图片 槽位；ORDERED_CHARACTER_NAMES 仅用于剧情理解，禁止写成 @姓名 指代参考图。',
            '- 若输出中出现 @图片N，仅表示与将来补图顺序对齐的占位，勿将具体外貌绑定到错误序号。',
          ].join('\n')
        : [
            'CHARACTER_IMAGE_BINDING: 当前无「角色」参考槽位；若出现人物且 @图片1 为场景，勿将人物外貌写在 @图片1。',
          ].join('\n');

  if (slots.length === 0 && !forceWithoutReferenceImages) {
    return {
      ok: false,
      code: 'bad_request',
      message: '请至少为场景、角色或道具上传一张参考图后再生成，以便对应 @图片1、@图片2 与 API 参考顺序一致',
    };
  }

  let imageSlotMapBlock;
  let line3Required;
  // 草稿里已有的**镜内剪辑点**数量：本轮必须保持，否则「润色」会把打斗镜的切拍抹掉，
  // 又退回「一条连续运镜演完 5 拍」的老样子（实测打斗只挤在最后 0.8 秒就是这么来的）。
  const draftCutCount = parseCutMarkers(sb.universal_segment_text).length;
  // 打斗/动作爆发镜：即使草稿还是老的单镜写法，也要切拍 —— 只靠提示词里说「打斗镜可以切拍」
  // 模型会保守地不动（实测 sb349 写着「当头劈下/抄棒横架/火星迸溅」仍输出「单镜头连续画幅」）。
  const fight = detectFightShot(sb);
  const targetCuts = draftCutCount >= 2
    ? Math.min(MAX_INTRA_SHOTS, draftCutCount)          // 已有剪辑点 → 原样保持
    : (fight.fight ? FIGHT_INTRA_SHOTS : 1);             // 没剪辑点 → 打斗镜切 3 拍，其余保持单镜
  const intraShots = Math.max(1, Math.min(MAX_INTRA_SHOTS, targetCuts));
  const isMultiShot = intraShots >= 2;
  const keepingDraftCuts = draftCutCount >= 2;
  const cuttingForFight = !keepingDraftCuts && fight.fight;
  if (slots.length === 0) {
    imageSlotMapBlock = [
      'IMAGE_SLOT_MAP（无图强制模式：尚无已上传场景/角色/道具参考图；视频 API 当前无实际参考图槽位。若正文仍写 @图片N，仅表示与将来补图顺序对齐的占位，出片前须核对）:',
      '（解析结果：无已绑定图像的槽位 — 优先依据剧本与分镜字段写清运镜、节奏与情绪；可不使用 @图片N，或自 @图片1 起预留占位，勿编造与剧本矛盾的细节。）',
    ].join('\n');
    line3Required =
      '当前尚未上传参考图；以剧本与分镜字段书写整段内的运镜与时间轴；若写 @图片N 仅为后续补图预留占位，勿将具体人脸绑定到尚未确定序号的图片；勿编造与剧本矛盾的情节。';
  } else {
    imageSlotMapBlock = [
      'IMAGE_SLOT_MAP（全能模式提交视频时参考图顺序；正文仅可使用下列占位符，与 API 一致）:',
      ...slots.map((s) => `${s.tag} = ${s.kind}「${s.summary}」`),
    ].join('\n');
    // 第3行随本镜是否镜内切镜而变：单镜形态含「须单镜头完整连续画面」，
    // 与正文里的 [Shot 2] At MM:SS.mmm 直接冲突，多镜时必须换成多镜形态。
    // 环境参考约束：给模型逐字引用的一段话（写进 subject_definitions 或 summary）
    line3Required = slots[0].kind === '场景'
      ? `环境、光影与陈设定性参考 ${slots[0].tag}。若 ${slots[0].tag} 为宫格或多画面拼图，禁止成片复刻其分格或并列布局，仅提取统一的空间、光线与氛围语义；须一次生成内的连续画面。`
      : '本片段以首张参考图 <Picture 1> 作为画面锚点展开。';
  }

  const charCount = charNamesOrdered.length;
  const propCount = propNames.length;

  let projectClipSec = 5;
  if (dramaRow?.metadata) {
    try {
      const m = typeof dramaRow.metadata === 'string' ? JSON.parse(dramaRow.metadata) : dramaRow.metadata;
      const v = Number(m?.video_clip_duration);
      if (Number.isFinite(v) && v > 0) projectClipSec = Math.min(120, Math.max(1, v));
    } catch (_) {}
  }
  const body = bodyIn;
  const bodyDurRaw = body.duration != null && body.duration !== '' ? Number(body.duration) : NaN;
  const sbDurRaw = sb.duration != null ? Number(sb.duration) : NaN;
  const durationSec = Number.isFinite(bodyDurRaw) && bodyDurRaw > 0
    ? Math.min(120, Math.max(1, bodyDurRaw))
    : Number.isFinite(sbDurRaw) && sbDurRaw > 0
      ? Math.min(120, Math.max(1, sbDurRaw))
      : projectClipSec;
  const durationLabel = Number.isInteger(durationSec) ? String(durationSec) : String(Math.round(durationSec * 10) / 10);

  const genreHint = (dramaRow?.genre && String(dramaRow.genre).trim()) || '';
  const dramaTitle = (dramaRow?.title && String(dramaRow.title).trim()) || '';
  const styleHintBlock = [
    `STYLE_HINT:`,
    chunk('DRAMA_TITLE', dramaTitle),
    chunk('DRAMA_GENRE', genreHint),
    chunk('STYLE_ZH', styleZh),
    chunk('STYLE_EN', styleEn),
  ]
    .filter(Boolean)
    .join('\n');

  const propRule =
    propSlotTags.length > 0
      ? `- 若本镜绑定了道具（IMAGE_SLOT_MAP 中的「道具」槽：${propSlotTags.join('、')}）：凡在该镜头文案中出现的道具，**必须用其对应的道具槽位符显式引用**（例：${propSlotTags[0]} 帆布包、${propSlotTags[0]} 草图），不得只用文字描写而不引图占位符；道具名与顺序见 ORDERED_PROP_NAMES。若某道具不重要可省略，但重要道具必须指到对应道具槽位。`
      : '- 若本镜未绑定任何道具图，文中禁止凭空写出「道具参考图」占位符。';
  const refContract = [
    'REFERENCE_RULE:',
    ...(slots.length === 0
      ? [
          '- 当前为无图强制模式：视频 API 尚无参考图；可不写 @图片N，若写则仅为补图前占位，出片前须与实际上传顺序一致。',
          '- 禁止用 @场景、@姓名、@道具名 等形式指代参考图；将来有图时须一律改为 @图片N（与 MAP 一致）。',
        ]
      : [
          '- 绑定到某张参考图时，只能写 IMAGE_SLOT_MAP 里列出的 @图片N（阿拉伯数字，如 @图片1、@图片2）。',
          '- 禁止用 @场景、@姓名、@林薇、@道具名 等形式指代参考图；需要指图时一律 @图片N。',
          '- 若 @图片1 为「场景」：只写环境/光影/陈设；人物外貌与动作按 CHARACTER_IMAGE_BINDING 从 @图片2 起。若首张参考图即角色，则以 MAP 为准。',
          '- 场景参考若为四宫格/九宫格等拼图：见 SCENE_REFERENCE_LAYOUT；成片须单镜头连续画面，禁止模仿拼图布局。',
          propRule,
        ]),
    '- 每个 @图片N 与后随的中/英文字之间保留一个半角空格（后处理也会修正，但模型应直接写对）。',
    '- ORDERED_CHARACTER_NAMES 仅供理解剧情，不得当作图占位符。',
    `有图参考槽位数: ${slots.length}；绑定角色数(含无图): ${charCount}；绑定道具数(含无图): ${propCount}`,
  ].join('\n');

  const assetLine = `ORDERED_CHARACTER_NAMES（仅剧情理解）: ${charNames || 'none'}\nORDERED_PROP_NAMES: ${propNames.join(', ') || 'none'}`;

  if (lines.length === 0 && !sceneBlock && !charNames && !propNames.length) {
    return { ok: false, code: 'bad_request', message: '分镜中暂无可用信息，请先填写动作、对白、视频提示词或绑定场景/角色等' };
  }

  const hasSceneSlot = slots.some((s) => s.kind === '场景');
  const sceneLayoutBlock = hasSceneSlot
    ? [
        'SCENE_REFERENCE_LAYOUT（场景参考图可能是多宫格/多视角拼图，仅作内容与空间参考，成片禁止模仿拼图）:',
        '- 场景槽位（通常为 @图片1）常见为四宫格、九宫格或带分割线的多视角场景图：只提取家具、装修、色调、空间关系与光影，不要在提示中引导模型生成「分屏、宫格、多画面并列、复刻参考图网格」。',
        '- 正文里应点明：无成片宫格分屏；参考拼图仅用于理解空间与光线。镜内剪辑点是**真正的剪辑**（不是拼贴），不要把它写成宫格/分屏。',
      ].join('\n')
    : '';

  let episodeScript = '';
  let episodeTableTitle = '';
  try {
    const ep = db.prepare('SELECT script_content, title FROM episodes WHERE id = ? AND deleted_at IS NULL').get(sb.episode_id);
    if (ep) {
      episodeTableTitle = (ep.title && String(ep.title).trim()) || '';
      episodeScript = ep.script_content != null ? String(ep.script_content) : '';
    }
  } catch (_) {}
  const SCRIPT_CAP = 20000;
  if (episodeScript.length > SCRIPT_CAP) {
    episodeScript = `${episodeScript.slice(0, SCRIPT_CAP)}\n...[EPISODE_SCRIPT_TRUNCATED]`;
  }

  let shotPacingBlock = '';
  try {
    const all = db
      .prepare(
        'SELECT id, storyboard_number, segment_index, segment_title FROM storyboards WHERE episode_id = ? AND deleted_at IS NULL ORDER BY storyboard_number ASC'
      )
      .all(sb.episode_id);
    const ix = all.findIndex((r) => Number(r.id) === Number(sb.id));
    const totalShots = all.length || 1;
    const posTag =
      ix <= 0 ? 'first_in_episode' : ix === all.length - 1 ? 'last_in_episode' : 'middle_of_episode';
    const prevSeg = ix > 0 ? String(all[ix - 1].segment_title || '').trim() : '';
    const nextSeg = ix >= 0 && ix < all.length - 1 ? String(all[ix + 1].segment_title || '').trim() : '';
    const currSeg = String(sb.segment_title || '').trim();
    const segChange = ix > 0 && currSeg && prevSeg && currSeg !== prevSeg;
    shotPacingBlock = [
      'SHOT_PACING_AND_POSITION:',
      `TOTAL_CLIP_SECONDS: ${durationLabel}（本条数据库分镜 = 一次成片 API 的整段时长；只写 1 条分镜行）`,
      `INTRA_SHOT_CUTS: ${intraShots}（H3 镜内镜头数；用 [Shot N] At MM:SS.mmm, 记号表达，禁写「分镜2：」行）`,
      `SHOT_ORDER: ${ix >= 0 ? ix + 1 : '?'} / ${totalShots}`,
      `SHOT_POSITION_TAG: ${posTag}`,
      chunk('SEGMENT_TITLE_PREV', prevSeg || null),
      chunk('SEGMENT_TITLE_CURRENT', currSeg || null),
      chunk('SEGMENT_TITLE_NEXT', nextSeg || null),
      segChange
        ? 'BOUNDARY_HINT: 段落标题相对上一镜已变化 → 这是**新分镜条目**的信号，应在分镜层面拆分；不要靠镜内剪辑点来跨段落。'
        : 'BOUNDARY_HINT: 同段落延续 → 优先用运镜与节奏表现时间流动；只有打斗/追击/连招爆发才用镜内剪辑点。',
    ].join('\n');
  } catch (_) {
    shotPacingBlock = [
      'SHOT_PACING_AND_POSITION:',
      `TOTAL_CLIP_SECONDS: ${durationLabel}`,
      'INTRA_SHOT_CUTS: 1（无法读取当前草稿时的保守默认：单镜）',
    ].join('\n');
  }

  let neighborDetailBlock = '';
  try {
    // 取出相邻分镜的完整文案（含 universal_segment_text，用于判断上一镜结尾/下一镜开头的实际动作，避免跨镜重复）
    const prevFull = db
      .prepare(
        `SELECT storyboard_number, title, segment_title, action, result, dialogue, narration, shot_type, movement, atmosphere, universal_segment_text
         FROM storyboards WHERE episode_id = ? AND storyboard_number < ? AND deleted_at IS NULL ORDER BY storyboard_number DESC LIMIT 1`
      )
      .get(sb.episode_id, sb.storyboard_number);
    const nextFull = db
      .prepare(
        `SELECT storyboard_number, title, segment_title, action, result, dialogue, narration, shot_type, movement, atmosphere, universal_segment_text
         FROM storyboards WHERE episode_id = ? AND storyboard_number > ? AND deleted_at IS NULL ORDER BY storyboard_number ASC LIMIT 1`
      )
      .get(sb.episode_id, sb.storyboard_number);
    const fmtN = (row, tag) => {
      if (!row) return `${tag}: (none)`;
      const u = String(row.universal_segment_text || '').trim();
      // 上一镜的结尾(最后一个分镜N行) / 下一镜的开头(第一个分镜N行)：供判别重复边界
      const beats = u.split(/\n/).filter((l) => /^分镜\d+：/.test(l.trim()));
      const lastBeat = beats.length ? beats[beats.length - 1].trim() : '';
      const firstBeat = beats.length ? beats[0].trim() : '';
      const bits = [
        `${tag}:`,
        chunk('N_NUM', row.storyboard_number),
        chunk('N_TITLE', row.title),
        chunk('N_SEGMENT', row.segment_title),
        chunk('N_ACTION', row.action),
        // 上一镜/下一镜的**权威结束状态**。此前只给了 N_ACTION，没给 N_RESULT —— 而
        // 「这一镜结束时到底是什么状态」恰恰写在 result 里。缺了它，写手只能从对方 ust 的
        // 结尾措辞去推断；实测就出过事：镜4 的 result 是「唐僧倒在枯草中昏迷不醒」，
        // 但它的 ust 收尾写成「光圈内空无一人」，镜5 照着 ust 承接，于是把唐僧又演倒了一次。
        chunk('N_RESULT', row.result),
        chunk('N_DIALOGUE', row.dialogue),
        chunk('N_NARRATION', row.narration),
        chunk('N_SHOT_TYPE', row.shot_type),
        chunk('N_MOVEMENT', row.movement),
        chunk('N_ATMOSPHERE', row.atmosphere),
      ].filter(Boolean);
      if (lastBeat) bits.push('N_ENDING_BEAT（上一镜/下一镜的结尾分镜N行，本镜开头禁止重演）: ' + lastBeat.slice(0, 320));
      if (firstBeat) bits.push('N_OPENING_BEAT（上一镜/下一镜的开头分镜N行，仅供衔接参考）: ' + firstBeat.slice(0, 320));
      return bits.join('\n');
    };
    neighborDetailBlock =
      [
        fmtN(prevFull, 'NEIGHBOR_PREV_DETAIL'),
        '',
        fmtN(nextFull, 'NEIGHBOR_NEXT_DETAIL'),
        '',
        'NEIGHBOR_SEQUENCE_RULE（避免与相邻分镜重复，违反即失败）:',
        '- 本分镜的开头（[Shot 1] 或分镜1 正文起句）**严禁**重演 NEIGHBOR_PREV_DETAIL 里上一镜已完成的动作/结局。例如上一镜结尾是「抛刀化寒光射向分身」或「二人对视蓄势」，本镜开头不得再写一遍同样的抛刀/对视。',
        '- 本分镜应在上一镜**结束后的新状态**上继续推进：先一句承接上一镜结果（如「寒光散去/蓄势后」），随即进入本镜自己的新动作，而不是把上一镜的动作再演一次。',
        '- 本分镜结尾也不得提前演出 NEIGHBOR_NEXT_DETAIL 中下一镜的核心动作；相邻两镜的「结束→开始」只做状态承接，不重复同一动作或同一情景整段。',
        '- 若本镜与上一镜题材连续（如「分身围攻」接「破分身」），明确把「上一镜的结果」作为本镜起点，再从该结果派生新动作，避免两镜都在演同一个挥刀/相撞/抛刀的瞬间。',
        '- **衔接依据的优先级（重要）**：判断「上一镜结束时是什么状态」以对方的 **N_ACTION / N_RESULT** 为准（N_RESULT 是权威的结束状态）；N_ENDING_BEAT / N_OPENING_BEAT 只是对方 ust 的**措辞**。两者矛盾时**一律以 N_RESULT 为准**，并按它来承接。例：上一镜 N_RESULT 是「唐僧倒在枯草中昏迷不醒」，而对方 ust 结尾写了「光圈内空无一人」——本镜必须按「唐僧已倒在原地」承接，**不得按「无人」承接，更不得让唐僧再倒一次**。',
      ].join('\n');
  } catch (_) {}

  // 旧的四行块契约（第1行风格/第2行声明/第3行 LINE3/第4行分镜行）已废弃 ——
  // 现在只有 Ref2VA 官方六段结构，契约随之改写（否则「生成/润色」会把六段正文改回旧格式）。
  const multiBeatContract = [
    'REF2VA_CONTRACT（一条 universal_segment_text = 一次生成调用，必须写全官方六段）:',
    '- 六段顺序固定、段名用英文原样：subject_definitions → summary → retention_analysis →' +
      ' detailed_description → overall_soundscape → non_diegetic_music。',
    '- **标签分层**：角色/场景/道具这类可复用可见内容一律建 <Subject N>，并把图片来源写进定义：' +
      '「<Subject 2> 是 <Picture 2> 中的角色「唐僧」——外貌、发型与服装来自该图。」；' +
      '<Picture N> **只在**该图本身充当某镜首帧/关键帧/尾帧/构图锚时才单独列条目。',
    '- retention_analysis 每个标签一行，标记必须是**固定英文值**：可见内容 fully_preserved /' +
      ' partially_preserved / attribute_transfer / weak_reference；音频 fully_copy / partially_copy /' +
      ' reference / weak_reference。本节不写 (Sx)。',
    '- detailed_description 先 1-2 句英文风格句，再逐镜头：[Shot 1] 不带时间戳；' +
      '其后每镜写 [Shot N] At MM:SS.mmm, the camera cuts to …（时间严格递增且小于本镜时长）。' +
      '单镜 5-10 秒目标 200-350 个英文词，构图/主体/环境/动作/运镜/音效/对白都要写全。',
    '- 说话人写 <Subject N> (Sx) says, <d>[Chinese] 台词原文</d>；跨切镜台词两侧写 <scenetrans>，' +
      '片尾截断写 <cutoff>。禁止概括台词。',
    '- 参考音频写成 <Audio j> is the voice-timbre reference for <Subject N> (Sx).；' +
      '只参考音色时不得复述参考音频里的原话。',
    '- non_diegetic_music 本项目不使用背景音乐，写「无（不使用背景音乐）。」',
    `- INTRA_SHOT_CUTS: ${intraShots} —— H3 镜内镜头数。` +
      (keepingDraftCuts
        ? ' 草稿已有这些剪辑点，必须原样保持（数量/编号/时间戳都不许改）。'
        : cuttingForFight
          ? ` **本镜判定为打斗/动作爆发镜（命中：${fight.hits.slice(0, 6).join('、')}）→ 必须切成 ${intraShots} 拍**，` +
            '把定场压进 [Shot 1] 的前 1-2 秒，其余时长全给交锋。'
          : ' 本轮保持单镜（[Shot N] 只有 [Shot 1]）。'),
    '- 镜内切镜**只能**用 [Shot N] At MM:SS.mmm, 记号；[Shot 1] 不带时间戳、后续必须带、最多 4 镜。' +
      '禁止「切镜到」「镜头2」这类叙述性措辞，也禁止「分镜2：」那类行。',
    '- 参考槽位只能用 IMAGE_SLOT_MAP 里的 <Picture N>（阿拉伯数字）；<Picture 1> 是场景，角色从 <Picture 2> 起。',
    '- **状态一致性（硬性）**：收尾状态必须与本镜 ACTION / RESULT 一致；不得把 RESULT 里留在画面内的人写成' +
      '「空无一人」；只在更早镜头发生、现在持续的状态用静态措辞（横卧/静置/已倒/昏迷不醒），禁止用动作措辞' +
      '（倒下/倒地）让模型再演一次。',
    '- 禁止 markdown、英文小标题之外的额外说明行；禁止 @图片N / @人物N / 灵境单行格式。',
  ].join('\n');

  const userPrompt = [
    `TOTAL_CLIP_SECONDS: ${durationLabel}`,
    `DURATION_SECONDS: ${durationLabel}`,
    multiBeatContract,
    shotPacingBlock,
    neighborDetailBlock || null,
    'ENV_REFERENCE_CONSTRAINT（把下面整句逐字写进 subject_definitions 或 summary）:',
    line3Required,
    `EPISODE_SCRIPT:\n${episodeScript || '(本集剧本为空；仅凭分镜与邻镜推断节奏，勿编造大段新剧情)'}`,
    chunk('EPISODE_TABLE_TITLE', episodeTableTitle),
    imageSlotMapBlock,
    sceneLayoutBlock || null,
    charBindingBlock,
    styleHintBlock,
    refContract,
    assetLine,
    sceneBlock || null,
    `CONTEXT_PREV_SHORT: ${prevDesc}`,
    `CONTEXT_NEXT_SHORT: ${nextDesc}`,
    '--- STORYBOARD FIELDS ---',
    ...lines,
  ]
    .filter(Boolean)
    .join('\n');

  const finalPrompt = imgRef(userPrompt);

  return {
    ok: true,
    userPrompt: finalPrompt,
    durationLabel,
    durationSec,
    sbId,
    episodeId: Number(sb.episode_id) || 0,
    storyboardNumber: Number(sb.storyboard_number) || 0,
  };
}

module.exports = { buildUniversalSegmentUserPromptBundle };
