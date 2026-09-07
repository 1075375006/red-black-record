#!/usr/bin/env bash
set -Eeuo pipefail

REPO="${RED_BLACK_REPO:-1075375006/red-black-record}"
BRANCH="${RED_BLACK_BRANCH:-main}"
INSTALL_DIR="${RED_BLACK_DIR:-/opt/red-black-record}"
WEB_PORT="${RED_BLACK_PORT:-4399}"

if [[ "$(id -u)" -ne 0 ]]; then
  echo "请使用 root 运行，或执行：sudo bash -c \"curl -fsSL https://raw.githubusercontent.com/${REPO}/${BRANCH}/install-server.sh | bash\""
  exit 1
fi

if ! command -v docker >/dev/null 2>&1; then
  if command -v apt-get >/dev/null 2>&1 && command -v curl >/dev/null 2>&1; then
    echo "未检测到 Docker，正在自动安装 Docker Engine…"
    curl -fsSL https://get.docker.com | sh
    systemctl enable --now docker 2>/dev/null || true
  else
    echo "未检测到 Docker，且当前系统无法自动安装。请先安装 Docker Engine。"
    exit 1
  fi
fi

if docker compose version >/dev/null 2>&1; then
  COMPOSE=(docker compose)
elif command -v docker-compose >/dev/null 2>&1; then
  COMPOSE=(docker-compose)
else
  if command -v apt-get >/dev/null 2>&1; then
    echo "正在安装 Docker Compose Plugin…"
    apt-get update
    apt-get install -y docker-compose-plugin
    COMPOSE=(docker compose)
  else
    echo "未检测到 Docker Compose，请安装 Docker Compose Plugin 后重试。"
    exit 1
  fi
fi

command -v curl >/dev/null 2>&1 || { echo "缺少 curl，请先安装 curl。"; exit 1; }
mkdir -p "$INSTALL_DIR"
tmp_dir="$(mktemp -d)"
trap 'rm -rf "$tmp_dir"' EXIT

echo "正在下载 ${REPO}@${BRANCH} …"
curl -fL --retry 3 "https://github.com/${REPO}/archive/refs/heads/${BRANCH}.tar.gz" -o "$tmp_dir/project.tgz"
tar -xzf "$tmp_dir/project.tgz" -C "$tmp_dir"
source_dir="$tmp_dir/$(basename "$REPO")-${BRANCH}"

if [[ -f "$INSTALL_DIR/docker-compose.yml" ]]; then
  echo "保留现有 Docker 数据卷，更新应用文件。"
fi
find "$INSTALL_DIR" -mindepth 1 -maxdepth 1 ! -name 'docker-compose.yml' -exec rm -rf {} +
cp -a "$source_dir"/. "$INSTALL_DIR"/
cd "$INSTALL_DIR"

port_in_use() {
  if command -v ss >/dev/null 2>&1; then
    ss -ltnH | awk -v port="$1" '$4 ~ (":" port "$") { found=1 } END { exit found ? 0 : 1 }'
    return $?
  fi
  return 1
}

while port_in_use "$WEB_PORT"; do
  WEB_PORT=$((WEB_PORT + 1))
done
export WEB_PORT

echo "正在拉取镜像并启动服务…"
"${COMPOSE[@]}" up -d --build
"${COMPOSE[@]}" ps

server_ip="$(hostname -I 2>/dev/null | awk '{print $1}')"
echo
echo "部署完成。"
echo "实际端口：${WEB_PORT}"
echo "本机访问：http://127.0.0.1:${WEB_PORT}"
[[ -n "$server_ip" ]] && echo "局域网访问：http://${server_ip}:${WEB_PORT}"
echo "更新命令：curl -fsSL https://raw.githubusercontent.com/${REPO}/${BRANCH}/install-server.sh | sudo bash"
