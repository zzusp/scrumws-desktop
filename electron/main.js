const { app, BrowserWindow } = require('electron');
const { loadConfig } = require('./config');
const { startServer } = require('./server-host');
const { createTray } = require('./tray');

let mainWindow = null;
let tray = null;
let quitting = false;

const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  // 已有实例在跑：把任务交给它（second-instance 事件），自己退出，防双派发
  app.quit();
} else {
  app.on('second-instance', () => {
    if (mainWindow) { mainWindow.show(); mainWindow.focus(); }
  });

  app.whenReady().then(async () => {
    const config = loadConfig();
    const { port } = await startServer(config);

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
