# Provider 与运行时体验改造（桌面端）

## 目标与范围

本轮只修改 Electron 桌面端及本地 `platform/` 服务：

1. 新建任务的 Provider 改为项目自绘选择面板，不使用浏览器原生 select。
2. Codex 提供固定快捷模型 `gpt-5.6`、`gpt-5.5`、`gpt-5.4`、`gpt-5.4-mini`，仍保留 CLI 默认与自定义 model；
   reasoning effort 使用 Codex CLI 支持的 `none/minimal/low/medium/high/xhigh/max/ultra`。
3. 运行时卡自身展示该运行时的账号用量和启停控制；移除活跃会话数。
4. 原独立账号用量卡替换为全 Provider、最近 7 天的新建任务数折线图。
5. 添加本机 CLI 会话同时扫描 Claude Code 与 Codex CLI，Codex 以只读观察态展示。
6. 面向用户的泛指文案使用“运行时 / Agent / CLI 会话”，仅在行为或协议确实专属时保留具体名称。

云端与手机端不在范围内。

## 当前事实

- Provider 目录已支持 Claude/Codex，但 Codex 只有空模型列表和自定义模型。
- 运行时页把 Claude 账号用量拆成独立卡片，且卡片含活跃会话数；启停不存在。
- Claude CLI 历史在 `~/.claude/projects/<project>/<uuid>.jsonl`；Codex 真实历史在
  `~/.codex/sessions/YYYY/MM/DD/rollout-...-<thread-id>.jsonl`，首行 `session_meta.payload` 有 `session_id` 和 `cwd`。
- Claude JSONL 包含注册表、turn_duration、后台任务等专属语义；Codex rollout 不具备同构终端占用/rewind 语义。

## 设计

### Provider 选择与模型

- 新建任务使用 `button + listbox`，键盘可聚焦、Esc 关闭、点击外部关闭；隐藏 input 仅作为程序值载体，不使用原生 select UI。
- 选择面板每项显示运行时名称、命令和能力摘要；禁用的运行时不能被选择。
- 模型/effort 菜单继续从 registry 读取。Codex 固定模型优先显示，CLI 默认和“输入自定义 model”作为附加项。

### 运行时开关

- 配置新增 `providerEnabled: { claude: boolean, codex: boolean }`，缺失项解释为 `true`。
- `POST /api/providers/<provider>/enabled` 只改本地配置；关闭后不再允许新建 provider session/恢复会话，不强杀已经运行的会话。
- runtime 探测的“CLI 可用”与“已启用”分离呈现：缺 CLI 是离线，手动关闭是已停用。

### 运行时页

- 每个 provider 运行时卡展示版本、路径、状态、启停按钮；支持账号用量的 provider 将其用量条放在本卡内。
- 移除活跃会话数及其后端聚合。
- `dailyCreated` 是所有未迁移任务包按 `createdAt` 聚合的最近 7 个本地日期；归档任务仍计入创建当天。
- 独立“账号用量”卡改为“新建任务趋势”折线图；原每日 token 趋势和用量汇总保留。

### 本机 CLI 会话

- watchlist entry 增加 `provider`（旧 entry 缺失按 Claude）。
- Claude 继续现有完整观察/收养路径。
- Codex 新增独立 rollout 扫描器，支持 recent/search/add/read-only 卡片；不提供 Claude 专属收养、rewind、后台任务解析或终端进程判定。
- 两类观察卡沿用 `cli:<short>` 的既有任务键格式；完整 session id 和 provider 存在 watchlist 元数据中，详情读取时以该元数据分派解析器。

## 验收

- registry 校验 Codex 固定模型、全部 effort 与禁用 runtime 拒绝创建会话。
- provider 启停 HTTP 契约、旧 config 兼容、运行时 dailyCreated 聚合。
- Claude/Codex CLI session fixture：recent/search/add/collect/provider 字段与 Codex 只读能力。
- 浏览器验收自绘 Provider 面板、Codex 模型、runtime 卡/开关、7 日折线图、CLI 弹窗 provider 筛选。
- 既有 provider、external API、replan 回归继续通过。
