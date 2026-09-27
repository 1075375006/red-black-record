# 上游代理网关（proxy-gateway）开发文档

> 状态：规划稿，未开始编码
> 目标读者：负责实现本模块的开发者
> 适用项目：红黑记录（`server.js` + `public/` + PostgreSQL，Docker Compose 部署）

---

## 1. 背景与问题

项目服务器部署在国外，而体彩接口 `webapi.sporttery.cn` 只允许国内 IP 访问，所以服务端访问体彩比赛 API 和赛果 API 时必须经过国内代理。

当前实现存在以下问题：

| 问题 | 现状位置 | 影响 |
| --- | --- | --- |
| 代理逻辑和业务代码混在一起 | `server.js` 第 7、22–35、308–342、532 行 | 业务文件承担网络出口职责，难以单独维护和替换 |
| 代理只能通过环境变量配置 | `UPSTREAM_SOCKS5_PROXY` / `SOCKS5_PROXY`，经 `.env` → `docker-compose.yml` 传入 | 修改代理要登录服务器改 `.env` 并重建容器 |
| 代理在启动时创建一次，无法热更新 | 模块加载时 `new SocksProxyAgent(...)` | 代理失效后只能重启服务 |
| 没有开关 | 只有“配置了就用、没配置就直连” | 无法临时关闭代理排查问题 |
| 只支持单个代理 | 单一环境变量 | 代理挂掉时没有备用线路，比赛和赛果同步直接失败 |
| 没有可视化状态 | 仅启动日志一行 | 不知道代理是否可用、延迟多少、最近失败原因 |
| 安装脚本会整体覆盖 `.env` | `install-server.sh` 第 59–62 行、`install-mac.sh` 第 60–62 行 | 以后 `.env` 里有其他配置时会被冲掉 |

## 2. 目标与非目标

### 2.1 目标

1. **独立模块**：代理功能拆成独立目录、独立依赖、独立容器，主项目只依赖一个很小的“上游请求”接口，不再引用任何 SOCKS 相关库。
2. **可开可关**：后台有全局开关。关闭后所有上游请求直连；开启后按配置走代理。
3. **后台管理**：网页后台可以添加、修改、删除、启用/停用代理，修改后立即生效，无需重启。
4. **仅服务 API**：代理只用于服务端访问体彩接口（域名白名单），不代理网页、数据库或其他任何流量，也不能被当成开放代理使用。
5. **平滑迁移**：已有的 `UPSTREAM_SOCKS5_PROXY` 配置在升级后自动导入，不需要用户手工操作。

### 2.2 非目标

- 不做通用代理服务器，不对外提供 SOCKS/HTTP 代理端口。
- 不做代理订阅、节点购买、自动抓取免费代理。
- 不改动比赛、赛果、预测、结算等业务逻辑，只替换“怎么把请求发出去”这一层。
- 第一版不做多管理员权限分级，沿用现有管理员登录。

## 3. 总体架构

### 3.1 部署拓扑

```
浏览器
  │  HTTP :4399
  ▼
┌───────────────────────────┐        内部网络（不对外暴露端口）
│ web（主项目 server.js）     │ ─────────────────────────────┐
│  - 业务接口 /api/*          │   POST /relay（转发体彩请求）   │
│  - 管理员登录 auth.js       │   /admin/*（代理后台，反向代理） │
│  - /proxy-admin/ 入口       │                               ▼
└───────────────────────────┘                  ┌──────────────────────────┐
          │                                    │ proxy-gateway（新模块）     │
          ▼                                    │  - 转发 + 白名单            │
┌──────────────────┐                           │  - 代理池 / 故障切换         │
│ db（PostgreSQL）   │                           │  - 管理 API + 管理页面       │
└──────────────────┘                           │  - 配置存储（独立数据卷）     │
                                               └──────────────────────────┘
                                                        │ 直连 或 SOCKS5
                                                        ▼
                                               国内代理 → webapi.sporttery.cn
```

### 3.2 职责划分

