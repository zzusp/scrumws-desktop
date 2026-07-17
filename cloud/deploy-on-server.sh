#!/usr/bin/env bash
# 在服务器上执行的部署脚本。照 claude-center 的 scripts/deploy-on-server.sh 模式。
#
# 关键设计（抄 claude-center，理由同）：服务器**不依赖** GitHub 出站连通
# （国内服务器对 github.com:443 普遍不通），部署源是本地打包、scp 上来的 tarball。
#
# 假设：
#   - /opt/scrumws-cloud/.env 存在（含 DATABASE_URL），权限 600（一次性放好）
#   - 宿主机已装 docker + docker compose v2
#   - postgres 跑在宿主机 :55432（容器经 host.docker.internal 走 host-gateway 访问）
#
# 用法：bash deploy-on-server.sh <X.Y.Z> [bundle.tar.gz]
set -Eeuo pipefail

APP_VERSION="${1:-${APP_VERSION:-}}"
BUNDLE="${2:-/tmp/scrumws-cloud-deploy.tar.gz}"
APP_DIR="${APP_DIR:-/opt/scrumws-cloud}"

if [[ -z "$APP_VERSION" ]]; then
  echo "[deploy] 用法：bash deploy-on-server.sh <X.Y.Z> [bundle.tar.gz]"; exit 2
fi
if [[ ! "$APP_VERSION" =~ ^[0-9]+\.[0-9]+\.[0-9]+$ ]]; then
  echo "[deploy] APP_VERSION 格式错误（应为 X.Y.Z）：$APP_VERSION"; exit 2
fi
if [[ ! -f "$BUNDLE" ]]; then
  echo "[deploy] 缺 bundle：$BUNDLE"; exit 2
fi
if [[ ! -f "$APP_DIR/.env" ]]; then
  echo "[deploy] 缺 $APP_DIR/.env（含 DATABASE_URL）。先一次性放好，权限 600。"; exit 1
fi

echo "[deploy] === scrumws-cloud v$APP_VERSION → $APP_DIR ==="

# 1) 解压到临时区
stage="$(mktemp -d)"
cleanup() { rm -rf "$stage"; }
trap cleanup EXIT
tar -xzf "$BUNDLE" -C "$stage"

src="$stage"
if [[ ! -f "$src/docker-compose.yml" ]]; then
  wrap="$(find "$stage" -mindepth 1 -maxdepth 1 -type d | head -1)"
  if [[ -n "$wrap" && -f "$wrap/docker-compose.yml" ]]; then
    src="$wrap"
  else
    echo "[deploy] bundle 解压后找不到 docker-compose.yml"; ls -la "$stage"; exit 1
  fi
fi

# 2) rsync 替换 APP_DIR，保留 .env
rsync -a --delete --exclude='.env' "$src/" "$APP_DIR/"
cd "$APP_DIR"
chmod 600 .env

# 3) build + up
export APP_VERSION
echo "[deploy] docker compose build cloud"
docker compose build cloud
echo "[deploy] docker compose up -d cloud"
docker compose up -d cloud

# 4) 健康检查。/api/health 无鉴权，200 即就绪
echo "[deploy] 等待 cloud 就绪（最多 60s）"
for i in $(seq 1 12); do
  code="$(curl -s -o /dev/null -m 3 -w '%{http_code}' http://127.0.0.1:8790/api/health || echo 000)"
  if [[ "$code" == "200" ]]; then
    echo "[deploy] cloud OK (HTTP $code)"; break
  fi
  if [[ $i -eq 12 ]]; then
    echo "[deploy] cloud 未就绪（最后 HTTP $code）"
    docker compose logs --tail=60 cloud
    exit 1
  fi
  sleep 5
done

# 5) 清理悬空镜像
docker image prune -f >/dev/null 2>&1 || true

echo "[deploy] === v$APP_VERSION 部署完成 ==="
