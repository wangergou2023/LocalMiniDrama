# 脚本索引

本仓库的脚本不多（一共 8 个），只是散在三个地方，容易记混。这里按**用途**列一遍：
「什么时候用哪个」「它做了什么」「能不能挪」。

---

## 一、日常入口（放在仓库根目录，别挪 —— 文档里都是按这个路径写的）

| 脚本 | 平台 | 用途 | 它做什么 |
|---|---|---|---|
| `run_dev.sh` | WSL / Linux / macOS | **开发模式**启动 | 起后端（5679，`node --watch` 热重载）+ 前端 Vite（3013 热更新） |
| `run_dev.bat` | Windows | **开发模式**启动 | 先杀掉占用 5679 的旧进程，然后开两个窗口分别跑后端与前端 |
| `run_dev.ps1` | Windows | 同上（PowerShell 版） | 与 `run_dev.bat` 等价 |
| `打包-Windows.bat` | Windows | **打 Windows 安装包** | 构建前端 → 复制到 desktop → 体检 Windows 原生依赖 → electron-builder 出 `LocalMiniDrama-Setup-x.x.x.exe` |

> 被引用情况：`run_dev.*` 三个在 `README.md`、`docs/quickstart.md`、`docs/en.md`、`CONTRIBUTING.md` 里都有引用，
> **挪动就会让文档里的命令失效**，所以保持在根目录。

---

## 二、辅助脚本（`scripts/`）

| 脚本 | 平台 | 用途 | 备注 |
|---|---|---|---|
| `run_local.bat` | Windows | **本地运行（不安装）** | 构建前端后由后端单端口 5679 提供页面，形态更接近正式发布。原来的文件名是 `start-test.bat`，名字不达意，已改名 |
| `build-windows-legacy.sh` | WSL / Linux | 旧的 Windows 打包脚本 | ⚠️ **已被 `打包-Windows.bat` 取代**，保留仅作参考 |

`run_dev.bat`（开发模式，Vite 5173 热更新）与 `run_local.bat`（构建后单端口 5679）的区别就在这里，
按需要选一个。

---

## 三、打包内部步骤（`desktop/`，**不要挪** —— 全部被 `desktop/package.json` 引用）

| 脚本 | 用途 |
|---|---|
| `desktop/scripts/copy-front.js` | 把 `frontweb/dist` 复制成 `desktop/frontweb-dist` |
| `desktop/scripts/copy-backend.js` | 把 `backend-node/{src,configs,scripts,migrations}` 复制成 `desktop/backend-app`，并合并初始迁移 |
| `desktop/scripts/clean-win-unpacked.js` | 打包前清理 `release/win-unpacked` |
| `desktop/scripts/dist-cn.js` | 设好国内镜像后执行完整打包（`npm run dist:cn`） |
| `desktop/dist-cn.bat` | 上面的双击入口 |
| `desktop/dist-mac.sh` | macOS 打包（完整版 + 纯净版 DMG） |

它们由 `desktop/package.json` 的 npm 脚本调用（`prestart` / `copy-front` / `prepare-backend` /
`clean:unpacked` / `dist:cn` / `dist:mac`），**移动任何一个都会让打包失败**。

---

## 四、其它常用命令（不在本目录，但更常用）

```bash
# 后端（backend-node）
npm run start      # 起服务
npm run dev        # 起服务 + 热重载
npm run migrate    # 手动跑数据库迁移（正常启动时会自动跑，一般用不到）

# 前端（frontweb）
npm run build      # 构建到 frontweb/dist（改了前端代码必须跑，5679 页面才会更新）
npm run dev        # Vite 开发服务器

# 测试（两个子项目各自跑）
cd backend-node && node --test test/*.test.js
cd frontweb     && node --test test/*.test.js
```

---

## 五、整理记录

- `start-test.bat` → `scripts/run_local.bat`（改名 + 说明；原本无名引用，移动安全）
- `build-exe.sh` → `scripts/build-windows-legacy.sh`（已被 `打包-Windows.bat` 取代，标注保留）
- 删掉了 `backend-node/package.json` 里失效的 `migrate:07` 脚本 —— 它指向的
  `backend-node/scripts/run-migration-07.js` 已经不存在了（`backend-node/scripts/` 整个目录都没有，
  但打包脚本仍会去复制它，属于历史残留）
