/**
 * 解析后端任务结果（async_tasks.result）。
 *
 * 后端 `taskService.rowToTask` 把 TEXT 列原样返回，所以前端从 `/tasks/:id` 拿到的
 * `result` 是 **JSON 字符串**，不是对象。直接写 `result.truncated` 会永远得到
 * `undefined` —— 而且**不报任何错**，属最难受的一类 bug。
 *
 * 实测踩过：「分镜可能被截断」告警（原有代码）一直是死代码 —— 不弹、不报错，
 * 看起来像「没触发」。
 *
 * 约定：能解析就返回对象；解析不了就返回原值（不改变既有调用方的行为，避免引入新回归）。
 *
 * @param {unknown} result
 * @returns {object|string|null|undefined}
 */
export function parseTaskResult(result) {
  if (result == null) return result
  if (typeof result === 'object') return result
  if (typeof result !== 'string') return result
  const s = result.trim()
  if (!s || (s[0] !== '{' && s[0] !== '[')) return result
  try {
    const parsed = JSON.parse(s)
    return parsed && typeof parsed === 'object' ? parsed : result
  } catch (_) {
    return result
  }
}

/**
 * 从 /static/... 形式的图片地址反推 local_path。
 * 素材库里存 local_path 很关键 —— 素材库导出/导入靠它把图片打进包里。
 */
export function localPathFromImageUrl(url) {
  const m = String(url || '').match(/\/static\/(.+)$/)
  return m ? m[1] : null
}

/**
 * 读取「生成图片」类任务的结果，统一返回 { url, local_path }。
 *
 * 后端 task.result 是 **JSON 字符串**（见本文件顶部说明），各调用点各写各的
 * `task.result?.image_url` 会永远取到 undefined，表现为「未获取到图片地址」。
 * 实测踩过：图片调试台与素材库「AI 生成」都因此失败，而后端其实已经出图成功。
 *
 * @param {{result?: unknown}} task
 * @returns {{ url: string, local_path: string|null }}
 */
export function readImageTaskResult(task) {
  const r = parseTaskResult(task && task.result)
  if (!r || typeof r !== 'object') return { url: '', local_path: null }
  const imageUrl = r.image_url || r.url || ''
  const localPath = r.local_path || localPathFromImageUrl(imageUrl)
  const url = imageUrl || (localPath ? '/static/' + String(localPath).replace(/^\//, '') : '')
  return { url, local_path: localPath || null }
}

export default { parseTaskResult, localPathFromImageUrl, readImageTaskResult }
