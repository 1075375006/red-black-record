# 红黑记录




一个轻量的足球预测记录网页：每天同步竞彩比赛，记录胜平负/让球方向和备注，赛果回来后自动判定“红 / 黑”。




## 启动




### Windows 一键安装（推荐）




确认 Docker Desktop 已经启动后，双击项目目录里的 `install.bat` 即可自动完成镜像准备、网页和数据库启动，并打开浏览器。




也可以在 PowerShell 中运行：




```powershell
powershell -ExecutionPolicy Bypass -File .\install.ps1
```




### Linux 服务器一键部署




在 Ubuntu/Debian 服务器上直接复制这一条命令即可。脚本会自动准备 Docker（如果尚未安装）、下载 GitHub 最新代码、构建网页镜像、启动 PostgreSQL 和网页服务，不需要手动下载项目：




```bash
curl -fsSL https://raw.githubusercontent.com/1075375006/red-black-record/main/install-server.sh | sudo bash
```




默认安装目录是 `/opt/red-black-record`，数据库数据保存在 Docker volume 中。网页服务默认使用 `4399` 端口（服务器和容器内部统一）；如果 `4399` 已被占用，会自动选择下一个可用端口，并在最后输出实际地址。服务器安全组或防火墙需要放行输出的端口。

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
