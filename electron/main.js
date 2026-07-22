import { app, BrowserWindow, dialog, shell } from 'electron';
import { loadConfig } from './config.js';
import { startServer } from './server-host.js';
import { createTray } from './tray.js';
import { localPathFromLink } from './link-utils.js';
import { appIconPath } from './icon.js';

let mainWindow = null;
let tray = null;
let quitting = false;

const gotLock = app.requestSingleInstanceLock();
app.setAppUserModelId('com.zzusp.scrumws-desktop');
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
      icon: appIconPath,
      webPreferences: { contextIsolation: true },
    });
    mainWindow.loadURL(`http://127.0.0.1:${port}/`);
    mainWindow.once('ready-to-show', () => mainWindow.show());

    // 详情消息的链接绝不在窗口内导航：网页交默认浏览器，本地文件交系统关联程序。
    // 这样 file:// 和 Windows 盘符链接不会把 SPA 导航到空白页；未知协议则直接拒绝。
    // 本地 app 自身导航（同 origin，含 #/ hash 路由）不拦——hash 变化根本不触发 will-navigate。
    const appOrigin = `http://127.0.0.1:${port}`;
    const openLinkOutsideApp = async (url) => {
      const localPath = localPathFromLink(url);
      if (localPath) {
        const error = await shell.openPath(localPath);
        if (error) {
          await dialog.showMessageBox(mainWindow, {
            type: 'error',
            title: '无法打开本地文件',
            message: '该文件可能已被移动、删除，或没有可用的关联程序。',
            detail: localPath,
          });
        }
        return;
      }
      if (/^(https?|mailto):/i.test(url)) await shell.openExternal(url);
    };
    // target=_blank / window.open（消息 markdown 和 issue commentUrl）→ 系统处理 + 拒绝开内嵌窗口
    mainWindow.webContents.setWindowOpenHandler(({ url }) => { void openLinkOutsideApp(url); return { action: 'deny' }; });
    // 无 target 的 <a href> 点击会把整窗导航走 → 拦下并交给系统；未识别协议也不会离开当前页。
    mainWindow.webContents.on('will-navigate', (e, url) => {
      let external = false;
      try { external = new URL(url).origin !== appOrigin; } catch { external = false; }
      if (external) { e.preventDefault(); void openLinkOutsideApp(url); }
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
