const path = require('path');
const fs = require('fs');
const { getFfmpegPath, getFfprobePath, hasLocalFfmpeg } = require('../utils/ffmpegPath');
const storageLayout = require('./storageLayout');

function list(db, query) {
  let sql = 'FROM video_merges WHERE deleted_at IS NULL';
  const params = [];
  if (query.episode_id) {
    sql += ' AND episode_id = ?';
    params.push(query.episode_id);
  }
  if (query.drama_id) {
    sql += ' AND drama_id = ?';
    params.push(query.drama_id);
  }
  const rows = db.prepare('SELECT * ' + sql + ' ORDER BY created_at DESC').all(...params);
  return rows.map(rowToItem);
}

function rowToItem(r) {
  return {
    id: r.id,
    episode_id: r.episode_id,
    drama_id: r.drama_id,
    title: r.title,
    provider: r.provider,
    status: r.status,
    merged_url: r.merged_url,
    duration: r.duration ?? undefined,
    task_id: r.task_id,
    error_msg: r.error_msg ?? undefined,
    created_at: r.created_at,
    completed_at: r.completed_at,
  };
}

function getById(db, id) {
  const r = db.prepare('SELECT * FROM video_merges WHERE id = ? AND deleted_at IS NULL').get(Number(id));
  return r ? rowToItem(r) : null;
}

function create(db, log, req) {
  const now = new Date().toISOString();
  const taskService = require('./taskService');
  const task = taskService.createTask(db, log, 'video_merge', String(req.episode_id || ''));
  const mergeOptionsJson = (() => {
    const o = req.merge_options;
    if (o && typeof o === 'object') return JSON.stringify(o);
    return '{}';
  })();
  const info = db.prepare(
    `INSERT INTO video_merges (episode_id, drama_id, title, provider, model, status, scenes, merge_options, task_id, created_at)
     VALUES (?, ?, ?, ?, ?, 'pending', ?, ?, ?, ?)`
  ).run(
    Number(req.episode_id) || 0,
    Number(req.drama_id) || 0,
    req.title ?? null,
    req.provider || 'ffmpeg',
    req.model ?? null,
    req.scenes ? JSON.stringify(req.scenes) : '[]',
    mergeOptionsJson,
    task.id,
    now
  );
  return { merge_id: info.lastInsertRowid, task_id: task.id, ...getById(db, info.lastInsertRowid) };
}

function deleteById(db, log, id) {
  const now = new Date().toISOString();
  const result = db.prepare('UPDATE video_merges SET deleted_at = ? WHERE id = ? AND deleted_at IS NULL').run(now, Number(id));
  return result.changes > 0;
}

/** 获取 storage 根目录（绝对路径） */
function getStorageRoot() {
  const loadConfig = require('../config').loadConfig;
  const cfg = loadConfig();
  const p = cfg.storage?.local_path || './data/storage';
  return path.isAbsolute(p) ? p : path.join(process.cwd(), p);
}

