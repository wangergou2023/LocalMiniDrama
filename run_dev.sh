#!/bin/bash
set -e

ROOT="$(cd "$(dirname "$0")" && pwd)"
BACKEND_DIR="$ROOT/backend-node"
FRONTEND_DIR="$ROOT/frontweb"
PID_FILE="$ROOT/.dev_pids"

RED='\033[0;31m'
GREEN='\033[0;32m'
CYAN='\033[0;36m'
YELLOW='\033[1;33m'
NC='\033[0m'

# 停止服务：先杀记录的进程组，再用 fuser 清端口
stop_all() {
    if [ -f "$PID_FILE" ]; then
        while read pid; do
            # kill 整个进程组（负数 PID），确保 npm/node 子进程全停
            kill -TERM -- -"$pid" 2>/dev/null || kill -TERM "$pid" 2>/dev/null || true
        done < "$PID_FILE"
        rm -f "$PID_FILE"
    fi
    # 兜底：fuser 按端口清理（比 lsof 快，不会卡死）
    sleep 0.5
    fuser -k 5679/tcp 2>/dev/null || true
    fuser -k 3013/tcp 2>/dev/null || true
    echo -e "${GREEN}所有服务已停止${NC}"
}

case "${1:-start}" in
    stop)
        stop_all
        exit 0
        ;;
    restart)
        stop_all
        sleep 1
        ;;
esac

cleanup() {
    echo -e "\n${YELLOW}正在停止服务...${NC}"
    stop_all
    exit 0
}
trap cleanup SIGINT SIGTERM

echo -e "${CYAN}==================================${NC}"
echo -e "${CYAN}  LocalMiniDrama 开发环境启动${NC}"
echo -e "${CYAN}==================================${NC}"

# 检查依赖
if [ ! -d "$BACKEND_DIR/node_modules" ]; then
    echo -e "${YELLOW}后端依赖未安装，正在安装...${NC}"
    (cd "$BACKEND_DIR" && npm install)
fi

if [ ! -d "$FRONTEND_DIR/node_modules" ]; then
    echo -e "${YELLOW}前端依赖未安装，正在安装...${NC}"
    (cd "$FRONTEND_DIR" && npm install)
fi

# 清理旧进程 + 端口
stop_all > /dev/null 2>&1

# 启动后端（不用 setsid，用进程组管理）
echo -e "\n${GREEN}[1/2] 启动后端 (port 5679)...${NC}"
cd "$BACKEND_DIR" && npm run dev &
BACKEND_PID=$!
echo $BACKEND_PID > "$PID_FILE"

# 启动前端
echo -e "${GREEN}[2/2] 启动前端 (port 3013)...${NC}"
cd "$FRONTEND_DIR" && npm run dev &
FRONTEND_PID=$!
echo $FRONTEND_PID >> "$PID_FILE"

# 回到项目根目录
cd "$ROOT"

# 等待启动
sleep 3

# 验证
if curl -s -o /dev/null http://127.0.0.1:3013/ 2>/dev/null; then
    echo -e "\n${GREEN}开发服务器已启动！${NC}"
    echo -e "  ${YELLOW}前端:  ${NC}http://localhost:3013"
    echo -e "  ${YELLOW}后端:  ${NC}http://localhost:5679"
    echo -e "  ${YELLOW}API:   ${NC}http://localhost:5679/api/v1"
    echo -e "\n${CYAN}按 Ctrl+C 停止所有服务${NC}"
    wait
else
    echo -e "\n${RED}启动失败，检查日志：${NC}"
    echo -e "  前端日志: tail -f /tmp/frontend_*.log"
    echo -e "  后端日志: 后端终端输出"
    stop_all
    exit 1
fi
