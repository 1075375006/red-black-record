# 红黑记录

一个轻量的足球预测记录网页：同步竞彩比赛，记录胜平负/让球方向和备注，赛果回来后自动判定红黑。

## ⚠️ 管理员认证

项目已集成独立的管理员认证模块，所有写入操作（记录预测、修改记录、清空记录）必须登录后才能进行。

首次启动时，系统会自动创建默认管理员账户：
- 用户名：`admin`
- 密码：`admin123456`

**重要提示**：首次登录后请立即通过 `/change-password.html` 修改密码！

访问路径：
- 首页：`http://localhost:4399/`
- 登录页面：`http://localhost:4399/login.html`
- 修改密码：`http://localhost:4399/change-password.html`

## 一键部署

### Linux 服务器

Ubuntu/Debian 服务器直接执行：

```bash
curl -fsSL https://raw.githubusercontent.com/1075375006/red-black-record/main/install-server.sh | sudo bash
```

脚本会自动下载最新版代码、准备 Docker（缺少时尝试安装）、启动网页和 PostgreSQL。默认安装到 `/opt/red-black-record`，默认端口为 `4399`；若端口被占用，会自动选择下一个可用端口并在输出中显示实际地址。云服务器安全组/防火墙需放行实际端口。

更新部署时重复执行上面的命令即可。Docker volume `redblack_red_black_pgdata` 会保留数据库数据。

### 国外服务器使用 SOCKS5 代理

体彩接口仅对国内网络开放时，可给网页容器配置 SOCKS5 代理。项目只会代理服务端访问体彩比赛和赛果 API，不会代理网页、数据库或其他流量。使用 `socks5://` 即可：

```bash
cd /opt/red-black-record
printf '%s\n' 'UPSTREAM_SOCKS5_PROXY=socks5://用户名:密码@代理地址:代理端口' > .env
docker compose up -d --build
```

也可以在一键部署时传入，安装脚本会把配置保存到安装目录的 `.env`，后续更新仍会保留：

```bash
curl -fsSL https://raw.githubusercontent.com/1075375006/red-black-record/main/install-server.sh \
  | sudo RED_BLACK_SOCKS5_PROXY='socks5://用户名:密码@代理地址:代理端口' bash
```

不设置 `UPSTREAM_SOCKS5_PROXY` 时，网页在本机直接访问体彩接口，不经过代理。代理用户名或密码包含 `@`、`#` 等特殊字符时，请先按 URL 规则编码。

### Windows

启动 Docker Desktop 后，双击 `install.bat`，或在 PowerShell 执行：

```powershell
powershell -ExecutionPolicy Bypass -File .\install.ps1
```

### macOS

安装并启动 Docker Desktop 后，在终端执行：

```bash
curl -4fL --retry 5 https://raw.githubusercontent.com/1075375006/red-black-record/main/install-mac.sh | bash
```

脚本会自动下载最新版代码、启动 Docker Desktop、构建网页和数据库。默认安装到 `~/red-black-record`，默认端口为 `4399`；端口被占用时会自动选择下一个可用端口。

如果上述地址仍无法访问，可改用 jsDelivr CDN 获取安装脚本：

```bash
curl -4fL --retry 5 https://cdn.jsdelivr.net/gh/1075375006/red-black-record@main/install-mac.sh | bash
```

如果所在网络访问 Docker Hub 或 GitHub 不稳定，脚本会自动强制使用 IPv4、重试并切换备用镜像。也可以手动指定镜像：

```bash
RED_BLACK_NODE_IMAGE=mirror.gcr.io/library/node:22-alpine \\
RED_BLACK_POSTGRES_IMAGE=mirror.gcr.io/library/postgres:16-alpine \\
curl -4fL --retry 5 https://raw.githubusercontent.com/1075375006/red-black-record/main/install-mac.sh | bash
```

### 手动 Docker 启动

```powershell
docker compose up -d --build
```

网页和容器内部统一使用 `4399` 端口。查看状态、停止服务：

```powershell
docker compose ps
docker compose down
```

`docker compose down -v` 会同时删除数据库数据，请谨慎使用。

## 功能

- 比赛 API 和赛果 API 由本地 Node 服务转发，并附带竞彩站点所需请求头。
- PostgreSQL 保存比赛快照、官方完整赛果、全场比分、预测玩法、方向、让球线、备注、实际赛果方向、红黑状态和结算时间；浏览器 localStorage 作为离线兜底。
- “全部”页面按 API 当前比赛在前、数据库历史比赛在后合并展示，同一场比赛不重复。
- “待预测”仅显示当前 API 仍可操作且尚未选择方向的比赛。
- 已下架、过期或已完赛比赛锁定所有操作，原有记录仍可查看。
- 日期按竞彩销售日归档，以“周三001”这类场次编号为准；即使比赛在次日凌晨开球，仍显示在对应的前一销售日中。
- 服务端启动后每小时自动同步最近 3 天赛果，页面每 5 分钟也会同步；赛果落库后由服务端自动结算并永久保存红/黑状态。

## 技术结构

- `server.js`：静态网页服务、上游 API 代理、PostgreSQL 初始化与 REST 接口。
- `public/`：前端页面、样式和交互逻辑。
- `Dockerfile`：Node 22 Alpine 网页镜像。
- `docker-compose.yml`：网页容器 + PostgreSQL 16 容器及持久化 volume。
- `install-server.sh`：Linux 服务器一键部署脚本。
- `install-mac.sh`：macOS 一键部署脚本。
- `install.bat` / `install.ps1`：Windows 一键部署脚本。

## 联系我

如有使用问题或功能建议，欢迎添加微信联系：

<table align="center" border="1" cellpadding="14" cellspacing="0">
  <tr>
    <td align="center">
      <img src="https://image.dooo.ng/c/2025/03/31/67e976e7dac1e.jpg" width="240" alt="微信二维码" />
      <br />扫码添加微信
    </td>
  </tr>
</table>
