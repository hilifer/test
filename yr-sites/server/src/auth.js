// Staff accounts, roles and sessions for /admin.
// - Passwords: scrypt with per-user salt. Sessions: random token in an HttpOnly cookie, 12 h idle expiry.
// - Brute force: 5 failed logins per username or per IP → locked for 15 minutes.
// - Every request runs inside an AsyncLocalStorage context, so the events log records the real person.
// - HTTP Basic auth is still accepted (same users, same lockout) for scripts and monitoring.
import { AsyncLocalStorage } from 'node:async_hooks';
import { randomBytes, scryptSync, timingSafeEqual } from 'node:crypto';
import { db } from './db.js';
import { config } from './config.js';
import { migrate, addColumn } from './migrate.js';

// Permission catalogue. "x" also grants "x.view"; ".export", ".delete" etc. must be granted explicitly.
export const PERMISSIONS = {
  leads: ['线索：查看和处理', '销售'], 'leads.view': ['线索：只看', '销售'], 'leads.export': ['线索：导出', '销售'], 'leads.all': ['线索：查看全部、分配和设置目标（主管）', '销售'], chat: ['对话：查看和人工接待', '销售'],
  quotes: ['报价 / PI', '销售'], 'quotes.view': ['报价：只看', '销售'], contracts: ['合同：生成、作废', '销售'], 'contracts.view': ['合同：只看', '销售'],
  deals: ['AI 议价：审批', '销售'], 'deals.view': ['AI 议价：只看', '销售'], customers: ['客户档案', '销售'], 'customers.view': ['客户：只看', '销售'],
  orders: ['订单：处理', '订单与财务'], 'orders.view': ['订单：只看', '订单与财务'], payments: ['收款、退款、议价政策', '订单与财务'], 'shop.refund': ['网店退款', '订单与财务'],
  shipments: ['发货与物流', '仓库'], 'shop.fulfil': ['网店发货', '仓库'], rma: ['售后', '仓库'], inventory: ['SKU 与库存', '仓库'],
  catalog: ['商品：编辑、上下架', '商品与内容'], 'catalog.view': ['商品：只看', '商品与内容'], 'catalog.export': ['商品：导出', '商品与内容'], 'catalog.delete': ['商品：删除', '商品与内容'],
  content: ['内容与 GEO', '商品与内容'], marketing: ['优惠券与评价', '商品与内容'], settings: ['站点设置', '商品与内容'], shop: ['网店设置（运费、支付）', '商品与内容'], 'shop.view': ['网店：只看', '商品与内容'],
  assets: ['素材：上传、编辑、移动、删除到回收站', '素材'], 'assets.view': ['素材：只看', '素材'], 'assets.download': ['素材：下载原图', '素材'], 'assets.delete': ['素材：彻底删除（清空回收站）', '素材'],
  system: ['系统状态与备份', '系统'], audit: ['操作日志', '系统'], users: ['账号与岗位', '系统'],
};
// Built-in roles (kept in code so they stay current). Admins add their own roles in 账号权限 → 岗位.
export const ROLES = {
  admin: { zh: '管理员', perms: ['*'] },
  sales: { zh: '销售', perms: ['leads', 'leads.export', 'chat', 'quotes', 'orders', 'customers', 'catalog.view', 'shop.view', 'deals.view', 'contracts', 'assets.view', 'assets.download'] },
  sales_manager: { zh: '销售主管', perms: ['leads', 'leads.all', 'leads.export', 'chat', 'quotes', 'orders', 'customers', 'catalog.view', 'shop.view', 'deals.view', 'contracts', 'assets.view', 'assets.download'] },
  finance: { zh: '财务', perms: ['orders', 'payments', 'customers', 'shop.view', 'shop.refund', 'deals', 'contracts.view'] },
  warehouse: { zh: '仓库/物流', perms: ['orders.view', 'shipments', 'rma', 'inventory', 'catalog.view', 'shop.view', 'shop.fulfil'] },
  content: { zh: '内容运营', perms: ['content', 'catalog', 'catalog.export', 'catalog.delete', 'marketing', 'settings', 'assets', 'assets.download'] },
  service: { zh: '客服', perms: ['chat', 'leads.view', 'orders.view', 'customers.view', 'rma', 'shop.view'] },
  designer: { zh: '美工', perms: ['catalog', 'catalog.view', 'assets', 'assets.download', 'assets.delete'] },
  ops: { zh: '运维', perms: ['system', 'audit', 'orders.view', 'catalog.view'] },
};

