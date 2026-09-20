const state = {
  config: null,
  db: {},
  activeTab: ''
};

const $ = (selector, root = document) => root.querySelector(selector);
const $$ = (selector, root = document) => [...root.querySelectorAll(selector)];

function escapeHtml(value = '') {
  return String(value)
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#039;');
}

function fmtDate(value) {
  if (!value) return '-';
  return new Date(value).toLocaleString('zh-CN', { hour12: false });
}

function toast(message) {
  const el = $('#toast');
  el.textContent = message;
  el.classList.add('show');
  clearTimeout(toast.timer);
  toast.timer = setTimeout(() => el.classList.remove('show'), 2600);
}

async function api(path, options = {}) {
  const res = await fetch(path, {
    headers: { 'Content-Type': 'application/json' },
    ...options
  });
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new Error(body.error || '请求失败');
  }
  if (res.status === 204) return null;
  return res.json();
}

function valueByPath(source, pathName) {
  return pathName.split('.').reduce((value, key) => value?.[key], source);
}

function collectionLabel(collection) {
  return state.config.collections[collection]?.label || collection;
}

function relationLabel(relation, id) {
  const item = state.db[relation.collection]?.find((entry) => entry.id === id);
  if (!item) return '未关联';
  return relation.labelFields.map((field) => item[field]).filter(Boolean).join(' / ');
}

function optionList(items, labelFields) {
  return items.map((item) => {
    const label = labelFields.map((field) => item[field]).filter(Boolean).join(' / ');
    return `<option value="${item.id}">${escapeHtml(label)}</option>`;
  }).join('');
}

function formField(field) {
  const required = field.required ? 'required' : '';
  const value = field.default ? `value="${escapeHtml(field.default)}"` : '';
  const extra = field.placeholder ? `placeholder="${escapeHtml(field.placeholder)}"` : '';
  if (field.type === 'textarea') {
    return `<label class="${field.wide ? 'wide' : ''}">${field.label}<textarea name="${field.name}" ${required} ${extra}></textarea></label>`;
  }
  if (field.type === 'select') {
    return `<label class="${field.wide ? 'wide' : ''}">${field.label}<select name="${field.name}" ${required}>${field.options.map((option) => `<option value="${escapeHtml(option)}">${escapeHtml(option)}</option>`).join('')}</select></label>`;
  }
  if (field.type === 'relation') {
    const items = state.db[field.collection] || [];
    return `<label class="${field.wide ? 'wide' : ''}">${field.label}<select name="${field.name}" ${required}>${optionList(items, field.labelFields)}</select></label>`;
  }
  return `<label class="${field.wide ? 'wide' : ''}">${field.label}<input type="${field.type || 'text'}" name="${field.name}" ${value} ${required} ${extra}></label>`;
}

function pill(value, tone = '') {
  return `<span class="pill ${tone}">${escapeHtml(value || '-')}</span>`;
}

function toneFor(value) {
  return state.config.tones?.[value] || '';
}

function historyHtml(item) {
  const history = item.history || [];
  if (!history.length) return '';
  return `<div class="history">${history.slice(0, 6).map((entry) => `
    <div class="history-item"><span>${fmtDate(entry.at)}</span><span>${escapeHtml(entry.action)}${entry.note ? '：' + escapeHtml(entry.note) : ''}</span></div>
  `).join('')}</div>`;
}

function values(form) {
  const payload = Object.fromEntries(new FormData(form).entries());
  // 字段元素上声明 data-type 的做类型转换（如装备是否异常 → 布尔）
  for (const raw of form.elements) {
    if (!raw.name || raw.type === 'checkbox') continue;
    if (raw.dataset.type === 'boolean') payload[raw.name] = payload[raw.name] === 'true';
  }
  return payload;
}

function createValues(form, view) {
  const payload = values(form);
  for (const field of view.fields || []) {
    if (field.type === 'number') payload[field.name] = Number(payload[field.name] || 0);
  }
  return { ...(view.defaults || {}), ...payload };
}

