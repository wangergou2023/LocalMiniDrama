/**
 * H3 台词标记工具（渲染阶段与英译前置步骤共用）。
 *
 * 为什么需要对白标记 —— 实测结论（镜 3，同一 seed、同一参考图与参考音频，只改写法）：
 *
 *   中文正文 + 裸引号台词
 *     → 模型把 <d> 之后的描述文字也念出来（用户听到「话音落定，他抬手轻抚马鬃」），
 *       且角色嘴不动（被当成旁白）
 *   英文正文 + <d>[Chinese] 台词</d>（对白保留中文）
 *     → 台词正确、无多余语音、嘴部随台词开合 ✅
 *
 * 即：官方规范那句「Write rewrite sections in English; preserve dialogue … in their
 * original language」不是风格偏好，而是让 <d> 生效的机制 —— 语言差异本身就是
 * 「描述」与「台词」的分界线。正文与台词同为中文时，边界模糊，模型会把描述当台词念。
 *
 * 本文件只做「加标记」这件确定性的事；翻译成英文由 segmentTextI18nService 负责。
 */

/**
 * 从 storyboard.dialogue 解析说话人「按首次出现顺序去重」的数组。
 * 格式形如：唐僧："悟空，为师有些饿了。" 悟空："师父，我去。"
 */
function parseDialogueSpeakers(dialogueText) {
  const src = String(dialogueText || '');
  const out = [];
  const re = /([^\s：:"\u201c]{1,8})\s*[：:]\s*[\u201c"]/g;
  let m;
  while ((m = re.exec(src))) {
    const name = String(m[1] || '').trim();
    if (name && !out.includes(name)) out.push(name);
  }
  return out;
}

/**
 * 把正文里的台词包进 <d>[Chinese] …</d>，并给说话人加 (Sx) 编号。
 *
 * 规范 §4.4：说话人的身份描述、编号、动作、表达方式放在 <d> **外面**；
 * <d> 里面只放语言标签和真正说出口的内容。
 *
 * 输入形如：…@图片2 的嗓音温和清朗："悟空，为师有些饿了，你且去化些斋饭来。"话音落定…
 * 输出形如：…@图片2 的嗓音温和清朗 (S1)：<d>[Chinese] 悟空，为师有些饿了，你且去化些斋饭来。</d>话音落定…
 *
 * 幂等：文本里已经有 <d> 时原样返回（英译结果会自带 <d>，不能再包一层）。
 *
 * @param {string} text 正文
 * @param {string[]} speakers 说话人按首次出现顺序去重（parseDialogueSpeakers 的结果）
 */
function markDialogue(text, speakers) {
  const src = String(text || '');
  if (!src) return src;
  if (src.indexOf('<d>') >= 0) return src;   // 已标记过
  const order = (Array.isArray(speakers) ? speakers : [])
    .map((x) => String(x || '').trim())
    .filter(Boolean);
  if (!order.length) return src;

  const ids = new Map();
  for (const name of order) if (!ids.has(name)) ids.set(name, ids.size + 1);

  let k = 0;
  return src.replace(/[：:]\s*[\u201c"]([^\u201d"]+)[\u201d"]/g, (_whole, spoken) => {
    // 第 k 个引号与 dialogue 里第 k 行台词逐字对应（已对全部含对白分镜验证过）
    const name = order[k] || order[order.length - 1];
    const id = ids.get(name) || 1;
    k += 1;
    return ' (S' + id + ')：<d>[Chinese] ' + String(spoken).trim() + '</d>';
  });
}

module.exports = { parseDialogueSpeakers, markDialogue };
