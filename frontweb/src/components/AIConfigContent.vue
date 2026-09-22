<template>
  <div class="ai-config-content">
    <el-tabs v-model="activeTab" class="config-tabs">
      <el-tab-pane label="AI 配置" name="configs">
        <div class="tab-content">
          <!-- 普通模式操作栏 -->
          <div v-if="!vendorLock.enabled" class="content-actions">
            <div class="actions-left">
              <el-button type="primary" @click="openAdd">
                <el-icon><Plus /></el-icon>
                添加配置
              </el-button>
              <el-button plain @click="exportConfigs">
                <el-icon><Upload /></el-icon>
                导出配置
              </el-button>
              <el-button plain @click="triggerImport">
                <el-icon><Download /></el-icon>
                导入配置
              </el-button>
              <input ref="importFileRef" type="file" accept=".json" style="display:none" @change="importConfigs" />
            </div>
            <div class="actions-right">
              <transition name="fade-slide">
                <el-button
                  v-if="selectedRows.length > 0"
                  type="danger"
                  :loading="batchDeleting"
                  @click="onBatchDelete"
                >
                  <el-icon><Delete /></el-icon>
                  删除选中 ({{ selectedRows.length }})
                </el-button>
              </transition>
            </div>
          </div>
          <!-- 锁定模式提示栏 -->
          <div v-else class="vendor-lock-bar">
            <el-alert
              type="info"
              :closable="false"
              class="vendor-lock-tip"
            >
              <template #title>
                <span>🔒 当前为厂商锁定模式，AI 服务由管理员统一配置。你只能修改 <b>API Key</b> 和 <b>默认模型</b>。</span>
              </template>
            </el-alert>
            <el-button type="primary" size="small" class="vendor-bulk-key-btn" @click="openBulkKey">
              <el-icon><Key /></el-icon>
              一键换Key
            </el-button>
          </div>
          <p class="default-tip">每种服务类型仅有一个默认配置：文本用于生成故事；文本生成图片用于角色/场景/道具图；分镜图片生成用于分镜图（支持参考图）；视频用于生成视频。</p>
          <el-table
            v-loading="loading"
            :data="list"
            stripe
            style="width: 100%"
            @selection-change="onSelectionChange"
          >
            <el-table-column v-if="!vendorLock.enabled" type="selection" width="46" />
            <el-table-column prop="name" label="名称" min-width="130" />
            <el-table-column prop="provider" label="提供商" width="96" />
            <el-table-column prop="base_url" label="Base URL" min-width="170" show-overflow-tooltip />
            <el-table-column prop="default_model" label="默认模型" min-width="130" show-overflow-tooltip>
              <template #default="{ row }">
                {{ row.default_model || (Array.isArray(row.model) && row.model[0]) || '—' }}
              </template>
            </el-table-column>
            <el-table-column prop="service_type" label="类型" width="148">
              <template #default="{ row }">
                <span :class="['type-badge', 'type-' + row.service_type]">
                  <el-icon class="type-icon">
                    <ChatDotRound v-if="row.service_type === 'text'" />
                    <Picture v-else-if="row.service_type === 'image'" />
                    <Film v-else-if="row.service_type === 'storyboard_image'" />
                    <VideoCamera v-else-if="row.service_type === 'video'" />
                    <Microphone v-else-if="row.service_type === 'tts'" />
                  </el-icon>
                  {{ serviceTypeLabel(row.service_type) }}
                </span>
              </template>
            </el-table-column>
            <el-table-column prop="is_default" label="默认" width="60">
              <template #default="{ row }">
                <el-tag v-if="row.is_default" type="success" size="small">✓</el-tag>
                <span v-else class="no-default">—</span>
              </template>
            </el-table-column>
            <el-table-column label="操作" width="215" fixed="right">
              <template #default="{ row }">
                <el-button v-if="row.service_type === 'tts'" link type="primary" size="small" @click="openVoicePreview(row)">试听</el-button>
                <el-button v-else link type="primary" size="small" @click="openTest(row)">测试</el-button>
                <el-button link type="primary" size="small" @click="onRowEdit(row)">{{ vendorLock.enabled ? '修改Key' : '编辑' }}</el-button>
                <el-button v-if="!vendorLock.enabled" link type="danger" size="small" @click="onDelete(row)">删除</el-button>
              </template>
            </el-table-column>
          </el-table>
        </div>
      </el-tab-pane>
      <el-tab-pane label="高级设置（短剧提示词）" name="promptsDrama">
        <div class="tab-content">
          <PromptEditor group="drama" />
        </div>
      </el-tab-pane>
      <el-tab-pane label="高级设置（宣传片提示词）" name="promptsPromo">
        <div class="tab-content">
          <PromptEditor group="promo" />
        </div>
      </el-tab-pane>
      <el-tab-pane label="高级设置（业务场景）" name="sceneModelMap">
        <div class="tab-content">
          <SceneModelMap />
        </div>
      </el-tab-pane>
      <el-tab-pane label="生成设置" name="generation">
        <div class="tab-content generation-settings">
          <div class="gs-section-title">⚡ 一键生成并发设置</div>
          <p class="gs-desc">控制「一键生成视频」和「补全并生成」流水线中，各类任务同时并行生成的数量。并发数越高速度越快，但过高可能触发 API 限流（429 错误）。建议根据你的 API 额度选择。</p>

          <div class="gs-row">
            <span class="gs-label">图片并发数</span>
            <el-select
              v-model="genConcurrencyInput"
              filterable
              allow-create
              default-first-option
              placeholder="选择或输入并发数"
              style="width: 180px"
              @change="onConcurrencyChange"
            >
              <el-option label="1（串行，最稳定）" :value="1" />
              <el-option label="2" :value="2" />
              <el-option label="3（默认）" :value="3" />
              <el-option label="5" :value="5" />
              <el-option label="8" :value="8" />
              <el-option label="10" :value="10" />
            </el-select>
            <span class="gs-unit">个任务同时生成</span>
          </div>

          <div class="gs-row" style="margin-top: 10px">
            <span class="gs-label">视频并发数</span>
            <el-select
              v-model="genVideoConcurrencyInput"
              filterable
              allow-create
              default-first-option
              placeholder="选择或输入并发数"
              style="width: 180px"
              @change="onVideoConcurrencyChange"
            >
              <el-option label="1（串行，最稳定）" :value="1" />
              <el-option label="2" :value="2" />
              <el-option label="3（默认）" :value="3" />
              <el-option label="5" :value="5" />
              <el-option label="8" :value="8" />
              <el-option label="10" :value="10" />
            </el-select>
            <span class="gs-unit">个任务同时生成</span>
          </div>

          <div style="margin-top: 14px">
            <el-button
              type="primary"
              size="small"
              :loading="genSettingSaving"
              @click="saveGenerationSettings"
            >保存</el-button>
          </div>
          <el-alert
            v-if="genSettingSaved"
            type="success"
            title="已保存"
            :closable="false"
            show-icon
            style="margin-top: 12px; width: fit-content"
          />
          <div class="gs-tip-box">
            <div class="gs-tip-title">📌 适用范围</div>
            <ul class="gs-tip-list">
              <li>图片并发：步骤 2 角色图、步骤 4 场景图、步骤 6 分镜图</li>
              <li>视频并发：步骤 7 分镜视频</li>
            </ul>
          </div>
        </div>
      </el-tab-pane>
    </el-tabs>

    <!-- 添加/编辑 -->
    <el-dialog
      v-model="dialogVisible"
      :title="vendorLock.enabled ? '修改 API Key / 默认模型' : (editingId ? '编辑配置' : '添加配置')"
      width="520px"
      :close-on-click-modal="false"
      @closed="resetForm"
    >
      <!-- 锁定模式：只展示 api_key 和 default_model -->
      <template v-if="vendorLock.enabled">
        <el-descriptions :column="1" border style="margin-bottom: 16px">
          <el-descriptions-item label="名称">{{ form.name }}</el-descriptions-item>
          <el-descriptions-item label="类型">{{ serviceTypeLabel(form.service_type) }}</el-descriptions-item>
          <el-descriptions-item label="厂商">{{ form.provider }}</el-descriptions-item>
        </el-descriptions>
        <el-form ref="formRef" :model="form" label-width="100px">
          <el-form-item prop="api_key" :rules="[{ required: true, message: '请输入 API Key', trigger: 'blur' }]">
            <template #label><span class="form-label-tip">API Key</span></template>
            <el-input
              v-model="form.api_key"
              type="password"
              placeholder="输入你的 API 密钥"
              show-password
            />
          </el-form-item>
          <el-form-item>
            <template #label><span class="form-label-tip">默认模型</span></template>
            <el-select v-model="form.default_model" clearable style="width: 100%">
              <el-option v-for="m in formModelList" :key="m" :label="m" :value="m" />
            </el-select>
            <p class="field-tip">实际调用时使用的模型，可从预设列表中选择。</p>
          </el-form-item>
          <el-form-item>
            <template #label>
              <span class="form-label-tip">设为默认
                <el-tooltip placement="top" popper-class="cfg-tip-popper">
                  <template #content>
                    <div class="cfg-tip-content">
                      每种服务类型只有一个「默认」配置。<br>
                      生成时系统会优先使用默认配置，建议每类至少设一个默认。
                    </div>
                  </template>
                  <el-icon class="tip-icon"><QuestionFilled /></el-icon>
                </el-tooltip>
              </span>
            </template>
            <el-switch v-model="form.is_default" />
          </el-form-item>
        </el-form>
      </template>

      <!-- 普通模式：完整表单 -->
      <el-form v-else ref="formRef" :model="form" :rules="rules" label-width="100px">
        <el-form-item prop="service_type">
          <template #label>
            <span class="form-label-tip">服务类型
              <el-tooltip placement="top" :show-arrow="true" popper-class="cfg-tip-popper">
                <template #content>
                  <div class="cfg-tip-content">
                    <b>文本/对话</b>：用于 AI 生成故事剧本<br>
                    <b>文本生成图片</b>：角色、场景、道具的图片生成（不支持参考图）<br>
                    <b>分镜图片生成</b>：生成分镜图片，支持传入角色参考图<br>
                    <b>视频生成</b>：根据分镜图生成视频片段<br>
                    <b>旁白参考音色</b>：只合成<b>一句 14 字的音色样本</b>，作为整个项目旁白的音色参考交给视频模型；<br>
                    &nbsp;&nbsp;&nbsp;&nbsp;全片解说由视频模型照这个音色念出，<b>不合成整段旁白</b>。全项目只合成一次并缓存。
                  </div>
                </template>
                <el-icon class="tip-icon"><QuestionFilled /></el-icon>
              </el-tooltip>
            </span>
          </template>
          <el-select v-model="form.service_type" placeholder="选择类型" style="width: 100%" @change="onServiceTypeChange">
            <el-option label="文本/对话" value="text" />
            <el-option label="文本生成图片" value="image" />
            <el-option label="分镜图片生成" value="storyboard_image" />
            <el-option label="视频生成" value="video" />
            <el-option label="旁白参考音色" value="tts" />
          </el-select>
        </el-form-item>
        <el-form-item prop="provider">
          <template #label>
            <span class="form-label-tip">厂商
              <el-tooltip placement="top" popper-class="cfg-tip-popper">
                <template #content>
                  <div class="cfg-tip-content">
                    从下拉选择预设厂商，会自动填入 Base URL 和模型列表。<br>
                    也可直接输入自定义厂商名（需手动填写其他字段）。<br>
                    <b>常用</b>：DeepSeek（文本）、ComfyUI（图片 / 视频）、MiniMax H3（云端视频·无需显卡）。
                  </div>
                </template>
                <el-icon class="tip-icon"><QuestionFilled /></el-icon>
              </el-tooltip>
            </span>
          </template>
          <el-select
            v-model="form.provider"
            placeholder="选择预设厂商（自动填充 URL 和模型）"
            clearable
            filterable
            allow-create
            default-first-option
            style="width: 100%"
            @change="onProviderChange"
          >
            <el-option
              v-for="p in availableProviderOptions"
              :key="p.id"
              :label="p.name"
              :value="p.id"
              :class="p.id === '__custom__' ? 'provider-custom-option' : ''"
            />
          </el-select>
        </el-form-item>
        <!-- 接口规范：仅图片/分镜/视频类型显示，预设厂商自动填充；自定义厂商必选 -->
        <el-form-item v-if="form.service_type !== 'text' && form.service_type !== 'tts'">
          <template #label>
            <span class="form-label-tip">接口规范
              <el-icon class="tip-icon" style="cursor:pointer;color:#409eff" @click="showProtocolHelp = true"><QuestionFilled /></el-icon>
            </span>
          </template>
          <el-select v-model="form.api_protocol" style="width: 100%" placeholder="选择接口规范（自定义厂商必选）" clearable>
            <el-option label="OpenAI 兼容（大多数中转站默认）" value="openai" />
            <el-option label="OpenAI 官方图像 gpt-image-2（/images/generations，带参考图自动改 /images/edits）" value="openai_image" />
            <el-option label="MiniMax H3（官方 V2：/v2/video_generation，模型 MiniMax-H3）" value="minimax_h3" />
          </el-select>
        </el-form-item>

        <!-- 旁白参考音色：音色标识（+ MiniMax 旧版 T2A 接口的 GroupId） -->
        <el-form-item v-if="form.service_type === 'tts'">
          <template #label>
            <span class="form-label-tip">音色 ID
              <el-tooltip placement="top" :show-arrow="true" popper-class="cfg-tip-popper">
                <template #content>
                  <div class="cfg-tip-content">
                    旁白要使用的音色标识。系统会用它合成<b>一句 14 字的样本</b>，交给视频模型作为全片旁白的音色参考。<br>
                    <b>MiniMax</b>：官方音色如 <code>female-shaonv</code>、<code>male-qn-qingse</code>，或你自己克隆出来的 voice_id<br>
                    <b>OpenAI 兼容</b>：如 <code>alloy</code>、<code>nova</code>、<code>shimmer</code><br>
                    留空则用厂商默认音色（MiniMax <code>female-shaonv</code> / OpenAI <code>alloy</code>）。
                  </div>
                </template>
                <el-icon class="tip-icon"><QuestionFilled /></el-icon>
              </el-tooltip>
            </span>
          </template>
          <el-input
            v-model="form.voice_id"
            placeholder="如 female-shaonv / male-qn-qingse（MiniMax），alloy / nova（OpenAI）"
            clearable
          />
        </el-form-item>
        <el-form-item v-if="form.service_type === 'tts' && (form.provider || '').toLowerCase() === 'minimax'">
          <template #label>
            <span class="form-label-tip">GroupId
              <el-tooltip placement="top" popper-class="cfg-tip-popper">
                <template #content>
                  <div class="cfg-tip-content">
                    MiniMax <b>旧版</b> T2A 接口（<code>api.minimax.chat/v1/t2a_v2</code>）要求 URL 上带 GroupId。<br>
                    若你的 Key 走新版 <code>api.minimaxi.com</code>，此项可留空。
                  </div>
                </template>
                <el-icon class="tip-icon"><QuestionFilled /></el-icon>
              </el-tooltip>
            </span>
          </template>
          <el-input v-model="form.group_id" placeholder="MiniMax 旧版 T2A 接口的 GroupId，可留空" clearable />
        </el-form-item>

        <!-- 接口规范帮助 Dialog -->
        <el-dialog v-model="showProtocolHelp" title="接口规范说明" width="700px" top="5vh">
          <div class="protocol-help">
            <div class="ph-section-title">🖼 图片 / 分镜图 协议</div>
            <el-collapse accordion>
              <el-collapse-item name="openai-img">
                <template #title><span class="ph-tag ph-tag-img">图片</span> OpenAI 兼容 — 绝大多数中转站默认</template>
                <div class="ph-body">
                  <b>适用场景：</b>OpenAI 官方、各类中转/代理站（ChatFire、硅基流动等）<br>
                  <b>Endpoint：</b><code>POST /v1/images/generations</code><br>
                  <pre>{ "model": "dall-e-3", "prompt": "...", "n": 1, "size": "1024x1024" }</pre>
                </div>
              </el-collapse-item>
            </el-collapse>

            <div class="ph-section-title" style="margin-top:16px">🎬 视频 协议</div>
            <el-collapse accordion>
              <el-collapse-item name="openai-vid">
                <template #title><span class="ph-tag ph-tag-vid">视频</span> OpenAI 兼容 — content 数组格式</template>
                <div class="ph-body">
                  <b>适用场景：</b>各类中转站视频接口<br>
                  <b>Endpoint：</b>自定义，如 <code>POST /v1/video/create</code><br>
                  <pre>{ "model": "your-video-model",
  "content": [
    { "type": "text", "text": "..." },
    { "type": "image_url", "image_url": { "url": "https://..." }, "role": "reference_image" }
  ],
  "ratio": "9:16", "duration": 5, "watermark": false, "resolution": "720p" }</pre>
                </div>
              </el-collapse-item>
            </el-collapse>
          </div>
          <template #footer>
            <el-button @click="showProtocolHelp = false">关闭</el-button>
          </template>
        </el-dialog>
        <el-form-item prop="name">
          <template #label>
            <span class="form-label-tip">名称
              <el-tooltip content="配置的显示名，用于在列表中区分不同配置，选择厂商后可自动生成。" placement="top" popper-class="cfg-tip-popper">
                <el-icon class="tip-icon"><QuestionFilled /></el-icon>
              </el-tooltip>
            </span>
          </template>
          <el-input v-model="form.name" placeholder="如：OpenAI 图文，可自动生成" />
        </el-form-item>
        <el-form-item prop="base_url">
          <template #label>
            <span class="form-label-tip">Base URL
              <el-tooltip placement="top" popper-class="cfg-tip-popper">
                <template #content>
                  <div class="cfg-tip-content">
                    API 接口地址，选择预设厂商后自动填入，一般无需修改。
                  </div>
                </template>
                <el-icon class="tip-icon"><QuestionFilled /></el-icon>
              </el-tooltip>
            </span>
          </template>
          <el-input
            v-model="form.base_url"
            placeholder="选择预设厂商后自动填充，可修改"
          />
        </el-form-item>
        <el-form-item prop="api_key">
          <template #label>
            <span class="form-label-tip">API Key
              <el-tooltip placement="top" popper-class="cfg-tip-popper">
                <template #content>
                  <div class="cfg-tip-content">
                    在对应 AI 平台申请的密钥，用于身份验证。
                  </div>
                </template>
                <el-icon class="tip-icon"><QuestionFilled /></el-icon>
              </el-tooltip>
            </span>
          </template>
          <el-input
            v-model="form.api_key"
            type="password"
            placeholder="API 密钥"
            show-password
          />
        </el-form-item>

        <!-- 端点配置：视频必填（自定义厂商）；图片/分镜在使用代理或特殊厂商时填写 -->
        <template v-if="form.service_type !== 'text' && form.service_type !== 'tts'">
          <el-form-item>
            <template #label>
              <span class="form-label-tip">提交端点
                <el-tooltip placement="top" popper-class="cfg-tip-popper">
                  <template #content>
                    <div class="cfg-tip-content">
                      接口路径，追加在 Base URL 之后。<br>
                      <b>预设厂商</b>留空，系统自动推断。<br>
                      <b>视频自定义厂商</b>必须填写，如 /v1/videos/generations
                    </div>
                  </template>
                  <el-icon class="tip-icon"><QuestionFilled /></el-icon>
                </el-tooltip>
              </span>
            </template>
            <el-input v-model="form.endpoint" :placeholder="form.service_type === 'video' ? '自定义视频厂商必填，如 /v1/videos/generations；预设厂商留空' : '代理或特殊厂商时填写；预设厂商留空'" />
          </el-form-item>
          <el-form-item>
            <template #label>
              <span class="form-label-tip">查询端点
                <el-tooltip placement="top" popper-class="cfg-tip-popper">
                  <template #content>
                    <div class="cfg-tip-content">
                      查询任务状态的接口路径，{taskId} 会被替换为实际任务 ID。<br>
                      <b>预设厂商</b>留空即可，由系统自动推断。<br>
                      <b>视频自定义厂商</b>必须填写，如 /v1/video/tasks/{taskId}<br>
                      <b>图片</b>代理若不支持轮询可留空
                    </div>
                  </template>
                  <el-icon class="tip-icon"><QuestionFilled /></el-icon>
                </el-tooltip>
              </span>
            </template>
            <el-input v-model="form.query_endpoint" placeholder="自定义视频厂商必填，如 /v1/video/tasks/{taskId}；预设厂商留空" />
          </el-form-item>
        </template>

        <!-- 接口地址预览：选择厂商/协议后自动展示，帮助用户核对 -->
        <div v-if="endpointPreviewInfo" class="endpoint-preview-box">
          <div class="ep-preview-header">
            <span>📌 系统将使用以下接口地址</span>
            <span v-if="endpointPreviewInfo.isAuto && form.service_type !== 'text'" class="ep-auto-badge">自动推断</span>
          </div>
          <div class="ep-row">
            <span class="ep-label">提交地址：</span>
            <code class="ep-url">{{ endpointPreviewInfo.submit }}</code>
          </div>
          <div v-if="endpointPreviewInfo.query" class="ep-row">
            <span class="ep-label">查询地址：</span>
            <code class="ep-url">{{ endpointPreviewInfo.query }}</code>
          </div>
          <p v-if="endpointPreviewInfo.note" class="ep-tip">{{ endpointPreviewInfo.note }}</p>
          <p class="ep-tip">以上为系统推断的实际调用地址（可手动填写上方端点字段来覆盖）</p>
        </div>

        <!-- ComfyUI 工作流选择 -->
        <el-form-item v-if="showComfyWorkflow">
          <template #label>
            <span class="form-label-tip">工作流
              <el-tooltip placement="top" popper-class="cfg-tip-popper">
                <template #content>
                  <div class="cfg-tip-content">
                    选择 ComfyUI 工作流文件，系统自动注入提示词、尺寸、种子。<br>
                    工作流中的模型、采样器参数以工作流文件内的设置为准。
                  </div>
                </template>
                <el-icon class="tip-icon"><QuestionFilled /></el-icon>
              </el-tooltip>
            </span>
          </template>
          <el-select
            v-model="form.workflow"
            placeholder="选择工作流（留空使用默认）"
            clearable
            filterable
            :loading="workflowLoading"
            style="width: 100%"
          >
            <el-option
              v-for="wf in workflowList"
              :key="wf.filename"
              :label="wf.filename"
              :value="wf.filename"
            >
              <div class="workflow-option">
                <div class="workflow-option-left">
                  <span class="workflow-option-name">{{ wf.filename }}</span>
                  <span class="workflow-option-plugins" v-if="wf.requiredPlugins && wf.requiredPlugins.length">
                    <el-tag
                      v-for="p in wf.requiredPlugins"
                      :key="p"
                      size="small"
                      :type="wf.requiredPlugins.length <= 3 ? 'info' : 'warning'"
                      effect="plain"
                    >{{ p }}</el-tag>
                  </span>
                </div>
                <span class="workflow-option-tags">
                  <el-tag v-if="wf.hasNunchaku" size="small" type="success" effect="plain">Nunchaku</el-tag>
                  <el-tag v-if="wf.hasControlNet" size="small" type="warning" effect="plain">ControlNet</el-tag>
                  <el-tag v-if="wf.hasSeedVR" size="small" type="danger" effect="plain">SeedVR</el-tag>
                  <el-tag v-if="wf.hasLora" size="small" effect="plain">LoRA</el-tag>
                </span>
              </div>
            </el-option>
          </el-select>
          <p class="field-tip">选定工作流后，模型加载由工作流 JSON 决定，上方「模型列表」「默认模型」可留空。</p>
        </el-form-item>

        <!-- ComfyUI 视频画幅（本地视频实际分辨率） -->
        <el-form-item v-if="showComfyMegapixels">
          <template #label>
            <span class="form-label-tip">视频画幅
              <el-tooltip placement="top" popper-class="cfg-tip-popper">
                <template #content>
                  <div class="cfg-tip-content">
                    本地 ComfyUI 视频的实际分辨率，与官方 ResolutionSelector 同口径（1 MP = 1024×1024）。<br>
                    数值越大越清晰，但生成时间与显存占用显著上升（分辨率翻倍 ≈ 耗时翻倍以上）。<br>
                    竖屏项目自动转置，无需另设。
                  </div>
                </template>
                <el-icon class="tip-icon"><QuestionFilled /></el-icon>
              </el-tooltip>
            </span>
          </template>
          <el-select v-model="form.megapixels" style="width: 100%">
            <el-option
              v-for="opt in megapixelsOptions"
              :key="opt.value"
              :label="opt.label"
              :value="opt.value"
            />
          </el-select>
          <p class="field-tip">决定本地视频画幅；云厂商视频仍按上方「分辨率」与项目画幅处理。</p>
        </el-form-item>

        <!-- ComfyUI turbo 加速开关（覆盖工作流内的 Lightning/turbo 开关） -->
        <el-form-item v-if="showComfyMegapixels">
          <template #label>
            <span class="form-label-tip">turbo 加速
              <el-tooltip placement="top" popper-class="cfg-tip-popper">
                <template #content>
                  <div class="cfg-tip-content">
                    工作流内的 turbo 开关（PrimitiveBoolean → ComfySwitchNode）：开启时挂 turbo/Lightning LoRA 并用少步数采样，速度快；关闭时用原始模型 + 多步数采样。<br>
                    默认「跟随工作流」，即按工作流文件里的原值执行；需要临时对比画质时再强制开启/关闭。<br>
                    若该工作流没有此类开关节点，此项不生效（后端会打 WARN 日志）。
                  </div>
                </template>
                <el-icon class="tip-icon"><QuestionFilled /></el-icon>
              </el-tooltip>
            </span>
          </template>
          <el-select v-model="form.turbo" style="width: 100%">
            <el-option label="跟随工作流（不改动）" :value="''" />
            <el-option label="强制开启（快）" :value="true" />
            <el-option label="强制关闭（慢，原始模型）" :value="false" />
          </el-select>
          <p class="field-tip">仅对本地 ComfyUI 视频生效。</p>
        </el-form-item>

        <el-form-item>
          <template #label>
            <span class="form-label-tip">模型列表
              <el-tooltip placement="top" popper-class="cfg-tip-popper">
                <template #content>
                  <div class="cfg-tip-content">
                    该厂商下可用的模型，多个用逗号或换行分隔。<br>
                    可从上方「追加预设模型」下拉快速添加，也可手动输入。
                  </div>
                </template>
                <el-icon class="tip-icon"><QuestionFilled /></el-icon>
              </el-tooltip>
            </span>
          </template>
          <div class="model-row">
            <el-select
              v-model="presetModelPick"
              placeholder="追加预设模型"
              clearable
              filterable
              style="width: 220px; margin-bottom: 8px"
              @change="onPresetModelSelect"
            >
              <el-option v-for="m in availableModels" :key="m" :label="m" :value="m" />
            </el-select>
          </div>
          <el-input v-model="form.modelText" type="textarea" :rows="2" placeholder="选择预设厂商后自动填入，可编辑；多个用逗号或换行分隔" />
        </el-form-item>
        <el-form-item>
          <template #label>
            <span class="form-label-tip">默认模型
              <el-tooltip content="有多个模型时，实际调用哪个进行生成。建议选响应快、效果好的那个。" placement="top" popper-class="cfg-tip-popper">
                <el-icon class="tip-icon"><QuestionFilled /></el-icon>
              </el-tooltip>
            </span>
          </template>
          <el-select
            v-model="form.default_model"
            :placeholder="formModelList.length ? '从上面模型列表中选一个作为生成时使用的默认' : '请先填写上方模型列表'"
            clearable
            style="width: 100%"
          >
            <el-option v-for="m in formModelList" :key="m" :label="m" :value="m" />
          </el-select>
          <p class="field-tip">该配置被选为「默认」时，生成故事/图片/视频将使用此处指定的模型。</p>
        </el-form-item>
        <el-form-item v-if="isDeepSeekOfficialForm">
          <template #label>
            <span class="form-label-tip">思考模式
              <el-tooltip placement="top" popper-class="cfg-tip-popper">
                <template #content>
                  <div class="cfg-tip-content">
                    DeepSeek V4 官方模型用 thinking 参数控制思考模式。<br>
                    关闭思考对应旧 deepseek-chat；开启思考对应旧 deepseek-reasoner。
                  </div>
                </template>
                <el-icon class="tip-icon"><QuestionFilled /></el-icon>
              </el-tooltip>
            </span>
          </template>
          <div class="deepseek-settings">
            <el-radio-group v-model="form.deepseek_thinking">
              <el-radio-button label="disabled">关闭思考</el-radio-button>
              <el-radio-button label="enabled">开启思考</el-radio-button>
            </el-radio-group>
            <el-select
              v-if="form.deepseek_thinking === 'enabled'"
              v-model="form.deepseek_reasoning_effort"
              style="width: 140px"
            >
              <el-option label="high" value="high" />
              <el-option label="max" value="max" />
            </el-select>
          </div>
          <p class="field-tip">官方旧模型名将在 2026-07-24 废弃；新配置建议使用 deepseek-v4-flash 或 deepseek-v4-pro。</p>
        </el-form-item>
        <el-form-item>
          <template #label>
            <span class="form-label-tip">优先级
              <el-tooltip content="同一服务类型有多个配置时，数字越大越优先被调用。默认 0，一般设为 10 即可。" placement="top" popper-class="cfg-tip-popper">
                <el-icon class="tip-icon"><QuestionFilled /></el-icon>
              </el-tooltip>
            </span>
          </template>
          <el-input-number v-model="form.priority" :min="0" :max="999" />
        </el-form-item>
        <el-form-item>
          <template #label>
            <span class="form-label-tip">设为默认
              <el-tooltip placement="top" popper-class="cfg-tip-popper">
                <template #content>
                  <div class="cfg-tip-content">
                    每种服务类型只有一个「默认」配置。<br>
                    生成时系统会优先使用默认配置，建议每类至少设一个默认。
                  </div>
                </template>
                <el-icon class="tip-icon"><QuestionFilled /></el-icon>
              </el-tooltip>
            </span>
          </template>
          <el-switch v-model="form.is_default" />
        </el-form-item>
      </el-form>
      <template #footer>
        <el-button @click="dialogVisible = false">取消</el-button>
        <el-button type="primary" :loading="saving" @click="submit">确定</el-button>
      </template>
    </el-dialog>

    <!-- 测试连接 -->
    <el-dialog v-model="testVisible" title="测试连接" width="420px">
      <p v-if="testResult === null">正在测试…</p>
      <template v-else-if="testResult">
        <el-alert
          v-if="testServiceType === 'image' || testServiceType === 'storyboard_image' || testServiceType === 'video'"
          type="success"
          title="连接成功"
          description="API Key 有效，网络已连通。提示：测试仅验证 Key 合法性，不实际生成图片/视频，模型名填错、账号未开通该功能或配额不足时实际生成仍可能报错。"
          show-icon
          :closable="false"
        />
        <el-alert
          v-else
          type="success"
          title="连接成功"
          description="文本生成接口已正常响应。"
          show-icon
          :closable="false"
        />
      </template>
      <el-alert v-else type="error" :title="testError || '连接失败'" show-icon :closable="false" />
      <template #footer>
        <el-button @click="testVisible = false">关闭</el-button>
      </template>
    </el-dialog>

    <!-- 旁白参考音色·试听 -->
    <el-dialog v-model="voicePreviewVisible" title="试听旁白参考音色" width="480px">
      <p class="vp-desc">
        下面这句就是要交给视频模型的<b>音色样本</b>（全片旁白会照它念）。<br>
        实际生成视频时这句样本会被缓存复用，不会重复合成。
      </p>
      <el-alert type="info" :closable="false" show-icon class="vp-sample">
        <template #title>样本文案</template>
        {{ VOICE_PREVIEW_TEXT }}
      </el-alert>
      <p v-if="voicePreviewLoading" class="vp-status">正在合成…</p>
      <template v-else-if="voicePreviewUrl">
        <audio :src="voicePreviewUrl" controls autoplay style="width: 100%; margin-top: 8px" />
        <p class="vp-status vp-ok">合成成功。请确认音色是否符合预期，不满意就改「音色 ID」后重新试听。</p>
      </template>
      <el-alert v-else-if="voicePreviewError" type="error" :title="voicePreviewError" show-icon :closable="false" />
      <template #footer>
        <el-button @click="voicePreviewVisible = false">关闭</el-button>
        <el-button type="primary" :loading="voicePreviewLoading" @click="runVoicePreview">重新试听</el-button>
      </template>
    </el-dialog>

    <!-- 一键换Key（锁定模式） -->
    <el-dialog v-model="bulkKeyVisible" title="一键换Key" width="440px" :close-on-click-modal="false">
      <el-alert
        type="warning"
        :closable="false"
        style="margin-bottom: 16px"
        title="此操作将替换所有配置的 API Key，请确认新 Key 可用后再提交。"
        show-icon
      />
      <el-form label-width="80px">
        <el-form-item label="新 API Key">
          <el-input
            v-model="bulkKeyInput"
            type="password"
            show-password
            placeholder="粘贴新的 API Key"
            clearable
          />
        </el-form-item>
      </el-form>
      <template #footer>
        <el-button @click="bulkKeyVisible = false">取消</el-button>
        <el-button type="primary" :loading="bulkKeySaving" :disabled="!bulkKeyInput.trim()" @click="submitBulkKey">确认替换</el-button>
      </template>
    </el-dialog>
  </div>
