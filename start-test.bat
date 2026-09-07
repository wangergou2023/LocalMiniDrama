@echo off
setlocal
cd /d "%~dp0"
set "ROOT=%~dp0"

echo ============================================
echo   LocalMiniDrama  -  local run (no install)
echo   UI: http://127.0.0.1:5679
echo ============================================

echo [1/3] Building frontend (frontweb/dist) ...
pushd "%ROOT%frontweb"
call npm run build
if errorlevel 1 (
  echo   FAILED: npm run build. Is Node.js + npm installed?
  popd
  pause
  exit /b 1
)
popd

echo [2/3] Freeing port 5679 ...
for /f "tokens=5" %%a in ('netstat -ano ^| findstr ":5679 " ^| findstr "LISTENING"') do (
  echo   Kill old PID %%a
  taskkill /PID %%a /F >nul 2>&1
)

echo [3/3] Starting backend (backend-node) and opening browser ...
start "LocalMiniDrama-Backend" /D "%ROOT%backend-node" cmd /k "npm run dev"
timeout /t 4 /nobreak >nul
start "" "http://127.0.0.1:5679"

echo.
echo Started. Backend runs in a separate window; browser should open at http://127.0.0.1:5679
echo (ComfyUI generation needs the AI config set, see notes.)
pause