function renderTabs() {
  $('#tabs').innerHTML = state.config.views.map((view, index) => `
    <button class="tab${index === 0 ? ' active' : ''}" data-tab="${view.id}">${escapeHtml(view.label)}</button>
  `).join('');
  state.activeTab = state.config.views[0].id;
}

function setTab(tabId) {
  state.activeTab = tabId;
  $$('.tab').forEach((tab) => tab.classList.toggle('active', tab.dataset.tab === tabId));
  $$('.view').forEach((view) => view.classList.toggle('active', view.id === tabId));
}

function statValue(stat) {
  const items = state.db[stat.collection] || [];
  if (!stat.filter) return items.length;
  const wanted = [].concat(stat.filter.value);
  return items.filter((item) => wanted.includes(item[stat.filter.field])).length;
}

function renderStats() {
  return `<div class="stats">${state.config.stats.map((stat) => `
    <div class="stat"><span>${escapeHtml(stat.label)}</span><strong>${statValue(stat)}</strong></div>
  `).join('')}</div>`;
}

function renderCard(item, collection, view) {
  const title = view.titleFields.map((field) => item[field]).filter(Boolean).join(' / ') || item.id;
  const statusValue = item[view.statusField];
  const relation = view.relation ? `<div class="meta">${escapeHtml(relationLabel(view.relation, item[view.relation.localKey]))}</div>` : '';
  const details = (view.detailFields || []).map((field) => {
    const raw = item[field.name];
    const value = field.type === 'relation' ? relationLabel(field, raw) : raw;
    return `<div>${escapeHtml(field.label)}<br><strong>${escapeHtml(value || '-')}</strong></div>`;
  }).join('');
  const summary = (view.summaryFields || []).map((field) => item[field]).filter(Boolean).join(' · ');
  const actions = state.config.actions
    .filter((action) => action.collection === collection)
    .map((action) => `<button class="${action.danger ? 'danger' : 'ghost'}" data-action="${action.id}" data-id="${item.id}">${escapeHtml(action.label)}</button>`)
    .join('');
  return `<article class="card">
    <div class="card-head"><h3>${escapeHtml(title)}</h3>${statusValue ? pill(statusValue, toneFor(statusValue)) : ''}</div>
    ${relation}
    ${summary ? `<p>${escapeHtml(summary)}</p>` : ''}
    ${details ? `<div class="detail">${details}</div>` : ''}
    ${actions ? `<div class="actions">${actions}</div>` : ''}
    ${historyHtml(item)}
  </article>`;
}

function renderList(view) {
  const collection = view.collection;
  const query = $(`#search-${view.id}`)?.value.trim() || '';
  const status = $(`#status-${view.id}`)?.value || '';
  let items = [...(state.db[collection] || [])];
  if (query) {
    items = items.filter((item) => view.searchFields.some((field) => String(item[field] || '').includes(query)));
  }
  if (status) {
    items = items.filter((item) => item[view.statusField] === status);
  }
  return items.length ? items.map((item) => renderCard(item, collection, view)).join('') : `<div class="empty">暂无${escapeHtml(collectionLabel(collection))}</div>`;
}

/* ---------------- 进洞许可闭环视图 ---------------- */

const PERMIT_ACTIVE = ['已许可', '进洞中', '待确认延期', '逾期'];
const PERMIT_STATUS_RANK = {
  '逾期': 0,
  '待确认延期': 1,
  '进洞中': 2,
  '已许可': 3,
  '已出洞': 4
};

function permitOptions(source) {
  const db = state.db;
  if (source === 'zones') return uniqueValues(db.sites, 'zone');
  if (source === 'routes') return uniqueValues(db.sites, 'route');
  if (source === 'leaders') return uniqueValues(db.surveys, 'surveyor');
  return [];
}

function uniqueValues(items, field) {
  return [...new Set((items || []).map((item) => item[field]).filter(Boolean))];
}

function datalistId(name) {
  return `datalist-${name}`;
}

