// 洞穴巡测台：进洞许可 / 出洞释放闭环的纯领域规则。
// 本模块不读写文件、不接触 HTTP，所有结果要么返回 { error }，要么直接改写传入的 db。
// 这样许可规则可以被服务端复用，也方便单独核对。

const STATUS = {
  GRANTED: '已许可',     // 已发放、分区额度被占用
  PENDING_SEARCH: '待搜索', // 出洞核对有缺员/装备异常，额度不释放
  RELEASED: '已释放'      // 闭环结束，额度归还
};

const TODO_STATUS = {
  OPEN: '待处理',
  DONE: '已处理'
};

const SHANGHAI_TZ_OFFSET_MIN = 8 * 60;

function shanghaiParts(when) {
  const shifted = new Date(when.getTime() + SHANGHAI_TZ_OFFSET_MIN * 60000);
  const pad = (n) => String(n).padStart(2, '0');
  return {
    date: `${shifted.getUTCFullYear()}-${pad(shifted.getUTCMonth() + 1)}-${pad(shifted.getUTCDate())}`,
    time: `${pad(shifted.getUTCHours())}:${pad(shifted.getUTCMinutes())}`
  };
}

function shanghaiDay(date) {
  return shanghaiParts(date).date;
}

function shanghaiDateTime(when) {
  const { date, time } = shanghaiParts(when);
  return `${date} ${time}`;
}

// datetime-local（无时区）按东八区解释，避免服务器部署在 UTC 时日期错位。
function parseLocalAsShanghai(value) {
  if (!value) return null;
  const m = String(value).trim().match(/^(\d{4})-(\d{2})-(\d{2})[T ](\d{1,2}):(\d{2})/);
  if (!m) return null;
  const [, y, mo, d, h, mi] = m;
  const hour = Number(h);
  const minute = Number(mi);
  if (hour > 23 || minute > 59) return null;
  const utcMs = Date.UTC(+y, +mo - 1, +d, hour, minute) - SHANGHAI_TZ_OFFSET_MIN * 60000;
  return new Date(utcMs);
}

function stamp(action, note) {
  return { at: new Date().toISOString(), action, note: note || '' };
}

function splitMembers(text) {
  return [...new Set(
    String(text || '')
      .split(/[\s,，、;；\n\r]+/)
      .map((name) => name.trim())
      .filter(Boolean)
  )];
}

function dedupeKey(input) {
  const start = parseLocalAsShanghai(input.plannedStart);
  const members = splitMembers(input.memberNames).join('|');
  return [
    String(input.teamName || '').trim(),
    String(input.cave || '').trim(),
    String(input.zone || '').trim(),
    start ? start.toISOString() : '',
    members
  ].join('§');
}

function permitNumber(db, now) {
  const day = shanghaiDay(now).replaceAll('-', '');
  const prefix = `P-${day}-`;
  let max = 0;
  for (const permit of db.permits) {
    if (permit.permitNo?.startsWith(prefix)) {
      max = Math.max(max, Number(permit.permitNo.slice(prefix.length)) || 0);
    }
  }
  return `${prefix}${String(max + 1).padStart(2, '0')}`;
}

function overlap(a, b) {
  return new Date(a.start).getTime() < new Date(b.end).getTime() &&
    new Date(b.start).getTime() < new Date(a.end).getTime();
}

// 仍占用分区额度的许可。
function activePermits(db, at = new Date()) {
  return db.permits.filter((permit) => permit.status !== STATUS.RELEASED);
}

// 普通进洞申请的分区互斥：等待确认的延长尚未生效，不预先占用新窗。
function conflictingPermit(db, candidate, at) {
  const cWindow = { start: candidate.plannedStart, end: candidate.plannedEnd };
  return activePermits(db, at).find((permit) => {
    if (permit.id === candidate.id) return false;
    if (permit.cave !== candidate.cave || permit.zone !== candidate.zone) return false;
    if (permit.pendingExtension) return false;
    return overlap(cWindow, { start: permit.plannedStart, end: permit.plannedEnd });
  });
}

// 延长重确认：把“申请中的新整段窗口”与其他所有未释放许可的实际窗口比较。
function extensionConflict(db, permit, requestedEndIso, at) {
  const cWindow = { start: permit.plannedStart, end: requestedEndIso };
  return activePermits(db, at).find((other) => {
    if (other.id === permit.id) return false;
    if (other.cave !== permit.cave || other.zone !== permit.zone) return false;
    return overlap(cWindow, { start: other.plannedStart, end: other.plannedEnd });
  });
}