</template>

<script setup>
import { ref, computed, onMounted, watch } from 'vue'
import { ElMessage, ElMessageBox } from 'element-plus'
import { Plus, QuestionFilled, Download, Upload, Delete, ChatDotRound, Picture, Film, VideoCamera, Key, Microphone } from '@element-plus/icons-vue'
import { aiAPI } from '@/api/ai'
import { audioAPI } from '@/api/audio'
import { generationSettingsAPI } from '@/api/prompts'
import PromptEditor from '@/components/PromptEditor.vue'
import SceneModelMap from '@/components/SceneModelMap.vue'

const activeTab = ref('configs')
const importFileRef = ref(null)

// ---- 生成设置 ----
const genConcurrencyInput = ref(3)
const genVideoConcurrencyInput = ref(3)
const genSettingSaving = ref(false)
const genSettingSaved = ref(false)

async function loadGenerationSettings() {
  try {
    const res = await generationSettingsAPI.get()
    genConcurrencyInput.value = res?.concurrency ?? 3
    genVideoConcurrencyInput.value = res?.video_concurrency ?? 3
  } catch (_) {}
}

function onConcurrencyChange(val) {
  const n = Number(val)
  if (!isNaN(n) && n >= 1) genConcurrencyInput.value = Math.min(20, Math.max(1, Math.round(n)))
}