// Path prefix → permission. First match wins; anything else under /admin needs "admin".
const RULES = [
  [/^\/admin\/?$/, 'leads'], [/^\/admin\/leads\.csv/, 'leads.export'], [/^\/admin\/sales\/(settings|targets)/, 'leads.all'], [/^\/admin\/sales/, 'leads'], [/^\/admin\/lead/, 'leads'], [/^\/admin\/(conversations|conv)/, 'chat'],
  [/^\/admin\/deals\/(policy|floors)/, 'payments'], [/^\/admin\/deals/, 'deals'],
  [/^\/admin\/contracts\/template/, 'admin'], [/^\/admin\/contracts/, 'contracts'], [/^\/admin\/quotes\/[^/]+\/contract/, 'contracts'],
  [/^\/admin\/quotes/, 'quotes'], [/^\/admin\/customers/, 'customers'],
  [/^\/admin\/orders\/[^/]+\/(payment|refund)/, 'payments'], [/^\/admin\/orders\/[^/]+\/(ship)/, 'shipments'], [/^\/admin\/orders/, 'orders'],
  [/^\/admin\/shipments/, 'shipments'], [/^\/admin\/rma/, 'rma'], [/^\/admin\/(skus|inventory)/, 'inventory'],
  [/^\/admin\/(content|geo)/, 'content'], [/^\/admin\/settings/, 'settings'],
  [/^\/admin\/copy/, 'catalog'], [/^\/admin\/products\/(export|template)\.csv/, 'catalog.export'], [/^\/admin\/products\/[^/]+\/delete/, 'catalog.delete'], [/^\/admin\/(products|categories|media)/, 'catalog'],
  [/^\/admin\/shop\/[^/]+\/refund/, 'shop.refund'], [/^\/admin\/shop\/[^/]+\/(fulfil|ship)/, 'shop.fulfil'], [/^\/admin\/shop/, 'shop'],
  [/^\/admin\/(coupons|reviews|marketing)/, 'marketing'], [/^\/admin\/dashboard/, 'orders'],
  [/^\/admin\/assets\/(file|bulk-download)/, 'assets.download'], [/^\/admin\/assets\/trash\/purge/, 'assets.delete'], [/^\/admin\/assets/, 'assets'],
  [/^\/admin\/system/, 'system'], [/^\/admin\/audit/, 'audit'], [/^\/admin\/(users|roles)/, 'users'],
  [/^\/admin\/(ops|me|logout|home|tasks)/, null], // any logged-in user
];

export function permissionFor(path, method = 'GET') {
  for (const [re, perm] of RULES) if (re.test(path)) return perm && method === 'GET' && !perm.includes('.') ? [perm, `${perm}.view`] : perm ? [perm] : [];
  return ['admin'];
}
/** All permissions of a user (union of their roles). */
export function permsOf(user) {
  const all = allRoles();
  return [...new Set(String(user?.role || '').split(',').filter(Boolean).flatMap((r) => all[r]?.perms || []))];
}
export function can(user, perms) {
  if (!user) return false;
  const have = permsOf(user);
  if (have.includes('*')) return true;
  if (!perms.length) return true;
  return perms.some((p) => have.includes(p) || (p.endsWith('.view') && have.includes(p.slice(0, -5))));
}
export const roleNames = (roleList) => String(roleList || '').split(',').filter(Boolean).map((r) => allRoles()[r]?.zh || r).join(' + ');

migrate([{
  id: '2026-10-20-staff-auth',
  up: () => db.exec(`
    CREATE TABLE staff (id INTEGER PRIMARY KEY AUTOINCREMENT, username TEXT UNIQUE, name TEXT, role TEXT, pw_hash TEXT,
      active INTEGER DEFAULT 1, created_at TEXT, last_login_at TEXT);
    CREATE TABLE staff_sessions (token TEXT PRIMARY KEY, staff_id INTEGER, created_at TEXT, last_seen INTEGER, ip TEXT);
    CREATE TABLE login_attempts (id INTEGER PRIMARY KEY AUTOINCREMENT, key TEXT, ts INTEGER, ok INTEGER);
    CREATE INDEX idx_login_attempts ON login_attempts(key, ts);`),
}, {
  id: '2026-10-28-staff-lang',
  up: () => addColumn('staff', 'lang', 'TEXT'),
}]);
migrate([{
  id: '2026-10-29-custom-roles',
  up: () => db.exec('CREATE TABLE roles (key TEXT PRIMARY KEY, name TEXT NOT NULL, perms TEXT NOT NULL, created_at TEXT, updated_at TEXT, updated_by TEXT)'),
}]);

