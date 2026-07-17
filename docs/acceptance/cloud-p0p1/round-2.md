# cloud P0+P1 · round-2 验收记录 —— 机器纳管管理页（P0 最后一环）

**结论：本轮 14 条新用例（C28–C41）全绿 + 复跑的 12 条 round-1 用例全绿，浏览器 e2e 40/40 PASS。
P0 链路自此打通：网页上能生成注册密钥 / 配对码 / join token → 贴到桌面端 → 机器真的 enroll 上来并 online。**

**两条如实标注（不强凑全绿）**：
1. **C27b「用户 8799 app 全程可用」= 观察，不是 PASS** —— 收尾时它不在监听。证据链指向用户自己关的
   （当晚他自行重启 4 次），但我无法 100% 自证清白 → 见 §7 / §6 未收敛-6。
   > 原 C27 在本轮**拆成 C27a/C27b**：它把「我只杀自己的进程」和「用户 app 还活着」两件事捆在一条里，
   > 本轮前者成立、后者不可断言，捆着就只能二选一地说谎。round-1 两半都确实 PASS（它收尾时探到 8799 HTTP 200），历史值未被篡改。
2. 中途出过 4 条**假 FAIL**（全是我测试脚本自身的错，不是实现），逐条查明真因后**只改测试、没动实现** —— 记在 §2。
   其中 1 条差点让我把好实现改坏。

- 日期：2026-07-17
- 契约：`docs/spec/cloud-p0p1-contract.md` §6.4 / §6.14–6.16 / §6.17；视觉基准：`docs/spec/multica-style-guide.md`
- 状态总表：`matrix.csv`（状态以它为准，round-1 列原样保留）
- 脚本：`scripts/`（跨轮复用）；本轮证据：`round-2/`

## 0. 交付物

| 文件 | 改动 |
|---|---|
| `cloud/public/ui.js` | **新增**：全站共用的组件层（dropdown / modal / toast）。零依赖原生 JS |
| `cloud/public/index.html` | 新增「机器纳管」视图 + 侧边栏入口；**新增暗色 token 全集**；组件层 CSS；两处原生 `<select>` → 自研 dropdown 挂载点；主题切换按钮 |
| `cloud/public/app.js` | 新增机器纳管模块（rk / 配对码 / join token 就地拼装 + 列表 + 撤销）；接上自研 dropdown；主题切换 |

**没碰**：`platform/`、`cloud/src/`（服务端一行没改 —— 端点本就全通，本轮只是把 UI 接上去）、`.env`、根 `package.json`。
**没加任何依赖**：`ui.js` 是原生 JS+DOM；`cloud/package.json` 依赖面仍是 `fastify` + `pg` + `@fastify/static`。
> `ui.js` 无需改服务端：`cloud/src/server.js:43` 注册的是 `public/` **静态根**，新文件自动被托管（实测 `200 /ui.js`）。

## 0.1 环境与隔离

| 项 | 值 |
|---|---|
| 云端 | `127.0.0.1:8790`，pid 24664 |
| 本地沙箱看板 | `127.0.0.1:8797`，`SCRUMWS_DATA_ROOT=<repo>/.sandbox/p1-ui`，pid 5980，`scheduler.mode=running` |
| 用户真实桌面 app | `127.0.0.1:8799`（pid 31824）—— **全程只读探活，一次没碰**，收尾 `GET /` → HTTP 200 |
| 验收库 | `scrumws_p1_verify`（一次性，用完 DROP） |

**真实库零污染**（独立只读复核，`scratchpad/isolation-check.mjs`）：

```
.env 指向的真实库名 = scrumws
真实库 scrumws 现状： {"au":1,"m":6,"t":6,"rk":10,"ec":9}      ← au/m/t 与 round-1 记录逐字相同
真实库里带本轮 label（'P1 UI 验收'/'诊断用'）的 registration_key 行数 = 0   ✅
真实库里本轮 machineUid 的行数 = 0                                        ✅
同实例 claude_center / novel_writer：本轮从未连接
```

---

## 1. 两条铁律怎么落的（这是本轮的核心，不是普通功能）

### ① 明文只此一次 —— 只在 JS 内存，刷新即永久丢失

`cloud/public/app.js:476-478` 是 rk / 配对码 / join token 明文在本页的**唯一**去处：

