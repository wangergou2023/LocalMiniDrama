import request from '@/utils/request'

/**
 * 素材库的导入 / 导出（角色 / 场景 / 道具 / 分镜 四类共用）。
 *
 * 导出走浏览器直接下载（GET 返回 zip），导入走 multipart 上传同一个 zip。
 * 用途：把素材库导出成文件发给同事，同事在自己的软件里导入即可，
 * 重复导入同一份文件会按「身份 + 图片 sha256」判重跳过，不会把库翻倍。
 */
export const libraryTransferAPI = {
  /**
   * 导出下载地址（直接给 <a href> 或 window.open 用）。
   * @param {'character'|'scene'|'prop'|'storyboard'} kind
   */
  exportUrl(kind) {
    return `/api/v1/library/${kind}/export`
  },

  /**
   * 导出成 Blob（需要自己处理保存时可选用；常规直接用 exportUrl）。
   * @param {'character'|'scene'|'prop'|'storyboard'} kind
   */
  exportBlob(kind) {
    return request.get(`/library/${kind}/export`, { responseType: 'blob' })
  },

  /**
   * 导入素材包（.zip）。
   * @param {'character'|'scene'|'prop'|'storyboard'} kind
   * @param {File} file
   * @returns {Promise<{added:number,skipped:number,failed:number,total:number}>}
   */
  importZip(kind, file) {
    const form = new FormData()
    form.append('file', file)
    return request.post(`/library/${kind}/import`, form, {
      headers: { 'Content-Type': 'multipart/form-data' },
      timeout: 600000,
    })
  },
}

export default libraryTransferAPI
