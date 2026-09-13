const crypto = require('crypto');

/**
 * 独立的管理员认证模块
 * 负责用户验证、会话管理和访问控制
 */
class AuthModule {
  constructor(pool) {
    this.pool = pool;
    this.sessions = new Map(); // matchId -> { token, expiresAt, username }
    this.SESSION_TTL = 7 * 24 * 60 * 60 * 1000; // 7天
  }

  /**
   * 初始化认证相关的数据库表
   */
  async initDb() {
    if (!this.pool) return;
    await this.pool.query(`
      CREATE TABLE IF NOT EXISTS admin_users (
        username TEXT PRIMARY KEY,
        password_hash TEXT NOT NULL,
        salt TEXT NOT NULL,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        last_login_at TIMESTAMPTZ
      );
      CREATE TABLE IF NOT EXISTS admin_sessions (
        token TEXT PRIMARY KEY,
        username TEXT NOT NULL REFERENCES admin_users(username) ON DELETE CASCADE,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        expires_at TIMESTAMPTZ NOT NULL,
        last_activity_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );
      CREATE INDEX IF NOT EXISTS admin_sessions_username_idx ON admin_sessions (username);
      CREATE INDEX IF NOT EXISTS admin_sessions_expires_idx ON admin_sessions (expires_at);
    `);

    // 检查是否有默认管理员，如果没有则创建
    const result = await this.pool.query('SELECT COUNT(*) FROM admin_users');
    if (Number(result.rows[0].count) === 0) {
      await this.createDefaultAdmin();
    }
  }

  /**
   * 创建默认管理员账户（首次启动时）
   */
  async createDefaultAdmin() {
    const username = 'admin';
    const password = 'admin123456';
    const { hash, salt } = this.hashPassword(password);

    await this.pool.query(
      'INSERT INTO admin_users (username, password_hash, salt) VALUES ($1, $2, $3)',
      [username, hash, salt]
    );

    console.log('\n' + '='.repeat(60));
    console.log('【管理员账户已创建】');
    console.log('用户名:', username);
    console.log('密码:', password);
    console.log('请立即登录并修改密码！');
    console.log('='.repeat(60) + '\n');
  }

  /**
   * 生成随机密码
   */
  generateRandomPassword(length = 12) {
    const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz23456789';
    let password = '';
    const randomBytes = crypto.randomBytes(length);
    for (let i = 0; i < length; i++) {
      password += chars[randomBytes[i] % chars.length];
    }
    return password;
  }

  /**
   * 密码哈希
   */
  hashPassword(password, salt = null) {
    if (!salt) {
      salt = crypto.randomBytes(32).toString('hex');
    }
    const hash = crypto.pbkdf2Sync(password, salt, 100000, 64, 'sha512').toString('hex');
    return { hash, salt };
  }

  /**
   * 验证密码
   */
  verifyPassword(password, hash, salt) {
    const { hash: computedHash } = this.hashPassword(password, salt);
    return crypto.timingSafeEqual(Buffer.from(hash, 'hex'), Buffer.from(computedHash, 'hex'));
  }

  /**
   * 生成会话令牌
   */
  generateToken() {
    return crypto.randomBytes(32).toString('hex');
  }

  /**
   * 用户登录
   */
  async login(username, password) {
    if (!this.pool) throw new Error('数据库未连接');

    const result = await this.pool.query(
      'SELECT password_hash, salt FROM admin_users WHERE username = $1',
      [username]
    );

    if (result.rows.length === 0) {
      throw new Error('用户名或密码错误');
    }

    const { password_hash, salt } = result.rows[0];
    if (!this.verifyPassword(password, password_hash, salt)) {
      throw new Error('用户名或密码错误');
    }

    // 创建会话
    const token = this.generateToken();
    const expiresAt = new Date(Date.now() + this.SESSION_TTL);

    await this.pool.query(
      'INSERT INTO admin_sessions (token, username, expires_at) VALUES ($1, $2, $3)',
      [token, username, expiresAt]
    );

    await this.pool.query(
      'UPDATE admin_users SET last_login_at = NOW() WHERE username = $1',
      [username]
    );

    // 同时存入内存缓存
    this.sessions.set(token, { username, expiresAt });

    return { token, expiresAt };
  }

