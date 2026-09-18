const fs = require('fs');
const path = require('path');
const response = require('../response');
const storyboardService = require('../services/storyboardService');
const episodeStoryboardService = require('../services/episodeStoryboardService');
const framePromptService = require('../services/framePromptService');
const aiClient = require('../services/aiClient');
const promptI18n = require('../services/promptI18n');
const angleService = require('../services/angleService');
const { buildUniversalSegmentUserPromptBundle } = require('../services/universalSegmentPromptBundle');
const { normalizeUniversalSegmentShotDurations } = require('../services/universalSegmentDurationNormalize');
const ref2vaFormat = require('../services/ref2vaFormat');

/** 单镜提示词路由也要带上项目画风 cfg —— §5「禁止颜色词」硬规则是按画风条件生成的 */
function styleCfgForStoryboard(db, sbId) {
  const { loadConfig } = require('../config');
  const { mergeCfgStyleWithDrama } = require('../utils/dramaStyleMerge');
  try {
    const row = db.prepare(
      `SELECT d.style AS style, d.metadata AS metadata FROM storyboards sb
         JOIN episodes e ON e.id = sb.episode_id
         JOIN dramas d ON d.id = e.drama_id
        WHERE sb.id = ?`
    ).get(Number(sbId));
    return mergeCfgStyleWithDrama(loadConfig(), row || {});
  } catch (_) {
    return loadConfig();
  }
}


/**
 * 取项目**中文**画风（与提示词里的 STYLE_ZH 同源），供全能片段骨架修复用。
 * 取不到返回空串，修复函数会跳过第 1 行的风格归一化。
 */
function resolveDramaStyleZh(db, storyboardId) {
  try {
    const row = db.prepare(
      'SELECT d.style AS style, d.metadata AS metadata FROM dramas d JOIN episodes e ON e.drama_id = d.id JOIN storyboards s ON s.episode_id = e.id WHERE s.id = ?'
    ).get(Number(storyboardId));
    if (!row) return '';
    const { mergeCfgStyleWithDrama } = require('../utils/dramaStyleMerge');
    const cfg = mergeCfgStyleWithDrama(require('../config').loadConfig() || {}, row);
    return String(cfg?.style?.default_style_zh || '').trim();
  } catch (_) {
    return '';
  }
}

/**
 * 全能片段落库前的最后一道骨架校验 + 就地修复。
 *
 * 生成/润色两条路都会调它。此前两条路都是「拿到什么就存什么」——
 * 实测模型输出过：已废弃的灵境单行格式、`分镜2：`多子分镜、以及被
 * aiClient 流式解码切断汉字产生的 U+FFFD（`1 个分镜` → `1 ���分镜`）静默落库。
 * 修复只换骨架行（风格/单分镜声明/LINE3），模型写的第 4 行长句原样保留。
 */
function saveUniversalSegmentText(db, log, sbId, text, tag) {
  const styleZh = resolveDramaStyleZh(db, sbId);
  // 只有 Ref2VA 六段结构（旧四行块已废弃）；缺段机械补齐，保住模型写的 detailed_description
  const rep = ref2vaFormat.repairRef2va(text, {
    summaryFallback: styleZh,
    soundscapeFallback: '',
  });
  if (rep.fatal) {
    log.warn('[分镜] 全能片段骨架不合规且无法就地修复，原样保存', {
      storyboard_id: sbId, tag, reasons: rep.changes,
    });
    return { text, repaired: false, reasons: rep.changes };
  }
  if (rep.changes.length) {
    log.warn('[分镜] 全能片段骨架已就地修复', { storyboard_id: sbId, tag, changes: rep.changes });
  }
  db.prepare('UPDATE storyboards SET universal_segment_text = ?, universal_segment_text_en = NULL, updated_at = ? WHERE id = ? AND deleted_at IS NULL').run(
    rep.text,
    new Date().toISOString(),
    sbId
  );
  return { text: rep.text, repaired: rep.changes.length > 0, reasons: rep.changes };
}