// ---- roles: built-in (code) + custom (database), cached
let roleCache = null;
export function allRoles() {
  if (!roleCache) {
    const custom = Object.fromEntries(db.prepare('SELECT * FROM roles ORDER BY key').all().map((r) => [r.key, { zh: r.name, perms: JSON.parse(r.perms), custom: true }]));
    roleCache = { ...custom, ...ROLES }; // built-in keys cannot be overridden
  }
  return roleCache;
}
export function saveRole({ key, name, perms }, actor = 'admin') {
  const k = String(key || '').trim().toLowerCase();
  if (!/^[a-z][a-z0-9_-]{1,31}$/.test(k)) throw new Error('岗位编码：2–32 位小写字母、数字、横线或下划线，以字母开头');
  if (ROLES[k]) throw new Error('内置岗位不能修改，请新建一个岗位');
  if (!String(name || '').trim()) throw new Error('岗位名称必填');
  const list = [...new Set([].concat(perms || []).map(String))];
  const bad = list.filter((p) => !PERMISSIONS[p]);
  if (bad.length) throw new Error(`权限无效：${bad.join('、')}`);
  if (!list.length) throw new Error('请至少勾选一项权限');
  const t = new Date().toISOString();
  db.prepare('INSERT INTO roles (key, name, perms, created_at, updated_at, updated_by) VALUES (?,?,?,?,?,?) ON CONFLICT(key) DO UPDATE SET name = excluded.name, perms = excluded.perms, updated_at = excluded.updated_at, updated_by = excluded.updated_by')
    .run(k, String(name).trim().slice(0, 40), JSON.stringify(list), t, t, actor);
  roleCache = null;
  return k;
}
export function deleteRole(key) {
  if (ROLES[key]) throw new Error('内置岗位不能删除');
  const users = db.prepare("SELECT username FROM staff WHERE ',' || role || ',' LIKE ?").all(`%,${key},%`).map((u) => u.username);
  if (users.length) throw new Error(`还有账号在使用这个岗位：${users.join('、')}`);
  db.prepare('DELETE FROM roles WHERE key = ?').run(key);
  roleCache = null;
}

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
export const verifyPassword = (pw, stored) => checkPassword(pw, stored);
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

export const listStaff = () => db.prepare('SELECT id, username, name, role, active, lang, created_at, last_login_at FROM staff ORDER BY id').all();
/** System default admin language (系统设置), used for users who have not chosen one. */
export function defaultAdminLang() {
  try { const v = JSON.parse(db.prepare("SELECT value FROM settings WHERE key = 'admin_lang'").get()?.value || 'null'); return v === 'en' ? 'en' : 'zh'; } catch { return 'zh'; }
}
export const adminLang = (user, cookie) => (['zh', 'en'].includes(user?.lang) ? user.lang : ['zh', 'en'].includes(cookie) ? cookie : defaultAdminLang());
export function setStaffLang(id, lang) {
  if (!['zh', 'en'].includes(lang)) throw new Error('语言无效');
  db.prepare('UPDATE staff SET lang = ? WHERE id = ?').run(lang, id);
}
export const getStaff = (id) => db.prepare('SELECT id, username, name, role, active FROM staff WHERE id = ?').get(id);

export function saveStaff({ id, username, name, role, password, active }) {
  const roles = [...new Set([].concat(role || []).flatMap((r) => String(r).split(',')).map((r) => r.trim()).filter(Boolean))];
  if (!roles.length || roles.some((r) => !allRoles()[r])) throw new Error('角色无效');
  role = roles.join(',');
  if (id) {
    const u = getStaff(id);
    if (!u) throw new Error('账号不存在');
    if (u.username === config.adminUser && (!roles.includes('admin') || active === false)) throw new Error('初始管理员账号不能降级或停用');
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
  return { user: { id: u.id, username: u.username, name: u.name, role: u.role, lang: u.lang } };
}

export function createSession(user, ip) {
  const token = randomBytes(32).toString('base64url');
  db.prepare('INSERT INTO staff_sessions (token, staff_id, created_at, last_seen, ip) VALUES (?,?,?,?,?)').run(token, user.id, now(), Date.now(), ip);
  return token;
}
export function sessionUser(token) {
  if (!token) return null;
  const s = db.prepare('SELECT s.*, u.username, u.name, u.role, u.active, u.lang FROM staff_sessions s JOIN staff u ON u.id = s.staff_id WHERE s.token = ?').get(token);
  if (!s || !s.active || Date.now() - s.last_seen > SESSION_IDLE_MS) { if (s) db.prepare('DELETE FROM staff_sessions WHERE token = ?').run(token); return null; }
  db.prepare('UPDATE staff_sessions SET last_seen = ? WHERE token = ?').run(Date.now(), token);
  return { id: s.staff_id, username: s.username, name: s.name, role: s.role, lang: s.lang };
}
export const endSession = (token) => db.prepare('DELETE FROM staff_sessions WHERE token = ?').run(token || '');

// ---- request context: who is acting right now ----
const als = new AsyncLocalStorage();
export const runAs = (user, fn) => als.run({ user }, fn);
export const currentUser = () => als.getStore()?.user || null;
export const actorName = (fallback = 'system') => currentUser()?.username || fallback;
