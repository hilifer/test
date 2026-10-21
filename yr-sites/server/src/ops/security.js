// Ops: login records and online sessions (登录与会话), unusual-login alerts, configuration check (密钥与配置检查),
// restore drills (恢复演练) and the hourly watch for overdue backups.
import { db } from '../db.js';
import { config } from '../config.js';
import { migrate } from '../migrate.js';
import { alertOps } from '../alerts.js';
import { getSetting, setSetting } from '../catalog/store.js';
import { registerJob, every } from '../jobs.js';
import { listBackups, backupPath, backupRuns, verifyBackup, backupConfig } from './backup.js';

migrate([{
  id: '2026-11-04-restore-drills',
  up: () => db.exec('CREATE TABLE restore_drills (id INTEGER PRIMARY KEY AUTOINCREMENT, ts TEXT, file TEXT, ok INTEGER, detail TEXT, seconds REAL, by TEXT)'),
}]);
const now = () => new Date().toISOString();
const SESSION_IDLE_MS = 12 * 3600e3; // same as auth.js

// ---------------------------------------------------------------- logins & sessions
/** Per account: last login (time, IP), failed attempts in 24 h, online sessions. */
export function loginSummary() {
  const since = new Date(Date.now() - 24 * 3600e3).toISOString();
  return db.prepare('SELECT id, username, name, role, active, last_login_at FROM staff ORDER BY username').all().map((u) => {
    const last = db.prepare("SELECT ts, ip FROM audit_log WHERE username = ? AND action = 'login' ORDER BY id DESC LIMIT 1").get(u.username);
    return {
      ...u, last_ip: last?.ip || '', last_at: last?.ts || u.last_login_at,
      fails24h: db.prepare("SELECT COUNT(*) n FROM audit_log WHERE username = ? AND action = 'login_failed' AND ts >= ?").get(u.username, since).n,
      ips: db.prepare("SELECT COUNT(DISTINCT ip) n FROM audit_log WHERE username = ? AND action = 'login'").get(u.username).n,
      sessions: db.prepare('SELECT COUNT(*) n FROM staff_sessions WHERE staff_id = ? AND last_seen > ?').get(u.id, Date.now() - SESSION_IDLE_MS).n,
    };
  });
}
export function loginEvents({ user = '', result = '', limit = 200 } = {}) {
  const w = ["action IN ('login', 'login_failed', 'logout', 'kick')"], a = [];
  if (user) { w.push('username = ?'); a.push(user); }
  if (result === 'ok') w.push("action = 'login'"); else if (result === 'fail') w.push("action = 'login_failed'");
  return db.prepare(`SELECT ts, username, action, ip, message FROM audit_log WHERE ${w.join(' AND ')} ORDER BY id DESC LIMIT ?`).all(...a, limit);
}
export const onlineSessions = () => db.prepare('SELECT s.rowid AS sid, s.created_at, s.last_seen, s.ip, u.username, u.name, u.role FROM staff_sessions s JOIN staff u ON u.id = s.staff_id WHERE s.last_seen > ? ORDER BY s.last_seen DESC').all(Date.now() - SESSION_IDLE_MS);
/** Force a session to log out. Returns the username. */
export function kickSession(sid) {
  const s = db.prepare('SELECT s.rowid AS sid, u.username FROM staff_sessions s JOIN staff u ON u.id = s.staff_id WHERE s.rowid = ?').get(Number(sid));
  if (!s) throw new Error('会话不存在或已结束');
  db.prepare('DELETE FROM staff_sessions WHERE rowid = ?').run(s.sid);
  return s.username;
}
/**
 * Called on every staff login attempt, before it is written to the operation log. Alerts on a successful login from an
 * IP the account never used before (when it has logged in before), and when an account reaches 5 failures in 15 min.
 */
export function onLoginAttempt(username, ip, ok) {
  const u = String(username || '').toLowerCase();
  if (ok) {
    const before = db.prepare("SELECT COUNT(*) n, SUM(ip = ?) same FROM audit_log WHERE username = ? AND action = 'login'").get(ip, u);
    if (before.n > 0 && !before.same && getSetting('alert_new_ip', true)) alertOps('后台账号在新的 IP 登录', [`账号：${u}`, `IP：${ip}`, `如非本人操作，请到"系统 → 登录与会话"强制下线并重置密码`]).catch(() => {});
    return before.n > 0 && !before.same ? 'new_ip' : null;
  }
  const since = new Date(Date.now() - 15 * 60e3).toISOString();
  const fails = db.prepare("SELECT COUNT(*) n FROM audit_log WHERE username = ? AND action = 'login_failed' AND ts >= ?").get(u, since).n + 1;
  if (fails === 5) alertOps('后台登录多次失败', [`账号：${u}`, `IP：${ip}`, '15 分钟内失败 5 次，账号已临时锁定']).catch(() => {});
  return fails >= 5 ? 'locked' : null;
}

