import { defineStore } from 'pinia'
import { reactive } from 'vue'

/**
 * AI 导演助手的「@引用」通道（类似添加附件）。
 * 任意页面（如分镜图片旁的 +@ 按钮）通过 addRef() 把一个分镜挂到 AI 导演的引用列表，
 * 用户可连续添加多个，最后连同文字一起发送给后端 agent。
 * AiDirectorBar 监听 refs，渲染成芯片（带缩略图/标题/关闭），发送时作为 refs 一起 POST。
 */
export const useAidirStore = defineStore('aidir', () => {
  const refs = reactive([]) // { key, type:'storyboard', id, title, num, img, prompt?, extra? }
  let _seq = 0

  function _key() { return Date.now().toString(36) + '-' + (++_seq) }

  /** 添加一个引用；若同 id 已存在则不重复添加 */
  function addRef(item) {
    if (!item || item.id == null) return null
    const dup = refs.find(r => r.type === item.type && r.id === item.id)
    if (dup) return dup
    const ref = { key: _key(), ...item }
    refs.push(ref)
    return ref
  }

  function removeRef(key) {
    const i = refs.findIndex(r => r.key === key)
    if (i >= 0) refs.splice(i, 1)
  }

  function clearRefs() { refs.splice(0, refs.length) }

  return { refs, addRef, removeRef, clearRefs }
})