| 组件 | 负责 | 不负责 |
| --- | --- | --- |
| 主项目 `web` | 业务逻辑；决定请求哪个体彩 URL；缓存（现有 45 秒）；管理员登录；把 `/proxy-admin/` 请求转交给网关 | 代理选择、代理连接、代理配置存储 |
| `proxy-gateway` | 接收主项目的转发请求；校验目标域名；按开关和代理池选择出口；健康检查；代理配置的增删改查；管理页面 | 业务数据、比赛解析、登录账号体系 |

### 3.3 为什么做成独立容器而不是项目内的一个 JS 文件

- 依赖隔离：`socks-proxy-agent` 只出现在网关的 `package.json`，主项目镜像不再包含它。
- 生命周期隔离：代理出问题、网关重启，不影响主站页面和数据库读取；主站仍可展示已入库的历史数据。
- 可复用：以后其他需要“国内出口”的项目可以直接复用这个网关。
- 可替换：主项目只认一个 `UPSTREAM_GATEWAY_URL`，以后换成别的出口方案（例如 HTTP 代理、自建国内中转）不需要改业务代码。

## 4. 目录结构（规划）

```
红黑记录/
├─ server.js                  # 主项目：删除 SOCKS 代码，改为调用上游客户端
├─ lib/
│  └─ upstream-client.js      # 主项目新增：唯一的上游请求出口（直连 / 走网关）
├─ proxy-gateway/             # 新模块，独立目录
│  ├─ package.json            # 仅依赖 socks-proxy-agent
│  ├─ Dockerfile
│  ├─ README.md               # 模块自身说明，可独立阅读
│  ├─ src/
│  │  ├─ index.js             # 入口：HTTP 服务、路由分发
│  │  ├─ config-store.js      # 配置读写：JSON 文件、原子写入、密码加密
│  │  ├─ agent-pool.js        # 按代理配置创建/缓存/销毁 Agent，支持热更新
│  │  ├─ relay.js             # 转发：白名单校验、出口选择、故障切换、超时
│  │  ├─ health.js            # 连通性测试、定时健康检查、熔断冷却
│  │  ├─ admin-api.js         # 管理 API
│  │  ├─ request-log.js       # 最近请求日志（内存环形缓冲）
│  │  └─ audit-log.js         # 配置变更审计日志
│  └─ public/
│     ├─ index.html           # 代理管理后台页面
│     ├─ admin.js
│     └─ admin.css
├─ docker-compose.yml         # 新增 proxy-gateway 服务和 proxy_gateway_data 数据卷
├─ .dockerignore              # 新增 proxy-gateway/，避免被打进主项目镜像
└─ docs/proxy-gateway.md      # 本文档
```

技术栈与主项目保持一致：Node.js 22、原生 `http`/`https`、原生 HTML/CSS/JavaScript，不引入 Web 框架。

## 5. 核心概念与行为规则

### 5.1 全局开关（代理模式）

| 模式 | 值 | 行为 |
| --- | --- | --- |
| 关闭 | `enabled = false` | 所有上游请求直连，即使配置了代理也不使用 |
| 开启 | `enabled = true` | 按优先级使用“已启用”的代理；全部失败时按 `fallbackToDirect` 决定是否直连兜底 |

`fallbackToDirect` 默认 `false`。原因：服务器在国外时直连必然失败，静默直连只会把“代理全挂了”的真实原因掩盖成“上游返回 403”。本地开发或国内服务器可在后台打开。

### 5.2 代理条目

- 支持协议：`socks5`、`socks5h`（第一版）。**推荐默认 `socks5h`**，由代理端解析域名，避免国外服务器解析出海外 CDN 节点。
- 预留协议：`http`、`https`（第二版视需要追加，数据结构先留字段）。
- 每条代理有独立的启用/停用开关和优先级（数字越小越优先），后台支持拖拽排序。
- 密码在存储时加密，任何 API 都不返回明文，只返回“已设置/未设置”。编辑时密码框留空表示不修改。

### 5.3 出口选择与故障切换

