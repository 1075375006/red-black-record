# 红黑记录

一个轻量的足球预测记录网页：每天同步竞彩比赛，记录胜平负/让球方向和备注，赛果回来后自动判定“红 / 黑”。

## 启动

### Windows 一键安装（推荐）

确认 Docker Desktop 已经启动后，双击项目目录里的 `install.bat` 即可自动完成镜像准备、网页和数据库启动，并打开浏览器。

也可以在 PowerShell 中运行：

```powershell
powershell -ExecutionPolicy Bypass -File .\install.ps1
```

### 手动启动

推荐使用 Docker Compose，一次启动网页和 PostgreSQL 数据库：

```powershell
docker compose up -d --build
```

如果构建时提示无法访问 `auth.docker.io`，先单独拉取网页运行时镜像，再重新启动：

```powershell
docker pull node:22-alpine
docker compose up -d --build
```

然后打开 http://localhost:8787。

查看运行状态：

```powershell
docker compose ps
```

停止服务（保留数据库数据）：

```powershell
docker compose down
```

如果要连同数据库数据一起删除，再执行 `docker compose down -v`。

也可以直接使用 Node.js 18 或更高版本运行 `npm install` 和 `npm start`，此时没有 PostgreSQL 环境，记录会退回保存到当前浏览器的 localStorage。

## 说明

- 比赛和赛果请求由本地服务转发，服务端会附带竞彩站点需要的请求头，避免浏览器安全策略拦截。
- Docker 模式下，比赛快照和预测记录保存在 PostgreSQL 数据库中，浏览器 localStorage 作为离线/接口异常时的临时兜底；记录以比赛 matchId 关联。
- 让球预测保存的是选择当时的让球线，结算时按全场比分重新计算，不直接套用普通胜平负结果。
- 赛果接口按所选日期到次日查询，用于覆盖跨午夜结束的比赛。
- 页面每 5 分钟自动同步一次，也可以点击“同步数据”手动刷新。
