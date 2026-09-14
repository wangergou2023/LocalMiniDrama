'use strict';
/**
 * 项目英文风格块 → 视频提示词的**位置**注入。
 *
 * 实测事故（drama 6《西游记-盘丝洞》vg76/vg77，2026-09-15）：
 * 原来的实现是 `prompt = prompt + '. Style: ' + style`，把风格块贴在**提示词最末尾**
 * （Ref2VA 六段结构的 §6 non_diegetic_music 之后）。结果模型基本无视它：
 * §5 里 LLM 自己写的风格句「in ink-wash tones, with **warm green forest hues**」
 * 反而成了主导，成片是一整片彩色森林，参考图（六格水墨山道场景图）的墨色与空间全丢。
 *
 * 正确位置是 §5 detailed_description 的**段首**：官方 Ref2VA 结构里「1-2 句风格句」就该写在
 * [Shot 1] 之前，那才是模型当作画风指令读的地方。
 */
function escapeRe(text) {
  return String(text).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** §5 detailed_description 段内是否已经带着风格块 */
function styleInsideSection(prompt, style) {
  // 注意 lookahead 要排除 Style: 行本身 —— 否则「§5 段首就是 Style: 行」时会把整段截成空串
  const m = /(^|\n)detailed_description:[ \t]*([\s\S]*?)(?=\n(?!style:)[A-Za-z_]+:|$)/i.exec(prompt);
  return m ? m[2].toLowerCase().includes(style.toLowerCase()) : false;
}

function injectStyleIntoVideoPrompt(prompt, style) {
  const raw = String(prompt == null ? '' : prompt);
  const s = String(style == null ? '' : style).trim();
  if (!s) return raw;
  if (styleInsideSection(raw, s)) return raw;
  // 旧写法留下的「. Style: …」尾巴先摘掉，再放到 §5 段首，避免同时存在两处
  let p = raw;
  const tailRe = new RegExp(`[\\s.。]*Style:[ \\t]*${escapeRe(s)}[ \\t]*$`, 'i');
  if (tailRe.test(p)) p = p.replace(tailRe, '').replace(/[\s.。]+$/, '');
  const m = /(^|\n)(detailed_description:[ \t]*)/.exec(p);
  if (!m) {
    // 非六段结构（老格式/自由文本）保留旧行为：贴末尾
    return p ? `${p}. Style: ${s}` : `Style: ${s}`;
  }
  const idx = m.index + m[0].length;
  const head = p.slice(0, idx).replace(/\s+$/, '');
  let rest = p.slice(idx).replace(/^[ \t]*\n+/, '');
  // §5.1 按官方结构就该是「1-2 句风格句」：把 LLM 自己写的那句**替换掉**。
  // 实测：只并列写入时，LLM 那句「warm green forest hues」会把画面带成彩色森林（vg78 仍是绿林），
  // 风格块必须独占这个位置。替换范围 = §5 开头到第一个 [Shot N] 之前。
  const iShot = rest.indexOf('[Shot ');
  if (iShot > 0) rest = rest.slice(iShot);
  return `${head}\nStyle: ${s}\n${rest}`;
}

module.exports = { injectStyleIntoVideoPrompt };
