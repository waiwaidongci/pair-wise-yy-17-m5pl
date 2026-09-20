const fs = require('fs/promises');
const path = require('path');

const DB_FILE = path.join(__dirname, '..', 'data', 'db.json');

const COLLECTIONS = ['sites', 'surveys', 'permits', 'todos'];

// 同一进程内把所有写操作串成队列，避免两个并发请求“读后写”交错。
let chain = Promise.resolve();

async function readDb() {
  const raw = await fs.readFile(DB_FILE, 'utf8');
  const db = JSON.parse(raw);
  for (const key of COLLECTIONS) {
    if (!Array.isArray(db[key])) db[key] = [];
  }
  return db;
}

async function writeDb(db) {
  await fs.writeFile(DB_FILE, JSON.stringify(db, null, 2) + '\n');
}

function withLock(task) {
  const run = chain.then(() => task());
  chain = run.catch(() => {});
  return run;
}

// 在同一个临界区内完成“读库 → 变更 → 写库”，task 只负责操作内存中的 db。
async function mutate(task) {
  return withLock(async () => {
    const db = await readDb();
    const result = await task(db);
    await writeDb(db);
    return result;
  });
}

module.exports = { DB_FILE, COLLECTIONS, readDb, writeDb, withLock, mutate };
