const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const store = require('./config-store');
const relay = require('./relay');

const PORT = Number(process.env.PORT || 4398);
const PUBLIC = path.join(__dirname, '..', 'public');
const relayToken = process.env.RELAY_TOKEN || '';
const adminToken = process.env.PROXY_ADMIN_TOKEN || '';
function tokenEquals(a, b) {
  const left = Buffer.from(String(a || '')); const right = Buffer.from(String(b || ''));
  return left.length === right.length && left.length > 0 && crypto.timingSafeEqual(left, right);
}
function json(res, code, value) { res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' }); res.end(JSON.stringify(value)); }
async function body(req) {
  let raw = ''; for await (const chunk of req) { raw += chunk; if (raw.length > 100000) throw Object.assign(new Error('请求内容过大'), { statusCode: 413 }); }
  try { return raw ? JSON.parse(raw) : {}; } catch { throw Object.assign(new Error('JSON 格式无效'), { statusCode: 400 }); }
}
function safeState() {
  const config = store.getConfig();
  return { ...store.publicConfig(config), runtime: relay.runtimeState(), encryptionReady: store.encryptionReady };
}
function privateAddress(host) {
  const h = host.toLowerCase();
  return h === 'localhost' || h.endsWith('.localhost') || h === '::1' || h === '0.0.0.0' || /^(10\.|127\.|169\.254\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.)/.test(h);
}
function validateProxy(input, existing = null) {
  const protocol = input.protocol || existing?.protocol || 'socks5h';
  const host = String(input.host ?? existing?.host ?? '').trim();
  const port = Number(input.port ?? existing?.port);
  const name = String(input.name ?? existing?.name ?? '').trim();
  if (!['socks5', 'socks5h'].includes(protocol)) throw Object.assign(new Error('协议仅支持 socks5 或 socks5h'), { statusCode: 400 });
  if (!host || host.length > 253 || /[\s/@?#]/.test(host) || privateAddress(host)) throw Object.assign(new Error('代理地址无效或属于本机/内网地址'), { statusCode: 400 });
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw Object.assign(new Error('端口必须是 1–65535 的整数'), { statusCode: 400 });
  if (!name || name.length > 30) throw Object.assign(new Error('名称必须为 1–30 个字符'), { statusCode: 400 });
  const sanitized = { ...existing, ...input };
  delete sanitized.password;
  delete sanitized.revision;
  return { ...sanitized, id: existing?.id || input.id || 'px_' + crypto.randomBytes(4).toString('hex'), name, protocol, host, port, username: String(input.username ?? existing?.username ?? '').slice(0, 255), remark: String(input.remark ?? existing?.remark ?? '').slice(0, 100), enabled: input.enabled === undefined ? (existing?.enabled ?? true) : Boolean(input.enabled), priority: Number(input.priority ?? existing?.priority ?? 100), updatedAt: new Date().toISOString(), createdAt: existing?.createdAt || new Date().toISOString() };
}
async function adminApi(req, res, pathname, user) {
  if (!tokenEquals(req.headers['x-admin-token'], adminToken)) return json(res, 401, { error: '管理令牌无效' });
  const url = new URL(req.url, 'http://gateway');
  const config = store.getConfig();
  const data = ['POST', 'PUT', 'DELETE'].includes(req.method) ? await body(req) : {};
  if (req.method === 'GET' && pathname === '/admin/api/state') return json(res, 200, safeState());
  if (req.method === 'GET' && pathname === '/admin/api/logs') return json(res, 200, { logs: relay.getLogs(Number(url.searchParams.get('limit') || 100)) });
  if (req.method === 'GET' && pathname === '/admin/api/audit') return json(res, 200, { audit: store.readAudit(Number(url.searchParams.get('limit') || 100)) });
  if (req.method === 'PUT' && pathname === '/admin/api/settings') {
    const next = { ...config, ...data };
    if (data.allowedHosts && (!Array.isArray(data.allowedHosts) || data.allowedHosts.length !== 1 || data.allowedHosts[0] !== 'webapi.sporttery.cn')) throw Object.assign(new Error('代理网关只允许访问体彩接口域名 webapi.sporttery.cn'), { statusCode: 400 });
    for (const key of ['timeoutMs', 'totalTimeoutMs', 'failureThreshold', 'cooldownMs', 'healthCheckIntervalMs']) if (data[key] !== undefined && (!Number.isInteger(Number(data[key])) || Number(data[key]) < 1000)) throw Object.assign(new Error(`${key} 数值无效`), { statusCode: 400 });
    await store.saveConfig(next, data.revision, user, 'update-settings'); return json(res, 200, safeState());
  }
  if (req.method === 'POST' && pathname === '/admin/api/proxies/parse') {
    let parsed; try { parsed = new URL(data.url); } catch { throw Object.assign(new Error('代理 URL 格式无效'), { statusCode: 400 }); }
    if (!['socks5:', 'socks5h:'].includes(parsed.protocol) || !parsed.hostname || !parsed.port) throw Object.assign(new Error('仅支持完整的 socks5:// 或 socks5h:// 地址'), { statusCode: 400 });
    return json(res, 200, { protocol: parsed.protocol.slice(0, -1), host: parsed.hostname, port: Number(parsed.port), username: decodeURIComponent(parsed.username), password: decodeURIComponent(parsed.password) });
  }
  if (req.method === 'POST' && pathname === '/admin/api/proxies/test') {
    const proxy = validateProxy(data); proxy.passwordEnc = data.password ? store.encodePassword(String(data.password)) : '';
    return json(res, 200, await relay.testProxy(proxy));
  }
  if (req.method === 'POST' && pathname === '/admin/api/proxies') {
    const proxy = validateProxy(data);
    proxy.passwordEnc = data.password ? store.encodePassword(String(data.password)) : '';
    const next = { ...config, proxies: [...config.proxies, proxy] };
    await store.saveConfig(next, data.revision, user, 'create-proxy'); return json(res, 201, safeState());
  }
  const match = pathname.match(/^\/admin\/api\/proxies\/([^/]+)(?:\/(test|toggle))?$/);
  if (match) {
    const id = decodeURIComponent(match[1]); const index = config.proxies.findIndex(item => item.id === id);
    if (index < 0) return json(res, 404, { error: '代理不存在' });
    if (req.method === 'POST' && match[2] === 'test') return json(res, 200, await relay.testProxy(config.proxies[index]));
    const proxies = [...config.proxies];
    if (req.method === 'POST' && match[2] === 'toggle') proxies[index] = { ...proxies[index], enabled: !proxies[index].enabled, updatedAt: new Date().toISOString() };
    else if (req.method === 'PUT' && !match[2]) {
      const old = proxies[index]; const updated = validateProxy(data, old);
      updated.passwordEnc = data.password ? store.encodePassword(String(data.password)) : old.passwordEnc;
      proxies[index] = updated;
    } else if (req.method === 'DELETE' && !match[2]) proxies.splice(index, 1);
    else return json(res, 405, { error: '不支持的操作' });
    const next = { ...config, proxies };
    await store.saveConfig(next, data.revision, user, match[2] || (req.method === 'DELETE' ? 'delete-proxy' : 'update-proxy'));
    relay.destroyRemovedAgents(next); return json(res, 200, safeState());
  }
  if (req.method === 'PUT' && pathname === '/admin/api/proxies/order') {
    if (!Array.isArray(data.order) || data.order.length !== config.proxies.length || new Set(data.order).size !== config.proxies.length || data.order.some(id => !config.proxies.some(proxy => proxy.id === id))) throw Object.assign(new Error('代理排序列表无效'), { statusCode: 400 });
    const next = { ...config, proxies: data.order.map((id, i) => ({ ...config.proxies.find(proxy => proxy.id === id), priority: i + 1 })) };
    await store.saveConfig(next, data.revision, user, 'reorder-proxies'); return json(res, 200, safeState());
  }
  return json(res, 404, { error: '接口不存在' });
}
function serveAdminPage(req, res, pathname) {
  const name = pathname === '/' || pathname === '/index.html' ? 'index.html' : pathname.slice(1);
  const file = path.resolve(PUBLIC, name);
  if (!file.startsWith(path.resolve(PUBLIC) + path.sep)) return json(res, 400, { error: '非法路径' });
  fs.stat(file, (err, stat) => {
    if (err || !stat.isFile()) return json(res, 404, { error: '页面不存在' });
    const ext = path.extname(file); const types = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8' };
    res.writeHead(200, { 'Content-Type': types[ext] || 'application/octet-stream', 'Cache-Control': 'no-store' }); fs.createReadStream(file).pipe(res);
  });
}
const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://gateway'); const pathname = url.pathname;
  try {
    if (req.method === 'GET' && pathname === '/healthz') return json(res, 200, { ok: true, mode: store.getConfig().enabled ? 'proxy' : 'direct', activeProxies: store.getConfig().proxies.filter(item => item.enabled).length });
    if (req.method === 'POST' && pathname === '/relay') {
      if (!tokenEquals(req.headers['x-relay-token'], relayToken)) return json(res, 401, { error: 'relay token 无效' });
      const data = await body(req); const result = await relay.relay(data);
      res.writeHead(result.statusCode, { 'Content-Type': result.headers['content-type'] || 'application/json; charset=utf-8', 'Cache-Control': 'no-store', 'X-Relay-Route': result.route, 'X-Relay-Attempts': String(result.attempts), 'X-Relay-Latency': String(result.latencyMs) });
      return res.end(result.body);
    }
    if (pathname.startsWith('/admin/api/')) return await adminApi(req, res, pathname, req.headers['x-admin-user'] || 'admin');
    if (req.method === 'GET') return serveAdminPage(req, res, pathname);
    return json(res, 405, { error: '仅支持 GET' });
  } catch (error) { return json(res, error.statusCode || 502, { error: error.message || '网关请求失败', attempts: error.attempts }); }
});
(async () => {
  if (!relayToken || !adminToken) throw new Error('RELAY_TOKEN 和 PROXY_ADMIN_TOKEN 必须配置');
  await store.initConfig();
  server.listen(PORT, '0.0.0.0', () => console.log(`代理网关已启动，端口 ${PORT}`));
  setInterval(() => relay.healthCheck().catch(error => console.error('代理健康检查失败：' + error.message)), Math.max(60000, Number(store.getConfig().healthCheckIntervalMs) || 600000));
})().catch(error => { console.error('代理网关启动失败：' + error.message); process.exit(1); });
