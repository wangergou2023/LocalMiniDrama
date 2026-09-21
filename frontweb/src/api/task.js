import request from '@/utils/request'

export const taskAPI = {
  get(taskId) {
    return request.get(`/tasks/${taskId}`)
  },
  cancel(taskId, body) {
    return request.post(`/tasks/${taskId}/cancel`, body || {})
  },
  listByResource(resourceId) {
    return request.get('/tasks', { params: { resource_id: String(resourceId) } })
  },
  /**
   * 批量取多个资源的任务 —— 一次请求代替 N 次。
   * 任务同步原本给每个角色/道具/场景各查一次，实测 30 次/轮、单秒峰值 61 次；这里合并成 1 次。
   */
  listByResources(resourceIds) {
    const ids = [...new Set((resourceIds || []).map((x) => String(x)).filter(Boolean))]
    if (!ids.length) return Promise.resolve([])
    return request.get('/tasks', { params: { resource_ids: ids.join(',') } })
  },
}
