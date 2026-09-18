// 与 Go application/services/frame_prompt_service.go 对齐：生成首帧/关键帧/尾帧/分镜板/动作序列提示词
const loadConfig = require('../config').loadConfig;
const promptI18n = require('./promptI18n');
const aiClient = require('./aiClient');
const taskService = require('./taskService');
const { safeParseAIJSON } = require('../utils/safeJson');
const storyboardService = require('./storyboardService');
const angleService = require('./angleService');
const {
  parseNamesFromAnchorLines,
  sanitizeFramePrompt,
} = require('../utils/framePromptSanitize');

/**
 * 将分镜角度值扩展为带透视含义的完整描述，注入图像提示词上下文
 * 优先使用结构化三元组（angle_h/angle_v/angle_s），降级到旧文本解析
 */
function expandAngleDescription(angle, isEn, angleH, angleV, angleS) {
  if (angleH && angleV && angleS) {
    return isEn
      ? angleService.toPromptFragment(angleH, angleV, angleS)
      : `相机角度：${angleService.toChineseLabel(angleH, angleV, angleS)}`;
  }
  if (angle) {
    if (isEn) return angleService.fromLegacyText(angle, '');
    const { h, v, s } = angleService.parseFromLegacyText(angle, '');
    return `相机角度：${angleService.toChineseLabel(h, v, s)}`;
  }
  return null;
}

/** 旧版兼容：仅传 angle 文本时的快捷调用（保持向后兼容） */
function expandAngleDescriptionLegacy(angle, isEn) {
  if (!angle) return null;
  const a = String(angle).trim().toLowerCase();
  if (isEn) {
    if (a.includes('low') || a.includes('仰')) {
      return "camera angle: low-angle upward shot, background shows sky/ceiling/treetops from below, strong upward perspective distortion";
    }
    if (a.includes('high') || a.includes('俯')) {
      return "camera angle: high-angle downward shot, bird's eye view perspective, background shows ground/floor/scene from above with downward perspective distortion";
    }
    if (a.includes('side') || a.includes('侧')) {
      return "camera angle: side-angle shot, profile composition, background extends laterally";
    }
    if (a.includes('back') || a.includes('背')) {
      return "camera angle: rear shot from behind character, character's back to camera, background scene stretches ahead into the distance";
    }
    return "camera angle: eye-level horizontal shot, normal perspective, straight-on composition";
  } else {
    if (a.includes('仰') || a.includes('low')) {
      return '相机角度：低角度仰拍，背景呈现天空/天花板/树冠的仰视透视效果，视角由下向上倾斜';
    }
    if (a.includes('俯') || a.includes('high')) {
      return '相机角度：高角度俯拍，鸟瞰视角，背景呈现地面/场景的俯视透视效果，视角由上向下倾斜';
    }
    if (a.includes('侧') || a.includes('side')) {
      return '相机角度：侧面视角，侧向构图，背景向两侧水平延展';
    }
    if (a.includes('背') || a.includes('back')) {
      return '相机角度：从角色背后拍摄，角色背对镜头，背景场景在角色前方向远处延伸';
    }
    return '相机角度：平视水平拍摄，正常透视构图，正面取景';
  }
}

const FRAME_TYPES = ['first', 'key', 'last', 'panel', 'action'];

function loadStoryboard(db, storyboardId) {
  const row = db.prepare('SELECT * FROM storyboards WHERE id = ? AND deleted_at IS NULL').get(Number(storyboardId));
  return row
    ? {
        id: row.id,
        description: row.description,
        location: row.location,
        time: row.time,
        dialogue: row.dialogue,
        narration: row.narration,
        action: row.action,
        atmosphere: row.atmosphere,
        result: row.result,
        scene_id: row.scene_id,
        shot_type: row.shot_type,
        angle: row.angle,
        angle_h: row.angle_h,
        angle_v: row.angle_v,
        angle_s: row.angle_s,
        movement: row.movement,
        lighting_style: row.lighting_style,
        depth_of_field: row.depth_of_field,
      }
    : null;
}

/**
 * 将 identity_anchors JSON 转换为适合注入分镜提示词的结构化描述
 * 优先使用结构化锚点，无锚点时 fallback 到 appearance 文本
 */
