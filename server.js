const express = require('express');
const fs = require('fs/promises');
const path = require('path');

const app = express();
const config = require('./project.config');
const rules = require('./permit-rules');
const PORT = process.env.PORT || config.port || 3900;
const DB_FILE = path.join(__dirname, 'data', 'db.json');

app.use(express.json({ limit: '2mb' }));
app.use(express.static(path.join(__dirname, 'public')));

// 串行化所有写操作：重复或并发申请沿用首次许可，不能重复占用额度
let writeChain = Promise.resolve();
function locked(handler) {
  return (req, res) => {
    writeChain = writeChain
      .then(() => handler(req, res))
      .catch((error) => {
        if (!res.headersSent) res.status(500).json({ error: error.message || '服务器错误' });
      });
    return writeChain;
  };
}

async function readDb() {
  const raw = await fs.readFile(DB_FILE, 'utf8');
  return JSON.parse(raw);
}

async function writeDb(db) {
  await fs.writeFile(DB_FILE, JSON.stringify(db, null, 2) + '\n');
}

function stamp(action, note) {
  return {
    at: new Date().toISOString(),
    action,
    note: note || ''
  };
}

function sortNewest(a, b) {
  return new Date(b.updatedAt || b.createdAt || 0) - new Date(a.updatedAt || a.createdAt || 0);
}

app.get('/api/config', (req, res) => {
  res.json(config);
});

app.get('/api/db', async (req, res) => {
  const db = await readDb();
  // 逾期自动置顶：读取即巡检，逾期许可仍占用额度
  if (rules.sweepOverdue(db, new Date())) await writeDb(db);
  for (const key of Object.keys(db)) {
    if (Array.isArray(db[key])) db[key].sort(sortNewest);
  }
  res.json(db);
});

// 闭环集合只能通过专用接口写入，避免绕过许可规则
const GENERIC_WRITABLE = ['sites', 'surveys'];

function nextId(collection) {
  return `${collection}-${Date.now()}-${Math.random().toString(16).slice(2, 7)}`;
}

app.post('/api/:collection', locked(async (req, res) => {
  const db = await readDb();
  const { collection } = req.params;
  if (!Array.isArray(db[collection])) return res.status(404).json({ error: 'unknown collection' });
  if (!GENERIC_WRITABLE.includes(collection)) {
    return res.status(405).json({ error: `「${collection}」需通过进洞许可闭环接口创建` });
  }
  const now = new Date().toISOString();
  const item = {
    id: nextId(collection),
    ...req.body,
    createdAt: now,
    updatedAt: now,
    history: [stamp('创建', req.body.note || req.body.memo || '')]
  };
  db[collection].push(item);
  await writeDb(db);
  res.status(201).json(item);
}));

app.patch('/api/:collection/:id', async (req, res) => {
  const db = await readDb();
  const { collection, id } = req.params;
  if (!Array.isArray(db[collection])) return res.status(404).json({ error: 'unknown collection' });
  // 许可状态只能由闭环接口流转；待办允许直接标记完成
  if (!GENERIC_WRITABLE.includes(collection) && !(collection === 'todos')) {
    return res.status(405).json({ error: `「${collection}」需通过闭环接口更新` });
  }
  const item = db[collection].find((entry) => entry.id === id);
  if (!item) return res.status(404).json({ error: 'not found' });
  const historyAction = req.body.historyAction;
  delete req.body.historyAction;
  Object.assign(item, req.body, { updatedAt: new Date().toISOString() });
  item.history = item.history || [];
  if (historyAction || req.body.note || req.body.memo || req.body.status) {
    item.history.unshift(stamp(historyAction || req.body.status || '更新', req.body.note || req.body.memo || ''));
  }
  await writeDb(db);
  res.json(item);
});

app.delete('/api/:collection/:id', async (req, res) => {
  const db = await readDb();
  const { collection, id } = req.params;
  if (!Array.isArray(db[collection])) return res.status(404).json({ error: 'unknown collection' });
  const before = db[collection].length;
  db[collection] = db[collection].filter((entry) => entry.id !== id);
  if (db[collection].length === before) return res.status(404).json({ error: 'not found' });
  await writeDb(db);
  res.status(204).end();
});

function findPermit(db, id) {
  return (db.permits || []).find((entry) => entry.id === id);
}