/** 将 video_url 解析为本地文件路径，或下载到 temp 返回路径 */
async function resolveVideoToLocalPath(videoUrl, baseUrl, storageRoot, tempDir, index, log) {
  if (!videoUrl || typeof videoUrl !== 'string') return null;
  const u = videoUrl.trim();
  // 1) URL 以 baseUrl 开头（如 http://localhost:5679/static）-> 对应 storageRoot 下相对路径
  if (baseUrl && (u.startsWith(baseUrl) || u.startsWith(baseUrl.replace(/\/$/, '')))) {
    const base = baseUrl.replace(/\/$/, '');
    const rel = u.startsWith(base + '/') ? u.slice(base.length + 1) : u.slice(base.length).replace(/^\//, '');
    if (rel && !rel.startsWith('http')) {
      const localPath = path.join(storageRoot, rel.replace(/\//g, path.sep));
      if (fs.existsSync(localPath)) {
        log.info('Video merge: using local static file', { index, path: localPath });
        return localPath;
      }
    }
  }
  // 2) 已是本地绝对路径且存在
  if (path.isAbsolute(u) && fs.existsSync(u)) {
    log.info('Video merge: using absolute path', { index, path: u });
    return u;
  }
  // 3) 相对路径（相对 storageRoot）
  if (!u.startsWith('http://') && !u.startsWith('https://')) {
    const localPath = path.join(storageRoot, u.replace(/^\//, '').replace(/\//g, path.sep));
    if (fs.existsSync(localPath)) {
      log.info('Video merge: using relative path', { index, path: localPath });
      return localPath;
    }
  }
  // 4) 远程 URL：下载到 temp
  const ext = u.includes('.mp4') ? '.mp4' : u.includes('.webm') ? '.webm' : '.mp4';
  const destPath = path.join(tempDir, `dl_${Date.now()}_${index}${ext}`);
  try {
    const res = await fetch(u, { method: 'GET' });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const buf = Buffer.from(await res.arrayBuffer());
    fs.writeFileSync(destPath, buf);
    log.info('Video merge: downloaded to temp', { index, dest: destPath });
    return destPath;
  } catch (e) {
    log.warn('Video merge: download failed', { index, url: u, error: e.message });
    return null;
  }
}

/**
 * 用 ffprobe 读取一条视频的编码规格（失败返回 null，调用方按“不动它”处理）。
 * 合并用的是 `ffmpeg -f concat -c copy`，要求所有输入同编码/同分辨率/同音频参数；
 * 任何一段不一致都会导致**那一段只有声音、画面被丢弃**（播放器卡在上一帧）。
 */
function probeVideoProfile(filePath, log) {
  try {
    const { spawnSync } = require('child_process');
    const args = [
      '-v', 'error',
      '-show_entries', 'stream=codec_type,codec_name,width,height,r_frame_rate,pix_fmt,sample_rate,channels',
      '-of', 'json',
      filePath,
    ];
    const r = spawnSync(getFfprobePath(), args, { encoding: 'utf8', maxBuffer: 2 * 1024 * 1024 });
    if (r.status !== 0) return null;
    const j = JSON.parse(r.stdout || '{}');
    const streams = Array.isArray(j.streams) ? j.streams : [];
    const v = streams.find((s) => s.codec_type === 'video');
    const a = streams.find((s) => s.codec_type === 'audio');
    if (!v) return null;
    return {
      codec: String(v.codec_name || '').toLowerCase(),
      width: Number(v.width) || 0,
      height: Number(v.height) || 0,
      fps: normalizeFps(v.r_frame_rate),
      pixFmt: String(v.pix_fmt || '').toLowerCase(),
      audioCodec: a ? String(a.codec_name || '').toLowerCase() : '',
      audioRate: a ? Number(a.sample_rate) || 0 : 0,
      audioChannels: a ? Number(a.channels) || 0 : 0,
    };
  } catch (e) {
    if (log && log.warn) log.warn('Video merge: probe 失败', { file: path.basename(String(filePath)), error: e.message });
    return null;
  }
}

/** "24/1" → 24；解析不了返回 0 */
function normalizeFps(value) {
  const s = String(value || '').trim();
  const m = s.match(/^(\d+)\s*\/\s*(\d+)$/);
  if (m) {
    const n = Number(m[1]);
    const d = Number(m[2]);
    if (n > 0 && d > 0) return Math.round((n / d) * 1000) / 1000;
    return 0;
  }
  const n = Number(s);
  return Number.isFinite(n) && n > 0 ? n : 0;
}

/**
 * 选「多数派规格」作为合并目标：维度+帧率取出现次数最多的组合；
 * 编码统一用 h264（兼容性最好，最终成片编码器也是它）。
 * 探测失败（null）的条目不计入。
 */
function pickMajorityProfile(profiles) {
  const valid = (profiles || []).filter((p) => p && p.width > 0 && p.height > 0);
  if (valid.length === 0) return null;
  const counter = new Map();
  for (const p of valid) {
    const key = `${p.width}x${p.height}@${p.fps}`;
    const cur = counter.get(key) || { count: 0, sample: p };
    cur.count += 1;
    counter.set(key, cur);
  }
  let best = null;
  for (const v of counter.values()) if (!best || v.count > best.count) best = v;
  return {
    codec: 'h264',
    width: best.sample.width,
    height: best.sample.height,
    fps: best.sample.fps || 24,
  };
}

/** 该段是否需要归一化（探测失败时返回 false —— 不动它，保持原行为） */
function needsNormalization(profile, target) {
  if (!profile || !target) return false;
  if (profile.codec !== target.codec) return true;
  if (profile.width !== target.width || profile.height !== target.height) return true;
  if (normalizeFps(profile.fps) !== normalizeFps(target.fps)) return true;
  if (profile.pixFmt !== 'yuv420p') return true;
  if (profile.audioCodec !== 'aac') return true;
  if (profile.audioRate !== 48000) return true;
  if (profile.audioChannels !== 2) return true;
  return false;
}

/** 归一化 ffmpeg 参数：等比缩放 + 补边到目标尺寸、统一帧率/像素格式/音频参数 */
function buildNormalizeArgs(src, out, target, hasAudio) {
  const fps = normalizeFps(target.fps) || 24;
  const vf = `scale=${target.width}:${target.height}:force_original_aspect_ratio=decrease,` +
    `pad=${target.width}:${target.height}:(ow-iw)/2:(oh-ih)/2,setsar=1,fps=${fps}`;
  const args = ['-y', '-i', src];
  if (!hasAudio) args.push('-f', 'lavfi', '-i', 'anullsrc=channel_layout=stereo:sample_rate=48000');
  args.push(
    '-vf', vf,
    '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '20', '-pix_fmt', 'yuv420p',
    '-c:a', 'aac', '-ar', '48000', '-ac', '2', '-b:a', '192k',
    '-shortest', '-movflags', '+faststart',
    out
  );
  return args;
}

/**
 * 合并前把不一致的输入归一化到同一规格。
 * @returns {{paths: string[], normalized: object[], profile: object|null, tmpDir: string|null}}
 */
function prepareUniformInputs(localPaths, log) {
  const list = Array.isArray(localPaths) ? localPaths : [];
  const profiles = list.map((p) => probeVideoProfile(p, log));
  const target = pickMajorityProfile(profiles);
  if (!target) return { paths: list, normalized: [], profile: null, tmpDir: null };
  const needIdx = list.map((p, i) => i).filter((i) => needsNormalization(profiles[i], target));
  if (needIdx.length === 0) return { paths: list, normalized: [], profile: target, tmpDir: null };

  const tmpDir = path.join(require('os').tmpdir(), `lmd_merge_norm_${Date.now()}`);
  fs.mkdirSync(tmpDir, { recursive: true });
  const paths = list.slice();
  const normalized = [];
  const ffmpegBin = getFfmpegPath();
  const { spawnSync } = require('child_process');
  for (const i of needIdx) {
    const out = path.join(tmpDir, `norm_${i}.mp4`);
    const prof = profiles[i];
    const r = spawnSync(ffmpegBin, buildNormalizeArgs(list[i], out, target, !!prof.audioCodec), {
      encoding: 'utf8',
      maxBuffer: 8 * 1024 * 1024,
    });
    if (r.status === 0 && fs.existsSync(out)) {
      paths[i] = out;
      normalized.push({
        index: i,
        file: path.basename(list[i]),
        from: `${prof.codec} ${prof.width}x${prof.height}@${normalizeFps(prof.fps)}`,
        to: `h264 ${target.width}x${target.height}@${normalizeFps(target.fps)}`,
      });
    } else {
      if (log && log.warn) {
        log.warn('Video merge: 归一化失败，该段可能丢画面', {
          index: i, file: path.basename(list[i]), error: String(r.stderr || '').slice(-300),
        });
      }
    }
  }
  return { paths, normalized, profile: target, tmpDir };
}

/** 使用 ffmpeg concat 合并多个视频文件 */
function runFfmpegConcat(localPaths, outputPath, log) {
  const ffmpegBin = getFfmpegPath();
  const isWin = process.platform === 'win32';
  const listFile = path.join(path.dirname(outputPath), `concat_list_${Date.now()}.txt`);
  try {
    const lines = localPaths.map((p) => {
      const normalized = p.replace(/\\/g, '/');
      return `file '${normalized.replace(/'/g, "'\\''")}'`;
    });
    fs.writeFileSync(listFile, lines.join('\n'), 'utf8');
    const { spawnSync } = require('child_process');
    const args = [
      '-f', 'concat',
      '-safe', '0',
      '-i', listFile,
      '-c', 'copy',
      '-y',
      outputPath,
    ];
    const result = spawnSync(ffmpegBin, args, { encoding: 'utf8', maxBuffer: 4 * 1024 * 1024 });
    if (result.error) {
      log.warn('Video merge: ffmpeg spawn error', { error: result.error.message });
      return false;
    }
    if (result.status !== 0) {
      log.warn('Video merge: ffmpeg failed', { stderr: result.stderr?.slice(-500) });
      return false;
    }
    return true;
  } finally {
    try { if (fs.existsSync(listFile)) fs.unlinkSync(listFile); } catch (_) {}
  }
}

/**
 * 异步处理视频合成：优先使用 ffmpeg 真正合并多段视频；失败或无 ffmpeg 时用首段作为 merged_url。
 */
async function processVideoMerge(db, log, mergeId, baseUrl) {
  const r = db.prepare('SELECT * FROM video_merges WHERE id = ? AND deleted_at IS NULL').get(mergeId);
  if (!r) return;
  const taskId = r.task_id;
  const episodeId = r.episode_id;
  let scenes = [];
  try {
    scenes = JSON.parse(r.scenes || '[]');
  } catch (_) {
    log.warn('video merge parse scenes failed', { merge_id: mergeId });
  }
  const now = new Date().toISOString();
  db.prepare('UPDATE video_merges SET status = ? WHERE id = ?').run('processing', mergeId);
  const taskService = require('./taskService');
  if (scenes.length === 0) {
    db.prepare('UPDATE video_merges SET status = ?, error_msg = ? WHERE id = ?').run('failed', '无有效视频片段', mergeId);
    if (taskId) taskService.updateTaskError(db, taskId, '无有效视频片段');
    return;
  }
  const first = scenes[0];
  const mergedUrlFallback = first && first.video_url ? first.video_url : null;
  if (!mergedUrlFallback) {
    db.prepare('UPDATE video_merges SET status = ?, error_msg = ? WHERE id = ?').run('failed', '首段无视频地址', mergeId);
    if (taskId) taskService.updateTaskError(db, taskId, '首段无视频地址');
    return;
  }

  const totalDuration = scenes.reduce((sum, s) => sum + (Number(s.duration) || 0), 0);
  const storageRoot = getStorageRoot();
  const tempDir = path.join(require('os').tmpdir(), 'drama-video-merge');
  if (!fs.existsSync(tempDir)) fs.mkdirSync(tempDir, { recursive: true });

  const localPaths = [];
  const toCleanup = [];
  for (let i = 0; i < scenes.length; i++) {
    const p = await resolveVideoToLocalPath(
      scenes[i].video_url,
      baseUrl,
      storageRoot,
      tempDir,
      i,
      log
    );
    if (p) {
      localPaths.push(p);
      if (p.startsWith(tempDir)) toCleanup.push(p);
    }
  }

  const ffmpegAvailable = hasLocalFfmpeg();
  log.info('Video merge: ffmpeg check', {
    merge_id: mergeId,
    has_ffmpeg: ffmpegAvailable,
    ffmpeg_path: getFfmpegPath(),
    local_video_count: localPaths.length,
    cwd: process.cwd(),
  });

  let mergedRelativePath = null;
  if (localPaths.length > 0 && ffmpegAvailable && localPaths.length <= 100) {
    const projectSubdir = storageLayout.getProjectStorageSubdir(db, r.drama_id);
    const sub = projectSubdir && String(projectSubdir).trim();
    const mergedDir = sub
      ? path.join(storageRoot, sub, 'videos', 'merged')
      : path.join(storageRoot, 'videos', 'merged');
    if (!fs.existsSync(mergedDir)) fs.mkdirSync(mergedDir, { recursive: true });
    const outputFileName = `merged_${Date.now()}.mp4`;
    const outputPath = path.join(mergedDir, outputFileName);
    // 先统一规格：-c copy 拼接要求所有输入同编码/同分辨率/同音频参数，
    // 否则那一段会「只有声音没画面」（播放器卡在上一帧）。
    const prepared = prepareUniformInputs(localPaths, log);
    if (prepared.normalized.length) {
      log.info('Video merge: 已把不一致的输入归一化到多数派规格', {
        merge_id: mergeId,
        target: prepared.profile,
        items: prepared.normalized,
      });
    }
    const ok = runFfmpegConcat(prepared.paths, outputPath, log);
    if (prepared.tmpDir) {
      try { fs.rmSync(prepared.tmpDir, { recursive: true, force: true }); } catch (_) {}
    }
    if (ok && fs.existsSync(outputPath)) {
      mergedRelativePath = sub
        ? path.join(sub, 'videos', 'merged', outputFileName).replace(/\\/g, '/')
        : path.join('videos', 'merged', outputFileName).replace(/\\/g, '/');
      log.info('Video merge completed (ffmpeg)', { merge_id: mergeId, episode_id: episodeId, output: mergedRelativePath });
    }
  }

  let mergeOpts = {};
  try {
    mergeOpts = JSON.parse(r.merge_options || '{}');
  } catch (_) {
    mergeOpts = {};
  }
  const postNeed =
    !!mergeOpts.burn_narration_subtitles
    || !!mergeOpts.burn_dialogue_audio
    || !!(mergeOpts.watermark_text && String(mergeOpts.watermark_text).trim());
  if (mergedRelativePath && ffmpegAvailable && postNeed) {
    const mergedAbsPath = path.join(storageRoot, mergedRelativePath.replace(/\//g, path.sep));
    if (fs.existsSync(mergedAbsPath)) {
      const mergedPP = require('./mergedEpisodePostProcess');
      const post = await mergedPP.runMergedEpisodePostProcess(db, log, {
        mergedAbsPath,
        storageRoot,
        scenes,
        episodeId,
        mergeOpts,
      });
      if (post.ok && post.relativePath) {
        mergedRelativePath = post.relativePath;
        log.info('Video merge: merged episode post-process', { merge_id: mergeId, out: mergedRelativePath });
      } else if (post.error && post.error !== 'NO_POST_OPTS') {
        log.warn('Video merge: post-process skipped', { merge_id: mergeId, err: post.error });
      }
    }
  }

  for (const p of toCleanup) {
    try { if (fs.existsSync(p)) fs.unlinkSync(p); } catch (_) {}
  }

  const finalMergedUrl = mergedRelativePath || mergedUrlFallback;
  db.prepare(
    'UPDATE video_merges SET status = ?, merged_url = ?, duration = ?, completed_at = ?, error_msg = ? WHERE id = ?'
  ).run('completed', finalMergedUrl, Math.round(totalDuration) || null, now, null, mergeId);
  db.prepare('UPDATE episodes SET video_url = ?, status = ?, updated_at = ? WHERE id = ?').run(finalMergedUrl, 'completed', now, episodeId);
  if (taskId) {
    taskService.updateTaskResult(db, taskId, { merge_id: mergeId, video_url: finalMergedUrl, duration: Math.round(totalDuration) });
  }
  if (!mergedRelativePath) {
    log.info('Video merge completed (first-clip fallback)', { merge_id: mergeId, episode_id: episodeId });
  }
}

module.exports = {
  // 纯逻辑（供单测）：合并前判断哪些输入需要归一化
  normalizeFps,
  pickMajorityProfile,
  needsNormalization,
  buildNormalizeArgs,
  prepareUniformInputs,
  runFfmpegConcat,
  probeVideoProfile,
  list,
  getById,
  create,
  deleteById,
  processVideoMerge,
};