1. 取出所有 `enabled = true` 且不在冷却期的代理，按 `priority` 升序排列。
2. 依次尝试，单次尝试超时为 `timeoutMs`（默认 15 秒）。
3. 以下情况视为“该代理失败，切换下一条”：连接失败、握手失败、超时、上游返回 403 / 5xx / 非 JSON。
4. 以下情况视为“请求本身的问题，不切换”：上游返回 400 / 404（换代理也没用）。
5. 同一代理连续失败达到 `failureThreshold`（默认 3 次）后进入冷却期 `cooldownMs`（默认 60 秒），冷却期内跳过；冷却结束后自动恢复参与。
6. 全部失败：若 `fallbackToDirect = true` 则直连一次，否则返回 502，并附带每一次尝试的失败原因。
7. 单次转发总耗时上限 `totalTimeoutMs`（默认 40 秒），防止多个代理串行超时导致主站请求挂起过久。

### 5.4 域名白名单（防开放代理 / SSRF）

- 只允许 `https://webapi.sporttery.cn:443`，且路径必须是比赛接口 `getMatchCalculatorV1.qry` 或赛果接口 `getUniformMatchResultV1.qry`。域名和路径在服务端固定校验，管理后台不能扩展转发范围。
- 只允许 `GET` 方法。
- 拒绝 IP 字面量、`localhost`、内网地址。
- 请求头只透传白名单内的字段（`Accept`、`Accept-Encoding`、`Origin`、`Referer`、`User-Agent`），其余丢弃。
- 禁止修改白名单，服务端固定校验体彩接口域名和两条业务 API 路径，并写入配置审计日志。

### 5.5 热更新

- 每次配置写入成功后，`agent-pool` 对比新旧配置：被修改或删除的代理，销毁旧 Agent 并从缓存移除；新增的代理在首次使用时再创建。
- 正在进行中的请求继续使用旧 Agent 直到完成，不强制中断。
- 不需要重启容器，保存后下一次请求即使用新配置。

## 6. 数据存储

### 6.1 存储方式

网关使用**自己的数据卷** `proxy_gateway_data`，挂载到容器内 `/data`，配置文件为 `/data/config.json`。不使用主项目的 PostgreSQL，保证模块独立（网关可以脱离主项目单独运行）。

写入规则：

- 先写 `/data/config.json.tmp`，`fsync` 后 `rename` 覆盖，保证断电不会写坏文件。
- 所有写操作在进程内串行执行（单写队列），避免并发保存互相覆盖。
- 每次写入前把旧文件复制为 `/data/config.json.bak`，只保留最近一份。
- 配置带 `revision` 字段，后台保存时提交当前 `revision`，不一致则返回 409，提示“配置已被其他页面修改，请刷新”。

### 6.2 配置数据结构

```json
{
  "version": 1,
  "revision": 12,
  "enabled": true,
  "fallbackToDirect": false,
  "timeoutMs": 15000,
  "totalTimeoutMs": 40000,
  "failureThreshold": 3,
  "cooldownMs": 60000,
  "healthCheckIntervalMs": 600000,
  "allowedHosts": ["webapi.sporttery.cn"],
  "proxies": [
    {
      "id": "px_8f3a2c",
      "name": "上海家宽",
      "protocol": "socks5h",
      "host": "1.2.3.4",
      "port": 1080,
      "username": "user",
      "passwordEnc": "v1:gcm:<iv>:<tag>:<ciphertext>",
      "enabled": true,
      "priority": 1,
      "remark": "主线路",
      "createdAt": "2026-09-27T06:00:00.000Z",
      "updatedAt": "2026-09-27T06:00:00.000Z"
    }
  ]
}
```

运行时状态（最近检测结果、连续失败次数、冷却截止时间、累计成功/失败次数）**只保存在内存**，不写入配置文件，重启后重新检测。

### 6.3 密码加密

- 算法：AES-256-GCM。
- 密钥：环境变量 `PROXY_SECRET_KEY`（32 字节随机值，十六进制或 Base64）。安装脚本在 `.env` 中不存在该值时自动生成并保留。
- 未配置密钥时：网关启动打印警告，密码以明文存储，后台页面顶部显示黄色提示。
- 密钥丢失时：已存密码无法解密，后台将对应代理标记为“密码需要重新填写”，不影响其他字段。

## 7. 接口设计

网关监听一个内部端口（默认 `4398`），只在 Docker 内部网络 `expose`，**不映射到宿主机公网端口**。接口分三组，使用不同的令牌。

### 7.1 转发接口（主项目 → 网关）

`POST /relay`

请求头：`X-Relay-Token: <RELAY_TOKEN>`，`Content-Type: application/json`

