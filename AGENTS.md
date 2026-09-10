# 红黑记录项目说明

- 定位：竞彩足球比赛预测与红黑结果记录网页。
- 运行：优先执行 `docker compose up -d --build`；Linux 服务器使用 `install-server.sh`，macOS 使用 `install-mac.sh`。
- 技术栈：Node.js 22、原生 HTTP/fetch、PostgreSQL 16、原生 HTML/CSS/JavaScript。
- 目录：`server.js` 是后端入口，`public/` 是前端，Docker 与安装脚本位于项目根目录。
- 数据：Docker 模式使用 PostgreSQL；`matches` 保存比赛快照，`match_results` 保存官方完整赛果，`predictions` 保存预测和持久化红黑结算状态；浏览器 localStorage 仅作离线兜底。不要执行 `docker compose down -v`，除非明确要删除数据。
- 当前行为：全部页面合并显示 API 当前比赛与数据库历史比赛；待预测只显示未过期、未完赛且未选择方向的比赛；已过期/完赛比赛锁定操作。
- 日期归档：比赛、预测和赛果统一按竞彩销售日 `business_date` 归档，以“周三001”这类场次编号的星期为准；次日凌晨开球的比赛仍归入前一销售日。
- 结算：服务端每小时同步最近 3 天赛果，并在赛果落库后按 `match_id`、玩法和预测时让球线结算；前端优先读取数据库中的 `settlement_status`。
- 部署：macOS 默认安装到 `~/red-black-record`，Linux 默认安装到 `/opt/red-black-record`，默认外部端口均为 `4399`，占用时自动递增。
- 验证：修改后运行 `node --check server.js`、`node --check public/app.js`、`docker compose config`。
