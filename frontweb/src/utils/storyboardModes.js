/**
 * 「全能分镜模式」与「首尾帧参考图」互斥规则。
 *
 * 为什么互斥：
 *  - 全能分镜模式会让**每一镜**都是全能镜头（creation_mode=universal），
 *    而首尾帧双槽只对**经典镜头**生效（前端各处都是 `useFirstLast && !isUniversal`）；
 *  - 所以两者同时开启时，首尾帧开关虽然勾着，实际是空转（历史项目里出现过这种状态）。
 *
 * 这里只放纯逻辑，便于单测；FilmCreate.vue 负责把结果写回 ref 并提示用户。
 */

export const SB_MODE_UNIVERSAL = 'universal'
export const SB_MODE_FIRST_LAST = 'first_last_frame'

/**
 * 规范化两个开关的组合。
 * @param {object} opts
 * @param {boolean} opts.universalOmni 当前/目标：全能分镜模式
 * @param {boolean} opts.useFirstLastFrame 当前/目标：首尾帧参考图
 * @param {'universal'|'first_last_frame'|null} [opts.preferred] 冲突时优先保留谁（= 用户本次勾选的那个）
 * @returns {{ universalOmni: boolean, useFirstLastFrame: boolean, dropped: string|null }}
 */
export function resolveStoryboardModes({ universalOmni, useFirstLastFrame, preferred } = {}) {
  const wantUniversal = !!universalOmni
  const wantFirstLast = !!useFirstLastFrame
  if (!(wantUniversal && wantFirstLast)) {
    return { universalOmni: wantUniversal, useFirstLastFrame: wantFirstLast, dropped: null }
  }
  // 同时为真：只有被勾选（或载入时优先保留）的一方留下
  if (preferred === SB_MODE_FIRST_LAST) {
    return { universalOmni: false, useFirstLastFrame: true, dropped: SB_MODE_UNIVERSAL }
  }
  return { universalOmni: true, useFirstLastFrame: false, dropped: SB_MODE_FIRST_LAST }
}

/** 被关掉的一方对应的用户提示（没有冲突时返回空串） */
export function storyboardModeDropMessage(dropped) {
  if (dropped === SB_MODE_FIRST_LAST) {
    return '已关闭「首尾帧参考图」：全能分镜模式下每镜都是全能镜头，首尾帧双槽不生效'
  }
  if (dropped === SB_MODE_UNIVERSAL) {
    return '已关闭「全能分镜模式」：首尾帧双槽只对经典镜头生效'
  }
  return ''
}
