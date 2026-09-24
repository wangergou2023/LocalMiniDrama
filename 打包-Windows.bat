@echo off
chcp 65001 >nul
setlocal enabledelayedexpansion
title LocalMiniDrama 一键打包（Windows）

REM ============================================================
REM  本地短剧助手 - Windows 安装包一键打包
REM
REM  用法：把本文件放在仓库根目录，双击运行即可。
REM  它会依次：
REM    1) 检查 Node（没有会给出下载地址）
REM    2) 显示即将打包的分支/提交/版本号（确认没打错代码）
REM    3) 构建前端（frontweb）
REM    4) 准备桌面端依赖（desktop）—— 会检查是否为 Windows 原生依赖
REM    5) 用国内镜像执行 electron-builder，产出安装包与便携版
REM  产物：desktop\release\LocalMiniDrama-Setup-<版本>.exe （安装包）
REM        desktop\release\LocalMiniDrama <版本>.exe       （便携版）
REM ============================================================

cd /d "%~dp0"

echo.
echo ============================================================
echo   本地短剧助手 - Windows 打包
echo ============================================================
echo   仓库目录：%CD%
echo.

REM ---------- 1. 检查 Node ----------
where node >nul 2>nul
if errorlevel 1 (
  echo [错误] 没有找到 Node.js。
  echo.
  echo   请先安装 Node.js 20 或更高版本：https://nodejs.org/zh-cn/download
  echo   安装后重新双击本脚本即可。
  echo.
  pause
  exit /b 1
)
for /f "delims=" %%v in ('node -v') do set NODEVER=%%v
echo [1/5] Node 版本：!NODEVER!
where npm >nul 2>nul
if errorlevel 1 (
  echo [错误] 找到了 node 但没有 npm，请重新安装 Node.js。
  pause
  exit /b 1
)

REM ---------- 2. 显示代码版本（防止打错分支） ----------
echo.
echo [2/5] 即将打包的代码：
where git >nul 2>nul
if not errorlevel 1 (
  for /f "delims=" %%b in ('git rev-parse --abbrev-ref HEAD 2^>nul') do set GITBRANCH=%%b
  for /f "delims=" %%c in ('git log -1 --format^=%%h %%s 2^>nul') do set GITCOMMIT=%%c
  echo       分支：!GITBRANCH!
  echo       提交：!GITCOMMIT!
) else (
  echo       （未检测到 git，跳过代码版本检查）
)
if not exist "desktop\package.json" (
  echo.
  echo [错误] 当前目录不像仓库根目录：找不到 desktop\package.json
  echo        请把本脚本放在仓库根目录（与 frontweb、backend-node 同级）再运行。
  pause
  exit /b 1
)
REM 用 node 读版本号（比 findstr 抠 json 可靠得多）
for /f "delims=" %%v in ('node -p "require('./desktop/package.json').version"') do set VER=%%v
echo       版本号：!VER!   （安装包将命名为 LocalMiniDrama-Setup-!VER!.exe）
echo.
echo       确认无误后按任意键继续；要取消请直接关掉本窗口。
pause >nul

REM ---------- 3. 构建前端 ----------
echo.
echo [3/5] 构建前端...
if not exist "frontweb\node_modules" (
  echo       首次运行，安装前端依赖（可能要几分钟）...
  REM 前端【不能】加 --ignore-scripts：esbuild / vite 靠安装脚本放置自己的二进制
  pushd frontweb
  call npm install --no-audit --no-fund
  if errorlevel 1 ( popd & echo [错误] 前端依赖安装失败。 & pause & exit /b 1 )
  popd
)
pushd frontweb
call npm run build
if errorlevel 1 ( popd & echo [错误] 前端构建失败。 & pause & exit /b 1 )
popd
echo       前端构建完成。

REM ---------- 4. 准备桌面端依赖（必须是 Windows 原生） ----------
echo.
echo [4/5] 准备桌面端依赖...
set NEED_DESKTOP_INSTALL=0
if not exist "desktop\node_modules\electron-builder" set NEED_DESKTOP_INSTALL=1
REM 关键：如果是别处（例如 WSL/Linux）装好拷过来的，原生模块会是 Linux 版，
REM 打出来的包在 Windows 上加载不了 sharp / better-sqlite3。这里做一次体检。
if not exist "desktop\node_modules\@img\sharp-win32-x64" set NEED_DESKTOP_INSTALL=1
if "!NEED_DESKTOP_INSTALL!"=="1" (
  echo       安装 / 修复桌面端依赖（Windows 原生版）...
  pushd desktop
  REM 关键：加 --ignore-scripts。
  REM better-sqlite3 自带各平台【N-API 预编译】（prebuilds\win32-x64.node），
  REM 不需要现场编译；但它带 binding.gyp 又没有 install 脚本，npm 的历史默认行为会
  REM 自动跑 node-gyp rebuild —— 那就要 Python 3 + Visual Studio C++ 生成工具（好几个 GB），
  REM 缺了就会以 EPERM / gyp ERR! find Python 失败，整个安装中断。
  REM 加 --ignore-scripts 后：2 秒装完，直接可用（已实测）。
  call npm install --ignore-scripts --no-audit --no-fund
  if errorlevel 1 (
    popd
    echo.
    echo       首次安装失败 —— 可能是上一次装坏留下的残留（EPERM/文件被占用）。
    echo       正在清掉 desktop\node_modules 后重试一次...
    rmdir /s /q "node_modules" 2>nul
    pushd desktop
    call npm install --ignore-scripts --no-audit --no-fund
    if errorlevel 1 ( popd & echo [错误] 桌面端依赖仍然装不上，请把上面的报错发出来。 & pause & exit /b 1 )
    popd
  )
  popd
)
if not exist "desktop\node_modules\@img\sharp-win32-x64" (
  echo.
  echo [警告] 仍未检测到 Windows 版 sharp（@img\sharp-win32-x64）。
  echo        如果继续打包，成片里用到图片处理的地方可能报错。
  echo        建议先删除 desktop\node_modules 后重跑本脚本。
  echo.
  pause
)
echo       桌面端依赖就绪。

REM ---------- 5. 打包 ----------
echo.
echo [5/5] 打包（用国内镜像下载 electron，首次约需几分钟）...
pushd desktop
call npm run dist:cn
set BUILD_RC=%ERRORLEVEL%
popd

echo.
if not "%BUILD_RC%"=="0" (
  echo ============================================================
  echo   打包失败（退出码 %BUILD_RC%）
  echo   常见原因：
  echo     - 网络中断（可重跑本脚本，会续用已下载的缓存）
  echo     - 杀毒软件拦截 electron-builder 写入 exe
  echo     - Node 版本过低（建议 20+）
  echo ============================================================
  pause
  exit /b %BUILD_RC%
)

echo ============================================================
echo   打包完成！
echo ============================================================
echo   产物目录：%CD%\release
dir /b "release\*.exe" 2>nul
echo.
echo   安装包：release\LocalMiniDrama-Setup-!VER!.exe
echo   便携版：release\LocalMiniDrama !VER!.exe
echo.
echo   把安装包发给同事即可（她那边需要是同一份代码的版本才能导入/导出素材）。
echo.
start "" "%CD%\release"
pause