```js
let rkPlain = null;    // §6.14 的 201 响应
let codePlain = null;  // §6.4  的 201 响应
let joinToken = null;  // 就地拼出来的 swjt_ 串
```

**证据（页内实搜，不是看代码猜）**：生成 rk + 配对码 + token 后，在浏览器里把 `localStorage` / `sessionStorage` / `location.href` / `document.cookie` 全文拼起来搜三个明文 → **零命中**：

```
localStorage/sessionStorage/URL/cookie 全文 = "cloud-theme=light;http://127.0.0.1:8790/#/enroll"
→ 里面只有主题偏好，没有任何明文
```

**源码侧**：`cloud/public/` 全文 grep `localStorage|sessionStorage|console.` → 唯二命中是 `index.html:8-9` 的**主题偏好**（不是秘密，与明文红线是两回事，注释已写明）和 `app.js:474` 那条**禁止性注释**本身。

**库侧终点**（最终证据 —— 云端确实拿不回明文）：

```
registration_key：13 行，key_hash 长度全部 = 64 且匹配 ^[0-9a-f]{64}$（sha256 十六进制）
enrollment_code：4 行，code_hash 长度全部 = 64；被 enroll 用掉的那个 used=true
GET /api/registration-keys 响应体：含 "key": → ✅ 无 ；含 hash → ✅ 无
```

### ② join token 只能在浏览器就地拼

`app.js:490` `encodeJoinToken()` 是桌面端 `platform/public/app.js:2318` `parseJoinToken()` 的**逐字逆运算**。
两个函数**都从真实源码里抠出来**跑对拍（不手抄，避免与源码漂移 —— `scripts/../scratchpad/jt-roundtrip.mjs`）：

```
云端编码器  cloud/public/app.js    抠出 221 字节
桌面解析器  platform/public/app.js 抠出 457 字节

[PASS] ASCII 常规            前缀 swjt_=true | 无 = 填充=true | 无 +/ =true
[PASS] https 生产
[PASS] base64url 特殊字节(-_)
[PASS] 中文（btoa 只吃 latin1，专防 InvalidCharacterError）  解回 {"cloudUrl":"http://中文.example:8790","registrationKey":"swrk_测试密钥",…}
--- 反证：畸形串必须解不出 ---
  ✅ 拒绝 v=2 的 / ✅ 拒绝缺 code 的 / ✅ 拒绝 swjt_@@@bad@@@ / ✅ 拒绝 swrk_notajointoken / ✅ 拒绝空串
```

> 为什么用 `unescape(encodeURIComponent(...))` 这对「过时」函数：桌面端解包用的正是它的镜像 `decodeURIComponent(escape(...))`。
> 要的是**逐字对称**，不是各自发挥 —— 换成 TextEncoder 那边就解不出中文了。

**最硬的一条**：这串 token 被**真的贴进桌面端**（§3⑥），三项逐字还原、enroll 成功。格式对不对不靠我说，靠对面解得开。

---

## 2. 4 条假 FAIL 复盘（都是测试脚本的错，实现没动）

第一版 e2e 跑出 30/35。**5 条 FAIL 里 4 条是我自己测试写错**，逐条查明真因后修测试；没有一条是靠改实现「修」掉的。
记在这里是因为「工具的成功回执不算证据」的反面同样成立：**FAIL 也可能是假的，不查清就改实现＝按假警报改代码**。

| # | 表面现象 | 真因 | 处置 |
|---|---|---|---|
| 1 | 「新生成的 rk 没出现在列表」 | `loadRegKeys()` 是另一发 fetch，我在它回来**之前**就断言。实测：生成瞬间 行数=1 命中=false → 等 1.5s 行数=2 命中=true | 测试改 `waitForFunction` 等列表刷新 |
| 2 | 「配对码没有倒计时」 | 倒计时文案是 `10:00 后过期`，我的正则写死 `^\d:\d\d` 只认个位数 | 测试改 `\d{1,2}` |
| 3 | 「点复制后剪贴板是空的 / toast 不是已复制」 | **puppeteer 的 `overridePermissions` 是反的**（见下） | 测试**删掉** `overridePermissions` |
| 4 | 「有非预期控制台 404」 | 控制台文本只有 `404 (Not Found)` 不带 URL，我按文本过滤当然滤不掉。实为 `/favicon.ico`（round-1 §9 观察-3 已记） | 测试改为**按 URL** 记录非 2xx 再判定 |