请求体：

```json
{
  "url": "https://webapi.sporttery.cn/gateway/uniform/football/getMatchCalculatorV1.qry?channel=c&poolCode=hhad,had",
  "headers": { "Accept": "application/json", "Referer": "https://www.sporttery.cn/" }
}
```

成功响应：原样返回上游状态码和响应体，附加响应头：

| 响应头 | 示例 | 含义 |
| --- | --- | --- |
| `X-Relay-Route` | `proxy:px_8f3a2c` / `direct` | 本次实际使用的出口 |
| `X-Relay-Attempts` | `2` | 尝试次数（含失败切换） |
| `X-Relay-Latency` | `412` | 网关侧总耗时（毫秒） |

失败响应（网关自身产生）：

| 状态码 | 场景 | 响应体示例 |
| --- | --- | --- |
| 401 | 令牌错误 | `{"error":"relay token 无效"}` |
| 403 | 目标不在白名单 | `{"error":"目标域名不在白名单：example.com"}` |
| 502 | 全部出口失败 | `{"error":"所有代理均不可用","mode":"proxy","attempts":[{"proxy":"上海家宽","error":"连接超时"}]}` |
| 503 | 开启代理但没有任何已启用代理，且未允许直连兜底 | `{"error":"代理已开启，但没有可用的代理条目"}` |

`GET /healthz`：返回 `{"ok":true,"mode":"proxy","activeProxies":2}`，供 Docker healthcheck 和主项目状态展示使用，无需令牌。

### 7.2 管理 API（后台页面 → 网关）

统一前缀 `/admin/api`，请求头需带 `X-Admin-Token: <PROXY_ADMIN_TOKEN>`（由主项目反向代理自动注入，见第 8.2 节），主项目同时注入 `X-Admin-User` 供审计日志记录操作人。

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| GET | `/admin/api/state` | 全局设置 + 代理列表（密码脱敏）+ 每条代理的运行时状态 |
| PUT | `/admin/api/settings` | 修改全局设置：`enabled`、`fallbackToDirect`、超时、阈值、`allowedHosts` |
| POST | `/admin/api/proxies` | 新增代理 |
| POST | `/admin/api/proxies/parse` | 解析一行 `socks5h://用户:密码@地址:端口`，返回表单字段（用于“粘贴快速添加”） |
| PUT | `/admin/api/proxies/:id` | 修改代理；`password` 字段缺省或为空字符串表示不修改 |
| DELETE | `/admin/api/proxies/:id` | 删除代理（需二次确认，前端实现） |
| POST | `/admin/api/proxies/:id/toggle` | 启用/停用单条代理 |
| PUT | `/admin/api/proxies/order` | 提交新的排序 `["px_a","px_b"]`，服务端重算 `priority` |
| POST | `/admin/api/proxies/:id/test` | 测试已保存的代理 |
| POST | `/admin/api/proxies/test` | 测试尚未保存的表单内容（保存前先测） |
| GET | `/admin/api/logs?limit=100` | 最近转发日志 |
| GET | `/admin/api/audit?limit=100` | 配置变更记录 |

所有写接口：只接受 `application/json`；请求体必须带 `revision`（见 6.1）；成功后返回新的完整 `state`，前端直接刷新界面。

字段校验：

| 字段 | 规则 |
| --- | --- |
| `name` | 1–30 字符，必填 |
| `protocol` | `socks5` / `socks5h` |
| `host` | 域名或 IP，必填，禁止 `localhost` 和内网地址 |
| `port` | 1–65535 整数 |
| `username` / `password` | 可选，各不超过 255 字符；特殊字符由服务端处理，用户无需自己做 URL 编码 |
| `remark` | 不超过 100 字符 |

### 7.3 连通性测试定义

“测试”对指定代理执行以下检查，并返回每一步结果：

1. TCP 连接代理服务器，记录耗时。
2. SOCKS5 握手与认证。
3. 通过代理请求体彩比赛接口（固定使用 `getMatchCalculatorV1.qry`），判定标准：HTTP 2xx、响应可解析为 JSON、`success` 字段不为 `false`。
4. （可选）查询出口 IP 及归属地，用于确认确实是国内出口。查询服务地址需单独配置在 `healthCheckIpUrl`，默认关闭，避免引入额外外部依赖。

