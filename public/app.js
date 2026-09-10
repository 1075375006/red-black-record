(() => {
  'use strict';
  const STORAGE_KEY = 'red-black-records-v1';
  const MATCHES_STORAGE_KEY = 'red-black-match-snapshots-v1';
  const state = { date: todayLocal(), matches: loadMatchSnapshot(todayLocal()), results: new Map(), records: loadRecords(), matchSnapshots: loadMatchSnapshots(), filter: 'all', syncing: false };
  const $ = (selector, root = document) => root.querySelector(selector);
  const $$ = (selector, root = document) => [...root.querySelectorAll(selector)];
  const dateInput = $('#dateInput'), matchesList = $('#matchesList'), emptyState = $('#emptyState'), notice = $('#notice'), refreshButton = $('#refreshButton'), syncStatus = $('#syncStatus');
  dateInput.value = state.date;
  updateDateLabel();
  bindEvents();
  render();
  syncAll();
  setInterval(() => { if (!document.hidden) syncAll({ quiet: true }); }, 5 * 60 * 1000);

  function todayLocal() {
    const now = new Date(), offset = now.getTimezoneOffset();
    return new Date(now.getTime() - offset * 60000).toISOString().slice(0, 10);
  }
  function shiftDate(dateText, amount) { const date = new Date(dateText + 'T12:00:00'); date.setDate(date.getDate() + amount); return date.toISOString().slice(0, 10); }
  function loadRecords() { try { const parsed = JSON.parse(localStorage.getItem(STORAGE_KEY) || '{}'); return parsed && typeof parsed === 'object' ? parsed : {}; } catch { return {}; } }
  function saveRecords() { localStorage.setItem(STORAGE_KEY, JSON.stringify(state.records)); }
  function loadMatchSnapshots() { try { const parsed = JSON.parse(localStorage.getItem(MATCHES_STORAGE_KEY) || '{}'); return parsed && typeof parsed === 'object' ? parsed : {}; } catch { return {}; } }
  function loadMatchSnapshot(date) { const snapshots = loadMatchSnapshots(); return Array.isArray(snapshots[date]) ? snapshots[date] : []; }
  function saveMatchSnapshot(date, matches) { if (!Array.isArray(matches) || !matches.length) return; state.matchSnapshots[date] = matches; localStorage.setItem(MATCHES_STORAGE_KEY, JSON.stringify(state.matchSnapshots)); }
  function dateRecords() { if (!state.records[state.date]) state.records[state.date] = {}; return state.records[state.date]; }
  function getRecord(matchId) { return dateRecords()[String(matchId)] || null; }
  function setRecord(matchId, record) {
    const normalized = { ...record, updatedAt: record.updatedAt || new Date().toISOString() };
    dateRecords()[String(matchId)] = normalized;
    saveRecords();
    fetch('/api/predictions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
      body: JSON.stringify({
        matchId: String(matchId),
        market: normalized.market || 'had',
        pick: normalized.pick ?? null,
        handicapLine: normalized.handicapLine ?? null,
        note: normalized.note || ''
      })
    }).then(async response => {
      if (!response.ok) {
        let payload = {};
        try { payload = await response.json(); } catch {}
        throw new Error(payload.error || '保存失败');
      }
    }).catch(error => showNotice('记录已保存在本地，但同步数据库失败：' + error.message));
  }

  function bindEvents() {
    dateInput.addEventListener('change', () => { if (!dateInput.value) return; state.date = dateInput.value; state.matches = loadMatchSnapshot(state.date); state.results = new Map(); updateDateLabel(); render(); syncAll(); });
    $('#prevDay').addEventListener('click', () => changeDate(-1));
    $('#nextDay').addEventListener('click', () => changeDate(1));
    refreshButton.addEventListener('click', () => syncAll());
    $('#clearDay').addEventListener('click', clearDay);
    $$('.filter-tab').forEach(button => button.addEventListener('click', () => { state.filter = button.dataset.filter; $$('.filter-tab').forEach(tab => tab.classList.toggle('active', tab === button)); render(); }));
  }
  function changeDate(amount) { state.date = shiftDate(state.date, amount); dateInput.value = state.date; state.matches = loadMatchSnapshot(state.date); state.results = new Map(); updateDateLabel(); render(); syncAll(); }
  function updateDateLabel() { const date = new Date(state.date + 'T12:00:00'), weekday = ['日', '一', '二', '三', '四', '五', '六'][date.getDay()]; $('#dateText').textContent = state.date.replaceAll('-', '.') + ' · 周' + weekday; }

  async function syncAll() {
    if (state.syncing) return;
    state.syncing = true; refreshButton.disabled = true; syncStatus.textContent = '同步中…'; syncStatus.className = 'status-pill busy'; hideNotice();
    try {
      const [matchesResponse, resultsResponse] = await Promise.all([
        fetchJson('/api/matches?date=' + encodeURIComponent(state.date)),
        fetchJson('/api/results?date=' + encodeURIComponent(state.date))
      ]);
      // 赛果接口会先在服务端落库并完成结算，再读取数据库中的预测状态。
      const predictionsResponse = await fetchJson('/api/predictions?date=' + encodeURIComponent(state.date));
      const liveMatches = normalizeMatches(matchesResponse);
      const normalizedResults = normalizeResults(resultsResponse);
      const storedPredictions = normalizePredictions(predictionsResponse.predictions);
      if (storedPredictions.length) {
        state.records[state.date] = { ...(state.records[state.date] || {}) };
        storedPredictions.forEach(record => { state.records[state.date][String(record.matchId)] = record; });
        saveRecords();
      }
      if (liveMatches.length) {
        // 服务端已按“API 当前比赛在前、数据库历史比赛在后”合并排序。
        state.matches = liveMatches;
        saveMatchSnapshot(state.date, state.matches);
      } else if (!state.matches.length) {
        state.matches = loadMatchSnapshot(state.date);
        if (!state.matches.length) {
          state.matches = normalizeResultMatches(resultsResponse.data);
          saveMatchSnapshot(state.date, state.matches);
        }
      }
      state.results = normalizedResults;
      syncStatus.textContent = '已同步'; syncStatus.className = 'status-pill'; $('#lastSync').textContent = '更新于 ' + formatClock(new Date()); render();
    } catch (error) {
      syncStatus.textContent = '同步失败'; syncStatus.className = 'status-pill error'; showNotice('数据同步失败：' + error.message + '。请检查本地服务是否已启动，或稍后重试。'); render();
    } finally { state.syncing = false; refreshButton.disabled = false; }
  }
  async function fetchJson(url) {
    const response = await fetch(url, { headers: { Accept: 'application/json' } });
    let payload = {}; try { payload = await response.json(); } catch {}
    if (!response.ok) throw new Error(payload.error || '请求失败（' + response.status + '）');
    if (payload.data?.success === false || (payload.data?.errorCode && payload.data.errorCode !== '0')) throw new Error(payload.data.errorMessage || '上游接口未返回成功');
    return payload;
  }
  function normalizeMatches(payload) {
    const stored = Array.isArray(payload?.matches) ? payload.matches : [];
    if (stored.length) {
      const chosenStored = stored.filter(match => match.businessDate === state.date || match.matchDate === state.date);
      if (chosenStored.length) return dedupe(chosenStored, match => match.matchId);
    }
    const upstreamPayload = payload?.data || payload;
    const groups = upstreamPayload?.value?.matchInfoList || [];
    const all = groups.flatMap(group => (group.subMatchList || []).map(match => ({ ...match, businessDate: match.businessDate || group.businessDate })));
    const chosen = all.filter(match => match.businessDate === state.date), fallback = all.filter(match => match.matchDate === state.date), source = chosen.length ? chosen : fallback;
    return dedupe(source, match => match.matchId).sort((a, b) => (a.matchDate + ' ' + a.matchTime).localeCompare(b.matchDate + ' ' + b.matchTime));
  }
  function normalizePredictions(list) {
    return (Array.isArray(list) ? list : []).map(item => ({
      market: item.market,
      pick: item.pick ?? null,
      handicapLine: item.handicapLine === null || item.handicapLine === undefined ? null : Number(item.handicapLine),
      note: item.note || '',
      resultOutcome: item.resultOutcome || null,
      settlementStatus: item.settlementStatus || 'pending',
      settledAt: item.settledAt || null,
      updatedAt: item.updatedAt || '' ,
      matchId: item.matchId
    }));
  }
  function normalizeResults(payload) { const list = Array.isArray(payload?.results) ? payload.results : (payload?.data?.value?.matchResult || payload?.value?.matchResult || []); return new Map(list.map(item => [String(item.matchId), item])); }
  function mergeMatchSnapshots(previous, current) {
    const merged = new Map();
    [...(previous || []), ...(current || [])].forEach(match => {
      const key = String(match.matchId);
      merged.set(key, { ...(merged.get(key) || {}), ...match });
    });
    return [...merged.values()].sort((a, b) => ((a.matchDate || '') + ' ' + (a.matchTime || '')).localeCompare((b.matchDate || '') + ' ' + (b.matchTime || '')));
  }
  function normalizeResultMatches(payload) {
    return (payload?.value?.matchResult || [])
      .filter(item => item.matchDate === state.date)
      .map(item => ({
        matchId: item.matchId,
        matchNum: item.matchNum,
        matchNumStr: item.matchNumStr,
        matchDate: item.matchDate,
        matchTime: '',
        businessDate: item.matchDate,
        leagueAbbName: item.leagueNameAbbr || item.leagueName,
        leagueAllName: item.leagueName,
        homeTeamAllName: item.allHomeTeam || item.homeTeam,
        awayTeamAllName: item.allAwayTeam || item.awayTeam,
        homeTeamAbbName: item.homeTeam,
        awayTeamAbbName: item.awayTeam,
        had: {},
        hhad: item.goalLine !== '' && item.goalLine !== null && item.goalLine !== undefined ? { goalLine: item.goalLine, goalLineValue: item.goalLine } : {}
      }));
  }
  function dedupe(list, keyer) { const map = new Map(); list.forEach(item => map.set(String(keyer(item)), item)); return [...map.values()]; }

  function render() {
    const visible = state.matches.filter(matchesFilter), stats = calculateStats();
    $('#totalCount').textContent = state.matches.length; $('#pickedCount').textContent = stats.picked; $('#redCount').textContent = stats.red; $('#blackCount').textContent = stats.black; $('#hitRate').textContent = stats.settled ? Math.round(stats.red / stats.settled * 100) + '%' : '—';
    $('#allBadge').textContent = state.matches.length; $('#unpickedBadge').textContent = stats.unpicked; $('#pendingBadge').textContent = stats.pending; $('#redBadge').textContent = stats.red; $('#blackBadge').textContent = stats.black;
    matchesList.replaceChildren(); emptyState.hidden = visible.length > 0; visible.forEach(match => matchesList.appendChild(renderMatch(match)));
  }
  function calculateStats() {
    let picked = 0, unpicked = 0, pending = 0, red = 0, black = 0, settled = 0;
    state.matches.forEach(match => { const record = getRecord(match.matchId), rawResult = state.results.get(String(match.matchId)), result = settle(match, record), locked = isMatchLocked(match, rawResult); if (!record?.pick) { if (!locked) unpicked++; } else picked++; if (result.status === 'pending' && record?.pick) pending++; if (result.status === 'red') red++; if (result.status === 'black') black++; if (result.status === 'red' || result.status === 'black') settled++; });
    return { picked, unpicked, pending, red, black, settled };
  }
  function matchesFilter(match) { const record = getRecord(match.matchId), rawResult = state.results.get(String(match.matchId)), result = settle(match, record); if (state.filter === 'unpicked') return !record?.pick && !isMatchLocked(match, rawResult); if (state.filter === 'pending') return Boolean(record?.pick) && result.status === 'pending'; if (state.filter === 'red' || state.filter === 'black') return result.status === state.filter; return true; }

  function renderMatch(match) {
    const fragment = $('#matchTemplate').content.cloneNode(true), card = $('.match-card', fragment), record = getRecord(match.matchId), result = state.results.get(String(match.matchId)), had = match.had || {}, hhad = match.hhad || {}, hasHad = hasOdds(had), hasHhad = hasOdds(hhad);
    let market = record?.market || (hasHad ? 'had' : 'hhad'); if (market === 'had' && !hasHad && hasHhad) market = 'hhad';
    const settlement = settle(match, record), locked = isMatchLocked(match, result);
    if (locked) card.classList.add('locked');
    $('.match-number', card).textContent = match.matchNumStr || ('场次 ' + (match.matchNum || '')); $('.league-name', card).textContent = match.leagueAbbName || match.leagueAllName || '足球赛事'; $('.match-time', card).textContent = (match.matchDate || state.date) + ' ' + String(match.matchTime || '').slice(0, 5);
    $('.home-name', card).textContent = match.homeTeamAllName || match.homeTeamAbbName || '主队'; $('.away-name', card).textContent = match.awayTeamAllName || match.awayTeamAbbName || '客队'; $('.team-home .team-rank', card).textContent = match.homeRank || ''; $('.team-away .team-rank', card).textContent = match.awayRank || ''; $('.score-label', card).textContent = resultScore(result) || '—';
    const status = $('.match-status', card); if (result && isFinishedResult(result)) { status.textContent = '已完赛'; status.classList.add('finished'); } else if (match.matchStatus === 'Selling') status.textContent = '可预测'; else { status.textContent = match.matchStatus || '未开始'; status.classList.add('live'); }
    const odds = market === 'hhad' ? hhad : had; $('.odds-caption', card).textContent = market === 'hhad' ? '让球赔率' : '胜平负赔率'; $('.odd-h', card).textContent = odds.h || '—'; $('.odd-d', card).textContent = odds.d || '—'; $('.odd-a', card).textContent = odds.a || '—';
    const lineChip = $('.line-chip', card); if (market === 'hhad' && odds.goalLineValue !== undefined && odds.goalLineValue !== '') { lineChip.textContent = '主 ' + formatLine(odds.goalLineValue); lineChip.style.display = 'inline-block'; }
    $$('.market-switch button', card).forEach(button => { const enabled = button.dataset.market === 'had' ? hasHad : hasHhad; button.disabled = locked || !enabled; button.classList.toggle('active', button.dataset.market === market); button.addEventListener('click', () => { if (locked || !enabled) return; setRecord(match.matchId, { ...(getRecord(match.matchId) || {}), market: button.dataset.market, pick: null, handicapLine: null }); render(); }); });
    const labels = market === 'hhad' ? ['让胜', '让平', '让负'] : ['胜', '平', '负'];
    $$('.pick-buttons button', card).forEach((button, index) => { button.querySelector('.pick-main').textContent = labels[index]; button.disabled = locked; button.classList.toggle('active', record?.market === market && record?.pick === button.dataset.pick); button.addEventListener('click', () => { if (locked) return; const currentOdds = market === 'hhad' ? hhad : had; setRecord(match.matchId, { ...(getRecord(match.matchId) || {}), market, pick: button.dataset.pick, handicapLine: market === 'hhad' ? numberOrNull(currentOdds.goalLineValue ?? currentOdds.goalLine) : null, note: $('.note-input', card).value.trim(), updatedAt: new Date().toISOString() }); render(); }); });
    const noteInput = $('.note-input', card); noteInput.value = record?.note || ''; noteInput.readOnly = locked; $('.saved-label', card).textContent = record?.updatedAt ? '已保存 ' + formatSavedTime(record.updatedAt) : '';
    const saveButton = $('.save-button', card); saveButton.disabled = locked; saveButton.addEventListener('click', () => { if (locked) return; const current = getRecord(match.matchId) || { market, pick: null, handicapLine: null }; setRecord(match.matchId, { ...current, market, note: noteInput.value.trim(), updatedAt: new Date().toISOString() }); render(); });
    const settlementRow = $('.settlement-row', card), settlementText = $('.settlement-text', card), settlementDetail = $('.settlement-detail', card);
    if (locked && !record?.pick) { settlementText.textContent = '已锁定 · 比赛已过期'; settlementDetail.textContent = '已过期比赛不可修改预测'; } else if (!record?.pick) { settlementText.textContent = '还没有留下预测'; settlementDetail.textContent = '选择一个方向开始记录'; } else if (settlement.status === 'red') { settlementRow.classList.add('red'); settlementText.textContent = '红 · 预测命中'; settlementDetail.textContent = settlement.detail; } else if (settlement.status === 'black') { settlementRow.classList.add('black'); settlementText.textContent = '黑 · 预测未中'; settlementDetail.textContent = settlement.detail; } else { settlementRow.classList.add('pending'); settlementText.textContent = '等待赛果'; settlementDetail.textContent = result && !isFinishedResult(result) ? '官方结果尚未结算' : '赛后自动判断红黑'; }
    return fragment;
  }

  function isMatchLocked(match, result) { return match.isLive === false || Boolean(result && isFinishedResult(result)); }

  function hasOdds(odds) { return Boolean(odds && (odds.h || odds.d || odds.a)); }
  function numberOrNull(value) { if (value === null || value === undefined || value === '') return null; const n = Number(value); return Number.isFinite(n) ? n : null; }
  function formatLine(value) { const n = numberOrNull(value); if (n === null) return String(value || ''); return (n > 0 ? '+' : '') + (Number.isInteger(n) ? n : n.toFixed(2)); }
  function validScore(score) { return /^(\d+)\s*:\s*(\d+)$/.test(String(score || '')); }
  function scoreParts(result) { if (!result || !validScore(result.sectionsNo999)) return null; const [, home, away] = String(result.sectionsNo999).match(/^(\d+)\s*:\s*(\d+)$/); return { home: Number(home), away: Number(away) }; }
  function isFinishedResult(result) { const score = scoreParts(result); return Boolean(score && (result.poolStatus === 'Payout' || String(result.matchResultStatus) === '2' || result.winFlag)); }
  function resultOutcome(result, market, handicapLine) { const score = scoreParts(result); if (!score) return null; if (market === 'hhad') { const line = numberOrNull(handicapLine ?? result.goalLine); if (line === null) return null; const adjusted = score.home + line; return adjusted > score.away ? 'H' : adjusted === score.away ? 'D' : 'A'; } return score.home > score.away ? 'H' : score.home === score.away ? 'D' : 'A'; }
  function settle(match, record) { const result = state.results.get(String(match.matchId)); if (!record?.pick) return { status: 'pending', detail: '' }; const labels = record.market === 'hhad' ? { H: '让胜', D: '让平', A: '让负' } : { H: '胜', D: '平', A: '负' }; const line = record.market === 'hhad' && record.handicapLine !== null && record.handicapLine !== undefined ? ' · 主' + formatLine(record.handicapLine) : ''; if ((record.settlementStatus === 'red' || record.settlementStatus === 'black') && record.resultOutcome) return { status: record.settlementStatus, detail: '赛果 ' + labels[record.resultOutcome] + line }; if (!result || !isFinishedResult(result)) return { status: 'pending', detail: '' }; const outcome = resultOutcome(result, record.market || 'had', record.handicapLine); if (!outcome) return { status: 'pending', detail: '' }; return { status: outcome === record.pick ? 'red' : 'black', detail: '赛果 ' + labels[outcome] + line }; }
  function resultScore(result) { return scoreParts(result) ? result.sectionsNo999.replace(/\s/g, '') : ''; }
  function formatClock(date) { return date.toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' }); }
  function formatSavedTime(value) { const date = new Date(value); return Number.isNaN(date.getTime()) ? '' : date.toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' }); }
  function showNotice(message) { notice.textContent = message; notice.hidden = false; }
  function hideNotice() { notice.hidden = true; notice.textContent = ''; }
  async function clearDay() {
    const records = dateRecords();
    if (!Object.keys(records).length) return;
    if (!window.confirm('确定清空 ' + state.date + ' 的全部预测记录吗？')) return;
    delete state.records[state.date];
    saveRecords();
    render();
    try {
      const response = await fetch('/api/predictions?date=' + encodeURIComponent(state.date), { method: 'DELETE', headers: { Accept: 'application/json' } });
      if (!response.ok) throw new Error('数据库删除失败');
    } catch (error) {
      showNotice('本地记录已清空，但数据库同步失败：' + error.message);
    }
  }
})();
