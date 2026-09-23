<template>
  <div class="studio-page">
    <header class="studio-header">
      <el-button text @click="$router.push('/')">
        <el-icon><ArrowLeft /></el-icon>返回项目列表
      </el-button>
      <h1 class="studio-title">图片调试台</h1>
      <span class="studio-sub">
        单独调试一张图：上传或从素材库取一张图 → 反复改提示词反复生成 → 满意后直接存回素材库。
        用的是「AI 配置」里的图片服务（带图即走图生图 / 参考图编辑）。
      </span>
    </header>

    <div class="studio-body">
      <!-- ───── 左：输入 ───── -->
      <section class="studio-panel studio-panel--input">
        <div class="panel-title">输入图<span class="panel-title-tip">可选；带上它就是对这张图做编辑</span></div>

        <div
          class="drop-zone"
          :class="{ 'drop-zone--has': !!inputImage, 'drop-zone--over': dragOver }"
          @click="fileRef?.click()"
          @dragover.prevent="dragOver = true"
          @dragleave.prevent="dragOver = false"
          @drop.prevent="onDrop"
        >
          <img v-if="inputImage" :src="inputImage.url" alt="" />
          <div v-else class="drop-hint">
            <el-icon :size="26"><Upload /></el-icon>
            <div>点击选择，或把图片拖到这里</div>
          </div>
          <div v-if="uploading" class="drop-mask">上传中…</div>
        </div>

        <div class="row-actions">
          <el-button size="small" :loading="uploading" @click="fileRef?.click()">上传图片</el-button>
          <el-button size="small" @click="openLibPicker">从素材库导入</el-button>
          <el-button v-if="inputImage" size="small" text type="danger" @click="inputImage = null">移除</el-button>
        </div>
        <input ref="fileRef" type="file" accept="image/*" style="display:none" @change="onPickFile" />

        <div class="panel-title">
          提示词
          <span class="panel-title-tip">想调什么就写什么；改完再点生成即可对比</span>
        </div>
        <el-input
          v-model="prompt"
          type="textarea"
          :rows="9"
          resize="vertical"
          placeholder="例：把这枚芯片的丝印去掉，其余保持不变，冷蓝影棚侧光，写实 8K"
        />

        <div class="panel-title panel-title--sm">负面提示词<span class="panel-title-tip">可留空</span></div>
        <el-input v-model="negativePrompt" type="textarea" :rows="2" resize="vertical" placeholder="例：文字、水印、多余器件" />

        <div class="param-row">
          <span class="param-label">尺寸</span>
          <el-select v-model="size" size="small" style="width: 130px">
            <el-option label="16:9（横屏）" value="16:9" />
            <el-option label="9:16（竖屏）" value="9:16" />
            <el-option label="1:1（方图）" value="1:1" />
          </el-select>
        </div>

        <el-button
          class="generate-btn"
          type="primary"
          size="large"
          :loading="generating"
          :disabled="!prompt.trim()"
          @click="onGenerate"
        >
          <el-icon v-if="!generating"><MagicStick /></el-icon>
          {{ generating ? '生成中…' : '生成' }}
        </el-button>
      </section>

      <!-- ───── 右：结果 + 历史 ───── -->
      <section class="studio-panel studio-panel--result">
        <div class="panel-title">当前结果</div>
        <div v-if="current" class="result-box">
          <img :src="current.url" alt="" @click="previewUrl = current.url" />
          <div class="result-actions">
            <el-button size="small" type="primary" @click="openSaveDialog(current)">导入到素材库</el-button>
            <el-button size="small" @click="useAsInput(current)">用作输入图</el-button>
            <el-button size="small" @click="downloadImage(current)">下载</el-button>
          </div>
          <div class="result-prompt">{{ current.prompt }}</div>
        </div>
        <div v-else class="empty-tip">还没有结果，左侧写好提示词点「生成」</div>

        <div class="panel-title panel-title--mt">
          历史
          <span class="panel-title-tip">每张都可「用作输入图」继续迭代；也可以随时存进素材库</span>
          <el-button v-if="history.length" size="small" text type="danger" @click="history = []">清空</el-button>
        </div>
        <div v-if="history.length" class="history-grid">
          <div v-for="(h, i) in history" :key="i" class="history-item" :class="{ 'history-item--cur': current && h.url === current.url }">
            <img :src="h.url" alt="" @click="current = h" />
            <div class="history-tools">
              <el-button size="small" text @click="useAsInput(h)">用作输入</el-button>
              <el-button size="small" text @click="openSaveDialog(h)">存素材库</el-button>
              <el-button size="small" text @click="prompt = h.prompt">复用提示词</el-button>
            </div>
            <div class="history-prompt" :title="h.prompt">{{ h.prompt }}</div>
          </div>
        </div>
        <div v-else class="empty-tip">暂无历史</div>
      </section>
    </div>

    <!-- 从素材库导入 -->
    <el-dialog v-model="showLibPicker" title="从素材库导入" width="760px" destroy-on-close @open="loadLibList">
      <el-tabs v-model="libTab" @tab-change="loadLibList">
        <el-tab-pane label="素材角色" name="character" />
        <el-tab-pane label="素材场景" name="scene" />
        <el-tab-pane label="素材道具" name="prop" />
        <el-tab-pane label="素材分镜" name="storyboard" />
      </el-tabs>
      <div v-loading="libLoading" class="lib-grid">
        <div
          v-for="it in libList"
          :key="it.id"
          class="lib-item"
          :title="libItemName(it)"
          @click="pickLibItem(it)"
        >
          <img v-if="assetImageUrl(it)" :src="assetImageUrl(it)" alt="" />
          <div v-else class="lib-item-ph">暂无图</div>
          <div class="lib-item-name">{{ libItemName(it) }}</div>
        </div>
        <div v-if="!libLoading && !libList.length" class="empty-tip">这个素材库还没有内容</div>
      </div>
    </el-dialog>

    <!-- 导入到素材库 -->
    <el-dialog v-model="showSaveDialog" title="导入到素材库" width="540px">
      <el-form label-width="90px">
        <el-form-item label="存到">
          <el-select v-model="saveTarget" style="width: 100%">
            <el-option label="素材角色" value="character" />
            <el-option label="素材场景" value="scene" />
            <el-option label="素材道具" value="prop" />
            <el-option label="素材分镜" value="storyboard" />
          </el-select>
        </el-form-item>
        <el-form-item :label="saveTarget === 'scene' ? '地点' : '名称'">
          <el-input v-model="saveName" placeholder="取个好认的名字" />
        </el-form-item>
        <el-form-item v-if="saveTarget === 'scene'" label="时间">
          <el-input v-model="saveTime" placeholder="如：白天 / 夜晚（可留空）" />
        </el-form-item>
        <el-form-item label="描述">
          <el-input v-model="saveDesc" type="textarea" :rows="3" placeholder="可留空" />
        </el-form-item>
        <el-form-item label="提示词">
          <el-input v-model="savePrompt" type="textarea" :rows="3" placeholder="默认沿用这次生成用的提示词" />
        </el-form-item>
      </el-form>
      <template #footer>
        <el-button @click="showSaveDialog = false">取消</el-button>
        <el-button type="primary" :loading="saving" @click="doSaveToLibrary">保存</el-button>
      </template>
    </el-dialog>

    <el-dialog v-model="showPreview" width="80%" title="预览" append-to-body>
      <img v-if="previewUrl" :src="previewUrl" style="width: 100%" alt="" />
    </el-dialog>
  </div>
