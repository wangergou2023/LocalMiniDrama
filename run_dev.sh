#!/bin/bash
set -e
# 开启 job control：让后台任务各自成为进程组组长。
# 否则后台任务与脚本同组，stop_all 里的 `kill -- -PID`（按组杀）会因为「没有该进程组」而失效，
# 只能杀掉 npm 包装进程，真正干活的 node 子进程会残留。
set -m

ROOT="$(cd "$(dirname "$0")" && pwd)"
BACKEND_DIR="$ROOT/backend-node"
FRONTEND_DIR="$ROOT/frontweb"
PID_FILE="$ROOT/.dev_pids"

BACKEND_PORT=5679
FRONTEND_PORT=3013

RED='\033[0;31m'
GREEN='\033[0;32m'
CYAN='\033[0;36m'
YELLOW='\033[1;33m'
NC='\033[0m'

# 端口是否被占用：ss 优先，回退 fuser。用于兜底清理与启动校验。
port_busy() {
    if command -v ss >/dev/null 2>&1; then
        ss -ltn 2>/dev/null | grep -q ":$1[[:space:]]"
    elif command -v fuser >/dev/null 2>&1; then
        fuser -s "$1/tcp" 2>/dev/null
    else
        return 1
    fi
}

# 启动校验：优先打 /health（真正证明服务可用），无 curl 时退化为端口占用检测
check_backend() {
    if command -v curl >/dev/null 2>&1; then
        curl -fsS -m 5 -o /dev/null "http://127.0.0.1:$BACKEND_PORT/health" 2>/dev/null
    else
        port_busy "$BACKEND_PORT"
    fi
}

check_frontend() {
    if command -v curl >/dev/null 2>&1; then
        curl -fsS -m 5 -o /dev/null "http://127.0.0.1:$FRONTEND_PORT/" 2>/dev/null
    else
        port_busy "$FRONTEND_PORT"
    fi
}

# 停止服务：先杀记录的进程组，再用端口兜底清理
stop_all() {
    if [ -f "$PID_FILE" ]; then
        while read pid; do
            [ -z "$pid" ] && continue
            # kill 整个进程组（负数 PID），确保 npm/node 子进程全停
            kill -TERM -- -"$pid" 2>/dev/null || kill -TERM "$pid" 2>/dev/null || true
        done < "$PID_FILE"
        rm -f "$PID_FILE"
    fi
    # 兜底：fuser 按端口清理（比 lsof 快，不会卡死）；没有 fuser 时跳过
    sleep 0.5
    if command -v fuser >/dev/null 2>&1; then
        fuser -k "$BACKEND_PORT/tcp" 2>/dev/null || true
        fuser -k "$FRONTEND_PORT/tcp" 2>/dev/null || true
    fi
    echo -e "${GREEN}所有服务已停止${NC}"
}

# 依赖检查：后台模式与前台模式共用
ensure_deps() {
    if [ ! -d "$BACKEND_DIR/node_modules" ]; then
        echo -e "${YELLOW}后端依赖未安装，正在安装...${NC}"
        (cd "$BACKEND_DIR" && npm install)
    fi
    if [ ! -d "$FRONTEND_DIR/node_modules" ]; then
        echo -e "${YELLOW}前端依赖未安装，正在安装...${NC}"
        (cd "$FRONTEND_DIR" && npm install)
    fi
}

# 启动校验：前后端都验，成功返回 0
verify_both() {
    BACKEND_OK=0
    FRONTEND_OK=0
    check_backend && BACKEND_OK=1
    check_frontend && FRONTEND_OK=1
    [ "$BACKEND_OK" = "1" ] && [ "$FRONTEND_OK" = "1" ]
}

