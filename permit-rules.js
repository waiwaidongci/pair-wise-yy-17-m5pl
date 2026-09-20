'use strict';

// 进洞许可闭环规则层：纯函数，不读文件、不碰 HTTP、不做页面展示。
// server.js 的闭环接口只能通过这里的函数判断能不能开票 / 放行。

const STATUS = {
  APPROVED: '已许可',       // 已开票，占用分区时段额度，尚未进洞
  INSIDE: '进洞中',         // 班组已进洞
  EXTEND_PENDING: '待确认延期', // 提出延期，等待领队重确认
  OVERDUE: '逾期',          // 超过预计出洞时间仍未释放
  RELEASED: '已出洞'        // 出洞核对通过，额度已释放
};

const ACTIVE_STATUSES = [
  STATUS.APPROVED,
  STATUS.INSIDE,
  STATUS.EXTEND_PENDING,
  STATUS.OVERDUE
];

// 本地时区的 YYYY-MM-DD，与巡测登记的 date 字段口径一致
function localYmd(now) {
  const d = now instanceof Date ? now : new Date(now);
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${d.getFullYear()}-${m}-${day}`;
}

// 名单支持换行 / 逗号 / 顿号 / 空白分隔
function splitNames(value) {
  return String(value || '')
    .split(/[\n,，、;；]+/)
    .map((name) => name.trim())
    .filter(Boolean);
}

function unique(list) {
  return [...new Set(list)];
}

function isActive(permit) {
  return ACTIVE_STATUSES.includes(permit.status);
}

function routeSites(db, route) {
  return (db.sites || []).filter((site) => site.route === route);
}

// 领队当日必须已有一条巡测登记
function leaderRegisteredToday(db, leader, today) {
  const name = String(leader || '').trim();
  return (db.surveys || []).some(
    (survey) => String(surveyorOf(survey) || '').trim() === name && survey.date === today
  );
}

function surveyorOf(survey) {
  return survey.surveyor;
}

function toTime(value) {
  if (!value) return null;
  const t = new Date(value);
  return Number.isNaN(t.getTime()) ? null : t;
}

// 半开区间重叠判定：[start,end) 与 [otherStart,otherEnd)
function intervalsOverlap(start, end, otherStart, otherEnd) {
  return start < otherEnd && otherStart < end;
}

function permitKeyOf(data) {
  return [data.team, data.zone, data.planEnterAt]
    .map((v) => String(v || '').trim())
    .join('|');
}

function activePermits(db) {
  return (db.permits || []).filter(isActive);
}

// 进洞申请校验：任一条件不满足都返回 error，由调用方保证不留任何记录。
function validateApplication(db, rawInput, now = new Date()) {
  const input = rawInput || {};
  const team = String(input.team || '').trim();
  const leader = String(input.leader || '').trim();
  const zone = String(input.zone || '').trim();
  const route = String(input.route || '').trim();
  const planEnterAt = String(input.planEnterAt || '').trim();
  const expectedExitAt = String(input.expectedExitAt || '').trim();

  if (!team) return { error: '班组名称必填' };
  if (!leader) return { error: '领队必填' };
  if (!zone) return { error: '分区必填' };
  if (!route) return { error: '巡测路线必填' };

  const enterAt = toTime(planEnterAt);
  const exitAt = toTime(expectedExitAt);
  if (!enterAt) return { error: '进洞时间格式不正确' };
  if (!exitAt) return { error: '预计出洞时间格式不正确' };
  if (!(enterAt < exitAt)) return { error: '预计出洞时间必须晚于进洞时间' };

  // 规则一：路线含暂停开放样点 → 整单拒绝
  const closed = routeSites(db, route).filter(
    (site) => site.protectedStatus === '暂停开放'
  );
  if (closed.length) {
    return {
      error: `路线「${route}」含暂停开放样点 ${closed
        .map((site) => site.pointCode)
        .filter(Boolean)
        .join('、')}，不予许可`
    };
  }

  // 规则二：领队未完成当日巡测登记 → 整单拒绝
  const today = localYmd(now);
  if (!leaderRegisteredToday(db, leader, today)) {
    return { error: `领队「${leader}」尚未完成 ${today} 的当日巡测登记，不予许可` };
  }

  const memberNames = unique(splitNames(input.memberNames ?? input.members));
  if (!memberNames.length) return { error: '进洞人员名单必填（含领队，每行一人）' };
  if (!memberNames.includes(leader)) memberNames.push(leader); // 领队默认计入全员

  const key = permitKeyOf({ team, zone, planEnterAt });

  // 重复 / 并发申请：同班组 + 同分区 + 同进洞时间，沿用首次许可
  const reuse = activePermits(db).find((permit) => permit.permitKey === key);
  if (reuse) return { reuse };

  // 规则三：同一分区同一时段只许一组进洞
  const blocker = activePermits(db).find(
    (permit) =>
      permit.zone === zone &&
      intervalsOverlap(
        enterAt.getTime(),
        exitAt.getTime(),
        toTime(permit.planEnterAt).getTime(),
        toTime(permit.expectedExitAt).getTime()
      )
  );
  if (blocker) {
    return {
      error: `分区「${zone}」该时段已由班组「${blocker.team}」占用（${blocker.planEnterAt} 至 ${blocker.expectedExitAt}），同一分区同一时段只许一组进洞`
    };
  }

  return {
    data: {
      team,
      leader,
      zone,
      route,
      planEnterAt,
      expectedExitAt,
      memberNames,
      permitKey: key,
      status: STATUS.APPROVED
    }
  };
}

// 延期：新时间必须合法、未与其他在洞班组冲突
function validateExtension(db, permit, nextExitRaw, now = new Date()) {
  if (!isActive(permit)) return { error: '许可已结束，不能延期' };
  const nextExit = toTime(nextExitRaw);
  if (!nextExit) return { error: '新的预计出洞时间格式不正确' };
  if (!(nextExit > now)) return { error: '新的预计出洞时间必须晚于当前时间，延期需重确认' };
  const enterAt = toTime(permit.planEnterAt);
  if (!(nextExit > enterAt)) return { error: '新的预计出洞时间必须晚于进洞时间' };

  const blocker = activePermits(db).find(
    (other) =>
      other.id !== permit.id &&
      other.zone === permit.zone &&
      intervalsOverlap(
        enterAt.getTime(),
        nextExit.getTime(),
        toTime(other.planEnterAt).getTime(),
        toTime(other.expectedExitAt).getTime()
      )
  );
  if (blocker) {
    return {
      error: `延期后与班组「${blocker.team}」在分区「${permit.zone}」的时段冲突，不予确认`
    };
  }
  return { expectedExitAt: nextExitRaw };
}

// 出洞核对：全员、实际路线、异常装备。
// 缺员或装备异常 → 生成搜索待办，且 canRelease=false，额度不释放。
function reviewExit(permit, report = {}) {
  const roster = permit.memberNames?.length
    ? permit.memberNames
    : splitNames(permit.members);
  const actual = unique(splitNames(report.actualMembers ?? report.members));
  const actualRoute = String(report.actualRoute || '').trim();
  const equipmentAbnormal =
    report.equipmentAbnormal === true ||
    report.equipmentAbnormal === 'true' ||
    report.equipmentAbnormal === '有异常';
  const equipmentNote = String(report.equipmentNote || '').trim();

  const missing = roster.filter((name) => !actual.includes(name));
  const unexpected = actual.filter((name) => !roster.includes(name));

  const todos = [];
  if (missing.length) {
    todos.push({
      kind: '缺员搜寻',
      detail: `出洞核对缺少队员：${missing.join('、')}`,
      missing
    });
  }
  if (equipmentAbnormal) {
    todos.push({
      kind: '装备异常',
      detail: `发现异常装备${equipmentNote ? `：${equipmentNote}` : '（未填写说明）'}`
    });
  }

  return {
    canRelease: todos.length === 0 && Boolean(actualRoute) && actual.length > 0,
    roster,
    actual,
    missing,
    unexpected,
    actualRoute,
    equipmentAbnormal,
    equipmentNote,
    todos
  };
}

// 逾期巡检：超过预计出洞时间仍在洞 → 逾期，供列表自动置顶
function sweepOverdue(db, now = new Date()) {
  let changed = false;
  for (const permit of db.permits || []) {
    if (
      permit.status !== STATUS.OVERDUE &&
      isActive(permit) &&
      permit.expectedExitAt &&
      toTime(permit.expectedExitAt) < now
    ) {
      permit.status = STATUS.OVERDUE;
      permit.updatedAt = now.toISOString();
      permit.history = permit.history || [];
      permit.history.unshift({
        at: now.toISOString(),
        action: '逾期自动置顶',
        note: `已超过预计出洞时间 ${permit.expectedExitAt}，额度仍被占用`
      });
      changed = true;
    }
  }
  return changed;
}

module.exports = {
  STATUS,
  ACTIVE_STATUSES,
  localYmd,
  splitNames,
  isActive,
  validateApplication,
  validateExtension,
  reviewExit,
  sweepOverdue
};