function routeSites(db, routeSiteIds) {
  return (routeSiteIds || [])
    .map((id) => db.sites.find((site) => site.id === id))
    .filter(Boolean);
}

function validateRequest(db, input, now) {
  const teamName = String(input.teamName || '').trim();
  const cave = String(input.cave || '').trim();
  const zone = String(input.zone || '').trim();
  const leader = String(input.leader || '').trim();
  const members = splitMembers(input.memberNames);
  const start = parseLocalAsShanghai(input.plannedStart);
  const end = parseLocalAsShanghai(input.plannedEnd);

  if (!teamName || !cave || !zone || !leader) return { error: '班组、洞穴、分区、领队均为必填项' };
  if (!members.length) return { error: '请至少填写一名进洞人员' };
  if (!members.includes(leader)) return { error: `领队「${leader}」必须在进洞人员名单内` };
  if (!start || !end) return { error: '请填写预计进洞与出洞时间' };
  if (end.getTime() <= start.getTime()) return { error: '预计出洞时间必须晚于进洞时间' };

  const ids = Array.isArray(input.routeSiteIds) ? [...new Set(input.routeSiteIds)] : [];
  if (!ids.length) return { error: '请至少选择一个巡测样点作为路线' };
  const unknown = ids.filter((id) => !db.sites.some((site) => site.id === id));
  if (unknown.length) return { error: '路线中包含不存在的样点，请刷新后重选' };
  const closedSite = db.sites.find((site) => ids.includes(site.id) && site.protectedStatus === '暂停开放');
  if (closedSite) return { error: `路线含暂停开放样点 ${closedSite.pointCode}（${closedSite.zone}），拒绝进洞` };

  const today = shanghaiDay(now);
  const registered = db.surveys.some((survey) =>
    survey.surveyor === leader && String(survey.date || '') === today
  );
  if (!registered) return { error: `领队「${leader}」尚未完成 ${today} 的当日巡测登记，拒绝进洞` };

  return {
    value: { teamName, cave, zone, leader, members, start, end, routeSiteIds: ids }
  };
}

// 申请进洞许可。拒绝不落库，避免留下半张许可。
// 幂等：同班组同分区同进洞时间同名单的重复/并发申请沿用首次许可。
function requestPermit(db, rawInput, ctx) {
  const now = ctx.now || new Date();

  const key = dedupeKey(rawInput);
  const existing = db.permits.find((permit) => permit.dedupeKey === key);
  if (existing) return { item: existing, reused: true };

  const check = validateRequest(db, rawInput, now);
  if (check.error) return { error: check.error };
  const v = check.value;

  const candidate = {
    cave: v.cave,
    zone: v.zone,
    plannedStart: v.start.toISOString(),
    plannedEnd: v.end.toISOString()
  };
  const blockedBy = conflictingPermit(db, candidate, now);
  if (blockedBy) {
    return { error: `${v.cave} / ${v.zone} 在该时段已被 ${blockedBy.teamName}（许可 ${blockedBy.permitNo}）占用，同分区同一时段只许一组进洞` };
  }

  const id = ctx.nextId('permits');
  const ts = now.toISOString();
  const permit = {
    id,
    permitNo: permitNumber(db, now),
    dedupeKey: key,
    teamName: v.teamName,
    cave: v.cave,
    zone: v.zone,
    leader: v.leader,
    memberNames: v.members,
    routeSiteIds: v.routeSiteIds,
    plannedStart: v.start.toISOString(),
    plannedEnd: v.end.toISOString(),
    status: STATUS.GRANTED,
    pendingExtension: null,
    exitReport: null,
    openTodoIds: [],
    createdAt: ts,
    updatedAt: ts,
    history: [stamp('许可发放', `${v.cave} / ${v.zone}，${v.members.length} 人，预计 ${shanghaiDateTime(v.end)} 出洞`)]
  };
  db.permits.push(permit);
  return { item: permit, reused: false };
}

function getPermit(db, id) {
  return db.permits.find((permit) => permit.id === id) || null;
}

