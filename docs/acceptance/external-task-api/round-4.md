# round-4（2026-07-17）：allowQueued 直执权限 + 密钥编辑 / 复制 · 全绿

用户增量需求：① 密钥可配置「能否直接写任务进 queued」（不经确认执行）；② 已有密钥可编辑修改；③ 支持复制已有密钥。

## 语义

- **allowQueued（默认关）**：关闭时该密钥显式传 `plan:false` 一律 `400 该密钥不允许直接排队执行…`（只能建 plan 任务）；开启才可直进 queued 自动执行。缺省 plan:true 不受影响。
- **编辑**（`POST /api/apikeys/update`）：改 label / source / 三项策略 / allowQueued，走与 create 同一套校验（validateKeyConfig 共用）；密钥本体（prefix/hash）与 createdAt / disabled / lastUsedAt 不动。
- **复制**：明文只存 sha256 不可复原，「复制」= 按现有配置回填表单克隆生成**新**密钥（新明文只显示一次）。纯前端回填，无新端点。

## 证据（r7/r7b 隔离实例，PATH 无 claude——Q2 会真建 queued 任务触发 spawn，子进程秒死零副作用）

- **API 37/37 PASS**：新增 Q1（未开 allowQueued 传 plan:false → 400）、Q2（开了 → 200，响应 state=processing、磁盘初态 queued——直执链路真实走通）、Q3（编辑：越界 400 → update 扩白名单 → 同请求 200，label 更新）、Q4（update 缺策略 / 未知 id → 400）；A2 增 allowQueued 回显断言。
- **UI 8/8 PASS**：新增 U6（编辑：回填 label/勾选/目录、按钮变「保存修改」、保存后行更新且**不产新明文**）、U7（复制：回填 label 带「副本」、生成克隆新钥）；U5 改为循环删除全部冒烟钥。截图复核（执行权限勾选、行内编辑/复制按钮、「直执」琥珀标识、备注列宽修正）。
- **用例竞态修复**（首跑 U3 FAIL 为用例 bug）：明文框先渲染、列表刷新是其后异步，原等待条件"table 存在"会撞旧 table 假过——改等「目标行出现」。产品代码无返工。
- **生产 chat 钥已补 `allowQueued:true`**（写后读回校验防心跳并发覆盖；issue 钥保持 false）——本 PR 合并 + 桌面端重启后 chat 直执无缝，不会出现 400 断流窗口。
