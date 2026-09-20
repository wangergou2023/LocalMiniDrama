/**
 * 分镜「场景」下拉与解析。
 *
 * 背景：后端 `store.scenes` 只含**本集**场景（见 stores/film.js 的设计注释），
 * 但生成分镜时模型可能把分镜绑到别的剧集里同地点的场景行（老数据里就有这种绑定）。
 * 这时按 id 在本集列表里查不到 → 界面上场景显示为空、全能模式也收不到场景参考图。
 *
 * 这里补两条：
 *  1. `pickSceneById`：本集查不到时回退到全剧场景（只用于解析，不改变"默认只显示本集"的设计）；
 *  2. `buildSceneSelectOptions`：把「已绑定到本集分镜的跨集场景」补进下拉并标注属于第几集，
 *     避免已绑定的值在下拉里显示为空白。
 */

/** 解析场景：优先本集，其次全剧（跨集绑定也能显示/引用） */
export function pickSceneById(sceneId, episodeScenes, allScenes) {
  if (sceneId == null) return null
  const own = (Array.isArray(episodeScenes) ? episodeScenes : []).find(
    (s) => Number(s.id) === Number(sceneId)
  )
  if (own) return own
  return (
    (Array.isArray(allScenes) ? allScenes : []).find((s) => Number(s.id) === Number(sceneId)) || null
  )
}

/**
 * 下拉选项：本集场景（原样）+ 已被本集分镜绑定的跨集场景（标注「（第N集）」）。
 * @param {object} opts
 * @param {Array} opts.episodeScenes 本集场景
 * @param {Array} opts.allScenes 全剧场景（可缺省）
 * @param {Array<number|string>} opts.boundSceneIds 当前集分镜已绑定的场景 id
 * @param {(episodeId:number)=>number|null} [opts.episodeNumberOf] episode_id → 集号
 */
export function buildSceneSelectOptions({
  episodeScenes,
  allScenes,
  boundSceneIds,
  episodeNumberOf,
} = {}) {
  const own = Array.isArray(episodeScenes) ? episodeScenes : []
  const all = Array.isArray(allScenes) ? allScenes : []
  const ownIds = new Set(own.map((s) => Number(s.id)))
  const label = (s) => s.location || s.name || `场景 ${s.id}`

  const options = own.map((s) => ({
    id: s.id,
    location: s.location,
    label: label(s),
    crossEpisode: false,
    scene: s,
  }))

  for (const rawId of Array.isArray(boundSceneIds) ? boundSceneIds : []) {
    if (rawId == null) continue
    const id = Number(rawId)
    if (ownIds.has(id)) continue
    if (options.some((o) => Number(o.id) === id)) continue
    const scene = all.find((s) => Number(s.id) === id)
    if (!scene) continue
    const ep = typeof episodeNumberOf === 'function' ? episodeNumberOf(scene.episode_id) : null
    options.push({
      id: scene.id,
      location: scene.location,
      label: `${label(scene)}${ep ? `（第${ep}集）` : '（其它集）'}`,
      crossEpisode: true,
      scene,
    })
  }

  return options
}
