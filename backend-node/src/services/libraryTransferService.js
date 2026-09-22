'use strict';
/**
 * 素材库的导入 / 导出（角色 / 场景 / 道具 / 分镜 四类共用一套实现）。
 *
 * 导出：把「素材库」条目（全局条目，即 drama_id IS NULL）打成一个 zip：
 *   items.json        条目字段 + 图片在包内的相对路径 + 图片 sha256
 *   images/<文件>     图片原文件
 * 导入：读同一个 zip，把图片落进 storage，再插入素材库（drama_id 置空）。
 *   —— 按【身份字段 + 图片 sha256】判重，重复的跳过并在结果里报数，
 *      这样同一份文件重复导入不会把库翻倍。
 *
 * 四张表字段名不同（scene 用 location/time，character 有 appearance 等），
 * 所以这里用一份配置表描述每类库的字段，逻辑本身共用。
 */
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const AdmZip = require('adm-zip');

/** 各类素材库的配置：表名 / 身份字段 / 可迁移字段 / 图片字段 / 导入后的存放目录 */
const LIBS = {
  character: {
    table: 'character_libraries',
    zh: '素材角色',
    identity: 'name',
    fields: ['name', 'category', 'description', 'tags', 'appearance', 'identity_anchors', 'style_tokens', 'color_palette', 'source_type', 'source_id', 'image_url'],
    imageField: 'local_path',
    dir: 'library/characters',
  },
  scene: {
    table: 'scene_libraries',
    zh: '素材场景',
    identity: 'location',
    fields: ['location', 'time', 'prompt', 'description', 'category', 'tags', 'source_type', 'source_id', 'image_url'],
    imageField: 'local_path',
    dir: 'library/scenes',
  },
  prop: {
    table: 'prop_libraries',
    zh: '素材道具',
    identity: 'name',
    fields: ['name', 'description', 'prompt', 'category', 'tags', 'source_type', 'source_id', 'image_url'],
    imageField: 'local_path',
    dir: 'library/props',
  },
  storyboard: {
    table: 'storyboard_libraries',
    zh: '素材分镜',
    identity: 'name',
    fields: ['name', 'description', 'prompt', 'narration', 'category', 'tags', 'source_type', 'source_id', 'image_url'],
    imageField: 'local_path',
    dir: 'library/storyboards',
  },
};

function getLib(kind) {
  return LIBS[String(kind || '').toLowerCase()] || null;
}

function sha256(buf) {
  return crypto.createHash('sha256').update(buf).digest('hex');
}

