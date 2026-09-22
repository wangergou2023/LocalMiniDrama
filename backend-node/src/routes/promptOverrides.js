const promptOverridesService = require('../services/promptOverridesService');
const promptI18n = require('../services/promptI18n');
const response = require('../response');

// 提示词元数据：label / description 在此维护；内容（default_body / locked_suffix）从 promptI18n 动态读取
const PROMPT_META = [
  {
    key: 'story_expansion_system',
    label: '故事生成提示词',
    description: '控制 AI 如何将故事梗概扩写成完整剧本',
  },
  {
    key: 'promo_video_system',
    label: '故事生成提示词',
    description:
      '控制宣传片这条链路里，AI 如何根据梗概/产品信息生成剧本（形态是分幕解说词大纲：每幕含标题、解说词、英文画面描述）。输出格式要求已锁定',
  },
  {
    key: 'storyboard_system',
    label: '分镜拆解提示词（短剧）',
    description: '控制 AI 如何将短剧剧本拆分成分镜头方案（输出格式要求已锁定）',
  },
  {
    key: 'storyboard_system_promo',
    label: '分镜拆解提示词（宣传片）',
    description:
      '控制 AI 如何将宣传片剧本拆分成分镜头方案；只影响宣传片链路，与短剧那份互不覆盖（输出格式要求已锁定）',
  },
  {
    key: 'character_extraction',
    label: '角色提取提示词',
    description: '控制 AI 如何从剧本中提取角色信息（输出格式要求已锁定）',
  },
  {
    key: 'scene_extraction',
    label: '场景提取提示词（短剧）',
    description: '控制 AI 如何从短剧剧本中提取场景背景（风格/比例和输出格式已锁定）',
  },
  {
    key: 'scene_extraction_promo',
    label: '场景提取提示词（宣传片）',
    description:
      '控制 AI 如何从宣传片剧本中提取场景背景；只影响宣传片链路，与短剧那份互不覆盖（风格/比例和输出格式已锁定）',
  },
  {
    key: 'prop_extraction',
    label: '道具提取提示词',
    description: '控制 AI 如何从剧本中提取关键道具（风格/比例和输出格式已锁定）',
  },
  {
    key: 'storyboard_user_suffix',
    label: '分镜输出格式要求',
    description: '追加在分镜拆解用户提示词末尾的详细要素说明（JSON 输出格式已锁定）',
  },
  {
    key: 'first_frame_prompt',
    label: '首帧图像提示词',
    description: '控制 AI 如何生成分镜首帧（动作前静态画面）的图像提示词（风格/比例和 JSON 格式已锁定）',
  },
  {
    key: 'key_frame_prompt',
    label: '关键帧图像提示词',
    description: '控制 AI 如何生成分镜关键帧（动作高潮瞬间）的图像提示词（风格/比例和 JSON 格式已锁定）',
  },
  {
    key: 'last_frame_prompt',
    label: '尾帧图像提示词',
    description: '控制 AI 如何生成分镜尾帧（动作后静态画面）的图像提示词（风格/比例和 JSON 格式已锁定）',
  },
  // 出视频时统一追加的「无人声规则」：独立成条，便于单独修改/清空。
  // 为什么不写进「分镜拆解」：那条默认正文 4000+ 字，而覆盖是整条替换，改一个小规则要复制全文，
  // 很容易把默认正文弄丢；而且本规则要在【出视频时】生效，才能覆盖「手改的 / 导入的」提示词。
  {
    key: 'video_no_speech_rule',
    label: '视频提示词·无人声规则',
    description:
      '出视频时自动追加到提示词末尾的一段硬性约束。默认禁止生成人声（对白/旁白/说话口型），只保留环境音与音效 —— '
      + '因为 H3 的「参考音频」与「首帧」互斥，单图模式无法固定音色，让它念旁白会导致每镜音色不一致；'
      + '旁白统一由合成时的 TTS 配音。提示词里若已有 <d> 角色台词（全能短剧）则不会追加。留空即关闭该行为。',
  },
  // 放在最后：它控制的是「全能提示词」与分镜批量生成里的片段描述规范，属于偏底层的格式约定
  {
    key: 'universal_multi_beat_format',
    label: '片段描述规范（H3 精简格式）',
    description:
      '控制「生成全能提示词」与分镜批量生成里片段描述的结构与硬性规则（<Picture N> 映射行、精简三段、时间推进用中文、台词与画面禁字规则）。按项目画风自动追加的色彩硬规则不可编辑',
  },
];