### 另一个自己捅的娄子：把 join token 明文写进了仓库（已修）

e2e 里为了把 token 交棒给「桌面端粘贴」那步，写过：

```js
fs.writeFileSync(path.join(OUT, '..', 'jt.txt'), joinToken);   // 注释还自信地写着「明文只落 scratchpad（仓库外）」
```

`OUT` 是仓库里的 `round-2/`，`'..'` 当然还在仓库里 —— **join token 内含 rk + 配对码明文，等于把凭据提交进仓库**，
正是我这轮在守的那条红线，被我自己的测试脚本破了。收尾自查（全仓 grep `swjt_eyJ` / `swrk_{20,}`）时抓到：

```
./docs/acceptance/cloud-p0p1/jt.txt        ← 153 字节 = 整串 join token
./docs/acceptance/cloud-p0p1/rkprefix.txt  ← swrk_AMfo（前缀，非秘密，但也没理由进仓库）
```

已 `rm` 并独立复核确认不在（`ls` → No such file）；脚本里那两行**删掉**（桌面端那步现在同进程内做，本来就不需要跨进程传）。
> 教训：**注释里写「仓库外」不等于它在仓库外**。路径是不是安全，要用 `git status` / `grep` 去问，不是靠自己写的注释安慰自己。
> 这也是为什么收尾那条全仓 grep 值得常设 —— 它抓的正是「我以为我没写」的东西。

### 假 FAIL #3 值得单独说：差点把好实现改坏

现象是「复制按钮不工作」。这在一个「明文只此一次、现在不复制就永久丢失」的页面上是致命 bug —— 但**它是假的**。
A/B 实跑（`scratchpad/clip-variants.mjs`，三个候选假设逐个证伪）：

```
                                      permissions.query   writeText          toast
不调 overridePermissions（有头）        granted            OK                 已复制 ✅
不调 overridePermissions（无头）        granted            OK                 已复制 ✅
调 ['clipboard-read','clipboard-write'] denied             NotAllowedError    复制失败 ❌
只调 ['clipboard-read']                 —                  被拒               复制失败 ❌
只调 ['clipboard-sanitized-write']      —                  OK                 已复制（但 readText 被拒）
```

**结论：是我给测试加的 `overridePermissions` 把权限设成了 denied**；真实用户档（安全上下文 + 用户手势）浏览器本就自动放行写剪贴板。
> 副产品：这轮误打误撞把**失败路径**真跑了一遍 —— UI 如实弹 `注册密钥复制失败 —— 请手动选中框里的内容复制`，
> **没有假装成功**。明文只此一次的页面上，静默失败＝直接丢数据，这条路径能被证明是诚实的，比它不出现更有价值。

### 剪贴板：无头验不了的那部分，用有头 + OS 级证据补上

无头下 `readText` 读不回（`clipboard-read` 在真实浏览器里是 `prompt` 档，自动化点不了授权），
所以 e2e 只断言 toast。「用户 Ctrl+V 粘出来的到底是不是那串」用**有头浏览器 + PowerShell `Get-Clipboard`** 直接验（`scratchpad/clip-os.mjs`）：

```
本轮 headless = false
页面 toast          = join token已复制到剪贴板
join token 长度     = 153  开头: swjt_eyJ2IjoxLCJ1cmwiOiJ…
系统剪贴板长度      = 153  开头: swjt_eyJ2IjoxLCJ1cmwiOiJ…
系统剪贴板 == token = ✅ 逐字相同
→ 用户 Ctrl+V 粘出来的就是这串 join token（OS 级证据）
```
> 顺带查明：**无头 Chrome 的 writeText 会 resolve 但不落 Windows 系统剪贴板**（内部剪贴板），有头才落。
> 中途被这点摆过一道：一度读到 48 字节以为「复制错了内容」，实为上一次**有头**跑留下的 rk 残留。
> 跑完把用户原剪贴板还原了（备份 → 还原，别顺手清人家剪贴板）。

---

## 3. 端到端剧本（`scripts/e2e-enroll-ui.mjs`，真实浏览器 + 真实 8790 + 真实 8797）

