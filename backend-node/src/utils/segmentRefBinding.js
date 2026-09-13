/**
 * 全能提示词的**参考图绑定自检 / 自动修正**。
 *
 * 为什么需要 —— 用户实测发现的真实问题（drama4 ep1 镜1）：
 *   该镜 characters = 唐僧/悟空/八戒/沙僧 四人，槽位应为
 *     @图片1=场景、@图片2=唐僧、@图片3=悟空、@图片4=八戒、@图片5=沙僧
 *   但正文里**只用 @图片2 引了唐僧**，悟空/八戒/沙僧全是裸名字：
 *     「@图片2 的唐僧端坐马上居于队中，悟空扛棒昂首走在最前，八戒牵马相随，沙僧挑担殿后」
 *   → 那三个角色**拿不到任何参考图绑定**，身份一致性直接丢失（正是全能模式存在的意义）。
 *
 * 另有一类反向错误（同批 镜3）：characters = 悟空/唐僧 → @图片4 其实是**道具**槽，
 * 正文却写成「@图片4 的八戒缩肩屏息」→ 把金箍棒参考图绑到了八戒身上。
 *
 * 两类都能**确定性**判定并修正：
 *   ① 槽位存在、正文写了他的名字却没带 @图片N  → 在首次出现处补上
 *   ② @图片N 后面跟的名字与该槽位绑定的名字不符 → 改写成该名字对应的槽位；名字没有槽位则去掉这个引用
 * 说明性文字（说明头/第1-3行）与台词 <d>…</d> 一律不动。
 */

/** 只保留有图可用的槽位（与前端 collectSbOmniReferenceItems / 后端 bundle 的规则一致） */
function hasMediaRef(row) {
  if (!row) return false;
  const a = String(row.local_path || '').trim();
  const b = String(row.image_url || '').trim();
  return !!(a || b);
}

/**
 * 为某条分镜构建槽位表（顺序必须与**成片时的参考图顺序**一致）：
 *   场景 → 角色（按分镜 characters JSON 的本剧角色顺序）→ 道具（按 storyboard_props.prop_id 升序）
 * 上限 9 张（视频 API / H3 节点上限）。
 *
 * @returns {Array<{index:number, tag:string, kind:'场景'|'角色'|'道具', name:string}>}
 */
function buildSlotsForStoryboard(db, sb, opts = {}) {
  const sbId = Number(sb && sb.id);
  if (!sb && !opts.characterIds) return [];
  const slots = [];
  const push = (kind, name) => {
    const index = slots.length + 1;
    slots.push({ index, tag: `@图片${index}`, kind, name: String(name || '').trim() || kind });
  };

  // 场景
  try {
    if (sb.scene_id != null) {
      const row = db
        .prepare('SELECT location, local_path, image_url FROM scenes WHERE id = ? AND deleted_at IS NULL')
        .get(Number(sb.scene_id));
      if (hasMediaRef(row)) push('场景', row.location || '场景环境');
    }
  } catch (_) {}

  // 角色：以分镜 characters 的顺序为准（这是前端与渲染路径共同使用的顺序）。
  // 入库前 sb.characters 是数组，入库后是 JSON 字符串 —— 两种都要支持。
  const charIds = [];
  const pushCharIds = (arr) => {
    if (!Array.isArray(arr)) return;
    for (const item of arr) {
      const id = Number(typeof item === 'object' && item != null ? item.id : item);
      if (Number.isFinite(id) && !charIds.includes(id)) charIds.push(id);
    }
  };
  if (Array.isArray(opts.characterIds)) pushCharIds(opts.characterIds);
  if (!charIds.length) {
    try {
      pushCharIds(typeof sb.characters === 'string' ? JSON.parse(sb.characters) : sb.characters);
    } catch (_) {}
  }
  if (!charIds.length) {
    try {
      for (const link of db
        .prepare('SELECT character_id FROM storyboard_characters WHERE storyboard_id = ? ORDER BY id ASC')
        .all(sbId)) {
        const id = Number(link.character_id);
        if (Number.isFinite(id) && !charIds.includes(id)) charIds.push(id);
      }
    } catch (_) {}
  }
  const charNames = [];
  for (const id of charIds) {
    if (slots.length >= 9) break;
    let row = null;
    try {
      row = db.prepare('SELECT name, local_path, image_url FROM characters WHERE id = ? AND deleted_at IS NULL').get(id);
    } catch (_) {}
    if (!hasMediaRef(row)) continue;
    const nm = String((row && row.name) || '').trim();
    if (!nm || charNames.includes(nm)) continue;
    charNames.push(nm);
    push('角色', nm);
  }

  // 道具：入库后用 storyboard_props 关联；入库前用解析出来的 propIds
  try {
    const propRows = Array.isArray(opts.propIds) && opts.propIds.length
      ? db.prepare(
          `SELECT name, local_path, image_url FROM props
           WHERE deleted_at IS NULL AND id IN (${opts.propIds.map(() => '?').join(',')})
           ORDER BY id ASC`
        ).all(...opts.propIds)
      : db
          .prepare(
            `SELECT p.name, p.local_path, p.image_url FROM storyboard_props sp
             JOIN props p ON p.id = sp.prop_id AND p.deleted_at IS NULL
             WHERE sp.storyboard_id = ? ORDER BY sp.prop_id ASC`
          )
          .all(sbId);
    for (const row of propRows) {
      if (slots.length >= 9) break;
      if (!hasMediaRef(row)) continue;
      push('道具', row.name || '道具');
    }
  } catch (_) {}

  return slots;
}

