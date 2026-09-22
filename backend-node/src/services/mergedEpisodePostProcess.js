/**
 * 整集合并后的后处理：对白 TTS 轨、解说旁白轨+SRT、右下角文字水印（可组合）。
 */
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');
const { getFfmpegPath, getFfprobePath } = require('../utils/ffmpegPath');

function ffprobeDurationSec(filePath) {
  const probe = getFfprobePath();
  const r = spawnSync(
    probe,
    ['-v', 'error', '-show_entries', 'format=duration', '-of', 'default=noprint_wrappers=1:nokey=1', filePath],
    { encoding: 'utf8', maxBuffer: 1024 * 1024 }
  );
  if (r.status !== 0) return null;
  const d = parseFloat(String(r.stdout || '').trim());
  return Number.isFinite(d) && d > 0 ? d : null;
}

function formatSrtTimestamp(ms) {
  if (!Number.isFinite(ms) || ms < 0) ms = 0;
  const h = Math.floor(ms / 3600000);
  const m = Math.floor((ms % 3600000) / 60000);
  const s = Math.floor((ms % 60000) / 1000);
  const z = Math.floor(ms % 1000);
  const p2 = (n) => String(n).padStart(2, '0');
  return `${p2(h)}:${p2(m)}:${p2(s)},${String(z).padStart(3, '0')}`;
}

function buildAtempoChain(factor) {
  if (!Number.isFinite(factor) || factor <= 0) return null;
  if (Math.abs(factor - 1) < 0.002) return null;
  const parts = [];
  let f = factor;
  while (f > 2.001) {
    parts.push('atempo=2');
    f /= 2;
  }
  while (f < 0.499) {
    parts.push('atempo=0.5');
    f /= 0.5;
  }
  parts.push(`atempo=${Math.min(2, Math.max(0.5, f))}`);
  return parts.join(',');
}

