import { Tray, Menu } from 'electron';
import { appIconPath } from './icon.js';

export function createTray({ onShow, onQuit, port }) {
  const tray = new Tray(appIconPath);
  tray.setToolTip(`ScrumWS · 127.0.0.1:${port}`);
  tray.setContextMenu(Menu.buildFromTemplate([
    { label: '打开看板', click: onShow },
    { type: 'separator' },
    { label: '退出（后台守护将停止）', click: onQuit },
  ]));
  tray.on('double-click', onShow);
  return tray;
}
