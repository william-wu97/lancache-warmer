# ============================================================
#  标准镜像构建方式（适用于支持 build 的环境）
#
#  NAS 的 compose 不支持 build:，那边用 deploy/docker-compose.yaml
#  （node 镜像 + 挂载代码 + start.sh）。这个 Dockerfile 是给
#  Docker Hub / K8s / 普通 VPS 用的。
# ============================================================
FROM node:24-bookworm-slim

WORKDIR /app

# 先只拷依赖清单，利用层缓存：代码改动不会触发重装依赖
COPY package.json package-lock.json* ./
RUN npm ci --omit=dev --no-audit --no-fund || npm install --omit=dev --no-audit --no-fund

COPY src ./src
COPY web ./web
COPY deploy ./deploy

# 数据目录：游戏库、凭据、图标缓存
RUN mkdir -p /app/data /cache

ENV NODE_ENV=production \
    PORT=8080 \
    DATA_DIR=/app/data \
    CACHE_DIR=/cache

EXPOSE 8080

# 非 root 运行
USER node

CMD ["node", "src/server.js"]
