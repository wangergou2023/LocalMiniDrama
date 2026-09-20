// 与 Go ImageGenerationService.ExtractBackgroundsForEpisode + processBackgroundExtraction 对齐
const taskService = require('./taskService');
const aiClient = require('./aiClient');
const promptI18n = require('./promptI18n');
const sceneService = require('./sceneService');
const { safeParseAIJSON, extractFirstArray } = require('../utils/safeJson');

function normalizeLanguage(language) {
  const lang = (language || '').toString().trim().toLowerCase();
  return lang === 'zh' || lang === 'en' ? lang : '';
}

function hasChinese(text) {
  return /[\u4e00-\u9fff]/.test(text || '');
}

function withLanguage(cfg, language) {
  if (!language) return cfg;
  return {
    ...cfg,
    app: { ...(cfg?.app || {}), language },
  };
}

async function translatePromptToChinese(db, log, model, prompt) {
  const userPrompt =
    '请将以下场景图像提示词翻译为中文，保留风格词或比例（如 realistic、16:9）原样，直接返回翻译后的中文提示词，不要解释：\n' +
    prompt;
  const text = await aiClient.generateText(db, log, 'text', userPrompt, '', {
    scene_key: 'scene_extraction',
    model: model || undefined,
    temperature: 0.2,
    max_tokens: 400,
  });
  return (text || '').toString().trim();
}

/**
 * 把本剧已有场景清单拼进提取提示词（纯数据块）。
 * 目的：同一地点让模型沿用完全相同的 location / time 写法，
 * 否则「河边」与「河边不远处」会被当成两个地点，跨集复用就断在这里。
 */
function buildExistingScenesHint(existingScenes, language) {
  // 同一地点在多集里会各有一行 → 按「地点+时间」去重，重复时保留带图的那条，清单更短更准
  const seen = new Map();
  const list = [];
  for (const s of (existingScenes || [])) {
    if (!s || !String(s.location || '').trim()) continue;
    const key = sceneService.normalizeSceneLocationKey(s.location) + '|' + String(s.time || '').trim();
    if (seen.has(key)) {
      const pos = seen.get(key);
      const prevHasImg = !!(list[pos].image_url || list[pos].local_path);
      if (!prevHasImg && (s.image_url || s.local_path)) list[pos] = s;
      continue;
    }
    seen.set(key, list.length);
    list.push(s);
  }
  if (list.length === 0) return '';
  const en = language === 'en';
  const header = en
    ? '[Existing locations already used in this drama — if the location below is the same place, reuse exactly the same location and time wording]'
    : '【本剧已有场景 — 若与下面地点是同一处，请沿用完全相同的 location 与 time 写法】';
  const lines = list.map((s, i) => {
    const noImg = s.image_url || s.local_path ? '' : (en ? ' (no image yet)' : '（尚无图）');
    return `${i + 1}. ${String(s.location).trim()}${s.time ? ' / ' + String(s.time).trim() : ''}${noImg}`;
  });
  return header + '\n' + lines.join('\n') + '\n\n';
}

async function extractBackgroundsFromScript(db, cfg, log, scriptContent, dramaId, model, style, existingScenes) {
  if (!scriptContent || !scriptContent.trim()) return [];
  const systemPrompt = promptI18n.getSceneExtractionPrompt(cfg, style);
  const hint = buildExistingScenesHint(existingScenes, promptI18n.getLanguage(cfg));
  const prompt = hint + (promptI18n.getLanguage(cfg) === 'en' ? '[Script Content]\n' : '【剧本内容】\n') + scriptContent;
  console.log('systemPrompt', systemPrompt);
  console.log('prompt', prompt);
  const text = await aiClient.generateText(db, log, 'text', prompt, systemPrompt, { scene_key: 'scene_extraction', model: model || undefined, temperature: 0.7 });
  let list = [];
  try {
    const parsed = safeParseAIJSON(text, log);
    list = extractFirstArray(parsed) || [];
  } catch (_) {
    list = [];
  }
  return list.map((b) => ({
    location: b.location || '',
    time: b.time || '',
    prompt: b.prompt || '',
    atmosphere: b.atmosphere,
  }));
}

