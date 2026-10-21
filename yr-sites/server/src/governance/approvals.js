// Approval flows (审批流): the administrator decides which operations need approval — sending a quote whose discount is
// over a percentage, refunds over an amount, deleting a product — and who approves them. Staff who cannot approve get a
// request instead of the operation; once it is approved they do it again and it goes through (the approval is used up).
import { db } from '../db.js';
import { config } from '../config.js';
import { migrate } from '../migrate.js';
import { currentUser, can } from '../auth.js';
import { alertOps } from '../alerts.js';
import { getSetting, setSetting } from '../catalog/store.js';
import { onGate } from '../gate.js';

migrate([{
  id: '2026-11-11-approvals',
  up: () => db.exec(`CREATE TABLE approvals (id INTEGER PRIMARY KEY AUTOINCREMENT, kind TEXT NOT NULL, ref TEXT NOT NULL, label TEXT, amount REAL, currency TEXT, detail TEXT,
    status TEXT NOT NULL DEFAULT 'pending', requested_by TEXT, requested_at TEXT, decided_by TEXT, decided_at TEXT, note TEXT, used_at TEXT);
    CREATE INDEX approvals_status ON approvals(status, kind);`),
}]);
const now = () => new Date().toISOString();

export const KINDS = {
  quote_discount: { name: '报价折扣', what: '发送折扣超过比例的报价', param: 'percent', unit: '%', path: (ref) => `/admin/quotes/${ref}` },
  refund: { name: '退款', what: '退款金额超过', param: 'amount', unit: '', path: (ref) => `/admin/orders/${ref}` },
  product_delete: { name: '删除商品', what: '删除商品', param: null, unit: '', path: (ref) => `/admin/products/${encodeURIComponent(ref)}` },
};
export const APPROVERS = { admin: '管理员', 'leads.all': '销售主管', payments: '财务' };
export const STATUS = { pending: '待审批', approved: '已通过', rejected: '已驳回', used: '已执行', cancelled: '已撤回' };
const DEFAULTS = { quote_discount: { enabled: false, percent: 10, approver: 'leads.all' }, refund: { enabled: false, amount: 500, approver: 'admin' }, product_delete: { enabled: false, approver: 'admin' } };

export const rules = () => { const s = getSetting('approval_rules', {}); return Object.fromEntries(Object.keys(KINDS).map((k) => [k, { ...DEFAULTS[k], ...(s[k] || {}) }])); };
/** Changes the given rules (fields left out keep their current value). */
export function saveRules(input) {
  const out = {};
  const cur = rules();
  for (const [k, def] of Object.entries(KINDS)) {
    const r = { ...cur[k], ...(input[k] || {}) };
    const approver = r.approver;
    if (!APPROVERS[approver]) throw new Error('审批人无效');
    const rule = { enabled: Boolean(r.enabled), approver };
    if (def.param) {
      const v = r[def.param] === '' ? NaN : Number(r[def.param]);
      if (!(v >= 0) || (def.param === 'percent' && v > 100)) throw new Error(`${def.name}：${def.param === 'percent' ? '比例须在 0–100 之间' : '金额须不小于 0'}`);
      rule[def.param] = v;
    }
    out[k] = rule;
  }
  setSetting('approval_rules', out);
  return out;
}
export const canApprove = (user, kind) => can(user, [rules()[kind].approver]);
const triggered = (kind, rule, info) => (kind === 'quote_discount' ? info.percent > rule.percent + 1e-9 : kind === 'refund' ? info.amount > rule.amount + 1e-9 : true);

/**
 * The check run at each gate. Passes when the rule is off or not triggered, for people who may approve, outside a staff
 * request (customers, the AI, jobs), or with an approved request of the same person for this record (which is used up).
 * Otherwise files a request (once) and stops the operation with a message.
 */