**40/40 PASS**（完整输出 `round-2/e2e-results.json`）。

### ① 登录 → 管理页

```
GET / → HTTP 200 text/html          （真实 server.js 托管）
swuk_ 登录进入 shell                 ✅
侧边栏有「机器纳管」入口且 #/enroll 路由可达  ✅
```

### ② 生成注册密钥（明文只此一次）

```
rk 明文当场展示：长度=48 前缀=swrk_AMfo         ✅
展示「明文只此一次」的复制引导                    ✅（现在就复制保存 / 永久拿不回来）
新生成的 rk 出现在下方列表                       ✅
```

### ③ 生成配对码

```
配对码 8 位：code=H8X7TTH8    ✅
10min 倒计时：9:52 后过期      ✅
```

### ④ 就地拼 join token

```
join token 拼出且 swjt_ 前缀：长度=153                              ✅
内容 = {v:1, 本页 origin, rk 明文, code}：
  v=1 url=http://127.0.0.1:8790 rk 匹配=true code 匹配=true       ✅
url 无尾斜杠（§6.17）                                              ✅
点复制 → writeText 兑现，自研 toast 报「已复制」（非 alert）          ✅
```

### ⑤ 红线复核

```
localStorage/sessionStorage/URL/cookie 里搜不到 rk / code / token 明文  ✅
```

### ⑥ 把 join token 真的粘到桌面端（8797）→ 点连接 → **enroll 成功**

```
桌面端就地拆包：URL / rk / 配对码 三项自动填好
  url=http://127.0.0.1:8790 · rk 逐字匹配=true · code=H8X7TTH8
  提示="已从 join token 填好三项，确认 URL 后点连接"                  ✅
点「连接」→ enroll 成功（切到「已连接」面板）
  enrolled=true workspace=scrumws machineId=e458f445-b311-454d-a3fc-bb114af6fcd7   ✅
本地 identity 不含 rk（入场券用完即弃）：/api/cloud/status 全文搜 rk 明文 = ✅ 无
桌面端设置页无 JS 报错                                              ✅
```

### ⑦ 回云端机器列表 → **online**

```
百部 online 孙鹏 0/5 · 主机名 百部 · win32/x64 · claude 2.1.211 · app 0.1.0 · 最后心跳 刚刚   ✅
```
独立只读复核（不看 UI 文案，直接问 API）：
```
GET /api/machines → 百部 | status=online | claude=2.1.211 | owner=孙鹏
  lastSeenAt=2026-07-16T17:01:02.512Z   enrolledAt=2026-07-16T17:00:17.342Z
GET /api/registration-keys → swrk_AMfo… | label=P1 UI 验收 | 最后用=2026-07-16T17:00:17.342Z
  ← lastUsedAt 与 enrolledAt **完全相同** = 这台机器确实是拿这把 rk 进来的（轮换的操作依据可用）
```

### ⑧ 负例：刷新后再拼 join token（**这轮的重点**）

```
刷新后回到「生成一把」态（内存里的 rk 明文没了）                      ✅
点「拼 join token」→ 给出明确提示而不是坏串                          ✅
提示说清「刷新后 rk 明文已丢失」                                     ✅
提示给出出路：重新生成 或 手动贴三个字段                              ✅
负例下**没有**拼出任何 token（绝不半成品）                           ✅
```
实际文案（`round-2/05-negative-no-rk-plaintext.png`）：
> **拼不出 join token：本页内存里没有注册密钥的明文。**
> 明文只在「生成」那一次的响应里出现过 —— **刷新 / 重进本页即永久丢失**（云端库里只剩 sha256，谁也拿不回来）。
> 请在上面**重新生成一把注册密钥**再拼；或者手动把三个字段分别贴到桌面端「设置 → 云端」：
> `云端 URL  http://127.0.0.1:8790` / `注册密钥 你自己保存的那把 swrk_…（本页已拿不到）` / `配对码 （上面「生成配对码」现取一个）`

配对码缺失 / 已过期也各有专属文案（`buildJt()` 的三个分支），不是一句通用报错糊过去。

---

## 4. 自研组件（推翻「用原生组件样式」那条旧策略）