async function processBackgroundExtraction(db, cfg, log, taskID, episodeId, model, style, language) {
  taskService.updateTaskStatus(db, taskID, 'processing', 0, '正在提取场景信息...');
  const episode = db.prepare('SELECT id, drama_id, script_content FROM episodes WHERE id = ? AND deleted_at IS NULL').get(Number(episodeId));
  if (!episode) {
    taskService.updateTaskStatus(db, taskID, 'failed', 0, '剧集信息不存在');
    return;
  }
  const scriptContent = episode.script_content;
  if (!scriptContent || !String(scriptContent).trim()) {
    taskService.updateTaskStatus(db, taskID, 'failed', 0, '剧本内容为空');
    return;
  }

  // 合并风格：显式 style 参数优先（一般为前端传来的英文 prompt）；否则用剧集 metadata 中的完整提示词
  let effectiveCfg = cfg;
  try {
    const dramaRow = db.prepare('SELECT style, metadata FROM dramas WHERE id = ? AND deleted_at IS NULL').get(episode.drama_id);
    const { mergeCfgStyleWithDrama } = require('../utils/dramaStyleMerge');
    const paramStyle = (style && String(style).trim()) || '';
    let next = { ...cfg, style: { ...(cfg?.style || {}) } };
    if (dramaRow?.metadata) {
      const meta = typeof dramaRow.metadata === 'string' ? JSON.parse(dramaRow.metadata) : dramaRow.metadata;
      if (meta?.aspect_ratio) next.style.default_image_ratio = meta.aspect_ratio;
    }
    if (paramStyle) {
      next.style = {
        ...next.style,
        default_style_zh: paramStyle,
        default_style_en: paramStyle,
        default_style: paramStyle,
      };
      effectiveCfg = next;
    } else {
      effectiveCfg = mergeCfgStyleWithDrama(next, dramaRow);
    }
    style = paramStyle || effectiveCfg?.style?.default_style_en || effectiveCfg?.style?.default_style || style;
  } catch (_) {}

  const requestedLanguage = normalizeLanguage(language);
  const configuredLanguage = normalizeLanguage(promptI18n.getLanguage(effectiveCfg));
  let effectiveLanguage = requestedLanguage || configuredLanguage;
  if (!requestedLanguage && effectiveLanguage === 'en' && hasChinese(scriptContent)) {
    effectiveLanguage = 'zh';
  }
  const cfgForPrompt = withLanguage(effectiveCfg, effectiveLanguage);
  // 本剧其它剧集已有的场景（含图片）：既给模型对齐命名，也用于本次建行时复用图与提示词
  let existingScenes = [];
  try {
    existingScenes = sceneService
      .listByDramaId(db, episode.drama_id)
      .filter((s) => Number(s.episode_id) !== Number(episodeId));
  } catch (e) {
    log.warn('读取本剧已有场景失败（本次不做跨集复用）', { error: e.message, drama_id: episode.drama_id });
  }

  let backgroundsInfo;
  try {
    backgroundsInfo = await extractBackgroundsFromScript(
      db,
      cfgForPrompt,  // 已包含 effectiveCfg + language
      log,
      String(scriptContent),
      episode.drama_id,
      model,
      style,  // 作为 prompt 追加（extractBackgroundsFromScript 内部会用到）
      existingScenes
    );
  } catch (err) {
    log.error('Background extraction AI failed', { error: err.message, task_id: taskID });
    taskService.updateTaskStatus(db, taskID, 'failed', 0, 'AI提取场景失败: ' + err.message);
    return;
  }
  if (effectiveLanguage === 'zh') {
    const translated = await Promise.all(
      (backgroundsInfo || []).map(async (bg) => {
        const original = (bg.prompt || '').toString().trim();
        if (!original || hasChinese(original)) return bg;
        try {
          const translatedPrompt = await translatePromptToChinese(db, log, model, original);
          if (!translatedPrompt) return bg;
          return { ...bg, prompt: translatedPrompt };
        } catch (err) {
          log.warn('Background prompt translate failed', { error: err.message, task_id: taskID });
          return bg;
        }
      })
    );
    backgroundsInfo = translated;
  }
  sceneService.deleteScenesByEpisodeId(db, log, episodeId);
  const scenes = [];
  for (const bg of backgroundsInfo) {
    // 同一地点在本剧更早的剧集里已有场景（可能已生成图）→ 复用它的提示词与图片，
    // 不重新生成；找不到才当作新场景。
    const reusable = sceneService.findReusableScene(db, episode.drama_id, {
      location: bg.location,
      time: bg.time,
      excludeEpisodeId: episodeId,
    });
    const scene = sceneService.createSceneForEpisode(db, log, episode.drama_id, episodeId, {
      location: bg.location,
      time: bg.time,
      prompt: bg.prompt,
      inherit_from_scene_id: reusable ? reusable.id : null,
    });
    if (scene) {
      scenes.push(scene);
      // polished_prompt 是完整四视图图片提示词，提取后始终为空，需要异步预生成；
      // 已复用既有场景时它随图一起继承过来了，不必再生成。
      if (effectiveCfg && !reusable) {
        const capturedStyle = style;
        setImmediate(() => {
          sceneService.generateScenePromptOnly(db, log, effectiveCfg, scene.id, undefined, capturedStyle).catch((err) => {
            log.warn('[提取场景] 预生成polished_prompt失败', { scene_id: scene.id, error: err.message });
          });
        });
      }
    }
  }
  taskService.updateTaskResult(db, taskID, {
    scenes,
    count: scenes.length,
    episode_id: episodeId,
    drama_id: episode.drama_id,
  });
  log.info('Background extraction completed', { task_id: taskID, episode_id: episodeId, count: scenes.length });
}

