<template>
  <div
    class="ref-stitch-thumb"
    :class="{ 'ref-stitch-thumb--clickable': hasImage }"
    :title="title"
    role="button"
    @click="onClick"
  >
    <img v-if="displaySrc" :src="displaySrc" class="ref-stitch-thumb-img" alt="" />
    <span v-else class="ref-stitch-thumb-ph">{{ placeholder }}</span>
    <span v-if="multiCount > 1" class="ref-stitch-thumb-badge">{{ multiCount }}</span>
  </div>
</template>

<script setup>
import { ref, computed, watch, onBeforeUnmount } from 'vue'
import { stitchImageUrls } from '@/utils/imageStitch'

const props = defineProps({
  /** 图片绝对 URL 列表；0 张显示占位，1 张显示原图，多张横向拼接为一张 */
  urls: { type: Array, default: () => [] },
  /** 无图时显示的占位字符（通常取首个名字字符） */
  placeholder: { type: String, default: '?' },
  title: { type: String, default: '' },
})

const emit = defineEmits(['preview'])

const displaySrc = ref('')
const multiCount = ref(0)
let seq = 0

const validUrls = computed(() => props.urls.filter(Boolean))
const hasImage = computed(() => displaySrc.value !== '')

async function compute() {
  const token = ++seq
  const urls = validUrls.value
  if (!urls.length) {
    displaySrc.value = ''
    multiCount.value = 0
    return
  }
  if (urls.length === 1) {
    displaySrc.value = urls[0]
    multiCount.value = 1
    return
  }
  multiCount.value = urls.length
  const stitched = await stitchImageUrls(urls)
  if (token !== seq) return
  displaySrc.value = stitched || urls[0]
}

watch(
  () => validUrls.value.join('|'),
  () => { compute() },
  { immediate: true }
)

/** 点击预览：优先展示拼接图，画廊含拼接图 + 原图（去重），可在预览内翻阅 */
function onClick() {
  if (!hasImage.value) return
  const gallery = []
  if (displaySrc.value) gallery.push(displaySrc.value)
  for (const u of validUrls.value) if (!gallery.includes(u)) gallery.push(u)
  emit('preview', displaySrc.value, gallery)
}

onBeforeUnmount(() => { seq += 1 })
</script>

<style scoped>
.ref-stitch-thumb {
  display: inline-flex;
  align-items: center;
  height: 38px;
  max-width: 220px;
  border-radius: 6px;
  overflow: hidden;
  background: #22232d;
  border: 1px solid rgba(255, 255, 255, 0.08);
  position: relative;
  flex-shrink: 0;
}
.ref-stitch-thumb--clickable {
  cursor: pointer;
}
.ref-stitch-thumb-img {
  display: block;
  height: 38px;
  width: auto;
  max-width: 220px;
  object-fit: cover;
}
.ref-stitch-thumb-ph {
  display: flex;
  align-items: center;
  justify-content: center;
  height: 38px;
  min-width: 38px;
  padding: 0 8px;
  font-size: 14px;
  font-weight: 600;
  color: #71717a;
  background: #22232d;
}
.ref-stitch-thumb-badge {
  position: absolute;
  top: 2px;
  right: 2px;
  padding: 0 4px;
  border-radius: 8px;
  background: rgba(0, 0, 0, 0.62);
  color: #e4e4e7;
  font-size: 10px;
  line-height: 14px;
  pointer-events: none;
}
html.light .ref-stitch-thumb {
  background: #f4f4f5;
  border-color: #e4e4e7;
}
html.light .ref-stitch-thumb-ph {
  color: #a1a1aa;
  background: #f4f4f5;
}
</style>