</template>

<script setup>
import { ref, computed } from 'vue'
import { useRouter } from 'vue-router'
import { ElMessage } from 'element-plus'
import { ArrowLeft, Upload, MagicStick } from '@element-plus/icons-vue'
import { imagesAPI } from '@/api/images'
import { taskAPI } from '@/api/task'
import { uploadAPI } from '@/api/upload'
import { characterLibraryAPI } from '@/api/characterLibrary'
import { sceneLibraryAPI } from '@/api/sceneLibrary'
import { propLibraryAPI } from '@/api/propLibrary'
import { storyboardLibraryAPI } from '@/api/storyboardLibrary'
import { assetImageUrl } from '@/utils/mediaUrl'

const router = useRouter()

// ── 输入 ──
const fileRef = ref(null)
const inputImage = ref(null) // { url, local_path, name }
const uploading = ref(false)
const dragOver = ref(false)
const prompt = ref('')
const negativePrompt = ref('')
const size = ref('16:9')
const previewUrl = ref('')
const showPreview = computed({
  get: () => !!previewUrl.value,
  set: (v) => { if (!v) previewUrl.value = '' },
})

// ── 生成与历史 ──
const generating = ref(false)
const current = ref(null)  // { url, local_path, prompt }
const history = ref([])

// ── 素材库选择 ──
const showLibPicker = ref(false)
const libTab = ref('character')
const libLoading = ref(false)
const libList = ref([])
const LIB_API = {
  character: characterLibraryAPI,
  scene: sceneLibraryAPI,
  prop: propLibraryAPI,
  storyboard: storyboardLibraryAPI,
}

