<template>
  <div class="aidir">
    <!-- 结果浮层卡 -->
    <transition name="aidir-fade">
      <div v-if="expanded && messages.length" class="aidir-card">
        <div class="aidir-head">
          <span class="aidir-title">AI 导演</span>
          <span class="aidir-hint">对话指挥生产 · 图片自动 · 视频需确认</span>
          <button class="aidir-close" @click="expanded = false" title="收起">×</button>
        </div>
        <div class="aidir-body" ref="bodyRef">
          <div v-for="(m, i) in messages" :key="i" class="aidir-msg" :class="'r-' + m.role">
            <div class="aidir-bubble">{{ m.content }}</div>
            <div v-if="m.tool" class="aidir-tool">
              <span class="aidir-tool-name">⚙ {{ m.tool }}</span>
              <span class="aidir-tool-stat" :class="m.toolStatus">{{ m.toolStatusText }}</span>
              <div v-if="m.toolDetail" class="aidir-tool-detail">{{ m.toolDetail }}</div>
            </div>
            <div v-if="m.qc" class="aidir-qc" :class="m.qc.ok ? 'ok' : 'bad'">
              <span class="aidir-qc-score">质检 {{ m.qc.score }}<span>/100</span></span>
              <span class="aidir-qc-verdict">{{ m.qc.ok ? '通过' : '未通过 → 将重生成' }}</span>
              <div v-if="m.qc.issues && m.qc.issues.length" class="aidir-qc-issues">
                <div v-for="(it, k) in m.qc.issues" :key="k">— {{ it }}</div>
              </div>
            </div>
          </div>
          <el-button v-if="awaitingConfirm" class="aidir-confirm" type="warning" size="small" @click="confirmYes">
            {{ confirmText || '确认执行(视频/高风险操作)?' }}
          </el-button>
        </div>
      </div>
    </transition>

    <!-- 悬浮药丸输入框 -->
    <div class="aidir-pill" :class="{ active: expanded }">
      <span class="aidir-avatar">🤖</span>
      <input
        v-model="text"
        class="aidir-input"
        placeholder="指挥 AI 导演，回车发送，如：给第3幕每镜出图，有瑕疵的自己重生成"
        @keydown.enter.prevent="send"
        :disabled="busy"
      />
      <button v-if="busy" class="aidir-btn stop" @click="stop" title="停止">■</button>
      <button class="aidir-btn send" :disabled="busy || !text.trim()" @click="send">↑</button>
      <button class="aidir-btn ghost" @click="expanded = !expanded" :title="expanded ? '收起日志' : '展开日志'">{{ expanded ? '▾' : '▴' }}</button>
    </div>
  </div>
</template>

<script setup lang="ts">
import { ref, nextTick } from 'vue'
import { ElMessage } from 'element-plus'

const text = ref('')
const messages = ref<any[]>([])
const busy = ref(false)
const expanded = ref(false)
const awaitingConfirm = ref(false)
const confirmText = ref('')
const bodyRef = ref<HTMLElement | null>(null)
let aborter: AbortController | null = null

function push(m: any) { messages.value.push(m); scrollBottom() }
function scrollBottom() { nextTick(() => { if (bodyRef.value) bodyRef.value.scrollTop = bodyRef.value.scrollHeight }) }

async function readSSE(res: Response, onEvent: (ev: any) => void) {
  const reader = res.body!.getReader(); const dec = new TextDecoder(); let buf = ''
  for (;;) {
    const { done, value } = await reader.read(); if (done) break
    buf += dec.decode(value, { stream: true }); let i
    while ((i = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, i).trim(); buf = buf.slice(i + 1)
      if (line.startsWith('data:')) { const p = line.slice(5).trim(); if (p && p !== '[DONE]') try { onEvent(JSON.parse(p)) } catch {} }
    }
  }
}

