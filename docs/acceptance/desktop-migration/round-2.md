# round-2 · C13 写端点 + C14 调度器 Electron 宿主实跑（2026-07-11）

环境：sandbox 数据根 `.sandbox/`（gitignore），`SCRUMWS_DATA_ROOT` 注入 + `SCRUMWS_PORT=8803` + `SCRUMWS_SCHEDULER=1`，Electron 壳实跑。生产 runtime（D:\baibu-agent）零接触；旧看板 8788 不受影响。

## C14 调度器（Electron 宿主）PASS
- `scheduler.mode = running`（拿到 sandbox 自己的 scheduler.lock）
- 桩派发器（intervalSec=5）连续 tick，**每 tick 独立 fork 进程**：
  `[12:52:53] stub tick ok pid=2804 / [12:52:58] pid=51660 / [12:53:03] pid=524`
  → 证明 `ELECTRON_RUN_AS_NODE=1` 下 electron.exe 以纯 Node 语义跑 run-job.js（修复点 1 实证）
- 附带发现：sandbox 注册表缺失时 `readRegistry()` 会自动播种真实 chat/issue 派发器（enabled）——sandbox 必须**先落注册表再起服务**（本轮已如此操作；正式切换时数据根是真实 runtime、注册表已存在，无此问题）

## C13 写端点 PASS（12 个）
任务链（manual:m20260711125335-839 全生命周期）：
- create(planFirst)→ok / describe→ok / rename→ok / approve→ok(spawned) / cancel→ok / archive→ok，最终 archived 桶可见
派发器链（stub-test）：
- script 读→ok(len=89) / update(改 label+interval+脚本，经 `node --check` 语法校验)→ok / **坏脚本被拦**（`语法校验未通过` — 反证 Electron 下 --check 真实在跑，修复点 2 实证）/ stop→ok / delete→ok（删除后 dispatchers=0）
平台开关：runner pause/resume→ok/ok、checker stop/start→ok/ok

## 本轮修复
3. `dispatchers.js` validateScript 的 `execFile(process.execPath, ['--check'])` 同样存在 Electron execPath 问题 → env 加 `ELECTRON_RUN_AS_NODE=1`（与 scheduler 同款）

## 观察（非缺陷）
- 强杀 Electron 主进程时 scheduler.lock 不释放（'exit' handler 不触发）；锁自带 pid 判活，下次启动自愈抢锁。托盘正常退出路径会释放。
