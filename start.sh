#!/bin/bash
# LocalMiniDrama 一键启动脚本

cd /home/wangergou/LocalMiniDrama

# 启动后端
if ! pgrep -f "backend-node/src/server" > /dev/null; then
    echo "启动后端 API..."
    cd backend-node
    nohup npm run dev > /tmp/localminidrama_backend.log 2>&1 &
    cd ..
else
    echo "后端 API 已在运行"
fi

# 启动前端
if ! pgrep -f "vite" > /dev/null; then
    echo "启动前端 Web..."
    cd frontweb
    nohup npm run dev > /tmp/localminidrama_frontend.log 2>&1 &
    cd ..
else
    echo "前端 Web 已在运行"
fi

sleep 3
echo ""
echo "服务地址:"
echo "  后端 API: http://127.0.0.1:5679"
echo "  前端 Web: http://127.0.0.1:3013"
echo ""
echo "日志:"
echo "  后端: tail -f /tmp/localminidrama_backend.log"
echo "  前端: tail -f /tmp/localminidrama_frontend.log"
