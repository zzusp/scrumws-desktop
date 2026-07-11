# 切换 runbook：web 看板（8788）→ 桌面 app

> 前提：matrix 全绿（含 C15/C16）。实际执行由孙鹏拍板；本文步骤可逐条复制执行。
> 原则：数据根不动（`D:\baibu-agent\runtime` / `scripts/`），切的只是「平台进程宿主」。

## 0. 自检（零副作用）

```powershell
# 旧看板在跑、锁被谁持有
Invoke-RestMethod http://127.0.0.1:8788/api/state | Select-Object -ExpandProperty scheduler
# 桌面 app 已安装且能以只读模式起（默认 schedulerEnabled=false 不抢锁）
```

## 1. 停旧（可逆）

```powershell
# 停计划任务（先 Disable 不删，保留回滚路径）
Get-ScheduledTask -TaskName baibu-dashboard | Disable-ScheduledTask
# 停当前 8788 进程（下一个 5min 自愈已被禁用）
Get-NetTCPConnection -LocalPort 8788 -State Listen -ErrorAction SilentlyContinue |
  Select-Object -ExpandProperty OwningProcess -Unique | ForEach-Object { Stop-Process -Id $_ -Force }
```

注意：强停后 `runtime/scheduler.lock` 可能残留死 pid——锁自带 pid 判活，桌面 app 启动会自愈抢锁，无需手清。

## 2. 起新

桌面 app 配置（`%APPDATA%\scrumws-desktop\config.json`，或首启后由设置界面写）：

```json
{ "port": 8799, "dataRoot": "D:\\baibu-agent", "schedulerEnabled": true }
```

启动 app → 核验：

```powershell
$s = Invoke-RestMethod http://127.0.0.1:8799/api/state
$s.scheduler.mode        # 期望 running
$s.dispatchers.Count     # 期望 2（chat-watch / issue-watch）
```

盯 1 个派发周期：`runtime/dispatch-chat.log` 有新时间戳心跳、无 ERROR。

## 3. 常驻（开机自启）

app 内开启「开机自启」（`app.setLoginItemSettings`，G7 交付项）。
不再需要任何 Windows 计划任务——「看板进程 = 调度平台」的语义不变，宿主从 schtasks+node 换成托盘常驻 app。

## 4. 回滚（任一步不符合预期）

```powershell
# 退出桌面 app（托盘菜单退出；调度停止、锁释放）
Get-ScheduledTask -TaskName baibu-dashboard | Enable-ScheduledTask
Start-ScheduledTask -TaskName baibu-dashboard   # 立即拉起 8788，恢复原态
```

## 5. 收尾（观察 ≥1 天后）

- 确认 awaiting-human / 派发 / 回复链在桌面 app 下均正常工作过至少一轮
- 删除 baibu-dashboard 计划任务（`Unregister-ScheduledTask`）
- `D:\baibu-agent\dashboard\` 保留为参考（本项目独立检出，不依赖它）