function canExtend(permit, requestedEndDate, db, now) {
  if (permit.status === STATUS.RELEASED) return { error: '许可已释放，不能延长' };
  if (!requestedEndDate || Number.isNaN(requestedEndDate.getTime())) return { error: '新的预计出洞时间无效' };
  const currentEnd = new Date(permit.pendingExtension?.requestedEnd || permit.plannedEnd);
  if (requestedEndDate.getTime() <= currentEnd.getTime()) {
    return { error: `新出洞时间必须晚于当前预计 ${shanghaiDateTime(currentEnd)}` };
  }
  // 等待重确认期间，许可按原窗口参与互斥；确认时再做整段重校验。
  const candidate = {
    id: permit.id,
    cave: permit.cave,
    zone: permit.zone,
    plannedStart: permit.plannedStart,
    plannedEnd: requestedEndDate.toISOString()
  };
  const blockedBy = conflictingPermit(db, candidate, now);
  if (blockedBy) {
    return { error: `延长期与 ${blockedBy.teamName}（许可 ${blockedBy.permitNo}）的时段冲突` };
  }
  return {};
}

// 第一步：提交延长申请，许可进入“延长待确认”，暂不扩大占用窗口。
function requestExtension(db, id, rawEnd, reason, ctx) {
  const now = ctx.now || new Date();
  const permit = getPermit(db, id);
  if (!permit) return { error: '许可不存在' };
  const requestedEnd = parseLocalAsShanghai(rawEnd);
  const guard = canExtend(permit, requestedEnd, db, now);
  if (guard.error) return { error: guard.error };

  permit.pendingExtension = {
    requestedEnd: requestedEnd.toISOString(),
    reason: String(reason || '').trim(),
    requestedAt: now.toISOString()
  };
  permit.updatedAt = now.toISOString();
  permit.history = permit.history || [];
  permit.history.unshift(stamp('申请延长', `预计出洞改为 ${shanghaiDateTime(requestedEnd)}，待重确认`));
  return { item: permit, pending: permit.pendingExtension };
}

// 第二步：重确认。重新校验整段时间窗的互斥规则，通过才真正延长。
function confirmExtension(db, id, ctx) {
  const now = ctx.now || new Date();
  const permit = getPermit(db, id);
  if (!permit) return { error: '许可不存在' };
  const pending = permit.pendingExtension;
  if (!pending) return { error: '该许可没有待确认的延长申请' };

  // 重确认：把申请中的新整段窗口与其他许可的实际窗口比较。
  const blockedBy = extensionConflict(db, permit, pending.requestedEnd, now);
  if (blockedBy) {
    return { error: `重确认失败：延长期与 ${blockedBy.teamName}（许可 ${blockedBy.permitNo}）冲突，维持原预计出洞时间` };
  }

  const oldEnd = permit.plannedEnd;
  permit.plannedEnd = pending.requestedEnd;
  permit.pendingExtension = null;
  permit.updatedAt = now.toISOString();
  permit.history = permit.history || [];
  permit.history.unshift(stamp('延长已确认', `${shanghaiDateTime(new Date(oldEnd))} → ${shanghaiDateTime(new Date(pending.requestedEnd))}${pending.reason ? `：${pending.reason}` : ''}`));
  return { item: permit };
}

function cancelExtension(db, id, ctx) {
  const now = ctx.now || new Date();
  const permit = getPermit(db, id);
  if (!permit) return { error: '许可不存在' };
  if (!permit.pendingExtension) return { error: '该许可没有待确认的延长申请' };
  permit.pendingExtension = null;
  permit.updatedAt = now.toISOString();
  permit.history = permit.history || [];
  permit.history.unshift(stamp('撤销延长', '维持原预计出洞时间'));
  return { item: permit };
}

