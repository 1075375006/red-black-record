#!/usr/bin/env bash
set -Eeuo pipefail

REPO="${RED_BLACK_REPO:-1075375006/red-black-record}"
BRANCH="${RED_BLACK_BRANCH:-main}"
INSTALL_DIR="${RED_BLACK_DIR:-$HOME/red-black-record}"
WEB_PORT="${RED_BLACK_PORT:-4399}"

if [[ "$(uname -s)" != "Darwin" ]]; then echo "此脚本仅适用于 macOS。Linux 请使用 install-server.sh。"; exit 1; fi
command -v curl >/dev/null 2>&1 || { echo "未检测到 curl，请先安装 Xcode Command Line Tools。"; exit 1; }

if ! command -v docker >/dev/null 2>&1; then
  if command -v brew >/dev/null 2>&1; then brew install --cask docker; else echo "请先安装 Docker Desktop：https://www.docker.com/products/docker-desktop/"; exit 1; fi
fi
if ! docker info >/dev/null 2>&1; then
  [[ -d "/Applications/Docker.app" ]] || { echo "请先安装 Docker Desktop。"; exit 1; }
  open -a Docker
  for _ in $(seq 1 60); do docker info >/dev/null 2>&1 && break; sleep 2; done
fi
docker info >/dev/null 2>&1 || { echo "Docker Desktop 启动超时，请手动启动后重试。"; exit 1; }

if docker compose version >/dev/null 2>&1; then COMPOSE=(docker compose); elif command -v docker-compose >/dev/null 2>&1; then COMPOSE=(docker-compose); else echo "未检测到 Docker Compose，请更新 Docker Desktop。"; exit 1; fi
port_in_use() { command -v lsof >/dev/null 2>&1 && lsof -nP -iTCP:"$1" -sTCP:LISTEN >/dev/null 2>&1; }
while port_in_use "$WEB_PORT"; do WEB_PORT=$((WEB_PORT + 1)); done
export WEB_PORT

mkdir -p "$INSTALL_DIR"
tmp_dir="$(mktemp -d)"; trap 'rm -rf "$tmp_dir"' EXIT
echo "正在下载 ${REPO}@${BRANCH} …"
curl -fL --retry 3 "https://github.com/${REPO}/archive/refs/heads/${BRANCH}.tar.gz" -o "$tmp_dir/project.tgz"
tar -xzf "$tmp_dir/project.tgz" -C "$tmp_dir"
cp -a "$tmp_dir/$(basename "$REPO")-${BRANCH}"/. "$INSTALL_DIR"/
cd "$INSTALL_DIR"
echo "正在拉取镜像并启动服务…"
"${COMPOSE[@]}" up -d --build
"${COMPOSE[@]}" ps
echo "部署完成。访问地址：http://127.0.0.1:${WEB_PORT}"