function onVideoConcurrencyChange(val) {
  const n = Number(val)
  if (!isNaN(n) && n >= 1) genVideoConcurrencyInput.value = Math.min(20, Math.max(1, Math.round(n)))
}

async function saveGenerationSettings() {
  const n = Number(genConcurrencyInput.value)
  const nv = Number(genVideoConcurrencyInput.value)
  if (isNaN(n) || n < 1 || n > 20) {
    ElMessage.warning('图片并发数请填写 1-20 之间的整数')
    return
  }
  if (isNaN(nv) || nv < 1 || nv > 20) {
    ElMessage.warning('视频并发数请填写 1-20 之间的整数')
    return
  }
  genSettingSaving.value = true
  genSettingSaved.value = false
  try {
    await generationSettingsAPI.update({ concurrency: Math.round(n), video_concurrency: Math.round(nv) })
    genSettingSaved.value = true
    setTimeout(() => { genSettingSaved.value = false }, 2000)
  } catch (e) {
    ElMessage.error('保存失败：' + (e?.message || ''))
  } finally {
    genSettingSaving.value = false
  }
}
const loading = ref(false)
const list = ref([])
const selectedRows = ref([])
const batchDeleting = ref(false)
const vendorLock = ref({ enabled: false, config_file: '' })
const dialogVisible = ref(false)
const editingId = ref(null)
const saving = ref(false)
const showProtocolHelp = ref(false)
const bulkKeyVisible = ref(false)
const bulkKeyInput = ref('')
const bulkKeySaving = ref(false)
const formRef = ref(null)
const form = ref({
  service_type: 'text',
  name: '',
  provider: '',
  api_protocol: '',
  base_url: '',
  api_key: '',
  endpoint: '',
  query_endpoint: '',
  modelText: '',
  default_model: '',
  deepseek_thinking: 'disabled',
  deepseek_reasoning_effort: 'high',
  priority: 0,
  is_default: false,
  // ComfyUI 工作流选择
  workflow: '',
  // ComfyUI 视频画幅（MP）：本地视频的实际分辨率来源
  megapixels: 0.5,
  // turbo 加速：'' = 跟随工作流，true/false = 强制开关
  turbo: '',
  // 「旁白参考音色」专用
  voice_id: '',
  group_id: '',
})
const presetModelPick = ref('')
const workflowList = ref([])
const workflowLoading = ref(false)

