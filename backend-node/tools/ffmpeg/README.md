# FFmpeg 本地目录

将 ffmpeg 可执行文件放在此目录下，后端会优先使用，**无需配置环境变量**。

## 需要拷贝的文件（Windows）

- `ffmpeg.exe`
- `ffprobe.exe`（若需要探测时长等信息）

从 FFmpeg 官方构建目录的 `bin` 下复制到本目录即可。

## 一键拷贝（可选）

若你的 ffmpeg 在 `D:\Program Files\ffmpeg-8.0.1-essentials_build\bin`，可在 **backend-node** 目录下执行：

```bash
node scripts/copy-ffmpeg.js "D:\Program Files\ffmpeg-8.0.1-essentials_build\bin"
```

会复制 `ffmpeg.exe` 和 `ffprobe.exe` 到本目录。

## 需要拷贝的文件（Linux / macOS / WSL）

要点：**文件名不带 `.exe`**，且必须是当前系统能执行的二进制。
容器里常见的情况是本目录只有 `ffmpeg.exe`（Windows 的 PE 格式），Linux 上执行不了，
后端会判定为「没有 ffmpeg」，视频合成就只回退成第一条片段（成片长度 = 第一镜）。

```bash
# 推荐：从 npm 拉静态构建（二进制在 tarball 里，不走 GitHub 下载）
npm i --no-save --prefix /tmp/ffbin @ffmpeg-installer/linux-x64 @ffprobe-installer/linux-x64
cp /tmp/ffbin/node_modules/@ffmpeg-installer/linux-x64/ffmpeg  tools/ffmpeg/ffmpeg
cp /tmp/ffbin/node_modules/@ffprobe-installer/linux-x64/ffprobe tools/ffmpeg/ffprobe
chmod +x tools/ffmpeg/ffmpeg tools/ffmpeg/ffprobe
```

`@ffmpeg-installer` 给的是较老的静态构建（如 N-47683），但已包含 `libx264` 与 `libaom-av1`，
拼接（`-c copy`）与常规转码都够用。

`.gitignore` 里已忽略这两个文件名（各 60~76MB），不会误入库。

## 怎么确认装好了

```bash
node -e "const p=require('./src/utils/ffmpegPath'); console.log(p.hasLocalFfmpeg(), p.getFfmpegPath())"
# 期望输出: true /home/.../backend-node/tools/ffmpeg/ffmpeg
```

合成日志里也会打印：`Video merge: ffmpeg check {"has_ffmpeg":true,...}`。
若为 `false`，合成的成片会变成第一条片段的长度（例如 10 秒）。

## 路径优先级

1. 本目录下的 `ffmpeg`（或 Windows 下 `ffmpeg.exe`）
2. 环境变量 `FFMPEG_PATH`（若已设置）
3. 系统 PATH 中的 `ffmpeg`
