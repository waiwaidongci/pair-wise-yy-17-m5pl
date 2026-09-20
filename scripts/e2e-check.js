// 端到端场景验证：通过 HTTP 走完整闭环。运行后恢复演示数据。
const fs = require('fs');
const path = require('path');

const BASE = 'http://localhost:3912';
const seed = fs.readFileSync(path.join(__dirname, '..', 'data', 'db.json'), 'utf8');

let failures = 0;
function check(name, cond, detail = '') {
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`);
  if (!cond) failures++;
}

async function req(method, url, body) {
  const res = await fetch(BASE + url, {
    method,
    headers: { 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body)
  });
  const json = await res.json().catch(() => null);
  return { status: res.status, json };
}

// 以上海墙钟生成 datetime-local 字符串，offsetMin 相对当前上海时间，自动跨天。
function shanghaiAt(offsetMin, second = 0) {
  const d = new Date(Date.now() + (8 * 60 + offsetMin) * 60000);
  const pad = (n) => String(n).padStart(2, '0');
  return `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}T${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}:${pad(second)}`;
}
// 统一场景基准时刻：5 分钟后的下一个整分钟（上海墙钟），各窗口按相对分钟偏移。
const shanghaiNowMs = Date.now() + 8 * 3600000;
const T0 = (Math.ceil(shanghaiNowMs / 60000 + 5) * 60000 - shanghaiNowMs) / 60000;
const today = shanghaiAt(T0).slice(0, 10);
const start = shanghaiAt(T0);
const end = shanghaiAt(T0 + 180);
const laterEnd = shanghaiAt(T0 + 300);

async function main() {
  // 1. 拒绝：领队未完成当日登记（韩冰最近登记是昨天）
  let r = await req('POST', '/api/permits/request', {
    teamName: '乙班', cave: '北麓三号洞', zone: '流石坡区', leader: '韩冰',
    memberNames: '韩冰 赵岩', plannedStart: start, plannedEnd: end, routeSiteIds: ['site-seed-3']
  });
  check('领队未当日登记 → 409 拒绝', r.status === 409 && /当日/.test(r.json.error), r.json.error);

  // 2. 拒绝：路线含暂停开放样点（周岭今天登记过）
  r = await req('POST', '/api/permits/request', {
    teamName: '乙班', cave: '北麓三号洞', zone: '流石坡区', leader: '周岭',
    memberNames: '周岭 赵岩', plannedStart: start, plannedEnd: end, routeSiteIds: ['site-seed-3', 'site-seed-4']
  });
  check('路线含暂停开放样点 → 409 拒绝', r.status === 409 && /暂停开放/.test(r.json.error), r.json.error);

  // 3. 拒绝：领队不在名单
  r = await req('POST', '/api/permits/request', {
    teamName: '乙班', cave: '北麓三号洞', zone: '流石坡区', leader: '周岭',
    memberNames: '赵岩 高远', plannedStart: start, plannedEnd: end, routeSiteIds: ['site-seed-3']
  });
  check('领队不在名单 → 409 拒绝', r.status === 409 && /名单/.test(r.json.error), r.json.error);

  // 4. 拒绝不落库
  const board0 = await req('GET', '/api/board/permits');
  check('拒绝申请不留许可记录', board0.json.permits.length === 0 && board0.json.occupancy.length === 0);

  // 5. 合法申请 → 201 发放
  r = await req('POST', '/api/permits/request', {
    teamName: '甲班', cave: '北麓三号洞', zone: '流石坡区', leader: '周岭',
    memberNames: '周岭 高远 林晓', plannedStart: start, plannedEnd: end, routeSiteIds: ['site-seed-3']
  });
  check('合法申请 → 201', r.status === 201 && !r.json.reused && r.json.item.status === '已许可');
  const permitId = r.json.item.id;
  const permitNo = r.json.item.permitNo;
  check('许可号按日编号', /^P-\d{8}-01$/.test(permitNo), permitNo);

  // 6. 同分区同时段另一组 → 拒绝
  r = await req('POST', '/api/permits/request', {
    teamName: '乙班', cave: '北麓三号洞', zone: '流石坡区', leader: '周岭',
    memberNames: '周岭 赵岩', plannedStart: start, plannedEnd: end, routeSiteIds: ['site-seed-3']
  });
  check('同分区同时段第二组 → 409', r.status === 409 && /占用/.test(r.json.error), r.json.error);

  // 7. 时间窗相邻（不重叠）允许；完全相同申请则幂等沿用
  const dup = await req('POST', '/api/permits/request', {
    teamName: '甲班', cave: '北麓三号洞', zone: '流石坡区', leader: '周岭',
    memberNames: '周岭 高远 林晓', plannedStart: start, plannedEnd: end, routeSiteIds: ['site-seed-3']
  });
  check('重复申请 → 沿用首次许可', dup.status === 200 && dup.json.reused && dup.json.item.id === permitId);

  // 8. 不同分区同时段允许
  const other = await req('POST', '/api/permits/request', {
    teamName: '丙班', cave: '南坡一号洞', zone: '竖井厅区', leader: '周岭',
    memberNames: '周岭 陈默', plannedStart: start, plannedEnd: end, routeSiteIds: ['site-seed-5']
  });
  check('不同分区同时段 → 允许', other.status === 201);

  // 9. 通用写接口禁止操作 permits/todos
  const blocked = await req('POST', '/api/permits', { foo: 1 });
  check('通用 POST /api/permits → 403', blocked.status === 403, blocked.json.error);

  // 10. 延长两阶段：申请后状态保持，确认时做冲突校验（场景放在两天后，避开其他测试时段）
  const EXT_DAY = 2 * 1440;
  let ext = await req('POST', `/api/permits/${other.json.item.id}/extend`, {
    plannedEnd: shanghaiAt(EXT_DAY + 180), reason: '补测'
  });
  check('延长申请成功', ext.status === 200 && ext.json.item.pendingExtension, JSON.stringify(ext.json));
  const b1 = await req('GET', '/api/board/permits');
  const otherView = b1.json.permits.find((p) => p.id === other.json.item.id);
  check('延长待确认期间 effectiveEnd 仍是原窗口', otherView.effectiveEnd === other.json.item.plannedEnd);
  // 闯入组压在“申请中的延长窗”尾部（远晚于丙班原窗口终点），确认延长时必须冲突。
  const intruderStart = shanghaiAt(EXT_DAY + 170, 30);
  const intruderEnd = shanghaiAt(EXT_DAY + 240, 30);
  const intruder = await req('POST', '/api/permits/request', {
    teamName: '丁班', cave: '南坡一号洞', zone: '竖井厅区', leader: '周岭',
    memberNames: '周岭 吴桐', plannedStart: intruderStart, plannedEnd: intruderEnd, routeSiteIds: ['site-seed-5']
  });
  check('延长未确认 → 后组可占用延长窗（原窗口不重叠）', intruder.status === 201);
  const confirmFail = await req('POST', `/api/permits/${other.json.item.id}/extend-confirm`, {});
  check('延长重确认遇冲突 → 409 且维持原时间', confirmFail.status === 409 && /冲突/.test(confirmFail.json.error), JSON.stringify(confirmFail.json));
  // 后组释放后重确认成功（先给后组做正常出洞核对+释放）
  await req('POST', `/api/permits/${intruder.json.item.id}/exit`, {
    returnedMemberNames: '周岭 吴桐', actualRouteSiteIds: ['site-seed-5'], gearAbnormal: false
  });
  await req('POST', `/api/permits/${intruder.json.item.id}/release`, {});
  const confirmOk = await req('POST', `/api/permits/${other.json.item.id}/extend-confirm`, {});
  check('冲突解除后重确认 → 延长生效', confirmOk.status === 200 && confirmOk.json.item.plannedEnd === ext.json.item.pendingExtension.requestedEnd);

  // 11. 出洞核对：缺员 + 装备异常 → 待办、不释放
  const badExit = await req('POST', `/api/permits/${permitId}/exit`, {
    returnedMemberNames: '周岭 高远', // 林晓未出
    actualRouteSiteIds: ['site-seed-3'],
    gearAbnormal: true, gearNote: '气体检测仪遗失一台'
  });
  check('缺员+装备异常 → 不释放且生成待办', badExit.status === 201 && badExit.json.releaseEligible === false && badExit.json.todo);
  check('许可转“待搜索”', badExit.json.item.status === '待搜索');
  const b2 = await req('GET', '/api/board/permits');
  const p2 = b2.json.permits.find((p) => p.id === permitId);
  check('待搜索期间仍占用分区', p2.openTodos.length === 1 && b2.json.occupancy.some((g) => g.zone === '流石坡区'));
  const releaseBlocked = await req('POST', `/api/permits/${permitId}/release`, {});
  check('有待办时释放 → 409', releaseBlocked.status === 409);

  // 12. 待办关闭后才能释放
  const todoId = badExit.json.todo.id;
  const resolve = await req('POST', `/api/todos/${todoId}/resolve`, { resolution: '林晓在L-02支洞找回，检测仪在营地补领' });
  check('完成搜索待办', resolve.status === 200 && resolve.json.item.status === '已处理');
  const b3 = await req('GET', '/api/board/permits');
  const p3 = b3.json.permits.find((p) => p.id === permitId);
  check('待办清零后出现可释放状态', p3.canRelease === true);
  const released = await req('POST', `/api/permits/${permitId}/release`, {});
  check('释放成功 → 已释放', released.status === 200 && released.json.item.status === '已释放');

  // 13. 释放后该分区新组可进（排在次日，避免与其他时段撞车）
  const nextDay = 1440;
  const after = await req('POST', '/api/permits/request', {
    teamName: '乙班', cave: '北麓三号洞', zone: '流石坡区', leader: '周岭',
    memberNames: '周岭 赵岩', plannedStart: shanghaiAt(nextDay), plannedEnd: shanghaiAt(nextDay + 180),
    routeSiteIds: ['site-seed-3']
  });
  check('额度释放后同分区时段 → 允许新组', after.status === 201 && after.json.item.teamName === '乙班', after.json.error || after.json.item?.permitNo);

  // 14. 全员正常出洞 → 直接可释放
  const okExit = await req('POST', `/api/permits/${after.json.item.id}/exit`, {
    returnedMemberNames: '周岭 赵岩', actualRouteSiteIds: ['site-seed-3'], gearAbnormal: false
  });
  check('全员正常出洞 → releaseEligible', okExit.status === 201 && okExit.json.releaseEligible === true);
  check('正常出洞不生成待办', !okExit.json.todo);

  // 15. 并发申请：同时打两个相同请求，只有一张许可
  const concurrentStart = shanghaiAt(T0 + 360);
  const concurrentEnd = shanghaiAt(T0 + 540);
  const payload = {
    teamName: '并发班', cave: '北麓三号洞', zone: '滴水帘区', leader: '周岭',
    memberNames: '周岭 郑海', plannedStart: concurrentStart, plannedEnd: concurrentEnd, routeSiteIds: ['site-seed-1', 'site-seed-2']
  };
  const [c1, c2] = await Promise.all([
    req('POST', '/api/permits/request', payload),
    req('POST', '/api/permits/request', payload)
  ]);
  const codes = [c1.status, c2.status].sort().join(',');
  const ids = [c1.json.item?.id, c2.json.item?.id];
  check('并发相同申请 → 201+200 沿用同一许可', codes === '200,201' && ids[0] === ids[1], codes);

  // 16. 刷新后占用/待办/履历一致（完全从 db 重建）
  const b4 = await req('GET', '/api/board/permits');
  const permitsDb = await req('GET', '/api/db');
  check('看板许可数与存储一致', b4.json.permits.length === permitsDb.json.permits.length);
  check('已释放许可不再占用分区', !b4.json.occupancy.some((g) => g.permits.some((p) => p.status === '已释放')));
  check('搜索待办与存储一致', b4.json.todos.length === permitsDb.json.todos.length);
  check('履历挂在许可记录上', b4.json.permits.every((p) => Array.isArray(p.history) && p.history.length >= 1));

  console.log(`\n${failures ? `${failures} 项失败` : '全部通过'}`);
  process.exitCode = failures ? 1 : 0;
}

main()
  .catch((error) => { console.error(error); process.exitCode = 1; })
  .finally(() => {
    fs.writeFileSync(path.join(__dirname, '..', 'data', 'db.json'), seed);
    console.log('(已恢复演示数据)');
  });
