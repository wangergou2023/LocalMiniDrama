/**
 * 解析后端任务结果（async_tasks.result）。
 *
 * 后端 `taskService.rowToTask` 把 TEXT 列原样返回，所以前端从 `/tasks/:id` 拿到的
 * `result` 是 **JSON 字符串**，不是对象。直接写 `result.quality_report` /
 * `result.truncated` 会永远得到 `undefined` —— 而且**不报任何错**，属最难受的一类 bug。
 *
 * 实测踩过两次：
 *   1. 「分镜可能被截断」告警（原有代码）一直是死代码
 *   2. 新加的「台词覆盖率 / 生成质量报告」提示同样不生效
 * 两个都不弹、不报错，看起来像「没触发」。
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

export default { parseTaskResult }
