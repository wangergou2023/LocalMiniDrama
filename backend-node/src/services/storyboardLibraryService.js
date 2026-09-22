/**
 * 分镜参考图库：把满意的分镜图存成素材，供后续复用。
 *
 * 结构与 propLibraryService / sceneLibraryService 一致（同一套 libraryDedup 判重逻辑），
 * 差异只在「素材来源」是分镜：取分镜的 title / description / image_prompt / narration /
 * image_url / local_path 存档，再加一个 applyLibraryItemToStoryboard 把库里的图设回某个分镜的主图。
 *
 * 只做全局素材库（drama_id = NULL）：一条分镜本来就属于某一集，再存一份「本剧分镜库」是冗余。
 */
const {
  appendSourceIdFilters,
  insertLibraryItem,
  normalizeSourceId,
} = require('./libraryDedup');

const TABLE = 'storyboard_libraries';

function rowToItem(r) {
  return {
    id: r.id,
    drama_id: r.drama_id ?? null,
    name: r.name,
    description: r.description,
    prompt: r.prompt,
    narration: r.narration,
    image_url: r.image_url,
    local_path: r.local_path,
    category: r.category,
    tags: r.tags,
    source_type: r.source_type || 'storyboard',
    source_id: r.source_id || null,
    created_at: r.created_at,
    updated_at: r.updated_at,
  };
}

function listLibraryItems(db, query = {}) {
  let sql = `FROM ${TABLE} WHERE deleted_at IS NULL`;
  const params = [];
  if (query.global === '1' || query.global === 1) {
    sql += ' AND drama_id IS NULL';
  } else if (query.drama_id != null && query.drama_id !== '') {
    sql += ' AND drama_id = ?';
    params.push(Number(query.drama_id));
  }
  if (query.category) {
    sql += ' AND category = ?';
    params.push(query.category);
  }
  if (query.source_type) {
    sql += ' AND source_type = ?';
    params.push(query.source_type);
  }
  sql = appendSourceIdFilters(query, sql, params);
  if (query.keyword) {
    sql += ' AND (name LIKE ? OR description LIKE ? OR prompt LIKE ? OR narration LIKE ?)';
    const k = '%' + query.keyword + '%';
    params.push(k, k, k, k);
  }
  const countRow = db.prepare('SELECT COUNT(*) as total ' + sql).get(...params);
  const total = countRow.total || 0;
  const page = Math.max(1, parseInt(query.page, 10) || 1);
  const pageSize = Math.min(100, Math.max(1, parseInt(query.page_size, 10) || 20));
  const offset = (page - 1) * pageSize;
  const rows = db.prepare('SELECT * ' + sql + ' ORDER BY created_at DESC LIMIT ? OFFSET ?').all(...params, pageSize, offset);
  return { items: rows.map(rowToItem), total, page, pageSize };
}

function getLibraryItem(db, id) {
  const row = db.prepare(`SELECT * FROM ${TABLE} WHERE id = ? AND deleted_at IS NULL`).get(Number(id));
  return row ? rowToItem(row) : null;
}

function createLibraryItem(db, log, req) {
  const now = new Date().toISOString();
  const info = insertLibraryItem(db, TABLE, {
    drama_id: req.drama_id ?? null,
    name: req.name || '',
    description: req.description ?? null,
    prompt: req.prompt ?? null,
    narration: req.narration ?? null,
    image_url: req.image_url || '',
    local_path: req.local_path ?? null,
    category: req.category ?? null,
    tags: req.tags ?? null,
    source_type: req.source_type || 'manual',
    source_id: normalizeSourceId(req.source_id) || null,
    created_at: now,
    updated_at: now,
  });
  log.info('Storyboard library item created', { item_id: info.lastInsertRowid });
  return getLibraryItem(db, String(info.lastInsertRowid));
}