function permitFormField(field) {
  const required = field.required ? 'required' : '';
  const placeholder = field.placeholder ? `placeholder="${escapeHtml(field.placeholder)}"` : '';
  const wide = field.wide ? 'wide' : '';
  if (field.type === 'textarea') {
    return `<label class="${wide}">${field.label}<textarea name="${field.name}" ${required} ${placeholder}></textarea></label>`;
  }
  if (field.type === 'select') {
    return `<label class="${wide}">${field.label}<select name="${field.name}" data-type="boolean" ${required}>${field.options
      .map((option) => `<option value="${option.value}">${escapeHtml(option.label)}</option>`)
      .join('')}</select></label>`;
  }
  if (field.type === 'datalist') {
    const id = datalistId(field.name);
    return `<label class="${wide}">${field.label}<input name="${field.name}" list="${id}" ${required} ${placeholder} autocomplete="off">
      <datalist id="${id}">${permitOptions(field.source).map((value) => `<option value="${escapeHtml(value)}">`).join('')}</datalist>
    </label>`;
  }
  return `<label class="${wide}">${field.label}<input type="${field.type || 'text'}" name="${field.name}" ${required} ${placeholder}></label>`;
}

function isPermitActive(permit) {
  return PERMIT_ACTIVE.includes(permit.status);
}

function renderOccupancy() {
  const active = (state.db.permits || []).filter(isPermitActive);
  if (!active.length) return `<div class="empty">当前无在洞班组，分区时段全部空闲</div>`;
  return `<div class="occupancy">${active
    .slice()
    .sort(sortPermits)
    .map((permit) => `
      <div class="occ-item ${permit.status === '逾期' ? 'overdue' : ''}">
        <strong>${escapeHtml(permit.zone)}</strong>
        <span>${escapeHtml(permit.team)} · 领队 ${escapeHtml(permit.leader)}</span>
        <span>${fmtDate(permit.planEnterAt)} → ${fmtDate(permit.expectedExitAt)}</span>
        ${pill(permit.status, toneFor(permit.status))}
      </div>`)
    .join('')}</div>`;
}

function sortPermits(a, b) {
  const rankDiff = (PERMIT_STATUS_RANK[a.status] ?? 9) - (PERMIT_STATUS_RANK[b.status] ?? 9);
  if (rankDiff !== 0) return rankDiff;
  // 逾期/在洞均按预计出洞时间升序，越快到期越靠前；履历按更新时间倒序
  const left = a.status === '已出洞' ? a.updatedAt : a.expectedExitAt;
  const right = b.status === '已出洞' ? b.updatedAt : b.expectedExitAt;
  if (a.status === '已出洞') return new Date(right) - new Date(left);
  return new Date(left) - new Date(right);
}

function permitActions(permit) {
  const id = permit.id;
  const buttons = [];
  if (permit.status === '已许可') {
    buttons.push(`<button data-enter="${id}">进洞确认</button>`);
  }
  if (permit.status === '进洞中' || permit.status === '逾期') {
    buttons.push(`<button class="ghost" data-extend="${id}">申请延期</button>`);
  }
  if (permit.status === '待确认延期') {
    buttons.push(`<button data-extend-confirm="${id}" data-exit="${escapeHtml(permit.pendingExitAt || '')}">重确认延期</button>`);
  }
  if (permit.status !== '已出洞') {
    buttons.push(`<button class="ghost" data-exit-panel="${id}">出洞核对</button>`);
  }
  return buttons.join('');
}

