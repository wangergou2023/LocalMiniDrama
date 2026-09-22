/**
 * 提示词覆盖的共享状态。
 *
 * 「高级设置（短剧提示词）」和「高级设置（宣传片提示词）」两个页签，是同一个 PromptEditor 的两个实例。
 * 如果每个实例各持一份状态，会出现这种情况：在短剧页签改了没保存 → 切到宣传片页签看到的是旧值 →
 * 一保存就把前一次的改动覆盖掉了。所以列表、编辑内容、脏标记都放模块作用域共享，接口也只拉一次。
 *
 * 各自「当前选中哪一条」（currentKey）仍由组件自己持有 —— 两个页签显示的清单本来就不同。
 */
import { ref } from 'vue'
import { promptsAPI } from '@/api/prompts'

const loading = ref(false)
const prompts = ref([])
const editState = ref({})
const isDirty = ref({})
let loadPromise = null

export function usePromptOverrides() {
  /** 拉取提示词清单，多次调用只真正请求一次 */
  async function loadOnce() {
    if (loadPromise) return loadPromise
    loadPromise = (async () => {
      loading.value = true
      try {
        const data = await promptsAPI.list()
        prompts.value = data.prompts || []
        for (const p of prompts.value) {
          editState.value[p.key] = p.current_body || p.default_body
        }
      } catch (err) {
        loadPromise = null // 失败后允许重试
        throw err
      } finally {
        loading.value = false
      }
    })()
    return loadPromise
  }

  return { loading, prompts, editState, isDirty, loadOnce }
}