const formModelList = computed(() => parseModelText(form.value.modelText))

// 保证「生成时默认使用」下拉有可选且选中值在列表内，否则会不显示或修改无效
watch(
  () => [formModelList.value, form.value.default_model],
  () => {
    const list = formModelList.value
    if (list.length === 0) return
    const current = form.value.default_model
    if (!current || !list.includes(current)) {
      form.value.default_model = list[0] || ''
    }
  },
  { immediate: true }
)

function onServiceTypeChange() {
  const st = form.value.service_type || 'text'
  const listByType = providerConfigs[st] || []
  const current = form.value.provider
  if (!current || !listByType.some((p) => p.id === current)) {
    form.value.provider = ''
    form.value.base_url = ''
    form.value.modelText = ''
    form.value.default_model = ''
  }
}

function onPresetModelSelect(value) {
  if (!value) return
  const listParsed = parseModelText(form.value.modelText)
  if (listParsed.includes(value)) {
    presetModelPick.value = ''
    return
  }
  const append = listParsed.length ? '\n' + value : value
  form.value.modelText = (form.value.modelText || '').trim() + append
  presetModelPick.value = ''
}
const rules = computed(() => ({
  service_type: [{ required: true, message: '请选择服务类型', trigger: 'change' }],
  name: [{ required: true, message: '请输入名称', trigger: 'blur' }],
  provider: [{ required: true, message: '请选择或输入厂商', trigger: 'change' }],
  base_url: [{ required: true, message: '请输入 Base URL', trigger: 'blur' }],
  api_key: [
    {
      validator: (_rule, v, cb) => {
        if (v != null && String(v).trim()) return cb()
        cb(new Error('请输入 API Key'))
      },
      trigger: 'blur',
    },
  ],
}))
const testVisible = ref(false)
const testResult = ref(null)
const testServiceType = ref('')
const testError = ref('')

