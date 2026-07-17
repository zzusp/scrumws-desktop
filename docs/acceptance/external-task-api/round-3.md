# round-3（2026-07-17）：策略语义改「必选」（全不选 = 没有权限）· 全绿

用户修正 round-2 的策略语义：三项白名单（可用模型 / 可用 effort / 可访问目录）**必选**——全不选不是"不限"而是"没有权限"。

## 改动

- `api-keys.js`：createApiKey 三项缺任一 → 拒建（`allowedModels 必选…` / `allowedEfforts 必选…` / `allowedCwds 必填…`）；条目恒存三数组。
- `external-ingest.js`：resolveAgainstPolicy 先查缺项——缺任一（含旧格式无策略存量钥）→ `400 该密钥未配置…（策略必选=无权限），请在「API 密钥」页重新生成`。
- UI：三项标注必选/必填；前端提交前拦一道（后端仍强制）；「限制」列对旧格式钥显示「未配置（无权限）」琥珀 tag（原「不限」文案随语义废除）。
- 文档 task-ingest.md 同步。

## 证据（r6 隔离实例）

- **API 33/33 PASS**：新增 A7（缺 models/efforts/cwds 三连拒建 400）、P7 改造（注入旧格式无策略钥 → 建任务 400「未配置…无权限」）；A2/A3 等全部建钥用例携全策略复测；P3 用例自身补全 models/efforts 后真正命中相对路径校验（首跑 FAIL 为用例 bug，产品校验正确）。
- **UI 6/6 PASS**：新增 U2a（全不选 → 前端必选报错可见、无明文框）+ U2b（补全策略 → 生成成功）；截图复核（必选文案、旧格式钥「未配置（无权限）」tag）。
- **本轮修出一个真实 UI bug**：`.form-err` 类自带 `display:none`，原代码 `style.display=''` 显示错误等于没显示（round-2 前从未走过错误路径故未暴露）——三处改 `'block'`，U2a 由 FAIL 转 PASS。
- 生产两把钥均带全策略，不受旧格式拒绝影响；baibu 派发器显式传策略内值，行为不变（无需重跑派发器 e2e）。