/** 正文里所有 @图片N 的位置与后随词（用于判定绑定是否正确） */
const REF_RE = /@图片\s*(\d+)\s*/g;

/**
 * 正文使用的槽位与槽位表的差异。
 *
 * @param {string} ust
 * @param {Array} slots
 * @returns {{missing:Array<{tag:string,name:string}>, unknown:number[], mismatched:Array<{tag:string,written:string,expectedTag:string|null}>}}
 *   missing    槽位存在、正文提到该名字却没引用它
 *   unknown    引用了不存在的槽位序号
 *   mismatched @图片N 后面跟的名字与该槽位绑定的名字不符
 */
/** 去掉 @图片N 与名字之间常见的「的」与空白/标点 */
function stripLeading(text) {
  return String(text || '').replace(/^[\s的之、，,：:]*/, '');
}

/**
 * 该位置出现的 name 是否其实是**更长名字的一部分**（例如「悟空」出现在「假悟空」里）。
 * 不做这个判断，补引用就会把 @图片3(悟空) 插到「假悟空」前面 —— 那是另一个角色。
 */
function isPartOfLongerName(text, pos, name, allNames) {
  for (const other of allNames) {
    if (!other || other === name || other.length <= name.length) continue;
    const start = pos - (other.length - name.length);
    for (let off = Math.max(0, pos - other.length + 1); off <= pos && off + other.length <= text.length; off++) {
      if (text.startsWith(other, off) && pos >= off && pos + name.length <= off + other.length) return true;
    }
    if (start >= 0 && text.startsWith(other, start)) return true;
  }
  return false;
}

/**
 * @param {string} ust
 * @param {Array} slots
 * @param {{ knownNames?: string[] }} [opts] 本剧全部实体名（角色/道具/场景），
 *        用于识别「引用了一个**没有槽位**的角色」——例如 镜3 把 @图片4(金箍棒) 写成了八戒
 */
function checkSegmentRefBinding(ust, slots, opts = {}) {
  const text = String(ust || '');
  const byIndex = new Map((slots || []).map((s) => [s.index, s]));
  const allNames = Array.from(new Set(
    (slots || []).map((s) => s.name).concat(Array.isArray(opts.knownNames) ? opts.knownNames : []).filter(Boolean)
  ));
  const unknown = [];
  const mismatched = [];
  const used = new Set();

  REF_RE.lastIndex = 0;
  let m;
  while ((m = REF_RE.exec(text))) {
    const idx = Number(m[1]);
    used.add(idx);
    const slot = byIndex.get(idx);
    const after = stripLeading(text.slice(m.index + m[0].length, m.index + m[0].length + 14));
    if (!slot) { unknown.push(idx); continue; }
    if (after.startsWith(slot.name)) continue;                    // 绑定正确
    // 后随词若以**别的实体名**开头 → 序号写错了
    const wrongName = allNames
      .filter((n) => n !== slot.name && after.startsWith(n))
      .sort((a, b) => b.length - a.length)[0];
    if (wrongName) {
      const target = (slots || []).find((s) => s.name === wrongName);
      mismatched.push({ tag: slot.tag, written: wrongName, expectedTag: target ? target.tag : null });
    }
  }

  const missing = [];
  for (const s of slots || []) {
    if (used.has(s.index)) continue;
    // 只在「正文确实提到该名字」时才要求引用（没出场的角色不该被强行加引用）
    if (!s.name) continue;
    let pos = text.indexOf(s.name);
    while (pos >= 0 && isPartOfLongerName(text, pos, s.name, allNames)) {
      pos = text.indexOf(s.name, pos + 1);
    }
    if (pos >= 0) missing.push({ tag: s.tag, name: s.name });
  }
  return { missing, unknown, mismatched };
}