/** 预设厂商与模型（与参考前端一致） */
const providerConfigs = {
  text: [
    { id: 'openai', name: 'OpenAI', models: ['gpt-4o', 'gpt-4', 'gpt-3.5-turbo'] },
    { id: 'deepseek', name: 'DeepSeek', models: ['deepseek-v4-flash', 'deepseek-v4-pro'] }
  ],
  image: [
    { id: 'openai', name: 'OpenAI', models: ['gpt-image-2'] },
    { id: 'comfyui', name: 'ComfyUI', models: ['qwen-image-edit-2511'] }
  ],
  storyboard_image: [
    { id: 'openai', name: 'OpenAI', models: ['gpt-image-2'] },
    { id: 'comfyui', name: 'ComfyUI', models: ['qwen-image-edit-2511'] }
  ],
  video: [
    { id: 'comfyui', name: 'ComfyUI', models: ['LTX 2.3'] },
    { id: 'minimax', name: 'MiniMax', models: ['MiniMax-H3'] }
  ],
  // 「旁白参考音色」：provider 决定走哪条 TTS 接口（ttsService 按 provider 分发，不看 api_protocol）
  tts: [
    { id: 'minimax', name: 'MiniMax（T2A v2）', models: ['speech-2.8-hd', 'speech-2.8-turbo', 'speech-02-hd', 'speech-02-turbo', 'speech-01-hd', 'speech-01-turbo'] },
    { id: 'openai', name: 'OpenAI 兼容（/audio/speech）', models: ['tts-1', 'tts-1-hd', 'gpt-4o-mini-tts'] }
  ],
}

/** 厂商 id → 默认接口规范（api_protocol） */
const providerProtocolMap = {
  comfyui: 'comfyui',
  minimax: 'minimax_h3',
  minimax_h3: 'minimax_h3',
  openai_image: 'openai_image',
  gpt_image: 'openai_image',
  'gpt-image': 'openai_image',
  openai: 'openai',
  deepseek: 'openai',
}

/** 厂商 id → 默认 Base URL */
function getBaseUrlForProvider(provider) {
  if (!provider) return ''
  const p = String(provider).toLowerCase()
  if (p === 'minimax' || p === 'minimax_h3') return 'https://api.minimaxi.com'
  if (p === 'openai' || p === 'openai_image' || p === 'gpt_image' || p === 'gpt-image') return 'https://api.openai.com/v1'
  if (p === 'deepseek') return 'https://api.deepseek.com'
  if (p === 'comfyui' || p === 'comfy') return 'http://127.0.0.1:8188'
  return ''
}

const CUSTOM_PROVIDER_SENTINEL = '__custom__'

function parseSettings(settings) {
  if (!settings) return {}
  if (typeof settings === 'object') return settings
  try {
    const parsed = JSON.parse(settings)
    return parsed && typeof parsed === 'object' ? parsed : {}
  } catch (_) {
    return {}
  }
}

function isDeepSeekOfficial(provider, baseUrl) {
  const p = String(provider || '').trim().toLowerCase()
  const base = String(baseUrl || '').trim().toLowerCase()
  return p === 'deepseek' || base.includes('api.deepseek.com')
}

function resolveDeepSeekFormSettings(row) {
  const s = parseSettings(row?.settings)
  const nested = s.deepseek && typeof s.deepseek === 'object' ? s.deepseek : {}
  let thinking = s.deepseek_thinking || s.thinking || nested.thinking || nested.type || ''
  const model = String(row?.default_model || '').toLowerCase()
  if (!thinking && model === 'deepseek-chat') thinking = 'disabled'
  if (!thinking && model === 'deepseek-reasoner') thinking = 'enabled'
  if (thinking !== 'enabled' && thinking !== 'disabled') thinking = 'disabled'

  let effort = s.deepseek_reasoning_effort || s.reasoning_effort || nested.reasoning_effort || nested.effort || 'high'
  effort = String(effort).toLowerCase() === 'max' ? 'max' : 'high'
  return { thinking, effort }
}

const isDeepSeekOfficialForm = computed(() => (
  form.value.service_type === 'text'
  && isDeepSeekOfficial(form.value.provider, form.value.base_url)
))

const isComfyUIForm = computed(() => {
  const p = (form.value.provider || '').toLowerCase()
  const api = (form.value.api_protocol || '').toLowerCase()
  return (p === 'comfyui' || p === 'comfy' || api === 'comfyui')
    && (form.value.service_type === 'image' || form.value.service_type === 'storyboard_image' || form.value.service_type === 'video')
})

const showComfyWorkflow = computed(() => isComfyUIForm.value && !vendorLock.value.enabled)

// 视频画幅：仅 ComfyUI 的视频服务需要（决定本地视频实际分辨率）
const showComfyMegapixels = computed(() => isComfyUIForm.value && form.value.service_type === 'video')

// 与后端 comfyuiClient 同构：total = mp * 1024 * 1024，再按 32 取整（官方 ResolutionSelector 口径）
function mpToPixels(mp, wr = 16, hr = 9) {
  const total = Math.round(Number(mp || 0.4) * 1024 * 1024)
  const scale = Math.sqrt(total / (wr * hr))
  return `${Math.round((wr * scale) / 32) * 32}×${Math.round((hr * scale) / 32) * 32}`
}

const megapixelsOptions = computed(() =>
  [0.4, 0.5, 0.6, 0.7, 0.98].map((mp) => ({
    value: mp,
    label: `${mp} MP · 16:9 ${mpToPixels(mp, 16, 9)} · 9:16 ${mpToPixels(mp, 9, 16)}`,
  }))
)

