const DEFAULT_HEADERS = {
  Accept: 'application/json, text/javascript, */*; q=0.01',
  'Accept-Encoding': 'identity',
  Origin: 'https://www.sporttery.cn',
  Referer: 'https://www.sporttery.cn/',
  'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/152 Safari/537.36'
};
const gatewayUrl = (process.env.UPSTREAM_GATEWAY_URL || '').replace(/\/$/, '');
const gatewayFallback = process.env.UPSTREAM_GATEWAY_FALLBACK || 'fail';
function describeError(status, route) { return new Error(`上游接口返回 ${status}（出口：${route}）`); }
async function getJson(url) {
  if (!gatewayUrl) {
    const response = await fetch(url, { method: 'GET', headers: DEFAULT_HEADERS, signal: AbortSignal.timeout(30000) });
    if (!response.ok) throw describeError(response.status, 'direct');
    return response.json();
  }
  let response;
  try {
    response = await fetch(gatewayUrl + '/relay', {
      method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Relay-Token': process.env.RELAY_TOKEN || '' },
      body: JSON.stringify({ url, headers: DEFAULT_HEADERS }), signal: AbortSignal.timeout(45000)
    });
  } catch (error) {
    if (gatewayFallback === 'direct') {
      const direct = await fetch(url, { method: 'GET', headers: DEFAULT_HEADERS, signal: AbortSignal.timeout(30000) });
      if (!direct.ok) throw describeError(direct.status, 'direct fallback');
      return direct.json();
    }
    throw new Error(`代理网关不可达：${error.message}`);
  }
  if (!response.ok) {
    let payload = null; try { payload = await response.json(); } catch {}
    const error = new Error(payload?.error || `代理网关返回 ${response.status}`);
    error.statusCode = response.status; throw error;
  }
  return response.json();
}
async function getStatus() {
  if (!gatewayUrl) return { ok: true, mode: 'direct', activeProxies: 0 };
  const response = await fetch(gatewayUrl + '/healthz', { signal: AbortSignal.timeout(5000) });
  if (!response.ok) throw new Error(`网关状态返回 ${response.status}`);
  return response.json();
}
module.exports = { getJson, getStatus, gatewayConfigured: Boolean(gatewayUrl) };
