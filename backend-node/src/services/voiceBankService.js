/**
 * 内置音色库服务
 * 从 software 自带的 voice-bank 资源目录读取预置 TTS 音色，
 * 供角色「从内置音色库选择」使用（Seedance 2.0 / MiniMax H3 均生效）。
 *
 * 资源目录：backend-node/src/assets/voice-bank/
 *   ├── labels.json      → 音色元数据（中文名 / 性别 / 方言 / 风格）
 *   └── voices/*.mp3     → 音色参考音频
 * 打包后由 prepare-backend 拷入 backend-app/src/assets/voice-bank/，随 exe 分发。
 */
const fs = require('fs');
const path = require('path');

/** 内置音色库资源根目录（相对本文件 src/services/ -> ../assets/voice-bank） */
function voiceBankRoot() {
  return path.join(__dirname, '..', 'assets', 'voice-bank');
}

/**
 * 兼容 Electron asar / asar.unpacked 的真实路径解析。
 * 打包后 backend-app/src/assets/voice-bank 会被 asarUnpack 移到 app.asar.unpacked/，
 * 而 fs.existsSync 对 asar 内的 unpacked 条目会失败，因此需要同时探测两处。
 */
function resolveVoiceBankRoot() {
  const inAsar = path.join(__dirname, '..', 'assets', 'voice-bank');
  if (fs.existsSync(inAsar)) return inAsar;
  // 若 __dirname 形如 .../app.asar/backend-app/src/services，则 unpacked 在 .../app.asar.unpacked/backend-app/...
  const asarMarker = path.sep + 'app.asar' + path.sep;
  if (__dirname.includes(asarMarker)) {
    const unpacked = __dirname.replace(asarMarker, path.sep + 'app.asar.unpacked' + path.sep);
    const out = path.join(unpacked, '..', 'assets', 'voice-bank');
    if (fs.existsSync(out)) return out;
  }
  return inAsar;
}

/** 读取音色元数据：返回 [{ key, name, gender, lang, style }] */
function listVoices() {
  const root = resolveVoiceBankRoot();
  const labelsPath = path.join(root, 'labels.json');
  if (!fs.existsSync(labelsPath)) return [];
  let labels = {};
  try {
    labels = JSON.parse(fs.readFileSync(labelsPath, 'utf8'));
  } catch (_) {
    return [];
  }
  return Object.entries(labels).map(([key, label]) => {
    // label 形如 "晓晓 XiaoXiao · 女 · 普通话·温暖"
    const parts = String(label || '').split('·').map((s) => s.trim());
    return {
      key,
      name: parts[0] || key,
      raw: label,
      gender: parts.find((p) => /女|男/.test(p)) || '',
      lang: parts.find((p) => /普通话|粤语|国语|东北|陕西|方言/.test(p)) || '',
      style: parts[parts.length - 1] || '',
      exists: fs.existsSync(path.join(root, 'voices', `${key}.mp3`)),
    };
  });
}

/** 根据 voiceKey 定位内置音色的音频文件绝对路径 */
function voiceAudioPath(voiceKey) {
  const safe = String(voiceKey || '')
    // 仅防目录穿越：去掉路径分隔符与 ..，保留中文/字母/数字/./-
    .replace(/[\\\/]/g, '')
    .replace(/\.\./g, '')
    .trim();
  if (!safe) return null;
  const p = path.join(resolveVoiceBankRoot(), 'voices', `${safe}.mp3`);
  return fs.existsSync(p) ? p : null;
}

/**
 * 把某个内置音色应用到角色：复制 mp3 到角色的 voice 目录，
 * 写入 seedance2_voice_asset（status=active），与手动上传等价。
 * @returns {{ ok: boolean, error?: string, seedance2_voice_asset?: object }}
 */
function applyVoiceToCharacter(db, cfg, charId, voiceKey) {
  try {
    const charRow = db
      .prepare('SELECT id, drama_id FROM characters WHERE id = ? AND deleted_at IS NULL')
      .get(Number(charId));
    if (!charRow) return { ok: false, error: '角色不存在' };

    const srcPath = voiceAudioPath(voiceKey);
    if (!srcPath) return { ok: false, error: `内置音色不存在：${voiceKey}` };

    // 角色音色存储基路径（与 sd2VoiceUpload 一致）
    const storageLocalPath = cfg?.storage?.local_path;
    const storageRoot = storageLocalPath
      ? path.isAbsolute(storageLocalPath)
        ? storageLocalPath
        : path.join(process.cwd(), storageLocalPath)
      : path.join(process.cwd(), 'data', 'storage');

    const relDir = `drama_${charRow.drama_id}/characters/voice`;
    const absDir = path.join(storageRoot, relDir);
    if (!fs.existsSync(absDir)) fs.mkdirSync(absDir, { recursive: true });

    const safeName = `char_${charId}_voice_${Date.now()}.mp3`;
    const absPath = path.join(absDir, safeName);
    fs.copyFileSync(srcPath, absPath, fs.constants.COPYFILE_FICLONE);

    const publicUrl = `/static/${relDir}/${safeName}`;
    const now = new Date().toISOString();

    const payload = {
      status: 'active',
      url: publicUrl,
      local_path: `${relDir}/${safeName}`,
      certified_at: now,
      duration: null,
      format: 'mp3',
      source: 'voice_bank',
      voice_key: voiceKey,
    };

    db.prepare('UPDATE characters SET seedance2_voice_asset = ?, updated_at = ? WHERE id = ?').run(
      JSON.stringify(payload),
      now,
      charId
    );

    return { ok: true, seedance2_voice_asset: payload };
  } catch (err) {
    return { ok: false, error: err.message };
  }
}

module.exports = { listVoices, applyVoiceToCharacter, voiceAudioPath, voiceBankRoot };