async function fetchWorkflows() {
  workflowLoading.value = true
  try {
    const type = form.value.service_type === 'video' ? 'video' : ''
    const res = await aiAPI.fetchWorkflows(type)
    workflowList.value = res.data || res || []
  } catch (_) {
    workflowList.value = []
  } finally {
    workflowLoading.value = false
  }
}

watch(() => [form.value.provider, form.value.service_type, form.value.api_protocol], () => {
  if (showComfyWorkflow.value && workflowList.value.length === 0) {
    fetchWorkflows()
  }
})

/** 当前服务类型下的预设厂商列表（编辑时若当前 provider 不在列表则补一项；末尾始终附一项自定义入口） */
const availableProviderOptions = computed(() => {
  const st = form.value.service_type || 'text'
  const listByType = providerConfigs[st] || []
  const current = form.value.provider
  let result = [...listByType]
  if (editingId.value && current && current !== CUSTOM_PROVIDER_SENTINEL && !listByType.some((p) => p.id === current)) {
    result = [{ id: current, name: current + ' (当前)', models: [] }, ...result]
  }
  result.push({ id: CUSTOM_PROVIDER_SENTINEL, name: '✏️ 自定义（直接输入厂商名）', models: [] })
  return result
})

/** 当前厂商的预设模型列表（用于追加预设模型） */
const availableModels = computed(() => {
  const st = form.value.service_type
  const provider = form.value.provider
  if (!st || !provider) return []
  const p = (providerConfigs[st] || []).find((x) => x.id === provider)
  return p?.models || []
})

/** 根据当前厂商/协议/base_url 推算实际将使用的接口地址，供用户核对 */
const endpointPreviewInfo = computed(() => {
  const { api_protocol, base_url, service_type, endpoint, query_endpoint } = form.value
  const p = String(form.value.provider || '').toLowerCase()
  const proto = api_protocol || providerProtocolMap[p] || ''
  const base = (base_url || '').replace(/\/$/, '')

  if (!base && !proto && !p) return null

  let submitPath = '', queryPath = '', note = ''

  if (service_type === 'text') {
    submitPath = '/chat/completions'
  } else if (service_type === 'image' || service_type === 'storyboard_image') {
    if (proto === 'openai_image' || p === 'openai' || p === 'openai_image' || p === 'gpt_image' || p === 'gpt-image') {
      // OpenAI 官方 gpt-image-2：文生图走 /images/generations；带参考图（分镜/角色一致性）自动改用 /images/edits
      submitPath = endpoint || '/images/generations'
      note = 'OpenAI gpt-image-2：文生图 POST /images/generations；带参考图时自动改用 POST /images/edits'
    } else {
      submitPath = endpoint || '/images/generations'  // openai 兼容：base_url 已含 /v1
    }
  } else if (service_type === 'video') {
    if (endpoint) {
      submitPath = endpoint
    } else if (proto === 'minimax_h3' || p === 'minimax' || p === 'minimax_h3') {
      submitPath = '/v2/video_generation'
    } else {
      submitPath = '/v1/video/create'
    }
    if (query_endpoint) {
      queryPath = query_endpoint
    } else if (proto === 'minimax_h3' || p === 'minimax' || p === 'minimax_h3') {
      queryPath = '/v2/query/video_generation/{taskId}'
    } else {
      queryPath = '/v1/video/query?id={taskId}'
    }
  }

  const submitUrl = base ? (base + submitPath) : ('(未填 Base URL)' + submitPath)
  const queryUrl = queryPath ? (base ? base + queryPath : '(未填 Base URL)' + queryPath) : null

  if (!submitPath) return null
  return {
    submit: submitUrl,
    query: queryUrl,
    isAuto: !endpoint,  // 端点是自动推断的（非用户手填）
    note,
  }
})

function onProviderChange(providerId) {
  if (providerId === CUSTOM_PROVIDER_SENTINEL) {
    form.value.provider = ''
    form.value.api_protocol = ''
    form.value.base_url = ''
    form.value.modelText = ''
    form.value.default_model = ''
    return
  }
  const st = form.value.service_type || 'text'
  const p = (providerConfigs[st] || []).find((x) => x.id === providerId)
  if (!p) {
    form.value.base_url = ''
    form.value.modelText = ''
    form.value.default_model = ''
    return
  }
  form.value.base_url = getBaseUrlForProvider(providerId)
  // ComfyUI 图片类配置有工作流选择，模型列表留空即可
  if (providerId === 'comfyui' && (st === 'image' || st === 'storyboard_image' || st === 'video')) {
    form.value.modelText = ''
    form.value.default_model = ''
  } else {
    form.value.modelText = (p.models || []).join('\n')
    form.value.default_model = (p.models && p.models[0]) || ''
  }
  if (providerId === 'deepseek') {
    form.value.deepseek_thinking = 'disabled'
    form.value.deepseek_reasoning_effort = 'high'
  }
  // 自动填充端点
  if (st === 'video' && (providerId === 'minimax' || providerId === 'minimax_h3')) {
    form.value.endpoint = '/v2/video_generation'
    form.value.query_endpoint = '/v2/query/video_generation/{taskId}'
  }
  // OpenAI 官方 gpt-image-2：文生图端点；带参考图时后端自动改用 /images/edits
  if ((st === 'image' || st === 'storyboard_image')
    && (providerId === 'openai' || providerId === 'openai_image' || providerId === 'gpt_image' || providerId === 'gpt-image')) {
    form.value.endpoint = '/images/generations'
    form.value.query_endpoint = ''
  }
  // 自动填充接口规范：图片类的 provider=openai 必须落到 openai_image（不能和文本的 openai 协议混用）
  const isImageType = st === 'image' || st === 'storyboard_image'
  if (isImageType && (providerId === 'openai' || providerId === 'openai_image' || providerId === 'gpt_image' || providerId === 'gpt-image')) {
    form.value.api_protocol = 'openai_image'
  } else if (st === 'video' && (providerId === 'minimax' || providerId === 'minimax_h3')) {
    form.value.api_protocol = 'minimax_h3'
  } else if (st === 'tts') {
    // 旁白参考音色：ttsService 按 provider 分发（minimax→T2A v2 / openai→/audio/speech），不使用 api_protocol
    form.value.api_protocol = ''
  } else {
    form.value.api_protocol = providerProtocolMap[providerId] || (st === 'text' ? '' : 'openai')
  }
  if (!editingId.value) {
    form.value.name = (p.name || providerId) + ' ' + serviceTypeLabel(st)
  }
}

function serviceTypeLabel(t) {
  const map = {
    text: '文本',
    image: '文本生成图片',
    storyboard_image: '分镜图片生成',
    video: '视频',
    tts: '旁白参考音色',
  }
  return map[t] || t
}

function onRowEdit(row) {
  openEdit(row)
}

async function loadList() {
  loading.value = true
  try {
    list.value = await aiAPI.list()
  } catch (_) {
    list.value = []
  } finally {
    loading.value = false
  }
}

function parseModelText(text) {
  if (!text || !String(text).trim()) return []
  return String(text)
    .split(/[\n,，]/)
    .map((s) => s.trim())
    .filter(Boolean)
}

function resetForm() {
  editingId.value = null
  presetModelPick.value = ''
  form.value = {
    service_type: 'text',
    name: '',
    provider: '',
    api_protocol: '',
    base_url: '',
    api_key: '',
    endpoint: '',
    query_endpoint: '',
    modelText: '',
    default_model: '',
    deepseek_thinking: 'disabled',
    deepseek_reasoning_effort: 'high',
    priority: 0,
    is_default: true,  // 新增时默认勾选「设为默认」，便于理解当前会使用哪条配置
    workflow: '',
    megapixels: 0.5,
    turbo: '',
    voice_id: '',
    group_id: '',
  }
  formRef.value?.resetFields?.()
}

function openAdd() {
  resetForm()
  dialogVisible.value = true
}

function openEdit(row) {
  editingId.value = row.id
  const model = Array.isArray(row.model) ? row.model : (row.model ? [row.model] : [])
  const modelList = model.map((m) => String(m).trim()).filter(Boolean)
  const defaultInList = row.default_model && modelList.includes(row.default_model)
  // ComfyUI 工作流 / 画幅 / turbo 从 settings 解析
  let workflow = ''
  let megapixels = 0.5
  let turbo = ''
  const deepseekSettings = resolveDeepSeekFormSettings(row)
  if (row.settings) {
    try {
      const s = JSON.parse(row.settings)
      if (s.workflow) workflow = s.workflow
      if (Number(s.megapixels) > 0) megapixels = Number(s.megapixels)
      if (typeof s.turbo === 'boolean') turbo = s.turbo
    } catch (_) {}
  }
  form.value = {
    service_type: row.service_type,
    name: row.name,
    provider: row.provider,
    api_protocol: row.api_protocol || '',
    base_url: row.base_url,
    api_key: row.api_key,
    endpoint: row.endpoint || '',
    query_endpoint: row.query_endpoint || '',
    modelText: modelList.join('\n'),
    default_model: defaultInList ? row.default_model : (modelList[0] || ''),
    deepseek_thinking: deepseekSettings.thinking,
    deepseek_reasoning_effort: deepseekSettings.effort,
    priority: row.priority ?? 0,
    is_default: !!row.is_default,
    workflow,
    megapixels,
    turbo,
    voice_id: row.voice_id || '',
    group_id: row.group_id || '',
  }
  dialogVisible.value = true
}