function cleanAppearanceForIdentity(appText) {
  if (!appText) return '';
  let t = String(appText).trim();
  // 去除服装/衣着/配饰等可变描述（中英文常见表述）—— 保留固定身份特征（脸型、发型、肤质、眼神、气质等）
  const clothingPatterns = [
    /身穿[^，。；\n]*/g,
    /穿着[^，。；\n]*/g,
    /衣着[^，。；\n]*/g,
    /手持[^，。；\n]*/g,
    /戴着[^，。；\n]*/g,
    /围[^，。；\n]*巾/g,
    /服装[^，。；\n]*/g,
    /服饰[^，。；\n]*/g,
    /着装[^，。；\n]*/g,
    / dressed in [^，。；\n]*/gi,
    / wearing [^，。；\n]*/gi,
    / holding [^，。；\n]*/gi,
    /着[^，。；\n]*鞋/g,
  ];
  clothingPatterns.forEach((re) => {
    t = t.replace(re, '');
  });
  // 清理多余标点和空格，保留核心描述
  t = t.replace(/[，、；]\s*[，、；]+/g, '，').replace(/^[，、；\s]+|[，、；\s]+$/g, '').replace(/\s+/g, ' ').trim();
  return t;
}

function buildCharacterAnchorText(name, anchors, appearance) {
  if (anchors && typeof anchors === 'object' && Object.keys(anchors).length > 0) {
    const parts = [`Character: ${name}`];
    if (anchors.face_shape && anchors.face_shape !== 'unspecified') {
      parts.push(`Face: ${anchors.face_shape}`);
    }
    if (anchors.facial_features && anchors.facial_features !== 'unspecified') {
      parts.push(`Features: ${anchors.facial_features}`);
    }
    if (anchors.hair_style && anchors.hair_style !== 'unspecified') {
      parts.push(`Hair: ${anchors.hair_style}`);
    }
    if (anchors.skin_texture && anchors.skin_texture !== 'unspecified') {
      parts.push(`Skin: ${anchors.skin_texture}`);
    }
    if (anchors.color_anchors && typeof anchors.color_anchors === 'object') {
      const colors = Object.entries(anchors.color_anchors)
        .filter(([, v]) => v && v !== 'unspecified')
        .map(([k, v]) => `${k}=${v}`)
        .join(', ');
      if (colors) parts.push(`Colors: ${colors}`);
    }
    if (anchors.unique_marks && anchors.unique_marks !== 'none' && anchors.unique_marks !== 'unspecified') {
      parts.push(`Marks: ${anchors.unique_marks}`);
    }
    return parts.join('; ');
  }
  // fallback: 清洗 appearance，只保留固定身份特征，彻底剔除服装/配饰等可变描述
  const cleaned = cleanAppearanceForIdentity(appearance);
  if (cleaned) {
    return `${name}（${cleaned}）—— 以上为该角色固定视觉身份锚点，生成画面时必须严格以此为基础，禁止添加任何未在此列出的外貌细节（发型/颜色/脸型/气质等）`;
  }
  return name;
}

