const http = require('http');
const fs = require('fs');
const path = require('path');
const { URL } = require('url');

const PORT = Number(process.env.PORT || 8787);
const ROOT = __dirname;
const PUBLIC_DIR = path.join(ROOT, 'public');

const API = {
  matches: 'https://webapi.sporttery.cn/gateway/uniform/football/getMatchCalculatorV1.qry?channel=c&poolCode=hhad,had',
  results: 'https://webapi.sporttery.cn/gateway/uniform/football/getUniformMatchResultV1.qry'
};

const cache = new Map();
const CACHE_TTL = 45 * 1000;

function json(res, status, payload) {
  const body = JSON.stringify(payload);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
    'Access-Control-Allow-Origin': '*'
  });
  res.end(body);
}

function validDate(value) {
  return /^\d{4}-\d{2}-\d{2}$/.test(value || '');
}

function addDays(dateText, amount) {
  const date = new Date(dateText + 'T12:00:00+08:00');
  date.setDate(date.getDate() + amount);
  return date.toISOString().slice(0, 10);
}

async function upstream(url) {
  const response = await fetch(url, {
    method: 'GET',
    headers: {
      Accept: 'application/json, text/javascript, */*; q=0.01',
      Origin: 'https://www.sporttery.cn',
      Referer: 'https://www.sporttery.cn/',
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/152 Safari/537.36'
    }
  });
  if (!response.ok) throw new Error('上游接口返回 ' + response.status);
  return response.json();
}

async function cached(key, loader) {
  const hit = cache.get(key);
  if (hit && Date.now() - hit.time < CACHE_TTL) return hit.value;
  const value = await loader();
  cache.set(key, { time: Date.now(), value });
  return value;
}

async function getMatches() {
  return cached('matches', () => upstream(API.matches));
}

async function getResults(date) {
  const end = addDays(date, 1);
  const query = new URLSearchParams({
    matchBeginDate: date,
    matchEndDate: end,
    leagueId: '',
    pageSize: '100',
    pageNo: '1',
    isFix: '0',
    matchPage: '1',
    pcOrWap: '1'
  });
  return cached('results:' + date, () => upstream(API.results + '?' + query.toString()));
}

function safeFile(filePath) {
  const absolute = path.resolve(PUBLIC_DIR, filePath.replace(/^[/\\]+/, ''));
  return absolute.startsWith(path.resolve(PUBLIC_DIR)) ? absolute : null;
}

function serveStatic(req, res, pathname) {
  const filePath = pathname === '/' ? path.join(PUBLIC_DIR, 'index.html') : safeFile(pathname);
  if (!filePath) return json(res, 400, { error: '非法路径' });
  fs.stat(filePath, (statError, stat) => {
    if (statError || !stat.isFile()) return json(res, 404, { error: '页面不存在' });
    const ext = path.extname(filePath).toLowerCase();
    const types = {
      '.html': 'text/html; charset=utf-8',
      '.js': 'text/javascript; charset=utf-8',
      '.css': 'text/css; charset=utf-8',
      '.json': 'application/json; charset=utf-8',
      '.svg': 'image/svg+xml'
    };
    res.writeHead(200, { 'Content-Type': types[ext] || 'application/octet-stream' });
    fs.createReadStream(filePath).pipe(res);
  });
}

const server = http.createServer(async (req, res) => {
  const requestUrl = new URL(req.url, 'http://' + (req.headers.host || 'localhost'));
  try {
    if (req.method === 'GET' && requestUrl.pathname === '/api/matches') {
      const data = await getMatches();
      return json(res, 200, { fetchedAt: new Date().toISOString(), data });
    }
    if (req.method === 'GET' && requestUrl.pathname === '/api/results') {
      const date = requestUrl.searchParams.get('date');
      if (!validDate(date)) return json(res, 400, { error: '日期格式应为 YYYY-MM-DD' });
      const data = await getResults(date);
      return json(res, 200, { fetchedAt: new Date().toISOString(), data });
    }
    if (req.method === 'GET') return serveStatic(req, res, requestUrl.pathname);
    return json(res, 405, { error: '仅支持 GET' });
  } catch (error) {
    console.error(error);
    return json(res, 502, { error: error.message || '接口请求失败' });
  }
});

server.listen(PORT, () => {
  console.log('红黑记录已启动：http://localhost:' + PORT);
});
