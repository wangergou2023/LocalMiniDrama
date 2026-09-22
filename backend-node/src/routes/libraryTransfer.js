'use strict';
/**
 * 素材库的导入 / 导出处理函数（角色 / 场景 / 道具 / 分镜 四类共用）。
 *
 *   GET  /api/v1/library/:kind/export   → 下载一个 zip（library.json + images/）
 *   POST /api/v1/library/:kind/import   → 上传该 zip（multipart，字段名 file）
 *
 * kind 取值：character | scene | prop | storyboard
 * 与其它路由模块保持一致：返回 handler 对象，由 routes/index.js 的统一 router 注册
 * （本仓库用的是单一 express.Router + handler 对象，不嵌套 router）。
 */
const path = require('path');
const response = require('../response');
const transfer = require('../services/libraryTransferService');

function getStorageRoot(cfg) {
  return path.isAbsolute(cfg?.storage?.local_path)
    ? cfg.storage.local_path
    : path.join(process.cwd(), cfg?.storage?.local_path || './data/storage');
}

function libraryTransferRoutes(db, cfg, log) {
  return {
    exportLibrary: (req, res) => {
      try {
        const kind = String(req.params.kind || '').toLowerCase();
        if (!transfer.getLib(kind)) return response.badRequest(res, '未知的素材库类型：' + kind);
        const r = transfer.exportLibrary(db, log, kind, getStorageRoot(cfg));
        if (!r.ok) return response.badRequest(res, r.error);
        res.setHeader('Content-Type', 'application/zip');
        res.setHeader('Content-Disposition', `attachment; filename*=UTF-8''${encodeURIComponent(r.filename)}`);
        res.setHeader('X-Export-Count', String(r.count));
        return res.send(r.buffer);
      } catch (e) {
        log.error('library export failed', { error: e.message });
        return response.internalError(res, '导出失败：' + e.message);
      }
    },

    importLibrary: (req, res) => {
      try {
        const kind = String(req.params.kind || '').toLowerCase();
        if (!transfer.getLib(kind)) return response.badRequest(res, '未知的素材库类型：' + kind);
        const file = req.file;
        if (!file || !file.buffer) return response.badRequest(res, '没有收到文件');
        const r = transfer.importLibrary(db, log, kind, file.buffer, getStorageRoot(cfg));
        if (!r.ok) return response.badRequest(res, r.error);
        return response.success(res, r);
      } catch (e) {
        log.error('library import failed', { error: e.message });
        return response.internalError(res, '导入失败：' + e.message);
      }
    },
  };
}

module.exports = { libraryTransferRoutes };
