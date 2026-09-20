const express = require('express');
const path = require('path');

const config = require('./project.config');
const store = require('./lib/store');
const rules = require('./lib/permit-rules');

const app = express();
const PORT = process.env.PORT || config.port || 3900;

app.use(express.json({ limit: '2mb' }));
app.use(express.static(path.join(__dirname, 'public')));

function stamp(action, note) {
  return { at: new Date().toISOString(), action, note: note || '' };
}

function sortNewest(a, b) {
  return new Date(b.updatedAt || b.createdAt || 0) - new Date(a.updatedAt || a.createdAt || 0);
}

function ctx() {
  return {
    now: new Date(),
    nextId(collection) {
      return `${collection.replace(/s$/, '')}-${Date.now()}-${Math.random().toString(16).slice(2, 7)}`;
    }
  };
}

app.get('/api/config', (req, res) => {
  res.json(config);
});

app.get('/api/db', async (req, res, next) => {
  try {
    const db = await store.readDb();
    for (const key of Object.keys(db)) {
      if (Array.isArray(db[key])) db[key].sort(sortNewest);
    }
    res.json(db);
  } catch (error) {
    next(error);
  }
});

// 进洞调度看板：许可规则的所有派生状态（占用、逾期、待办）都在这里现算，页面不存业务状态。
app.get('/api/board/permits', async (req, res, next) => {
  try {
    const db = await store.readDb();
    res.json(rules.buildBoard(db, new Date()));
  } catch (error) {
    next(error);
  }
});

// ---- 进洞许可闭环（领域动作，规则全部来自 lib/permit-rules） ----

app.post('/api/permits/request', async (req, res, next) => {
  try {
    const result = await store.mutate((db) => rules.requestPermit(db, req.body || {}, ctx()));
    if (result.error) return res.status(409).json({ error: result.error });
    res.status(result.reused ? 200 : 201).json({ item: result.item, reused: Boolean(result.reused) });
  } catch (error) {
    next(error);
  }
});

app.post('/api/permits/:id/extend', async (req, res, next) => {
  try {
    const result = await store.mutate((db) =>
      rules.requestExtension(db, req.params.id, req.body?.plannedEnd, req.body?.reason, ctx()));
    if (result.error) return res.status(409).json({ error: result.error });
    res.json({ item: result.item });
  } catch (error) {
    next(error);
  }
});

app.post('/api/permits/:id/extend-confirm', async (req, res, next) => {
  try {
    const result = await store.mutate((db) => rules.confirmExtension(db, req.params.id, ctx()));
    if (result.error) return res.status(409).json({ error: result.error });
    res.json({ item: result.item });
  } catch (error) {
    next(error);
  }
});

app.post('/api/permits/:id/extend-cancel', async (req, res, next) => {
  try {
    const result = await store.mutate((db) => rules.cancelExtension(db, req.params.id, ctx()));
    if (result.error) return res.status(409).json({ error: result.error });
    res.json({ item: result.item });
  } catch (error) {
    next(error);
  }
});

app.post('/api/permits/:id/exit', async (req, res, next) => {
  try {
    const result = await store.mutate((db) =>
      rules.exitCheck(db, req.body || {}, { ...ctx(), permitId: req.params.id }));
    if (result.error) return res.status(409).json({ error: result.error });
    res.status(201).json({ item: result.item, releaseEligible: result.releaseEligible, todo: result.todo || null });
  } catch (error) {
    next(error);
  }
});

app.post('/api/permits/:id/release', async (req, res, next) => {
  try {
    const result = await store.mutate((db) => rules.releasePermit(db, req.params.id, ctx()));
    if (result.error) return res.status(409).json({ error: result.error });
    res.json({ item: result.item });
  } catch (error) {
    next(error);
  }
});

app.post('/api/todos/:id/resolve', async (req, res, next) => {
  try {
    const result = await store.mutate((db) => rules.resolveTodo(db, req.params.id, req.body?.resolution, ctx()));
    if (result.error) return res.status(409).json({ error: result.error });
    res.json({ item: result.item });
  } catch (error) {
    next(error);
  }
});

// ---- 通用集合接口：仅开放档案与巡测记录，许可与待办必须走领域动作 ----

const GENERIC_COLLECTIONS = ['sites', 'surveys'];

app.post('/api/:collection', async (req, res, next) => {
  try {
    const { collection } = req.params;
    if (!GENERIC_COLLECTIONS.includes(collection)) {
      return res.status(403).json({ error: `${collection} 只能通过进洞调度的专用操作变更` });
    }
    const item = await store.mutate((db) => {
      const now = new Date().toISOString();
      const created = {
        id: `${collection.replace(/s$/, '')}-${Date.now()}-${Math.random().toString(16).slice(2, 7)}`,
        ...req.body,
        createdAt: now,
        updatedAt: now,
        history: [stamp('创建', req.body.note || req.body.memo || '')]
      };
      db[collection].push(created);
      return created;
    });
    res.status(201).json(item);
  } catch (error) {
    next(error);
  }
});

app.patch('/api/:collection/:id', async (req, res, next) => {
  try {
    const { collection, id } = req.params;
    if (!GENERIC_COLLECTIONS.includes(collection)) {
      return res.status(403).json({ error: `${collection} 只能通过进洞调度的专用操作变更` });
    }
    const item = await store.mutate((db) => {
      const target = db[collection].find((entry) => entry.id === id);
      if (!target) return null;
      const historyAction = req.body.historyAction;
      const patch = { ...req.body };
      delete patch.historyAction;
      Object.assign(target, patch, { updatedAt: new Date().toISOString() });
      target.history = target.history || [];
      if (historyAction || patch.note || patch.memo || patch.status) {
        target.history.unshift(stamp(historyAction || patch.status || '更新', patch.note || patch.memo || ''));
      }
      return target;
    });
    if (!item) return res.status(404).json({ error: 'not found' });
    res.json(item);
  } catch (error) {
    next(error);
  }
});

app.delete('/api/:collection/:id', async (req, res, next) => {
  try {
    const { collection, id } = req.params;
    if (!GENERIC_COLLECTIONS.includes(collection)) {
      return res.status(403).json({ error: `${collection} 只能通过进洞调度的专用操作变更` });
    }
    const removed = await store.mutate((db) => {
      const before = db[collection].length;
      db[collection] = db[collection].filter((entry) => entry.id !== id);
      return db[collection].length !== before;
    });
    if (!removed) return res.status(404).json({ error: 'not found' });
    res.status(204).end();
  } catch (error) {
    next(error);
  }
});

app.post('/api/action/:actionId/:id', async (req, res, next) => {
  try {
    const action = config.actions.find((entry) => entry.id === req.params.actionId);
    if (!action) return res.status(404).json({ error: 'unknown action' });
    const result = await store.mutate((db) => {
      const item = db[action.collection]?.find((entry) => entry.id === req.params.id);
      if (!item) return { missing: true };
      return runAction(db, action, item);
    });
    if (result.missing) return res.status(404).json({ error: 'not found' });
    if (result.error) return res.status(409).json({ error: result.error });
    res.json(result.item);
  } catch (error) {
    next(error);
  }
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

app.use((error, req, res, next) => {
  console.error(error);
  res.status(500).json({ error: '服务端处理失败' });
});

app.listen(PORT, () => {
  console.log(`${config.title} running at http://localhost:${PORT}`);
});