返回示例：

```json
{
  "ok": true,
  "latencyMs": 386,
  "steps": [
    { "name": "连接代理", "ok": true, "ms": 120 },
    { "name": "SOCKS5 认证", "ok": true, "ms": 45 },
    { "name": "请求体彩接口", "ok": true, "ms": 221, "statusCode": 200 }
  ],
  "exitIp": null
}
```

定时健康检查：每 `healthCheckIntervalMs`（默认 10 分钟）对所有已启用代理执行一次上述第 1–3 步，结果写入内存运行时状态，供后台展示和冷却判断使用。

## 8. 主项目改造

### 8.1 上游请求出口 `lib/upstream-client.js`

主项目新增一个极薄的客户端，对外只暴露“按 URL 获取 JSON”一个能力，`server.js` 中的 `upstream(url)` 改为调用它。

行为规则：

| 条件 | 行为 |
| --- | --- |
| 配置了 `UPSTREAM_GATEWAY_URL` | 通过 `POST {网关}/relay` 转发；网关返回的错误信息原样透传到主项目错误消息中 |
| 未配置 `UPSTREAM_GATEWAY_URL` | 直接用原生 `fetch` 直连（本地开发、国内服务器场景） |
| 配置了网关但网关不可达 | 按 `UPSTREAM_GATEWAY_FALLBACK` 决定：`fail`（默认）直接报错；`direct` 改为直连 |

需要从 `server.js` 删除的内容：

- `require('socks-proxy-agent')`
- `upstreamProxyUrl`、`upstreamProxyAgent` 及其初始化代码
- `requestJsonThroughProxy` 函数
- `upstreamStatusError` 中“是否启用 SOCKS5”的判断，改为使用网关返回的 `X-Relay-Route` 描述出口
- 启动日志中的 SOCKS5 提示，改为打印“上游出口：代理网关 / 直连”

主项目 `package.json` 删除 `socks-proxy-agent` 依赖。

现有业务行为保持不变：45 秒缓存、赛果同步失败时回退读取数据库已存赛果、每小时同步最近 3 天赛果。

### 8.2 后台入口 `/proxy-admin/`

主项目在路由中增加一段反向代理（这是主项目与网关后台之间唯一的耦合点）：

1. 请求路径以 `/proxy-admin/` 开头时，先调用现有 `auth.middleware(req)` 校验管理员登录。
2. 未登录：页面请求重定向到 `/login.html?next=/proxy-admin/`；API 请求返回 401。
3. 已登录：去掉 `/proxy-admin` 前缀，转发到网关，并注入 `X-Admin-Token`（来自主项目环境变量 `PROXY_ADMIN_TOKEN`）和 `X-Admin-User`（当前用户名）。
4. 浏览器请求中自带的 `X-Admin-Token` 一律丢弃，防止伪造。

需要配套修改：

- `public/login.html`：支持 `next` 参数，登录成功后跳回原页面（只允许站内相对路径，防止开放重定向）。
- 主页面顶部导航：已登录管理员显示“代理设置”入口链接。
- 可选：主页面显示一个小状态标识（“代理出口正常 / 代理异常 / 直连”），数据来自主项目新增的 `GET /api/upstream/status`，该接口内部调用网关的 `/healthz`。

### 8.3 网关独立运行模式

网关不依赖主项目也能使用：设置 `PROXY_ADMIN_PUBLISH=127.0.0.1:4398` 后，Compose 把管理端口映射到宿主机本地回环地址，可通过 SSH 隧道访问 `http://127.0.0.1:4398/`，此时由网关自身的登录页校验 `PROXY_ADMIN_TOKEN`。默认不开启。

## 9. 管理后台页面设计

页面路径：`/proxy-admin/`（经主项目登录后访问）。风格沿用主项目 `styles.css` 的配色和组件样式。

### 9.1 页面布局

1. **顶部状态栏**
   - 全局开关（大号开关按钮）：“代理已开启 / 已关闭（直连）”。切换时弹出确认框说明影响。
   - 当前出口：显示当前优先使用的代理名称和最近一次检测延迟。
   - “直连兜底”开关，旁边附说明文字。