// ---------------------------------------------------------------- configuration check (values are never shown)
const set = (k) => Boolean(process.env[k]);
export const CONFIG_GROUPS = [
  ['基础', [['PUBLIC_BASE_URL', '网站地址，影响邮件和支付回跳链接', true], ['ADMIN_PASSWORD', '首个管理员的初始密码（上线后应修改并删除）', false], ['APP_VERSION', '版本号，显示在系统页和两站状态里', false]]],
  ['大模型', [['LLM_PROVIDER', 'AI 对话、AI 议价、AI 上架', false], ['LLM_API_KEY', '同上', false], ['LLM_MODEL', '同上', false], ['CONTENT_LLM_API_KEY', '内容智能体可单独用另一个模型', false], ['GEO_LLM_API_KEY', 'GEO 监测（最好是联网搜索型模型）', false]]],
  ['金蝶', [['ERP_MODE', 'kingdee / mock / local', false], ['KD_BASE_URL', '金蝶云星空地址', false], ['KD_ACCT_ID', '账套', false], ['KD_APP_ID', '第三方应用 ID', false], ['KD_APP_SECRET', '第三方应用密钥', false]]],
  ['收款', [['STRIPE_SECRET_KEY', '银行卡 / Apple Pay / Google Pay', false], ['STRIPE_WEBHOOK_SECRET', '没有它付款结果无法自动回传', false], ['PAYPAL_CLIENT_ID', 'PayPal', false], ['PAYPAL_CLIENT_SECRET', 'PayPal', false], ['PAYPAL_API_BASE', '未设置时为沙箱环境，正式收款必须设置为 https://api-m.paypal.com', false]]],
  ['物流与邮件', [['TRACK17_KEY', '17TRACK 自动物流轨迹', false], ['SMTP_URL', '订单、发货、找回密码等邮件；未配置时只记录不发送', false], ['MAIL_FROM', '发件人', false]]],
  ['提醒', [['WECOM_WEBHOOK_URL', '企业微信群机器人：线索、付款、错误、备份等提醒', false], ['FEISHU_WEBHOOK_URL', '飞书群机器人', false]]],
  ['备份与运维', [['BACKUP_CMD', '异地复制；不配置时备份和数据库在同一块磁盘上', false], ['PEER_SITES', '另一个站点的地址，用于两站状态', false], ['OPS_TOKEN', '两站之间读取运行状态用的口令（两边相同）', false]]],
  ['图片与内容', [['IMAGE_AI_KEY', 'AI 抠图 / 换背景', false], ['INDEXNOW_KEY', '发布后通知 Bing 等搜索引擎', false]]],
];
export function configCheck() {
  const groups = CONFIG_GROUPS.map(([name, items]) => ({ name, items: items.map(([key, impact, required]) => ({ key, impact, required, set: set(key) })) }));
  const warnings = [];
  if (!config.publicBaseUrl.startsWith('https://')) warnings.push('网站地址不是 https，客户付款和登录不安全');
  if (set('PAYPAL_CLIENT_ID') && !/api-m\.paypal\.com/.test(process.env.PAYPAL_API_BASE || '')) warnings.push('PayPal 仍在沙箱环境（PAYPAL_API_BASE 未设为正式地址），不能真实收款');
  if (set('STRIPE_SECRET_KEY') && /^sk_test_/.test(process.env.STRIPE_SECRET_KEY)) warnings.push('Stripe 使用的是测试密钥（sk_test_），不能真实收款');
  if (set('STRIPE_SECRET_KEY') && !set('STRIPE_WEBHOOK_SECRET')) warnings.push('配置了 Stripe 但没有 STRIPE_WEBHOOK_SECRET，付款结果无法自动回传');
  if (process.env.ADMIN_PASSWORD && db.prepare('SELECT COUNT(*) n FROM staff').get().n > 1) warnings.push('已有多个账号，建议从配置中删除 ADMIN_PASSWORD');
  if (!set('BACKUP_CMD')) warnings.push('没有配置异地备份（BACKUP_CMD）');
  if (process.env.PULL_ALLOW_PRIVATE === 'true') warnings.push('PULL_ALLOW_PRIVATE=true 只能用于测试，生产环境必须关闭');
  return { groups, warnings };
}

// ---------------------------------------------------------------- restore drills & backup watch
export async function restoreDrill(file, by = 'system') {
  const p = backupPath(file);
  if (!p || !listBackups().some((b) => b.file === file)) throw new Error('备份文件不存在');
  const t0 = Date.now();
  let ok = 0, detail;
  try { const v = await verifyBackup(p); ok = v.ok ? 1 : 0; detail = v; } catch (e) { detail = { error: e.message }; }
  db.prepare('INSERT INTO restore_drills (ts, file, ok, detail, seconds, by) VALUES (?,?,?,?,?,?)').run(now(), file, ok, JSON.stringify(detail), (Date.now() - t0) / 1000, by);
  return { ok: Boolean(ok), detail };
}
export const restoreDrills = (n = 20) => db.prepare('SELECT * FROM restore_drills ORDER BY id DESC LIMIT ?').all(n).map((r) => ({ ...r, detail: JSON.parse(r.detail || '{}') }));
export const DRILL_DAYS = 90;
export function drillOverdue() { const d = restoreDrills(1)[0]; return !d || !d.ok || Date.now() - Date.parse(d.ts) > DRILL_DAYS * 86400e3; }
export function backupOverdue() {
  if (!backupConfig().enabled) return false;
  const ok = backupRuns(50).find((r) => r.ok);
  return !ok || Date.now() - Date.parse(ok.ts) > 36 * 3600e3;
}
export function startOpsWatch() {
  registerJob({ id: 'ops-watch', name: '备份到期检查', schedule: every(3600e3, { initialDelay: 5 * 60e3 }), quiet: true, run: async () => {
    if (!backupOverdue()) return null;
    const last = getSetting('backup_overdue_alerted', '');
    if (last && Date.now() - Date.parse(last) < 12 * 3600e3) return null;
    setSetting('backup_overdue_alerted', now());
    await alertOps('超过 36 小时没有成功的数据库备份', ['请到"系统 → 系统状态"查看备份记录，或点"立即备份"']);
    return '已提醒';
  } });
}
