// Staff accounts, roles and sessions for /admin.
// - Passwords: scrypt with per-user salt. Sessions: random token in an HttpOnly cookie, 12 h idle expiry.
// - Brute force: 5 failed logins per username or per IP → locked for 15 minutes.
// - Every request runs inside an AsyncLocalStorage context, so the events log records the real person.
// - HTTP Basic auth is still accepted (same users, same lockout) for scripts and monitoring.
import { AsyncLocalStorage } from 'node:async_hooks';
import { randomBytes, scryptSync, timingSafeEqual } from 'node:crypto';
import { db } from './db.js';
import { config } from './config.js';
import { migrate } from './migrate.js';

export const ROLES = {
  admin: { zh: '管理员', perms: ['*'] },
  sales: { zh: '销售', perms: ['leads', 'quotes', 'orders', 'customers', 'catalog.view', 'shop.view'] },
  finance: { zh: '财务', perms: ['orders', 'payments', 'customers', 'shop.view', 'shop.refund'] },
  warehouse: { zh: '仓库/物流', perms: ['orders.view', 'shipments', 'rma', 'inventory', 'catalog.view', 'shop.view', 'shop.fulfil'] },
  content: { zh: '内容运营', perms: ['content', 'catalog', 'marketing', 'settings'] },
};

// Path prefix → permission. First match wins; anything else under /admin needs "admin".
const RULES = [
  [/^\/admin\/?$/, 'leads'], [/^\/admin\/(lead|conversations|conv|leads\.csv)/, 'leads'],
  [/^\/admin\/quotes/, 'quotes'], [/^\/admin\/customers/, 'customers'],
  [/^\/admin\/orders\/[^/]+\/payment/, 'payments'], [/^\/admin\/orders\/[^/]+\/(ship)/, 'shipments'], [/^\/admin\/orders/, 'orders'],
  [/^\/admin\/shipments/, 'shipments'], [/^\/admin\/rma/, 'rma'], [/^\/admin\/(skus|inventory)/, 'inventory'],
  [/^\/admin\/(content|geo)/, 'content'], [/^\/admin\/settings/, 'settings'], [/^\/admin\/(products|categories|media)/, 'catalog'],
  [/^\/admin\/shop\/[^/]+\/refund/, 'shop.refund'], [/^\/admin\/shop\/[^/]+\/(fulfil|ship)/, 'shop.fulfil'], [/^\/admin\/shop/, 'shop'],
  [/^\/admin\/(coupons|reviews|marketing)/, 'marketing'],
  [/^\/admin\/(ops|me|logout)/, null], // any logged-in user
];

export function permissionFor(path, method = 'GET') {
  for (const [re, perm] of RULES) if (re.test(path)) return perm && method === 'GET' && !perm.includes('.') ? [perm, `${perm}.view`] : perm ? [perm] : [];
  return ['admin'];
}
export function can(user, perms) {
  if (!user) return false;
  const have = ROLES[user.role]?.perms || [];
  if (have.includes('*')) return true;
  if (!perms.length) return true;
  return perms.some((p) => have.includes(p) || have.includes(p.split('.')[0]));
}

migrate([{
  id: '2026-10-20-staff-auth',
  up: () => db.exec(`
    CREATE TABLE staff (id INTEGER PRIMARY KEY AUTOINCREMENT, username TEXT UNIQUE, name TEXT, role TEXT, pw_hash TEXT,
      active INTEGER DEFAULT 1, created_at TEXT, last_login_at TEXT);
    CREATE TABLE staff_sessions (token TEXT PRIMARY KEY, staff_id INTEGER, created_at TEXT, last_seen INTEGER, ip TEXT);
    CREATE TABLE login_attempts (id INTEGER PRIMARY KEY AUTOINCREMENT, key TEXT, ts INTEGER, ok INTEGER);
    CREATE INDEX idx_login_attempts ON login_attempts(key, ts);`),
}]);

const now = () => new Date().toISOString();
const SESSION_IDLE_MS = 12 * 3600e3;
const LOCK_FAILS = 5;
const LOCK_MS = 15 * 60e3;

export function hashPassword(pw) {
  const salt = randomBytes(16);
  return `scrypt$${salt.toString('hex')}$${scryptSync(String(pw), salt, 32).toString('hex')}`;
}
function checkPassword(pw, stored) {
  const [, salt, hash] = String(stored || '').split('$');
  if (!salt || !hash) return false;
  const a = scryptSync(String(pw), Buffer.from(salt, 'hex'), 32);
  const b = Buffer.from(hash, 'hex');
  return a.length === b.length && timingSafeEqual(a, b);
}
export function passwordProblem(pw) {
  if (String(pw).length < 10) return '密码至少 10 位';
  if (!/[A-Za-z]/.test(pw) || !/\d/.test(pw)) return '密码需同时包含字母和数字';
  return null;
}

