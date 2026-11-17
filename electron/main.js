'use strict';

const { app, BrowserWindow, shell, dialog, Menu, systemPreferences } = require('electron');
const path = require('path');
const { createApp } = require('../server/index');
const { defaultDataDir } = require('../server/util');

let mainWindow = null;
let backend = null;
let serverPort = 0;

// 单实例运行，避免多个后台同时抢占端口和推流进程
const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  app.quit();
} else {
  app.on('second-instance', () => {
    if (mainWindow) {
      if (mainWindow.isMinimized()) mainWindow.restore();
      mainWindow.focus();
    }
  });
}

async function boot() {
  app.setName('StreamPilot');

  backend = await createApp({
    // 与命令行版共用同一数据目录，桌面端与浏览器端看到的是同一份配置
    dataDir: defaultDataDir(),
    openPath: (p) => shell.openPath(p),
    pickFiles: async ({ multiple, kind }) => {
      const filters = kind === 'playlist'
        ? [{ name: '播放列表', extensions: ['m3u', 'm3u8', 'txt'] }]
        : [{ name: '媒体文件', extensions: ['mp4', 'mkv', 'mov', 'avi', 'flv', 'ts', 'm2ts', 'webm', 'mp3', 'aac', 'wav', 'm4a'] }];
      const result = await dialog.showOpenDialog(mainWindow, {
        title: kind === 'playlist' ? '选择播放列表' : '选择媒体文件',
        properties: ['openFile', ...(multiple ? ['multiSelections'] : [])],
        filters: [...filters, { name: '全部文件', extensions: ['*'] }],
      });
      return result.canceled ? [] : result.filePaths;
    },
    pickFolder: async () => {
      const result = await dialog.showOpenDialog(mainWindow, {
        title: '选择输出目录',
        properties: ['openDirectory', 'createDirectory'],
      });
      return result.canceled ? '' : result.filePaths[0];
    },
    pickSave: async ({ defaultName }) => {
      const result = await dialog.showSaveDialog(mainWindow, {
        title: '选择录制文件保存位置',
        defaultPath: defaultName,
        filters: [{ name: '视频文件', extensions: ['mp4', 'mkv', 'ts'] }],
      });
      return result.canceled ? '' : result.filePath;
    },
  });
  const { port } = await backend.listen(0);
  serverPort = port;

  createWindow();
  buildMenu();
}

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1440,
    height: 900,
    minWidth: 1080,
    minHeight: 680,
    backgroundColor: '#0b0f16',
    title: 'StreamPilot 流控台',
    titleBarStyle: process.platform === 'darwin' ? 'hiddenInset' : 'default',
    trafficLightPosition: { x: 16, y: 18 },
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      backgroundThrottling: false,
    },
  });

  const target = `http://127.0.0.1:${serverPort}`;
  mainWindow.loadURL(target);

  // 外链一律走系统浏览器
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    if (!url.startsWith(target)) shell.openExternal(url);
    return { action: 'deny' };
  });

  mainWindow.webContents.on('will-navigate', (event, url) => {
    if (!url.startsWith(target)) {
      event.preventDefault();
      shell.openExternal(url);
    }
  });

  // 首次启动申请屏幕/摄像头/麦克风权限（macOS）
  if (process.platform === 'darwin') {
    mainWindow.webContents.session.setPermissionRequestHandler((wc, permission, callback) => {
      callback(true);
    });
    setTimeout(async () => {
      try {
        const screenStatus = systemPreferences.getMediaAccessStatus?.('screen');
        if (screenStatus === 'not-determined') {
          await systemPreferences.askForMediaAccess?.('screen');
        }
      } catch (_) {}
    }, 1200);
  }

  mainWindow.on('closed', () => { mainWindow = null; });
}

function buildMenu() {
  const isMac = process.platform === 'darwin';
  const template = [
    ...(isMac ? [{
      label: 'StreamPilot',
      submenu: [
        { role: 'about', label: '关于 StreamPilot' },
        { type: 'separator' },
        {
          label: '打开数据目录',
          click: () => backend && shell.openPath(backend.dataDir),
        },
        { type: 'separator' },
        { role: 'hide', label: '隐藏' },
        { role: 'quit', label: '退出' },
      ],
    }] : []),
    {
      label: '编辑',
      submenu: [
        { role: 'undo', label: '撤销' }, { role: 'redo', label: '重做' },
        { type: 'separator' },
        { role: 'cut', label: '剪切' }, { role: 'copy', label: '复制' },
        { role: 'paste', label: '粘贴' }, { role: 'selectAll', label: '全选' },
      ],
    },
    {
      label: '视图',
      submenu: [
        { role: 'reload', label: '重新加载界面' },
        { role: 'toggleDevTools', label: '开发者工具' },
        { type: 'separator' },
        { role: 'resetZoom', label: '实际大小' },
        { role: 'zoomIn', label: '放大' },
        { role: 'zoomOut', label: '缩小' },
        { type: 'separator' },
        { role: 'togglefullscreen', label: '全屏' },
      ],
    },
    {
      label: '推流',
      submenu: [
        {
          label: '启动全部任务',
          click: () => backend && backend.store.config.jobs.forEach((j) => {
            backend.jobs.start(j.id).catch(() => {});
          }),
        },
        {
          label: '停止全部任务',
          click: () => backend && backend.jobs.stopAll(),
        },
      ],
    },
    {
      label: '帮助',
      submenu: [
        {
          label: '使用说明',
          click: () => mainWindow && mainWindow.webContents.executeJavaScript("window.location.hash='#/help';"),
        },
        {
          label: '项目主页',
          click: () => shell.openExternal('https://github.com/'),
        },
      ],
    },
  ];
  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

app.whenReady().then(boot).catch((err) => {
  dialog.showErrorBox('StreamPilot 启动失败', String(err && err.stack ? err.stack : err));
  app.quit();
});

app.on('window-all-closed', () => {
  app.quit();
});

app.on('before-quit', async (event) => {
  if (!backend) return;
  event.preventDefault();
  const b = backend;
  backend = null;
  try { await b.close(); } catch (_) {}
  app.exit(0);
});

process.on('uncaughtException', (err) => {
  console.error('[main] uncaught', err);
});
