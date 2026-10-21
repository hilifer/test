// Task center (任务中心): long-running batch jobs (batch image processing, size exports, AI work…) run here, one item at
// a time, in the background. Each task keeps per-item status, progress, a log, and can be paused, resumed, cancelled and
// have its failed items retried. Tasks survive a restart: anything left "running" is picked up again on startup.
import { randomUUID } from 'node:crypto';
import { db } from './db.js';
import { migrate } from './migrate.js';
import { actorName, runAs } from './auth.js';

migrate([{
  id: '2026-11-02-tasks',
  up: () => db.exec(`CREATE TABLE tasks (id TEXT PRIMARY KEY, kind TEXT NOT NULL, title TEXT, status TEXT NOT NULL, params TEXT, items TEXT NOT NULL,
    log TEXT NOT NULL DEFAULT '[]', created_by TEXT, created_at TEXT, updated_at TEXT, started_at TEXT, finished_at TEXT);
    CREATE INDEX tasks_status ON tasks(status, created_at);`),
}]);

export const STATUS = { queued: '排队中', running: '进行中', paused: '已暂停', done: '已完成', failed: '有失败', cancelled: '已取消' };
export const ITEM_STATUS = { queued: '等待', running: '处理中', done: '成功', failed: '失败', cancelled: '已取消' };
const handlers = new Map();
const now = () => new Date().toISOString();
const J = (s, d) => { try { return JSON.parse(s); } catch { return d; } };

/** kind → { label, run(key, params) → short result text, or { text, link } }. */
export function registerHandler(kind, { label, run }) { handlers.set(kind, { label, run }); }
export const handlerLabel = (kind) => handlers.get(kind)?.label || kind;

const row = (r) => r && { ...r, params: J(r.params, {}), items: J(r.items, []), log: J(r.log, []) };
export const getTask = (id) => row(db.prepare('SELECT * FROM tasks WHERE id = ?').get(id));
export function listTasks({ user = null, status = '', limit = 100 } = {}) {
  const w = [], a = [];
  if (user) { w.push('created_by = ?'); a.push(user); }
  if (status) { w.push('status = ?'); a.push(status); }
  return db.prepare(`SELECT * FROM tasks ${w.length ? `WHERE ${w.join(' AND ')}` : ''} ORDER BY created_at DESC LIMIT ?`).all(...a, limit).map(row);
}
export function progress(t) {
  const n = (s) => t.items.filter((i) => i.status === s).length;
  const done = n('done'), failed = n('failed');
  return { total: t.items.length, done, failed, finished: done + failed + n('cancelled'), pct: t.items.length ? Math.round(((done + failed) / t.items.length) * 100) : 100 };
}
function save(t, extra = {}) {
  Object.assign(t, extra, { updated_at: now() });
  db.prepare('UPDATE tasks SET status = ?, items = ?, log = ?, updated_at = ?, started_at = ?, finished_at = ? WHERE id = ?')
    .run(t.status, JSON.stringify(t.items), JSON.stringify(t.log.slice(-500)), t.updated_at, t.started_at || null, t.finished_at || null, t.id);
}
const log = (t, msg) => t.log.push({ ts: now(), msg: String(msg).slice(0, 400) });

/** items: [{ key, label }] — key is what the handler receives (e.g. an asset id). */
export function createTask({ kind, title, items, params = {} }) {
  if (!handlers.has(kind)) throw new Error('未知的任务类型');
  const list = [].concat(items || []).filter((i) => i && i.key).map((i) => ({ key: String(i.key), label: String(i.label || i.key).slice(0, 120), status: 'queued', error: null, result: null }));
  if (!list.length) throw new Error('没有要处理的内容');
  if (list.length > 2000) throw new Error('一次最多 2000 项');
  const id = randomUUID(), ts = now();
  db.prepare('INSERT INTO tasks (id, kind, title, status, params, items, log, created_by, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?,?,?)')
    .run(id, kind, String(title || handlerLabel(kind)).slice(0, 120), 'queued', JSON.stringify(params), JSON.stringify(list), JSON.stringify([{ ts, msg: `已创建，共 ${list.length} 项` }]), actorName('system'), ts, ts);
  kick();
  return id;
}