export function check(kind, info) {
  const rule = rules()[kind];
  if (!rule?.enabled || !triggered(kind, rule, info)) return;
  const u = currentUser();
  if (!u || can(u, [rule.approver])) return;
  const ref = String(info.ref);
  const ok = db.prepare("SELECT id FROM approvals WHERE kind = ? AND ref = ? AND requested_by = ? AND status = 'approved' AND COALESCE(amount, 0) >= ? - 0.005 ORDER BY id DESC LIMIT 1").get(kind, ref, u.username, Number(info.amount) || 0);
  if (ok) { db.prepare("UPDATE approvals SET status = 'used', used_at = ? WHERE id = ?").run(now(), ok.id); return; }
  const who = APPROVERS[rule.approver];
  const pending = db.prepare("SELECT id FROM approvals WHERE kind = ? AND ref = ? AND requested_by = ? AND status = 'pending'").get(kind, ref, u.username);
  if (pending) throw Object.assign(new Error(`需要审批：${info.label} 已在等待审批（审批人：${who}，审批单 #${pending.id}）`), { approval: pending.id });
  const id = Number(db.prepare('INSERT INTO approvals (kind, ref, label, amount, currency, detail, requested_by, requested_at) VALUES (?,?,?,?,?,?,?,?)')
    .run(kind, ref, String(info.label || ref).slice(0, 200), info.amount == null ? null : Number(info.amount), info.currency || null, String(info.detail || '').slice(0, 500), u.username, now()).lastInsertRowid);
  alertOps(`待审批：${KINDS[kind].name}`, [`${info.label}${info.detail ? ` · ${info.detail}` : ''}`, `申请人：${u.name || u.username}`, `${config.publicBaseUrl}/admin/approvals`]).catch(() => {});
  throw Object.assign(new Error(`需要审批：已提交审批（审批人：${who}，审批单 #${id}），审批通过后请再操作一次`), { approval: id });
}
for (const k of Object.keys(KINDS)) onGate(k, (info) => check(k, info));

export const getApproval = (id) => db.prepare('SELECT * FROM approvals WHERE id = ?').get(Number(id));
export function decide(id, decision, user, note = '') {
  const a = getApproval(id);
  if (!a) throw new Error('审批单不存在');
  if (a.status !== 'pending') throw new Error(`审批单状态：${STATUS[a.status]}，不能再审批`);
  if (!canApprove(user, a.kind)) throw new Error(`没有审批权限（审批人：${APPROVERS[rules()[a.kind].approver]}）`);
  if (a.requested_by === user.username) throw new Error('不能审批自己的申请');
  if (!['approve', 'reject'].includes(decision)) throw new Error('请选择通过或驳回');
  db.prepare('UPDATE approvals SET status = ?, decided_by = ?, decided_at = ?, note = ? WHERE id = ?').run(decision === 'approve' ? 'approved' : 'rejected', user.username, now(), String(note || '').slice(0, 300), a.id);
  return getApproval(a.id);
}
export function cancel(id, user) {
  const a = getApproval(id);
  if (!a || a.requested_by !== user.username || a.status !== 'pending') throw new Error('只能撤回自己待审批的申请');
  db.prepare("UPDATE approvals SET status = 'cancelled', decided_at = ? WHERE id = ?").run(now(), a.id);
}
/** For a person: what waits for their decision, and their own requests. */
export function listFor(user, { status = '', limit = 200 } = {}) {
  const rows = db.prepare(`SELECT * FROM approvals ${status ? 'WHERE status = ?' : ''} ORDER BY id DESC LIMIT ?`).all(...(status ? [status] : []), limit);
  return rows.filter((a) => a.requested_by === user.username || canApprove(user, a.kind));
}
export const toDecide = (user) => db.prepare("SELECT * FROM approvals WHERE status = 'pending' ORDER BY id").all().filter((a) => a.requested_by !== user.username && canApprove(user, a.kind));
export const myApproved = (user) => db.prepare("SELECT * FROM approvals WHERE status IN ('approved', 'rejected') AND requested_by = ? AND decided_at >= ? ORDER BY id DESC").all(user.username, new Date(Date.now() - 7 * 86400e3).toISOString());
/** Approver for any rule that is on (decides whether the approvals board is shown). */
export const involved = (user) => Object.entries(rules()).some(([, r]) => r.enabled && can(user, [r.approver])) || db.prepare('SELECT 1 FROM approvals WHERE requested_by = ? LIMIT 1').get(user.username);
