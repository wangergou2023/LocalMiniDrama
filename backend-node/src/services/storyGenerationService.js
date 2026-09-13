// 根据故事梗概 + 风格/类型/集数，调用文本模型生成扩展后的故事/剧本（JSON 数组格式）
const aiClient = require('./aiClient');
const promptI18n = require('./promptI18n');
const taskService = require('./taskService');
const dramaService = require('./dramaService');
const { safeParseAIJSON } = require('../utils/safeJson');
const loadConfig = require('../config').loadConfig;

async function generateStory(db, log, body) {
  const premise = (body.premise || body.prompt || body.text || '').trim();
  if (!premise) {
    throw new Error('请提供故事梗概');
  }
  const cfg = loadConfig();
  const style = body.style || body.genre || null;
  const type = body.type || null;
  const episodeCount = Math.max(1, Math.floor(Number(body.episode_count) || 1));

  const isPromo = type === 'promo';
  const segmentCount = Math.max(3, episodeCount);
  const systemPrompt = isPromo
    ? promptI18n.getPromoVideoSystemPrompt(cfg, segmentCount)
    : promptI18n.getStoryExpansionSystemPrompt(cfg, episodeCount);
  const userPrompt = isPromo
    ? promptI18n.buildPromoVideoUserPrompt(cfg, premise, style, type, segmentCount)
    : promptI18n.buildStoryExpansionUserPrompt(cfg, premise, style, type, episodeCount);

  // 单次**输出**上限（max_tokens）。注意它与模型的上下文窗口（本项目 1M）是两回事：
  // 上下文再大，max_tokens 仍决定"一次最多吐多少"。
  //
  // 剧本长度目标已从「每集约 800 字」提到「约 1200-1600 字」（见 promptI18n 的剧本创作提示词：
  // 一句一事 + 过渡要写出来），按实测约 1.45 token/字 + JSON 包装估算，1600 字 ≈ 2400 token。
  // 原值 2200 会开始截断，故抬到 4500（约 2 倍余量）。
  //
  // 多集注意：当前实现把 episodeCount 集放在**一次调用**里生成，集数一多单次输出上限必然不够。
  // 这里按单次调用的现实上限封顶并告警，而不是发一个不可能的 max_tokens 让接口报错。
  const perEpisodeTokens = 4500;
  const wantTokens = episodeCount * perEpisodeTokens;
  const singleCallCap = 8000;
  const minTokensNeeded = Math.max(perEpisodeTokens, Math.min(wantTokens, singleCallCap));
  if (wantTokens > singleCallCap && log && typeof log.warn === 'function') {
    log.warn('剧本生成：集数过多，单次输出上限不足，可能被截断（建议减少单次集数）', {
      episode_count: episodeCount,
      want_tokens: wantTokens,
      capped_to: minTokensNeeded,
    });
  }

  // 注意：不使用 json_mode=true，因为 response_format:json_object 要求返回 JSON 对象而非数组，
  // 会导致模型将数组包成 {"episodes":[...]} 对象，破坏解析逻辑。依靠 prompt 本身约束格式即可。
  const rawText = await aiClient.generateText(db, log, 'text', userPrompt, systemPrompt, {
    scene_key: 'story_generation',
    model: body.model || undefined,
    temperature: 0.8,
    min_max_tokens: minTokensNeeded,
  });

  log && log.info && log.info('Story raw response', {
    text_length: (rawText || '').length,
    episode_count: episodeCount,
    text_preview: (rawText || '').slice(0, 200),
  });

  // 解析 JSON，支持多种 AI 返回格式
  let parsed = null;
  try {
    parsed = safeParseAIJSON(rawText, log);
  } catch (e) {
    log && log.warn && log.warn('Story JSON parse failed', { error: e.message });
  }

  // 规范化为集数数组，兼容以下常见 AI 输出格式：
  // 1. 直接数组 [{episode,title,content}, ...]
  // 2. 包装对象 { episodes: [...] } 或 { data: [...] }
  // 3. 单个对象 {episode:1, title, content}（只生成1集时）
  let episodeList = null;
  if (Array.isArray(parsed)) {
    episodeList = parsed;
  } else if (parsed && typeof parsed === 'object') {
    const keys = Object.keys(parsed);
    // 找第一个 value 是数组的字段（如 episodes / data / items）
    const arrKey = keys.find(k => Array.isArray(parsed[k]));
    if (arrKey) {
      episodeList = parsed[arrKey];
    } else if (parsed.content || parsed.episode) {
      // 单集对象
      episodeList = [parsed];
    }
  }

  if (episodeList && episodeList.length > 0) {
    const result = episodeList.map((ep, i) => {
      const seg = Number(ep.segment ?? ep.episode ?? i + 1);
      if (isPromo) {
        return {
          episode: seg,
          title: (ep.title || `第${seg}幕`).trim(),
          content: (ep.narration || ep.content || '').trim(),
          image_prompt: (ep.visual || '').trim(),
          duration: Number(ep.duration) || 10,
        };
      }
      return {
        episode: seg,
        title: (ep.title || `第${seg}集`).trim(),
        content: (ep.content || ep.script || ep.text || ep.body || '').trim(),
      };
    }).filter(ep => ep.content.length > 0);

    if (result.length > 0) {
      log && log.info && log.info('Story episodes parsed', { count: result.length });
      logScriptLengths(log, result);
      return { episodes: result };
    }
  }

  // 兜底：JSON 解析失败或返回纯文本，把整段文本当作第 1 集正文
  log && log.warn && log.warn('Story JSON parse gave no valid episodes, treating as plain text', {
    text_length: (rawText || '').length,
  });
  const fallbackContent = (rawText || '').trim();
  const fallbackList = [{
    episode: 1,
    title: '第1集',
    content: fallbackContent,
  }];
  logScriptLengths(log, fallbackList);
  return { episodes: fallbackList };
}