function renderPermitCard(permit) {
  const members = permit.memberNames || [];
  const exitPanel = permit.status !== '已出洞' ? `
    <form class="exit-panel" data-exit-form="${permit.id}" hidden>
      <h4>出洞核对（缺员或装备异常只生成搜索待办，不释放额度）</h4>
      <div class="form-grid">
        <label class="wide">实际出洞人员（每行一人）<textarea name="actualMembers" required>${escapeHtml(members.join('\n'))}</textarea></label>
        <label class="wide">实际路线<input name="actualRoute" list="datalist-routes-${permit.id}" required value="${escapeHtml(permit.route)}" autocomplete="off"><datalist id="datalist-routes-${permit.id}">${permitOptions('routes').map((value) => `<option value="${escapeHtml(value)}">`).join('')}</datalist></label>
        <label class="wide">装备是否异常<select name="equipmentAbnormal" data-type="boolean"><option value="false">正常</option><option value="true">有异常</option></select></label>
        <label class="wide">异常装备说明<textarea name="equipmentNote"></textarea></label>
      </div>
      <div class="actions"><button>提交核对</button><button type="button" class="ghost" data-cancel>取消</button></div>
    </form>
    <form class="extend-panel" data-extend-form="${permit.id}" hidden>
      <h4>${permit.status === '待确认延期' ? '重确认延期' : '申请延期'}（延长预计出洞时间须领队重确认）</h4>
      <div class="form-grid">
        <label class="wide">新的预计出洞时间<input type="datetime-local" name="expectedExitAt" required value="${escapeHtml(permit.pendingExitAt || '')}"></label>
      </div>
      <div class="actions">
        <button name="confirm" value="${permit.status === '待确认延期' ? 'true' : 'false'}">${permit.status === '待确认延期' ? '确认延期' : '提交延期申请'}</button>
        <button type="button" class="ghost" data-cancel>取消</button>
      </div>
    </form>` : '';

  return `<article class="card ${permit.status === '逾期' ? 'card-overdue' : ''}">
    <div class="card-head">
      <h3>${escapeHtml(permit.team)}</h3>
      ${pill(permit.status, toneFor(permit.status))}
    </div>
    <div class="meta">分区 ${escapeHtml(permit.zone)} · 路线 ${escapeHtml(permit.route)} · 领队 ${escapeHtml(permit.leader)} · ${members.length} 人</div>
    <div class="detail">
      <div>计划进洞<br><strong>${fmtDate(permit.planEnterAt)}</strong></div>
      <div>预计出洞<br><strong>${fmtDate(permit.expectedExitAt)}</strong></div>
      <div>实际路线<br><strong>${escapeHtml(permit.actualRoute || '—')}</strong></div>
    </div>
    ${permit.exitNote ? `<p class="warn-note">${escapeHtml(permit.exitNote)}</p>` : ''}
    <div class="actions">${permitActions(permit)}</div>
    ${exitPanel}
    ${historyHtml(permit)}
  </article>`;
}

function sortTodos(a, b) {
  if ((a.status === '待处理') !== (b.status === '待处理')) return a.status === '待处理' ? -1 : 1;
  return new Date(b.createdAt) - new Date(a.createdAt);
}

function renderTodoCard(todo) {
  return `<article class="card todo-card ${todo.status === '待处理' ? 'todo-open' : ''}">
    <div class="card-head">
      <h3>${escapeHtml(todo.kind)}</h3>
      ${pill(todo.status, toneFor(todo.status))}
    </div>
    <div class="meta">${escapeHtml(todo.zone || '')} · ${escapeHtml(todo.team || '')} · 许可 ${escapeHtml(todo.permitId || '')}</div>
    <p>${escapeHtml(todo.detail || '')}</p>
    <div class="actions">
      ${todo.status === '待处理'
        ? `<button data-todo-done="${todo.id}">完成处置</button>`
        : '<span class="meta">已闭环</span>'}
    </div>
    ${historyHtml(todo)}
  </article>`;
}

