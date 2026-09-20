// 进洞调度看板：只负责展示与交互，所有业务规则以 /api/board/permits 返回的派生状态为准。
// 刷新页面后占用、待办、履历全部由服务端记录重建，本地不保存业务状态。
(function () {
  'use strict';

  const board = {
    data: null,
    expanded: new Map() // permitId -> 'exit' | 'extend'，重渲染时保持展开
  };

  const $ = (selector, root = document) => root.querySelector(selector);

  function esc(value = '') {
    return String(value)
      .replaceAll('&', '&amp;')
      .replaceAll('<', '&lt;')
      .replaceAll('>', '&gt;')
      .replaceAll('"', '&quot;')
      .replaceAll("'", '&#039;');
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

  // datetime-local 用东八区墙钟时间填充（与服务端 parseLocalAsShanghai 对齐）。
  function shanghaiInputValue(offsetMin = 0) {
    const now = new Date(Date.now() + offsetMin * 60000 + 8 * 3600000);
    const pad = (n) => String(n).padStart(2, '0');
    return `${now.getUTCFullYear()}-${pad(now.getUTCMonth() + 1)}-${pad(now.getUTCDate())}T${pad(now.getUTCHours())}:${pad(now.getUTCMinutes())}`;
  }

  function fmtClock(iso) {
    if (!iso) return '-';
    const d = new Date(iso);
    const pad = (n) => String(n).padStart(2, '0');
    const shifted = new Date(d.getTime() + 8 * 3600000);
    return `${shifted.getUTCFullYear()}-${pad(shifted.getUTCMonth() + 1)}-${pad(shifted.getUTCDate())} ${pad(shifted.getUTCHours())}:${pad(shifted.getUTCMinutes())}`;
  }

  function pill(value, tone = '') {
    return `<span class="pill ${tone}">${esc(value || '-')}</span>`;
  }

  function toneFor(value) {
    return window.appConfig?.tones?.[value] || '';
  }

  function siteMap() {
    const map = new Map();
    for (const site of board.data?.sites || []) map.set(site.id, site);
    return map;
  }

  function siteLabel(site) {
    return site ? `${site.pointCode}（${site.zone}）` : '未知样点';
  }

  function historyHtml(item) {
    const history = item.history || [];
    if (!history.length) return '';
    return `<div class="history">${history.slice(0, 6).map((entry) => `
      <div class="history-item"><span>${fmtClock(entry.at)}</span><span>${esc(entry.action)}${entry.note ? '：' + esc(entry.note) : ''}</span></div>
    `).join('')}</div>`;
  }

  // ---- 静态骨架：只挂载一次，避免自动刷新冲掉正在填写的表单 ----

  function renderShell() {
    const startValue = shanghaiInputValue(5);
    const endValue = shanghaiInputValue(5 + 4 * 60);
    return `<section class="view" id="permits">
      <div id="permitAlert" class="permit-alert" hidden></div>
      <div class="permit-grid">
        <form class="panel" id="permitRequestForm">
          <h2>申请进洞许可</h2>
          <p class="hint" id="permitTodayHint"></p>
          <div class="form-grid">
            <label>班组名称<input name="teamName" required placeholder="如：甲班"></label>
            <label>领队<input name="leader" list="leaderList" required placeholder="完成当日登记后方可带队"></label>
            <datalist id="leaderList"></datalist>
            <label>洞穴<input name="cave" list="caveList" required placeholder="如：北麓三号洞"></label>
            <datalist id="caveList"></datalist>
            <label>分区<input name="zone" list="zoneList" required placeholder="如：滴水帘区"></label>
            <datalist id="zoneList"></datalist>
            <label>预计进洞<input type="datetime-local" name="plannedStart" value="${startValue}" required></label>
            <label>预计出洞<input type="datetime-local" name="plannedEnd" value="${endValue}" required></label>
            <label class="wide">进洞人员（空格或逗号分隔，须含领队）<textarea name="memberNames" required placeholder="周岭 高远 林晓"></textarea></label>
            <div class="wide">
              <span class="field-label">计划路线样点（含暂停开放样点将被拒绝）</span>
              <div class="route-box" id="routeSitePickers"></div>
            </div>
          </div>
          <div class="actions"><button>提交申请</button><span class="hint" id="permitFormHint"></span></div>
        </form>
        <div class="panel">
          <h2>当前分区占用</h2>
          <div class="list" id="occupancyList"></div>
        </div>
      </div>
      <div class="permit-grid todo-grid">
        <div class="panel">
          <h2>搜索待办</h2>
          <div class="list" id="todoList"></div>
        </div>
        <div class="panel">
          <h2>许可履历（逾期自动置顶）</h2>
          <div class="toolbar">
            <input id="permitSearch" placeholder="搜索许可号、班组、领队、分区">
            <select id="permitStatusFilter">
              <option value="">全部状态</option>
              <option value="已许可">已许可</option>
              <option value="待搜索">待搜索</option>
              <option value="已释放">已释放</option>
            </select>
          </div>
          <div class="list" id="permitList"></div>
        </div>
      </div>
    </section>`;
  }

  function renderRoutePickers() {
    const grouped = new Map();
    for (const site of board.data.sites) {
      const key = `${site.cave} / ${site.zone}`;
      if (!grouped.has(key)) grouped.set(key, []);
      grouped.get(key).push(site);
    }
    $('#routeSitePickers').innerHTML = [...grouped.entries()].map(([group, sites]) => `
      <div class="route-group">
        <div class="route-group-title">${esc(group)}</div>
        <div class="route-items">${sites.map((site) => `
          <label class="route-item ${site.protectedStatus === '暂停开放' ? 'closed' : ''}">
            <input type="checkbox" name="routeSiteIds" value="${site.id}" ${site.protectedStatus === '暂停开放' ? '' : ''}>
            <span>${esc(site.pointCode)} <em>${esc(site.route)}</em></span>
            ${site.protectedStatus === '暂停开放' ? pill('暂停开放', 'bad') : pill(site.protectedStatus, toneFor(site.protectedStatus))}
          </label>`).join('')}
        </div>
      </div>`).join('');
  }

  function renderOccupancy() {
    const groups = board.data.occupancy || [];
    $('#occupancyList').innerHTML = groups.length ? groups.map((group) => `
      <article class="card ${group.overdue ? 'card-overdue' : ''}">
        <div class="card-head">
          <h3>${esc(group.cave)} / ${esc(group.zone)}</h3>
          ${group.overdue ? pill('逾期未出', 'bad') : pill('占用中', 'warn')}
        </div>
        ${group.permits.map((permit) => `
          <div class="occupy-row">
            <div><strong>${esc(permit.teamName)}</strong> <span class="meta">${esc(permit.permitNo)} · 领队 ${esc(permit.leader)} · ${permit.memberNames.length} 人</span></div>
            <div class="meta">进 ${fmtClock(permit.plannedStart)} ｜ 出 ${fmtClock(permit.effectiveEnd)}${permit.overdue ? ` · 已逾期 ${permit.overdueMinutes} 分钟` : ''}${permit.hasPendingExtension ? ' · 延长待确认' : ''}</div>
          </div>`).join('')}
      </article>`).join('') : '<div class="empty">当前无分区占用，可提交进洞申请</div>';
  }

  function routeNames(permit, map) {
    return (permit.routeSiteIds || []).map((id) => siteLabel(map.get(id))).join('、');
  }

  function renderExitForm(permit) {
    const map = siteMap();
    const plannedChecks = permit.routeSiteIds.map((id) => {
      const site = map.get(id);
      return `<label class="checkline"><input type="checkbox" name="actualRouteSiteIds" value="${id}" checked> ${esc(siteLabel(site))}</label>`;
    }).join('');
    return `<form class="subform" data-exit="${permit.id}">
      <h4>出洞核对</h4>
      <div class="form-grid">
        <div class="wide">
          <span class="field-label">实际出洞人员（取消勾选即视为缺员）</span>
          <div class="check-grid">${permit.memberNames.map((name) => `
            <label class="checkline"><input type="checkbox" name="returnedMembers" value="${esc(name)}" checked> ${esc(name)}</label>`).join('')}
          </div>
        </div>
        <div class="wide">
          <span class="field-label">实际路线样点</span>
          <div class="check-grid">${plannedChecks}</div>
          <input name="actualRouteExtra" placeholder="计划外样点编号，多个用逗号分隔（可选）">
        </div>
        <label class="wide checkbox-row"><input type="checkbox" name="gearAbnormal"> 存在异常装备</label>
        <label class="wide">异常装备说明（勾选时必填）<input name="gearNote" placeholder="如：气体检测仪遗失一台"></label>
        <label class="wide">备注<textarea name="note"></textarea></label>
      </div>
      <div class="actions">
        <button>提交核对</button>
        <button type="button" class="ghost" data-collapse="${permit.id}">取消</button>
      </div>
    </form>`;
  }

  function renderExtendForm(permit) {
    return `<form class="subform" data-extend="${permit.id}">
      <h4>申请延长出洞时间</h4>
      <div class="form-grid">
        <label>新的预计出洞<input type="datetime-local" name="plannedEnd" value="${shanghaiInputValue(60)}" required></label>
        <label class="wide">延长原因<input name="reason" placeholder="如：D-09 滴水频率异常需补测"></label>
      </div>
      <div class="actions">
        <button>提交延长申请</button>
        <button type="button" class="ghost" data-collapse="${permit.id}">取消</button>
      </div>
      <p class="hint">延长不会立即生效，需重确认分区时段无冲突后才占用新窗口。</p>
    </form>`;
  }

  function renderPermitCard(permit) {
    const map = siteMap();
    const expanded = board.expanded.get(permit.id);
    const badges = [permit.status];
    if (permit.overdue) badges.push('逾期未出');
    const exitReport = permit.exitReport;
    return `<article class="card ${permit.overdue ? 'card-overdue' : ''}">
      <div class="card-head">
        <h3>${esc(permit.permitNo)} · ${esc(permit.teamName)}</h3>
        <span>${badges.map((b) => pill(b, toneFor(b))).join(' ')}</span>
      </div>
      <div class="meta">${esc(permit.cave)} / ${esc(permit.zone)} ｜ 领队 ${esc(permit.leader)} ｜ 进洞 ${fmtClock(permit.plannedStart)} ｜ 预计出洞 ${fmtClock(permit.effectiveEnd)}</div>
      <div class="detail">
        <div>进洞人员<br><strong>${esc((permit.memberNames || []).join('、'))}</strong></div>
        <div>计划路线<br><strong>${esc(routeNames(permit, map))}</strong></div>
        <div>开放待办<br><strong>${permit.openTodos.length} 条</strong></div>
      </div>
      ${permit.hasPendingExtension ? `<p class="warn-line">延长申请待重确认：期望 ${fmtClock(permit.pendingExtension.requestedEnd)}${permit.pendingExtension.reason ? `（${esc(permit.pendingExtension.reason)}）` : ''}</p>` : ''}
      ${exitReport ? `<div class="exit-report">
        <strong>出洞核对 @ ${fmtClock(exitReport.at)}</strong>
        <div class="meta">出洞人员：${esc((exitReport.returnedMemberNames || []).join('、') || '-')}</div>
        <div class="meta">路线偏差：漏掉 ${exitReport.skippedSiteIds.length} 个、新增 ${exitReport.addedSiteIds.length + (exitReport.actualRouteExtra || []).length} 个样点${exitReport.gearAbnormal ? ` ｜ 装备异常：${esc(exitReport.gearNote)}` : ''}</div>
      </div>` : ''}
      <div class="actions">
        ${permit.status === '已许可' && !permit.hasPendingExtension ? `<button type="button" class="ghost" data-expand="exit" data-id="${permit.id}">出洞核对</button>` : ''}
        ${permit.status === '已许可' && !permit.hasPendingExtension ? `<button type="button" class="ghost" data-expand="extend" data-id="${permit.id}">延长出洞</button>` : ''}
        ${permit.hasPendingExtension ? `<button type="button" data-action="extend-confirm" data-id="${permit.id}">重确认延长</button><button type="button" class="ghost" data-action="extend-cancel" data-id="${permit.id}">撤销延长</button>` : ''}
        ${permit.canRelease ? `<button type="button" data-action="release" data-id="${permit.id}">释放额度</button>` : ''}
        ${permit.status === '待搜索' ? `<a class="jumplink" href="#todo-${esc((permit.openTodos[0] || {}).id || '')}">查看搜索待办 ↓</a>` : ''}
      </div>
      ${expanded === 'exit' ? renderExitForm(permit) : ''}
      ${expanded === 'extend' ? renderExtendForm(permit) : ''}
      ${historyHtml(permit)}
    </article>`;
  }

  function renderPermits() {
    const query = ($('#permitSearch')?.value || '').trim();
    const status = $('#permitStatusFilter')?.value || '';
    let permits = [...(board.data.permits || [])];
    if (status) permits = permits.filter((permit) => permit.status === status);
    if (query) {
      const q = query.toLowerCase();
      permits = permits.filter((permit) =>
        [permit.permitNo, permit.teamName, permit.leader, permit.cave, permit.zone, ...(permit.memberNames || [])]
          .some((value) => String(value || '').toLowerCase().includes(q)));
    }
    $('#permitList').innerHTML = permits.length
      ? permits.map(renderPermitCard).join('')
      : '<div class="empty">暂无许可记录</div>';
  }

  function renderTodos() {
    const todos = board.data.todos || [];
    $('#todoList').innerHTML = todos.length ? todos.map((todo) => `
      <article class="card ${todo.status === '待处理' ? 'card-bad' : ''}" id="todo-${esc(todo.id)}">
        <div class="card-head">
          <h3>${esc(todo.kind)} · ${esc(todo.teamName)}</h3>
          ${pill(todo.status, toneFor(todo.status))}
        </div>
        <div class="meta">${esc(todo.cave)} / ${esc(todo.zone)} ｜ 关联许可 ${esc(todo.permitNo)}</div>
        <p>${esc(todo.description)}</p>
        ${todo.status === '待处理' ? `
          <form class="inline-form" data-resolve-todo="${todo.id}">
            <input name="resolution" placeholder="处理说明（找回位置、装备核清情况）">
            <div class="actions"><button>完成待办</button></div>
          </form>` : `<div class="meta">处理结果：${esc(todo.resolution || '已处理')} @ ${fmtClock(todo.resolvedAt)}</div>`}
        ${historyHtml(todo)}
      </article>`).join('') : '<div class="empty">暂无搜索待办</div>';
  }

  function renderHints() {
    $('#permitTodayHint').textContent = `今日（${board.data.today}）已完成巡测登记的领队可带队；拒绝的申请不会生成许可。`;
    $('#leaderList').innerHTML = (board.data.leaders || []).map((name) => `<option value="${esc(name)}">`).join('');
    const caves = [...new Set(board.data.sites.map((site) => site.cave))];
    const zones = [...new Set(board.data.sites.map((site) => site.zone))];
    $('#caveList').innerHTML = caves.map((value) => `<option value="${esc(value)}">`).join('');
    $('#zoneList').innerHTML = zones.map((value) => `<option value="${esc(value)}">`).join('');
  }

  function showAlert(message, kind = 'bad') {
    const el = $('#permitAlert');
    el.hidden = false;
    el.className = `permit-alert ${kind}`;
    el.textContent = message;
  }

  function clearAlert() {
    const el = $('#permitAlert');
    el.hidden = true;
    el.textContent = '';
  }

  function renderAll() {
    if (!board.data) return;
    renderHints();
    renderRoutePickers();
    renderOccupancy();
    renderTodos();
    renderPermits();
  }

  async function refresh() {
    board.data = await api('/api/board/permits');
    if ($('#permits')) renderAll();
    return board.data;
  }

  // 正在填写或展开核对表单时不做静默刷新，避免打断输入。
  function safeToSilenceRefresh() {
    const root = document.getElementById('permits');
    if (!root || !root.classList.contains('active')) return false;
    const active = document.activeElement;
    if (active && root.contains(active) && ['INPUT', 'TEXTAREA', 'SELECT'].includes(active.tagName)) return false;
    if (board.expanded.size) return false;
    return true;
  }

  function checkedValues(form, name) {
    return [...form.querySelectorAll(`input[name="${name}"]:checked`)].map((input) => input.value);
  }

  async function handleRequestSubmit(form, notify) {
    clearAlert();
    const payload = {
      teamName: form.teamName.value,
      leader: form.leader.value,
      cave: form.cave.value,
      zone: form.zone.value,
      plannedStart: form.plannedStart.value,
      plannedEnd: form.plannedEnd.value,
      memberNames: form.memberNames.value,
      routeSiteIds: checkedValues(form, 'routeSiteIds')
    };
    try {
      const result = await api('/api/permits/request', { method: 'POST', body: JSON.stringify(payload) });
      form.reset();
      form.plannedStart.value = shanghaiInputValue(5);
      form.plannedEnd.value = shanghaiInputValue(5 + 4 * 60);
      await refresh();
      notify(result.reused ? `申请重复，沿用首次许可 ${result.item.permitNo}` : `许可 ${result.item.permitNo} 已发放`);
    } catch (error) {
      showAlert(error.message);
    }
  }

  async function handleExitSubmit(form, permitId, notify) {
    const payload = {
      returnedMemberNames: checkedValues(form, 'returnedMembers'),
      actualRouteSiteIds: checkedValues(form, 'actualRouteSiteIds'),
      actualRouteExtra: form.actualRouteExtra.value,
      gearAbnormal: form.gearAbnormal.checked,
      gearNote: form.gearNote.value,
      note: form.note.value
    };
    try {
      const result = await api(`/api/permits/${permitId}/exit`, { method: 'POST', body: JSON.stringify(payload) });
      board.expanded.delete(permitId);
      await refresh();
      notify(result.releaseEligible ? '全员到齐、装备正常，核对通过，可释放额度' : '核对未通过，已生成搜索待办，额度暂不释放');
    } catch (error) {
      showAlert(error.message);
    }
  }

  async function handleExtendSubmit(form, permitId, notify) {
    const payload = { plannedEnd: form.plannedEnd.value, reason: form.reason.value };
    try {
      await api(`/api/permits/${permitId}/extend`, { method: 'POST', body: JSON.stringify(payload) });
      board.expanded.delete(permitId);
      await refresh();
      notify('延长申请已提交，待重确认');
    } catch (error) {
      showAlert(error.message);
    }
  }

  async function handleAction(action, id, notify) {
    clearAlert();
    if (action === 'extend-confirm') {
      try {
        await api(`/api/permits/${id}/extend-confirm`, { method: 'POST' });
        await refresh();
        notify('延长已重确认，占用窗口已更新');
      } catch (error) { showAlert(error.message); }
    } else if (action === 'extend-cancel') {
      await api(`/api/permits/${id}/extend-cancel`, { method: 'POST' });
      await refresh();
      notify('已撤销延长');
    } else if (action === 'release') {
      if (!window.confirm('确认全员已出洞并释放该分区额度？')) return;
      await api(`/api/permits/${id}/release`, { method: 'POST' });
      await refresh();
      notify('分区额度已释放，闭环完成');
    }
  }

  function bind(notify) {
    document.addEventListener('submit', async (event) => {
      const requestForm = event.target.closest('#permitRequestForm');
      const exitForm = event.target.closest('form[data-exit]');
      const extendForm = event.target.closest('form[data-extend]');
      const resolveForm = event.target.closest('form[data-resolve-todo]');
      if (!requestForm && !exitForm && !extendForm && !resolveForm) return;
      event.preventDefault();
      try {
        if (requestForm) return await handleRequestSubmit(requestForm, notify);
        if (exitForm) return await handleExitSubmit(exitForm, exitForm.dataset.exit, notify);
        if (extendForm) return await handleExtendSubmit(extendForm, extendForm.dataset.extend, notify);
        if (resolveForm) {
          await api(`/api/todos/${resolveForm.dataset.resolveTodo}/resolve`, {
            method: 'POST',
            body: JSON.stringify({ resolution: resolveForm.resolution.value })
          });
          await refresh();
          notify('搜索待办已完成');
        }
      } catch (error) {
        showAlert(error.message);
      }
    });

    document.addEventListener('click', (event) => {
      const expand = event.target.closest('[data-expand]');
      const collapse = event.target.closest('[data-collapse]');
      const action = event.target.closest('[data-action]');
      if (expand) {
        board.expanded.set(expand.dataset.id, expand.dataset.expand);
        renderPermits();
      }
      if (collapse) {
        board.expanded.delete(collapse.dataset.collapse);
        renderPermits();
      }
      if (action) {
        handleAction(action.dataset.action, action.dataset.id, notify).catch((error) => showAlert(error.message));
      }
    });

    const onFilter = () => board.data && renderPermits();
    document.addEventListener('input', (event) => {
      if (event.target.id === 'permitSearch' || event.target.id === 'permitStatusFilter') onFilter();
    });
    document.addEventListener('change', (event) => {
      if (event.target.id === 'permitStatusFilter') onFilter();
    });

    // 页面打开期间定时静默刷新，逾期状态会自动置顶。
    setInterval(() => {
      if (safeToSilenceRefresh()) refresh().catch(() => {});
    }, 20000);
  }

  window.PermitBoard = {
    renderShell,
    hydrate(notify) {
      bind(notify);
      return refresh();
    },
    refreshSilently() {
      if (safeToSilenceRefresh()) return refresh().catch(() => {});
      return null;
    }
  };
})();
