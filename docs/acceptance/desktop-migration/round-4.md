# round-4 · G7 打包与产物实跑（2026-07-11）

## 构建 PASS

`npm run dist`（env：ELECTRON_MIRROR + ELECTRON_BUILDER_BINARIES_MIRROR 走 npmmirror，HTTP(S)_PROXY 本机 10808）exit 0：
- `dist/win-unpacked/scrumws-desktop.exe`（免安装可跑）
- `dist/scrumws-desktop Setup 0.1.0.exe`（NSIS oneClick、per-user）
- 配置要点：`asar:false`（平台核依赖 import.meta.dirname + 子进程 fork，实体文件与 dev 行为一致）；icon 未配走 Electron 默认（后续 polish 项）

## C16 产物实跑 PASS（范围注记见下）

win-unpacked exe 直接实跑：
- server up：`scheduler.mode=disabled-env`（默认只读配置生效）、dispatchers=2
- 窗口标题「小小鹏 · 运行看板」（G5 新 UI）
- `autoStart` 默认 false → HKCU Run 无注册项（验证了"不乱注册"方向）
- 退出后进程残留 0

**范围注记**：NSIS 安装包本体未执行实装（往系统装软件属机器级变更，留孙鹏在切换时点装即可——win-unpacked 与安装后运行的是同一份产物，功能证据等价）；`autoStart:true` 的注册路径同理留切换时验证（cutover.md §3）。
