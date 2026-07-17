# 云端控制面（Fastify + pg）。照 claude-center 的部署模式：镜像在服务器上 build，
# postgres 走宿主机 55432（不进 compose），.env 由 ops 维护在 /opt/scrumws-cloud/.env。
#
# 单阶段：本服务没有构建步骤（原生 JS + 原生前端，零编译），多阶段只会徒增复杂度。
FROM node:22-alpine

WORKDIR /app

# 先装依赖再拷源码：源码变动不会让 npm ci 层失效
COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force

COPY src ./src
COPY public ./public
COPY scripts ./scripts
COPY migrations ./migrations

# 非 root 运行：node:alpine 自带 uid 1000 的 node 用户
USER node

ENV NODE_ENV=production
EXPOSE 8790

# HEALTHCHECK 走 /api/health（无鉴权、不碰 DB 以外的东西）。
# 用 node 而非 curl：alpine 基镜像没有 curl，装它只为健康检查不值当。
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:8790/api/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["node", "src/server.js"]
