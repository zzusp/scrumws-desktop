import { app, BrowserWindow, dialog, shell } from 'electron';
import { loadConfig } from './config.js';
import { startServer } from './server-host.js';
import { createTray } from './tray.js';

let mainWindow = null;
let tray = null;
let quitting = false;

const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  // 已有实例在跑：把焦点交给它（second-instance 事件），自己退出，防双实例
  app.quit();
} else {
  app.on('second-instance', () => {
    if (mainWindow) { mainWindow.show(); mainWindow.focus(); }
  });

  app.whenReady().then(async () => {
    const config = loadConfig();
    // 开机自启随配置对齐（仅打包版；dev 下 execPath 是裸 electron.exe，注册了也不对）
    if (app.isPackaged) app.setLoginItemSettings({ openAtLogin: !!config.autoStart });
    let port;
    try {
      ({ port } = await startServer(config));
    } catch (e) {
      dialog.showErrorBox('ScrumWS 启动失败',
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

    // 外链一律用系统默认浏览器打开，不在 app 内部浏览器里跳（详情里 claude 输出的 markdown 超链接、issue 评论链接等）。
    // 本地 app 自身导航（同 origin，含 #/ hash 路由）不拦——hash 变化根本不触发 will-navigate。
    const appOrigin = `http://127.0.0.1:${port}`;
    const openExternal = (url) => { if (/^(https?|mailto):/i.test(url)) shell.openExternal(url); };
    // target=_blank / window.open（如 issue commentUrl）→ 系统浏览器 + 拒绝开内嵌窗口
    mainWindow.webContents.setWindowOpenHandler(({ url }) => { openExternal(url); return { action: 'deny' }; });
    // 无 target 的 <a href> 点击会把整窗导航走 → 拦下外链改用系统浏览器
    mainWindow.webContents.on('will-navigate', (e, url) => {
      let external = false;
      try { external = new URL(url).origin !== appOrigin; } catch { external = false; }
      if (external) { e.preventDefault(); openExternal(url); }
    });

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