// ── 存进素材库 ──
const showSaveDialog = ref(false)
const saving = ref(false)
const saveTarget = ref('character')
const saveName = ref('')
const saveTime = ref('')
const saveDesc = ref('')
const savePrompt = ref('')
const savingItem = ref(null)

function libItemName(it) {
  return it.name || it.location || it.title || `#${it.id}`
}

async function onPickFile(e) {
  const file = e?.target?.files?.[0]
  if (!file) return
  await uploadOne(file)
  if (e?.target) e.target.value = ''
}

async function onDrop(e) {
  dragOver.value = false
  const file = e?.dataTransfer?.files?.[0]
  if (file) await uploadOne(file)
}

async function uploadOne(file) {
  uploading.value = true
  try {
    const res = await uploadAPI.uploadImage(file, {})
    const d = res?.data ?? res
    const url = d?.url || (d?.local_path ? '/static/' + String(d.local_path).replace(/^\//, '') : '')
    if (!url) throw new Error('上传未返回图片地址')
    inputImage.value = { url, local_path: d?.local_path || null, name: file.name }
    ElMessage.success('图片已就绪，可以开始调试提示词')
  } catch (e) {
    ElMessage.error(e?.message || '上传失败')
  } finally {
    uploading.value = false
  }
}

function useAsInput(item) {
  inputImage.value = { url: item.url, local_path: item.local_path || null, name: '历史结果' }
  ElMessage.success('已设为输入图，改完提示词再点生成即可继续迭代')
}

function downloadImage(item) {
  const a = document.createElement('a')
  a.href = item.url
  a.download = `image_studio_${Date.now()}.png`
  a.style.display = 'none'
  document.body.appendChild(a)
  a.click()
  setTimeout(() => document.body.removeChild(a), 0)
}

async function onGenerate() {
  if (!prompt.value.trim()) { ElMessage.warning('请先写提示词'); return }
  generating.value = true
  try {
    const payload = {
      drama_id: null,
      prompt: prompt.value.trim(),
      negative_prompt: negativePrompt.value.trim() || undefined,
      size: size.value,
      // 带输入图时后端会自动走图生图 / 参考图编辑（openai_image 通道切 /images/edits）
      reference_images: inputImage.value?.url ? [inputImage.value.url] : undefined,
    }
    const res = await imagesAPI.create(payload)
    const d = res?.data ?? res
    const taskId = d?.task_id
    if (!taskId) throw new Error('未返回任务ID')

    let task = null
    for (let i = 0; i < 400; i++) {
      await new Promise((r) => setTimeout(r, 1500))
      const tr = await taskAPI.get(taskId)
      task = tr?.data ?? tr
      if (task?.status === 'completed') break
      if (task?.status === 'failed') throw new Error(task.error || '生成失败')
    }
    if (!task || task.status !== 'completed') throw new Error('生成超时')
    const result = task.result || {}
    const url = result.image_url || (result.local_path ? '/static/' + String(result.local_path).replace(/^\//, '') : '')
    if (!url) throw new Error('未获取到图片地址')

    const item = { url, local_path: result.local_path || null, prompt: prompt.value.trim() }
    current.value = item
    history.value = [item, ...history.value].slice(0, 60)
    ElMessage.success('生成完成')
  } catch (e) {
    ElMessage.error(e?.message || '生成失败')
  } finally {
    generating.value = false
  }
}

function openLibPicker() {
  showLibPicker.value = true
}

async function loadLibList() {
  libLoading.value = true
  try {
    const api = LIB_API[libTab.value]
    const res = await api.list({ page: 1, page_size: 60 })
    const d = res?.data ?? res
    libList.value = d?.items || d?.list || (Array.isArray(d) ? d : [])
  } catch (e) {
    ElMessage.error(e?.message || '读取素材库失败')
    libList.value = []
  } finally {
    libLoading.value = false
  }
}

function pickLibItem(it) {
  const url = assetImageUrl(it) || it.image_url
  if (!url) { ElMessage.warning('这一项没有图'); return }
  inputImage.value = { url, local_path: it.local_path || null, name: libItemName(it) }
  showLibPicker.value = false
  ElMessage.success('已从素材库取图，可以开始调试')
}

function openSaveDialog(item) {
  savingItem.value = item
  savePrompt.value = item?.prompt || prompt.value || ''
  saveName.value = ''
  saveTime.value = ''
  saveDesc.value = ''
  showSaveDialog.value = true
}

async function doSaveToLibrary() {
  const item = savingItem.value
  if (!item) return
  if (!saveName.value.trim()) { ElMessage.warning(saveTarget.value === 'scene' ? '请填写地点' : '请填写名称'); return }
  saving.value = true
  try {
    const base = {
      image_url: item.url,
      local_path: item.local_path || undefined,
    }
    let payload
    if (saveTarget.value === 'character') {
      payload = { ...base, name: saveName.value.trim(), description: saveDesc.value.trim() || undefined }
    } else if (saveTarget.value === 'scene') {
      payload = { ...base, location: saveName.value.trim(), time: saveTime.value.trim() || undefined, description: saveDesc.value.trim() || undefined, prompt: savePrompt.value.trim() || undefined }
    } else if (saveTarget.value === 'prop') {
      payload = { ...base, name: saveName.value.trim(), description: saveDesc.value.trim() || undefined, prompt: savePrompt.value.trim() || undefined }
    } else {
      payload = { ...base, name: saveName.value.trim(), description: saveDesc.value.trim() || undefined, prompt: savePrompt.value.trim() || undefined }
    }
    await LIB_API[saveTarget.value].create(payload)
    ElMessage.success('已存入素材库')
    showSaveDialog.value = false
  } catch (e) {
    ElMessage.error(e?.message || '存入失败')
  } finally {
    saving.value = false
  }
}
</script>

<style scoped>
.studio-page {
  min-height: 100vh;
  padding: 16px 24px 40px;
  box-sizing: border-box;
  color: var(--el-text-color-primary);
  background: var(--el-bg-color-page);
}
.studio-header {
  display: flex;
  align-items: center;
  gap: 12px;
  flex-wrap: wrap;
  margin-bottom: 16px;
}
.studio-title {
  margin: 0;
  font-size: 20px;
  font-weight: 600;
}
.studio-sub {
  font-size: 12px;
  color: var(--el-text-color-secondary);
  flex: 1 1 320px;
  line-height: 1.6;
}
.studio-body {
  display: grid;
  grid-template-columns: 420px 1fr;
  gap: 16px;
  align-items: start;
}
@media (max-width: 1100px) {
  .studio-body { grid-template-columns: 1fr; }
}
.studio-panel {
  background: var(--el-bg-color);
  border: 1px solid var(--el-border-color-lighter);
  border-radius: 10px;
  padding: 14px;
}
.panel-title {
  font-size: 13px;
  font-weight: 600;
  margin: 4px 0 8px;
  display: flex;
  align-items: center;
  gap: 8px;
}
.panel-title--sm { margin-top: 12px; }
.panel-title--mt { margin-top: 18px; }
.panel-title-tip {
  font-size: 11px;
  font-weight: 400;
  color: var(--el-text-color-secondary);
}
.drop-zone {
  position: relative;
  height: 200px;
  border: 1px dashed var(--el-border-color);
  border-radius: 8px;
  display: flex;
  align-items: center;
  justify-content: center;
  cursor: pointer;
  overflow: hidden;
  background: var(--el-fill-color-lighter);
}
.drop-zone--over { border-color: var(--el-color-primary); }
.drop-zone--has { border-style: solid; }
.drop-zone img { max-width: 100%; max-height: 100%; object-fit: contain; }
.drop-hint {
  text-align: center;
  font-size: 12px;
  color: var(--el-text-color-secondary);
  line-height: 1.9;
}
.drop-mask {
  position: absolute;
  inset: 0;
  background: rgba(0, 0, 0, .45);
  color: #fff;
  display: flex;
  align-items: center;
  justify-content: center;
  font-size: 13px;
}
.row-actions {
  display: flex;
  gap: 8px;
  margin: 10px 0 14px;
}
.param-row {
  display: flex;
  align-items: center;
  gap: 10px;
  margin: 14px 0;
}
.param-label { font-size: 13px; }
.generate-btn { width: 100%; margin-top: 6px; }
.result-box img {
  width: 100%;
  border-radius: 8px;
  cursor: zoom-in;
  background: var(--el-fill-color-lighter);
}
.result-actions {
  display: flex;
  gap: 8px;
  margin-top: 10px;
  flex-wrap: wrap;
}
.result-prompt {
  margin-top: 8px;
  font-size: 12px;
  color: var(--el-text-color-secondary);
  line-height: 1.7;
  white-space: pre-wrap;
  word-break: break-all;
}
.history-grid {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(150px, 1fr));
  gap: 10px;
}
.history-item {
  border: 1px solid var(--el-border-color-lighter);
  border-radius: 8px;
  padding: 6px;
}
.history-item--cur { border-color: var(--el-color-primary); }
.history-item img {
  width: 100%;
  height: 110px;
  object-fit: cover;
  border-radius: 6px;
  cursor: pointer;
  background: var(--el-fill-color-lighter);
}
.history-tools {
  display: flex;
  flex-wrap: wrap;
  gap: 2px;
  margin-top: 4px;
}
.history-prompt {
  font-size: 11px;
  color: var(--el-text-color-secondary);
  margin-top: 2px;
  overflow: hidden;
  text-overflow: ellipsis;
  display: -webkit-box;
  -webkit-line-clamp: 2;
  -webkit-box-orient: vertical;
}
.empty-tip {
  font-size: 12px;
  color: var(--el-text-color-secondary);
  padding: 18px 0;
  text-align: center;
}
.lib-grid {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(120px, 1fr));
  gap: 10px;
  max-height: 420px;
  overflow-y: auto;
  min-height: 120px;
}
.lib-item {
  border: 1px solid var(--el-border-color-lighter);
  border-radius: 8px;
  padding: 6px;
  cursor: pointer;
}
.lib-item:hover { border-color: var(--el-color-primary); }
.lib-item img {
  width: 100%;
  height: 100px;
  object-fit: cover;
  border-radius: 6px;
  background: var(--el-fill-color-lighter);
}
.lib-item-ph {
  height: 100px;
  display: flex;
  align-items: center;
  justify-content: center;
  font-size: 12px;
  color: var(--el-text-color-secondary);
  background: var(--el-fill-color-lighter);
  border-radius: 6px;
}
.lib-item-name {
  font-size: 12px;
  margin-top: 4px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
</style>