2. **代理列表**（表格，可拖拽排序）
   - 列：拖拽手柄、名称、协议、地址:端口、认证（有/无）、状态（正常/失败/冷却中/未检测）、延迟、最近检测时间、启用开关、操作（测试、编辑、删除）。
   - 状态颜色：正常绿色、失败红色、冷却中橙色、未检测灰色。
3. **新增/编辑弹窗**
   - 顶部“粘贴代理地址”输入框，粘贴 `socks5h://...` 后自动拆分填充下方字段。
   - 字段：名称、协议、地址、端口、用户名、密码（显示“已设置，留空不修改”）、备注、启用。
   - 按钮：“测试连接”（不保存，调用 `/proxies/test`）、“保存”、“取消”。
4. **高级设置**（默认折叠）
   - 单次超时、总超时、失败阈值、冷却时长、健康检查间隔、域名白名单。
5. **最近请求日志**（默认折叠）
   - 时间、目标接口（只显示路径，不显示完整查询串）、出口、状态码、耗时、错误原因。
6. **变更记录**（默认折叠）
   - 时间、操作人、操作类型、变更摘要（密码只记录“已修改”）。

### 9.2 交互规则

- 每次保存成功后用返回的最新 `state` 整体刷新，不做局部拼接。
- 收到 409 时提示“配置已在其他页面修改”，并提供“刷新”按钮。
- 删除当前唯一启用的代理、或在代理开启状态下停用最后一条代理时，弹窗提醒“保存后所有体彩请求将失败”。
- 页面每 30 秒自动刷新运行时状态（只刷新状态列，不打断正在编辑的弹窗）。

## 10. 配置项与环境变量

### 10.1 网关 `proxy-gateway`

| 变量 | 默认值 | 说明 |
| --- | --- | --- |
| `PORT` | `4398` | 网关监听端口（容器内） |
| `DATA_DIR` | `/data` | 配置文件目录 |
| `RELAY_TOKEN` | 无，必填 | 主项目调用 `/relay` 的令牌 |
| `PROXY_ADMIN_TOKEN` | 无，必填 | 管理 API 令牌 |
| `PROXY_SECRET_KEY` | 无，建议填 | 代理密码加密密钥 |
| `PROXY_BOOTSTRAP_URL` | 空 | 首次启动且配置为空时自动导入的代理地址（兼容旧 `UPSTREAM_SOCKS5_PROXY`） |
| `PROXY_ALLOWED_HOSTS` | `webapi.sporttery.cn` | 首次启动时写入配置的默认白名单，之后以后台配置为准 |

### 10.2 主项目 `web`

| 变量 | 默认值 | 说明 |
| --- | --- | --- |
| `UPSTREAM_GATEWAY_URL` | `http://proxy-gateway:4398` | 网关地址；设为空表示不使用网关，直接直连 |
| `UPSTREAM_GATEWAY_FALLBACK` | `fail` | 网关不可达时的行为：`fail` / `direct` |
| `RELAY_TOKEN` | 与网关一致 | 调用 `/relay` 使用 |
| `PROXY_ADMIN_TOKEN` | 与网关一致 | 反向代理后台时注入 |

旧变量 `UPSTREAM_SOCKS5_PROXY`、`SOCKS5_PROXY` 不再被主项目读取，仅由 Compose 映射给网关的 `PROXY_BOOTSTRAP_URL` 作为一次性导入来源。

### 10.3 Docker Compose 变更要点

- 新增服务 `proxy-gateway`：`build: ./proxy-gateway`，`restart: unless-stopped`，只 `expose: 4398`，不写 `ports`（除非设置了 `PROXY_ADMIN_PUBLISH`）。
- 新增数据卷 `proxy_gateway_data`，挂载到网关 `/data`。
- `proxy-gateway` 配置 healthcheck 调用 `/healthz`。
- `web` 增加 `depends_on: proxy-gateway`（条件为 `service_started`，不要求 healthy，避免网关异常时主站无法启动）。
- `web` 的 `UPSTREAM_SOCKS5_PROXY` 环境变量移除，改为上面 10.2 的变量。
- 根目录 `.dockerignore` 增加 `proxy-gateway/`，避免被打进主项目镜像。

## 11. 安装脚本与迁移