async function send() {
  const q = text.value.trim(); if (!q || busy.value) return
  text.value = ''; busy.value = true; expanded.value = true
  push({ role: 'user', content: q })
  const history = messages.value.filter((m: any) => m.content).map((m: any) => ({ role: m.role === 'user' ? 'user' : 'assistant', content: m.content }))
  aborter = new AbortController()
  let cur: any = null
  try {
    const res = await fetch('/api/v1/agent/chat', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ messages: history }), signal: aborter.signal })
    if (!res.ok) { const t = await res.text().catch(() => ''); push({ role: 'assistant', content: `后端未就绪: HTTP ${res.status} ${t.slice(0, 100)}` }); return }
    await readSSE(res, (ev) => {
      if (ev.type === 'message') { if (!cur) { cur = { role: 'assistant', content: '' }; push(cur) } cur.content += ev.text || ''; scrollBottom() }
      else if (ev.type === 'tool_call') { push({ role: 'assistant', content: '', tool: ev.name, toolStatus: 'run', toolStatusText: '执行中…', toolDetail: ev.argPreview || '' }) }
      else if (ev.type === 'task_progress') { const l = messages.value[messages.value.length - 1]; if (l && l.toolStatus === 'run') l.toolStatusText = ev.text || l.toolStatusText }
      else if (ev.type === 'tool_result') { const l = messages.value[messages.value.length - 1]; if (l && l.tool) { l.toolStatus = ev.ok ? 'ok' : 'fail'; l.toolStatusText = ev.ok ? '完成' : '失败'; l.toolDetail = ev.summary || '' } scrollBottom() }
      else if (ev.type === 'qc_result') { push({ role: 'assistant', content: '', qc: ev }) }
      else if (ev.type === 'confirm') { awaitingConfirm.value = true; confirmText.value = ev.label || '' }
    })
  } catch (e: any) { if (e?.name !== 'AbortError') push({ role: 'assistant', content: '请求中断: ' + (e?.message || e) }) }
  finally { busy.value = false; aborter = null }
}

function stop() { if (aborter) aborter.abort() }

async function confirmYes() {
  awaitingConfirm.value = false
  push({ role: 'user', content: '同意,继续' })
  push({ role: 'assistant', content: '', tool: '确认', toolStatus: 'run', toolStatusText: '执行中…' })
  busy.value = true; aborter = new AbortController()
  const history = messages.value.filter((m: any) => m.content).map((m: any) => ({ role: m.role === 'user' ? 'user' : 'assistant', content: m.content }))
  history.push({ role: 'user', content: '同意,继续执行刚才请求的步骤' })
  let cur: any = null
  try {
    const res = await fetch('/api/v1/agent/chat', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ messages: history }), signal: aborter.signal })
    await readSSE(res, (ev) => {
      if (ev.type === 'message') { if (!cur) { cur = { role: 'assistant', content: '' }; push(cur) } cur.content += ev.text || ''; scrollBottom() }
      else if (ev.type === 'tool_call') { push({ role: 'assistant', content: '', tool: ev.name, toolStatus: 'run', toolStatusText: '执行中…' }) }
      else if (ev.type === 'tool_result') { const l = messages.value[messages.value.length - 1]; if (l && l.tool) { l.toolStatus = ev.ok ? 'ok' : 'fail'; l.toolStatusText = ev.ok ? '完成' : '失败'; l.toolDetail = ev.summary || '' } }
      else if (ev.type === 'qc_result') { push({ role: 'assistant', content: '', qc: ev }) }
      else if (ev.type === 'confirm') { awaitingConfirm.value = true; confirmText.value = ev.label || '' }
    })
  } catch (e: any) { ElMessage.warning('确认发送失败: ' + (e?.message || e)) }
  finally { busy.value = false; aborter = null }
}
</script>

<style scoped>
/* 根节点不拦截指针事件,让背景正常滚动/点击;药丸和卡片才可交互 */
.aidir { position: fixed; left: 0; right: 0; bottom: 0; z-index: 9999; pointer-events: none; font-family: inherit; }

