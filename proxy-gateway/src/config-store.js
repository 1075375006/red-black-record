const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const dataDir = process.env.DATA_DIR || '/data';
const configPath = path.join(dataDir, 'config.json');
const auditPath = path.join(dataDir, 'audit.log');
const defaultConfig = () => ({
  version: 1, revision: 1, enabled: false, fallbackToDirect: false,
  timeoutMs: 15000, totalTimeoutMs: 40000, failureThreshold: 3,
  cooldownMs: 60000, healthCheckIntervalMs: 600000,
  allowedHosts: ['webapi.sporttery.cn'], proxies: []
});

function secretKey() {
  let raw = process.env.PROXY_SECRET_KEY || '';
  if (!raw) {
    try {
      fs.mkdirSync(dataDir, { recursive: true, mode: 0o700 });
      const keyPath = path.join(dataDir, '.secret-key');
      if (fs.existsSync(keyPath)) raw = fs.readFileSync(keyPath, 'utf8').trim();
      else {
        raw = crypto.randomBytes(32).toString('hex');
        fs.writeFileSync(keyPath, raw + '\\n', { mode: 0o600, flag: 'wx' });
      }
    } catch (error) { console.error('代理密码密钥初始化失败：' + error.message); return null; }
  }
  try {
    const value = /^[0-9a-f]{64}$/i.test(raw) ? Buffer.from(raw, 'hex') : Buffer.from(raw, 'base64');
    return value.length === 32 ? value : null;
  } catch { return null; }
}
const key = secretKey();

function encrypt(value) {
  if (!value) return '';
  if (!key) throw new Error('PROXY_SECRET_KEY 无效或未配置，不能安全保存代理密码');
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
  const encrypted = Buffer.concat([cipher.update(value, 'utf8'), cipher.final()]);
  return `v1:${iv.toString('hex')}:${cipher.getAuthTag().toString('hex')}:${encrypted.toString('hex')}`;
}
function decrypt(value) {
  if (!value) return '';
  if (!key) throw new Error('PROXY_SECRET_KEY 无效或未配置');
  const [, ivHex, tagHex, bodyHex] = value.split(':');
  const decipher = crypto.createDecipheriv('aes-256-gcm', key, Buffer.from(ivHex, 'hex'));
  decipher.setAuthTag(Buffer.from(tagHex, 'hex'));
  return Buffer.concat([decipher.update(Buffer.from(bodyHex, 'hex')), decipher.final()]).toString('utf8');
}
function publicConfig(config) {
  return { ...config, proxies: config.proxies.map(({ passwordEnc, password, ...proxy }) => ({ ...proxy, hasPassword: Boolean(passwordEnc) })) };
}
function appendAudit(entry) {
  const line = JSON.stringify({ at: new Date().toISOString(), ...entry }) + '\n';
  try {
    if (fs.existsSync(auditPath) && fs.statSync(auditPath).size > 5 * 1024 * 1024) fs.renameSync(auditPath, auditPath + '.1');
    fs.appendFileSync(auditPath, line, { mode: 0o600 });
  } catch (error) { console.error('审计日志写入失败：' + error.message); }
}

let config = null;
let writeQueue = Promise.resolve();
async function initConfig() {
  fs.mkdirSync(dataDir, { recursive: true, mode: 0o700 });
  try {
    config = JSON.parse(fs.readFileSync(configPath, 'utf8'));
    if (!Array.isArray(config.proxies)) config.proxies = [];
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
    config = defaultConfig();
    const bootstrap = process.env.PROXY_BOOTSTRAP_URL || process.env.UPSTREAM_SOCKS5_PROXY || '';
    if (bootstrap) {
      const parsed = new URL(bootstrap);
      if (!['socks5:', 'socks5h:'].includes(parsed.protocol) || !parsed.hostname || !parsed.port) throw new Error('PROXY_BOOTSTRAP_URL 格式无效');
      if (!key && parsed.password) console.warn('警告：未配置有效 PROXY_SECRET_KEY，旧代理密码无法导入');
      config.enabled = true;
      config.proxies.push({
        id: 'px_' + crypto.randomBytes(4).toString('hex'), name: '从环境变量导入',
        protocol: parsed.protocol.slice(0, -1), host: parsed.hostname,
        port: Number(parsed.port), username: decodeURIComponent(parsed.username),
        passwordEnc: parsed.password ? encrypt(decodeURIComponent(parsed.password)) : '',
        enabled: true, priority: 1, remark: '首次启动自动迁移',
        createdAt: new Date().toISOString(), updatedAt: new Date().toISOString()
      });
    }
    await saveConfig(config, null, 'system', 'bootstrap');
  }
  return config;
}
function getConfig() { return config; }
async function saveConfig(next, expectedRevision, actor, action) {
  const operation = writeQueue.then(async () => {
    if (expectedRevision !== null && expectedRevision !== undefined && Number(expectedRevision) !== Number(config.revision)) {
      const error = new Error('配置已在其他页面修改，请刷新'); error.statusCode = 409; throw error;
    }
    next.revision = Number(config.revision || 0) + 1;
    next.version = 1;
    const temp = configPath + '.tmp';
    if (fs.existsSync(configPath)) fs.copyFileSync(configPath, configPath + '.bak');
    const fd = fs.openSync(temp, 'w', 0o600);
    try { fs.writeFileSync(fd, JSON.stringify(next, null, 2)); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
    fs.renameSync(temp, configPath);
    config = next;
    appendAudit({ actor: actor || 'system', action, summary: action });
  });
  writeQueue = operation.catch(() => {});
  await operation;
  return config;
}
function readAudit(limit = 100) {
  try { return fs.readFileSync(auditPath, 'utf8').trim().split('\n').filter(Boolean).slice(-limit).reverse().map(line => JSON.parse(line)); }
  catch { return []; }
}
function encodePassword(password) { return encrypt(password); }
function decodePassword(passwordEnc) { return decrypt(passwordEnc); }
module.exports = { initConfig, getConfig, publicConfig, saveConfig, appendAudit, readAudit, encodePassword, decodePassword, encryptionReady: Boolean(key) };
