#!/usr/bin/env bash
set -Eeuo pipefail

REPO="${RED_BLACK_REPO:-1075375006/red-black-record}"
BRANCH="${RED_BLACK_BRANCH:-main}"
INSTALL_DIR="${RED_BLACK_DIR:-$HOME/red-black-record}"
WEB_PORT="${RED_BLACK_PORT:-4399}"

if [[ "$(uname -s)" != "Darwin" ]]; then echo "此脚本仅适用于 macOS。Linux 请使用 install-server.sh。"; exit 1; fi
command -v curl >/dev/null 2>&1 || { echo "未检测到 curl，请先安装 Xcode Command Line Tools。"; exit 1; }

# 部分网络的 IPv6 或 Docker Hub 连接不稳定，统一使用 IPv4 并增加可恢复重试。
curl_download() {
  local url="$1" output="$2"
  local retry_flags=(--retry 5 --retry-delay 2 --retry-max-time 600)
  # --retry-all-errors 仅在较新的 curl 中提供，旧版 macOS curl 不使用该参数。
  local curl_help
  curl_help="$(curl --help all 2>/dev/null || true)"
  if [[ "$curl_help" == *"--retry-all-errors"* ]]; then
    retry_flags+=(--retry-all-errors)
  fi
  curl -4fL --connect-timeout 20 --max-time 300 \
    "${retry_flags[@]}" \
    "$url" -o "$output"
}

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
archive_urls=(
  "${RED_BLACK_ARCHIVE_URL:-https://codeload.github.com/${REPO}/tar.gz/refs/heads/${BRANCH}}"
  "https://github.com/${REPO}/archive/refs/heads/${BRANCH}.tar.gz"
)
downloaded=0
for archive_url in "${archive_urls[@]}"; do
  if curl_download "$archive_url" "$tmp_dir/project.tgz"; then downloaded=1; break; fi
  echo "下载失败，正在尝试备用地址…" >&2
done
(( downloaded == 1 )) || { echo "无法下载项目源码，请检查网络，或设置 RED_BLACK_ARCHIVE_URL 后重试。"; exit 1; }
tar -xzf "$tmp_dir/project.tgz" -C "$tmp_dir"
cp -a "$tmp_dir/$(basename "$REPO")-${BRANCH}"/. "$INSTALL_DIR"/
cd "$INSTALL_DIR"

pull_image() {
  local image="$1"
  echo "正在准备镜像 ${image} …"
  docker pull --quiet "$image"
}

if [[ -n "${RED_BLACK_NODE_IMAGE:-}" ]]; then
  NODE_IMAGE="$RED_BLACK_NODE_IMAGE"
else
  node_images=(
    "node:22-alpine"
    "mirror.gcr.io/library/node:22-alpine"
    "docker.m.daocloud.io/library/node:22-alpine"
    "dockerproxy.net/library/node:22-alpine"
  )
  NODE_IMAGE=""
  for candidate in "${node_images[@]}"; do
    if pull_image "$candidate"; then NODE_IMAGE="$candidate"; break; fi
    echo "镜像 ${candidate} 拉取失败，尝试备用镜像…" >&2
  done
  [[ -n "$NODE_IMAGE" ]] || { echo "无法拉取 Node.js 镜像。可设置 RED_BLACK_NODE_IMAGE 后重试。" >&2; exit 1; }
fi
export NODE_IMAGE
if [[ -n "${RED_BLACK_POSTGRES_IMAGE:-}" ]]; then
  POSTGRES_IMAGE="$RED_BLACK_POSTGRES_IMAGE"
else
  postgres_images=(
    "postgres:16-alpine"
    "mirror.gcr.io/library/postgres:16-alpine"
    "docker.m.daocloud.io/library/postgres:16-alpine"
    "dockerproxy.net/library/postgres:16-alpine"
  )
  POSTGRES_IMAGE=""
  for candidate in "${postgres_images[@]}"; do
    if pull_image "$candidate"; then POSTGRES_IMAGE="$candidate"; break; fi
    echo "镜像 ${candidate} 拉取失败，尝试备用镜像…" >&2
  done
  [[ -n "$POSTGRES_IMAGE" ]] || { echo "无法拉取 PostgreSQL 镜像。可设置 RED_BLACK_POSTGRES_IMAGE 后重试。" >&2; exit 1; }
fi
export POSTGRES_IMAGE
echo "正在拉取镜像并启动服务…"
"${COMPOSE[@]}" up -d --build
"${COMPOSE[@]}" ps
echo "部署完成。访问地址：http://127.0.0.1:${WEB_PORT}"
