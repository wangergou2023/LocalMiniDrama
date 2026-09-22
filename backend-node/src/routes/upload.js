const path = require('path');
const multer = require('multer');
const response = require('../response');
const uploadService = require('../services/uploadService');
const storageLayout = require('../services/storageLayout');

const allowedTypes = ['image/jpeg', 'image/jpg', 'image/png', 'image/gif', 'image/webp'];
const maxSize = 16 * 1024 * 1024; // 16MB，单张图片上限
const MAX_SIZE_MB = 16;

const memoryStorage = multer.memoryStorage();
const upload = multer({
  storage: memoryStorage,
  limits: { fileSize: maxSize },
  fileFilter: (req, file, cb) => {
    const ct = file.mimetype || 'application/octet-stream';
    if (!allowedTypes.includes(ct)) {
      return cb(new Error('只支持图片格式 (jpg, png, gif, webp)'));
    }
    cb(null, true);
  },
});

// 素材库导入用的 zip 上传：素材包常有几十 MB，单独给一份限制与过滤器
const zipMaxSize = 1024 * 1024 * 1024; // 1GB
const zipUpload = multer({
  storage: memoryStorage,
  limits: { fileSize: zipMaxSize },
  fileFilter: (req, file, cb) => {
    const ct = file.mimetype || 'application/octet-stream';
    const isZip = /zip/i.test(ct) || /\.zip$/i.test(file.originalname || '');
    if (!isZip) return cb(new Error('只支持 .zip 素材包（请使用「导出素材」生成的文件）'));
    cb(null, true);
  },
});

const allowedVideoTypes = [
  'video/mp4',
  'video/webm',
  'video/quicktime',
  'video/x-msvideo',
  'video/x-matroska',
  'video/mpeg',
];
const videoMaxSize = 500 * 1024 * 1024; // 500MB
const videoUpload = multer({
  storage: memoryStorage,
  limits: { fileSize: videoMaxSize },
  fileFilter: (req, file, cb) => {
    const ct = file.mimetype || 'application/octet-stream';
    if (!allowedVideoTypes.includes(ct)) {
      return cb(new Error('只支持视频格式 (mp4, webm, mov, avi, mkv)'));
    }
    cb(null, true);
  },
});

function routes(cfg, log, db) {
  const singleUpload = upload.single('file');
  return {
    multerSingle: singleUpload,
    uploadImage: (req, res) => {
      if (!req.file || !req.file.buffer) {
        return response.badRequest(res, '请选择文件');
      }
      try {
        const rawStorage = cfg?.storage?.local_path || './data/storage';
        const storagePath = path.isAbsolute(rawStorage)
          ? rawStorage
          : path.join(process.cwd(), rawStorage);
        const baseUrl = cfg?.storage?.base_url || '';
        let projectSubdir = null;
        if (db) {
          const raw = req.body?.drama_id;
          const did =
            raw !== undefined && raw !== null && String(raw).trim() !== ''
              ? Number(raw)
              : NaN;
          if (Number.isFinite(did) && did > 0) {
            projectSubdir = storageLayout.getProjectStorageSubdir(db, did);
          }
        }
        const result = uploadService.uploadFile(
          storagePath,
          baseUrl,
          log,
          req.file.buffer,
          req.file.originalname || 'image.png',
          req.file.mimetype,
          'uploads',
          projectSubdir
        );
        response.success(res, {
          url: result.url,
          path: result.local_path,
          local_path: result.local_path,
          filename: req.file.originalname,
          size: req.file.size,
        });
      } catch (err) {
        log.error('upload image', { error: err.message });
        response.internalError(res, err.message || '上传失败');
      }
    },
  };
}

module.exports = {
  routes,
  upload,
  multerSingle: upload.single('file'),
  multerVideoSingle: videoUpload.single('file'),
  multerZipSingle: zipUpload.single('file'),
  MAX_IMAGE_SIZE_MB: MAX_SIZE_MB,
};
