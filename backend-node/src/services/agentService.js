// AI 导演助手 - 后端 Agent 核心
// 职责:接收对话,用配置的文本模型(带工具调用)循环执行工具,SSE 流式返回。
const aiClient = require('./aiClient');
const imageService = require('./imageService');
const qcService = require('./qcService');

// ---- 工具定义(OpenAI tools 格式) ----
function buildTools() {
  return [
    { type: 'function', function: { name: 'list_storyboards', description: '列出某剧集的分镜清单(含有无已完成图)', parameters: { type: 'object', properties: { episode_id: { type: 'integer', description: '剧集ID' } }, required: ['episode_id'] } } },
    { type: 'function', function: { name: 'generate_storyboard_image', description: '为单个分镜生成参考图(用角色/场景/道具参考,公司网关)', parameters: { type: 'object', properties: { storyboard_id: { type: 'integer' } }, required: ['storyboard_id'] } } },
    { type: 'function', function: { name: 'generate_all_storyboard_images', description: '为剧集内所有尚无图的分镜批量/逐个生成参考图', parameters: { type: 'object', properties: { episode_id: { type: 'integer' } }, required: ['episode_id'] } } },
    { type: 'function', function: { name: 'qc_storyboard_image', description: '质检某分镜最新生成的参考图(视觉模型打分,低分说明需重生成)', parameters: { type: 'object', properties: { storyboard_id: { type: 'integer' } }, required: ['storyboard_id'] } } },
    { type: 'function', function: { name: 'get_task', description: '查询异步任务状态', parameters: { type: 'object', properties: { task_id: { type: 'string' } }, required: ['task_id'] } } },
    { type: 'function', function: { name: 'list_tasks', description: '列出最近的异步任务', parameters: { type: 'object', properties: { limit: { type: 'integer' } } } } },
  ];
}

async function callTool(db, log, name, args) {
  const a = args || {};
  try {
    switch (name) {
      case 'list_storyboards': {
        const rows = db.prepare("SELECT id, storyboard_number, title, shot_type, image_prompt FROM storyboards WHERE episode_id=? AND deleted_at IS NULL ORDER BY storyboard_number").all(Number(a.episode_id));
        return { ok: true, data: rows.map(r => ({ ...r, has_image: !!db.prepare("SELECT id FROM image_generations WHERE storyboard_id=? AND status='completed' AND deleted_at IS NULL").get(r.id) })) };
      }
      case 'generate_storyboard_image': {
        const sb = db.prepare("SELECT sb.id, sb.episode_id, ep.drama_id FROM storyboards sb JOIN episodes ep ON ep.id = sb.episode_id WHERE sb.id=?").get(Number(a.storyboard_id));
        if (!sb) return { ok: false, error: '分镜不存在' };
        const ig = imageService.create(db, log, { drama_id: sb.drama_id, storyboard_id: sb.id, prompt: (db.prepare('SELECT image_prompt FROM storyboards WHERE id=?').get(sb.id) || {}).image_prompt || 'cinematic scene', provider: 'openai' });
        return { ok: true, data: { image_generation_id: ig.id, task_id: ig.task_id, status: ig.status } };
      }
      case 'generate_all_storyboard_images': {
        const ids = db.prepare(`SELECT id FROM storyboards WHERE episode_id=? AND deleted_at IS NULL AND NOT EXISTS (SELECT 1 FROM image_generations ig WHERE ig.storyboard_id=storyboards.id AND ig.status='completed' AND ig.deleted_at IS NULL)`).all(Number(a.episode_id));
        let submitted = 0;
        for (const r of ids) {
          const sbd = db.prepare('SELECT ep.drama_id FROM storyboards sb JOIN episodes ep ON ep.id = sb.episode_id WHERE sb.id=?').get(r.id);
          try { imageService.create(db, log, { drama_id: sbd?.drama_id, storyboard_id: r.id, prompt: (db.prepare('SELECT image_prompt FROM storyboards WHERE id=?').get(r.id) || {}).image_prompt || 'cinematic scene', provider: 'openai' }); submitted++; } catch (e) { log.warn('gen_all skip', { id: r.id, e: e.message }); }
        }
        return { ok: true, data: { need: ids.length, submitted } };
      }
      case 'qc_storyboard_image': {
        const ig = db.prepare("SELECT id, local_path, image_url, prompt FROM image_generations WHERE storyboard_id=? AND status='completed' AND deleted_at IS NULL ORDER BY id DESC LIMIT 1").get(Number(a.storyboard_id));
        if (!ig) return { ok: false, error: '该分镜无已完成图,请先生成' };
        const img = ig.local_path || ig.image_url;
        const res = await qcService.qcImage(db, log, { image: img, prompt: ig.prompt || '' });
        return { ok: true, data: res };
      }
      case 'get_task': {
        const t = db.prepare('SELECT id,type,status,progress,message,error FROM async_tasks WHERE id=?').get(String(a.task_id));
        return { ok: !!t, data: t || null };
      }
      case 'list_tasks': {
        const rows = db.prepare('SELECT id,type,status,message,updated_at FROM async_tasks ORDER BY updated_at DESC LIMIT ?').all(Math.min(Number(a.limit) || 10, 30));
        return { ok: true, data: rows };
      }
      default:
        return { ok: false, error: '未知工具: ' + name };
    }
  } catch (e) {
    log.error('AGENT tool error', { name, error: e.message });
    return { ok: false, error: e.message };
  }
}

