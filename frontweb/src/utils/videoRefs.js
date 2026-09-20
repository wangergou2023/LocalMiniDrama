/**
 * 经典 / 首尾帧镜头提交视频时的参考图组装。
 *
 * 为什么不依赖「全能分镜模式」：
 *  - 首尾帧的「图」那一步本来就带场景参考（后端 imageService 按 storyboard_id 自动注入
 *    `scene background reference for "河边"`），所以帧图里已经有真实环境；
 *  - 但视频这一步以前经典镜头只传自己那一张主图 → 镜头中段运镜露出帧外区域、
 *    或同一地点不同镜之间，环境仍会漂移；
 *  - 所以经典镜头也补一张场景图作为参考：场景在前、本镜主图在后，
 *    标签供后端 `applyH3RefsToApi` 逐张生成 `<Picture N>` 映射行。
 */
export function buildClassicVideoRefs({ sceneImageUrl, sceneName, ownFrameUrl } = {}) {
  const urls = []
  const labels = []
  const scene = (sceneImageUrl || '').trim()
  const own = (ownFrameUrl || '').trim()

  if (scene) {
    urls.push(scene)
    labels.push(`scene background for "${sceneName || '场景'}"`)
  }
  // 本镜主图（首帧/主图）排在其后；与场景图相同时不重复
  if (own && !urls.includes(own)) {
    urls.push(own)
    labels.push('keyframe still for this shot (composition and lighting reference)')
  }

  return { urls, labels }
}