function loadStoryboardCharacterNames(db, storyboardId) {
  const sid = Number(storyboardId);
  let ids = [];
  let usedExplicitCharactersColumn = false;

  // 以 storyboards.characters（前端勾选）为权威；仅未配置时才回退 storyboard_characters
  try {
    const sbRow = db.prepare('SELECT characters FROM storyboards WHERE id = ? AND deleted_at IS NULL').get(sid);
    if (sbRow?.characters != null && String(sbRow.characters).trim() !== '') {
      const parsed = JSON.parse(sbRow.characters);
      if (Array.isArray(parsed)) {
        usedExplicitCharactersColumn = true;
        for (const item of parsed) {
          if (typeof item === 'object' && item != null && item.id != null) {
            ids.push(Number(item.id));
          } else if (typeof item === 'number' || (typeof item === 'string' && /^\d+$/.test(item))) {
            ids.push(Number(item));
          }
        }
      }
    }
  } catch (_) {}

  if (!usedExplicitCharactersColumn) {
    const links = db.prepare('SELECT character_id FROM storyboard_characters WHERE storyboard_id = ?').all(sid);
    if (links.length) {
      ids = links.map((r) => r.character_id);
    }
  }

  if (!ids.length) {
    if (usedExplicitCharactersColumn) return [];
    // 最后兜底：尝试按名称模糊匹配（某些老数据可能只存了名字）
    try {
      const sbRow = db.prepare('SELECT characters FROM storyboards WHERE id = ? AND deleted_at IS NULL').get(sid);
      if (sbRow?.characters) {
        const raw = String(sbRow.characters);
        // 尝试提取可能的名字（简单处理）
        const nameMatches = raw.match(/[\u4e00-\u9fa5]{2,4}/g) || [];
        if (nameMatches.length) {
          const namePlaceholders = nameMatches.map(() => '?').join(',');
          const nameRows = db.prepare(
            `SELECT id, name, appearance, identity_anchors FROM characters 
             WHERE name IN (${namePlaceholders}) AND deleted_at IS NULL 
             AND drama_id = (SELECT drama_id FROM episodes WHERE id = (SELECT episode_id FROM storyboards WHERE id = ?))`
          ).all(...nameMatches, sid);
          if (nameRows.length) {
            return nameRows.map((r) => {
              let anchors = null;
              if (r.identity_anchors) { try { anchors = JSON.parse(r.identity_anchors); } catch (_) {} }
              return buildCharacterAnchorText(r.name, anchors, r.appearance);
            });
          }
        }
      }
    } catch (_) {}
    return [];
  }

  const placeholders = ids.map(() => '?').join(',');

  let rows = db.prepare(
    `SELECT id, name, appearance, identity_anchors FROM characters WHERE id IN (${placeholders}) AND deleted_at IS NULL`
  ).all(...ids);

  if (!rows || rows.length === 0) {
    rows = db.prepare(
      `SELECT id, name, appearance, identity_anchors FROM character_libraries WHERE id IN (${placeholders}) AND deleted_at IS NULL`
    ).all(...ids);
  }

  return rows.map((r) => {
    let anchors = null;
    if (r.identity_anchors) {
      try { anchors = JSON.parse(r.identity_anchors); } catch (_) {}
    }
    return buildCharacterAnchorText(r.name, anchors, r.appearance);
  });
}

/** 本剧全部角色名（用于从帧提示词中剔除未勾选出场的人物） */
function loadDramaCharacterNamesForStoryboard(db, storyboardId) {
  try {
    const rows = db.prepare(
      `SELECT name FROM characters
       WHERE drama_id = (
         SELECT e.drama_id FROM episodes e
         INNER JOIN storyboards s ON s.episode_id = e.id
         WHERE s.id = ? AND s.deleted_at IS NULL AND e.deleted_at IS NULL
       ) AND deleted_at IS NULL`
    ).all(Number(storyboardId));
    return rows.map((r) => String(r.name || '').trim()).filter(Boolean);
  } catch (_) {
    return [];
  }
}

function loadScene(db, sceneId) {
  if (sceneId == null) return null;
  const row = db.prepare('SELECT id, location, time FROM scenes WHERE id = ? AND deleted_at IS NULL').get(Number(sceneId));
  return row ? { id: row.id, location: row.location, time: row.time } : null;
}