/** Bootstrap: the ADMIN_USER / ADMIN_PASSWORD from the environment is always an active admin. */
export function ensureBootstrapAdmin() {
  if (!config.adminPassword) return;
  const u = db.prepare('SELECT * FROM staff WHERE username = ?').get(config.adminUser);
  if (!u) db.prepare('INSERT INTO staff (username, name, role, pw_hash, created_at) VALUES (?,?,?,?,?)').run(config.adminUser, '管理员', 'admin', hashPassword(config.adminPassword), now());
  else if (!checkPassword(config.adminPassword, u.pw_hash) || u.role !== 'admin' || !u.active) db.prepare('UPDATE staff SET pw_hash = ?, role = ?, active = 1 WHERE id = ?').run(hashPassword(config.adminPassword), 'admin', u.id);
}

export const listStaff = () => db.prepare('SELECT id, username, name, role, active, created_at, last_login_at FROM staff ORDER BY id').all();
export const getStaff = (id) => db.prepare('SELECT id, username, name, role, active FROM staff WHERE id = ?').get(id);

export function saveStaff({ id, username, name, role, password, active }) {
  if (!ROLES[role]) throw new Error('角色无效');
  if (id) {
    const u = getStaff(id);
    if (!u) throw new Error('账号不存在');
    if (u.username === config.adminUser && (role !== 'admin' || active === false)) throw new Error('初始管理员账号不能降级或停用');
    if (password) { const p = passwordProblem(password); if (p) throw new Error(p); }
    db.prepare('UPDATE staff SET name = ?, role = ?, active = ?, pw_hash = COALESCE(?, pw_hash) WHERE id = ?').run(String(name || ''), role, active === false ? 0 : 1, password ? hashPassword(password) : null, id);
    if (active === false || password) db.prepare('DELETE FROM staff_sessions WHERE staff_id = ?').run(id);
    return getStaff(id);
  }
  if (!/^[a-z0-9._-]{3,32}$/.test(String(username || ''))) throw new Error('用户名：3–32 位小写字母、数字、点、横线或下划线');
  const p = passwordProblem(password || '');
  if (p) throw new Error(p);
  if (db.prepare('SELECT 1 FROM staff WHERE username = ?').get(username)) throw new Error(`用户名 ${username} 已存在`);
  const r = db.prepare('INSERT INTO staff (username, name, role, pw_hash, created_at) VALUES (?,?,?,?,?)').run(username, String(name || username), role, hashPassword(password), now());
  return getStaff(r.lastInsertRowid);
}

function lockedFor(key) {
  const since = Date.now() - LOCK_MS;
  const rows = db.prepare('SELECT ok, ts FROM login_attempts WHERE key = ? AND ts > ? ORDER BY id DESC').all(key, since);
  let fails = 0;
  for (const r of rows) { if (r.ok) break; fails++; }
  if (fails < LOCK_FAILS) return 0;
  return Math.max(0, rows[LOCK_FAILS - 1].ts + LOCK_MS - Date.now());
}
const record = (key, ok) => db.prepare('INSERT INTO login_attempts (key, ts, ok) VALUES (?,?,?)').run(key, Date.now(), ok ? 1 : 0);

/** Returns { user } or { error, lockedMs } */
export function verifyLogin(username, password, ip) {
  const keys = [`u:${String(username).toLowerCase()}`, `ip:${ip}`];
  const lock = Math.max(...keys.map(lockedFor));
  if (lock) return { error: `登录失败次数过多，请 ${Math.ceil(lock / 60000)} 分钟后再试`, lockedMs: lock };
  const u = db.prepare('SELECT * FROM staff WHERE username = ?').get(String(username).toLowerCase());
  const ok = Boolean(u && u.active && checkPassword(password, u.pw_hash));
  keys.forEach((k) => record(k, ok));
  if (!ok) return { error: '用户名或密码错误' };
  db.prepare('UPDATE staff SET last_login_at = ? WHERE id = ?').run(now(), u.id);
  return { user: { id: u.id, username: u.username, name: u.name, role: u.role } };
}

export function createSession(user, ip) {
  const token = randomBytes(32).toString('base64url');
  db.prepare('INSERT INTO staff_sessions (token, staff_id, created_at, last_seen, ip) VALUES (?,?,?,?,?)').run(token, user.id, now(), Date.now(), ip);
  return token;
}
export function sessionUser(token) {
  if (!token) return null;
  const s = db.prepare('SELECT s.*, u.username, u.name, u.role, u.active FROM staff_sessions s JOIN staff u ON u.id = s.staff_id WHERE s.token = ?').get(token);
  if (!s || !s.active || Date.now() - s.last_seen > SESSION_IDLE_MS) { if (s) db.prepare('DELETE FROM staff_sessions WHERE token = ?').run(token); return null; }
  db.prepare('UPDATE staff_sessions SET last_seen = ? WHERE token = ?').run(Date.now(), token);
  return { id: s.staff_id, username: s.username, name: s.name, role: s.role };
}
export const endSession = (token) => db.prepare('DELETE FROM staff_sessions WHERE token = ?').run(token || '');

// ---- request context: who is acting right now ----
const als = new AsyncLocalStorage();
export const runAs = (user, fn) => als.run({ user }, fn);
export const currentUser = () => als.getStore()?.user || null;
export const actorName = (fallback = 'system') => currentUser()?.username || fallback;