# 后台启动（脱离终端，日志落 /tmp）：./run_dev.sh bg
# 因为 set -m 让每个后台任务自成进程组、且 PID 记进同一个 .dev_pids，
# 所以 ./run_dev.sh stop 仍能按「整组信号」一次带走 npm → sh → node --watch → node 整棵树。
start_background() {
    BACKEND_LOG=/tmp/localminidrama_backend.log
    FRONTEND_LOG=/tmp/localminidrama_frontend.log

    ensure_deps
    stop_all > /dev/null 2>&1

    echo -e "${CYAN}==================================${NC}"
    echo -e "${CYAN}  LocalMiniDrama 后台启动${NC}"
    echo -e "${CYAN}==================================${NC}"

    : > "$PID_FILE"
    echo -e "\n${GREEN}[1/2] 后台启动后端 (port $BACKEND_PORT)...${NC}"
    # nohup 避免终端关闭时被 SIGHUP 带走；exec 让 $! 就是 npm 本身，pgid == pid
    nohup bash -c "cd '$BACKEND_DIR' && exec npm run dev" > "$BACKEND_LOG" 2>&1 &
    echo $! >> "$PID_FILE"

    echo -e "${GREEN}[2/2] 后台启动前端 (port $FRONTEND_PORT)...${NC}"
    nohup bash -c "cd '$FRONTEND_DIR' && exec npm run dev" > "$FRONTEND_LOG" 2>&1 &
    echo $! >> "$PID_FILE"

    sleep 3

    if verify_both; then
        echo -e "\n${GREEN}开发服务器已在后台启动！${NC}"
        echo -e "  ${YELLOW}前端:  ${NC}http://localhost:$FRONTEND_PORT"
        echo -e "  ${YELLOW}后端:  ${NC}http://localhost:$BACKEND_PORT"
        echo -e "  ${YELLOW}API:   ${NC}http://localhost:$BACKEND_PORT/api/v1"
        echo -e "\n${CYAN}查看日志:${NC}"
        echo -e "  后端: tail -f $BACKEND_LOG"
        echo -e "  前端: tail -f $FRONTEND_LOG"
        echo -e "\n${CYAN}停止所有服务: ./run_dev.sh stop${NC}"
    else
        echo -e "\n${RED}启动失败（后端=$BACKEND_OK 前端=$FRONTEND_OK）${NC}"
        echo -e "  ${YELLOW}后端日志: ${NC}tail -f $BACKEND_LOG"
        echo -e "  ${YELLOW}前端日志: ${NC}tail -f $FRONTEND_LOG"
        stop_all
        exit 1
    fi
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
    bg)
        start_background
        exit 0
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
ensure_deps

# 清理旧进程 + 端口
stop_all > /dev/null 2>&1

# 启动后端（不用 setsid，用进程组管理；set -m 保证它自成一组）
echo -e "\n${GREEN}[1/2] 启动后端 (port $BACKEND_PORT)...${NC}"
cd "$BACKEND_DIR" && npm run dev &
BACKEND_PID=$!
echo $BACKEND_PID > "$PID_FILE"

# 启动前端
echo -e "${GREEN}[2/2] 启动前端 (port $FRONTEND_PORT)...${NC}"
cd "$FRONTEND_DIR" && npm run dev &
FRONTEND_PID=$!
echo $FRONTEND_PID >> "$PID_FILE"

# 回到项目根目录
cd "$ROOT"

# 等待启动
sleep 3

# 验证：前后端都要真的可用才算启动成功（只看前端会漏掉「后端挂了但脚本报成功」）
if verify_both; then
    echo -e "\n${GREEN}开发服务器已启动！${NC}"
    echo -e "  ${YELLOW}前端:  ${NC}http://localhost:$FRONTEND_PORT"
    echo -e "  ${YELLOW}后端:  ${NC}http://localhost:$BACKEND_PORT"
    echo -e "  ${YELLOW}API:   ${NC}http://localhost:$BACKEND_PORT/api/v1"
    echo -e "\n${CYAN}按 Ctrl+C 停止所有服务${NC}"
    wait
else
    echo -e "\n${RED}启动失败（后端=$BACKEND_OK 前端=$FRONTEND_OK）${NC}"
    echo -e "  ${YELLOW}后端地址:  ${NC}http://127.0.0.1:$BACKEND_PORT/health"
    echo -e "  ${YELLOW}前端地址:  ${NC}http://127.0.0.1:$FRONTEND_PORT/"
    echo -e "  ${YELLOW}服务日志:  ${NC}就在本终端输出里（本脚本不写日志文件）"
    echo -e "  ${YELLOW}端口占用:  ${NC}ss -ltnp | grep -E ':($BACKEND_PORT|$FRONTEND_PORT)'"
    stop_all
    exit 1
fi
