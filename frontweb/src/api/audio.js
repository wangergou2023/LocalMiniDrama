import request from '@/utils/request'

export const audioAPI = {
  /**
   * 合成一段语音（对白 / 解说旁白）。
   * @param {object} body { text?, storyboard_id?, tts_kind?: 'dialogue'|'narration', config_id? }
   *   - 只传 text 时用于「试听」：不落库到任何分镜。
   *   - config_id 指定要使用的 AI 配置行（旁白参考音色试听用），不传则用默认 TTS 配置。
   */
  extract(body) {
    return request.post('/audio/extract', body)
  },
}
