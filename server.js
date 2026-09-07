const http = require('http');
const fs = require('fs');
const path = require('path');
const { URL } = require('url');
const { Pool } = require('pg');

const PORT = Number(process.env.PORT || 8787);
const ROOT = __dirname;
const PUBLIC_DIR = path.join(ROOT, 'public');

const API = {
  matches: 'https://webapi.sporttery.cn/gateway/uniform/football/getMatchCalculatorV1.qry?channel=c&poolCode=hhad,had',
  results: 'https://webapi.sporttery.cn/gateway/uniform/football/getUniformMatchResultV1.qry'
};

const cache = new Map();
const CACHE_TTL = 45 * 1000;
const pool = process.env.DATABASE_URL ? new Pool({ connectionString: process.env.DATABASE_URL }) : null;

async function initDb() {
  if (!pool) return;
  await pool.query(`
    CREATE TABLE IF NOT EXISTS matches (
      match_id TEXT PRIMARY KEY,
      business_date DATE NOT NULL,
      match_date DATE,
      match_data JSONB NOT NULL,
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
    CREATE INDEX IF NOT EXISTS matches_business_date_idx ON matches (business_date);
    CREATE TABLE IF NOT EXISTS predictions (
      match_id TEXT PRIMARY KEY REFERENCES matches(match_id) ON DELETE CASCADE,
      market TEXT NOT NULL CHECK (market IN ('had', 'hhad')),
      pick TEXT CHECK (pick IN ('H', 'D', 'A')),
      handicap_line NUMERIC,
      note TEXT NOT NULL DEFAULT '',
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
  `);
}

async function saveMatches(matches) {
  if (!pool || !matches.length) return;
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    for (const match of matches) {
      await client.query(`
        INSERT INTO matches (match_id, business_date, match_date, match_data)
        VALUES ($1, $2::date, $3::date, $4::jsonb)
        ON CONFLICT (match_id) DO UPDATE SET
          business_date = EXCLUDED.business_date,
          match_date = EXCLUDED.match_date,
          match_data = EXCLUDED.match_data,
          updated_at = NOW()
      `, [String(match.matchId), match.businessDate || match.matchDate, match.matchDate || match.businessDate, JSON.stringify(match)]);
    }
    await client.query('COMMIT');
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}

async function getStoredMatches(date) {
  if (!pool) return [];
  const result = await pool.query('SELECT match_data AS match FROM matches WHERE business_date = $1 OR match_date = $1 ORDER BY match_date, match_data->>\'matchTime\'', [date]);
  return result.rows.map(row => row.match);
}

async function getPredictions(date) {
  if (!pool) return [];
  const result = await pool.query(`
    SELECT p.match_id AS "matchId", p.market, p.pick, p.handicap_line AS "handicapLine", p.note, p.updated_at AS "updatedAt"
    FROM predictions p JOIN matches m ON m.match_id = p.match_id
    WHERE m.business_date = $1 OR m.match_date = $1
  `, [date]);
  return result.rows;
}

async function savePrediction(payload) {
  if (!pool) return;
  const matchId = String(payload.matchId || '');
  if (!matchId || !['had', 'hhad'].includes(payload.market)) throw new Error('预测参数不完整');
  if (payload.pick !== null && !['H', 'D', 'A'].includes(payload.pick)) throw new Error('预测方向不正确');
  await pool.query(`
    INSERT INTO predictions (match_id, market, pick, handicap_line, note)
    VALUES ($1, $2, $3, $4, $5)
    ON CONFLICT (match_id) DO UPDATE SET
      market = EXCLUDED.market, pick = EXCLUDED.pick, handicap_line = EXCLUDED.handicap_line,
      note = EXCLUDED.note, updated_at = NOW()
  `, [matchId, payload.market, payload.pick || null, payload.handicapLine ?? null, String(payload.note || '').slice(0, 160)]);
}

async function deletePredictions(date) {
  if (!pool) return;
  await pool.query('DELETE FROM predictions p USING matches m WHERE p.match_id = m.match_id AND (m.business_date = $1 OR m.match_date = $1)', [date]);
}

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

function todayLocal() {
  const now = new Date();
  const utc = now.getTime() + now.getTimezoneOffset() * 60000;
  return new Date(utc + 8 * 60 * 60000).toISOString().slice(0, 10);
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
      const date = requestUrl.searchParams.get('date');
      const data = await getMatches();
      const live = data?.value?.matchInfoList?.flatMap(group => (group.subMatchList || []).map(match => ({ ...match, businessDate: match.businessDate || group.businessDate }))) || [];
      if (pool) await saveMatches(live);
      const stored = date && validDate(date) ? await getStoredMatches(date) : [];
      const liveForDate = date && validDate(date) ? live.filter(match => match.businessDate === date || match.matchDate === date) : live;
      const byId = new Map();
      // API 当前返回的比赛优先，数据库中已有但 API 已下架的比赛排在后面。
      liveForDate.forEach(match => {
        const key = String(match.matchId || '');
        if (key) byId.set(key, { ...match, isLive: true });
      });
      stored.forEach(match => {
        const key = String(match.matchId || '');
        if (key && !byId.has(key)) byId.set(key, { ...match, isLive: false });
      });
      const matches = [...byId.values()];
      return json(res, 200, { fetchedAt: new Date().toISOString(), data, matches, matchesSource: liveForDate.length ? 'live+stored' : 'stored' });
    }
    if (req.method === 'GET' && requestUrl.pathname === '/api/results') {
      const date = requestUrl.searchParams.get('date');
      if (!validDate(date)) return json(res, 400, { error: '日期格式应为 YYYY-MM-DD' });
      const data = await getResults(date);
      return json(res, 200, { fetchedAt: new Date().toISOString(), data });
    }
    if (req.method === 'GET' && requestUrl.pathname === '/api/predictions') {
      const date = requestUrl.searchParams.get('date');
      if (!validDate(date)) return json(res, 400, { error: '日期格式应为 YYYY-MM-DD' });
      return json(res, 200, { predictions: await getPredictions(date) });
    }
    if (req.method === 'POST' && requestUrl.pathname === '/api/predictions') {
      let raw = '';
      for await (const chunk of req) raw += chunk;
      await savePrediction(JSON.parse(raw));
      return json(res, 200, { ok: true });
    }
    if (req.method === 'DELETE' && requestUrl.pathname === '/api/predictions') {
      const date = requestUrl.searchParams.get('date');
      if (!validDate(date)) return json(res, 400, { error: '日期格式应为 YYYY-MM-DD' });
      await deletePredictions(date);
      return json(res, 200, { ok: true });
    }
    if (req.method === 'GET') return serveStatic(req, res, requestUrl.pathname);
    return json(res, 405, { error: '仅支持 GET' });
  } catch (error) {
    console.error(error);
    return json(res, 502, { error: error.message || '接口请求失败' });
  }
});

initDb().then(() => server.listen(PORT, () => {
  console.log('红黑记录已启动：http://localhost:' + PORT);
})).catch(error => {
  console.error('数据库初始化失败', error);
  process.exit(1);
});
