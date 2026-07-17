# plan：外部任务 API（带 apikey 鉴权）+ API 密钥管理页

## 需求

外部系统（钉钉群消息派发器、issue 检查派发器、未来任意发起端）能安全地向桌面端**发起任务**与**查询任务状态**：

- 有鉴权（API key），key 可在桌面端菜单页里生成/禁用/删除，每个 key 对应一个来源（source）。
- 外部推入的任务**默认落 plan 桶**（人工确认后才执行）。
- 幂等：同一外部事件（同一条钉钉指令 / 同一个 issue）重复调用不重复建任务。

## 现状（摸底结论）

- 本地 server：原生 node:http，`platform/server.js`，bind `127.0.0.1`（:19），端口 `SCRUMWS_PORT||8799`，if 链路由，**零鉴权**（安全模型=只听 localhost）。
- 任务创建唯一入口 `createTask()`（`platform/lib/task-actions.js:423`）：写任务包 `runtime/runner-state/<source>__<slug>/`（task.json+state.json），`plan:true`/`planSources`/`scheduledAt` → plan 桶；source 仅是元数据（架构不变量，不特判）。
- key 铸造/校验模式可参考 `cloud/src/auth.js`（`mintCredential`：`<prefix>_`+base64url(32B)，只存 sha256，明文只回一次）。本地 platform 无现成鉴权件。
- 前端：vanilla JS SPA（`platform/public/index.html` + `app.js`），hash 路由，`ROUTE_VIEWS`（app.js:1062）+ topnav（index.html:739）加页即可。
- 共享配置在数据根 `runtime/runner-config.json`（`platform/lib/runner-config.js`）。

## 方案

### 1. API key 模块 `platform/lib/api-keys.js`（新建）

- 存储 `P.tmpDir/api-keys.json`：`{ keys: [{ id, label, source, prefix, hash, createdAt, disabled, lastUsedAt }] }`。
  - `id`：短随机 id；`label`：人读备注；`source`：该 key 建任务的来源标签（复用 createTask 的 source 校验规则）；`prefix`：明文前 12 字符（列表展示用）；`hash`：sha256(明文) hex。**不存明文**。
- `createApiKey({label, source})` → 铸 `swak_<base64url(32B)>`，返回 `{entry, plaintext}`（明文只此一次）。
- `listApiKeys()` / `setApiKeyDisabled(id, disabled)` / `deleteApiKey(id)`。
- `verifyApiKey(authorizationHeader)`：解析 `Bearer swak_…`，sha256 后 `timingSafeEqual` 逐条比对；禁用/未命中 → 拒；命中刷 `lastUsedAt`。

### 2. 外部任务模块 `platform/lib/external-ingest.js`（新建）

- 去重台账 `P.tmpDir/external-ingest.json`：`{ "<source>:<externalKey>": { taskKey, createdAt } }`。
- `createExternalTask(key, payload)`：
  - `externalKey`（可选，≤200 字符）命中台账且任务包仍在（runner-state 或 archive）→ `{ok:true, existed:true, taskKey, state}`；任务包已被删 → 掉台账重建。
  - 未命中 → `createTask({source: key.source, plan: payload.plan === false ? false : true, title, prompt, model, cwd, effort, description, externalKey})`（**source 强制取 key 绑定值**，请求里的 source 忽略；缺省 plan）→ 记台账。
- `externalTaskStatus(key, {taskKey?, externalKey?})`：externalKey 经台账解析；校验任务 source === key.source（跨 source 一律 404，不泄露存在性）；返回 `{ok, taskKey, state, outcome, title, createdAt, resolvedAt}`（读 task.json+state.json）。
- `createTask` 增加可选参数 `externalKey`：仅透传写入 task.json（追溯用），不影响行为。

### 3. server.js 路由（if 链里加 6 条）

| 路由 | 鉴权 | 说明 |
|---|---|---|
| `GET /api/apikeys` | 无（同现有本机管理面） | 列表（永不回明文/hash） |
| `POST /api/apikeys/create` | 无 | body `{label, source}` → `{ok, key, plaintext}` |
| `POST /api/apikeys/toggle` | 无 | body `{id, disabled}` |
| `POST /api/apikeys/delete` | 无 | body `{id}` |
| `POST /api/external/task/create` | Bearer swak_ | body 同 /api/task/create 减 source 加 externalKey；缺省 plan |
| `GET /api/external/task/status?taskKey=…\|externalKey=…` | Bearer swak_ | 只能查本 source 任务 |

鉴权失败统一 `401 {ok:false, error:'unauthorized'}`。管理端点与现有全部端点一致走"只听 127.0.0.1"安全模型；外部端点额外要 key，为的是**来源身份可信**（key→source）+ 将来若开放监听面也有闸。

### 4. 「API 密钥」菜单页（index.html + app.js）

- topnav「平台」组加 `<a href="#/apikeys">`；新增 `#view-apikeys`。
- 页面：新建表单（备注 label + 来源 source）→ 明文一次性展示（复制按钮 + curl 示例）；key 列表（prefix…、source、label、创建时间、最近使用、状态），行内 禁用/启用、删除（确认）。
- app.js：`ROUTE_VIEWS` 加 `apikeys`、路由分支、进页拉取列表。

### 5. 文档

`docs/api/task-ingest.md` 增「外部 API（带鉴权）」章节：端点契约、apikey 页面用法、externalKey 幂等语义、错误表、curl 示例。

### 6. baibu-agent 对接（Phase B，另见 goal.md G7）

- 改 `D:\baibu-agent\runtime\dispatchers\chat-watch.mjs`：检测逻辑（3 会话+同事白名单、孙鹏 `cc:`、水位）不动；命中后由「建本地任务包+spawn watch-worker.ps1」改为 **POST 桌面端 /api/external/task/create**（externalKey=`chat-<convKey>-<触发消息createTime>`，prompt 带会话上下文与回复指引），成功才推水位；失败不推水位（消息不丢）、记日志。
- 改 `issue-watch.mjs`：gh 轮询+指纹+「已有人处理」判据不动；命中后改 POST（externalKey=`issue-HiQ-AI-feedback-<n>`，一 issue 一任务）；指纹改存 `runtime/dispatch-issue/dispatched/<n>.json`。
- 配置 `D:\baibu-agent\runtime\scrumws-ingest.json`：`{baseUrl, apiKey}`；缺失/HTTP 失败 → fail-soft（日志+跳过，不推水位）。
- 切换时序（现场按 ground truth）：停 chat-watch → 改码 → 对测试服务器验证 → 铸真实 key 写配置 → 桌面端跑上新代码后恢复 enabled。

## 改动清单（预估）

- 新建：`platform/lib/api-keys.js`、`platform/lib/external-ingest.js`
- 修改：`platform/server.js`（+6 路由）、`platform/lib/task-actions.js`（createTask +externalKey 透传）、`platform/public/index.html`、`platform/public/app.js`、`docs/api/task-ingest.md`
- baibu-agent（仓外）：`runtime/dispatchers/chat-watch.mjs`、`issue-watch.mjs`、新配置文件

## 验证（隔离环境）

`node platform/standalone.js` + `SCRUMWS_PORT=18799` + `SCRUMWS_DATA_ROOT=<scratch>`（不碰用户真实 8799/~/.scrumws）。用例见 matrix.csv：key 全生命周期、鉴权正反例、建任务落 plan、幂等去重、跨 source 查询隔离、UI 冒烟（puppeteer-core+系统 Edge）。**不 e2e 验 plan:false 自动起会话**（会真烧 claude 额度；该路径全量复用既有 createTask queued 逻辑，已被现有功能覆盖）。
