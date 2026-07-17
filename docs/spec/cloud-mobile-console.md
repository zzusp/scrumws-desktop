# 手机端个人控制台 · 设计与契约

给机器主人一个**手机可用的网页**，不在电脑前也能访问**自己的**本地 app：查看全部任务（含本地手敲的）、新建任务、回复 / 发消息、看实时输出。

与云端平台（团队派活面）的关系：**同一个云端服务、同一套登录 / 机器体系，但数据通路完全不同**——本控制台是「经云端中继实时访问本地 app」，不是「看云端镜像」。

**关键决策（2026-07-17 已与用户确认）**：
1. **数据通路 = 云端实时中继**：手机 → 云端 → connector 出站长连 → 本地既有 API，数据现取现回、**不落云库**。与决策 14（本地任务不全量上云）零冲突。
2. **本地闸门默认关**：`cloudRemoteControl` 默认 `false`，enroll 后须在桌面设置页手动开启；新建任务另受 cwd 白名单约束（默认空 = 拒绝）。
3. 沿用已定的 P2 绊线修订：公网裸 HTTP 下必须显式 `CLOUD_ACCEPT_PLAINTEXT_DISPATCH=1` 才放行一切下行面（含本中继）。

---

## 1. 候选架构与排除理由

| 候选 | 结论 | 理由 |
|---|---|---|
| **A. 云端实时中继**（✔ 采用） | 手机经云端中继直访本地 app 既有能力 | 与决策 14 一致（云库不存本地任务）；~0.5s 交互延迟；**零新表、零迁移**，与并行 cloud 开发冲突面最小；语义与本地看板天然一致（同一套状态机 / 动作） |
| B. owner 全量镜像上云 | ✘ | 与决策 14 直接冲突（云端是派活平台不是监控大盘）；15s 对账延迟对交互操作太慢；要动 connector 对账 / 云端 task 表——正是并行开发的主战场 |
| C. 手机 VPN 直连本地 8799 | ✘ | 8799 无鉴权（要新建整套本地鉴权）；手机须装并常开 VPN；每台机器单独配置；与云端账号体系割裂 |
| D. 独立手机网关服务 | ✘ | 重复建设登录 / 机器令牌 / 长连通道，纯开销 |

**机器离线时的表现（A 的代价，已知悉接受）**：手机端只能看到「机器离线」，无法翻任务历史——离线时本来也无法做任何操作。将来团队面的 P2 落地后，云端派发的任务自然有镜像可看，两者互补。

---

## 2. 架构

```
手机浏览器 ── HTTP(S) ──▶ 云端 (Fastify, 8790)
   │  /m/ 移动端页面           │            ▲
   │  /api/my/* (会话+owner)   │ SSE 下行    │ HTTP 上行
   │                          ▼            │
   │                    connector（本地 app 进程内，纯出站）
   │                          │ 进程内调用（不走 8799 回环）
   │                          ▼
   │              本地既有能力：getState / task-actions /
   │              task-runner / session-manager / logs.readWorkerLog
```

- **下行长连**：connector 出站建一条 SSE（`node:http(s)` 手写客户端，零依赖），云端经它推送 rpc 请求 / watch 指令。**8799 仍只绑 127.0.0.1，云端永远没有入站访问**——不变式不破。
- **上行**：connector 用既有 `cloudRequest()` POST 回 rpc 结果 / watch 帧。
- **云端不落库**：中继数据只在内存 pending 表 / SSE 管道里过一遍。`task` / `task_status` 等表零写入。
- 手机端页面与云端平台同源托管（会话 cookie 同一套），路径 `/m/`。

### 信任模型（诚实标注）

云端侧强制**只有机器主人本人**（`machine.owner_user_id == 会话 user`）能走 `/api/my/*`。但本地无法独立核验「请求者是 owner」——它信任云端的鉴权判定，这与已接受的 §7.3 owner-only 信任模型同款：**云端被攻破 = 攻击者可冒充 owner 在白名单目录内执行任务**。不依赖云端诚实的防线只有两道，都在本地：`cloudRemoteControl` 总开关（默认关）与 `cloudAllowedCwds` 白名单（默认空）。

---

## 3. 本地闸门（`runner-config.json`，热加载）

```jsonc
{
  "cloudRemoteControl": false,   // 总开关。false = connector 根本不建下行长连（零下行面）
  "cloudAllowedCwds": []         // createTask 的 cwd 白名单（前缀匹配）。空 = 拒绝一切远程新建
}
```

- 总开关管**一切** relay 能力，包括只读（state / 日志含源码 transcript，读也该受管）。
- 开关热加载：connector 每 tick（15s）检查，关→断开下行连接；开→建立。
- 白名单只约束 `createTask`；对既有任务的 reply / message / approve 不做 cwd 校验（任务已存在，约束点是总开关）。
- 桌面设置页「云端」区块加：远程控制开关 + 白名单编辑 + 中继连接状态展示。

---