  /**
   * 用户登出
   */
  async logout(token) {
    if (!token) return;

    this.sessions.delete(token);

    if (this.pool) {
      await this.pool.query('DELETE FROM admin_sessions WHERE token = $1', [token]);
    }
  }

  /**
   * 验证会话
   */
  async verifySession(token) {
    if (!token) return null;

    // 先查内存缓存
    let session = this.sessions.get(token);
    if (session) {
      if (new Date() > session.expiresAt) {
        this.sessions.delete(token);
        if (this.pool) {
          await this.pool.query('DELETE FROM admin_sessions WHERE token = $1', [token]);
        }
        return null;
      }
      return { username: session.username };
    }

    // 查数据库
    if (!this.pool) return null;

    const result = await this.pool.query(
      'SELECT username, expires_at FROM admin_sessions WHERE token = $1',
      [token]
    );

    if (result.rows.length === 0) return null;

    const { username, expires_at } = result.rows[0];
    const expiresAt = new Date(expires_at);

    if (new Date() > expiresAt) {
      await this.pool.query('DELETE FROM admin_sessions WHERE token = $1', [token]);
      return null;
    }

    // 更新最后活动时间
    await this.pool.query(
      'UPDATE admin_sessions SET last_activity_at = NOW() WHERE token = $1',
      [token]
    );

    // 加入内存缓存
    this.sessions.set(token, { username, expiresAt });

    return { username };
  }

  /**
   * 修改密码
   */
  async changePassword(username, oldPassword, newPassword) {
    if (!this.pool) throw new Error('数据库未连接');

    const result = await this.pool.query(
      'SELECT password_hash, salt FROM admin_users WHERE username = $1',
      [username]
    );

    if (result.rows.length === 0) {
      throw new Error('用户不存在');
    }

    const { password_hash, salt } = result.rows[0];
    if (!this.verifyPassword(oldPassword, password_hash, salt)) {
      throw new Error('原密码错误');
    }

    if (newPassword.length < 6) {
      throw new Error('新密码长度至少为6位');
    }

    const { hash: newHash, salt: newSalt } = this.hashPassword(newPassword);

    await this.pool.query(
      'UPDATE admin_users SET password_hash = $1, salt = $2 WHERE username = $3',
      [newHash, newSalt, username]
    );

    // 清除该用户的所有会话
    await this.pool.query('DELETE FROM admin_sessions WHERE username = $1', [username]);

    // 清理内存缓存中该用户的会话
    for (const [token, session] of this.sessions.entries()) {
      if (session.username === username) {
        this.sessions.delete(token);
      }
    }
  }

  /**
   * 清理过期会话（定期任务）
   */
  async cleanExpiredSessions() {
    if (!this.pool) return;

    await this.pool.query('DELETE FROM admin_sessions WHERE expires_at < NOW()');

    // 清理内存缓存
    const now = new Date();
    for (const [token, session] of this.sessions.entries()) {
      if (now > session.expiresAt) {
        this.sessions.delete(token);
      }
    }
  }

  /**
   * HTTP 中间件：从 Cookie 中提取令牌并验证
   */
  async middleware(req) {
    const cookies = this.parseCookies(req.headers.cookie || '');
    const token = cookies['admin_token'];

    if (!token) return null;

    return await this.verifySession(token);
  }

  /**
   * 解析 Cookie
   */
  parseCookies(cookieHeader) {
    const cookies = {};
    if (!cookieHeader) return cookies;

    cookieHeader.split(';').forEach(cookie => {
      const [name, ...rest] = cookie.split('=');
      if (name && rest.length) {
        cookies[name.trim()] = decodeURIComponent(rest.join('=').trim());
      }
    });

    return cookies;
  }

  /**
   * 生成 Set-Cookie 头
   */
  generateSetCookieHeader(token, expiresAt) {
    const secure = process.env.NODE_ENV === 'production' ? 'Secure; ' : '';
    return `admin_token=${token}; HttpOnly; ${secure}SameSite=Strict; Path=/; Expires=${expiresAt.toUTCString()}`;
  }

  /**
   * 生成清除 Cookie 的头
   */
  generateClearCookieHeader() {
    return 'admin_token=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0';
  }
}

module.exports = AuthModule;