// 出洞核对：全员到齐 + 实际路线 + 异常装备。
// 有缺员或装备异常：只生成搜索待办，状态转“待搜索”，不释放额度。
function exitCheck(db, rawInput, ctx) {
  const now = ctx.now || new Date();
  const permit = getPermit(db, ctx.permitId);
  if (!permit) return { error: '许可不存在' };
  if (permit.status === STATUS.RELEASED) return { error: '许可已释放，不能重复核对出洞' };
  if (permit.status === STATUS.PENDING_SEARCH) return { error: '该许可已转搜索流程，请处理搜索待办后释放额度' };

  const returned = splitMembers(rawInput.returnedMemberNames);
  if (!returned.length) return { error: '请填写实际出洞人员' };

  const plannedIds = permit.routeSiteIds || [];
  const actualIds = Array.isArray(rawInput.actualRouteSiteIds) ? [...new Set(rawInput.actualRouteSiteIds)] : [];
  const actualNames = splitMembers(rawInput.actualRouteExtra); // 临时样点名（自由文本）
  const visited = new Set([...actualIds, ...actualNames]);
  const skipped = plannedIds.filter((id) => !visited.has(id));
  const addedIds = actualIds.filter((id) => !plannedIds.includes(id));

  const plannedMembers = permit.memberNames || [];
  const returnedSet = new Set(returned);
  const missing = plannedMembers.filter((name) => !returnedSet.has(name));
  const extra = returned.filter((name) => !plannedMembers.includes(name));

  const gearAbnormal = rawInput.gearAbnormal === true || rawInput.gearAbnormal === 'true';
  const gearNote = String(rawInput.gearNote || '').trim();
  if (gearAbnormal && !gearNote) return { error: '装备异常时必须填写异常装备说明' };

  const exitReport = {
    at: now.toISOString(),
    returnedMemberNames: returned,
    actualRouteSiteIds: actualIds,
    actualRouteExtra: actualNames,
    skippedSiteIds: skipped,
    addedSiteIds: addedIds,
    extraMemberNames: extra,
    gearAbnormal,
    gearNote,
    note: String(rawInput.note || '').trim()
  };
  permit.exitReport = exitReport;
  permit.updatedAt = now.toISOString();
  permit.history = permit.history || [];

  const problems = [];
  if (missing.length) problems.push(`缺员：${missing.join('、')}`);
  if (gearAbnormal) problems.push(`装备异常：${gearNote}`);

  if (!problems.length) {
    // 全员到齐、装备无异常：允许释放（由释放动作显式确认并记录）。
    permit.history.unshift(stamp('出洞核对通过',
      `全员 ${returned.length} 人到齐` +
      (skipped.length || addedIds.length || actualNames.length ? '，实际路线与计划有偏差已记录' : '，实际路线与计划一致')));
    return { item: permit, releaseEligible: true };
  }

  permit.status = STATUS.PENDING_SEARCH;
  const todoId = ctx.nextId('todos');
  const todo = {
    id: todoId,
    kind: '洞内搜索',
    status: TODO_STATUS.OPEN,
    permitId: permit.id,
    permitNo: permit.permitNo,
    cave: permit.cave,
    zone: permit.zone,
    teamName: permit.teamName,
    memberNames: missing,
    gearNote: gearAbnormal ? gearNote : '',
    description: problems.join('；'),
    createdAt: now.toISOString(),
    updatedAt: now.toISOString(),
    history: [stamp('出洞核对未通过', problems.join('；'))]
  };
  db.todos.push(todo);
  permit.openTodoIds = [...new Set([...(permit.openTodoIds || []), todoId])];
  permit.history.unshift(stamp('出洞核对未通过', `${problems.join('；')}，已生成搜索待办，分区额度暂不释放`));
  return { item: permit, releaseEligible: false, todo };
}

// 搜索待办全部关闭后显式释放额度。
function releasePermit(db, id, ctx) {
  const now = ctx.now || new Date();
  const permit = getPermit(db, id);
  if (!permit) return { error: '许可不存在' };
  if (permit.status === STATUS.RELEASED) return { item: permit };

  const open = (permit.openTodoIds || [])
    .map((todoId) => db.todos.find((todo) => todo.id === todoId))
    .filter((todo) => todo && todo.status !== TODO_STATUS.DONE);
  if (open.length) return { error: `还有 ${open.length} 条搜索待办未处理，不能释放分区额度` };

  permit.status = STATUS.RELEASED;
  permit.releasedAt = now.toISOString();
  permit.updatedAt = now.toISOString();
  permit.history = permit.history || [];
  const hadExit = Boolean(permit.exitReport);
  permit.history.unshift(stamp('额度释放', hadExit ? '出洞闭环完成，分区额度归还' : '人工释放分区额度'));
  return { item: permit };
}

function resolveTodo(db, id, resolution, ctx) {
  const now = ctx.now || new Date();
  const todo = db.todos.find((entry) => entry.id === id);
  if (!todo) return { error: '待办不存在' };
  if (todo.status === TODO_STATUS.DONE) return { item: todo };

  todo.status = TODO_STATUS.DONE;
  todo.resolution = String(resolution || '').trim();
  todo.resolvedAt = now.toISOString();
  todo.updatedAt = now.toISOString();
  todo.history = todo.history || [];
  todo.history.unshift(stamp('搜索待办处理', todo.resolution || '人员找回、装备核清'));

  const permit = todo.permitId ? getPermit(db, todo.permitId) : null;
  if (permit) {
    permit.updatedAt = now.toISOString();
    permit.history = permit.history || [];
    permit.history.unshift(stamp('待办已处理', todo.resolution ? `${todo.description}：${todo.resolution}` : todo.description));
  }
  return { item: todo, permit };
}