/** 润色接口：邻镜结构化摘要（含全能片段与其它提示词字段） */
function formatNeighborShotPolishContext(row) {
  if (!row) return '(none)';
  const chunk = (k, v) => {
    const s = v != null && String(v).trim() ? String(v).trim() : '';
    return s ? `${k}: ${s}` : null;
  };
  const bits = [
    chunk('SHOT_NUM', row.storyboard_number),
    chunk('TITLE', row.title),
    chunk('DESCRIPTION', row.description),
    chunk('ACTION', row.action),
    // 权威结束状态。此前只给 ACTION 没给 RESULT，写手只能从对方 ust 结尾措辞推断承接状态，
    // 实测因此把「上一镜光圈内空无一人」当成事实、让唐僧在本镜又倒了一次。
    chunk('RESULT', row.result),
    chunk('DIALOGUE', row.dialogue),
    chunk('NARRATION', row.narration),
    chunk('VIDEO_PROMPT', row.video_prompt),
    chunk('UNIVERSAL_SEGMENT_TEXT', row.universal_segment_text),
  ].filter(Boolean);
  return bits.length ? bits.join('\n') : '(empty)';
}

function clipClassicCtx(s, maxLen) {
  if (s == null) return '';
  const t = String(s).trim();
  if (!t) return '';
  if (t.length <= maxLen) return t;
  return `${t.slice(0, maxLen)}…`;
}

/**
 * 从「场景：…。配乐：…」式拼装文案中拆出带标签的分句，供润色时强制保留信息点（配乐/音效/情绪强度/画幅/完整镜头英文等）。
 */
function extractRetentionClausesFromVideoPrompts(draft, composed) {
  const seen = new Set();
  const out = [];
  const sources = [draft, composed].map((x) => (x != null ? String(x).trim() : '')).filter(Boolean);
  for (const full of sources) {
    const pieces = full
      .replace(/\r\n/g, '\n')
      .trim()
      .split(/。+/)
      .map((x) => x.trim())
      .filter(Boolean);
    for (let piece of pieces) {
      piece = piece.replace(/\s*=\s*VideoRatio\s*:/gi, '=VideoRatio:').trim();
      if (!piece) continue;
      const labeled = /^(场景|镜头标题|动作|对话|对白|结果|景别|镜头角度|运镜|氛围|情绪|情绪强度|配乐|音效|时长|风格|解说旁白)[：:]/.test(
        piece
      );
      const hasRatio = /=VideoRatio\s*:/i.test(piece);
      if (!labeled && !hasRatio) continue;
      const dedupKey = piece.slice(0, 140);
      if (seen.has(dedupKey)) continue;
      seen.add(dedupKey);
      let c = piece;
      if (/^镜头角度/.test(c) && c.length > 920) c = `${c.slice(0, 920)}…`;
      else if (c.length > 560) c = `${c.slice(0, 560)}…`;
      if (!/[。．…]$/.test(c)) c += '。';
      out.push(c);
    }
  }
  return out;
}

/** 经典视频润色：邻镜长上下文（衔接剧情与已有视频文案） */
const MOVEMENT_LABEL_ZH = {
  static: '固定镜头',
  push: '推镜',
  pull: '拉镜',
  pan: '横摇',
  tilt: '纵摇',
  tracking: '跟镜',
  crane_up: '升镜',
  crane_dn: '降镜',
  orbit: '环绕',
  handheld: '手持',
};

const LIGHTING_LABEL_ZH = {
  natural: '自然光',
  front: '顺光',
  side: '侧光',
  backlit: '逆光',
  top: '顶光',
  under: '底光',
  soft: '柔光',
  dramatic: '戏剧光',
  golden_hour: '黄金时段',
  blue_hour: '蓝调时刻',
  night: '夜景',
  neon: '霓虹',
};

const DEPTH_LABEL_ZH = {
  extreme_shallow: '极浅景深',
  shallow: '浅景深',
  medium: '中景深',
  deep: '深景深（全焦）',
};

function movementDisplay(sbRow) {
  const raw = sbRow.movement != null ? String(sbRow.movement).trim() : '';
  if (!raw) return '';
  const zh = MOVEMENT_LABEL_ZH[raw];
  return zh ? `${zh}（${raw}）` : raw;
}

