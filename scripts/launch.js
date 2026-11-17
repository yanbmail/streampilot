#!/usr/bin/env node
'use strict';

/**
 * 启动器：某些环境（含 CI / 沙箱 / 通过其他 Electron 进程调用）会设置
 * ELECTRON_RUN_AS_NODE=1，导致 Electron 退化成 Node 运行器。这里显式清除，
 * 保证桌面窗口能正常创建。
 */
const { spawn } = require('child_process');
const path = require('path');
const fs = require('fs');

const projectRoot = path.join(__dirname, '..');
let electronBin = '';
try {
  electronBin = require('electron');
} catch (err) {
  electronBin = '';
}
if (!electronBin || !fs.existsSync(electronBin)) {
  const fallback = path.join(projectRoot, 'node_modules', 'electron', 'dist',
    process.platform === 'darwin' ? 'Electron.app/Contents/MacOS/Electron'
      : process.platform === 'win32' ? 'electron.exe' : 'electron');
  if (fs.existsSync(fallback)) electronBin = fallback;
}

if (!electronBin) {
  console.error('未找到 Electron 运行时，请先执行：npm install');
  process.exit(1);
}

const env = { ...process.env };
delete env.ELECTRON_RUN_AS_NODE;
delete env.ELECTRON_NO_ATTACH_CONSOLE;

const args = [projectRoot, ...process.argv.slice(2)];
// 受限环境（容器 / 某些 CI / 安全沙箱）里 Chromium 沙箱可能无法初始化，
// 可用 STREAMPILOT_NO_SANDBOX=1 关闭沙箱启动，仅建议在这种环境下使用。
if (process.env.STREAMPILOT_NO_SANDBOX === '1') {
  args.push('--no-sandbox', '--disable-gpu-sandbox');
}
const child = spawn(electronBin, args, {
  cwd: projectRoot,
  stdio: 'inherit',
  env,
});
child.on('exit', (code) => process.exit(code ?? 0));
for (const sig of ['SIGINT', 'SIGTERM']) {
  process.on(sig, () => { try { child.kill(sig); } catch (_) {} });
}