/* 药丸输入框:居中悬浮 */
.aidir-pill {
  pointer-events: auto;
  max-width: 720px; margin: 0 auto 14px;
  display: flex; align-items: center; gap: 8px;
  padding: 6px 8px 6px 12px;
  background: var(--bg-card, #18181b);
  border: 1px solid var(--border-color, #27272a);
  border-radius: 999px;
  box-shadow: 0 8px 24px rgba(0,0,0,.35);
  transition: border-color .2s, box-shadow .2s;
}
.aidir-pill.active { border-color: var(--el-color-primary, #4b7bff); box-shadow: 0 8px 24px rgba(75,123,255,.18); }
.aidir-avatar { font-size: 16px; user-select: none; }
.aidir-input {
  flex: 1; min-width: 0; height: 32px; padding: 0; border: none; outline: none;
  background: transparent; color: var(--text-primary, #e4e4e7); font-size: 13px;
}
.aidir-input::placeholder { color: var(--border-muted, #3f3f46); }
.aidir-btn {
  height: 30px; min-width: 32px; padding: 0 10px; border-radius: 999px; border: none; cursor: pointer;
  color: #fff; font-size: 14px; display: inline-flex; align-items: center; justify-content: center;
}
.aidir-btn.send { background: var(--el-color-primary, #4b7bff); }
.aidir-btn.send:disabled { background: var(--bg-hover, #27272a); color: var(--border-muted, #3f3f46); cursor: not-allowed; }
.aidir-btn.stop { background: #c0392b; }
.aidir-btn.ghost { background: transparent; color: var(--text-primary, #e4e4e7); border: 1px solid var(--border-color,#27272a); }

/* 结果浮层卡 */
.aidir-card {
  pointer-events: auto;
  max-width: 720px; margin: 0 auto 10px;
  max-height: 42vh; display: flex; flex-direction: column;
  background: var(--bg-card, #18181b);
  border: 1px solid var(--border-color, #27272a);
  border-radius: 14px;
  box-shadow: 0 -8px 30px rgba(0,0,0,.4);
  overflow: hidden;
}
.aidir-head { display: flex; align-items: center; gap: 10px; padding: 9px 14px; border-bottom: 1px solid var(--border-color,#27272a); }
.aidir-title { font-weight: 600; font-size: 13px; color: var(--text-primary,#e4e4e7); }
.aidir-hint { font-size: 11px; color: var(--border-muted,#3f3f46); }
.aidir-close { margin-left: auto; background: none; border: none; color: var(--border-muted,#3f3f46); cursor: pointer; font-size: 16px; }
.aidir-body { overflow-y: auto; padding: 10px 12px; display: flex; flex-direction: column; gap: 8px; }
.aidir-msg { display: flex; flex-direction: column; }
.aidir-msg.r-user { align-items: flex-end; }
.aidir-msg.r-assistant { align-items: flex-start; }
.aidir-bubble { max-width: 86%; padding: 6px 10px; border-radius: 10px; background: var(--bg-inner,#1c1c1e); border: 1px solid var(--border-color,#27272a); white-space: pre-wrap; word-break: break-word; font-size: 12.5px; line-height: 1.5; color: var(--text-primary,#e4e4e7); }
.aidir-tool { max-width: 94%; margin-top: 4px; padding: 6px 9px; border-radius: 8px; background: var(--bg-inner,#1c1c1e); border: 1px solid var(--border-color,#27272a); font-size: 12px; display: flex; flex-wrap: wrap; gap: 8px; }
.aidir-tool-name { color: #8ab4ff; }
.aidir-tool-stat { color: #f39c12; }
.aidir-tool-stat.ok { color: #2ecc71; }
.aidir-tool-stat.fail { color: #e74c3c; }
.aidir-tool-detail { width: 100%; color: var(--border-muted,#3f3f46); word-break: break-word; }
.aidir-qc { max-width: 94%; margin-top: 4px; padding: 6px 9px; border-radius: 8px; font-size: 12px; display: flex; align-items: center; gap: 8px; flex-wrap: wrap; }
.aidir-qc.ok { background: rgba(46,204,113,.1); border: 1px solid rgba(46,204,113,.3); }
.aidir-qc.bad { background: rgba(231,76,60,.1); border: 1px solid rgba(231,76,60,.3); }
.aidir-qc-score { font-weight: 600; color: var(--text-primary,#e4e4e7); }
.aidir-qc-score span { color: var(--border-muted,#3f3f46); font-weight: 400; }
.aidir-qc-verdict { color: inherit; }
.aidir-qc.ok .aidir-qc-verdict { color: #2ecc71; }
.aidir-qc.bad .aidir-qc-verdict { color: #e74c3c; }
.aidir-qc-issues { width: 100%; color: var(--border-muted,#3f3f46); }
.aidir-confirm { margin-top: 4px; align-self: flex-start; }
.aidir-fade-enter-active, .aidir-fade-leave-active { transition: opacity .16s, transform .16s; }
.aidir-fade-enter-from, .aidir-fade-leave-to { opacity: 0; transform: translateY(6px); }
</style>