/**
 * 就地修正三类绑定问题（**确定性**，不调模型）：
 *   ① 序号写错（@图片N 后随另一个槽位的名字）→ 换成正确槽位
 *   ② 引用了没有槽位的角色（如 镜3 的 @图片4=金箍棒 却写「八戒」）→ 去掉引用，只留名字，
 *      宁可不引用也不能把参考图绑错
 *   ③ 槽位存在、正文提到名字却没引用 → 在**首次干净出现处**补上引用
 * 台词 `<d>…</d>` 与前面 3 行骨架一律不动；「假悟空」里的「悟空」不会被误补引用。
 *
 * @returns {{text:string, changes:string[]}}
 */
function repairSegmentRefBinding(ust, slots, opts = {}) {
  const raw = String(ust || '');
  const changes = [];
  if (!raw.trim() || !(slots || []).length) return { text: raw, changes };
  const allNames = Array.from(new Set(
    (slots || []).map((s) => s.name).concat(Array.isArray(opts.knownNames) ? opts.knownNames : []).filter(Boolean)
  ));

  const lines = raw.split('\n');
  for (let li = 0; li < lines.length; li++) {
    if (!/^\s*分镜\s*\d+\s*[:：]/.test(lines[li])) continue;   // 只动正文行
    let out = lines[li];
    const dlg = [];
    out = out.replace(/<d>[\s\S]*?<\/d>/g, (mm) => { dlg.push(mm); return '#D' + (dlg.length - 1) + '#'; });

    // ① / ② 逐个引用核对
    out = out.replace(/@图片\s*(\d+)(\s*)/g, (mm, num, sp) => {
      const idx = Number(num);
      const slot = (slots || []).find((s) => s.index === idx);
      const after = stripLeading(out.slice(out.indexOf(mm) + mm.length));
      const written = allNames
        .filter((n) => after.startsWith(n))
        .sort((a, b) => b.length - a.length)[0];
      if (slot && (!written || written === slot.name)) return mm;      // 正确
      if (written) {
        const target = (slots || []).find((s) => s.name === written);
        if (target) {
          changes.push(`镜内 ${slot ? slot.tag : '@图片' + idx} → ${target.tag}（后随「${written}」）`);
          return `${target.tag}${sp}`;
        }
        changes.push(`去掉错误引用 @图片${idx}（后随「${written}」无对应槽位）`);
        return '';
      }
      if (!slot) { changes.push(`去掉不存在的槽位 @图片${idx}`); return ''; }
      return mm;
    });

    // ③ 补漏引：名字首次「干净」出现处补上引用
    for (const s of slots || []) {
      if (!s.name) continue;
      if (new RegExp('@图片\\s*' + s.index + '(?![0-9])').test(out)) continue;
      let pos = out.indexOf(s.name);
      while (pos >= 0) {
        const before = out.slice(0, pos);
        const alreadyRefd = /@图片\s*\d+\s*$/.test(before);
        if (!alreadyRefd && !isPartOfLongerName(out, pos, s.name, allNames)) break;
        pos = out.indexOf(s.name, pos + 1);
      }
      if (pos < 0) continue;
      out = out.slice(0, pos) + s.tag + ' ' + out.slice(pos);
      changes.push(`补引 ${s.tag}=${s.name}`);
    }

    out = out.replace(/#D(\d+)#/g, (mm, i) => (dlg[Number(i)] != null ? dlg[Number(i)] : mm));
    lines[li] = out;
  }

  return { text: changes.length ? lines.join('\n') : raw, changes };
}

module.exports = { buildSlotsForStoryboard, checkSegmentRefBinding, repairSegmentRefBinding, hasMediaRef };
