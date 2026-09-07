process.env.ELECTRON_MIRROR = 'https://npmmirror.com/mirrors/electron/';
process.env.ELECTRON_BUILDER_BINARIES_MIRROR = 'https://cdn.npmmirror.com/binaries/electron-builder-binaries/';

const { spawnSync } = require('child_process');
const path = require('path');
const isWin = process.platform === 'win32';
const cwd = path.join(__dirname, '..');

// 构建完整版（含示例资源），前端/后端同时准备
console.log('\n========== 构建完整版安装包（含示例资源）==========\n');
const full = spawnSync(isWin ? 'npm.cmd' : 'npm', ['run', 'dist'], {
  stdio: 'inherit',
  shell: isWin,
  cwd,
});
if (full.status !== 0) {
  console.error('完整版构建失败，终止。');
  process.exit(full.status || 1);
}

console.log('\n========== 构建完成 ==========');
console.log('输出目录：release/');
console.log('  完整版安装包：LocalMiniDrama-Setup-x.x.x.exe');
console.log('  完整版便携版：LocalMiniDrama-x.x.x.exe\n');
process.exit(0);