// 页签归属：决定这条提示词显示在「高级设置（短剧提示词）」还是「高级设置（宣传片提示词）」里。
//   drama  = 只有短剧链路用（剧本扩写、角色提取）
//   promo  = 只有宣传片链路用（宣传片大纲）
//   shared = 两条链路共用（分镜拆解、场景/道具提取、各帧图像提示词等）—— 两个页签都会显示，
//            编辑的是同一条覆盖，改哪边都一样生效
const PROMPT_GROUP = {
  story_expansion_system: 'drama',
  character_extraction: 'drama',
  storyboard_system: 'drama', // 分镜拆解（短剧那份）
  scene_extraction: 'drama', // 场景提取（短剧那份）
  promo_video_system: 'promo',
  storyboard_system_promo: 'promo', // 分镜拆解（宣传片那份）
  scene_extraction_promo: 'promo', // 场景提取（宣传片那份）
  universal_multi_beat_format: 'shared',
  video_no_speech_rule: 'shared', // 出视频时追加的无人声规则：两条链路共用
  storyboard_user_suffix: 'shared',
  prop_extraction: 'shared',
  first_frame_prompt: 'shared',
  key_frame_prompt: 'shared',
  last_frame_prompt: 'shared',
};

// default_body 和 locked_suffix 从 promptI18n 动态读取，确保与运行时提示词始终一致
function getPromptDefinitions() {
  return PROMPT_META.map((m) => ({
    ...m,
    group: PROMPT_GROUP[m.key] || 'shared',
    default_body: promptI18n.getDefaultPromptBody(m.key),
    locked_suffix: promptI18n.getLockedSuffix(m.key),
  }));
}

function routes(db, log) {
  return {
    list: (req, res) => {
      try {
        const defs = getPromptDefinitions();
        const overrides = promptOverridesService.listOverrides(db);
        const overrideMap = {};
        for (const o of overrides) overrideMap[o.key] = o.content;
        const prompts = defs.map((d) => ({
          key: d.key,
          label: d.label,
          description: d.description,
          group: d.group,
          default_body: d.default_body,
          locked_suffix: d.locked_suffix,
          current_body: overrideMap[d.key] || null,
          is_customized: !!overrideMap[d.key],
        }));
        response.success(res, { prompts });
      } catch (err) {
        log.error('prompts list', { error: err.message });
        response.internalError(res, err.message);
      }
    },
    update: (req, res) => {
      const { key } = req.params;
      const { content } = req.body || {};
      const defs = getPromptDefinitions();
      if (!defs.some((d) => d.key === key)) {
        return response.badRequest(res, `未知的提示词 key: ${key}`);
      }
      if (!content || !content.trim()) {
        return response.badRequest(res, 'content 不能为空');
      }
      try {
        promptOverridesService.setOverride(db, key, content.trim());
        promptI18n.setOverrideInMemory(key, content.trim());
        log.info('prompt override updated', { key });
        response.success(res, { ok: true, key });
      } catch (err) {
        log.error('prompts update', { error: err.message });
        response.internalError(res, err.message);
      }
    },
    reset: (req, res) => {
      const { key } = req.params;
      const defs = getPromptDefinitions();
      if (!defs.some((d) => d.key === key)) {
        return response.badRequest(res, `未知的提示词 key: ${key}`);
      }
      try {
        promptOverridesService.deleteOverride(db, key);
        promptI18n.clearOverrideInMemory(key);
        log.info('prompt override reset', { key });
        response.success(res, { ok: true, key });
      } catch (err) {
        log.error('prompts reset', { error: err.message });
        response.internalError(res, err.message);
      }
    },
  };
}

module.exports = { routes, getPromptDefinitions };