function decoratePermit(permit, db, now) {
  const decorated = { ...permit };
  // 延长未确认前不扩大占用窗口，逾期仍按原预计出洞时间判断。
  const effectiveEnd = new Date(permit.plannedEnd);
  decorated.effectiveEnd = permit.plannedEnd;
  decorated.overdue = permit.status !== STATUS.RELEASED && now.getTime() > effectiveEnd.getTime();
  decorated.overdueMinutes = decorated.overdue ? Math.floor((now.getTime() - effectiveEnd.getTime()) / 60000) : 0;
  decorated.hasPendingExtension = Boolean(permit.pendingExtension);
  decorated.openTodos = (permit.openTodoIds || [])
    .map((todoId) => db.todos.find((todo) => todo.id === todoId))
    .filter((todo) => todo && todo.status !== TODO_STATUS.DONE);
  decorated.canRelease = permit.status !== STATUS.RELEASED &&
    decorated.openTodos.length === 0 &&
    !permit.pendingExtension;
  return decorated;
}

// 逾期自动置顶，其次待搜索，再按计划进洞时间倒序。入参为 decoratePermit 装饰后的许可。
function rankPermit(decorated) {
  return [
    decorated.overdue ? 1 : 0,
    decorated.status === STATUS.PENDING_SEARCH ? 1 : 0,
    new Date(decorated.plannedStart).getTime()
  ];
}

function listPermits(db, now) {
  return db.permits
    .map((permit) => decoratePermit(permit, db, now))
    .sort((a, b) => {
      const ra = rankPermit(a);
      const rb = rankPermit(b);
      if (rb[0] !== ra[0]) return rb[0] - ra[0];
      if (rb[1] !== ra[1]) return rb[1] - ra[1];
      return rb[2] - ra[2];
    });
}

function currentOccupancy(db, now) {
  const groups = new Map();
  for (const permit of db.permits) {
    if (permit.status === STATUS.RELEASED) continue;
    const key = `${permit.cave}§${permit.zone}`;
    if (!groups.has(key)) {
      groups.set(key, { cave: permit.cave, zone: permit.zone, permits: [] });
    }
    groups.get(key).permits.push(decoratePermit(permit, db, now));
  }
  return [...groups.values()]
    .map((group) => ({
      ...group,
      overdue: group.permits.some((permit) => permit.overdue)
    }))
    .sort((a, b) => Number(b.overdue) - Number(a.overdue) || a.cave.localeCompare(b.cave, 'zh') || a.zone.localeCompare(b.zone, 'zh'));
}

// 派工看板专用快照：许可、待办、占用，以及申请表需要的下拉数据。
function buildBoard(db, now) {
  const permits = listPermits(db, now);
  const todos = db.todos
    .map((todo) => ({
      ...todo,
      permit: todo.permitId ? getPermit(db, todo.permitId) : null
    }))
    .sort((a, b) => {
      const rank = (t) => (t.status === TODO_STATUS.DONE ? 1 : 0);
      const diff = rank(a) - rank(b);
      return diff !== 0 ? diff : new Date(b.createdAt) - new Date(a.createdAt);
    });
  return {
    now: now.toISOString(),
    occupancy: currentOccupancy(db, now),
    permits,
    todos,
    sites: db.sites.map((site) => ({
      id: site.id,
      cave: site.cave,
      zone: site.zone,
      pointCode: site.pointCode,
      route: site.route,
      protectedStatus: site.protectedStatus
    })),
    // 近 30 天有登记的人员，供领队下拉。
    leaders: [...new Set(db.surveys.map((survey) => survey.surveyor).filter(Boolean))].sort(),
    today: shanghaiDay(now)
  };
}

module.exports = {
  STATUS,
  TODO_STATUS,
  shanghaiDay,
  shanghaiDateTime,
  parseLocalAsShanghai,
  splitMembers,
  dedupeKey,
  requestPermit,
  requestExtension,
  confirmExtension,
  cancelExtension,
  exitCheck,
  releasePermit,
  resolveTodo,
  decoratePermit,
  listPermits,
  currentOccupancy,
  buildBoard
};
