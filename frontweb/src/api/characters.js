import request from '@/utils/request'

export const characterAPI = {
  get(characterId) {
    return request.get(`/characters/${characterId}`)
  },
  generateImage(characterId, model, style) {
    return request.post(`/characters/${characterId}/generate-image`, { model, style })
  },
  generatePrompt(characterId, model, style) {
    return request.post(`/characters/${characterId}/generate-prompt`, { model, style })
  },
  batchGenerateImages(characterIds, model, style) {
    return request.post('/characters/batch-generate-images', {
      character_ids: characterIds.map(String),
      model,
      style
    })
  },
  update(characterId, data) {
    return request.put(`/characters/${characterId}`, data)
  },
  putImage(characterId, data) {
    return request.put(`/characters/${characterId}/image`, data)
  },
  putRefImage(characterId, refImagePath) {
    return request.put(`/characters/${characterId}/image`, { ref_image: refImagePath })
  },
  delete(characterId) {
    return request.delete(`/characters/${characterId}`)
  },
  addToLibrary(characterId, body) {
    return request.post(`/characters/${characterId}/add-to-library`, body || {})
  },
  addToMaterialLibrary(characterId) {
    return request.post(`/characters/${characterId}/add-to-material-library`, {})
  },
  /** 从素材库导入：手动挑一项，把它的图片（可选描述）应用到本角色，不靠名字匹配 */
  imageFromLibrary(characterId, libraryId, withFields = false) {
    return request.put(`/characters/${characterId}/image-from-library`, {
      library_id: libraryId,
      with_fields: !!withFields,
    })
  },
  addToTeamLibrary(characterId, body = {}) {
    return request.post(`/characters/${characterId}/add-to-team-library`, body)
  },
  extractFromImage(characterId) {
    return request.post(`/characters/${characterId}/extract-from-image`, {})
  },
  extractAnchors(characterId) {
    return request.post(`/characters/${characterId}/extract-anchors`, {})
  },
  // 软件内置音色库（参考音色）
  voiceBankList() {
    return request.get('/voice-bank')
  },
  voiceBankApply(characterId, voiceKey) {
    return request.post(`/characters/${characterId}/voice-bank-apply`, { voice_key: voiceKey })
  }
}