## 4. 协议契约

### 4.1 下行长连：`GET /api/machine/downlink`

鉴权 `Bearer swmt_…`；`text/event-stream`。云端 → connector 的事件：

```
event: rpc          data: { "rpcId": "uuid", "verb": "state", "args": {…} }
event: watch_start  data: { "watchId": "uuid", "taskKey": "manual:2026…" }
event: watch_stop   data: { "watchId": "uuid" }
event: ping         data: {}                    // 每 25s，保活
```

- 同一机器**重复建连 = 顶掉旧连接**（新连接生效，旧的被服务端关闭）——本地重启 / 断网重连后不留幽灵连接。
- connector 断线重连：指数退避 1s → 2s → … → 上限 30s；`cloudRemoteControl=false` 时不建连。
- 云端内存里维护 `machineId → 连接` 映射；连接在场 = `relayOnline: true`。

### 4.2 上行：rpc 结果与 watch 帧

```
POST /api/machine/rpc/:rpcId/result     (Bearer swmt_)
  { "ok": true, "data": {…} }  或  { "ok": false, "error": "白名单外的 cwd" }

POST /api/machine/watch/:watchId/frames (Bearer swmt_)
  { "frames": [ {…} ], "done": false }
  // done=true = 本地侧终止（任务收敛 / 开关被关），云端随之关闭浏览器 SSE
```

- rpcId / watchId 由云端生成；connector 对未知 id 的上行，云端回 404（连接顶替 / 超时后的迟到响应，丢弃即可）。
- watch 帧 500ms 批量合并后上行（抄 multica 的消息合并）。

### 4.3 云端 owner API（手机页专用；会话 cookie）

**全部端点先做 owner 校验**：目标机器 `owner_user_id != 会话 user` → **404**（不泄露存在性，同 §3.4）。

```
GET  /api/my/machines
  ← { "machines": [ { id, displayName, status, lastSeenAt, relayOnline,
                      load: {processing, queued, cap} } ] }   // 只列本人机器

POST /api/my/machines/:id/rpc        { "verb": "state", "args": {…} }
  ← 200 { "ok": true, "data": {…} }           // connector 的原样返回
  ← 502 { error: { code: "RELAY_FAILED" } }    // connector 返回 ok:false（message 透传本地拒绝原因）
  ← 503 { error: { code: "MACHINE_OFFLINE" } } // 下行连接不在场（离线或未开远程控制）
  ← 504 { error: { code: "RELAY_TIMEOUT" } }   // 10s 内无响应

GET  /api/my/machines/:id/watch?taskKey=…      // 浏览器 EventSource
  → 云端下发 watch_start，转发帧给浏览器；浏览器断开 → 下发 watch_stop
```

### 4.4 rpc verb 白名单（**穷举**；云端不解释 args，只透传；一切校验在本地）

| verb | args | 本地映射 | 说明 |
|---|---|---|---|
| `state` | — | `getState({maxAgeMs:3000})` | 裁剪成手机看板需要的六桶卡片核心字段（taskKey/title/state/outcome/source/cwd/enteredAt/lastActivityMs/backgroundTaskCount/worktreeBranch），**不含 prompt 全文** |
| `cwds` | — | 读 `cloudAllowedCwds` | 给新建表单做目录选择器（只返回白名单本身） |
| `taskDetail` | `{taskKey}` | task.json + state.json + meta 概要 | 含 prompt 全文、history、usage |
| `workerLog` | `{taskKey, tail?}` | `readWorkerLog` 尾部窗口 | `tail` 默认 30 块；返回 `{blocks, total}`，手机端「加载更早」翻页 |
| `createTask` | `{title,prompt,model,effort,cwd,worktree,baseBranch,plan}` | 闸门校验 → `createTask({source:'mobile', …})` | cwd 必须落在白名单前缀内，否则 `ok:false`；`plan=true` 落 plan 待确认，`false` 直接排队执行 |
| `message` | `{taskKey, text}` | 活会话在 → `sendUserMessage`；否则 → `replyToTask` | 按状态分支（与本地详情页行为一致）；plan/queued/done 等不可发 → `ok:false` 带原因 |
| `approve` | `{taskKey}` | 同本地 `/api/task/approve` 的动作函数 | plan → queued + 起跑 |
| `cancel` / `complete` / `uncomplete` / `toPlan` | `{taskKey}` | task-actions 对应函数 | 状态机自校验，非法迁移原样返回错误 |

- **verb 白名单在 connector 侧写死**（不是转发任意路径）——云端被攻破也只能调这张表里的动作。
- `source:'mobile'` 仅是来源元数据（README 任务来源不变量）；`'cloud'` 前缀留给并行开发中的团队派活（P2 intent），两者不混。
- 中继新建的任务是**本地任务**，不写云库——与决策 14 一致。将来 P2 落地后如需「手机建的任务离线可见」，由 P2 的 intent 通道承接，本设计不预做。

