// 并发压力：同分区不同班组同时申请，只许一张许可；同班组重复申请沿用。
const fs = require('fs');
const path = require('path');

const BASE = 'http://localhost:3912';
const seed = fs.readFileSync(path.join(__dirname, '..', 'data', 'db.json'), 'utf8');

async function req(method, url, body) {
  const res = await fetch(BASE + url, {
    method,
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body)
  });
  return { status: res.status, json: await res.json().catch(() => null) };
}

function shanghaiAt(offsetMin) {
  const d = new Date(Date.now() + (8 * 60 + offsetMin) * 60000);
  const pad = (n) => String(n).padStart(2, '0');
  return `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}T${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}:00`;
}

async function main() {
  let failures = 0;
  const check = (name, cond, detail = '') => {
    console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`);
    if (!cond) failures++;
  };

  const basePayload = {
    cave: '北麓三号洞', zone: '流石坡区', leader: '周岭',
    plannedStart: shanghaiAt(60), plannedEnd: shanghaiAt(180),
    routeSiteIds: ['site-seed-3']
  };

  // 10 个不同班组抢同一时段：恰好 1 张 201，其余 409
  const raiders = await Promise.all(
    Array.from({ length: 10 }, (_, i) =>
      req('POST', '/api/permits/request', { ...basePayload, teamName: `抢洞班${i}`, memberNames: `周岭 队员${i}` }))
  );
  const created = raiders.filter((r) => r.status === 201);
  const rejected = raiders.filter((r) => r.status === 409);
  check('10 组并发抢同一时段 → 仅 1 张许可', created.length === 1 && rejected.length === 9, `201=${created.length}, 409=${rejected.length}`);

  // 同一组再连发 5 次完全相同申请：全部沿用同一许可，不新增
  const winner = { teamName: created[0].json.item.teamName, memberNames: created[0].json.item.memberNames.join(' ') };
  const dupes = await Promise.all(
    Array.from({ length: 5 }, () =>
      req('POST', '/api/permits/request', { ...basePayload, ...winner }))
  );
  check('并发重复申请全部沿用首次许可', dupes.every((r) => r.status === 200 && r.json.reused && r.json.item.id === created[0].json.item.id));

  // 逾期：手工通过规则层构造一张过去窗口的许可，验证看板置顶与占用标记
  const store = require('../lib/store');
  const rules = require('../lib/permit-rules');
  await store.mutate((db) => {
    const now = new Date();
    const id = 'permit-overdue-test';
    db.permits.push({
      id,
      permitNo: 'P-TEST-OVERDUE',
      dedupeKey: 'overdue-test',
      teamName: '逾期班', cave: '南坡一号洞', zone: '竖井厅区', leader: '周岭',
      memberNames: ['周岭'],
      routeSiteIds: ['site-seed-5'],
      plannedStart: new Date(now.getTime() - 3 * 3600000).toISOString(),
      plannedEnd: new Date(now.getTime() - 30 * 60000).toISOString(),
      status: '已许可', pendingExtension: null, exitReport: null, openTodoIds: [],
      createdAt: now.toISOString(), updatedAt: now.toISOString(), history: []
    });
  });
  const board = await req('GET', '/api/board/permits');
  const top = board.json.permits[0];
  check('逾期许可自动置顶', top.id === 'permit-overdue-test' && top.overdue === true, `逾期${top.overdueMinutes} 分钟`);
  check('逾期分区在占用列表置顶并标红', board.json.occupancy[0].overdue === true);

  console.log(`\n${failures ? `${failures} 项失败` : '全部通过'}`);
  process.exitCode = failures ? 1 : 0;
}

main()
  .catch((error) => { console.error(error); process.exitCode = 1; })
  .finally(() => fs.writeFileSync(path.join(__dirname, '..', 'data', 'db.json'), seed));