### 11.1 安装脚本改造（`install-server.sh`、`install-mac.sh`、`install.ps1`）

1. `.env` 改为**按键合并写入**，不再整体覆盖：已存在的键保留，只追加缺失的键。
2. 缺少 `RELAY_TOKEN`、`PROXY_ADMIN_TOKEN`、`PROXY_SECRET_KEY` 时自动生成随机值写入 `.env`（权限 600）。
3. 继续接受 `RED_BLACK_SOCKS5_PROXY` 参数，写入 `.env` 的 `UPSTREAM_SOCKS5_PROXY`，作为网关首次导入来源。
4. 安装完成后输出代理后台地址：`http://<地址>:<端口>/proxy-admin/`。

### 11.2 老用户升级流程

1. 用户照常重新执行一键安装命令（或 `docker compose up -d --build`）。
2. 网关首次启动发现 `/data/config.json` 不存在：
   - 若 `PROXY_BOOTSTRAP_URL` 有值：解析并导入为一条名为“从环境变量导入”的代理，`enabled = true`，全局开关设为开启。
   - 若没有值：创建空配置，全局开关设为关闭（直连）。
3. 之后 `config.json` 已存在，`PROXY_BOOTSTRAP_URL` 不再生效；后台修改为唯一配置来源。README 中需写明这一点，避免用户改了 `.env` 却发现不生效。
4. 数据卷 `redblack_red_black_pgdata` 不受影响。严禁在迁移说明中出现 `docker compose down -v`。

### 11.3 回滚

- 回滚到旧版本代码后，旧版 `server.js` 仍读取 `.env` 中的 `UPSTREAM_SOCKS5_PROXY`，因此只要 `.env` 中保留该键即可恢复原行为。安装脚本在迁移后**不删除**该键。
- 网关数据卷可保留，不影响旧版本运行。

## 12. 安全要求

| 风险 | 措施 |
| --- | --- |
| 网关被当作开放代理 | 只接受白名单域名、只允许 HTTPS GET、端口不对公网暴露、`/relay` 需要令牌 |
| 管理后台被未授权访问 | 必须经主项目管理员登录；网关侧再校验 `X-Admin-Token`；浏览器传入的该请求头被主项目丢弃 |
| 代理密码泄露 | 存储加密；API 不返回明文；日志、错误信息、审计记录中对代理地址做脱敏（`socks5h://user:***@host:port`） |
| CSRF | 沿用主项目 `SameSite=Strict` 的 Cookie；写接口只接受 JSON 请求体 |
| 开放重定向 | `login.html` 的 `next` 参数只接受以 `/` 开头且不以 `//` 开头的站内路径 |
| 配置被并发覆盖 | `revision` 乐观锁 + 单写队列 |
| 内网探测 | 代理地址和白名单均拒绝 `localhost`、`127.0.0.0/8`、`10.0.0.0/8`、`172.16.0.0/12`、`192.168.0.0/16`、`169.254.0.0/16` 及 IPv6 本地地址 |

## 13. 日志与可观测性

- **转发日志**：内存环形缓冲，保留最近 500 条，字段为时间、目标路径、出口、尝试次数、状态码、耗时、错误原因。不落盘，重启清空。
- **审计日志**：追加写入 `/data/audit.log`（每行一条 JSON），超过 5 MB 时轮转保留一份旧文件。
- **控制台日志**：启动时打印当前模式、已启用代理数量、白名单；每次模式切换、代理进入/退出冷却时打印一行。任何日志都不打印明文密码。

## 14. 开发阶段划分

| 阶段 | 内容 | 完成标准 |
| --- | --- | --- |
| P1 网关核心 | `proxy-gateway` 目录骨架、`config-store`、`agent-pool`、`relay`、`/healthz`、环境变量导入；主项目 `upstream-client` 接入；Compose 增加服务 | 与现有功能完全等价：配置 `UPSTREAM_SOCKS5_PROXY` 升级后比赛与赛果照常同步；主项目不再依赖 `socks-proxy-agent` |
| P2 管理 API | 第 7.2 节全部接口、字段校验、`revision` 乐观锁、密码加密 | 通过 API 增删改代理、切换开关后立即生效，无需重启 |
| P3 管理后台 | 第 9 节页面；主项目 `/proxy-admin/` 反向代理和登录跳转；主页面入口链接 | 管理员登录后可在网页完成全部代理操作；未登录无法访问 |
| P4 可靠性 | 故障切换、熔断冷却、定时健康检查、连通性测试、转发日志、审计日志 | 第 15 节可靠性相关用例全部通过 |
| P5 部署与文档 | 三个安装脚本的 `.env` 合并写入与令牌生成；README、`AGENTS.md`、`proxy-gateway/README.md` 更新 | 全新安装与老用户升级两条路径都实测通过 |