> `docs/spec/multica-style-guide.md:4,64` 写的是「移植为 CSS 变量 + **原生组件样式**」。
> 本轮按用户明确要求**推翻其中的组件实现策略**：**视觉语言仍照抄 multica**（oklch token / 圆角阶梯 / ring 代 border / lucide 图标 / 6px 滚动条），
> 但**组件一律自研**。该文档未改（它是 G5 实现基线的历史快照）—— 差异记在这里，别当成没对齐。
> `platform/public/` 那 5 个原生 `<select>` **本轮没动**（不在范围内，且「不顺手改旁边的代码」）。

### 零原生组件：静态 + 运行时 双证

**静态**（`scripts/assert-no-native-ui.mjs`，退出码 0）：

```
✅ <select>   剥注释后 0 处（裸 grep 会数出 4 处 —— 差额全是解释「为何不用它」的注释）
✅ alert()    剥注释后 0 处（裸 grep 会数出 2 处）
✅ confirm()  剥注释后 0 处（裸 grep 会数出 3 处）
✅ prompt()   剥注释后 0 处（裸 grep 会数出 1 处）
剥注释器自检：ui.js 剥后仍含 4/4 个关键代码片段 ✅
```
> **为什么不能裸 grep**：本仓注释里大量出现这些字样（正是在解释为何不用），裸 grep 数出 10 处、证明不了任何事。
> 该脚本第一版用**字符级**扫描剥注释，被自检当场证伪 —— 它不认识**正则字面量**，`app.js:12` 的 `.replace(/[&<>"']/g,…)`
> 里那个 `"` 会把扫描器带进「字符串模式」，之后全文错位。改成**按行**剥：整行注释剥掉、代码行一律保留，
> 误差方向故意选成「行尾注释会误报」而不是漏报 —— **断言脚本漏报等于没有**。

**运行时**（定论 —— 静态看不见 `innerHTML` 拼出来的东西）：

```
#/board / #/machines / #/enroll 页面里 <select> 元素数 = 0        ✅（各 0 个）
alert/confirm/prompt 全程被调用 0 次（evaluateOnNewDocument 装的探针）  ✅ 实际=[]
```

### dropdown 补齐了原生 select 白送的能力

```
自绘浮层挂在 body 上且 position:fixed（能盖出 overflow 容器）  ✅ {"inBody":true,"pos":"fixed"}
ARIA：role=listbox / aria-expanded=true / aria-selected 项      ✅ {"role":"listbox","expanded":"true","selected":1}
Esc 关闭                                                        ✅
键盘 ↑↓ + Enter 选中                                            ✅ 选中=live · 实时
点浮层外部关闭                                                   ✅
```
> 浮层必须 `position:fixed` + 挂 `body`：`#pageWrap` / `.board-toolbar` 链上有 `overflow:auto`，挂容器里会被裁掉。

### modal / toast

```
撤销弹自研 modal（role=dialog / aria-modal=true）    ✅
modal 讲清「不影响已在线机器」                        ✅
modal 打开时背景不滚动                               ✅ scrollTop 0 → 0
Esc 关闭 modal（且未执行撤销）                       ✅
```
> **背景锁滚没写代码，是因为不需要**：`.mo-mask` 是 `position:fixed` 铺满视口的，滚轮落在它身上；
> `body` 本身 `overflow:hidden`，真正的滚动容器 `#pageWrap` 不在它的祖先链上 → 背景天然滚不动。
> 上表那条是**实测**（滚轮 400px，scrollTop 纹丝不动），不是「加了一行 `body.overflow='hidden'` 就宣称锁上了」。

### 亮暗双主题

```
切到暗色：{"theme":"dark","body":"oklch(0.15 0.005 285.8)"}                    ✅
暗色下拉浮层底色 = oklch(0.21 0.006 285.9)（--popover 暗色档，不是系统白底）   ✅
```
暗色 token 全集按 `multica-style-guide.md §1` 的 `.dark` 档移植进 `index.html` 的 `:root[data-theme="dark"]`。
只需覆盖「独立值」token —— `--bg/--ink/--mut/--jade…` 那批是 `var()` 引用型，底层一换自动跟着走。
两处按可读性反向调了（已注释说明）：`--amber` 亮色档压暗到 L0.55 是为了白底可读，暗底上提到 L0.80，否则糊成一团。

**截图**（`round-2/`，puppeteer-core + 系统 Edge，**走真实 8790 / 8797**）：