function updateLibraryItem(db, log, id, req) {
  const row = db.prepare(`SELECT id FROM ${TABLE} WHERE id = ? AND deleted_at IS NULL`).get(Number(id));
  if (!row) return null;
  const updates = [];
  const params = [];
  if (req.name != null) { updates.push('name = ?'); params.push(req.name); }
  if (req.description != null) { updates.push('description = ?'); params.push(req.description); }
  if (req.prompt != null) { updates.push('prompt = ?'); params.push(req.prompt); }
  if (req.narration != null) { updates.push('narration = ?'); params.push(req.narration); }
  if (req.image_url != null) { updates.push('image_url = ?'); params.push(req.image_url); }
  if (req.local_path != null) { updates.push('local_path = ?'); params.push(req.local_path); }
  if (req.category != null) { updates.push('category = ?'); params.push(req.category); }
  if (req.tags != null) { updates.push('tags = ?'); params.push(req.tags); }
  if (updates.length === 0) return getLibraryItem(db, id);
  params.push(new Date().toISOString(), Number(id));
  db.prepare(`UPDATE ${TABLE} SET ` + updates.join(', ') + ', updated_at = ? WHERE id = ?').run(...params);
  log.info('Storyboard library item updated', { item_id: id });
  return getLibraryItem(db, id);
}

function deleteLibraryItem(db, log, id) {
  const now = new Date().toISOString();
  const result = db.prepare(`UPDATE ${TABLE} SET deleted_at = ? WHERE id = ? AND deleted_at IS NULL`).run(now, Number(id));
  if (result.changes === 0) return false;
  log.info('Storyboard library item deleted', { item_id: id });
  return true;
}

function resolveImageUrl(image_url, local_path) {
  if (image_url && !image_url.startsWith('data:')) return image_url;
  if (local_path) return `/static/${local_path}`;
  return image_url || null;
}

/**
 * 取这一镜「最合适的那张图」。
 *
 * 分镜的图不一定挂在 storyboards 行上：实测旧项目 10 个镜头的 image_url 全为空，
 * 真正的图在 image_generations 里（frame_type = storyboard_first / storyboard_last）。
 * 优先级与前端一致：主图 → 已绑定的首帧 → storyboard_first → 尾帧 → storyboard_last。
 */
function resolveStoryboardImage(db, sb) {
  const pick = (row) => {
    if (!row) return null;
    if (!row.image_url && !row.local_path) return null;
    return {
      image_url: resolveImageUrl(row.image_url, row.local_path),
      local_path: row.local_path || null,
    };
  };
  const own = pick(sb);
  if (own) return own;

  if (sb.first_frame_image_id != null) {
    const row = db
      .prepare('SELECT image_url, local_path FROM image_generations WHERE id = ? AND deleted_at IS NULL')
      .get(Number(sb.first_frame_image_id));
    const hit = pick(row);
    if (hit) return hit;
  }

  const genSql = (frameType) =>
    db
      .prepare(
        `SELECT image_url, local_path FROM image_generations
         WHERE storyboard_id = ? AND frame_type = ? AND deleted_at IS NULL
           AND (image_url IS NOT NULL OR local_path IS NOT NULL)
         ORDER BY id DESC LIMIT 1`
      )
      .get(Number(sb.id), frameType);

  const first = pick(genSql('storyboard_first'));
  if (first) return first;

  const tail = pick({ image_url: sb.last_frame_image_url, local_path: sb.last_frame_local_path });
  if (tail) return tail;

  return pick(genSql('storyboard_last'));
}

function storyboardLibraryFields(sb, image, now) {
  const title = (sb.title || '').trim();
  return {
    drama_id: null,
    name: title || (sb.storyboard_number ? `第${sb.storyboard_number}镜` : '分镜参考图'),
    description: sb.description || sb.action || null,
    prompt: sb.image_prompt || null,
    narration: sb.narration || null,
    image_url: image.image_url,
    local_path: image.local_path,
    source_type: 'storyboard',
    source_id: normalizeSourceId(sb.id),
    updated_at: now,
  };
}

/**
 * 把某个分镜加入「分镜参考图」素材库（全局）。分镜没有图则拒绝。
 *
 * 这一库**允许重复**：同一个分镜（或同一张图）点几次就存几条，不做复用/覆盖。
 * 需求是「素材库支持重复」—— 素材本来就是拿来翻着挑的，多存几条比被悄悄合并掉好。
 * （其余三类库仍保留各自的 source_id/图片判重复用逻辑，不受影响。）
 */