function escapeFfmpegPath(absPath) {
  let s = path.resolve(absPath).replace(/\\/g, '/');
  if (/^[A-Za-z]:/.test(s)) s = s.replace(/^([A-Za-z]):/, '$1\\:');
  return s.replace(/'/g, "\\'");
}

function runFfmpeg(args, log, tag) {
  const bin = getFfmpegPath();
  const r = spawnSync(bin, args, { encoding: 'utf8', maxBuffer: 16 * 1024 * 1024 });
  if (r.error) {
    log.warn('merged post: ffmpeg spawn', { tag, error: r.error.message });
    return false;
  }
  if (r.status !== 0) {
    log.warn('merged post: ffmpeg failed', { tag, stderr: r.stderr?.slice(-1000) });
    return false;
  }
  return true;
}

/**
 * 最终成片编码器。
 * 默认 AV1（libsvtav1）10-bit：本机 Firefox 147 可硬解、色带（ink-wash 渐变）明显少于 8-bit H.264，
 * 且与单镜 clip（ComfyUI SaveVideo av1 + CreateVideo bit_depth=10）编码一致，避免二次转码风格突变。
 * 可通过 episodes.merge_options.output_codec / output_crf 覆盖（'av1' | 'h264'）。
 */
const FINAL_ENCODERS = {
  h264: (crf) => ['-c:v', 'libx264', '-preset', 'fast', '-crf', String(crf), '-pix_fmt', 'yuv420p'],
  av1: (crf) => ['-c:v', 'libsvtav1', '-preset', '6', '-crf', String(crf), '-pix_fmt', 'yuv420p10le'],
};
const FINAL_ENCODER_DEFAULT_CRF = { h264: 23, av1: 26 };

function finalEncoderArgs(mergeOpts = {}) {
  const wanted = String(mergeOpts.output_codec || 'av1').toLowerCase();
  const key = FINAL_ENCODERS[wanted] ? wanted : 'av1';
  const crf = Number.isFinite(Number(mergeOpts.output_crf))
    ? Number(mergeOpts.output_crf)
    : FINAL_ENCODER_DEFAULT_CRF[key];
  return { key, crf, args: FINAL_ENCODERS[key](crf) };
}

/**
 * 用目标编码器写最终文件；AV1 编码失败（缺 libsvtav1 等）时自动回退 libx264，
 * 保证无人值守的批量合成不会因为编码器问题整集失败。
 * @returns {boolean} 是否写出成功
 */
function encodeFinal(headArgs, tailArgs, outAbs, log, tag, mergeOpts) {
  const enc = finalEncoderArgs(mergeOpts);
  const common = [...tailArgs, '-movflags', '+faststart', outAbs];
  if (runFfmpeg([...headArgs, ...enc.args, ...common], log, tag)) {
    log.info('merged post: 最终编码', { tag, codec: enc.key, crf: enc.crf });
    return true;
  }
  if (enc.key === 'h264') return false;
  log.warn('merged post: AV1 编码失败，回退 libx264', { tag });
  const fb = finalEncoderArgs({ output_codec: 'h264' });
  return runFfmpeg([...headArgs, ...fb.args, ...common], log, `${tag}_fallback_h264`);
}

function writeSilenceMp3(slotSec, outPath, log) {
  return runFfmpeg(
    ['-y', '-f', 'lavfi', '-i', 'anullsrc=r=44100:cl=mono', '-t', String(slotSec), '-c:a', 'libmp3lame', '-q:a', '6', outPath],
    log,
    'silence'
  );
}

function fitAudioToSlot(inputPath, slotSec, outPath, log) {
  const d = ffprobeDurationSec(inputPath);
  if (d == null || d <= 0.01) return false;
  const eps = 0.06;
  if (d > slotSec + eps) {
    const factor = d / slotSec;
    const chain = buildAtempoChain(factor);
    const af = chain || 'anull';
    return runFfmpeg(
      ['-y', '-i', inputPath, '-af', af, '-t', String(slotSec), '-c:a', 'libmp3lame', '-q:a', '4', outPath],
      log,
      'fit_speed'
    );
  }
  if (d < slotSec - eps) {
    const pad = slotSec - d;
    return runFfmpeg(
      ['-y', '-i', inputPath, '-af', `apad`, '-t', String(slotSec), '-c:a', 'libmp3lame', '-q:a', '4', outPath],
      log,
      'fit_pad'
    );
  }
  try {
    fs.copyFileSync(inputPath, outPath);
    return true;
  } catch (_) {
    return runFfmpeg(
      ['-y', '-i', inputPath, '-t', String(slotSec), '-c:a', 'libmp3lame', '-q:a', '4', outPath],
      log,
      'fit_copy'
    );
  }
}

function concatMp3List(segmentPaths, outPath, log) {
  const listFile = path.join(path.dirname(outPath), `mix_concat_${Date.now()}.txt`);
  try {
    const lines = segmentPaths.map((p) => {
      const normalized = path.resolve(p).replace(/\\/g, '/');
      return `file '${normalized.replace(/'/g, "'\\''")}'`;
    });
    fs.writeFileSync(listFile, lines.join('\n'), 'utf8');
    return runFfmpeg(
      ['-y', '-f', 'concat', '-safe', '0', '-i', listFile, '-c:a', 'libmp3lame', '-q:a', '4', outPath],
      log,
      'concat_mix'
    );
  } finally {
    try {
      if (fs.existsSync(listFile)) fs.unlinkSync(listFile);
    } catch (_) {}
  }
}

function alignAudioToVideoDuration(inMp3, videoDur, outPath, log) {
  const n = ffprobeDurationSec(inMp3);
  if (n == null || !Number.isFinite(videoDur) || videoDur <= 0.1) return false;
  const eps = 0.08;
  if (n > videoDur + eps) {
    const factor = n / videoDur;
    const chain = buildAtempoChain(factor);
    if (!chain) {
      try {
        fs.copyFileSync(inMp3, outPath);
        return true;
      } catch (_) {
        return false;
      }
    }
    return runFfmpeg(
      ['-y', '-i', inMp3, '-af', chain, '-t', String(videoDur), '-c:a', 'libmp3lame', '-q:a', '4', outPath],
      log,
      'align_speed'
    );
  }
  if (n < videoDur - eps) {
    const pad = videoDur - n;
    return runFfmpeg(
      ['-y', '-i', inMp3, '-af', `apad`, '-t', String(videoDur), '-c:a', 'libmp3lame', '-q:a', '4', outPath],
      log,
      'align_pad'
    );
  }
  try {
    fs.copyFileSync(inMp3, outPath);
    return true;
  } catch (_) {
    return false;
  }
}

function amixTwoTracks(pathA, pathB, slotSec, outPath, log) {
  return runFfmpeg(
    [
      '-y', '-i', pathA, '-i', pathB,
      '-filter_complex', `[0:a][1:a]amix=inputs=2:duration=first:dropout_transition=2[aout]`,
      '-map', '[aout]',
      '-t', String(slotSec),
      '-c:a', 'libmp3lame', '-q:a', '4',
      outPath,
    ],
    log,
    'amix_seg'
  );
}

/**
 * 构造「原生音频床」滤镜链。
 *
 * 背景：MiniMax H3 是原生同步音频模型（画面/音效/音乐单次前向一起出），而此前最终合成只有
 * TTS 一条轨（`-map 0:v -map 1:a`），H3 生成的环境音/音效被整条丢掉。这里把它接回来当垫底轨。
 *
 * 关键点：**有对白的镜头必须压低**。H3 在有台词的镜头里会自己生成人声（实测 mean −14 dB），
 * 直接垫在 TTS 对白下会变成两个人同时说话。压到 duck 倍率后，H3 人声落到 −36 dB 量级，
 * 与 TTS 抢不了戏，而该镜的环境音仍在（避免环境音在对话时整段断掉）。
 *
 * 用 volume 的 timeline `enable` 表达式一次完成，避免 asplit/concat 把每个镜头切一遍。
 * 注意：ffmpeg 的 filter 参数里逗号是分隔符，但被单引号括住即为字面量，所以表达式整体用 '...'。
 *
 * @param {Array<[number, number]>} dialogueSlots 有对白的镜头时间窗 [startSec, endSec]
 * @param {number} gainFactor 全局线性增益倍率
 * @param {number} duck 有对白镜头的压低倍率
 */
function buildNativeBedFilter(dialogueSlots, gainFactor, duck) {
  const slots = (dialogueSlots || []).filter((s) => Array.isArray(s) && s.length === 2);
  const gain = Number.isFinite(gainFactor) && gainFactor > 0 ? gainFactor : 1;
  const d = Number.isFinite(duck) && duck > 0 && duck <= 1 ? duck : 1;
  if (!slots.length) return `[0:a]volume=${gain}[bed]`;
  const cond = slots
    .map(([s, e]) => `between(t,${Number(s).toFixed(3)},${Number(e).toFixed(3)})`)
    .join('+');
  return `[0:a]volume='if(${cond},${d},1)*${gain}':eval=frame[bed]`;
}

function getDrawtextFontOption() {
  const candidates = [];
  if (process.platform === 'win32') {
    // 真正跑在 Windows 上时用系统自带字体（在 Windows 内使用是授权允许的）
    const root = process.env.SystemRoot || 'C:\\Windows';
    candidates.push(
      path.join(root, 'Fonts', 'msyh.ttc'),
      path.join(root, 'Fonts', 'simhei.ttf')
    );
  }
  // Linux/WSL：优先【可免费商用】的 Noto Sans CJK（思源黑体，SIL OFL 1.1，允许嵌入视频）。
  // 不要用从 Windows 拷来的微软雅黑/中易黑体 —— 它的授权只覆盖 Windows 系统内使用，
  // 拷到 Linux 侧并用于商业成片有版权风险。
  candidates.push(
    path.join(require('os').homedir(), '.fonts', 'NotoSansCJK-Regular.ttc'),
    '/usr/share/fonts/opentype/noto/NotoSansCJK-Regular.ttc'
  );
  candidates.push('/System/Library/Fonts/PingFang.ttc');
  for (const p of candidates) {
    if (p && fs.existsSync(p)) {
      return `:fontfile='${escapeFfmpegPath(p)}'`;
    }
  }
  return '';
}

/**
 * 字幕（libass）用的字体参数。
 *
 * 为什么必须显式指定字体名：即使装了中文字体并 fc-cache，
 * `fc-match sans-serif:lang=zh` 依然会命中 DejaVuSans（无中文字形）→ 中文渲染成方框。
 * 所以这里给出 fontsdir（让 libass 自己去目录里找）+ force_style 指定字体名。
 *
 * 字体选型：Noto Sans CJK SC（思源黑体）= SIL OFL 1.1，
 * 免费商用、允许嵌入视频；不使用微软雅黑/中易黑体这类仅授权 Windows 内使用的字体。
 */
function getSubtitleFontOptions() {
  const fonts = [
    { dir: path.join(require('os').homedir(), '.fonts'), file: 'NotoSansCJK-Regular.ttc', name: 'Noto Sans CJK SC' },
    { dir: '/usr/share/fonts/opentype/noto', file: 'NotoSansCJK-Regular.ttc', name: 'Noto Sans CJK SC' },
  ];
  for (const f of fonts) {
    try {
      if (f.dir && fs.existsSync(path.join(f.dir, f.file))) {
        return `:fontsdir='${escapeFfmpegPath(f.dir)}':force_style='FontName=${f.name}'`;
      }
    } catch (_) {}
  }
  // 找不到可免费商用的中文字体：不传额外参数（行为与旧版一致），
  // 由调用方在日志里提示（否则又会渲染成方框且很难查）
  return '';
}

/** 是否找得到可用的中文字体（供日志告警用） */
function hasCjkFont() {
  return !!getSubtitleFontOptions();
}

/**
 * @param {object} mergeOpts — burn_dialogue_audio, burn_narration_subtitles, watermark_text
 */
async function runMergedEpisodePostProcess(db, log, opts) {
  const { mergedAbsPath, storageRoot, scenes, episodeId, mergeOpts = {} } = opts;
  const wantDial = !!mergeOpts.burn_dialogue_audio;
  // 「字幕」与「旁白语音」按需求拆成两件事：
  //   wantSubs      = 生成 SRT 并把字幕烧进画面
  //   wantNarrAudio = 合成 TTS 旁白语音并混入成片
  // 旧行为是一个开关（burn_narration_subtitles）同时管两件事；为兼容老调用方，
  // 未显式传 mix_narration_audio 时仍跟随 burn_narration_subtitles。
  const wantSubs = !!mergeOpts.burn_narration_subtitles;
  const wantNarrAudio = mergeOpts.mix_narration_audio === undefined
    ? wantSubs
    : !!mergeOpts.mix_narration_audio;
  const wantNarr = wantNarrAudio; // 下方音频相关分支沿用这个变量名
  const watermarkText = (mergeOpts.watermark_text && String(mergeOpts.watermark_text).trim())
    ? String(mergeOpts.watermark_text).trim().slice(0, 200)
    : '';

  if (!mergedAbsPath || !fs.existsSync(mergedAbsPath) || !Array.isArray(scenes) || scenes.length === 0) {
    return { ok: false, error: '无效合成参数' };
  }

  const needAudio = wantDial || wantNarrAudio;
  if (!needAudio && !wantSubs && !watermarkText) {
    return { ok: false, error: 'NO_POST_OPTS' };
  }

  const videoDur = ffprobeDurationSec(mergedAbsPath);
  if (videoDur == null) {
    return { ok: false, error: '无法读取合成视频时长' };
  }

  const tempRoot = path.join(require('os').tmpdir(), 'drama-merged-post', String(episodeId || 0), String(Date.now()));
  fs.mkdirSync(tempRoot, { recursive: true });
  const ttsService = require('./ttsService');

  try {
    let alignedAudioPath = null;
    let srtPath = null;
    let srtLines = [];
    /** 有对白 TTS 的镜头时间窗，供原生音频床压低用（见 buildNativeBedFilter） */
    const dialogueSlots = [];

    // 注意：字幕只需要时间轴与 SRT 文案，不需要生成音频 —— 所以 wantSubs 开着也要进这个循环
    if (needAudio || wantSubs) {
      let tMs = 0;
      let tSec = 0;
      let srtIdx = 1;
      const segmentFiles = [];

      for (let i = 0; i < scenes.length; i++) {
        const sc = scenes[i];
        const sbId = Number(sc.scene_id);
        const slotSec = Math.max(0.2, Number(sc.duration) || 5);
        const row = db.prepare(
          'SELECT dialogue, narration, audio_local_path, narration_audio_local_path FROM storyboards WHERE id = ? AND deleted_at IS NULL'
        ).get(sbId);

        const narrText = (row?.narration && String(row.narration).trim()) ? String(row.narration).trim() : '';
        if (wantSubs && narrText) {
          const durMs = Math.round(slotSec * 1000);
          srtLines.push(String(srtIdx++), `${formatSrtTimestamp(tMs)} --> ${formatSrtTimestamp(tMs + durMs)}`, narrText, '');
        }
        tMs += Math.round(slotSec * 1000);
        const slotStartSec = tSec;
        tSec += slotSec;

        // 只加字幕（wantSubs 且 needAudio=false）时不需要生成任何音频片段；
        // 旧代码无条件往下走 -> segmentFiles 为空 -> concat 失败 -> 整个后处理被跳过。
        if (!needAudio) continue;

        const diaFit = path.join(tempRoot, `dia_fit_${i}.mp3`);
        const narrFit = path.join(tempRoot, `narr_fit_${i}.mp3`);
        const segOut = path.join(tempRoot, `seg_mix_${i}.mp3`);

        if (wantDial) {
          const rel = row?.audio_local_path && String(row.audio_local_path).trim();
          const srcAbs = rel ? path.join(storageRoot, rel.replace(/\//g, path.sep)) : null;
          if (srcAbs && fs.existsSync(srcAbs)) {
            dialogueSlots.push([slotStartSec, slotStartSec + slotSec]);
            if (!fitAudioToSlot(srcAbs, slotSec, diaFit, log)) {
              return { ok: false, error: `对白配音时长对齐失败 #${i}` };
            }
          } else if (!writeSilenceMp3(slotSec, diaFit, log)) {
            return { ok: false, error: `对白静音片段失败 #${i}` };
          }
        }

        if (wantNarrAudio) {
          if (!narrText) {
            if (!writeSilenceMp3(slotSec, narrFit, log)) {
              return { ok: false, error: `旁白静音片段失败 #${i}` };
            }
          } else {
            const segRaw = path.join(tempRoot, `narr_raw_${i}.mp3`);
            let synth;
            try {
              synth = await ttsService.synthesize(db, log, {
                text: narrText,
                storyboard_id: null,
                storage_base: storageRoot,
              });
            } catch (e) {
              log.warn('merged post: narration TTS failed', { segment: i, error: e.message });
              return { ok: false, error: `解说旁白 TTS 失败：${e.message}` };
            }
            const narrAbs = path.join(storageRoot, synth.local_path.replace(/\//g, path.sep));
            if (!fs.existsSync(narrAbs)) {
              return { ok: false, error: `旁白 TTS 文件不存在` };
            }
            try {
              fs.copyFileSync(narrAbs, segRaw);
            } catch (_) {
              return { ok: false, error: '复制旁白 TTS 失败' };
            }
            if (!fitAudioToSlot(segRaw, slotSec, narrFit, log)) {
              return { ok: false, error: `旁白时长对齐失败 #${i}` };
            }
          }
        }

        if (wantDial && wantNarr) {
          if (!amixTwoTracks(diaFit, narrFit, slotSec, segOut, log)) {
            return { ok: false, error: `对白与旁白混音失败 #${i}` };
          }
        } else if (wantDial) {
          try {
            fs.copyFileSync(diaFit, segOut);
          } catch (_) {
            return { ok: false, error: `对白片段复制失败 #${i}` };
          }
        } else if (wantNarrAudio) {
          try {
            fs.copyFileSync(narrFit, segOut);
          } catch (_) {
            return { ok: false, error: `旁白片段复制失败 #${i}` };
          }
        }

        segmentFiles.push(segOut);
      }

      // 只在真的需要音频（对白 / 旁白配音）时拼接并对齐整条音轨
      if (needAudio) {
        const concatOut = path.join(tempRoot, 'full_mix.mp3');
        if (!concatMp3List(segmentFiles, concatOut, log)) {
          return { ok: false, error: '音轨拼接失败' };
        }

        alignedAudioPath = path.join(tempRoot, 'aligned_mix.mp3');
        if (!alignAudioToVideoDuration(concatOut, videoDur, alignedAudioPath, log)) {
          return { ok: false, error: '音轨与视频总时长对齐失败' };
        }

        // [独立产物] 把整条旁白/对白音轨另存到成片旁边，供后期剪辑单独取用。
        // 用户的诉求是「字幕」和「TTS 音频」分开拿，而不是全部烧死进视频。
        try {
          const aBase = path.basename(mergedAbsPath, path.extname(mergedAbsPath));
          const audioOut = path.join(path.dirname(mergedAbsPath), `${aBase}_narration.mp3`);
          fs.copyFileSync(alignedAudioPath, audioOut);
          log.info('merged post: 已导出独立旁白音轨（供后期剪辑）', { file: path.basename(audioOut) });
        } catch (e) {
          log.warn('merged post: 导出独立旁白音轨失败（不影响成片）', { error: e.message });
        }
      }

      if (wantSubs && srtLines.length > 0) {
        const baseName = path.basename(mergedAbsPath, path.extname(mergedAbsPath));
        srtPath = path.join(path.dirname(mergedAbsPath), `${baseName}_narration.srt`);
        log.info('merged post: 已导出独立字幕文件（供后期剪辑）', { file: path.basename(srtPath) });
        fs.writeFileSync(srtPath, `\uFEFF${srtLines.join('\n')}\n`, 'utf8');
      }
    }

    const baseName = path.basename(mergedAbsPath, path.extname(mergedAbsPath));
    const outAbs = path.join(path.dirname(mergedAbsPath), `${baseName}_post.mp4`);

    const hasSubs = !!(srtPath && fs.existsSync(srtPath));
    const hasWm = !!watermarkText;

    const vfParts = [];
    if (hasSubs) {
      const subEsc = escapeFfmpegPath(srtPath);
      // 必须带上中文字体参数，否则 libass 回退到 DejaVu（无中文字形）→ 中文字幕全变方框。
      const fontOpt = getSubtitleFontOptions();
      if (!fontOpt) {
        log.warn('merged post: 未找到可用的中文字体，字幕中文可能显示为方框', {
          hint: '安装思源黑体/Noto Sans CJK：apt-get download fonts-noto-cjk && 解包后把 NotoSansCJK-Regular.ttc 放进 ~/.fonts 再 fc-cache -f',
        });
      }
      vfParts.push(`subtitles='${subEsc}':charenc=UTF-8${fontOpt}`);
    }
    if (hasWm) {
      const wmFile = path.join(tempRoot, 'watermark.txt');
      fs.writeFileSync(wmFile, watermarkText, 'utf8');
      const wmEsc = escapeFfmpegPath(wmFile);
      const fontOpt = getDrawtextFontOption();
      vfParts.push(
        `drawtext=textfile='${wmEsc}':reload=1${fontOpt}:x=w-tw-16:y=h-th-16:fontsize=22:fontcolor=white@0.82:borderw=2:bordercolor=black@0.55`
      );
    }
    let filterComplex = '';
    if (vfParts.length === 1) {
      filterComplex = `[0:v]${vfParts[0]}[vout]`;
    } else if (vfParts.length === 2) {
      filterComplex = `[0:v]${vfParts[0]}[vx];[vx]${vfParts[1]}[vout]`;
    }

    if (needAudio) {
      if (!alignedAudioPath || !fs.existsSync(alignedAudioPath)) {
        return { ok: false, error: '内部错误：缺少对齐音轨' };
      }

      // 原生音频床：把合成视频自带的 H3 音轨接回来垫在 TTS 之下（环境音/音效/配乐）。
      // 失败不影响主流程 —— 探测不到音轨或参数异常就退回「只有 TTS」的老行为。
      const keepNative = mergeOpts.keep_native_audio !== false;
      const bedGainDb = Number.isFinite(Number(mergeOpts.native_audio_gain_db))
        ? Number(mergeOpts.native_audio_gain_db)
        : 6;
      const bedDuck = Number.isFinite(Number(mergeOpts.native_audio_duck))
        ? Number(mergeOpts.native_audio_duck)
        : 0.08;
      let bedChain = '';
      if (keepNative && ffprobeHasAudio(mergedAbsPath)) {
        bedChain = buildNativeBedFilter(dialogueSlots, Math.pow(10, bedGainDb / 20), bedDuck);
        log.info('merged post: 接入 H3 原生音频床', {
          gain_db: bedGainDb,
          duck_on_dialogue: bedDuck,
          dialogue_slots: dialogueSlots.length,
          total_slots: scenes.length,
        });
      }

      // [1:a]=TTS 对白/旁白，[bed]=原生环境音。不能让 ffmpeg 按输入数自动衰减
      // （两条轨各 −6 dB，会把 TTS 一起压小），所以混完补 volume=2 抵消掉。
      // 不用 amix 的 normalize=0：该选项 2021 年才加入，旧版 ffmpeg（如 4.1）会直接
      // 报 "Option 'normalize' not found" 并使整个滤镜图初始化失败，
      // 导致字幕/对白烧录被整体跳过（合成看着成功，成片却没有字幕）。
      // 两条轨都铺满全片，衰减恒为 1/2，故 volume=2 与 normalize=0 等价，且新旧版本通吃。
      const aChain = bedChain
        ? `${bedChain};[1:a][bed]amix=inputs=2:duration=first,volume=2[aout]`
        : '';
      const filters = [filterComplex, aChain].filter(Boolean).join(';');

      const args = ['-y', '-i', mergedAbsPath, '-i', alignedAudioPath];
      if (filters) {
        args.push('-filter_complex', filters);
        args.push('-map', filterComplex ? '[vout]' : '0:v');
        args.push('-map', bedChain ? '[aout]' : '1:a');
      } else {
        args.push('-map', '0:v', '-map', '1:a');
      }
      const head = args;
      const tail = ['-c:a', 'aac', '-b:a', '192k', '-shortest'];
      if (!encodeFinal(head, tail, outAbs, log, 'mux_av', mergeOpts)) {
        return { ok: false, error: '烧录字幕/水印或混音失败（AV1/H.264 编码器均不可用）' };
      }
    } else {
      if (!filterComplex) {
        return { ok: false, error: '内部错误：仅水印但无滤镜链' };
      }
      const args = ['-y', '-i', mergedAbsPath, '-filter_complex', filterComplex, '-map', '[vout]'];
      if (ffprobeHasAudio(mergedAbsPath)) {
        args.push('-map', '0:a', '-c:a', 'copy');
      } else {
        args.push('-an');
      }
      const head = args;
      const tail = [];
      if (!encodeFinal(head, tail, outAbs, log, 'watermark_only', mergeOpts)) {
        return { ok: false, error: '水印烧录失败（AV1/H.264 编码器均不可用）' };
      }
    }

    if (!fs.existsSync(outAbs)) {
      return { ok: false, error: '输出文件未生成' };
    }

    const relFromRoot = path.relative(storageRoot, outAbs).replace(/\\/g, '/');

    try {
      if (fs.existsSync(mergedAbsPath) && outAbs !== mergedAbsPath) {
        fs.unlinkSync(mergedAbsPath);
      }
    } catch (e) {
      log.warn('merged post: could not remove intermediate', { error: e.message });
    }

    log.info('merged post: done', { episode_id: episodeId, video: relFromRoot });
    return { ok: true, relativePath: relFromRoot };
  } catch (e) {
    log.warn('merged post: exception', { error: e.message });
    return { ok: false, error: e.message || String(e) };
  } finally {
    try {
      for (const p of fs.readdirSync(tempRoot)) {
        try {
          fs.unlinkSync(path.join(tempRoot, p));
        } catch (_) {}
      }
      fs.rmdirSync(tempRoot);
    } catch (_) {}
  }
}

function ffprobeHasAudio(filePath) {
  const probe = getFfprobePath();
  const r = spawnSync(
    probe,
    ['-v', 'error', '-select_streams', 'a', '-show_entries', 'stream=index', '-of', 'csv=p=0', filePath],
    { encoding: 'utf8', maxBuffer: 1024 * 1024 }
  );
  return r.status === 0 && String(r.stdout || '').trim().length > 0;
}

module.exports = {
  runMergedEpisodePostProcess,
  ffprobeDurationSec,
  buildNativeBedFilter,
  finalEncoderArgs,
};