function makeTodo(db, fields) {
  const now = new Date().toISOString();
  return {
    id: nextId('todos'),
    permitId: fields.permitId,
    zone: fields.zone,
    team: fields.team,
    kind: fields.kind,
    detail: fields.detail,
    missing: fields.missing || [],
    status: '待处理',
    createdAt: now,
    updatedAt: now,
    history: [stamp(fields.kind, fields.detail)]
  };
}

// ① 进洞申请：规则全部通过才写库；拒绝时不留半张许可
app.post('/api/permit/apply', locked(async (req, res) => {
  const db = await readDb();
  const result = rules.validateApplication(db, req.body, new Date());
  if (result.error) return res.status(409).json({ error: result.error });
  if (result.reuse) {
    // 重复或并发申请沿用首次许可
    return res.json({ ...result.reuse, reused: true });
  }
  const now = new Date().toISOString();
  const permit = {
    id: nextId('permits'),
    ...result.data,
    members: undefined,
    confirmedExitAt: '',
    actualRoute: '',
    exitNote: '',
    createdAt: now,
    updatedAt: now,
    history: [
      stamp(
        '许可签发',
        `班组 ${result.data.team} 进入分区 ${result.data.zone}，预计出洞 ${result.data.expectedExitAt}`
      )
    ]
  };
  delete permit.members;
  db.permits.push(permit);
  await writeDb(db);
  res.status(201).json(permit);
}));

// ② 进洞确认
app.post('/api/permit/:id/enter', locked(async (req, res) => {
  const db = await readDb();
  const permit = findPermit(db, req.params.id);
  if (!permit) return res.status(404).json({ error: '许可不存在' });
  if (permit.status !== rules.STATUS.APPROVED) {
    return res.status(409).json({ error: `当前状态「${permit.status}」不能进洞确认` });
  }
  permit.status = rules.STATUS.INSIDE;
  permit.enteredAt = new Date().toISOString();
  permit.updatedAt = new Date().toISOString();
  permit.history.unshift(stamp('进洞确认', '全员在洞口点验后进洞'));
  await writeDb(db);
  res.json(permit);
}));

// ③ 提出延期（须重确认）与确认延期
app.post('/api/permit/:id/extend', locked(async (req, res) => {
  const db = await readDb();
  const permit = findPermit(db, req.params.id);
  if (!permit) return res.status(404).json({ error: '许可不存在' });
  const nextExit = String(req.body.expectedExitAt || '').trim();
  const check = rules.validateExtension(db, permit, nextExit, new Date());
  if (check.error) return res.status(409).json({ error: check.error });

  if (req.body.confirm) {
    const oldExit = permit.expectedExitAt;
    permit.expectedExitAt = check.expectedExitAt;
    permit.status = rules.STATUS.INSIDE;
    permit.updatedAt = new Date().toISOString();
    permit.history.unshift(stamp('延期已确认', `预计出洞时间 ${oldExit} 延长至 ${check.expectedExitAt}`));
  } else {
    permit.pendingExitAt = check.expectedExitAt;
    permit.status = rules.STATUS.EXTEND_PENDING;
    permit.updatedAt = new Date().toISOString();
    permit.history.unshift(stamp('申请延期待确认', `拟延长至 ${check.expectedExitAt}，须领队重确认`));
  }
  await writeDb(db);
  res.json(permit);
}));