function lightingDisplay(sbRow) {
  const raw = sbRow.lighting_style != null ? String(sbRow.lighting_style).trim() : '';
  if (!raw) return '';
  const zh = LIGHTING_LABEL_ZH[raw];
  return zh ? `${zh}（${raw}）` : raw;
}

function depthDisplay(sbRow) {
  const raw = sbRow.depth_of_field != null ? String(sbRow.depth_of_field).trim() : '';
  if (!raw) return '';
  const zh = DEPTH_LABEL_ZH[raw];
  return zh ? `${zh}（${raw}）` : raw;
}

/** 结构化视角：中文标签 + 英文片语，供润色必覆盖清单 */
function angleCoverageLine(sbRow) {
  if (sbRow.angle_h && sbRow.angle_v && sbRow.angle_s) {
    try {
      const zh = angleService.toChineseLabel(sbRow.angle_h, sbRow.angle_v, sbRow.angle_s);
      const en = angleService.toPromptFragment(sbRow.angle_h, sbRow.angle_v, sbRow.angle_s);
      return `镜头角度（机位/景别）：${zh}；${en}`;
    } catch (_) {
      return sbRow.angle ? String(sbRow.angle).trim() : '';
    }
  }
  return sbRow.angle ? String(sbRow.angle).trim() : '';
}

/**
 * 凡非空字段逐条列出；模型须在同一段成稿中全部体现其语义（可改写，不可丢信息）。
 */
function buildClassicRequiredCoverageDigest(sbRow, linkedSceneText) {
  const lines = [];
  const add = (label, text) => {
    const s = text != null ? String(text).trim() : '';
    if (s) lines.push(`- ${label}：${s}`);
  };
  const sceneLocTime = [sbRow.location, sbRow.time].filter((x) => x != null && String(x).trim()).join('，');
  add('场景（地点与时间）', sceneLocTime);
  if (linkedSceneText) add('关联场景库（地点/时间/摘要）', linkedSceneText);
  add('镜头标题', sbRow.title);
  add('分镜描述', sbRow.description);
  add('人物动作', sbRow.action);
  add('人物对白', sbRow.dialogue);
  add('解说旁白', sbRow.narration);
  add('画面结果/落幅', sbRow.result);
  add('氛围', sbRow.atmosphere);
  add('情绪', sbRow.emotion);
  if (sbRow.emotion_intensity != null && sbRow.emotion_intensity !== '') {
    const ei = Number(sbRow.emotion_intensity);
    if (Number.isFinite(ei)) add('情绪强度', String(ei));
    else add('情绪强度', String(sbRow.emotion_intensity).trim());
  }
  add('景别', sbRow.shot_type);
  const ang = angleCoverageLine(sbRow);
  if (ang) add('镜头方式（视角/机位）', ang);
  add('光线/灯光风格', lightingDisplay(sbRow) || sbRow.lighting_style);
  add('景深', depthDisplay(sbRow) || sbRow.depth_of_field);
  add('运镜', movementDisplay(sbRow) || sbRow.movement);
  const dur = Number(sbRow.duration);
  const sec = Number.isFinite(dur) && dur > 0 ? Math.round(dur) : 5;
  add('时长（秒）', `${sec}`);
  if (sbRow.segment_title != null && String(sbRow.segment_title).trim()) {
    add('剧情段落', `「${String(sbRow.segment_title).trim()}」` + (sbRow.segment_index != null ? `（段序号 ${sbRow.segment_index}）` : ''));
  }
  if (!lines.length) return '(当前无非空结构化字段；请依据剧本与 AUTO_COMPOSED 润色)';
  return ['下列维度在库中均有值——成稿须**全部覆盖**其语义（允许电影化改写，禁止删事实、改秒数、改对白原意）：', ...lines].join('\n');
}