function addStoryboardToMaterialLibrary(db, log, storyboardId) {
  const sb = db
    .prepare('SELECT * FROM storyboards WHERE id = ? AND deleted_at IS NULL')
    .get(Number(storyboardId));
  if (!sb) return { ok: false, error: 'storyboard not found' };
  const image = resolveStoryboardImage(db, sb);
  if (!image) return { ok: false, error: '该分镜还没有图' };
  const now = new Date().toISOString();
  const fields = storyboardLibraryFields(sb, image, now);
  const info = insertLibraryItem(db, TABLE, { ...fields, created_at: now });
  log.info('Storyboard added to material library', { storyboard_id: storyboardId, library_item_id: info.lastInsertRowid });
  return { ok: true, item: getLibraryItem(db, String(info.lastInsertRowid)), duplicated: false };
}

/**
 * 把「分镜参考图」库里某一项的图设为某个分镜的图（用户手动挑，不依赖名字匹配）。
 *
 * 关键：**要同时写进 image_generations 并把 first_frame_image_id 指过去**。
 * 只改 storyboards.image_url/local_path 是不够的 —— 实测「首尾帧双槽」模式的项目里，
 * 界面首帧槽显示的是 first_frame_image_id 指向的那条 image_generations 记录，
 * 分镜的图列表也来自 image_generations，所以只改分镜行会出现「导入成功但界面毫无变化」。
 *
 * 库里那张图是磁盘上的文件（local_path），这里为它建一条 completed 的图记录，
 * 两种模式（首尾帧 / 单主图）都能立刻看到。
 * opts.withFields 时一并把库项的画面提示词写回 image_prompt；
 * **不动 title / narration**：那是剧本与台词在用的内容。
 */
function applyLibraryItemToStoryboard(db, log, storyboardId, libraryItemId, opts = {}) {
  const item = getLibraryItem(db, libraryItemId);
  if (!item) return { ok: false, error: 'library item not found' };
  const sb = db
    .prepare('SELECT id, episode_id FROM storyboards WHERE id = ? AND deleted_at IS NULL')
    .get(Number(storyboardId));
  if (!sb) return { ok: false, error: 'storyboard not found' };
  const now = new Date().toISOString();

  // 分镜所属的剧（image_generations 的 drama_id 冗余字段，便于按剧检索）
  const ep = sb.episode_id
    ? db.prepare('SELECT drama_id FROM episodes WHERE id = ?').get(Number(sb.episode_id))
    : null;
  const dramaId = ep ? ep.drama_id : null;

  // 1) 为库项这张图建一条图记录（status=completed，前端列表只认 completed）
  const genInfo = db
    .prepare(
      `INSERT INTO image_generations
         (storyboard_id, episode_id, drama_id, provider, prompt, frame_type, image_url, local_path, status, created_at, updated_at, completed_at)
       VALUES (?, ?, ?, 'library', ?, 'storyboard_first', ?, ?, 'completed', ?, ?, ?)`
    )
    .run(
      Number(storyboardId),
      sb.episode_id ?? null,
      dramaId,
      item.prompt || null,
      item.image_url || null,
      item.local_path || null,
      now,
      now,
      now
    );
  const newGenId = genInfo.lastInsertRowid;

  // 2) 分镜行：主图 + 首帧都指向它
  const sets = ['image_url = ?', 'local_path = ?', 'first_frame_image_id = ?', 'updated_at = ?'];
  const vals = [item.image_url || null, item.local_path || null, newGenId, now];
  if (opts.withFields && item.prompt != null) {
    sets.push('image_prompt = ?');
    vals.push(item.prompt);
  }
  vals.push(Number(storyboardId));
  db.prepare(`UPDATE storyboards SET ${sets.join(', ')} WHERE id = ?`).run(...vals);

  log.info('Library item applied to storyboard', {
    storyboard_id: storyboardId,
    library_item_id: libraryItemId,
    new_image_generation_id: newGenId,
  });
  return { ok: true, image_generation_id: newGenId };
}

module.exports = {
  listLibraryItems,
  createLibraryItem,
  getLibraryItem,
  updateLibraryItem,
  deleteLibraryItem,
  addStoryboardToMaterialLibrary,
  applyLibraryItemToStoryboard,
};
