# 红黑记录

一个轻量的足球预测记录网页：同步竞彩比赛，记录胜平负/让球方向和备注，赛果回来后自动判定红黑。

## 管理员认证

所有预测写入和代理配置操作都需要管理员登录。首次启动会创建默认账户 `admin` / `admin123456`，请立即访问 `/change-password.html` 修改密码。

- 首页：`http://localhost:4399/`
- 登录：`http://localhost:4399/login.html`
- 代理设置：`http://localhost:4399/proxy-admin/`

## 一键部署

### Linux 服务器

```bash
curl -fsSL https://raw.githubusercontent.com/1075375006/red-black-record/main/install-server.sh | sudo bash
```

脚本自动准备 Docker 并启动主站、代理网关和 PostgreSQL。默认安装目录 `/opt/red-black-record`，默认端口 `4399`，端口占用时自动递增。更新部署时重复执行即可。脚本会保留 `.env` 中已有设置，并为网关生成随机令牌和代理密码加密密钥。

### Windows

启动 Docker Desktop 后双击 `install.bat`，或运行：

```powershell
powershell -ExecutionPolicy Bypass -File .\install.ps1
```

### macOS

```bash
curl -4fL --retry 5 https://raw.githubusercontent.com/1075375006/red-black-record/main/install-mac.sh | bash
```

默认安装目录 `~/red-black-record`，默认端口 `4399`，被占用时自动递增。

### 手动 Docker 启动

```powershell
docker compose up -d --build
```

停止服务使用 `docker compose down`。**不要运行 `docker compose down -v`，该命令会删除数据库和网关配置数据卷。**

## 国外服务器访问体彩 API

体彩比赛和赛果接口只允许国内网络访问。项目使用独立的 `proxy-gateway` 容器管理上游出口。代理只用于服务端访问 `webapi.sporttery.cn` 的比赛与赛果 API，不转发网页流量、数据库连接或其他请求；网关端口只在 Docker 内部开放。

管理员登录后，从首页点击“代理设置”，可访问 `/proxy-admin/` 添加、修改、测试、启用或停用 SOCKS5/SOCKS5h 代理，也可调整优先顺序、查看运行状态和请求日志。关闭全局代理开关时走直连；开启时按优先级使用代理；配置保存后立即生效，无需重启容器。代理列表和开关保存在独立的 `proxy_gateway_data` 数据卷中。

旧版本 `.env` 中的 `UPSTREAM_SOCKS5_PROXY` 会在新网关首次启动时自动导入。首次导入后，后台配置成为唯一来源，后续改 `.env` 不会覆盖后台设置。安装时也可以提供初始代理：

```bash
curl -fsSL https://raw.githubusercontent.com/1075375006/red-black-record/main/install-server.sh \\
  | sudo RED_BLACK_SOCKS5_PROXY='socks5h://用户名:密码@代理地址:代理端口' bash
```

手动 Docker 部署若要保存带认证信息的代理，应在 `.env` 中设置随机 `PROXY_SECRET_KEY`（32 字节十六进制值），并为 `RELAY_TOKEN`、`PROXY_ADMIN_TOKEN` 配置独立随机值。安装脚本会自动生成这些密钥。代理密码采用 AES-256-GCM 加密保存；丢失 `PROXY_SECRET_KEY` 后需重新填写代理密码。

## 功能

- 主项目通过代理网关请求体彩比赛和赛果 API，并添加上游要求的请求头。
- 网关有全局开关、代理列表、优先级故障切换、失败冷却、连通性测试和日志。
- 网关只接受白名单中的 HTTPS 请求，默认仅允许 `webapi.sporttery.cn`。
- PostgreSQL 保存比赛快照、官方赛果和持久化红黑结算状态；浏览器 localStorage 仅作离线兜底。
- 全部页面合并显示 API 当前比赛与数据库历史比赛；待预测只显示未过期、未完赛且未选择方向的比赛。
- 日期按竞彩销售日归档；次日凌晨开球仍归入前一销售日。
- 服务端每小时同步最近 3 天赛果，并在赛果落库后自动结算。

## 技术结构

- `server.js`：主站 HTTP 服务、业务 REST 接口、认证与静态页面。
- `lib/upstream-client.js`：主站到代理网关的上游请求客户端。
- `proxy-gateway/`：独立代理网关、管理 API、管理页面和配置加密存储。
- `public/`：主站前端。
- `docker-compose.yml`：主站、代理网关和 PostgreSQL 服务。
- `install-server.sh` / `install-mac.sh` / `install.ps1`：部署脚本。

## 验证命令

```bash
node --check server.js
node --check lib/upstream-client.js
node --check public/app.js
node --check proxy-gateway/src/index.js
node --check proxy-gateway/src/config-store.js
node --check proxy-gateway/src/relay.js
node --check proxy-gateway/public/admin.js
docker compose config
```
