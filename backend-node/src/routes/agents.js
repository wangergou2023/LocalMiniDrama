'use strict';
/**
 * Agent 三层路由。
 *
 *   GET  /api/v1/agents                      角色清单（含各角色工具白名单）
 *   GET  /api/v1/agents/:agentId/tools       某角色实际可用的工具
 *   POST /api/v1/agents/:agentId/run        跑一个角色
 *        body: { episode_id, storyboard_ids?, instruction? }
 *        - read 层 → 返回 report（打分/违规/断裂），**不写任何数据**
 *        - write 层 → 返回 suggestions（含 before/after，供前端 diff），**同样不写**
 *        - orchestrate 层 → 返回 final + 工具调用记录
 *   POST /api/v1/agents/apply               把确认过的建议落库（**不再调用 LLM**）
 *        body: { agent_id?, suggestions:[{storyboard_id, field, after}] }
 *
 * 注意：本文件未在 routes/index.js 里注册时不会生效（注册那一步要改现有文件，
 * 会触发 node --watch 重载，故等没有渲染任务时再补）。
 */

const response = require('../response');
const { listAgents, getAgent, LAYERS } = require('../services/agents/agentRegistry');
const { toolsForAgent } = require('../services/agents/agentTools');
const { runAgent, applySuggestions } = require('../services/agents/agentRunner');

module.exports = function agentRoutes(db, cfg, log) {
  return {
    list: (req, res) => {
      try {
        response.success(res, {
          layers: Object.values(LAYERS),
          agents: listAgents().map((a) => ({ ...a, tools: toolsForAgent(a.id) })),
        });
      } catch (err) {
        log.error('agents list', { error: err.message });
        response.internalError(res, err.message);
      }
    },

    tools: (req, res) => {
      try {
        const agent = getAgent(req.params.agentId);
        if (!agent) return response.notFound(res, '角色不存在');
        response.success(res, { agent_id: agent.id, layer: agent.layer, tools: toolsForAgent(agent.id) });
      } catch (err) {
        log.error('agents tools', { error: err.message });
        response.internalError(res, err.message);
      }
    },

    run: async (req, res) => {
      try {
        const agentId = String(req.params.agentId || '').trim();
        if (!getAgent(agentId)) return response.notFound(res, '角色不存在');
        const body = req.body || {};
        const out = await runAgent(db, log, {
          agentId,
          episodeId: body.episode_id,
          storyboardIds: Array.isArray(body.storyboard_ids) ? body.storyboard_ids : undefined,
          instruction: body.instruction,
        });
        if (!out.ok) return response.badRequest(res, out.error || '执行失败');
        response.success(res, out);
      } catch (err) {
        log.error('agents run', { error: err.message });
        response.internalError(res, err.message);
      }
    },

    apply: async (req, res) => {
      try {
        const body = req.body || {};
        const suggestions = Array.isArray(body.suggestions) ? body.suggestions : [];
        if (!suggestions.length) return response.badRequest(res, 'suggestions 不能为空');
        const out = await applySuggestions(db, log, { agentId: body.agent_id || 'optimizer', suggestions });
        response.success(res, out);
      } catch (err) {
        log.error('agents apply', { error: err.message });
        response.internalError(res, err.message);
      }
    },
  };
};
