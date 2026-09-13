# 管理员认证功能说明

## 功能概述

项目已集成独立的管理员认证模块，确保只有经过验证的用户才能对比赛进行操作。所有写入操作（记录预测、修改记录、清空记录）都需要先登录。

## 核心特性

### 1. 独立认证模块 (`auth.js`)
- 完整的用户认证系统
- 基于 PBKDF2 的密码加密（100,000 次迭代）
- 会话管理（7 天有效期）
- 自动清理过期会话
- HttpOnly Cookie 防止 XSS 攻击

### 2. 数据库表结构
```sql
-- 管理员用户表
admin_users (
  username TEXT PRIMARY KEY,
  password_hash TEXT NOT NULL,
  salt TEXT NOT NULL,
  created_at TIMESTAMPTZ,
  last_login_at TIMESTAMPTZ
)

-- 会话表
admin_sessions (
  token TEXT PRIMARY KEY,
  username TEXT NOT NULL,
  created_at TIMESTAMPTZ,
  expires_at TIMESTAMPTZ,
  last_activity_at TIMESTAMPTZ
)
```

### 3. API 接口

#### 登录
```
POST /api/auth/login
Body: { "username": "admin", "password": "your_password" }
Response: { "ok": true, "expiresAt": "..." }
Set-Cookie: admin_token=...; HttpOnly; SameSite=Strict
```

#### 登出
```
POST /api/auth/logout
Response: { "ok": true }
Set-Cookie: admin_token=; Max-Age=0
```

#### 检查登录状态
```
GET /api/auth/status
Response: { "authenticated": true, "username": "admin" }
```

#### 修改密码
```
POST /api/auth/change-password
Body: { "oldPassword": "...", "newPassword": "..." }
Response: { "ok": true }
```

### 4. 前端页面

#### 登录页面 (`/login.html`)
- 简洁的登录界面
- 实时错误提示
- 登录成功后跳转到首页

#### 修改密码页面 (`/change-password.html`)
- 验证旧密码
- 确认新密码一致性
- 密码长度限制（最少6位）
- 修改成功后自动跳转到登录页

#### 首页集成 (`/index.html` + `app.js`)
- 顶部显示登录状态
- 未登录时显示"未登录"和"立即登录"链接
- 已登录时显示用户名、修改密码和退出链接
- 所有写入操作前验证登录状态
- 401 响应自动跳转到登录页

### 5. 受保护的操作

以下操作需要先登录：
- ✅ 记录预测方向（选择胜/平/负或让球）
- ✅ 保存备注信息
- ✅ 清空当天所有记录
- ✅ 修改密码

以下操作无需登录：
- 📖 查看比赛列表
- 📖 查看历史预测记录
- 📖 查看赛果和红黑状态

## 首次启动

### 1. 启动服务
```bash
docker compose up -d --build
```

### 2. 查看初始密码
首次启动时，控制台会输出：
```
==========================================================
【管理员账户已创建】
用户名: admin
密码: admin123456
请立即登录并修改密码！
==========================================================
```

**重要提示**：这是默认密码，建议立即登录后修改。

### 3. 登录
访问 `http://localhost:4399/login.html`，使用上述账号登录。

### 4. 修改密码
登录后点击顶部"修改密码"链接，或直接访问 `http://localhost:4399/change-password.html`。

## 安全机制

### 密码加密
- 使用 PBKDF2-SHA512 算法
- 100,000 次迭代
- 32 字节随机盐值
- 64 字节哈希输出

### 会话管理
- 7 天有效期
- HttpOnly Cookie（防止 JavaScript 访问）
- SameSite=Strict（防止 CSRF 攻击）
- 生产环境自动启用 Secure 标志
- 内存 + 数据库双重存储
- 自动清理过期会话（每小时一次）

### 防护措施
- 定时比对防止时序攻击
- 登录失败统一返回"用户名或密码错误"
- 会话过期自动清理
- 修改密码后清除所有旧会话
- Cookie HttpOnly 防止 XSS 窃取

## 使用流程

```
用户访问首页
    ↓
查看比赛（无需登录）
    ↓
想要记录预测 → 检测未登录 → 跳转登录页
    ↓
输入用户名密码
    ↓
登录成功 → 设置 Cookie → 返回首页
    ↓
可以记录预测、保存备注、清空记录
    ↓
（可选）修改密码
    ↓
退出登录 → 清除 Cookie
```

## 故障排查

### 无法登录
1. 检查数据库是否正常连接
2. 查看控制台是否有初始密码输出
3. 确认密码输入正确（区分大小写）

### 登录后仍提示未登录
1. 检查浏览器是否启用 Cookie
2. 查看浏览器控制台是否有错误
3. 确认服务端时间正确（影响会话过期）

### 忘记密码
1. 停止服务：`docker compose down`
2. 删除数据库数据：`docker compose down -v`
3. 重新启动：`docker compose up -d --build`
4. 系统会重新创建默认账户并输出新密码

## 技术栈

- **认证模块**：独立的 `AuthModule` 类
- **密码加密**：Node.js `crypto.pbkdf2Sync`
- **会话存储**：PostgreSQL + 内存缓存
- **Cookie 管理**：HttpOnly + SameSite + Secure
- **前端集成**：原生 JavaScript，无额外依赖

## 未来扩展

如果需要多用户支持，可以扩展以下功能：
- 添加注册接口
- 角色权限管理
- 用户管理页面
- 操作日志审计
- 登录失败次数限制
- 双因素认证

当前实现已经满足个人使用的安全需求，无需额外配置即可防止未授权访问。
