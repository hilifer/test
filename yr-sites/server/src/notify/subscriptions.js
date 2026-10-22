// Important events (重要事件提醒): every alert carries an event kind; each person chooses which events they want, and is
// @-mentioned in the WeCom group (by WeCom account or mobile number) and/or e-mailed. The administrator decides per event
// whether the group always gets it, only when someone subscribed, or never (then only e-mail). Every push is logged.
import { db } from '../db.js';
import { config } from '../config.js';
import { migrate } from '../migrate.js';
import { listStaff, can } from '../auth.js';
import { getSetting, setSetting } from '../catalog/store.js';
import { setAlertRouting, alertOps } from '../alerts.js';
import { sendMail } from '../shop/mailer.js';

migrate([{
  id: '2026-11-12-notify',
  up: () => db.exec(`CREATE TABLE notify_prefs (username TEXT PRIMARY KEY, events TEXT DEFAULT '[]', wecom_id TEXT, mobile TEXT, email TEXT, email_on INTEGER DEFAULT 0, updated_at TEXT);
    CREATE TABLE notify_log (id INTEGER PRIMARY KEY AUTOINCREMENT, ts TEXT, event TEXT, title TEXT, grouped INTEGER, mentioned TEXT, emailed TEXT);`),
}]);
const now = () => new Date().toISOString();
const J = (s, d) => { try { return JSON.parse(s); } catch { return d; } };

/** Event kinds: name, who may subscribe (permission; null = anyone), group. "to" in an alert narrows it to those people. */
export const EVENTS = {
  lead_a: { name: '新 A 级线索', perm: 'leads', group: '销售' }, lead_b: { name: '新 B 级线索', perm: 'leads', group: '销售' }, handoff: { name: '客户请求人工', perm: 'chat', group: '销售' },
  chat_waiting: { name: '客户等待回复（我接待的对话）', perm: 'chat', group: '客服' }, customer_mail: { name: '收到客户邮件', perm: 'chat', group: '客服' }, bad_rating: { name: '客户差评', perm: 'chat', group: '客服' }, rma_new: { name: '新售后申请', perm: 'rma', group: '客服' },
  payment: { name: '付款到账', perm: 'payments', group: '财务' }, payment_issue: { name: '付款异常（金额不符、取消后付款）', perm: 'payments', group: '财务' },
  shipment_exception: { name: '物流异常', perm: 'shipments', group: '仓库' }, approval: { name: '待我审批', perm: null, group: '管理' },
  backup_failed: { name: '备份失败', perm: 'system', group: '运维' }, service_down: { name: '外部服务异常', perm: 'system', group: '运维' }, server_error: { name: '服务器错误', perm: 'system', group: '运维' }, security: { name: '登录安全（新 IP、多次失败）', perm: 'system', group: '运维' },
};
export const GROUP_MODES = { all: '总是发到群里', subscribers: '有人订阅时才发到群里（并 @ 订阅的人）', off: '不发到群里（只发邮件）' };
export const groupModes = () => ({ ...Object.fromEntries(Object.keys(EVENTS).map((k) => [k, 'all'])), ...(getSetting('notify_group_modes', {}) || {}) });
export function saveGroupModes(input) {
  const out = groupModes();
  for (const [k, v] of Object.entries(input || {})) { if (!EVENTS[k]) continue; if (!GROUP_MODES[v]) throw new Error('群推送方式无效'); out[k] = v; }
  setSetting('notify_group_modes', out);
  return out;
}

export const allowedEvents = (user) => Object.entries(EVENTS).filter(([, e]) => !e.perm || can(user, [e.perm])).map(([k]) => k);
export function prefsOf(username) {
  const r = db.prepare('SELECT * FROM notify_prefs WHERE username = ?').get(username);
  return { username, events: J(r?.events, []), wecom_id: r?.wecom_id || '', mobile: r?.mobile || '', email: r?.email || '', email_on: Boolean(r?.email_on) };
}
export function savePrefs(user, { events = [], wecom_id = '', mobile = '', email = '', email_on = false }) {
  const allowed = new Set(allowedEvents(user));
  const ev = [...new Set([].concat(events).map(String))].filter((e) => allowed.has(e));
  const m = String(mobile || '').replace(/[\s-]/g, '');
  if (m && !/^\+?\d{6,15}$/.test(m)) throw new Error('手机号格式不正确');
  const w = String(wecom_id || '').trim();
  if (w && !/^[\w.@-]{1,64}$/.test(w)) throw new Error('企业微信账号只能包含字母、数字和 . _ - @');
  const e = String(email || '').trim();
  if (e && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(e)) throw new Error('邮箱格式不正确');
  if (email_on && !e) throw new Error('要接收邮件提醒，请填写邮箱');
  if (ev.length && !w && !m && !(email_on && e)) throw new Error('请至少填写企业微信账号、手机号或开启邮件提醒，否则收不到提醒');
  db.prepare(`INSERT INTO notify_prefs (username, events, wecom_id, mobile, email, email_on, updated_at) VALUES (?,?,?,?,?,?,?)
    ON CONFLICT(username) DO UPDATE SET events = excluded.events, wecom_id = excluded.wecom_id, mobile = excluded.mobile, email = excluded.email, email_on = excluded.email_on, updated_at = excluded.updated_at`)
    .run(user.username, JSON.stringify(ev), w || null, m || null, e || null, email_on ? 1 : 0, now());
  return prefsOf(user.username);
}