function control(id, from, to, msg) {
  const t = getTask(id);
  if (!t) throw new Error('任务不存在');
  if (!from.includes(t.status)) throw new Error(`当前状态（${STATUS[t.status]}）不能执行此操作`);
  if (to === 'cancelled') for (const i of t.items) if (i.status === 'queued') i.status = 'cancelled';
  log(t, `${msg}（${actorName('system')}）`);
  save(t, { status: to, ...(to === 'cancelled' ? { finished_at: now() } : {}) });
  if (to === 'queued') kick();
  return getTask(id);
}
export const pauseTask = (id) => control(id, ['queued', 'running'], 'paused', '已暂停');
export const resumeTask = (id) => control(id, ['paused'], 'queued', '已继续');
export const cancelTask = (id) => control(id, ['queued', 'running', 'paused'], 'cancelled', '已取消');
/** Retry the failed (and cancelled) items of a finished task. */
export function retryTask(id) {
  const t = getTask(id);
  if (!t) throw new Error('任务不存在');
  if (!['failed', 'cancelled', 'done'].includes(t.status)) throw new Error('任务还在进行中');
  const again = t.items.filter((i) => i.status === 'failed' || i.status === 'cancelled');
  if (!again.length) throw new Error('没有失败的项目需要重试');
  for (const i of again) Object.assign(i, { status: 'queued', error: null });
  log(t, `重试 ${again.length} 项（${actorName('system')}）`);
  save(t, { status: 'queued', finished_at: null });
  kick();
  return getTask(id);
}

// ---------------------------------------------------------------- worker: one task, one item at a time
let busy = null;
export const tasksIdle = () => !busy && !db.prepare("SELECT 1 FROM tasks WHERE status IN ('queued', 'running') LIMIT 1").get();
export function kick() { if (!busy) busy = loop().finally(() => { busy = null; }); return busy; }
async function loop() {
  await new Promise((r) => setImmediate(r)); // let the creating request finish first
  for (;;) {
    const next = row(db.prepare("SELECT * FROM tasks WHERE status IN ('running', 'queued') ORDER BY status = 'running' DESC, created_at LIMIT 1").get());
    if (!next) return;
    await runTask(next);
  }
}
async function runTask(t) {
  const h = handlers.get(t.kind);
  if (!h) { log(t, '未知的任务类型，已停止'); save(t, { status: 'failed', finished_at: now() }); return; }
  if (t.status !== 'running') { log(t, '开始处理'); save(t, { status: 'running', started_at: t.started_at || now() }); }
  for (let idx = 0; idx < t.items.length; idx++) {
    const cur = getTask(t.id); // re-read: pause / cancel may have happened between items
    if (cur.status !== 'running') return;
    const item = cur.items[idx];
    if (item.status === 'running') item.status = 'queued'; // interrupted by a restart
    if (item.status !== 'queued') continue;
    let res = null, err = null;
    try { res = await runAs({ username: cur.created_by || 'system' }, () => h.run(item.key, cur.params)); } catch (e) { err = e; }
    const fresh = getTask(t.id);
    Object.assign(fresh.items[idx], err ? { status: 'failed', error: String(err.message || err).slice(0, 300) } : { status: 'done', result: typeof res === 'string' ? res : res ?? null });
    if (err) log(fresh, `失败：${item.label} — ${err.message || err}`);
    save(fresh);
  }
  const end = getTask(t.id);
  if (end.status !== 'running') return;
  const p = progress(end);
  log(end, `结束：成功 ${p.done}，失败 ${p.failed}`);
  save(end, { status: p.failed ? 'failed' : 'done', finished_at: now() });
}

/** On startup: continue interrupted tasks. */
export function startTasks() { if (db.prepare("SELECT 1 FROM tasks WHERE status IN ('queued', 'running') LIMIT 1").get()) kick(); }
