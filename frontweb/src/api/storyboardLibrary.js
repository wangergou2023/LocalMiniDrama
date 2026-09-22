import request from '@/utils/request'

export const storyboardLibraryAPI = {
  list(params) {
    return request.get('/storyboard-library', { params })
  },
  get(id) {
    return request.get(`/storyboard-library/${id}`)
  },
  create(data) {
    return request.post('/storyboard-library', data)
  },
  update(id, data) {
    return request.put(`/storyboard-library/${id}`, data)
  },
  delete(id) {
    return request.delete(`/storyboard-library/${id}`)
  }
}