/**
 * 剧本长度自检：把每集实际字数打出来。
 *
 * 为什么需要：实测模型会**自己写短** —— 提示词要「每集约 800 字」，它给了 716 字；
 * 而日志里当时只记了原始响应总长（785 字符，含 JSON 包装），看不出正文到底多少字。
 * 现在目标提到「约 1200-1600 字」，低于 1000 字即视为未达目标并告警。
 * 注意这与 max_tokens 截断是两回事：截断会中途断句，这里记录的是模型主动收尾的情况。
 */
function logScriptLengths(log, episodes) {
  if (!log || typeof log.info !== 'function') return;
  try {
    for (const ep of (episodes || [])) {
      const len = String((ep && ep.content) || '').trim().length;
      if (len <= 0) continue;
      if (len < 1000) {
        if (typeof log.warn === 'function') {
          log.warn('剧本偏短，未达长度目标（模型自己收尾，非截断）', {
            episode: ep.episode, chars: len, target: '约 1200-1600 字',
          });
        }
      } else {
        log.info('剧本长度', { episode: ep.episode, chars: len });
      }
    }
  } catch (_) {}
}

async function processStoryGeneration(db, log, taskId, req) {
  taskService.updateTaskStatus(db, taskId, 'processing', 10, '正在生成剧本...');
  try {
    const result = await generateStory(db, log, req);
    const episodes = result?.episodes || [];
    if (episodes.length === 0) {
      taskService.updateTaskError(db, taskId, 'AI 未能生成剧本');
      return;
    }

    const dramaId = Number(req.drama_id);
    taskService.updateTaskStatus(db, taskId, 'processing', 75, '正在保存剧本...');

    const saved = dramaService.saveEpisodes(db, log, dramaId, {
      episodes: episodes.map((ep, i) => ({
        episode_number: ep.episode ?? i + 1,
        title: ep.title || `第${ep.episode ?? i + 1}集`,
        script_content: ep.content || '',
      })),
    });
    if (!saved) {
      taskService.updateTaskError(db, taskId, '保存剧本失败：项目不存在');
      return;
    }

    if (req.summary || req.genre || req.drama_style || req.metadata || req.title) {
      dramaService.saveOutline(db, log, dramaId, {
        title: req.title,
        summary: req.summary,
        genre: req.genre,
        style: req.drama_style,
        metadata: req.metadata,
      });
    }

    taskService.updateTaskResult(db, taskId, {
      drama_id: dramaId,
      episode_count: episodes.length,
    });
    log.info('Story generation completed and saved', { task_id: taskId, drama_id: dramaId, episode_count: episodes.length });
  } catch (err) {
    log.error('processStoryGeneration failed', { task_id: taskId, error: err.message });
    taskService.updateTaskError(db, taskId, err.message || '故事生成失败');
  }
}

function startStoryGeneration(db, log, req) {
  const dramaId = String(req.drama_id || '');
  if (!dramaId) throw new Error('drama_id 必填');
  if (!dramaService.getDramaById(db, Number(dramaId))) {
    throw new Error('项目不存在');
  }

  const existing = db.prepare(
    `SELECT id FROM async_tasks
     WHERE resource_id = ? AND type = 'story_generation'
       AND status IN ('pending', 'processing') AND deleted_at IS NULL
     ORDER BY created_at DESC LIMIT 1`
  ).get(dramaId);
  if (existing) {
    log.info('Story generation already running', { task_id: existing.id, drama_id: dramaId });
    return existing.id;
  }

  const task = taskService.createTask(db, log, 'story_generation', dramaId);
  setImmediate(() => {
    processStoryGeneration(db, log, task.id, req).catch((err) => {
      log.error('processStoryGeneration fatal', { error: err.message, task_id: task.id });
      taskService.updateTaskError(db, task.id, err.message || '故事生成失败');
    });
  });
  return task.id;
}

module.exports = {
  generateStory,
  startStoryGeneration,
};
