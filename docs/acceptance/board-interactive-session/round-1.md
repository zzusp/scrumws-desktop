# Round 1 · S11 前置验证（macOS 侧 + dws 关系定性）

日期：2026-07-12。环境：macOS Ventura 13.7.8，claude 2.1.207。
脚本：`scripts/verify-modeb.mjs`（跨平台，同一脚本待 Windows 侧复跑）。

## 目的

S11 的两个前置：① dws 分身鉴权与 claude 的前置关系；② Windows 侧 Mode B 命令实测。
本轮在 macOS 完成①的定性 + ②的**脚本自证**（同脚本交 Windows 复跑）。

## 验证一：dws 与 claude 鉴权的关系（定性，证据侧）

**结论：dws 是 claude 当作工具调用的分身 API（发钉钉 / 列会话），不是 claude 的模型鉴权器。**

证据：
- `D:\baibu-agent/runtime/dispatchers/issue-watch.mjs:38` 注释原文："dws 授权闸门（issue-worker 内
  **claude 会调 dws 发钉钉**，链条起点熔断）"。
- `chat-watch.mjs:21-22` `dwsAuthGate` 在 spawn worker 前置检查 dws 自身是否 authed，避免会话中途
  claude 跑 `dws` 弹浏览器/失败。
- macOS 本机**未跑任何 dws**，claude 直接跑通 haiku（冒烟 system/init + assistant 正常）。

**对 Mode B 的含义**：
- claude 模型鉴权：走 claude 自己的 `~/.claude` 凭据，**永远需要**（等同终端登录态），与 dws 无关。
- dws-auth：**仅**对"会话内要用 dws 工具（钉钉/分身 API）"是前置；沿用现有 `dwsAuthGate` 即可。
- ⇒ Mode B 跑交互 claude **不以 dws 为前置**；只有分身 DingTalk 类任务才叠加 dws 闸门。

## 验证二：Mode B 命令 flag + 权限委派（macOS，PASS）

`node scripts/verify-modeb.mjs` 完整冒烟输出 **8/8 PASS**：

```
== A. claude 版本 + flag ==  claude 2.1.207
  [PASS] --include-partial-messages / --input-format / --output-format / --resume / --verbose
  note: --permission-prompt-tool 不在 help（hidden），实测生效
== B. --permission-prompt-tool stdio 权限委派冒烟 ==
  [PASS] B1 flag stdio 被接受（未报 unknown option）
  [PASS] B2 吐 can_use_tool control_request — tool_use=Write
  [PASS] B3 工具在授权前未执行（目标文件未创建）
```

即：喂一条 stream-json user 消息 → claude 触发 Write → 吐 `control_request/can_use_tool` →
**停下等 control_response，目标文件未创建**。权限委派在 macOS/2.1.207 成立。

## 验证二（Windows 侧）：待用户复跑

同一脚本跨平台，Windows 生产机执行：

```powershell
node docs\acceptance\board-interactive-session\scripts\verify-modeb.mjs          # 完整冒烟
node docs\acceptance\board-interactive-session\scripts\verify-modeb.mjs --check   # 零副作用，只查 flag
```

把输出贴回即可。关注点：
- A 段 flag 是否齐（Windows 的 claude 版本可能不同）。
- B 段是否同样 8/8 PASS（尤其 B2 吐 can_use_tool、B3 文件未创建）。
- C 段 dws auth status（Windows 有 dws，应打印真实 authenticated/token_valid）。

## 盲点 / 未收敛

- Windows 侧 B 段**尚未实测**（macOS 已 PASS，但目标运行时是 Windows）。
- `--permission-prompt-tool` 为 hidden flag，跨版本稳定性未知（当前 2.1.207 生效）。
- Windows 的 `claude` 是否为 `claude.cmd`、PATH 是否可直接 spawn，需 Windows 侧确认。