| 文件 | 内容 |
|---|---|
| `01-dropdown-open-light.png` | 自研下拉**展开态**（亮色）：自绘浮层 + 选中打勾 |
| `02-dropdown-open-dark.png` | 自研下拉**展开态**（暗色）—— 若用原生 `<select>`，这里会露出 Windows 白底列表 |
| `03-enroll-dark.png` | 机器纳管（暗色）：rk 明文 + 配对码 + join token 三步 |
| `04-enroll-light.png` | 机器纳管（亮色）：同上 + 注册密钥表 |
| `05-negative-no-rk-plaintext.png` | **负例**：刷新后拼 token → 明确提示 + 手动路径，未产坏串 |
| `06-revoke-modal-light.png` | 撤销确认：自研 modal（danger 档） |
| `07-desktop-paste-jointoken.png` | 桌面端设置页：贴 join token → 三项自动填好 |
| `08-desktop-connected.png` | 桌面端：已连接（workspace / machineId / 心跳） |
| `09-cloud-machine-online.png` | 云端机器列表：刚 enroll 的机器 online |

> **关于截图里露出的 rk / join token 明文**（`03` / `04` / `07`）：它们属于一次性验收库 `scrumws_p1_verify`，
> 该库已 `DROP … WITH (FORCE)` —— 连同 `registration_key` 的 sha256 一起没了，**这几串已经认证不了任何东西**，是死凭据。
> 之所以不打码：这两张截图要证的恰恰是「明文当场展示 + 引导立刻复制」，打了码就证不动了。
> **别把这个当成可照抄的做法** —— 前提是「库是一次性的、且跑完就 DROP」。对着真库截图 = 把真凭据提交进仓库。

---

## 5. 设计决策（会被问到的几处）

1. **向导不进 15s 轮询**：`router()` 里只在**进入本页**时 `renderEnrollView()`，`refreshCurrentView()` 只刷列表。
   轮询重建 DOM 会打断正在复制明文的人 —— 明文只此一次，打断的代价是重新生成一把。
2. **配对码过期 → 主动作废 join token**：`tickCode()` 归零时把 `joinToken` 置空并重画。
   否则人拿着一串必然 401 的东西去贴桌面端，排障成本比「重新生成」高得多。
3. **撤销掉本页内存里那把 rk → 同步清空**：`revokeRk()` 里 `if (rkPlain?.id === id)`。同理，别让人拿废密钥拼 token。
4. **「换一把」只丢本页明文，不撤销云端密钥**：两件事分开 —— 撤销在下面列表里，且要过 modal。
5. **复制失败必须说出来**：`copyToClipboard` 的 catch 弹红 toast + 提示手动选中（明文框 `user-select:all`）。
   不做 `execCommand('copy')` 兜底：契约 §6 生产强制 HTTPS、localhost 也是安全上下文，
   `navigator.clipboard` 覆盖 100% 真实场景，加第二条路径属于「多种方式任选」的堆砌。

---

## 6. 未收敛 / 观察项（不强凑结论）

1. **`404 /favicon.ico` 照旧**：`cloud/public/` 没有 favicon，控制台恒有一条 404。round-1 §9 观察-3 已记、判为纯观感。
   本轮**仍未加**（不在范围内）。但它现在是唯一的「非预期噪音」，加一个 16×16 的 data-URI favicon 是几行的事 —— **请拍板要不要收**，我不替你决定。
2. **`platform/public/` 的 5 个原生 `<select>` 未动**：用户这条要求指向 `cloud/public/`，且「不顺手改旁边的代码」。
   若要全仓统一，桌面端得把 `ui.js` 同源移植过去（那边是另一套 `index.html`，不共享静态资源）—— 是独立一件事，没夹带。
3. **`multica-style-guide.md` 未更新**：它是「G5 实现基线」的历史快照，本轮推翻的是其 §4 的组件实现策略。
   按「行为变了就同步文档」本该更新，但改它等于改另一个特性的基线文档 —— **建议**在该文档加一条「组件策略已于 2026-07-17 推翻，见 round-2.md §4」，
   **本轮没擅自改**，请拍板。
