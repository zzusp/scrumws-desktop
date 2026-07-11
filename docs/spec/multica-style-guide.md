# multica UI 风格指南（G5 实现基线）

> 来源：2026-07-11 对 `D:\baibu-agent\repos\multica`（Electron 39 + React19 + Tailwind v4 + Base UI）的全量研究。
> 我方实现策略：**不换前端技术栈**（保 vanilla 零依赖，降回归风险），把 multica 的设计 token / 布局范式 / 组件视觉逐项移植为 CSS 变量 + 原生组件样式。

## 1. 设计 token（源：`packages/ui/styles/tokens.css`，oklch）

### Light（`:root`）
```css
--background: oklch(1 0 0);            --foreground: oklch(0.141 0.005 285.8);
--card: oklch(1 0 0);                  --popover: oklch(1 0 0);
--primary: oklch(0.21 0.006 285.9);    --primary-foreground: oklch(0.985 0 0);
--secondary: oklch(0.967 0.001 286.4); --muted: oklch(0.967 0.001 286.4);
--muted-foreground: oklch(0.552 0.016 285.9);
--accent: oklch(0.967 0.001 286.4);    --border: oklch(0.945 0.003 286.3);
--input: oklch(0.92 0.004 286.3);      --ring: oklch(0.705 0.015 286.1);
--destructive: oklch(0.577 0.245 27.3);
--brand: oklch(0.55 0.16 255);         --success: oklch(0.55 0.16 145);
--warning: oklch(0.75 0.16 85);        --info: oklch(0.55 0.18 250);
--radius: 0.625rem;
--scrollbar-thumb: oklch(0 0 0 / 10%);
```

### Dark（`.dark`）
```css
--background: oklch(0.18 0.005 285.8); --foreground: oklch(0.985 0 0);
--card: oklch(0.21 0.006 285.9);       --popover: oklch(0.21 0.006 285.9);
--primary: oklch(0.92 0.004 286.3);    --secondary/muted/accent: oklch(0.274 0.006 286.0);
--border: oklch(1 0 0 / 6%);           --input: oklch(1 0 0 / 15%);
--brand: oklch(0.65 0.16 255);         --success: oklch(0.65 0.15 145);
--warning: oklch(0.70 0.16 85);        --info: oklch(0.65 0.18 250);
--destructive: oklch(0.704 0.191 22.2);
```

### 派生
- 圆角阶梯：`sm=radius*0.6, md=*0.8, lg=radius, xl=*1.4, 2xl=*1.8`；卡片/主盒 `xl`、按钮 `lg`、badge 胶囊全圆
- 字体：sans=`"Inter", -apple-system, "PingFang SC", "Microsoft YaHei", sans-serif`；mono=`"Geist Mono", ui-monospace, Consolas, monospace`
- 字号：密集信息用 12px/11px/10px（text-xs 档），正文 14px
- 阴影克制：卡片用 `ring`（`box-shadow: 0 0 0 1px color-mix(foreground 10%)`）代 border；board 卡 `0 3px 6px -2px rgba(0,0,0,.02), 0 1px 1px 0 rgba(0,0,0,.04)`；主内容盒 `shadow-sm`
- 滚动条：6px 细条 + `--scrollbar-thumb`

## 2. 布局范式（→ 我方映射）

multica shell：左侧**可折叠侧边栏**（inset 变体）+ 顶部窄工具条（拖拽区）+ 内容区 `rounded-xl shadow-sm bg-background` 主盒。

我方映射（4 视图 → 侧边栏导航）：
- 侧边栏分组：
  - **运行**：任务看板（board）/ 任务详情（点卡进入）
  - **编排**：派发器（dispatcher）
  - **平台**：数据看板（dashboard：Runner Checker）
- 侧边栏顶部：品牌区 + 「+ 新建任务」「+ CLI 会话」主操作
- 侧边栏底部：派发暂停开关、自动刷新开关、主题切换
- 顶部窄条：面包屑/当前视图名 + 时钟 + dws 授权红条挂全局横幅位
- 内容区：`rounded-xl` 主盒承载现有各视图

## 3. 组件视觉规范

| 组件 | multica 风格 |
|---|---|
| 卡片 | `rounded-xl bg-card ring-1 ring-foreground/10`，Header/Content/Footer 分区，Footer `bg-muted/50 border-t` |
| 状态徽章 | 胶囊（全圆）`h-5 text-xs`；变体 default/secondary/destructive/outline |
| 任务状态图标 | 手绘 SVG 环（backlog 点环/todo 空环/in_progress 半圆/done 打勾/blocked 斜杠），色：processing→warning、done→info、awaiting→destructive、queued→muted |
| 按钮 | `rounded-lg`，变体 default(实底 primary)/outline/secondary/ghost/destructive；`active:translate-y-px` 微交互 |
| 表单 | input/textarea/select 统一 `--input` 边框色、`--ring` focus 环 |
| 实时阶段指示 | TaskStatusPill 范式：把底层动作翻译成人话标签 + 呼吸 spinner + 秒表（我方 processing 卡可借鉴） |
| 日志/终端 | mono 字体、行式流、active 置顶 + past 折叠 |
| 模型名展示 | mono 字体 + effort 徽章（agent 资料卡范式） |
| 图标 | lucide 内联 SVG（MIT，按需复制 path） |

## 4. 桌面集成对照

| 能力 | multica 做法 | 我方决策 |
|---|---|---|
| 常驻 | 无 Tray，dock/taskbar 徽标 | **保留托盘**（调度平台关窗不能停），徽标可后续加 |
| 通知 | 原生 Notification，失焦才发，点击聚焦+路由 | 后续增强项（awaiting-human 通知） |
| 单实例 | requestSingleInstanceLock + dev/prod 隔离 userData | 已实现（G3） |
| PATH | 非 win32 用 fix-path 恢复登录 shell PATH | Windows 目标暂不需要，mac 时引入 |
| 更新 | electron-updater 静默下载 | 暂不做（本机自用） |
