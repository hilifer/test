// Scheduled jobs (定时任务): one place that runs every background job (backup, ERP sync, content writing, GEO check,
// tracking, cart reminders…), records each run, shows the next run time, and lets ops run a job now or pause it.
// Schedules: every(ms) or dailyAt(hour, { days, tz }) (days: 0=Sunday…6). A single 20-second tick decides what is due.
import { db } from './db.js';
import { migrate } from './migrate.js';
import { getSetting, setSetting } from './catalog/store.js';
import { actorName } from './auth.js';

migrate([{
  id: '2026-11-04-jobs',
  up: () => db.exec(`CREATE TABLE job_runs (id INTEGER PRIMARY KEY AUTOINCREMENT, job TEXT NOT NULL, ts TEXT, ok INTEGER, seconds REAL, detail TEXT, manual TEXT);
    CREATE INDEX job_runs_job ON job_runs(job, id);`),
}]);

const jobs = new Map();
const running = new Set();
const lastStart = new Map(); // in-memory: interval jobs count from process start
let onFailure = null;
const startedAt = Date.now();

/** Local date parts in a time zone. */
function parts(ms, tz) {
  const f = new Intl.DateTimeFormat('en-CA', { timeZone: tz || undefined, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', hour12: false, weekday: 'short' }).formatToParts(new Date(ms));
  const g = (t) => f.find((p) => p.type === t)?.value;
  return { date: `${g('year')}-${g('month')}-${g('day')}`, hour: Number(g('hour')) % 24, dow: ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'].indexOf(g('weekday')) };
}
export const every = (ms, { initialDelay = 0 } = {}) => ({ kind: 'every', ms, initialDelay });
export const dailyAt = (hour, { days = [0, 1, 2, 3, 4, 5, 6], tz = '' } = {}) => ({ kind: 'daily', hour, days, tz });

function lastRun(id) { return db.prepare('SELECT * FROM job_runs WHERE job = ? ORDER BY id DESC LIMIT 1').get(id) || null; }
function due(job, t) {
  const s = job.schedule;
  if (s.kind === 'every') {
    const last = lastStart.get(job.id);
    return last == null ? t - startedAt >= s.initialDelay : t - last >= s.ms;
  }
  const p = parts(t, s.tz);
  if (p.hour !== s.hour || !s.days.includes(p.dow)) return false;
  const lr = lastRun(job.id);
  return !(lr && !lr.manual && parts(Date.parse(lr.ts), s.tz).date === p.date);
}
/** Next scheduled run (ms) — for display. */
export function nextRun(job, t = Date.now()) {
  const s = job.schedule;
  if (s.kind === 'every') { const last = lastStart.get(job.id); return last == null ? startedAt + s.initialDelay : last + s.ms; }
  for (let h = 0; h <= 24 * 8; h++) {
    const m = (Math.floor(t / 3600e3) + h) * 3600e3; // each coming hour (time zones here are whole hours)
    const p = parts(m, s.tz);
    if (p.hour === s.hour && s.days.includes(p.dow) && (h > 0 || due(job, t))) return m;
  }
  return null;
}

/**
 * Register a job. run() may return a short summary (string or object); quiet jobs (every minute) only record runs that
 * did something or failed. enabled() lets a job be switched off by configuration (shown as "not configured").
 */
export function registerJob({ id, name, schedule, run, enabled = () => true, quiet = false, note = '' }) {
  jobs.set(id, { id, name, schedule, run, enabled, quiet, note });
}
export const pausedJobs = () => getSetting('jobs_paused', []);
export function setPaused(id, paused) {
  if (!jobs.has(id)) throw new Error('定时任务不存在');
  const p = new Set(pausedJobs());
  if (paused) p.add(id); else p.delete(id);
  setSetting('jobs_paused', [...p]);
}
export const onJobFailure = (fn) => { onFailure = fn; };

/** Run a job now (manual = who asked, or null for the schedule). */
export async function runJob(id, { manual = null } = {}) {
  const job = jobs.get(id);
  if (!job) throw new Error('定时任务不存在');
  if (running.has(id)) throw new Error('这个任务正在运行');
  running.add(id);
  lastStart.set(id, Date.now());
  const t0 = Date.now();
  let ok = 1, detail = null;
  try {
    const r = await job.run();
    detail = r == null ? null : typeof r === 'string' ? r : JSON.stringify(r);
  } catch (e) { ok = 0; detail = String(e?.message || e); }
  finally { running.delete(id); }
  const quietSkip = job.quiet && ok && !manual && (detail == null || detail === '0' || detail === '');
  if (!quietSkip) db.prepare('INSERT INTO job_runs (job, ts, ok, seconds, detail, manual) VALUES (?,?,?,?,?,?)').run(id, new Date(t0).toISOString(), ok, (Date.now() - t0) / 1000, detail?.slice(0, 1000) ?? null, manual);
  if (!ok && onFailure) Promise.resolve(onFailure(job, detail)).catch(() => {});
  return { ok: Boolean(ok), detail };
}

/** Everything for the jobs page. */
export function listJobs() {
  const paused = new Set(pausedJobs());
  return [...jobs.values()].map((j) => {
    const lr = lastRun(j.id);
    const lastFail = db.prepare('SELECT ts, detail FROM job_runs WHERE job = ? AND ok = 0 ORDER BY id DESC LIMIT 1').get(j.id) || null;
    return { id: j.id, name: j.name, note: j.note, schedule: j.schedule, enabled: Boolean(j.enabled()), paused: paused.has(j.id), running: running.has(j.id), last: lr, lastFail, next: j.enabled() && !paused.has(j.id) ? nextRun(j) : null };
  });
}
export const jobRuns = (id, n = 30) => db.prepare(`SELECT * FROM job_runs ${id ? 'WHERE job = ?' : ''} ORDER BY id DESC LIMIT ?`).all(...(id ? [id, n] : [n]));
export const describeSchedule = (s) => (s.kind === 'every' ? (s.ms >= 3600e3 ? `每 ${s.ms / 3600e3} 小时` : s.ms >= 60e3 ? `每 ${s.ms / 60e3} 分钟` : `每 ${s.ms / 1000} 秒`)
  : `${s.days.length === 7 ? '每天' : `每周 ${s.days.map((d) => DOW[d]).join('、')}`} ${s.hour}:00${s.tz ? `（${s.tz}）` : ''}`);
const DOW = ['周日', '周一', '周二', '周三', '周四', '周五', '周六'];

export function tick(t = Date.now()) {
  const paused = new Set(pausedJobs());
  for (const j of jobs.values()) {
    if (running.has(j.id) || paused.has(j.id) || !j.enabled()) continue;
    if (due(j, t)) runJob(j.id).catch(() => {});
  }
}
let timer = null;
export function startJobs() {
  if (timer) return;
  setImmediate(() => tick());
  timer = setInterval(() => tick(), 20e3);
  timer.unref();
}
export const jobActor = () => actorName('system');