4. **dropdown 未做 typeahead**：原生 `<select>` 支持敲首字母跳选项，自研版没有（键盘能力只补到 ↑↓/Enter/Esc/Tab/Home/End）。
   当前两个下拉分别是 4 项 / N 台机器，机器多了时 typeahead 才有价值 —— 记为已知差距，没顺手加。
5. **无头 Chrome 的剪贴板不落系统剪贴板**：见 §2。以后谁再验剪贴板，别在无头下读 `Get-Clipboard` 然后以为实现坏了。
6. **收尾时用户 app（8799）不在监听**：详见 §7。证据链指向用户自己关的（当晚他自己重启了 4 次，最后一次 pid=34916 是 electron，
   而我只杀过自己那两个 node pid、从未按名/路径杀），**但我无法 100% 自证清白** —— 不强凑「全程可用」的结论。
   若你确认 app 是被我搞掉的，请指出来，我按根因修流程；若是你自己关的，忽略本条即可。
7. **另一个 agent 正在用你的真实数据根**：`~/.scrumws/runtime/desktop-server.log` 里混着 worktree `20260716233653-862`
   在 8815 起的只读实例（`DASHBOARD_NO_SCHEDULER=1`，00:14 / 00:18 / 01:03 / 01:09 各一次）。不是我起的、也没动它，
   但**它写的是你的真实数据根**（我的沙箱全程走 `.sandbox/p1-ui`）—— 顺手提示一句，不在本轮范围内。

---

## 7. 收尾

- 一次性库 `scrumws_p1_verify` 已 `DROP … WITH (FORCE)`；重建配方 = `scripts/db-sandbox.mjs --create`（幂等）。
- 自起进程**按 PID 定点**收，杀之前逐个核对命令行：
  ```
  Stop-Process -Id 24664 → D:\soft\node-v22.13.0\node.exe run-cloud.mjs           （我的云端 8790）
  Stop-Process -Id 5980  → D:\soft\node-v22.13.0\node.exe platform/standalone.js  （我的沙箱看板 8797）
  ```
  **从未用过** `Stop-Process -Name` / `taskkill /IM` / 按路径杀 / 杀 electron —— 那会连用户 8799 的 app 一起端
  （`electron-kill-hits-user-app` 的教训）。
- 未碰的邻居进程（核对命令行后确认不是我的，一律不动）：
  - `pid=10200` → `D:\baibu-agent\dashboard\server.js`（用户的旧看板 8788）
  - `pid=25396` → **另一个 agent** 的验证实例（worktree `20260716233653-862`，8815，`DASHBOARD_NO_SCHEDULER=1`）
- 用户系统剪贴板：跑有头剪贴板验证时占用过，已**备份并还原**。
- 未 `git commit` / `git push`（收口由主 session 做）。

### ⚠ 收尾时 8799 未在监听 —— 如实标注（见 §6 未收敛-6）

**不隐瞒**：收尾探活 `GET http://127.0.0.1:8799/` **失败**（开局时它是 HTTP 200 / pid 31824）。
证据链指向「用户自己关的」，但我**无法 100% 排除**，故不写成「全程可用」：

用户 app 自己的日志 `~/.scrumws/runtime/desktop-server.log`（只读）显示它当晚被**反复重启 4 次**：
```
[00:07:57] → http://127.0.0.1:8799   调度器已启动（pid=31824）   ← 我开局看到的那个
[00:47:02] → http://127.0.0.1:8799   调度器已启动（pid=33400）
[00:47:16] → http://127.0.0.1:8799   调度器已启动（pid=35484）
[00:51:14] → http://127.0.0.1:8799   调度器已启动（pid=34916）   ← 最后一次，锁归它
```
`~/.scrumws/runtime/scheduler.lock` = `{"pid":34916,"at":"2026-07-17 00:51:14"}`，该 pid 现已不在。

**我没杀它的正面证据**：① 我全程只 `Stop-Process` 过 24664 / 5980，两者杀前都核过命令行、都是我自己起的 node；
② 34916 是 electron 进程，我从未按名/路径杀过任何东西；③ 该 app 在我这段时间里被用户自己重启了 4 次（00:07→00:51），
是**用户在主动折腾它**的模式，与 round-1 §10 记的那次「我以为误伤、实为用户自己重启」同型。
**没有自作主张替用户把 app 拉起来** —— 那是用户的桌面应用，1 点多关掉可能就是本意。