function buildStoryboardContext(cfg, sb, scene, characterNames) {
  const parts = [];
  const styleZh = (cfg?.style?.default_style_zh || '').toString().trim();
  const styleEn = (cfg?.style?.default_style_en || cfg?.style?.default_style || '').toString().trim();
  const isEn = promptI18n.isEnglish(cfg);
  if (isEn) {
    if (styleEn) parts.push(`MANDATORY ART STYLE: ${styleEn}`);
    else if (styleZh) parts.push(`MANDATORY ART STYLE: ${styleZh}`);
  } else if (styleZh) {
    parts.push(`【画风·最高优先级】${styleZh}`);
  } else if (styleEn) {
    parts.push(`【画风·最高优先级】${styleEn}`);
  }

  if (sb.description) {
    parts.push(promptI18n.formatUserPrompt(cfg, 'shot_description_label', sb.description));
  }
  if (scene) {
    parts.push(promptI18n.formatUserPrompt(cfg, 'scene_label', scene.location, scene.time));
  } else if (sb.location || sb.time) {
    parts.push(promptI18n.formatUserPrompt(cfg, 'scene_label', sb.location || '', sb.time || ''));
  }
  const allowedCharNames = parseNamesFromAnchorLines(characterNames);
  if (allowedCharNames.length) {
    const rosterLine = isEn
      ? `【ALLOWED CHARACTERS IN THIS SHOT — ONLY these may appear; NO other people】\n${allowedCharNames.join(', ')}`
      : `【本分镜允许出场的角色（仅此名单，严禁出现名单外的任何其他人物）】\n${allowedCharNames.join('、')}`;
    parts.unshift(rosterLine);
  }
  if (characterNames.length) {
    // 强化角色视觉锚点注入（针对首尾帧一致性问题）
    if (isEn) {
      parts.push(`【CHARACTER VISUAL ANCHORS - MUST USE EXACTLY, DO NOT HALLUCINATE】\n${characterNames.join('\n')}`);
    } else {
      parts.unshift(`【角色视觉锚点 - 最高优先级铁律，必须严格遵守，禁止任何脑补或添加未提供的外貌细节】\n${characterNames.join('\n')}`);
    }
  }
  if (sb.action) {
    parts.push(promptI18n.formatUserPrompt(cfg, 'action_label', sb.action));
  }
  if (sb.result) {
    parts.push(promptI18n.formatUserPrompt(cfg, 'result_label', sb.result));
  }
  if (sb.dialogue) {
    parts.push(promptI18n.formatUserPrompt(cfg, 'dialogue_label', sb.dialogue));
  }
  if (sb.atmosphere) {
    parts.push(promptI18n.formatUserPrompt(cfg, 'atmosphere_label', sb.atmosphere));
  }
  if (sb.shot_type) {
    parts.push(promptI18n.formatUserPrompt(cfg, 'shot_type_label', sb.shot_type));
  }
  if (sb.angle || (sb.angle_h && sb.angle_v && sb.angle_s)) {
    const isEn = promptI18n.isEnglish(cfg);
    const angleDesc = expandAngleDescription(sb.angle, isEn, sb.angle_h, sb.angle_v, sb.angle_s);
    if (angleDesc) parts.push(angleDesc);
  }
  if (sb.movement) {
    parts.push(promptI18n.formatUserPrompt(cfg, 'movement_label', sb.movement));
  }
  return parts.join('\n');
}

function frameKindSuffix(cfg, frameKind) {
  const isEn = promptI18n.isEnglish(cfg);
  if (isEn) {
    if (frameKind === 'first') return 'first frame, static shot';
    if (frameKind === 'key') return 'key frame, dynamic action';
    return 'last frame, final state';
  }
  if (frameKind === 'first') return '首帧静止画面，动作发生前的初始状态';
  if (frameKind === 'key') return '关键帧，动作高潮瞬间';
  return '尾帧静止画面，动作完成后的最终状态';
}

function buildFallbackPrompt(cfg, scene, frameKind) {
  const parts = [];
  const isEn = promptI18n.isEnglish(cfg);
  if (scene) {
    const loc = [scene.location, scene.time].filter(Boolean).join(isEn ? ', ' : '，');
    if (loc) parts.push(loc);
  }
  const style = isEn
    ? (cfg?.style?.default_style_en || cfg?.style?.default_style || '').toString().trim()
    : (cfg?.style?.default_style_zh || cfg?.style?.default_style || '').toString().trim();
  if (style) parts.push(style);
  parts.push(frameKindSuffix(cfg, frameKind));
  return parts.join(isEn ? ', ' : '，');
}

function parseFramePromptJSON(log, aiResponse) {
  try {
    const data = safeParseAIJSON(aiResponse, {}, log);
    if (data && typeof data.prompt === 'string') {
      return { prompt: data.prompt, description: data.description || '' };
    }
  } catch (e) {
    log.warn('Frame prompt JSON parse failed', { error: e.message, response_head: (aiResponse || '').slice(0, 200) });
  }
  return null;
}

function saveFramePrompt(db, log, storyboardId, frameType, prompt, description, layout) {
  const now = new Date().toISOString();
  db.prepare('DELETE FROM frame_prompts WHERE storyboard_id = ? AND frame_type = ?').run(Number(storyboardId), frameType);
  db.prepare(
    `INSERT INTO frame_prompts (storyboard_id, frame_type, prompt, description, layout, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)`
  ).run(Number(storyboardId), frameType, prompt, description ?? null, layout ?? null, now, now);
  log.info('Frame prompt saved', { storyboard_id: storyboardId, frame_type: frameType });
}

