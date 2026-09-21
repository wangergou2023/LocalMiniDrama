const taskService = require('../services/taskService');
const videoService = require('../services/videoService');
const response = require('../response');

function getTaskStatus(db, log) {
  return (req, res) => {
    const task = taskService.getTask(db, req.params.task_id);
    if (!task) return response.notFound(res, '任务不存在');
    response.success(res, task);
  };
}

function getResourceTasks(db, log) {
  return (req, res) => {
    // 批量优先：resource_ids=1,2,3 一次取回多个资源的任务。
    // 前端任务同步原本为每个角色/道具/场景各打一次这个接口（实测 30 次/轮 × 4 秒定时器），
    // 单秒峰值 61 次请求；批量参数让每轮只发 1 次。resource_id 单值形式保持兼容。
    const rawIds = req.query.resource_ids;
    if (rawIds != null && String(rawIds).trim() !== '') {
      const ids = String(rawIds).split(',').map((s) => s.trim()).filter(Boolean);
      if (ids.length > 2000) return response.badRequest(res, 'resource_ids 数量过多（上限 2000）');
      try {
        const tasks = taskService.getTasksByResources(db, ids);
        return response.success(res, tasks);
      } catch (err) {
        log.errorw('Get resource tasks failed', { error: err.message, mode: 'batch', count: ids.length });
        return response.internalError(res, err.message);
      }
    }

    const resourceId = req.query.resource_id;
    if (!resourceId) return response.badRequest(res, '缺少resource_id参数');
    try {
      const tasks = taskService.getTasksByResource(db, resourceId);
      response.success(res, tasks);
    } catch (err) {
      log.errorw('Get resource tasks failed', { error: err.message });
      response.internalError(res, err.message);
    }
  };
}

function cancelTaskStatus(db, log) {
  return async (req, res) => {
    try {
      // 视频任务：先取消上游（ComfyUI 运行中中断 / 排队中出队），再标记本地任务状态。
      // 以前只改数据库，用户点了取消 ComfyUI 那边照样把整批视频跑完。
      const videoCancel = await videoService.cancelVideoGenerationByTask(
        db,
        log,
        req.params.task_id,
        req.body?.reason
      );
      if (videoCancel && videoCancel.ok) {
        log.info('取消任务：上游处理结果', {
          task_id: req.params.task_id,
          upstream_cancelled: !!videoCancel.upstream,
          skipped: !!videoCancel.skipped,
        });
      }
      const result = taskService.cancelTask(db, log, req.params.task_id, req.body?.reason);
      if (!result.ok && result.reason === 'not_found') {
        return response.notFound(res, '任务不存在');
      }
      // 把上游取消结果一并返回：云端 MiniMax H3 只能取消排队中的任务，
      // 运行中官方不允许取消 —— 让调用方/界面能如实告知用户。
      response.success(res, {
        ...(result.task || { id: req.params.task_id }),
        upstream_cancel: videoCancel
          ? {
              attempted: true,
              cancelled: !!videoCancel.upstream,
              skipped: !!videoCancel.skipped,
              error: videoCancel.error || null,
            }
          : { attempted: false },
      });
    } catch (err) {
      log.errorw('Cancel task failed', { error: err.message, task_id: req.params.task_id });
      response.internalError(res, err.message);
    }
  };
}

module.exports = function taskRoutes(db, log) {
  return {
    getTaskStatus: getTaskStatus(db, log),
    getResourceTasks: getResourceTasks(db, log),
    cancelTaskStatus: cancelTaskStatus(db, log),
  };
};