async function submit() {
  await formRef.value?.validate?.().catch(() => {})
  saving.value = true
  try {
    const modelList = parseModelText(form.value.modelText)
    const defaultModel = form.value.default_model && modelList.includes(form.value.default_model)
      ? form.value.default_model
      : modelList[0] || null
    // settings 是**一份共享基底**：所有分支都改它，最后统一序列化一次。
    // 之前每个分支都从 prev.settings 重新 parse、各自覆盖 settings —— 结果后一个分支把前一个
    // 刚写进去的字段丢掉（实测：改了「工作流」再打开又变回旧值，因为视频画幅那段把它覆盖了）。
    const prevRow = editingId.value ? list.value.find((r) => r.id === editingId.value) : null
    const baseS = parseSettings(prevRow?.settings)
    let settingsTouched = false
    if (isDeepSeekOfficialForm.value) {
      baseS.deepseek_thinking = form.value.deepseek_thinking === 'enabled' ? 'enabled' : 'disabled'
      if (baseS.deepseek_thinking === 'enabled') {
        baseS.deepseek_reasoning_effort = form.value.deepseek_reasoning_effort === 'max' ? 'max' : 'high'
      } else {
        delete baseS.deepseek_reasoning_effort
      }
      settingsTouched = true
    }
    // ComfyUI 工作流（与画幅同存于 settings）
    if (form.value.workflow) {
      baseS.workflow = form.value.workflow
      settingsTouched = true
    }
    // ComfyUI 视频画幅 / turbo
    if (showComfyMegapixels.value) {
      if (Number(form.value.megapixels) > 0) baseS.megapixels = Number(form.value.megapixels)
      else delete baseS.megapixels
      if (typeof form.value.turbo === 'boolean') baseS.turbo = form.value.turbo
      else delete baseS.turbo
      settingsTouched = true
    }
    const settings = settingsTouched ? (Object.keys(baseS).length ? JSON.stringify(baseS) : null) : undefined
    const payload = {
      service_type: form.value.service_type,
      name: form.value.name,
      provider: form.value.provider,
      api_protocol: form.value.api_protocol || '',
      base_url: form.value.base_url,
      api_key: form.value.api_key,
      endpoint: form.value.endpoint || '',
      query_endpoint: form.value.query_endpoint || '',
      model: modelList,
      default_model: defaultModel,
      priority: form.value.priority,
      is_default: form.value.is_default,
      ...(settings !== undefined ? { settings } : {}),
      // 「旁白参考音色」专用：其余类型始终提交，值为空字符串（后端会归一化成 null）
      voice_id: form.value.service_type === 'tts' ? (form.value.voice_id || '') : '',
      group_id: form.value.service_type === 'tts' ? (form.value.group_id || '') : '',
    }
    if (editingId.value) {
      await aiAPI.update(editingId.value, payload)
      ElMessage.success('保存成功')
    } else {
      await aiAPI.create(payload)
      ElMessage.success('添加成功')
    }
    dialogVisible.value = false
    await loadList()
  } catch (e) {
    // request 已统一报错
  } finally {
    saving.value = false
  }
}

function openBulkKey() {
  bulkKeyInput.value = ''
  bulkKeyVisible.value = true
}

async function submitBulkKey() {
  const key = bulkKeyInput.value.trim()
  if (!key) return
  bulkKeySaving.value = true
  try {
    const res = await aiAPI.bulkUpdateKey(key)
    ElMessage.success(res?.message || '所有配置的 API Key 已更新')
    bulkKeyVisible.value = false
    await loadList()
  } catch (_) {
  } finally {
    bulkKeySaving.value = false
  }
}

async function openTest(row) {
  testVisible.value = true
  testResult.value = null
  testError.value = ''
  testServiceType.value = row.service_type || 'text'
  try {
    await aiAPI.testConnection({
      base_url: row.base_url,
      api_key: row.api_key,
      model: Array.isArray(row.model) ? row.model[0] : row.model,
      provider: row.provider,
      endpoint: row.endpoint,
      service_type: row.service_type,
      settings: row.settings
    })
    testResult.value = true
  } catch (e) {
    testResult.value = false
    testError.value = e?.message || '请求失败'
  }
}

/** 「旁白参考音色」试听用的固定样本文案 —— 与 videoClient.resolveDefaultNarratorVoiceReferenceUrl 保持一致 */
const VOICE_PREVIEW_TEXT = '大家好，下面开始介绍本产品。'
const voicePreviewVisible = ref(false)
const voicePreviewLoading = ref(false)
const voicePreviewUrl = ref('')
const voicePreviewError = ref('')
const voicePreviewRow = ref(null)

async function runVoicePreview() {
  const row = voicePreviewRow.value
  if (!row) return
  voicePreviewLoading.value = true
  voicePreviewUrl.value = ''
  voicePreviewError.value = ''
  try {
    const res = await audioAPI.extract({ text: VOICE_PREVIEW_TEXT, config_id: row.id })
    // 合成文件落在 storage 下，后端返回 /static/... 相对路径
    if (res?.url) {
      // 加时间戳避免命中浏览器对该 URL 的旧缓存
      voicePreviewUrl.value = res.url + (res.url.includes('?') ? '&' : '?') + 't=' + Date.now()
    } else {
      voicePreviewError.value = '合成成功但没有返回音频地址'
    }
  } catch (e) {
    voicePreviewError.value = e?.message || '试听失败'
  } finally {
    voicePreviewLoading.value = false
  }
}

function openVoicePreview(row) {
  voicePreviewRow.value = row
  voicePreviewVisible.value = true
  runVoicePreview()
}

async function onDelete(row) {
  await ElMessageBox.confirm(`确定删除配置「${row.name}」？`, '删除确认', {
    type: 'warning'
  })
  try {
    await aiAPI.delete(row.id)
    ElMessage.success('已删除')
    await loadList()
  } catch (_) {}
}

function onSelectionChange(rows) {
  selectedRows.value = rows
}

async function onBatchDelete() {
  if (!selectedRows.value.length) return
  await ElMessageBox.confirm(
    `确定删除选中的 ${selectedRows.value.length} 条配置？此操作不可恢复。`,
    '批量删除确认',
    { type: 'warning', confirmButtonText: '确定删除', confirmButtonClass: 'el-button--danger' }
  )
  batchDeleting.value = true
  let success = 0, failed = 0
  for (const row of selectedRows.value) {
    try {
      await aiAPI.delete(row.id)
      success++
    } catch (_) { failed++ }
  }
  batchDeleting.value = false
  selectedRows.value = []
  ElMessage.success(`已删除 ${success} 条${failed ? `，${failed} 条失败` : ''}`)
  await loadList()
}

async function exportConfigs() {
  try {
    const configs = await aiAPI.list()
    const exportData = configs.map(({ id, created_at, updated_at, ...rest }) => rest)
    const blob = new Blob([JSON.stringify(exportData, null, 2)], { type: 'application/json' })
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a')
    a.href = url
    a.download = `ai-configs-${new Date().toISOString().slice(0, 10)}.json`
    a.click()
    URL.revokeObjectURL(url)
    ElMessage.success(`已导出 ${exportData.length} 条配置`)
  } catch (e) {
    ElMessage.error('导出失败')
  }
}

function triggerImport() {
  importFileRef.value?.click()
}

async function importConfigs(event) {
  const file = event.target.files?.[0]
  if (!file) return
  try {
    const text = await file.text()
    const configs = JSON.parse(text)
    if (!Array.isArray(configs)) {
      ElMessage.error('文件格式不正确，需要 JSON 数组')
      return
    }
    let success = 0
    let failed = 0
    const errors = []
    for (const cfg of configs) {
      try {
        const models = Array.isArray(cfg.model) ? cfg.model : (cfg.model ? [cfg.model] : [])
        await aiAPI.create({
          service_type: cfg.service_type,
          name: cfg.name,
          provider: cfg.provider,
          api_protocol: cfg.api_protocol || null,
          base_url: cfg.base_url,
          api_key: cfg.api_key || '',
          endpoint: cfg.endpoint || null,
          query_endpoint: cfg.query_endpoint || null,
          model: models,
          default_model: cfg.default_model || null,
          priority: cfg.priority ?? 0,
          is_default: !!cfg.is_default,
          settings: cfg.settings || null
        })
        success++
      } catch (e) {
        failed++
        const msg = e?.response?.data?.error || e?.message || String(e)
        errors.push(msg)
        console.error('[导入配置] 失败:', cfg.name || cfg.service_type, msg)
      }
    }
    if (errors.length) {
      ElMessage.warning(`导入完成：${success} 条成功，${failed} 条失败。错误：${errors[0]}`)
    } else {
      ElMessage.success(`导入完成：${success} 条成功`)
    }
    await loadList()
  } catch (e) {
    ElMessage.error('导入失败：' + (e.message || '文件解析错误'))
  } finally {
    event.target.value = ''
  }
}