async function generateSingleFrame(db, log, cfg, sb, scene, characterNames, model, frameKind, sanitizeOpts = {}) {
  let context = buildStoryboardContext(cfg, sb, scene, characterNames);
  const allowedCharNames = parseNamesFromAnchorLines(characterNames);
  const allDramaNames = sanitizeOpts.allDramaNames || allowedCharNames;

  // 检测本分镜可用的参考图，通知 AI 避免脑补不存在的参考图编号
  try {
    const hasScene = !!(scene?.local_path || scene?.image_url || scene?.image_url);
    const hasChars = allowedCharNames.length > 0;
    const propCount = db.prepare('SELECT COUNT(*) as c FROM storyboard_props WHERE storyboard_id = ?').get(sb.id)?.c || 0;
    const refsAvailable = [];
    if (hasScene) refsAvailable.push('图1=场景（见参考图1）');
    if (hasChars) refsAvailable.push('图2=角色（见参考图2左/右）');
    if (propCount > 0) refsAvailable.push('图3=道具（见参考图3）');
    const refNote = refsAvailable.length
      ? `【可用参考图】仅以下图片存在：${refsAvailable.join('；')}。严禁使用不在此列表中的参考图编号（如无道具则不得写「见参考图3」）。`
      : `【可用参考图】本分镜无任何参考图，prompt 中严禁出现「见参考图1/2/3」等标记。`;
    context = context + '\n\n' + refNote;
  } catch (_) {}

  const systemKey = frameKind === 'first' ? 'getFirstFramePrompt' : frameKind === 'key' ? 'getKeyFramePrompt' : 'getLastFramePrompt';
  const userKey = frameKind === 'first' ? 'frame_info' : frameKind === 'key' ? 'key_frame_info' : 'last_frame_info';
  const systemPrompt = promptI18n[systemKey](cfg);
  const userPrompt = promptI18n.formatUserPrompt(cfg, userKey, context);

  // ── 调试日志：打印完整提示词，方便确认角度/视角是否正确注入 ──
  log.info('[帧提示词] ===== generateSingleFrame DEBUG =====', {
    frame_kind: frameKind,
    storyboard_id: sb?.id,
    angle: sb?.angle,
    shot_type: sb?.shot_type,
    movement: sb?.movement,
  });
  log.info('[帧提示词] CONTEXT (角色/场景/角度上下文):\n' + context);
  log.info('[帧提示词] SYSTEM PROMPT:\n' + systemPrompt);
  log.info('[帧提示词] USER PROMPT:\n' + userPrompt);
  log.info('[帧提示词] ==========================================');

  let aiResponse;
  try {
    aiResponse = await aiClient.generateText(db, log, 'text', userPrompt, systemPrompt, {
      model: model || undefined,
      max_tokens: 2400,
    });
  } catch (err) {
    log.warn('Frame prompt AI failed, using fallback', { error: err.message });
    const prompt = buildFallbackPrompt(cfg, scene, frameKind);
    const desc =
      frameKind === 'first'
        ? '镜头开始的静态画面，展示初始状态'
        : frameKind === 'key'
          ? '动作高潮瞬间，展示关键动作'
          : '镜头结束画面，展示最终状态和结果';
    return { prompt, description: desc };
  }
  log.info('[帧提示词] AI RAW RESPONSE:\n' + (aiResponse || '(empty)'));
  const parsed = parseFramePromptJSON(log, aiResponse);
  if (parsed) {
    const cleanedPrompt = sanitizeFramePrompt(parsed.prompt, allowedCharNames, allDramaNames, {
      log,
      source: 'frame_prompt_generation',
      storyboard_id: sb?.id,
      frame_kind: frameKind,
    });
    log.info('[帧提示词] PARSED RESULT prompt:\n' + cleanedPrompt);

    // 身体道具注入：从分镜关联的道具中提取角色→道具映射，注入角色括号
    let finalPrompt = cleanedPrompt;
    try {
      const propLinks = db.prepare('SELECT prop_id FROM storyboard_props WHERE storyboard_id = ?').all(sb.id);
      for (const pl of propLinks) {
        const prop = db.prepare('SELECT name FROM props WHERE id = ? AND deleted_at IS NULL').get(pl.prop_id);
        if (!prop?.name) continue;
        const parts = prop.name.split('的');
        const charName = parts[0].trim();
        const propName = parts.slice(1).join('的').trim() || prop.name;
        if (charName.length < 2) continue; // 单字不是角色名
        if (!finalPrompt.includes(charName + '（见参考图2')) continue;
        if (finalPrompt.includes(charName + '（见参考图2') && finalPrompt.includes('见参考图3')) continue;
        finalPrompt = finalPrompt.replace(
          new RegExp(charName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '（见参考图2([^）]*)）', 'g'),
          charName + '（见参考图2$1，见参考图3）'
        );
      }
    } catch (e) {
      log.warn('[帧提示词] 道具注入失败（继续）', { error: e.message });
    }

    return { ...parsed, prompt: finalPrompt };
  }
  const fallback = buildFallbackPrompt(cfg, scene, frameKind);
  log.warn('[帧提示词] JSON 解析失败，使用 FALLBACK prompt:\n' + fallback);
  return {
    prompt: fallback,
    description: frameKind === 'last' ? '镜头结束画面，展示最终状态和结果' : frameKind === 'key' ? '动作高潮瞬间，展示关键动作' : '镜头开始的静态画面，展示初始状态',
  };
}

