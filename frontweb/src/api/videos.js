import request from '@/utils/request'

export const videosAPI = {
  list(params) {
    return request.get('/videos', { params: params || {} })
  },
  delete(id) {
    return request.delete('/videos/' + id)
  },
  create(body) {
    return request.post('/videos', body)
  },
  /** 失败后复用已存上游 task 继续轮询，返回 video_generations 记录（含 task_id） */
  resumePoll(id) {
    return request.post(`/videos/${id}/resume-poll`)
  },
  /** 手动上传分镜视频并绑定到分镜（应用重启/生成中断时使用） */
  uploadVideo(file, opts = {}) {
    const form = new FormData()
    form.append('file', file)
    const did = opts.dramaId
    if (did != null && did !== '' && Number(did) > 0) {
      form.append('drama_id', String(did))
    }
    if (opts.storyboardId != null && opts.storyboardId !== '') {
      form.append('storyboard_id', String(opts.storyboardId))
    }
    return request.post('/videos/upload', form, {
      headers: { 'Content-Type': 'multipart/form-data' }
    })
  },
}