// ④ 出洞核对：缺员或装备异常只生成搜索待办，不释放额度
app.post('/api/permit/:id/exit', locked(async (req, res) => {
  const db = await readDb();
  const permit = findPermit(db, req.params.id);
  if (!permit) return res.status(404).json({ error: '许可不存在' });
  if (!rules.isActive(permit)) return res.status(409).json({ error: `许可状态「${permit.status}」无需出洞核对` });
  if (!String(req.body.actualRoute || '').trim()) {
    return res.status(409).json({ error: '请填写实际路线，出洞须核对实际路线' });
  }

  const review = rules.reviewExit(permit, req.body);
  const now = new Date().toISOString();
  permit.actualRoute = review.actualRoute;
  permit.exitNote = [
    review.missing.length ? `缺员 ${review.missing.join('、')}` : '',
    review.unexpected.length ? `多出人员 ${review.unexpected.join('、')}` : '',
    review.equipmentAbnormal ? '装备异常' : '',
    req.body.equipmentNote || ''
  ].filter(Boolean).join('；');

  if (!review.canRelease) {
    // 只落搜索 / 装备待办，许可保持占用（逾期身份保留）
    for (const todo of review.todos) {
      db.todos.push(makeTodo(db, {
        ...todo,
        permitId: permit.id,
        zone: permit.zone,
        team: permit.team
      }));
    }
    permit.history.unshift(stamp(
      '出洞核对未通过',
      review.todos.map((todo) => todo.detail).join('；') || '实际出洞名单为空'
    ));
    permit.updatedAt = now;
    await writeDb(db);
    return res.status(202).json({
      released: false,
      permit,
      todos: db.todos.filter((todo) => todo.permitId === permit.id && todo.status === '待处理')
    });
  }

  permit.status = rules.STATUS.RELEASED;
  permit.releasedAt = now;
  permit.confirmedExitAt = now;
  permit.updatedAt = now;
  permit.history.unshift(stamp(
    '出洞释放',
    `全员 ${review.actual.join('、')} 已核对，实际路线 ${review.actualRoute}，额度释放`
  ));
  await writeDb(db);
  res.json({ released: true, permit });
}));

app.post('/api/action/:actionId/:id', async (req, res) => {
  const db = await readDb();
  const action = config.actions.find((entry) => entry.id === req.params.actionId);
  if (!action) return res.status(404).json({ error: 'unknown action' });
  const item = db[action.collection]?.find((entry) => entry.id === req.params.id);
  if (!item) return res.status(404).json({ error: 'not found' });
  const result = runAction(db, action, item);
  if (result.error) return res.status(409).json({ error: result.error });
  await writeDb(db);
  res.json(result.item);
});

function getValue(source, pathName) {
  return pathName.split('.').reduce((value, key) => value?.[key], source);
}

function setValue(target, pathName, value) {
  const keys = pathName.split('.');
  let cursor = target;
  while (keys.length > 1) {
    const key = keys.shift();
    cursor[key] = cursor[key] || {};
    cursor = cursor[key];
  }
  cursor[keys[0]] = value;
}

function findRelated(db, relation, item) {
  return db[relation.collection]?.find((entry) => entry.id === item[relation.localKey]);
}

function runAction(db, action, item) {
  const related = action.relation ? findRelated(db, action.relation, item) : null;
  const context = { item, related };
  const levelRank = { '低': 1, '中': 2, '高': 3 };
  for (const guard of action.guards || []) {
    const left = getValue(context, guard.left);
    const right = guard.rightPath ? getValue(context, guard.rightPath) : guard.right;
    if (guard.op === 'missing' && left) continue;
    if (guard.op === 'missing' && !left) return { error: guard.message };
    if (guard.op === 'eq' && left !== right) return { error: guard.message };
    if (guard.op === 'neq' && left === right) return { error: guard.message };
    if (guard.op === 'gte' && Number(left) < Number(right)) return { error: guard.message };
    if (guard.op === 'levelGte' && (levelRank[left] || 0) < (levelRank[right] || 0)) return { error: guard.message };
    if (guard.op === 'notIn' && guard.values.includes(left)) return { error: guard.message };
  }
  for (const patch of action.patches || []) {
    const target = patch.target === 'related' ? related : item;
    if (!target) continue;
    const next = patch.valuePath ? getValue(context, patch.valuePath) : patch.value;
    setValue(target, patch.field, next);
    target.updatedAt = new Date().toISOString();
    target.history = target.history || [];
    target.history.unshift(stamp(action.label, action.note || '状态流转'));
  }
  for (const delta of action.deltas || []) {
    const target = delta.target === 'related' ? related : item;
    if (!target) continue;
    const sourceAmount = delta.amountPath ? Number(getValue(context, delta.amountPath)) : 1;
    const multiplier = delta.amount === undefined ? 1 : Number(delta.amount);
    const amount = sourceAmount * multiplier;
    const current = Number(getValue({ target }, `target.${delta.field}`) || 0);
    setValue(target, delta.field, current + amount);
    target.updatedAt = new Date().toISOString();
    target.history = target.history || [];
    target.history.unshift(stamp(action.label, action.note || '数量调整'));
  }
  return { item };
}

app.listen(PORT, () => {
  console.log(`${config.title} running at http://localhost:${PORT}`);
});