async function processFramePromptGeneration(db, log, taskId, storyboardId, frameType, panelCount, model) {
  let cfg = loadConfig();
  taskService.updateTaskStatus(db, taskId, 'processing', 0, '正在生成帧提示词...');

  const sb = loadStoryboard(db, storyboardId);
  if (!sb) {
    taskService.updateTaskError(db, taskId, '分镜信息不存在');
    log.error('Frame prompt: storyboard not found', { storyboard_id: storyboardId });
    return;
  }

  // 通过 storyboard → episode → drama 链路读取项目 style 和 aspect_ratio
  try {
    const epRow = db.prepare(
      'SELECT drama_id FROM episodes WHERE id = (SELECT episode_id FROM storyboards WHERE id = ? AND deleted_at IS NULL) AND deleted_at IS NULL'
    ).get(Number(storyboardId));
    if (epRow && epRow.drama_id) {
      const dramaRow = db.prepare('SELECT style, metadata FROM dramas WHERE id = ? AND deleted_at IS NULL').get(epRow.drama_id);
      if (dramaRow) {
        const { mergeCfgStyleWithDrama } = require('../utils/dramaStyleMerge');
        let next = { ...cfg, style: { ...(cfg?.style || {}) } };
        if (dramaRow.metadata) {
          const meta = typeof dramaRow.metadata === 'string' ? JSON.parse(dramaRow.metadata) : dramaRow.metadata;
          if (meta && meta.aspect_ratio) {
            next.style.default_image_ratio = meta.aspect_ratio;
            next.style.default_video_ratio = meta.aspect_ratio;
          }
        }
        cfg = mergeCfgStyleWithDrama(next, dramaRow);
      }
    }
  } catch (_) {}

  const scene = loadScene(db, sb.scene_id);
  const characterNames = loadStoryboardCharacterNames(db, storyboardId);
  const allDramaNames = loadDramaCharacterNamesForStoryboard(db, storyboardId);
  const sanitizeOpts = { allDramaNames };

  // 强调试日志：确认角色视觉锚点是否成功加载（用于排查“黑发扎马尾”等脑补问题）
  log.info('[帧提示词] 角色视觉锚点加载结果', {
    storyboard_id: storyboardId,
    character_count: characterNames.length,
    characters_preview: characterNames.length ? characterNames.map(c => c.substring(0, 120) + (c.length > 120 ? '...' : '')).join(' | ') : '(无关联角色或加载失败)'
  });

  const storyboardIdStr = String(storyboardId);
  let combinedPrompt = '';
  let description = '';
  let layout = '';

  try {
    if (frameType === 'first' || frameType === 'key' || frameType === 'last') {
      const frameKind = frameType;
      const single = await generateSingleFrame(db, log, cfg, sb, scene, characterNames, model, frameKind, sanitizeOpts);
      saveFramePrompt(db, log, storyboardId, frameType, single.prompt, single.description, '');
      combinedPrompt = single.prompt;
      description = single.description;
    } else if (frameType === 'panel') {
      const count = panelCount || 3;
      layout = `horizontal_${count}`;
      const prompts = [];
      if (count === 3) {
        const first = await generateSingleFrame(db, log, cfg, sb, scene, characterNames, model, 'first', sanitizeOpts);
        const key = await generateSingleFrame(db, log, cfg, sb, scene, characterNames, model, 'key', sanitizeOpts);
        const last = await generateSingleFrame(db, log, cfg, sb, scene, characterNames, model, 'last', sanitizeOpts);
        prompts.push(first.prompt, key.prompt, last.prompt);
        description = '分镜板组合提示词';
      } else if (count === 4) {
        const first = await generateSingleFrame(db, log, cfg, sb, scene, characterNames, model, 'first', sanitizeOpts);
        const key1 = await generateSingleFrame(db, log, cfg, sb, scene, characterNames, model, 'key', sanitizeOpts);
        const key2 = await generateSingleFrame(db, log, cfg, sb, scene, characterNames, model, 'key', sanitizeOpts);
        const last = await generateSingleFrame(db, log, cfg, sb, scene, characterNames, model, 'last', sanitizeOpts);
        prompts.push(first.prompt, key1.prompt, key2.prompt, last.prompt);
        description = '分镜板组合提示词';
      } else {
        prompts.push((await generateSingleFrame(db, log, cfg, sb, scene, characterNames, model, 'first', sanitizeOpts)).prompt);
        for (let i = 0; i < count - 2; i++) {
          prompts.push((await generateSingleFrame(db, log, cfg, sb, scene, characterNames, model, 'key', sanitizeOpts)).prompt);
        }
        prompts.push((await generateSingleFrame(db, log, cfg, sb, scene, characterNames, model, 'last', sanitizeOpts)).prompt);
        description = '分镜板组合提示词';
      }
      combinedPrompt = prompts.join('\n---\n');
      saveFramePrompt(db, log, storyboardId, frameType, combinedPrompt, description, layout);
    } else if (frameType === 'action') {
      layout = 'horizontal_5';
      const first = await generateSingleFrame(db, log, cfg, sb, scene, characterNames, model, 'first', sanitizeOpts);
      const key1 = await generateSingleFrame(db, log, cfg, sb, scene, characterNames, model, 'key', sanitizeOpts);
      const key2 = await generateSingleFrame(db, log, cfg, sb, scene, characterNames, model, 'key', sanitizeOpts);
      const key3 = await generateSingleFrame(db, log, cfg, sb, scene, characterNames, model, 'key', sanitizeOpts);
      const last = await generateSingleFrame(db, log, cfg, sb, scene, characterNames, model, 'last', sanitizeOpts);
      combinedPrompt = [first.prompt, key1.prompt, key2.prompt, key3.prompt, last.prompt].join('\n---\n');
      description = '动作序列组合提示词';
      saveFramePrompt(db, log, storyboardId, frameType, combinedPrompt, description, layout);
    } else {
      taskService.updateTaskError(db, taskId, '不支持的帧类型');
      log.error('Frame prompt: unsupported frame_type', { frame_type: frameType });
      return;
    }

    taskService.updateTaskResult(db, taskId, {
      storyboard_id: storyboardIdStr,
      frame_type: frameType,
      response: { frame_type: frameType, single_frame: combinedPrompt ? { prompt: combinedPrompt, description } : undefined, layout: layout || undefined },
    });
    log.info('Frame prompt generation completed', { task_id: taskId, storyboard_id: storyboardId, frame_type: frameType });
  } catch (err) {
    log.error('Frame prompt generation error', { task_id: taskId, error: err.message });
    taskService.updateTaskError(db, taskId, err.message || '生成失败');
  }
}

