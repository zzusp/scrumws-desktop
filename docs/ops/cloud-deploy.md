# 云端控制面 · 部署 runbook

对应 `cloud/`（Fastify + pg）。设计见 [`../spec/cloud-control-plane.md`](../spec/cloud-control-plane.md)，实现契约见 [`../spec/cloud-p0p1-contract.md`](../spec/cloud-p0p1-contract.md)。

**当前部署形态：内网模式（裸 HTTP），已上线** → http://115.159.161.47:8790

| 项 | 值 |
|---|---|
| 服务器 | `ubuntu@115.159.161.47:22`（口令在仓库根 `server_info.txt`，已入 .gitignore） |
| 应用目录 | `/opt/scrumws-cloud/`（对照物：`/opt/claude-center/`） |
| 容器 | `scrumws-cloud`，`restart: unless-stopped` + HEALTHCHECK |
| 端口 | 8790（腾讯云安全组需放行；3000/8787 是 claude-center 的，勿动） |
| Postgres | 宿主机 55432，**不在 compose 内** |

⚠ **部署源不走 GitHub**：国内服务器对 `github.com:443` 普遍不通。本地打 bundle → scp → `rsync --delete --exclude=.env`。抄自 claude-center 的同款设计。

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

### ⚠ P2 绊线（判据已按用户决策修订，2026-07-17）

原设计是「`CLOUD_INSECURE_COOKIE=1` + 非 localhost → 拒绝启动」。**用户明确要求改判据**：明知服务在公网裸 HTTP 上，仍要 P2 能跑，不接受被拒绝启动。

修订为**显式确认**而非拒绝：

> P2 意图下行上线时，`CLOUD_INSECURE_COOKIE=1` + 非 localhost **不阻止启动**，但必须另设
> `CLOUD_ACCEPT_PLAINTEXT_DISPATCH=1` 才放行下行；缺它则只起 P0+P1 只读面，下行端点返回 503。

**为什么不整个删掉**：绊线的用途不是拦人，是**防止有前提的判断被静默继承**。决策 13 是在「P1 只读、风险有界」下做的，P2 让前提失效。删掉 = 那个前提永远消失，几周后没人记得公网裸 HTTP 曾经只是因为「反正只读」才被接受。

改成第二把显式开关，两个性质都保住：P2 能跑（用户要的），且开它的人必须**亲手写下** `ACCEPT_PLAINTEXT_DISPATCH`——那一刻他知道自己在接受什么，而不是无意中继承了几周前为「只读」做的决定。

**部署 P2 时对应的 compose 改动**：

```yaml
environment:
  - CLOUD_INSECURE_COOKIE=1
  - CLOUD_ACCEPT_PLAINTEXT_DISPATCH=1   # P2 起必须显式加；不加则下行 503，只读面照常
```

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

## 2.5 部署 / 发版

一条龙：`cloud/deploy-on-server.sh`（build → up → 健康检查 → 清理悬空镜像）。**在开发机跑这三条**：

```bash
# 1) 打 bundle（务必排除 node_modules 与 .env）
cd <repo>
tar -czf /tmp/scrumws-cloud-deploy.tar.gz --exclude=node_modules --exclude=.env -C cloud .

# 2) 传 bundle + 部署脚本（脚本单独传，避免「先 rsync 才能拿到新脚本」的鸡生蛋——抄 claude-center）
scp -P 22 /tmp/scrumws-cloud-deploy.tar.gz ubuntu@115.159.161.47:/tmp/
scp -P 22 cloud/deploy-on-server.sh        ubuntu@115.159.161.47:/tmp/

# 3) 执行
ssh -p 22 ubuntu@115.159.161.47 'bash /tmp/deploy-on-server.sh 0.1.0 /tmp/scrumws-cloud-deploy.tar.gz'
```

Windows 上没有 sshpass，用 PuTTY 的 `pscp` / `plink -pw`。**注意**：Git Bash 的 `/tmp` 是 MSYS 虚拟路径，`pscp` 这类原生 Windows 程序不认，要给真实路径；`tar` 则相反，`C:/...` 会被当成远程主机名，要用 `/c/...` 形式。

脚本会自检：缺 bundle / 缺 `.env` / 版本号格式不对都直接退出。健康检查 60s 不过就打印容器日志并退出非零。

**上线后独立核实**（别信脚本自己的回执）：

```bash
docker ps --filter name=scrumws-cloud --format '{{.Names}} | {{.Status}}'   # 应 (healthy)
docker logs scrumws-cloud 2>&1 | grep -i insecure                            # 确认安全姿态符合预期
curl -s http://<公网IP>:8790/api/health                                       # → {"ok":true}
curl -s -o /dev/null -w '%{http_code}' http://<公网IP>:8790/api/machines      # → 401（鉴权真的挡着）
```