function extractBackgroundsForEpisode(db, cfg, log, episodeId, model, style, language) {
  const episode = db.prepare('SELECT id, drama_id, script_content FROM episodes WHERE id = ? AND deleted_at IS NULL').get(Number(episodeId));
  if (!episode) throw new Error('episode not found');
  if (!episode.script_content || !String(episode.script_content).trim()) {
    throw new Error('episode has no script content');
  }
  // 读取项目的 aspect_ratio，覆盖全局 cfg 中的 default_image_ratio，使 promptI18n 生成正确比例的提示词
  let runCfg = cfg;
  if (episode.drama_id) {
    try {
      const dramaRow = db.prepare('SELECT metadata FROM dramas WHERE id = ? AND deleted_at IS NULL').get(episode.drama_id);
      if (dramaRow && dramaRow.metadata) {
        const meta = typeof dramaRow.metadata === 'string' ? JSON.parse(dramaRow.metadata) : dramaRow.metadata;
        if (meta && meta.aspect_ratio) {
          runCfg = { ...cfg, style: { ...(cfg?.style || {}), default_image_ratio: meta.aspect_ratio } };
        }
      }
    } catch (_) {}
  }
  const existing = db.prepare(
    `SELECT id FROM async_tasks
     WHERE resource_id = ? AND type = 'background_extraction'
       AND status IN ('pending', 'processing') AND deleted_at IS NULL
     ORDER BY created_at DESC LIMIT 1`
  ).get(String(episodeId));
  if (existing) {
    log.info('Background extraction already running', { task_id: existing.id, episode_id: episodeId });
    return existing.id;
  }

  const task = taskService.createTask(db, log, 'background_extraction', String(episodeId));
  setImmediate(() => {
    processBackgroundExtraction(db, runCfg, log, task.id, episodeId, model, style, language).catch((err) => {
      log.error('processBackgroundExtraction fatal', { error: err.message, task_id: task.id });
      taskService.updateTaskError(db, task.id, err.message || '场景提取失败');
    });
  });
  return task.id;
}

module.exports = {
  extractBackgroundsForEpisode,
  buildExistingScenesHint,
};