async function loadVendorLock() {
  try {
    vendorLock.value = await aiAPI.getVendorLock()
  } catch (_) {
    vendorLock.value = { enabled: false, config_file: '' }
  }
}

onMounted(() => {
  loadVendorLock()
  loadList()
  loadGenerationSettings()
})
</script>

<style>
.provider-custom-option {
  border-top: 1px solid var(--el-border-color-light, #e4e7ed);
  margin-top: 4px;
  padding-top: 4px;
  color: var(--el-color-primary, #409eff) !important;
  font-style: italic;
}
</style>

<style scoped>
.ai-config-content {
  padding: 0;
}
.config-tabs {
  margin-top: -4px;
}
.tab-content {
  padding-top: 16px;
  max-height: calc(100vh - 320px);
  overflow-y: auto;
}
.content-actions {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
  margin-bottom: 16px;
}
.actions-left {
  display: flex;
  align-items: center;
  gap: 8px;
  flex-wrap: wrap;
}
.actions-right {
  display: flex;
  align-items: center;
  gap: 8px;
  flex-shrink: 0;
}

/* 过渡动画 */
.fade-slide-enter-active,
.fade-slide-leave-active {
  transition: all 0.2s ease;
}
.fade-slide-enter-from,
.fade-slide-leave-to {
  opacity: 0;
  transform: translateX(8px);
}

/* 类型徽章 */
.type-badge {
  display: inline-flex;
  align-items: center;
  gap: 5px;
  padding: 3px 10px;
  border-radius: 20px;
  font-size: 12px;
  font-weight: 600;
  white-space: nowrap;
  border: 1px solid transparent;
}
.type-icon {
  font-size: 13px;
  flex-shrink: 0;
}

/* 文本/对话 — 蓝色 */
.type-text {
  background: rgba(59, 130, 246, 0.12);
  color: #3b82f6;
  border-color: rgba(59, 130, 246, 0.25);
}
/* 文本生成图片 — 绿色 */
.type-image {
  background: rgba(16, 185, 129, 0.12);
  color: #10b981;
  border-color: rgba(16, 185, 129, 0.25);
}
/* 分镜图片生成 — 紫色 */
.type-storyboard_image {
  background: rgba(139, 92, 246, 0.12);
  color: #8b5cf6;
  border-color: rgba(139, 92, 246, 0.25);
}
/* 视频 — 橙色 */
.type-video {
  background: rgba(249, 115, 22, 0.12);
  color: #f97316;
  border-color: rgba(249, 115, 22, 0.25);
}
/* 旁白参考音色 — 青色 */
.type-tts {
  background: rgba(6, 182, 212, 0.12);
  color: #06b6d4;
  border-color: rgba(6, 182, 212, 0.25);
}
.no-default {
  color: #9ca3af;
  font-size: 13px;
}
/* 旁白参考音色·试听弹窗 */
.vp-desc {
  margin: 0 0 12px;
  font-size: 13px;
  line-height: 1.7;
  color: var(--el-text-color-regular, #606266);
}
.vp-sample {
  margin-bottom: 4px;
}
.vp-status {
  margin: 10px 0 0;
  font-size: 13px;
  color: var(--el-text-color-secondary, #909399);
}
.vp-ok {
  color: var(--el-color-success, #67c23a);
}
code {
  background: var(--el-fill-color, #f0f2f5);
  padding: 1px 5px;
  border-radius: 3px;
  font-size: 12px;
  font-family: monospace;
}
.cfg-tip-content code {
  background: none;
  padding: 0;
  border-radius: 0;
  font-size: inherit;
  font-family: monospace;
}
.default-tip {
  margin: 0 0 16px;
  padding: 10px 12px;
  background: #f0f9ff;
  border-radius: 6px;
  font-size: 13px;
  color: #0369a1;
  line-height: 1.5;
}
.vendor-lock-bar {
  display: flex;
  align-items: center;
  gap: 12px;
  margin-bottom: 16px;
}
.vendor-lock-bar .vendor-lock-tip {
  flex: 1;
  margin-bottom: 0;
}
.vendor-bulk-key-btn {
  white-space: nowrap;
  flex-shrink: 0;
  color: #fff !important;
}
.vendor-lock-tip {
  margin-bottom: 16px;
}
.model-row { margin-bottom: 4px; }
.deepseek-settings {
  display: flex;
  align-items: center;
  gap: 10px;
  flex-wrap: wrap;
}
.field-tip {
  margin: 6px 0 0;
  font-size: 12px;
  color: #909399;
  line-height: 1.4;
}
.form-label-tip {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  white-space: nowrap;
}
.ph-section-title {
  font-size: 13px;
  font-weight: 600;
  color: #606266;
  padding: 4px 0 6px;
  border-bottom: 1px solid #ebeef5;
  margin-bottom: 4px;
}
.ph-tag {
  display: inline-block;
  font-size: 11px;
  padding: 1px 6px;
  border-radius: 3px;
  margin-right: 6px;
  font-weight: 600;
  vertical-align: middle;
}
.ph-tag-img {
  background: #ecf5ff;
  color: #409eff;
  border: 1px solid #b3d8ff;
}
.ph-tag-vid {
  background: #f0f9eb;
  color: #67c23a;
  border: 1px solid #b3e19d;
}
.protocol-help .ph-body {
  font-size: 13px;
  line-height: 1.7;
  color: #303133;
}
.protocol-help .ph-body pre {
  background: #f5f7fa;
  border-radius: 4px;
  padding: 8px 12px;
  font-size: 12px;
  line-height: 1.6;
  overflow-x: auto;
  margin: 6px 0 2px;
  white-space: pre-wrap;
  word-break: break-all;
}
.protocol-help .ph-body code {
  background: #f0f2f5;
  padding: 1px 5px;
  border-radius: 3px;
  font-size: 12px;
}
.tip-icon {
  font-size: 13px;
  color: #909399;
  cursor: pointer;
  flex-shrink: 0;
  transition: color 0.15s;
}
.tip-icon:hover {
  color: #409eff;
}
.endpoint-preview-box {
  background: #f0f7ff;
  border: 1px solid #c6e0ff;
  border-radius: 6px;
  padding: 10px 14px;
  margin: -4px 0 14px;
  font-size: 12px;
}
.ep-preview-header {
  display: flex;
  align-items: center;
  gap: 8px;
  font-weight: 600;
  color: #409eff;
  margin-bottom: 8px;
  font-size: 12px;
}
.ep-auto-badge {
  background: #e6f1ff;
  color: #409eff;
  border: 1px solid #b3d8ff;
  border-radius: 3px;
  padding: 0 5px;
  font-size: 11px;
  font-weight: 400;
}
.ep-row {
  display: flex;
  align-items: flex-start;
  margin-bottom: 5px;
  gap: 6px;
  line-height: 1.5;
}
.ep-row:last-of-type {
  margin-bottom: 0;
}
.ep-label {
  flex-shrink: 0;
  color: #606266;
  min-width: 68px;
}
.ep-url {
  word-break: break-all;
  color: #303133;
  background: rgba(255,255,255,0.7);
  border: 1px solid #dce8fa;
  border-radius: 3px;
  padding: 1px 6px;
  font-family: 'Menlo', 'Consolas', monospace;
  font-size: 11.5px;
  line-height: 1.6;
}
.ep-tip {
  margin: 8px 0 0;
  font-size: 11px;
  color: #909399;
  line-height: 1.4;
}
.generation-settings {
  max-width: 600px;
}
.gs-section-title {
  font-size: 14px;
  font-weight: 600;
  color: #303133;
  margin-bottom: 8px;
}
.gs-desc {
  font-size: 13px;
  color: #606266;
  line-height: 1.6;
  margin-bottom: 20px;
}
.gs-row {
  display: flex;
  align-items: center;
  gap: 10px;
  margin-bottom: 12px;
}
.gs-label {
  font-size: 13px;
  color: #303133;
  font-weight: 500;
  white-space: nowrap;
}
.gs-unit {
  font-size: 13px;
  color: #606266;
  white-space: nowrap;
}
.gs-tip-box {
  margin-top: 20px;
  background: #f5f7fa;
  border-radius: 8px;
  padding: 14px 16px;
  font-size: 13px;
}
.gs-tip-title {
  font-weight: 600;
  color: #303133;
  margin-bottom: 8px;
}
.gs-tip-list {
  margin: 0 0 8px 16px;
  padding: 0;
  color: #606266;
  line-height: 1.8;
}
.gs-tip-note {
  color: #909399;
  font-size: 12px;
}
.workflow-option {
  display: flex;
  align-items: center;
  justify-content: space-between;
  width: 100%;
}
.workflow-option-left {
  flex: 1;
  min-width: 0;
}
.workflow-option-name {
  display: block;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.workflow-option-plugins {
  display: flex;
  flex-wrap: wrap;
  gap: 2px;
  margin-top: 2px;
}
.workflow-option-tags {
  display: flex;
  gap: 4px;
  margin-left: 8px;
  flex-shrink: 0;
}
</style>
