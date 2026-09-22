-- 分镜参考图库：把满意的分镜图存成素材，供后续复用（设为某个分镜的主图/参考图）
-- 结构对齐 prop_libraries / scene_libraries；drama_id 允许按剧隔离，分镜参考图一般存全局（NULL）
CREATE TABLE IF NOT EXISTS storyboard_libraries (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  drama_id INTEGER,
  name TEXT NOT NULL DEFAULT '',
  description TEXT,
  prompt TEXT,
  narration TEXT,
  image_url TEXT,
  local_path TEXT,
  category TEXT,
  tags TEXT,
  source_type TEXT,
  source_id TEXT,
  created_at TEXT,
  updated_at TEXT,
  deleted_at TEXT
);

CREATE INDEX IF NOT EXISTS idx_storyboard_libraries_drama ON storyboard_libraries(drama_id);
CREATE INDEX IF NOT EXISTS idx_storyboard_libraries_source ON storyboard_libraries(source_type, source_id);