/** 导出：返回 { ok, buffer, filename, count } */
function exportLibrary(db, log, kind, storageRoot) {
  const cfg = getLib(kind);
  if (!cfg) return { ok: false, error: '未知的素材库类型：' + kind };
  const rows = db
    .prepare(`SELECT * FROM ${cfg.table} WHERE deleted_at IS NULL AND drama_id IS NULL ORDER BY id`)
    .all();
  const zip = new AdmZip();
  const items = [];
  for (const r of rows) {
    const item = { _source_id: r.id };
    for (const f of cfg.fields) item[f] = r[f] == null ? null : r[f];
    const rel = r[cfg.imageField] ? String(r[cfg.imageField]) : '';
    if (rel) {
      const abs = path.join(storageRoot, rel.replace(/\//g, path.sep));
      try {
        if (fs.existsSync(abs)) {
          const buf = fs.readFileSync(abs);
          const ext = path.extname(abs) || '.png';
          const inner = `images/${item._source_id}_${sha256(buf).slice(0, 8)}${ext}`;
          zip.addFile(inner, buf);
          item._file = inner;
          item._sha256 = sha256(buf);
        }
      } catch (e) {
        log && log.warn && log.warn('[素材库导出] 读图失败，跳过该图', { id: r.id, error: e.message });
      }
    }
    items.push(item);
  }
  zip.addFile('library.json', Buffer.from(JSON.stringify({
    kind: String(kind).toLowerCase(),
    zh: cfg.zh,
    exported_at: new Date().toISOString(),
    count: items.length,
    items,
  }, null, 2), 'utf8'));
  const filename = `${cfg.zh}_${new Date().toISOString().slice(0, 10)}.zip`;
  log && log.info && log.info('[素材库导出] 完成', { kind, count: items.length, filename });
  return { ok: true, buffer: zip.toBuffer(), filename, count: items.length };
}

/** 导入：返回 { ok, added, skipped, failed, errors } */
function importLibrary(db, log, kind, buffer, storageRoot) {
  const cfg = getLib(kind);
  if (!cfg) return { ok: false, error: '未知的素材库类型：' + kind };
  let zip;
  try {
    zip = new AdmZip(buffer);
  } catch (e) {
    return { ok: false, error: '不是有效的 zip 文件：' + e.message };
  }
  const entry = zip.getEntry('library.json');
  if (!entry) return { ok: false, error: '压缩包里缺少 library.json（请使用本软件导出的文件）' };
  let payload;
  try {
    payload = JSON.parse(entry.getData().toString('utf8'));
  } catch (e) {
    return { ok: false, error: 'library.json 解析失败：' + e.message };
  }
  if (payload.kind && String(payload.kind).toLowerCase() !== String(kind).toLowerCase()) {
    return { ok: false, error: `这份文件是「${payload.zh || payload.kind}」的，不能导入到「${cfg.zh}」` };
  }

  const items = Array.isArray(payload.items) ? payload.items : [];
  const now = new Date().toISOString();
  // 已有的（身份, 图 sha）组合，用于判重
  const existing = db
    .prepare(`SELECT ${cfg.identity} AS idv, ${cfg.imageField} AS img FROM ${cfg.table} WHERE deleted_at IS NULL`)
    .all();
  const existKeys = new Set();
  for (const e of existing) {
    const idv = String(e.idv == null ? '' : e.idv).trim();
    let s = '';
    if (e.img) {
      try {
        const abs = path.join(storageRoot, String(e.img).replace(/\//g, path.sep));
        if (fs.existsSync(abs)) s = sha256(fs.readFileSync(abs));
      } catch (_) {}
    }
    existKeys.add(idv + '|' + s);
  }

  const insCols = [cfg.identity, cfg.imageField, 'drama_id', ...cfg.fields.filter((f) => f !== cfg.identity), 'created_at', 'updated_at'];
  const insSql = `INSERT INTO ${cfg.table} (${insCols.join(', ')}) VALUES (${insCols.map(() => '?').join(', ')})`;

  let added = 0;
  let skipped = 0;
  const errors = [];
  for (const it of items) {
    try {
      const idv = String(it[cfg.identity] == null ? '' : it[cfg.identity]).trim();
      let newRel = null;
      let imgSha = '';
      if (it._file) {
        const ze = zip.getEntry(String(it._file));
        if (ze) {
          const buf = ze.getData();
          imgSha = sha256(buf);
          const ext = path.extname(String(it._file)) || '.png';
          const base = String(it._source_id != null ? it._source_id : Date.now()) + '_' + imgSha.slice(0, 8);
          newRel = path.posix.join(cfg.dir, base + ext);
          const abs = path.join(storageRoot, newRel.replace(/\//g, path.sep));
          fs.mkdirSync(path.dirname(abs), { recursive: true });
          fs.writeFileSync(abs, buf);
        }
      }
      const key = idv + '|' + imgSha;
      if (existKeys.has(key)) {
        skipped += 1;
        continue;
      }
      const vals = [];
      for (const col of insCols) {
        if (col === cfg.identity) vals.push(it[cfg.identity] ?? null);
        else if (col === cfg.imageField) vals.push(newRel);
        else if (col === 'drama_id') vals.push(null);
        else if (col === 'created_at' || col === 'updated_at') vals.push(now);
        else vals.push(it[col] ?? null);
      }
      db.prepare(insSql).run(...vals);
      existKeys.add(key);
      added += 1;
    } catch (e) {
      errors.push({ item: it && it[cfg.identity], error: e.message });
    }
  }
  log && log.info && log.info('[素材库导入] 完成', { kind, added, skipped, failed: errors.length });
  return { ok: true, added, skipped, failed: errors.length, errors: errors.slice(0, 10), total: items.length };
}

module.exports = { LIBS, getLib, exportLibrary, importLibrary };