⚠ 最后两条**必须从公网打**，不能只在服务器内部 `127.0.0.1` 上 curl——首次上线就栽过：容器内部一切正常，公网却因安全组没放行 8790 而不通。

---

## 3. 首个用户与密钥

在服务器上经容器跑（镜像里已有依赖，无需 npm ci）：

```bash
# 零副作用自检，先跑这个：连库 + 验表齐全 + 打印将要做什么，不写任何行
docker exec scrumws-cloud node scripts/bootstrap.mjs   --name "你的名字" --workspace "工作区名" --slug team --check

# 确认自检说的是「新建」而不是「复用」再执行
docker exec scrumws-cloud node scripts/bootstrap.mjs   --name "你的名字" --workspace "工作区名" --slug team --label "我的密码管理器"
```

- `--workspace` **必填**；workspace 名含中文时 slugify 结果为空，**必须**显式给 `--slug`
- 同名 + 同 workspace 视为同一个人 → 只补发密钥（自检会显示「复用」）
- 输出的 `swuk_…` **明文只打印这一次**，立刻存进密码管理器。丢了只能再生成一把

> ⚠ 裸 HTTP 下（决策 13），你**用浏览器登录的那一刻这把密钥就明文过网了**。若它还经过别的渠道（终端记录、聊天、agent transcript），登录后立刻在管理页生成第二把、撤销第一把。

---

## 4. 起服务

日常部署走 §2.5 的 `deploy-on-server.sh`（build + up + 健康检查一条龙）。手工起停：

```bash
cd /opt/scrumws-cloud
docker compose up -d cloud      # CLOUD_INSECURE_COOKIE=1 已写死在 compose 的 environment
docker compose logs -f cloud
docker compose restart cloud
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
4. ~~无 Dockerfile / docker-compose~~ → **已补**（`cloud/Dockerfile`、`cloud/docker-compose.yml`、`cloud/deploy-on-server.sh`）。进程守护与开机自启由 `restart: unless-stopped` 兜底；**日志轮转仍未配**（docker 默认 json-file 无上限，长期跑会涨满盘，需设 `log-opts max-size`）。

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

## 6.5 ⚠ 首次上线时踩的：库里可能有 agent 自测残留的**活凭据**

2026-07-17 首次部署后发现：真实 `scrumws` 库里不是空的，有 6 台假机器（`SELFTEST-PC` / `GUARD-PC` / `X`）、6 条重复假任务、**7 把未撤销的 `swrk_`** 和 1 把 `swuk_`——全是开发期云端服务端 agent 自测时打进真实库的（后来的实跑 agent 才改用一次性验证库）。

**当时无害**（库只有内网 Postgres 能碰），**服务一上公网就成了活凭据**：拿那把 `swuk_` 可直接登录，拿 `swrk_` 可往里注册机器。

**上线前必查**：

```bash
psql "$DATABASE_URL" -c "select key_prefix, label, revoked_at is not null revoked from registration_key"
psql "$DATABASE_URL" -c "select key_prefix, label from user_key"
psql "$DATABASE_URL" -c "select display_name, hostname from machine"
```

见到 `自测` / `SELFTEST-PC` / `origin-guard` 这类 label 就是开发残留。确认无真实数据后清库重来：

```bash
psql "$DATABASE_URL" -c "drop schema public cascade; create schema public;"
psql "$DATABASE_URL" -f cloud/migrations/001_p0p1_init.sql
```

**教训**：凭据的危险性不是固有属性，是**部署形态的函数**。同一把密钥，内网库里躺着无害，服务上公网那一刻就变成了洞。**每次改变暴露面（内网→公网、加端口、加反代），都要重新过一遍"现存凭据在新形态下意味着什么"。**

## 7. 回滚

云端是**只读镜像**，停掉它不影响任何机器上的任务执行——这是「本地权威」的直接推论。

```bash
# 停服务：本地看板照常跑，任务照常执行，只是不再上报
cd /opt/scrumws-cloud && docker compose down

# 回退到上一版镜像（build 过的旧 tag 还在本地）
docker compose down && APP_VERSION=<旧版本> docker compose up -d cloud

# 解绑单台机器：桌面 app → 设置 → 云端 → 解绑（删本地 identity.json）
# 或云端撤销该机器的 machine_token

# 撤销注册密钥：只挡新机器入场，不影响已在线机器（它们靠机器令牌活着）
```
