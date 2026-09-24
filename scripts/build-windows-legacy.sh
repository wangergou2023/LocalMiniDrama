#!/bin/bash
# ⚠️ 已被淘汰：请用仓库根目录的「打包-Windows.bat」（它会额外体检 Windows 原生依赖：
#    从 Linux 拷过来的 node_modules 里 sharp/better-sqlite3 是 Linux 二进制，打出来的包在
#    Windows 上加载不了）。本脚本保留仅作参考。
#
# 用法（在仓库根目录执行）：bash scripts/build-windows-legacy.sh
set -e
# 脚本现在位于 scripts/ 下，先回到仓库根目录
cd "$(dirname "$0")/.."

RED='\033[0;31m'
GREEN='\033[0;32m'
CYAN='\033[0;36m'
NC='\033[0m'

echo -e "${CYAN}==================================${NC}"
echo -e "${CYAN}  LocalMiniDrama Windows 打包${NC}"
echo -e "${CYAN}==================================${NC}"

# 1. 构建前端
echo -e "\n${GREEN}[1/3] 构建前端...${NC}"
cd frontweb && npm run build && cd ..

# 2. 复制到 desktop
echo -e "\n${GREEN}[2/3] 复制文件到 desktop...${NC}"
cd desktop
npm run copy-front
node scripts/copy-backend.js

# 3. 打包
echo -e "\n${GREEN}[3/3] electron-builder 打包...${NC}"
npx electron-builder --win portable

echo -e "\n${CYAN}==================================${NC}"
echo -e "${GREEN}打包完成！${NC}"
ls -lh release/LocalMiniDrama*.exe
echo -e "${CYAN}==================================${NC}"