function renderPermitsView(view) {
  const permits = (state.db.permits || []).slice().sort(sortPermits);
  const todos = (state.db.todos || []).slice().sort(sortTodos);
  return `<section class="view" id="${view.id}">
    <div class="panel occupancy-panel">
      <h2>分区时段占用</h2>
      ${renderOccupancy()}
    </div>
    <div class="grid permits-grid">
      <form class="panel" data-api-form="/api/permit/app">
        <h2>${escapeHtml(view.formTitle)}</h2>
        <div class="form-grid">${view.applyFields.map(permitFormField).join('')}</div>
        <div class="actions"><button>${escapeHtml(view.submitLabel)}</button></div>
        <p class="meta">同一分区同一时段只许一组进洞；路线含暂停开放样点或领队未完成当日登记时整单拒绝。</p>
      </form>
      <div class="panel">
        <h2>${escapeHtml(view.listTitle)}（逾期自动置顶）</h2>
        <div class="list">${permits.length ? permits.map(renderPermitCard).join('') : '<div class="empty">暂无许可</div>'}</div>
      </div>
    </div>
    <div class="panel todo-panel">
      <h2>搜索待办与异常装备待办</h2>
      <div class="list todo-grid">${todos.length ? todos.map(renderTodoCard).join('') : '<div class="empty">暂无待办</div>'}</div>
    </div>
  </section>`;
}

/* ---------------- 看板 ---------------- */

function renderDashboardView(view) {
  const source = view.focus;
  let focusHtml;
  if (source.kind === 'todos') {
    const items = (state.db[source.collection] || [])
      .filter((todo) => todo.status === '待处理')
      .sort(sortTodos)
      .slice(0, source.limit || 8);
    focusHtml = items.length ? items.map(renderTodoCard).join('') : '<div class="empty">暂无待处理事项</div>';
  } else {
    let items = [...(state.db[source.collection] || [])];
    if (source.field) items = items.filter((item) => source.values.includes(item[source.field]));
    items = items.slice(0, source.limit || 8);
    const cardView = state.config.views.find((entry) => entry.collection === source.collection) || source;
    focusHtml = items.length
      ? items.map((item) => renderCard(item, source.collection, cardView)).join('')
      : '<div class="empty">暂无重点事项</div>';
  }
  return `<section class="view active" id="${view.id}">
    ${renderStats()}
    <div class="panel"><h2>${escapeHtml(view.focusTitle)}</h2><div class="list">${focusHtml}</div></div>
  </section>`;
}

/* ---------------- 通用 CRUD 视图 ---------------- */

function renderCrudView(view) {
  const statusOptions = view.statusOptions || [];
  return `<section class="view" id="${view.id}">
    <div class="grid">
      <form class="panel" data-create="${view.collection}" data-view="${view.id}">
        <h2>${escapeHtml(view.formTitle)}</h2>
        <div class="form-grid">${view.fields.map(formField).join('')}</div>
        <div class="actions"><button>${escapeHtml(view.submitLabel || '保存')}</button></div>
      </form>
      <div class="panel">
        <h2>${escapeHtml(view.listTitle)}</h2>
        <div class="toolbar">
          <input id="search-${view.id}" placeholder="${escapeHtml(view.searchPlaceholder || '搜索')}">
          <select id="status-${view.id}">
            <option value="">全部状态</option>
            ${statusOptions.map((option) => `<option>${escapeHtml(option)}</option>`).join('')}
          </select>
        </div>
        <div class="list" id="list-${view.id}">${renderList(view)}</div>
      </div>
    </div>
  </section>`;
}

function render() {
  $('#title').textContent = state.config.title;
  document.title = state.config.title;
  $('#lede').textContent = state.config.lede;
  $('#main').innerHTML = state.config.views
    .map((view) => {
      if (view.type === 'dashboard') return renderDashboardView(view);
      if (view.type === 'permits') return renderPermitsView(view);
      return renderCrudView(view);
    })
    .join('');
  setTab(state.activeTab || state.config.views[0].id);
}

async function load() {
  state.db = await api('/api/db');
  render();
}

/* ---------------- 事件 ---------------- */

