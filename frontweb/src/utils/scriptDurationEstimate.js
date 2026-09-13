/**
 * 剧本字数 → 成片总时长估算（**唯一实现**，别在别处再抄一份）。
 *
 * ── 为什么改 ────────────────────────────────────────────────────────────────
 * 原公式是 `round(10 + (字数/600)×60)`，等价于 **10 字/秒**。中文口播实际约
 * **4.2 字/秒**（标准播音 240–260 字/分），所以原公式把总时长估快了 2 倍多，
 * 进而把分镜数估少一半 —— 这是「剧本台词被大量丢弃」的直接原因。
 *
 * 实测对照（两集，同一套提示词与模型）：
 *
 *   集             剧本   原公式估      实际产出        台词覆盖
 *   三打白骨精     946字  105s/13镜   109s / 13 镜    21 句保住 13（丢 10）
 *   真假美猴王     716字   82s/11镜    95s / 11 镜    10 句保住  9（丢  1）
 *
 * 两集的丢失都符合一条容量规律：**分镜能承载的台词数 ≈ 1 句/镜**。镜数不足时模型
 * 合并叙事节拍，而合并时优先保画面动作、牺牲台词；丢掉的那几句在 dialogue、
 * universal_segment_text、video_prompt 里全都没有，等于整个剧情点消失。
 *
 * 按 4.2 字/秒：946 字 → 225s（≈28 镜）、716 字 → 170s（≈21 镜），与「丢失量」吻合。
 *
 * ── 注意 ────────────────────────────────────────────────────────────────────
 * 这是**粗估**，只用于「用户没手填时」给出合理默认值。UI 上的分镜数/总时长输入框
 * 优先级更高（见 FilmCreate.vue 的 userFilledStoryboardCount / userFilledVideoDuration）。
 * 单镜时长由 AI 在 [5.2, 项目「每段秒数」] 内按内容浮动，不是每镜都写满上限。
 *
 * @param {number|string} charLen 剧本字符数（含标点，浏览器里一个汉字算一个字符）
 * @returns {number|null} 估算总秒数；字数不足时返回 null
 */

/** 中文成片语速（字/秒）。低于口播速度是**有意**的：叙述部分要靠画面演，比读出来更费时间。 */
export const SCRIPT_CHARS_PER_SECOND = 4.2

/** 规划镜数用的平均单镜秒数（与后端 episodeStoryboardService.STORYBOARD_PLAN_SECONDS 保持一致） */
export const STORYBOARD_PLAN_SECONDS = 8

/** 单镜时长下限（秒）—— 本地 MiniMax H3 官方验证的下限 124 帧 ÷ 24fps = 5.17s */
export const STORYBOARD_MIN_SECONDS = 5.2

export function estimateVideoDurationSecFromCharLen(charLen) {
  const len = Math.max(0, Math.floor(Number(charLen) || 0))
  if (len < 1) return null
  const raw = Math.round(len / SCRIPT_CHARS_PER_SECOND)
  return Math.min(600, Math.max(10, raw))
}

export default { estimateVideoDurationSecFromCharLen, SCRIPT_CHARS_PER_SECOND, STORYBOARD_PLAN_SECONDS, STORYBOARD_MIN_SECONDS }
