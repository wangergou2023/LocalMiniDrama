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
  }
}