/** Active staff subscribed to an event (and allowed to see it), narrowed to `to` when given. */
export function subscribers(event, to = null) {
  const e = EVENTS[event];
  if (!e) return [];
  return listStaff().filter((u) => u.active).filter((u) => !to || to.includes(u.username)).filter((u) => !e.perm || can(u, [e.perm]))
    .map((u) => ({ user: u, prefs: prefsOf(u.username) })).filter((x) => x.prefs.events.includes(event));
}

/** The routing used by alerts.js for every alert with an event. */
export function routeEvent(event, { title = '', lines = [], to = null } = {}) {
  if (event === '_test') { // a test push to one person, whatever they subscribed to
    const p = prefsOf(to?.[0] || '');
    if (p.email_on && p.email) sendMail(p.email, `【${config.profile.brand}】${title}`, lines.join('\n')).catch(() => {});
    db.prepare('INSERT INTO notify_log (ts, event, title, grouped, mentioned, emailed) VALUES (?,?,?,?,?,?)').run(now(), event, String(title).slice(0, 200), 1, JSON.stringify(p.wecom_id || p.mobile ? [p.username] : []), JSON.stringify(p.email_on && p.email ? [p.username] : []));
    return { group: true, ids: p.wecom_id ? [p.wecom_id] : [], mobiles: !p.wecom_id && p.mobile ? [p.mobile] : [] };
  }
  if (!EVENTS[event]) return { group: true, ids: [], mobiles: [] };
  const mode = groupModes()[event];
  const subs = subscribers(event, to);
  const inGroup = mode !== 'off';
  const ids = inGroup ? subs.filter((s) => s.prefs.wecom_id).map((s) => s.prefs.wecom_id) : [];
  const mobiles = inGroup ? subs.filter((s) => !s.prefs.wecom_id && s.prefs.mobile).map((s) => s.prefs.mobile) : [];
  const mails = subs.filter((s) => s.prefs.email_on && s.prefs.email);
  const subject = `【${config.profile.brand}】${title}`;
  for (const s of mails) sendMail(s.prefs.email, subject, `${title}\n\n${lines.join('\n')}\n\n${config.publicBaseUrl}/admin/home\n\n— ${EVENTS[event].name}。在后台“修改密码 → 消息提醒”里可以修改。`).catch(() => {});
  const group = mode === 'all' || (mode === 'subscribers' && (ids.length + mobiles.length) > 0);
  db.prepare('INSERT INTO notify_log (ts, event, title, grouped, mentioned, emailed) VALUES (?,?,?,?,?,?)').run(now(), event, String(title).slice(0, 200), group ? 1 : 0,
    JSON.stringify(subs.filter((s) => inGroup && (s.prefs.wecom_id || s.prefs.mobile)).map((s) => s.user.username)), JSON.stringify(mails.map((s) => s.user.username)));
  return { group, ids, mobiles };
}
setAlertRouting(routeEvent);

export const recentLog = (limit = 50) => db.prepare('SELECT * FROM notify_log ORDER BY id DESC LIMIT ?').all(limit).map((r) => ({ ...r, mentioned: J(r.mentioned, []), emailed: J(r.emailed, []) }));
/** Who subscribed to what (for the administrator's overview). */
export const overview = () => Object.keys(EVENTS).map((k) => ({ event: k, ...EVENTS[k], mode: groupModes()[k], people: subscribers(k).map((s) => s.user.username) }));
/** A test push to oneself, through the same path as real events. */
export const sendTest = (user) => alertOps('测试提醒', [`这是发给 ${user.name || user.username} 的测试消息`], { event: '_test', to: [user.username] });