function generateFramePrompt(db, log, storyboardId, frameType, panelCount, model) {
  const sid = Number(storyboardId);
  const sb = db.prepare('SELECT id FROM storyboards WHERE id = ? AND deleted_at IS NULL').get(sid);
  if (!sb) {
    throw new Error('分镜不存在');
  }
  const validTypes = FRAME_TYPES.includes(frameType);
  if (!validTypes) {
    throw new Error('不支持的 frame_type，可选: first, key, last, panel, action');
  }
  const task = taskService.createTask(db, log, 'frame_prompt_generation', String(storyboardId));
  setImmediate(() => {
    processFramePromptGeneration(db, log, task.id, storyboardId, frameType, panelCount || 0, model);
  });
  log.info('Frame prompt task created', { task_id: task.id, storyboard_id: storyboardId, frame_type: frameType });
  return task.id;
}

module.exports = {
  generateFramePrompt,
  saveFramePrompt,
  loadStoryboard,
  loadStoryboardCharacterNames,
  loadDramaCharacterNamesForStoryboard,
  loadScene,
  buildCharacterAnchorText,
  getFramePrompts: (db, storyboardId) => storyboardService.getFramePrompts(db, storyboardId),
  generateSingleFrameExported: generateSingleFrame,
  expandAngleDescription,
};

