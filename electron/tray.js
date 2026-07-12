import { Tray, Menu, nativeImage } from 'electron';

// 纯色占位图标，UI 风格定稿（G5）后替换为正式 icon
function placeholderIcon() {
  const size = 16;
  const buf = Buffer.alloc(size * size * 4);
  for (let i = 0; i < size * size; i++) {
    buf[i * 4 + 0] = 0xe8; // B
    buf[i * 4 + 1] = 0x8c; // G
    buf[i * 4 + 2] = 0x4a; // R
    buf[i * 4 + 3] = 0xff; // A
  }
  return nativeImage.createFromBitmap(buf, { width: size, height: size });
}

export function createTray({ onShow, onQuit, port }) {
  const tray = new Tray(placeholderIcon());
  tray.setToolTip(`ScrumWS · 127.0.0.1:${port}`);
  tray.setContextMenu(Menu.buildFromTemplate([
    { label: '打开看板', click: onShow },
    { type: 'separator' },
    { label: '退出（后台守护将停止）', click: onQuit },
  ]));
  tray.on('double-click', onShow);
  return tray;
}