function formatClassicVideoNeighborBlock(label, row) {
  if (!row) return `${label}:\n(none)`;
  const lines = [
    row.storyboard_number != null && row.storyboard_number !== ''
      ? `SHOT_NUM: ${row.storyboard_number}`
      : null,
    row.title ? `TITLE: ${clipClassicCtx(row.title, 180)}` : null,
    row.description ? `DESCRIPTION: ${clipClassicCtx(row.description, 420)}` : null,
    row.action ? `ACTION: ${clipClassicCtx(row.action, 450)}` : null,
    row.dialogue ? `DIALOGUE: ${clipClassicCtx(row.dialogue, 320)}` : null,
    row.narration ? `NARRATION: ${clipClassicCtx(row.narration, 320)}` : null,
    row.video_prompt ? `VIDEO_PROMPT: ${clipClassicCtx(row.video_prompt, 450)}` : null,
    row.universal_segment_text
      ? `UNIVERSAL_SEGMENT_TEXT: ${clipClassicCtx(row.universal_segment_text, 260)}`
      : null,
  ].filter(Boolean);
  return `${label}:\n${lines.length ? lines.join('\n') : '(empty)'}`;
}

/**
 * 分镜主图路径：storyboards.local_path 常与图生记录不同步（图在 image_generations），按存在性解析。
 * @returns {string|null} storage 相对路径
 */
