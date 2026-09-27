const https = require('https');
const http = require('http');
const { SocksProxyAgent } = require('socks-proxy-agent');
const store = require('./config-store');

const runtime = new Map();
const requestLogs = [];
const agents = new Map();
function stateFor(id) {
  if (!runtime.has(id)) runtime.set(id, { failures: 0, cooldownUntil: 0, lastCheckAt: null, lastOk: null, latencyMs: null, totalSuccess: 0, totalFailure: 0, lastError: null });
  return runtime.get(id);
}
function getAgent(proxy) {
  const fingerprint = JSON.stringify([proxy.protocol, proxy.host, proxy.port, proxy.username, proxy.passwordEnc]);
  const cached = agents.get(proxy.id);
  if (cached && cached.fingerprint === fingerprint) return cached.agent;
  if (cached) { cached.agent.destroy(); agents.delete(proxy.id); }
  const username = encodeURIComponent(proxy.username || '');
  const password = encodeURIComponent(proxy.passwordEnc ? store.decodePassword(proxy.passwordEnc) : '');
  const auth = username ? `${username}:${password}@` : '';
  const agent = new SocksProxyAgent(`${proxy.protocol}://${auth}${proxy.host}:${proxy.port}`);
  agents.set(proxy.id, { fingerprint, agent });
  return agent;
}
function destroyRemovedAgents(config) {
  const valid = new Set(config.proxies.map(proxy => proxy.id));
  for (const [id, entry] of agents) if (!valid.has(id)) { entry.agent.destroy(); agents.delete(id); }
}
function parseTarget(rawUrl, allowedHosts) {
  let target;
  try { target = new URL(rawUrl); } catch { throw Object.assign(new Error('目标 URL 无效'), { statusCode: 400 }); }
  const allowedPaths = new Set([
    '/gateway/uniform/football/getMatchCalculatorV1.qry',
    '/gateway/uniform/football/getUniformMatchResultV1.qry'
  ]);
  if (target.protocol !== 'https:' || target.port && target.port !== '443' || !allowedHosts.includes(target.hostname.toLowerCase()) || !allowedPaths.has(target.pathname)) {
    throw Object.assign(new Error(`目标接口不在允许范围：${target.hostname}${target.pathname}`), { statusCode: 403 });
  }
  return target;
}
function requestRaw(target, headers, agent, timeoutMs) {
  return new Promise((resolve, reject) => {
    const request = https.get(target, { agent, headers }, response => {
      const chunks = [];
      response.on('data', chunk => chunks.push(chunk));
      response.on('end', () => resolve({ statusCode: response.statusCode || 502, headers: response.headers, body: Buffer.concat(chunks) }));
    });
    request.setTimeout(timeoutMs, () => request.destroy(new Error('上游请求超时')));
    request.on('error', reject);
  });
}
async function directRequest(target, headers, timeoutMs) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(target, { headers, signal: controller.signal });
    return { statusCode: response.status, headers: Object.fromEntries(response.headers.entries()), body: Buffer.from(await response.arrayBuffer()) };
  } finally { clearTimeout(timer); }
}
function safeHeaders(input) {
  const allowed = ['accept', 'accept-encoding', 'origin', 'referer', 'user-agent'];
  const result = {};
  for (const [name, value] of Object.entries(input || {})) if (allowed.includes(name.toLowerCase()) && typeof value === 'string') result[name] = value.slice(0, 1000);
  return result;
}
function log(entry) {
  requestLogs.push({ at: new Date().toISOString(), ...entry });
  if (requestLogs.length > 500) requestLogs.splice(0, requestLogs.length - 500);
}
function canRetry(statusCode) { return statusCode === 403 || statusCode >= 500; }
async function relay({ url, headers }) {
  const config = store.getConfig();
  const target = parseTarget(url, config.allowedHosts || ['webapi.sporttery.cn']);
  const safe = safeHeaders(headers);
  const start = Date.now();
  const attempts = [];
  const timeout = Math.max(1000, Number(config.timeoutMs) || 15000);
  const total = Math.max(timeout, Number(config.totalTimeoutMs) || 40000);
  const proxies = config.enabled ? config.proxies.filter(item => item.enabled).sort((a, b) => a.priority - b.priority) : [];
  if (config.enabled && !proxies.length && !config.fallbackToDirect) throw Object.assign(new Error('代理已开启，但没有可用的代理条目'), { statusCode: 503 });

  async function attempt(proxy) {
    if (Date.now() - start >= total) throw new Error('已达到转发总超时');
    const state = proxy ? stateFor(proxy.id) : null;
    const name = proxy ? proxy.name : 'direct';
    if (state && state.cooldownUntil > Date.now()) return null;
    try {
      const response = proxy ? await requestRaw(target, safe, getAgent(proxy), Math.min(timeout, total - (Date.now() - start))) : await directRequest(target, safe, Math.min(timeout, total - (Date.now() - start)));
      if (canRetry(response.statusCode)) throw Object.assign(new Error(`上游返回 HTTP ${response.statusCode}`), { retryable: true, upstreamResponse: response });
      if (state) { state.failures = 0; state.cooldownUntil = 0; state.lastOk = true; state.lastCheckAt = new Date().toISOString(); state.latencyMs = Date.now() - start; state.totalSuccess++; state.lastError = null; }
      log({ path: target.pathname, route: proxy ? `proxy:${proxy.id}` : 'direct', statusCode: response.statusCode, latencyMs: Date.now() - start, attempts: attempts.length + 1 });
      return { ...response, route: proxy ? `proxy:${proxy.id}` : 'direct', attempts: attempts.length + 1, latencyMs: Date.now() - start };
    } catch (error) {
      const retryable = error.retryable || !error.upstreamResponse;
      attempts.push({ proxy: proxy?.name || 'direct', error: error.message });
      if (state) {
        state.failures++; state.totalFailure++; state.lastOk = false; state.lastCheckAt = new Date().toISOString(); state.lastError = error.message;
        if (state.failures >= (Number(config.failureThreshold) || 3)) state.cooldownUntil = Date.now() + (Number(config.cooldownMs) || 60000);
      }
      if (!retryable) return { ...error.upstreamResponse, route: proxy ? `proxy:${proxy.id}` : 'direct', attempts: attempts.length, latencyMs: Date.now() - start };
      return null;
    }
  }

  for (const proxy of proxies) {
    const result = await attempt(proxy);
    if (result) return result;
  }
  if (!config.enabled || config.fallbackToDirect) {
    const result = await attempt(null);
    if (result) return result;
  }
  log({ path: target.pathname, route: 'failed', statusCode: 502, latencyMs: Date.now() - start, attempts: attempts.length, error: '所有出口失败' });
  throw Object.assign(new Error('所有代理均不可用'), { statusCode: 502, attempts });
}
function runtimeState() {
  const config = store.getConfig();
  return config.proxies.map(proxy => {
    const state = stateFor(proxy.id);
    return { id: proxy.id, enabled: proxy.enabled, status: state.cooldownUntil > Date.now() ? 'cooldown' : state.lastOk === true ? 'ok' : state.lastOk === false ? 'failed' : 'unknown', ...state, cooldownUntil: state.cooldownUntil || null };
  });
}
function getLogs(limit = 100) { return requestLogs.slice(-Math.max(1, Math.min(500, limit))).reverse(); }
async function testProxy(proxy) {
  const start = Date.now();
  const target = new URL('https://webapi.sporttery.cn/gateway/uniform/football/getMatchCalculatorV1.qry?channel=c&poolCode=hhad,had');
  const steps = [];
  try {
    const response = await requestRaw(target, { Accept: 'application/json', 'User-Agent': 'red-black-record-proxy-gateway' }, getAgent(proxy), 15000);
    steps.push({ name: 'SOCKS5 连接与体彩接口请求', ok: response.statusCode >= 200 && response.statusCode < 300, ms: Date.now() - start, statusCode: response.statusCode });
    let parsed = null;
    try { parsed = JSON.parse(response.body.toString('utf8')); } catch {}
    const ok = response.statusCode >= 200 && response.statusCode < 300 && parsed && parsed.success !== false;
    return { ok: Boolean(ok), latencyMs: Date.now() - start, steps, exitIp: null, error: ok ? null : '体彩接口响应异常' };
  } catch (error) {
    steps.push({ name: 'SOCKS5 连接与体彩接口请求', ok: false, ms: Date.now() - start, error: error.message });
    return { ok: false, latencyMs: Date.now() - start, steps, exitIp: null, error: error.message };
  }
}
async function healthCheck() {
  const config = store.getConfig();
  for (const proxy of config.proxies.filter(item => item.enabled)) {
    const result = await testProxy(proxy);
    const state = stateFor(proxy.id);
    state.lastCheckAt = new Date().toISOString(); state.latencyMs = result.latencyMs; state.lastOk = result.ok;
    state.lastError = result.error;
    if (result.ok) { state.failures = 0; state.cooldownUntil = 0; state.totalSuccess++; }
    else { state.failures++; state.totalFailure++; if (state.failures >= config.failureThreshold) state.cooldownUntil = Date.now() + config.cooldownMs; }
  }
}
module.exports = { relay, runtimeState, getLogs, testProxy, healthCheck, destroyRemovedAgents };
