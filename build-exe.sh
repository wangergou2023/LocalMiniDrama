#!/bin/bash
set -e
cd "$(dirname "$0")"

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