function resolveStoryboardImageLocalPath(db, storageBase, storyboardId, sbRow) {
  const normalizeRel = (rel) => (rel && String(rel).trim() ? String(rel).trim().replace(/^\//, '') : '');
  const tryRel = (rel) => {
    const r = normalizeRel(rel);
    if (!r) return null;
    const abs = path.join(storageBase, r);
    return fs.existsSync(abs) ? r : null;
  };
  const fromSb = tryRel(sbRow?.local_path);
  if (fromSb) return fromSb;
  const ig = db.prepare(
    `SELECT local_path FROM image_generations
     WHERE storyboard_id = ? AND status = 'completed' AND deleted_at IS NULL
       AND local_path IS NOT NULL AND TRIM(local_path) != ''
     ORDER BY id DESC
     LIMIT 1`
  ).get(storyboardId);
  return tryRel(ig?.local_path);
}

/** 全能片段：@图片N 与中英字、引号之间补半角空格，便于模型与接口解析 */
function normalizeUniversalSegmentAtImageSpacing(text) {
  if (!text || typeof text !== 'string') return text;
  return text.replace(
    /@图片(\d+)(?=[\u4e00-\u9fffA-Za-z「『【（])/gu,
    '@图片$1 '
  );
}

function routes(db, log) {
  return {
    create: (req, res) => {
      try {
        const sb = storyboardService.createStoryboard(db, log, req.body || {});
        response.created(res, sb);
      } catch (err) {
        log.error('storyboards create', { error: err.message });
        response.internalError(res, err.message);
      }
    },
    insertBefore: (req, res) => {
      try {
        const sb = storyboardService.insertBeforeStoryboard(db, log, req.params.id);
        if (!sb) return response.notFound(res, '目标分镜不存在');
        response.created(res, sb);
      } catch (err) {
        log.error('storyboards insertBefore', { error: err.message });
        response.internalError(res, err.message);
      }
    },
    getOne: (req, res) => {
      try {
        const sb = storyboardService.getStoryboardById(db, req.params.id);
        if (!sb) return response.notFound(res, '分镜不存在');
        response.success(res, sb);
      } catch (err) {
        log.error('storyboards getOne', { error: err.message });
        response.internalError(res, err.message);
      }
    },
    update: (req, res) => {
      try {
        const sb = storyboardService.updateStoryboard(db, log, req.params.id, req.body || {});
        if (!sb) return response.notFound(res, '分镜不存在');
        response.success(res, sb);
      } catch (err) {
        log.error('storyboards update', { error: err.message });
        response.internalError(res, err.message);
      }
    },
    delete: (req, res) => {
      try {
        const ok = storyboardService.deleteStoryboard(db, log, req.params.id);
        if (!ok) return response.notFound(res, '分镜不存在');
        response.success(res, { message: '删除成功' });
      } catch (err) {
        log.error('storyboards delete', { error: err.message });
        response.internalError(res, err.message);
      }
    },
    framePrompt: (req, res) => {
      try {
        const body = req.body || {};
        const frameType = body.frame_type || 'first';
        const panelCount = body.panel_count || 3;
        const model = body.model || '';
        const taskId = framePromptService.generateFramePrompt(db, log, req.params.id, frameType, panelCount, model);
        response.success(res, {
          task_id: taskId,
          status: 'pending',
          message: '帧提示词生成任务已创建，正在后台处理...',
        });
      } catch (err) {
        log.error('storyboards frame-prompt', { error: err.message });
        if (err.message && (err.message.includes('分镜不存在') || err.message.includes('不支持的'))) {
          return response.badRequest(res, err.message);
        }
        response.internalError(res, err.message);
      }
    },
    framePromptsGet: (req, res) => {
      try {
        const list = framePromptService.getFramePrompts(db, req.params.id);
        response.success(res, { frame_prompts: list });
      } catch (err) {
        log.error('storyboards frame-prompts', { error: err.message });
        response.internalError(res, err.message);
      }
    },
    framePromptSave: (req, res) => {
      try {
        const frameType = req.params.frame_type;
        const validTypes = ['first', 'key', 'last', 'panel', 'action'];
        if (!validTypes.includes(frameType)) {
          return response.badRequest(res, '不支持的 frame_type');
        }
        const body = req.body || {};
        const prompt = typeof body.prompt === 'string' ? body.prompt : '';
        const description = typeof body.description === 'string' ? body.description : null;
        const layout = typeof body.layout === 'string' ? body.layout : null;
        if (!prompt.trim()) {
          return response.badRequest(res, 'prompt 不能为空');
        }
        framePromptService.saveFramePrompt(db, log, req.params.id, frameType, prompt, description, layout);
        response.success(res, { message: '保存成功', frame_type: frameType });
      } catch (err) {
        log.error('storyboards frame-prompt-save', { error: err.message });
        response.internalError(res, err.message);
      }
    },
    rebuildVideoPrompt: (req, res) => {
      try {
        const id = Number(req.params.id);
        if (!id) return response.badRequest(res, '缺少分镜 id');
        const sb = episodeStoryboardService.rebuildVideoPromptForStoryboard(db, log, id);
        if (!sb) return response.notFound(res, '分镜不存在');
        response.success(res, {
          ...sb,
          message: '视频提示词已按最新规则重建并保存',
        });
      } catch (err) {
        log.error('storyboards rebuildVideoPrompt', { error: err.message, id: req.params.id });
        response.internalError(res, err.message || '重建视频提示词失败');
      }
    },
    episodeStoryboardsGenerate: (req, res) => {
      try {
        const taskId = episodeStoryboardService.generateStoryboard(
          db,
          log,
          req.params.episode_id,
          req.query.model,
          req.query.style
        );
        response.success(res, { task_id: taskId, status: 'pending', message: '分镜头生成任务已创建，正在后台处理...' });
      } catch (err) {
        log.error('episode storyboards generate', { error: err.message });
        response.internalError(res, err.message);
      }
    },

    episodeStoryboardsGet: (req, res) => {
      try {
        const list = episodeStoryboardService.getStoryboardsForEpisode(db, req.params.episode_id);
        response.success(res, { storyboards: list, total: list.length });
      } catch (err) {
        log.error('episode storyboards get', { error: err.message });
        response.internalError(res, err.message);
      }
    },

    // 独立触发单条分镜的 image prompt 优化，结果保存到 storyboards.polished_prompt 并返回
    /** 全能模式：根据分镜字段 AI 生成 universal_segment_text（含运镜/机位等专业描述） */
    generateUniversalSegmentPrompt: async (req, res) => {
      try {
        const sbId = Number(req.params.id);
        const built = buildUniversalSegmentUserPromptBundle(db, sbId, req.body || {}, {});
        if (!built.ok) {
          if (built.code === 'not_found') return response.notFound(res, built.message);
          return response.badRequest(res, built.message);
        }
        const { userPrompt, durationLabel, durationSec } = built;
        const out = await aiClient.generateText(
          db,
          log,
          'text',
          userPrompt,
          promptI18n.getUniversalOmniSegmentPrompt(styleCfgForStoryboard(db, sbId)),
          { scene_key: 'image_polish', max_tokens: 2400, temperature: 0.28 }
        );
        if (!out || String(out).trim().length < 20) {
          return response.badRequest(res, 'AI 返回内容过短，请检查文本模型配置');
        }
        let text = String(out).trim();
        text = normalizeUniversalSegmentShotDurations(text, durationLabel, durationSec);
        text = normalizeUniversalSegmentAtImageSpacing(text);
        const nowIso = new Date().toISOString();
        db.prepare('UPDATE storyboards SET universal_segment_text = ?, universal_segment_text_en = NULL, updated_at = ? WHERE id = ? AND deleted_at IS NULL').run(
          text,
          nowIso,
          sbId
        );
        log.info('[分镜] generateUniversalSegmentPrompt 完成', { id: sbId, len: text.length, duration_sec: durationSec });
        response.success(res, { universal_segment_text: text });
      } catch (err) {
        log.error('storyboards generateUniversalSegmentPrompt', { error: err.message });
        response.internalError(res, err.message);
      }
    },

    /** 全能模式：与 generateUniversalSegmentPrompt 相同逻辑，NDJSON 流式（delta + done） */
    generateUniversalSegmentStream: async (req, res) => {
      const sbId = Number(req.params.id);
      const built = buildUniversalSegmentUserPromptBundle(db, sbId, req.body || {}, {});
      if (!built.ok) {
        if (built.code === 'not_found') return response.notFound(res, built.message);
        return response.badRequest(res, built.message);
      }
      const { userPrompt, durationLabel, durationSec } = built;

      res.status(200);
      res.setHeader('Content-Type', 'application/x-ndjson; charset=utf-8');
      res.setHeader('Cache-Control', 'no-cache, no-transform');
      res.setHeader('Connection', 'keep-alive');
      if (typeof res.flushHeaders === 'function') res.flushHeaders();

      const writeNd = (obj) => {
        res.write(`${JSON.stringify(obj)}\n`);
      };

      let finalRaw = '';
      try {
        finalRaw = await aiClient.streamGenerateText(
          db,
          log,
          'text',
          userPrompt,
          promptI18n.getUniversalOmniSegmentPrompt(styleCfgForStoryboard(db, sbId)),
          {
            scene_key: 'image_polish',
            max_tokens: 2400,
            temperature: 0.28,
            silence_timeout_ms: 180000,
          },
          (delta) => writeNd({ type: 'delta', text: delta })
        );
      } catch (err) {
        log.error('storyboards generateUniversalSegmentStream', { error: err.message, id: sbId });
        writeNd({ type: 'error', message: err.message || 'stream failed' });
        return res.end();
      }

      if (!finalRaw || String(finalRaw).trim().length < 20) {
        writeNd({ type: 'error', message: 'AI 返回内容过短，请检查文本模型配置' });
        return res.end();
      }
      let text = String(finalRaw).trim();
      text = normalizeUniversalSegmentShotDurations(text, durationLabel, durationSec);
      text = normalizeUniversalSegmentAtImageSpacing(text);
      const saved = saveUniversalSegmentText(db, log, sbId, text, 'generateUniversalSegmentStream');
      text = saved.text;
      log.info('[分镜] generateUniversalSegmentStream 完成', { id: sbId, len: text.length, duration_sec: durationSec, repaired: saved.repaired });
      writeNd({ type: 'done', universal_segment_text: text });
      res.end();
    },



    upscale: async (req, res) => {
      const id = Number(req.params.id);
      const row = db.prepare(
        'SELECT id, local_path, image_url FROM storyboards WHERE id = ? AND deleted_at IS NULL'
      ).get(id);
      if (!row) return response.notFound(res, '分镜不存在');
      try {
        const loadConfig = require('../config').loadConfig;
        const cfg = loadConfig();
        const storageBase = path.isAbsolute(cfg.storage?.local_path)
          ? cfg.storage.local_path
          : path.join(process.cwd(), cfg.storage?.local_path || './data/storage');
        const localPath = resolveStoryboardImageLocalPath(db, storageBase, id, row);
        if (!localPath) return response.badRequest(res, '分镜没有本地图片，无法超分');
        const srcFile = path.join(storageBase, localPath);
        let sharp; try { sharp = require('sharp'); } catch (_) { sharp = null; }
        if (!sharp) return response.badRequest(res, 'sharp 模块不可用，无法超分');
        const info = await sharp(srcFile).metadata();
        const scale = 2;
        const newW = (info.width || 512) * scale;
        const newH = (info.height || 512) * scale;
        const ext = path.extname(localPath) || '.jpg';
        const baseName = path.basename(localPath, ext);
        const dirName = path.dirname(localPath);
        const newRelPath = path.join(dirName, baseName + '_2x' + ext).replace(/\\/g, '/');
        const newFile = path.join(storageBase, newRelPath);
        await sharp(srcFile).resize(newW, newH, { kernel: 'lanczos3' }).toFile(newFile);
        const now = new Date().toISOString();
        db.prepare('UPDATE storyboards SET local_path = ?, updated_at = ? WHERE id = ?').run(newRelPath, now, id);
        log.info('storyboard upscale done', { id, newRelPath, newW, newH });
        response.success(res, { local_path: newRelPath, width: newW, height: newH });
      } catch (err) {
        log.error('storyboards upscale', { error: err.message });
        response.internalError(res, err.message);
      }
    },

    // 批量推断摄影参数（movement/lighting_style/depth_of_field）
    // 对 episode 下所有缺少这些字段的分镜进行快速文本推断，不调用 AI，毫秒级完成
    batchInferParams: (req, res) => {
      try {
        const episodeId = Number(req.body?.episode_id);
        const overwrite = !!req.body?.overwrite; // 是否覆盖已有值
        if (!episodeId) return response.badRequest(res, 'episode_id 必填');

        const rows = db.prepare(
          'SELECT id, angle_s, shot_type, atmosphere, time, description, action, movement, lighting_style, depth_of_field FROM storyboards WHERE episode_id = ? AND deleted_at IS NULL ORDER BY storyboard_number ASC'
        ).all(episodeId);

        let updated = 0;
        const now = new Date().toISOString();
        const stmt = db.prepare(
          'UPDATE storyboards SET movement = COALESCE(?, movement), lighting_style = COALESCE(?, lighting_style), depth_of_field = COALESCE(?, depth_of_field), updated_at = ? WHERE id = ?'
        );
        const stmtOverwrite = db.prepare(
          'UPDATE storyboards SET movement = ?, lighting_style = ?, depth_of_field = ?, updated_at = ? WHERE id = ?'
        );

        for (const row of rows) {
          const inferred = angleService.inferPhotographyParams(row);
          // 只更新缺少的字段（除非 overwrite=true）
          const newMovement   = overwrite ? inferred.movement   : (row.movement      ? null : inferred.movement);
          const newLighting   = overwrite ? inferred.lighting_style : (row.lighting_style ? null : inferred.lighting_style);
          const newDof        = overwrite ? inferred.depth_of_field : (row.depth_of_field  ? null : inferred.depth_of_field);

          if (overwrite) {
            if (inferred.movement || inferred.lighting_style || inferred.depth_of_field) {
              stmtOverwrite.run(inferred.movement, inferred.lighting_style, inferred.depth_of_field, now, row.id);
              updated++;
            }
          } else {
            if (newMovement || newLighting || newDof) {
              stmt.run(newMovement, newLighting, newDof, now, row.id);
              updated++;
            }
          }
        }

        log.info('[分镜] batchInferParams 完成', { episode_id: episodeId, total: rows.length, updated, overwrite });
        response.success(res, { total: rows.length, updated });
      } catch (err) {
        log.error('storyboards batchInferParams', { error: err.message });
        response.internalError(res, err.message);
      }
    },
  };
}

module.exports = routes;