document.addEventListener('click', async (event) => {
  const tab = event.target.closest('.tab');
  const action = event.target.closest('[data-action]');
  const enter = event.target.closest('[data-enter]');
  const extend = event.target.closest('[data-extend]');
  const extendConfirm = event.target.closest('[data-extend-confirm]');
  const exitPanel = event.target.closest('[data-exit-panel]');
  const cancel = event.target.closest('[data-cancel]');
  const todoDone = event.target.closest('[data-todo-done]');

  if (tab) return setTab(tab.dataset.tab);
  if (cancel) {
    const panel = cancel.closest('form');
    panel.hidden = true;
    return;
  }

  try {
    if (action) {
      await api(`/api/action/${action.dataset.action}/${action.dataset.id}`, { method: 'POST' });
      await load();
      return toast('已更新');
    }
    if (enter) {
      await api(`/api/permit/${enter.dataset.enter}/enter`, { method: 'POST' });
      await load();
      return toast('进洞已确认');
    }
    if (extend) {
      const card = extend.closest('.card');
      card.querySelector('[data-extend-form]').hidden = false;
      return;
    }
    if (extendConfirm) {
      const id = extendConfirm.dataset.extendConfirm;
      await api(`/api/permit/${id}/extend`, {
        method: 'POST',
        body: JSON.stringify({ expectedExitAt: extendConfirm.dataset.exit, confirm: true })
      });
      await load();
      return toast('延期已重确认');
    }
    if (exitPanel) {
      const card = exitPanel.closest('.card');
      card.querySelector('[data-exit-form]').hidden = false;
      return;
    }
    if (todoDone) {
      await api(`/api/todos/${todoDone.dataset.todoDone}`, {
        method: 'PATCH',
        body: JSON.stringify({ status: '已处理', historyAction: '完成处置' })
      });
      await load();
      return toast('待办已闭环');
    }
  } catch (error) {
    toast(error.message);
  }
});

document.addEventListener('input', (event) => {
  const view = state.config.views.find((entry) => entry.id && (event.target.id === `search-${entry.id}` || event.target.id === `status-${entry.id}`));
  if (view) $(`#list-${view.id}`).innerHTML = renderList(view);
});

// 许可闭环表单（申请 / 出洞核对 / 延期）
document.addEventListener('submit', async (event) => {
  const apiForm = event.target.closest('[data-api-form]');
  const exitForm = event.target.closest('[data-exit-form]');
  const extendForm = event.target.closest('[data-extend-form]');
  const form = apiForm || exitForm || extendForm;
  if (!form) return;
  event.preventDefault();

  try {
    let path;
    let body = values(form);
    if (apiForm) {
      path = apiForm.dataset.apiForm;
      body.memberNames = String(body.memberNames || '').trim();
    } else if (exitForm) {
      path = `/api/permit/${exitForm.dataset.exitForm}/exit`;
    } else {
      path = `/api/permit/${extendForm.dataset.extendForm}/extend`;
      body.confirm = body.confirm === 'true';
    }
    const result = await api(path, { method: 'POST', body: JSON.stringify(body) });
    await load();
    if (result && result.reused) toast('该申请与首次许可一致，沿用原许可，未重复开票');
    else if (result && result.released === false) toast('出洞核对未通过：已生成搜索待办，额度未释放');
    else if (exitForm) toast('全员核对通过，已出洞释放');
    else if (extendForm) toast(body.confirm ? '延期已重确认' : '延期申请已登记，待领队重确认');
    else toast('许可已签发');
  } catch (error) {
    toast(error.message);
  }
});

// 通用建档表单
document.addEventListener('submit', async (event) => {
  const form = event.target.closest('[data-create]');
  if (!form) return;
  event.preventDefault();
  const view = state.config.views.find((entry) => entry.id === form.dataset.view);
  try {
    await api(`/api/${form.dataset.create}`, { method: 'POST', body: JSON.stringify(createValues(form, view)) });
    form.reset();
    await load();
    toast('已保存');
  } catch (error) {
    toast(error.message);
  }
});

$('#refreshBtn').addEventListener('click', () => load().then(() => toast('已刷新')));

async function boot() {
  state.config = await api('/api/config');
  renderTabs();
  await load();
}

boot().catch((error) => toast(error.message));