建议每个阶段单独提交，P1 完成后即可上线替换旧实现，后续阶段逐步叠加。

## 15. 测试与验收

### 15.1 静态检查（每次修改后）

- `node --check server.js`
- `node --check public/app.js`
- `node --check` 网关 `src/` 下所有文件和 `public/admin.js`
- `docker compose config`

### 15.2 功能验收用例

| 编号 | 场景 | 期望结果 |
| --- | --- | --- |
| T1 | 全局开关关闭 | 转发走直连，`X-Relay-Route: direct` |
| T2 | 开启，1 条可用代理 | 比赛和赛果正常返回，`X-Relay-Route: proxy:<id>` |
| T3 | 后台修改代理地址后立即请求 | 无需重启，新请求使用新地址 |
| T4 | 第 1 条代理错误、第 2 条可用 | 自动切换成功，`X-Relay-Attempts: 2`，第 1 条失败计数加一 |
| T5 | 某代理连续失败 3 次 | 进入冷却，60 秒内不再尝试，后台显示“冷却中” |
| T6 | 全部代理失败，未开直连兜底 | `/relay` 返回 502 且列出每次失败原因；主站 `/api/results` 回退读取数据库已存赛果（现有行为） |
| T7 | 开启代理但没有已启用代理 | 返回 503，错误信息明确 |
| T8 | 请求非白名单域名 | 403 |
| T9 | `/relay` 不带或带错令牌 | 401 |
| T10 | 未登录访问 `/proxy-admin/` | 重定向到登录页，登录后跳回 |
| T11 | 浏览器伪造 `X-Admin-Token` 直接请求 | 被主项目丢弃，仍需登录 |
| T12 | 任何 API 响应和日志 | 均不含明文代理密码 |
| T13 | 两个页面同时编辑后先后保存 | 后保存者收到 409 |
| T14 | 重启网关容器 | 配置保留；运行时状态重新检测 |
| T15 | 网关容器停止 | 主站页面可打开，历史数据可查看；实时比赛请求报出“代理网关不可达” |
| T16 | 老用户带 `UPSTREAM_SOCKS5_PROXY` 升级 | 自动导入 1 条代理且开关开启，同步正常 |
| T17 | 重复执行安装脚本 | `.env` 中已有令牌和密钥不变，代理配置不丢失 |
| T18 | 密码含 `@`、`#`、`:` 等字符 | 表单直接填写即可正常认证，无需手工编码 |

## 16. 待确认事项

实现前请产品负责人确认以下几点，文档中已给出默认方案：

1. **后台入口方式**：默认“经主站管理员登录后访问 `/proxy-admin/`”；备选“网关独立端口 + 独立口令”。
2. **是否需要 HTTP/HTTPS 代理协议**：默认第一版只做 SOCKS5/SOCKS5h。
3. **是否需要多代理故障切换**：默认支持；若只需要单个代理，可跳过 P4 中的故障切换和冷却，工作量约减少三分之一。
4. **全部代理失败时是否直连兜底**：默认不兜底（国外服务器直连必然失败）。
5. **出口 IP 归属地检测**：默认关闭；如需开启，需要确定一个可在国内访问的 IP 查询服务。

## 17. 完成后需同步更新的文档

- `README.md`：“国外服务器使用 SOCKS5 代理”一节改为介绍代理后台用法，保留环境变量导入说明并注明“仅首次生效”。
- `AGENTS.md`：“网络”一条改为描述 `proxy-gateway` 模块、`/proxy-admin/` 入口和相关环境变量；“验证”一条补充网关文件的 `node --check`。
- `proxy-gateway/README.md`：模块自身的接口、环境变量、独立运行方式。
