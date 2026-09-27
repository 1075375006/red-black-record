const $ = (selector) => document.querySelector(selector);
let state = null; let editingId = null;
const request = async (path, options = {}) => {
  const response = await fetch('/proxy-admin' + path, { ...options, headers: { 'Content-Type': 'application/json', ...(options.headers || {}) } });
  const data = await response.json();
  if (!response.ok) { if (response.status === 401) location.href = '/login.html?next=' + encodeURIComponent('/proxy-admin/'); throw new Error(data.error || `请求失败 ${response.status}`); }
  return data;
};
function escapeHtml(value) { return String(value ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]); }
function runtime(proxy) { return state.runtime.find(item => item.id === proxy.id) || {}; }
function render() {
  $('#enabled').checked = state.enabled; $('#fallback').checked = state.fallbackToDirect;
  $('#summary').textContent = `${state.enabled ? '代理已开启' : '代理已关闭，当前直连'}；已配置 ${state.proxies.length} 条代理`;
  $('#encryption-warning').classList.toggle('hidden', state.encryptionReady);
  for (const key of ['timeoutMs','totalTimeoutMs','failureThreshold','cooldownMs','healthCheckIntervalMs']) $('#' + key).value = state[key];
  $('#allowedHosts').value = state.allowedHosts.join('\n');
  $('#proxies').innerHTML = state.proxies.map((p, i) => { const r = runtime(p); const text = { ok: '正常', failed: '失败', cooldown: '冷却中', unknown: '未检测' }[r.status] || '未检测'; return `<tr><td><button data-move="${i}" data-dir="-1" ${i===0?'disabled':''}>↑</button> <button data-move="${i}" data-dir="1" ${i===state.proxies.length-1?'disabled':''}>↓</button></td><td>${escapeHtml(p.name)}</td><td>${escapeHtml(p.protocol)}</td><td>${escapeHtml(p.host)}:${p.port}</td><td>${p.hasPassword?'已设置':'无'}</td><td class="status ${r.status||'unknown'}">${text}</td><td>${r.latencyMs == null ? '—' : `${r.latencyMs} ms`}</td><td><input type="checkbox" data-toggle="${escapeHtml(p.id)}" ${p.enabled?'checked':''}></td><td><div class="icon-actions"><button data-test="${escapeHtml(p.id)}">测试</button><button data-edit="${escapeHtml(p.id)}">编辑</button><button data-delete="${escapeHtml(p.id)}">删除</button></div></td></tr>`; }).join('') || '<tr><td colspan="9">尚未添加代理。可先粘贴代理地址添加。</td></tr>';
}
async function load() {
  state = await request('/admin/api/state'); render();
  const [logs, audit] = await Promise.all([request('/admin/api/logs?limit=100'), request('/admin/api/audit?limit=100')]);
  $('#logs').innerHTML = logs.logs.map(x => `<div class="log">${escapeHtml(x.at)} · ${escapeHtml(x.path)} · ${escapeHtml(x.route)} · ${x.statusCode||'失败'} · ${x.latencyMs||0}ms ${escapeHtml(x.error||'')}</div>`).join('') || '暂无请求记录';
  $('#audit').innerHTML = audit.audit.map(x => `<div class="log">${escapeHtml(x.at)} · ${escapeHtml(x.actor)} · ${escapeHtml(x.action)} · ${escapeHtml(x.summary)}</div>`).join('') || '暂无变更记录';
}
function formData() { const f = new FormData($('#proxy-form')); return { name:f.get('name'), protocol:f.get('protocol'), host:f.get('host'), port:Number(f.get('port')), username:f.get('username'), password:f.get('password'), remark:f.get('remark'), enabled:f.get('enabled')==='on' }; }
function openEditor(proxy = null) {
  editingId = proxy?.id || null; const form = $('#proxy-form'); form.reset(); $('#form-title').textContent = proxy ? '修改代理' : '添加代理';
  $('#password-hint').textContent = proxy?.hasPassword ? '密码已设置；留空表示不修改。' : '';
  for (const key of ['name','protocol','host','port','username','remark']) if (proxy) form.elements[key].value = proxy[key] ?? '';
  if (proxy) form.elements.enabled.checked = proxy.enabled;
  $('#test-output').textContent = ''; $('#editor').showModal();
}
$('#reload').onclick = () => load().catch(showError); $('#add').onclick = () => openEditor(); $('#cancel').onclick = () => $('#editor').close();
$('#parse-url').onclick = async () => { try { const parsed = await request('/admin/api/proxies/parse', { method:'POST', body:JSON.stringify({url:$('#proxy-url').value}) }); for (const key of ['protocol','host','port','username']) $('#proxy-form').elements[key].value = parsed[key]; $('#proxy-form').elements.password.value = parsed.password; } catch(e) { showError(e); } };
$('#test-form').onclick = async () => { try { const result = await request('/admin/api/proxies/test', {method:'POST',body:JSON.stringify({...formData(),revision:state.revision})}); $('#test-output').textContent = `${result.ok?'连接成功':'连接失败'}，${result.latencyMs}ms\n${result.error||''}\n${JSON.stringify(result.steps,null,2)}`; } catch(e) { showError(e); } };
$('#save-proxy').onclick = async () => { try { const data = {...formData(),revision:state.revision}; const result = await request(editingId ? `/admin/api/proxies/${encodeURIComponent(editingId)}` : '/admin/api/proxies',{method:editingId?'PUT':'POST',body:JSON.stringify(data)}); state=result; $('#editor').close(); render(); } catch(e) { showError(e); } };
$('#save-settings').onclick = async () => { try { state = await request('/admin/api/settings',{method:'PUT',body:JSON.stringify({revision:state.revision,enabled:$('#enabled').checked,fallbackToDirect:$('#fallback').checked,...Object.fromEntries(['timeoutMs','totalTimeoutMs','failureThreshold','cooldownMs','healthCheckIntervalMs'].map(k=>[k,Number($('#'+k).value)])),allowedHosts:$('#allowedHosts').value.split(/\r?\n/).map(x=>x.trim()).filter(Boolean)})}); render(); } catch(e) { showError(e); } };
$('#proxies').onclick = async event => { const b=event.target.closest('button'); if(!b)return; try { if(b.dataset.test) { const r=await request(`/admin/api/proxies/${b.dataset.test}/test`,{method:'POST',body:'{}'}); alert(`${r.ok?'连接成功':'连接失败'}（${r.latencyMs}ms）${r.error?'\n'+r.error:''}`); await load(); } else if(b.dataset.edit) openEditor(state.proxies.find(p=>p.id===b.dataset.edit)); else if(b.dataset.delete && confirm('确定删除此代理？')) { state=await request(`/admin/api/proxies/${b.dataset.delete}`,{method:'DELETE',body:JSON.stringify({revision:state.revision})}); render(); } else if(b.dataset.move!==undefined) { const order=state.proxies.map(p=>p.id); const i=Number(b.dataset.move), j=i+Number(b.dataset.dir); [order[i],order[j]]=[order[j],order[i]]; state=await request('/admin/api/proxies/order',{method:'PUT',body:JSON.stringify({revision:state.revision,order})}); render(); } } catch(e) { showError(e); } };
$('#proxies').onchange = async event => { const id=event.target.dataset.toggle; if(!id)return; try { state=await request(`/admin/api/proxies/${id}/toggle`,{method:'POST',body:JSON.stringify({revision:state.revision})}); render(); } catch(e) { showError(e); } };
function showError(error) { alert(error.message || String(error)); }
load().catch(showError); setInterval(() => load().catch(()=>{}), 30000);
