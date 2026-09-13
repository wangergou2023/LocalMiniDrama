/**
 * 分镜正文的历史措辞修正（渲染阶段与英译前置步骤共用）。
 *
 * 必须在**英译之前**执行：早先这些修正只写在渲染阶段、且只匹配中文，
 * 结果英译会把「室内」忠实翻成 "interior space"，中文模式匹配不到，修正就失效了。
 */

/** [正则, 替换] —— 只处理明确的历史遗留措辞，不做通用改写 */
const LEGACY_TEXT_FIXES = [
  // 上游从室内样板沿用的模板（见 universalOmniMultiBeatFormat.js 顶部注释），对所有场景一刀切：
  // 户外山道也会被要求提取「室内」的光线语义，与剧本直接冲突。
  [/统一的?室内空间与光线语义/g, '统一的空间、光线与氛围语义'],
];

/**
 * 修掉正文里的历史遗留措辞。幂等，可安全重复调用。
 * @param {string} s
 * @returns {string}
 */
function fixLegacySegmentText(s) {
  let out = String(s || '');
  for (const [re, to] of LEGACY_TEXT_FIXES) out = out.replace(re, to);
  return out;
}

module.exports = { fixLegacySegmentText, LEGACY_TEXT_FIXES };
