const response = require('../response');
const storyboardLibraryService = require('../services/storyboardLibraryService');

function routes(db, cfg, log) {
  return {
    list: (req, res) => {
      try {
        const query = {
          page: req.query.page,
          page_size: req.query.page_size,
          drama_id: req.query.drama_id,
          global: req.query.global,
          category: req.query.category,
          source_type: req.query.source_type,
          source_id: req.query.source_id,
          source_ids: req.query.source_ids,
          keyword: req.query.keyword,
        };
        const { items, total, page, pageSize } = storyboardLibraryService.listLibraryItems(db, query);
        response.successWithPagination(res, items, total, page, pageSize);
      } catch (err) {
        log.error('storyboard-library list', { error: err.message });
        response.internalError(res, err.message);
      }
    },
    create: (req, res) => {
      try {
        const item = storyboardLibraryService.createLibraryItem(db, log, req.body || {});
        response.created(res, item);
      } catch (err) {
        log.error('storyboard-library create', { error: err.message });
        response.internalError(res, err.message);
      }
    },
    get: (req, res) => {
      try {
        const item = storyboardLibraryService.getLibraryItem(db, req.params.id);
        if (!item) return response.notFound(res, '分镜参考图不存在');
        response.success(res, item);
      } catch (err) {
        log.error('storyboard-library get', { error: err.message });
        response.internalError(res, err.message);
      }
    },
    update: (req, res) => {
      try {
        const item = storyboardLibraryService.updateLibraryItem(db, log, req.params.id, req.body || {});
        if (!item) return response.notFound(res, '分镜参考图不存在');
        response.success(res, item);
      } catch (err) {
        log.error('storyboard-library update', { error: err.message });
        response.internalError(res, err.message);
      }
    },
    delete: (req, res) => {
      try {
        const ok = storyboardLibraryService.deleteLibraryItem(db, log, req.params.id);
        if (!ok) return response.notFound(res, '分镜参考图不存在');
        response.success(res, { message: '删除成功' });
      } catch (err) {
        log.error('storyboard-library delete', { error: err.message });
        response.internalError(res, err.message);
      }
    },
  };
}

module.exports = routes;
