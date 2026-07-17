# 云端控制面 · 部署 runbook

对应 `cloud/`（Fastify + pg）。设计见 [`../spec/cloud-control-plane.md`](../spec/cloud-control-plane.md)，实现契约见 [`../spec/cloud-p0p1-contract.md`](../spec/cloud-p0p1-contract.md)。

**当前部署形态：内网模式（裸 HTTP）**，见 §1。

---

## 0. 前置

| 项 | 要求 |
|---|---|
| Node | ≥ 20.11 |
| PostgreSQL | 18.3（已有：`115.159.161.47:55432/scrumws`） |
| 凭据 | `DATABASE_URL` 从仓库根 `.env` 注入。**禁止**写进本文件、源码、启动脚本、日志 |

`.env` 已入 `.gitignore`。云端服务只从 `process.env.DATABASE_URL` 读，缺了直接拒绝启动（`cloud/src/db.js:8`）。

---

## 1. 安全姿态：内网模式 ⚠

**已决策（设计 §9 决策 13）：按内网部署配置，即 `CLOUD_INSECURE_COOKIE=1`、不前置 TLS。**

```bash
export CLOUD_INSECURE_COOKIE=1    # 摘掉会话 cookie 的 Secure，裸 HTTP 可用
```

### 这个开关意味着什么

`swuk_` 登录密钥与 `swmt_` 机器令牌**明文过网**。链路上任何人抓到即可完全冒充。

| 阶段 | 泄露后果 | 可接受？ |
|---|---|---|
| **P0+P1（当前）** | 看到全团队任务看板 / 往云端推假状态。**无下行通道 = 无 RCE 面** | 风险有界 |
| **P2 起** | 可给**所有机器**派活 = **全员开发机 RCE**（带 git 凭据、SSH key、`~/.claude` token） | **不可接受** |

### ⚠ P2 绊线（必须实现，别靠人记得）

P2 的意图下行代码上线时，**必须**加这道闸：

> 若 `CLOUD_INSECURE_COOKIE=1` 且服务并非绑在 localhost → **拒绝启动**，而不是打个警告了事。

理由：本决策是在「P1 只读、风险有界」的前提下做的。P2 让前提失效，但那时没人会记得今天设过这个 env。让它在变危险的那一刻**自动失效**，是唯一可靠的兑现方式。这不是保守，是把一个会过期的判断做成代码。

### 若改走公网（推荐）

前置 Caddy 自动签 Let's Encrypt 证书，比自研加密省事得多，且覆盖浏览器登录这条链路：

```caddyfile
cloud.example.com {
    reverse_proxy 127.0.0.1:8790
}
```

然后**去掉** `CLOUD_INSECURE_COOKIE`，并处理 `trustProxy`（见 §5）。

> **为什么不用两端对称加密代替 TLS**：浏览器那条是死结——页面 JS 经 HTTP 送达，路径上的人可直接改写它，在被篡改的代码里做任何加密都是自欺。而 `swuk_` 恰是权限最大的凭据。connector↔云端那条技术上可行，但要自己补齐 TLS 白送的防重放、密钥分发、前向保密，只保护一半链路。详见设计 §7。

---

## 2. 建库与迁移

**首次**（库已存在且为空时跳过建库）：

```bash
# 迁移（幂等性未做，只跑一次；重跑前需 drop schema）
psql "$DATABASE_URL" -f cloud/migrations/001_p0p1_init.sql

# 核实（独立只读命令，不信任上一条的回执）
psql "$DATABASE_URL" -c "\dt"    # 应有 12 张表，含 registration_key
```

本机无 psql 时走 docker：

```bash
docker run --rm postgres:17-alpine psql "$DATABASE_URL" -c "\dt"
```

⚠ 同实例还有 `claude_center` / `novel_writer`，**不要碰**。

---

## 3. 首个用户与密钥

```bash
cd cloud
npm ci
node scripts/bootstrap.mjs --check                    # 零副作用自检，先跑这个
node scripts/bootstrap.mjs --name "你的名字" --slug team --label "我的密码管理器"
```

输出的 `swuk_…` **明文只打印这一次**，立刻存进密码管理器。丢了只能再生成一把。

---

## 4. 起服务

```bash
cd cloud
CLOUD_INSECURE_COOKIE=1 npm start     # 监听 0.0.0.0:8790
```

启动日志会打出当前安全姿态。看到这行说明开关生效了：

```
[cloud] CLOUD_INSECURE_COOKIE=1：会话 cookie 已摘掉 Secure，允许裸 HTTP。…
```

**没看到 = 开关没生效**，此时裸 HTTP 上登录会静默坏掉（返回 200 但 cookie 没存下 → 下一个请求 401）。

冒烟：

```bash
curl -s http://<host>:8790/api/health     # → {"ok":true}
```

---

## 5. 已知的部署待决

1. **`trustProxy` 未开**（`cloud/src/server.js:22`）。开了就等于信任任意客户端的 `X-Forwarded-For`，限流 key 可被伪造。代价是**前置反代时限流按反代 IP 聚合成全局 10/5min**。收口反代方案时要一起定：要么在反代层做限流，要么开 `trustProxy` 且确保它只信任自己那一跳。**当前无反代，不构成问题。**
2. **限流状态在进程内**，多实例不共享。当前单实例，暂不构成问题。
3. **Postgres `55432` 公网可直连**。云端服务上线后应收口到只对它开放。属部署收口，没人做就是个洞。
4. **无 Dockerfile / docker-compose**。当前靠 `npm start` 裸跑，没有进程守护、没有开机自启、没有日志轮转。要长期跑得补。

---

## 6. 机器纳管（怎么把一台开发机接进来）

1. 浏览器开 `http://<host>:8790` → 用 `swuk_` 登录
2. 「机器纳管」页 → 生成**注册密钥 `swrk_`**（实例级，一把管全体，明文只此一次）
3. 同页生成**配对码**（8 位，TTL 10 分钟，单次使用，绑生成者 = 该机器的 owner）
4. 页面就地拼出 **join token**（`swjt_…`），一键复制

   > join token 只能在浏览器拼——服务端库里只剩 sha256，拿不到 rk 明文。刷新页面即丢，只能重新生成。
5. 桌面 app → 设置 → 云端 → 粘 join token（自动拆成三个字段）→ 连接
6. 回云端「机器」页，应看到该机器 **online**

**机器归首次 enroll 时生成配对码的那个人**（设计 §9 决策 12），重注册不改归属，且当前无转移路径。

---

## 7. 回滚

云端是**只读镜像**，停掉它不影响任何机器上的任务执行——这是「本地权威」的直接推论。

```bash
# 停服务：本地看板照常跑，任务照常执行，只是不再上报
pkill -f "node src/server.js"        # 或按 PID 定点收

# 解绑单台机器：桌面 app → 设置 → 云端 → 解绑（删本地 identity.json）
# 或云端撤销该机器的 machine_token

# 撤销注册密钥：只挡新机器入场，不影响已在线机器（它们靠机器令牌活着）
```