### 4.5 watch 帧内容（v1 = 轮询式 worker-log 尾巴）

connector 收到 `watch_start` 后，**进程内**每 1.5s 调一次 `readWorkerLog(taskKey)`（不 fs.watch、不碰 server.js 的 SSE 实现），指纹比对有变化才推：

```jsonc
{ "frames": [ { "kind": "worker-log", "blocks": [ …新增/变化的尾部块… ],
                "total": 57, "state": "processing" } ], "done": false }
```

- 任务收敛（state 离开 processing 且无活会话输出）→ 推最后一帧 `done:true` 并停表。
- 手机端到端延迟 ≈ 1.5–3s。**升级路径**（本期不做）：接 session emitter 的 partial 事件中继，实现逐字流。
- 同一任务多个观看者复用同一个本地轮询器（watchId 计数）。

### 4.6 云端绊线（与 P2 同判据，先落地在本中继上）

`CLOUD_INSECURE_COOKIE=1` 且服务非仅绑 localhost 且 **未设** `CLOUD_ACCEPT_PLAINTEXT_DISPATCH=1`
→ `/api/machine/downlink`、`/api/machine/rpc/*`、`/api/machine/watch/*`、`/api/my/*` 一律 **503**（启动不受阻，只封下行面；启动日志打出当前姿态）。判据写成独立函数（`cloud/src/dispatch-gate.js`），并行 P2 落地时直接复用。

---

## 5. 手机端页面（`cloud/public/m/`）

- 与云端平台同源同会话；**独立轻量 SPA**（原生 JS，hash 路由），不复用桌面版 `app.js`（交互范式不同：底部导航 / 大触控目标 / 单列流）。
- 视觉沿用 multica 风格 token（oklch、亮暗双主题跟随系统）；`viewport` meta + PWA manifest（可加到主屏，站名「ScrumWS」）。
- 页面：
  1. **登录**：贴 `swuk_` 登录密钥（复用 `/api/auth/login`），登录态 30 天。
  2. **机器**：`/api/my/machines`；单机直接进看板，多机列表选择；离线机器显示置灰 + 最后在线时间。
  3. **看板**：状态分桶 chips（进行中 / 待处理 / 计划 / 排队 / 已完成）+ 卡片单列流；10s 轮询 `rpc state`。
  4. **详情**：输出流（watch SSE 增量渲染，marked 渲染 markdown）+ 底部消息输入框（`message`）+ 动作条（确认执行 / 中断 / 完成 / 撤回完成）。
  5. **新建**：标题 / prompt / cwd（白名单选择器）/ model / effort / worktree 开关 / 「立即执行 or 存为计划」。

---

## 6. 与并行开发的边界（重要：cloud 端正在并行开发）

| 区域 | 本特性动不动 | 说明 |
|---|---|---|
| `cloud/migrations/` | **不动** | 零新表；不给 task 表加列 |
| `cloud/src/routes/user.js` / `machine.js` | **不动** | 新端点全放新文件 `routes/my.js`、`routes/machine-relay.js` |
| `cloud/src/server.js` | 只加路由注册 + 绊线日志（≤10 行） | |
| `platform/lib/cloud/connector.js` | 只加 downlink 启停挂钩（≤15 行） | 下行逻辑全在新文件 `downlink.js` / `relay-verbs.js` |
| `platform/lib/collect.js` / `task-actions.js` / `session-manager.js` / `logs.js` | **不动** | 只 import 调用 |
| `platform/server.js` | 只加 `/api/cloud/remote-config` GET/POST（~20 行） | |
| `platform/public/app.js` | 设置页云端区块加开关 + 白名单（局部） | |
| 云端 task 派活 / intent / 对账语义 | **完全不碰** | 那是并行 P2 的地盘 |

---

## 7. 验收要点（详见 `docs/acceptance/cloud-mobile-console/`）

安全类：关开关零下行连接；白名单外 cwd 拒绝；非 owner 404；绊线 503；开关热关闭 ≤15s 断连。
功能类：state/detail/log 与本地一致；createTask 落地并真跑；message 双分支（活会话注入 / resume）；watch 增量 ≤3s；断线重连自愈；rpc 超时 504。
不变式类：全程云库 task 表零新增行；本地状态机行为与本地操作完全一致（同一函数）。
UI 类：375px 视口 e2e（登录 → 看板 → 详情 → 发消息 → 新建）。

## 8. 未收敛 / 本期不做

1. **逐字实时流**（session partial 中继）——v1 是 1.5s 轮询尾巴，够用但不是打字机效果。
2. **机器离线时的手机侧体验**只有「离线」占位；离线可见性等 P2 镜像互补，不预做。
3. **推送通知**（任务转 awaiting-human 时通知手机）——需要 Web Push / 常驻 Service Worker，另立特性。
4. **swuk_ 在手机浏览器上的输入体验**（48 字符粘贴）——依赖密码管理器；不做扫码登录（要多一套一次性码端点，先看实际痛感）。