function buildUserPromptForState(history) {
  // 把最近对话压缩成系统提示(agent 职责说明)
  const lastUser = [...history].reverse().find(m => m.role === 'user');
  return `你是「AI 导演」助手,负责用工具驱动 LocalMiniDrama 生产短剧。规则:
1. 用户要"出图/生成图片",应调用 generate_all_storyboard_images(按剧集)或 generate_storyboard_image(单分镜)。
2. 生成后可选调用 qc_storyboard_image 质检;质检 ok=false 时,建议再生成(你可以直接再调 generate_storyboard_image)。
3. 涉及视频(MiniMax)的操作需先向用户确认,这里仅提示"需用户确认",不要触发。
4. 使用中文简洁回复。用户刚说的: ${lastUser ? lastUser.content : '(无)'}`;
}

// 主循环:用文本模型跑工具调用,SSE 输出事件
async function chat(db, log, cfg, req, res) {
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.flushHeaders && res.flushHeaders();
  const send = (obj) => { try { res.write('data: ' + JSON.stringify(obj) + '\n\n'); } catch (_) {} };

  const config = aiClient.getDefaultConfig(db, 'text');
  if (!config) { send({ type: 'message', text: '未配置文本模型,请先在「AI 配置」添加文本模型' }); send({ type: 'done' }); return res.end(); }
  const base = (config.base_url || '').replace(/\/$/, '');
  const url = base + '/chat/completions';
  const model = (Array.isArray(config.model) ? config.model[0] : config.model) || 'gpt-4o';
  const apiKey = config.api_key || '';

  let messages = [
    { role: 'system', content: buildUserPromptForState(req.body?.messages || []) },
    ...(req.body?.messages || []).filter(m => m.role === 'user' || m.role === 'assistant').map(m => ({ role: m.role, content: m.content })).slice(-12),
  ];

  const MAX_ROUNDS = 10;
  try {
    for (let round = 0; round < MAX_ROUNDS; round++) {
      const r = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + apiKey }, body: JSON.stringify({ model, messages, tools: buildTools(), tool_choice: 'auto', temperature: 0.6 }) });
      const j = await r.json().catch(() => ({}));
      if (!r.ok) { send({ type: 'message', text: `AI 调用失败: HTTP ${r.status} ${(j.error?.message || j.error || '').slice(0,200)}` }); break; }
      const choice = j.choices?.[0];
      const msg = choice?.message || {};
      const toolCalls = msg.tool_calls || [];
      if (toolCalls.length === 0) {
        const content = msg.content || '';
        if (content) { send({ type: 'message', text: content }); }
        break;
      }
      // 执行工具
      messages.push({ role: 'assistant', content: msg.content || '', tool_calls: toolCalls });
      for (const tc of toolCalls) {
        const fn = tc.function;
        send({ type: 'tool_call', name: fn.name, argPreview: (fn.arguments || '').slice(0, 80) });
        let result;
        try { result = await callTool(db, log, fn.name, JSON.parse(fn.arguments || '{}')); }
        catch (e) { result = { ok: false, error: e.message }; }
        send({ type: 'tool_result', name: fn.name, ok: !!result.ok, summary: result.ok ? summarize(result.data) : (result.error || '失败'), data: result.data });
        messages.push({ role: 'tool', tool_call_id: tc.id, content: JSON.stringify(result.data || { error: result.error }), name: fn.name });
      }
    }
  } catch (e) {
    send({ type: 'message', text: 'agent 异常: ' + e.message });
  }
  send({ type: 'done' });
  res.end();
}

function summarize(data) {
  if (data == null) return '完成';
  if (Array.isArray(data)) return `${data.length} 条`;
  if (typeof data === 'object') {
    const parts = [];
    if (data.need != null) parts.push(`待生成 ${data.need}`);
    if (data.submitted != null) parts.push(`已提交 ${data.submitted}`);
    if (data.image_generation_id != null) parts.push(`图任务 #${data.image_generation_id}`);
    if (data.status) parts.push(data.status);
    if (data.score != null) parts.push(`质检 ${data.score}/100 ${data.ok ? '通过' : '未通过'}`);
    return parts.join(' · ') || '完成';
  }
  return String(data).slice(0, 80);
}

// 质检接口(独立调用)
async function qc(db, log, cfg, req, res) {
  const b = req.body || {};
  try {
    const r = await qcService.qcImage(db, log, { image: b.image, prompt: b.prompt || '', expect: b.expect || '' });
    res.json({ success: true, data: r });
  } catch (e) {
    res.json({ success: false, error: { message: e.message } });
  }
}

module.exports = { chat, qc, buildTools, callTool };
