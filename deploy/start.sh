#!/bin/bash
# ============================================================
#  lancache-warmer 容器启动脚本
#
#  这个镜像基于官方 node:24-bookworm，代码通过卷挂载进来，
#  原因：NAS 的 compose 不支持 build:，只能用现成镜像 + 挂载。
#
#  首次启动会拉代码、装依赖；之后每次启动只做增量。
# ============================================================
set -e

APP_DIR="${APP_DIR:-/app}"
REPO_TARBALL="https://codeload.github.com/william-wu97/lancache-warmer/tar.gz/refs/heads/main"

cd "$APP_DIR"

# ---------- 1. 代码 ----------
# 每次启动都同步到最新：tar 里不含 data/，所以不会碰用户的游戏库和凭据。
# 想锁版本就设 UPDATE_CODE=0。
if [ "${UPDATE_CODE:-1}" != "0" ]; then
    echo "[start] 同步代码到最新"
    if curl -fsSL "$REPO_TARBALL" | tar xz --strip=1 --exclude='.git*' -C "$APP_DIR"; then
        echo "[start] 代码就绪"
    elif [ ! -d "$APP_DIR/src" ]; then
        echo "[start] 拉取代码失败，且本地无代码可回退" >&2
        exit 1
    else
        echo "[start] 拉取失败，继续使用现有代码" >&2
    fi
elif [ ! -d "$APP_DIR/src" ]; then
    echo "[start] UPDATE_CODE=0 但本地没有代码" >&2
    exit 1
fi

# ---------- 2. 依赖 ----------
if [ ! -d "$APP_DIR/node_modules" ] || [ ! -f "$APP_DIR/node_modules/.warmer-ready" ]; then
    echo "[start] 安装依赖（首次较慢，约 1-2 分钟）"
    npm install --omit=dev --no-audit --no-fund
    touch "$APP_DIR/node_modules/.warmer-ready"
fi

# ---------- 3. 数据目录 ----------
mkdir -p "${DATA_DIR:-$APP_DIR/data}"

# ---------- 4. 启动 ----------
echo "[start] 启动服务，端口 ${PORT:-8080}"
exec node "$APP_DIR/src/server.js"
