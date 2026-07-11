import { app, BrowserWindow, dialog } from 'electron';
import { loadConfig } from './config.js';
import { startServer } from './server-host.js';
import { createTray } from './tray.js';

let mainWindow = null;
let tray = null;
let quitting = false;

const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  // 已有实例在跑：把焦点交给它（second-instance 事件），自己退出，防双派发
  app.quit();
} else {
  app.on('second-instance', () => {
    if (mainWindow) { mainWindow.show(); mainWindow.focus(); }
  });

  app.whenReady().then(async () => {
    const config = loadConfig();
    let port;
    try {
      ({ port } = await startServer(config));
    } catch (e) {
      dialog.showErrorBox('scrumws-desktop 启动失败',
        e.code === 'EADDRINUSE' ? `端口 ${config.port} 已被占用（另一实例在跑？）` : String(e.stack || e));
      app.exit(1);
      return;
    }

    mainWindow = new BrowserWindow({
      width: 1440,
      height: 900,
      show: false,
      autoHideMenuBar: true,
      backgroundColor: '#111111',
      webPreferences: { contextIsolation: true },
    });
    mainWindow.loadURL(`http://127.0.0.1:${port}/`);
    mainWindow.once('ready-to-show', () => mainWindow.show());

    // 关窗 = 隐藏到托盘，调度继续；显式退出走托盘菜单
    mainWindow.on('close', (e) => {
      if (!quitting) {
        e.preventDefault();
        mainWindow.hide();
      }
    });

    tray = createTray({
      onShow: () => { mainWindow.show(); mainWindow.focus(); },
      onQuit: () => { quitting = true; app.quit(); },
      port,
    });
  });

  app.on('before-quit', () => { quitting = true; });
  // 托盘常驻：窗口全关不退出（Windows 语义；mac 适配留待后续）
  app.on('window-all-closed', () => {});
}
