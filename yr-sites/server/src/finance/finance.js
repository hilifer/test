// Finance (财务): receivables with ageing and overdue reminders, reconciliation of Stripe / PayPal / bank statements
// against the payments we recorded, monthly figures, and pushing receipts (收款单) to Kingdee.
import { db } from '../db.js';
import { config } from '../config.js';
import { migrate, addColumn } from '../migrate.js';
import { alertOps } from '../alerts.js';
import { getSetting, setSetting } from '../catalog/store.js';
import { registerJob, dailyAt, every } from '../jobs.js';
import * as S from '../ops/service.js';
import { adapter } from '../ops/erp/index.js';
import '../shop/schema.js'; // orders.channel / discount / shipping_fee

migrate([{
  id: '2026-11-08-finance',
  up: () => {
    for (const [c, t] of [['erp_bill_no', 'TEXT'], ['erp_error', 'TEXT']]) addColumn('payments', c, t);
    db.exec(`CREATE TABLE recon_runs (id INTEGER PRIMARY KEY AUTOINCREMENT, ts TEXT, source TEXT, period_from TEXT, period_to TEXT, matched INTEGER, issues INTEGER, detail TEXT, by TEXT);
      CREATE TABLE finance_log (id INTEGER PRIMARY KEY AUTOINCREMENT, ts TEXT, action TEXT, ok INTEGER, detail TEXT);`);
  },
}]);
const now = () => new Date().toISOString();
const r2 = (x) => Math.round(Number(x) * 100) / 100;
const days = (from, to = Date.now()) => Math.floor((to - Date.parse(from)) / 86400e3);
const log = (action, ok, detail) => db.prepare('INSERT INTO finance_log (ts, action, ok, detail) VALUES (?,?,?,?)').run(now(), action, ok ? 1 : 0, String(detail).slice(0, 1000));
export const financeLog = (n = 30) => db.prepare('SELECT * FROM finance_log ORDER BY id DESC LIMIT ?').all(n);

// ---------------------------------------------------------------- receivables
export const BUCKETS = [['0-30', 0, 30], ['31-60', 31, 60], ['61-90', 61, 90], ['90+', 91, Infinity]];
export const DEPOSIT_DAYS = () => Number(getSetting('deposit_due_days', 7));
const SHIPPED = ['shipped', 'delivered', 'completed'];
const shippedAt = (o) => db.prepare("SELECT ts FROM events WHERE entity = 'order' AND entity_id = ? AND to_state = 'shipped' ORDER BY id LIMIT 1").get(o.id)?.ts || null;
/**
 * When the open amount is due: the deposit within N days of the order; the balance before shipment (tt30 / tt100),
 * against the B/L copy (tt30bl, 7 days after shipping) or at shipment (L/C). Shop orders: by their payment deadline.
 */
export function dueDate(o) {
  if (o.channel === 'shop') return o.expires_at || o.created_at;
  const depositDue = Number(o.deposit_due) || 0;
  if (o.paid < depositDue - 0.01) return new Date(Date.parse(o.created_at) + DEPOSIT_DAYS() * 86400e3).toISOString();
  const shipped = shippedAt(o);
  if (o.payment_terms === 'tt30bl') return shipped ? new Date(Date.parse(shipped) + 7 * 86400e3).toISOString() : null;
  if (['tt30', 'tt100'].includes(o.payment_terms)) return ['ready_to_ship', ...SHIPPED].includes(o.status) ? (shipped || now()) : null;
  return shipped; // L/C and others: at shipment
}
/** Open receivables: every order (not cancelled) with money still to collect. */
export function receivables(t = Date.now()) {
  return S.listOrders("WHERE o.status != 'cancelled' AND o.paid < o.total - 0.01").map((o) => {
    const due = dueDate(o);
    const age = days(o.created_at, t);
    return { id: o.id, number: o.number, customer_id: o.customer_id, company: o.company || o.email, country: o.country, currency: o.currency, total: o.total, paid: o.paid, outstanding: r2(o.total - o.paid),
      status: o.status, channel: o.channel || 'b2b', created_at: o.created_at, due, overdueDays: due && Date.parse(due) < t ? days(due, t) : 0, age, bucket: BUCKETS.find(([, a, b]) => age >= a && age <= b)[0] };
  }).sort((a, b) => b.overdueDays - a.overdueDays || b.age - a.age);
}
export function receivablesByCustomer(rows = receivables()) {
  const m = new Map();
  for (const r of rows) {
    const c = m.get(r.customer_id) || { customer_id: r.customer_id, company: r.company, country: r.country, orders: 0, outstanding: 0, overdue: 0, oldest: 0, buckets: Object.fromEntries(BUCKETS.map(([k]) => [k, 0])) };
    c.orders++; c.outstanding = r2(c.outstanding + r.outstanding); c.buckets[r.bucket] = r2(c.buckets[r.bucket] + r.outstanding);
    if (r.overdueDays) c.overdue = r2(c.overdue + r.outstanding);
    c.oldest = Math.max(c.oldest, r.age);
    m.set(r.customer_id, c);
  }
  return [...m.values()].sort((a, b) => b.overdue - a.overdue || b.outstanding - a.outstanding);
}
/** Daily: alert finance about orders that became overdue since the last run (each order once). */
export function overdueReminder() {
  const seen = new Set(getSetting('overdue_alerted', []));
  const fresh = receivables().filter((r) => r.overdueDays > 0 && r.channel !== 'shop' && !seen.has(r.id));
  if (fresh.length) {
    alertOps(`${fresh.length} 笔应收款已逾期`, fresh.slice(0, 10).map((r) => `${r.number} · ${r.company} · ${r.currency} ${r.outstanding} · 逾期 ${r.overdueDays} 天`)).catch(() => {});
    setSetting('overdue_alerted', [...seen, ...fresh.map((r) => r.id)].slice(-2000));
  }
  return fresh.length;
}

// ---------------------------------------------------------------- reconciliation
const env = (k, d = '') => process.env[k] || d;
const cents = (x) => Math.round(Number(x) * 100);
/** Stripe balance transactions in the period (charges and refunds), with the payment intent of each charge. */
async function stripeTransactions(from, to) {
  const out = [];
  let after = '';
  for (let page = 0; page < 20; page++) {
    const q = new URLSearchParams({ limit: '100', 'created[gte]': String(Math.floor(Date.parse(from) / 1000)), 'created[lt]': String(Math.floor(Date.parse(to) / 1000) + 86400), 'expand[]': 'data.source' });
    if (after) q.set('starting_after', after);
    const r = await fetch(`${env('STRIPE_API_BASE', 'https://api.stripe.com')}/v1/balance_transactions?${q}`, { headers: { authorization: `Bearer ${env('STRIPE_SECRET_KEY')}` }, signal: AbortSignal.timeout(30000) });
    const j = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(`Stripe：HTTP ${r.status} ${j.error?.message || ''}`.trim());
    for (const t of j.data || []) {
      if (!['charge', 'payment', 'refund', 'payment_refund'].includes(t.type)) continue;
      const ref = t.source?.payment_intent || t.source?.id || t.source || t.id;
      out.push({ ref: String(ref), amount: t.amount / 100, currency: String(t.currency).toUpperCase(), date: new Date(t.created * 1000).toISOString(), kind: /refund/.test(t.type) ? 'refund' : 'payment', note: t.description || '' });
    }
    if (!j.has_more || !j.data?.length) break;
    after = j.data.at(-1).id;
  }
  return out;
}
/** PayPal transactions in the period (reporting API; ranges over 31 days are split). */
async function paypalTransactions(from, to) {
  const base = env('PAYPAL_API_BASE', 'https://api-m.sandbox.paypal.com');
  const tok = await fetch(`${base}/v1/oauth2/token`, { method: 'POST', body: 'grant_type=client_credentials', signal: AbortSignal.timeout(20000), headers: { authorization: 'Basic ' + Buffer.from(`${env('PAYPAL_CLIENT_ID')}:${env('PAYPAL_CLIENT_SECRET')}`).toString('base64'), 'content-type': 'application/x-www-form-urlencoded' } }).then((r) => r.json());
  if (!tok.access_token) throw new Error('PayPal：授权失败');
  const out = [];
  for (let s = Date.parse(from); s <= Date.parse(to); s += 31 * 86400e3) {
    const e = Math.min(s + 31 * 86400e3 - 1000, Date.parse(to) + 86400e3 - 1000);
    const q = new URLSearchParams({ start_date: new Date(s).toISOString().replace(/\.\d+Z$/, 'Z'), end_date: new Date(e).toISOString().replace(/\.\d+Z$/, 'Z'), fields: 'transaction_info', page_size: '500' });
    const r = await fetch(`${base}/v1/reporting/transactions?${q}`, { headers: { authorization: `Bearer ${tok.access_token}` }, signal: AbortSignal.timeout(30000) });
    const j = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(`PayPal：HTTP ${r.status} ${j.message || ''}`.trim());
    for (const d of j.transaction_details || []) {
      const t = d.transaction_info || {};
      const amount = Number(t.transaction_amount?.value);
      if (!t.transaction_id || !Number.isFinite(amount)) continue;
      out.push({ ref: t.transaction_id, amount, currency: t.transaction_amount.currency_code, date: t.transaction_initiation_date, kind: amount < 0 ? 'refund' : 'payment', note: t.transaction_event_code || '' });
    }
  }
  return out;
}
/** Bank or provider statement pasted as CSV: date, reference, amount, currency (header optional). */
export function parseStatement(text) {
  const rows = [], errors = [];
  for (const [i, line] of String(text || '').split(/\r?\n/).entries()) {
    const c = line.split(/[,\t;]/).map((x) => x.trim().replace(/^"|"$/g, ''));
    if (!c[0] || /^(date|日期)$/i.test(c[0])) continue;
    const amount = Number(String(c[2] || '').replace(/[^\d.-]/g, ''));
    if (Number.isNaN(Date.parse(c[0])) || !Number.isFinite(amount) || !c[2]) { errors.push(`第 ${i + 1} 行无法识别`); continue; }
    rows.push({ ref: c[1] || '', amount, currency: (c[3] || config.catalog.currency || 'USD').toUpperCase(), date: new Date(c[0]).toISOString(), kind: amount < 0 ? 'refund' : 'payment', note: c.slice(4).join(' ') });
  }
  return { rows, errors };
}
/**
 * Compare the source's transactions with our payments in the same period.
 * Stripe / PayPal match on the provider reference; a bank statement matches on the order number in the reference,
 * or on amount and date (±3 days). Returns matched, missingOurs (money we never recorded), missingSource (we recorded
 * money the source does not show), mismatched (same reference, different amount).
 */
export async function reconcile({ source, from, to, csv = '', by = 'system' }) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(from) || !/^\d{4}-\d{2}-\d{2}$/.test(to) || from > to) throw new Error('请选择正确的起止日期');
  let theirs, parseErrors = [];
  if (source === 'stripe') { if (!env('STRIPE_SECRET_KEY')) throw new Error('未配置 Stripe'); theirs = await stripeTransactions(from, to); }
  else if (source === 'paypal') { if (!env('PAYPAL_CLIENT_ID')) throw new Error('未配置 PayPal'); theirs = await paypalTransactions(from, to); }
  else if (source === 'bank') { const p = parseStatement(csv); theirs = p.rows; parseErrors = p.errors; if (!theirs.length) throw new Error('没有读到流水，请检查格式：日期, 摘要/附言, 金额, 币种'); }
  else throw new Error('对账来源无效');
  const inPeriod = db.prepare(`SELECT p.*, o.number FROM payments p JOIN orders o ON o.id = p.order_id WHERE substr(p.ts, 1, 10) >= ? AND substr(p.ts, 1, 10) <= ?`).all(from, to);
  const ours = source === 'bank' ? inPeriod.filter((p) => !/^(stripe|paypal) /.test(p.ref || '')) : inPeriod.filter((p) => (p.ref || '').startsWith(`${source} `));
  const refOf = (p) => String(p.ref || '').replace(/^(stripe|paypal) /, '');
  const used = new Set();
  const matched = [], missingOurs = [], mismatched = [];
  for (const t of theirs) {
    let hit;
    if (source === 'bank') {
      hit = ours.find((p) => !used.has(p.id) && t.ref && t.ref.toUpperCase().includes(p.number.toUpperCase()) && cents(p.amount) === cents(t.amount))
        || ours.find((p) => !used.has(p.id) && cents(p.amount) === cents(t.amount) && Math.abs(Date.parse(p.ts) - Date.parse(t.date)) <= 3 * 86400e3);
      if (!hit) { const byNumber = ours.find((p) => !used.has(p.id) && t.ref && t.ref.toUpperCase().includes(p.number.toUpperCase())); if (byNumber) { used.add(byNumber.id); mismatched.push({ theirs: t, ours: byNumber }); continue; } }
    } else {
      hit = ours.find((p) => !used.has(p.id) && refOf(p) === t.ref);
      if (hit && cents(hit.amount) !== cents(t.amount)) { used.add(hit.id); mismatched.push({ theirs: t, ours: hit }); continue; }
    }
    if (hit) { used.add(hit.id); matched.push({ theirs: t, ours: hit }); } else missingOurs.push(t);
  }
  const missingSource = ours.filter((p) => !used.has(p.id));
  const result = { source, from, to, matched, missingOurs, missingSource, mismatched, parseErrors, totals: { theirs: r2(theirs.reduce((a, t) => a + t.amount, 0)), ours: r2(ours.reduce((a, p) => a + p.amount, 0)) } };
  db.prepare('INSERT INTO recon_runs (ts, source, period_from, period_to, matched, issues, detail, by) VALUES (?,?,?,?,?,?,?,?)').run(now(), source, from, to, matched.length, missingOurs.length + missingSource.length + mismatched.length, JSON.stringify({ missingOurs, missingSource: missingSource.map((p) => ({ id: p.id, number: p.number, amount: p.amount, ref: p.ref, ts: p.ts })), mismatched, totals: result.totals }), by);
  return result;
}
export const reconRuns = (n = 20) => db.prepare('SELECT * FROM recon_runs ORDER BY id DESC LIMIT ?').all(n);

// ---------------------------------------------------------------- monthly report
/** Per month: orders and order value, money received (by method), refunds, discounts, shipping charged. */
export function monthlyReport(months) {
  const set = new Set(months);
  const out = Object.fromEntries(months.map((m) => [m, { month: m, orders: 0, orderValue: 0, received: 0, receivedOnline: 0, receivedTransfer: 0, refunds: 0, discounts: 0, shipping: 0 }]));
  for (const o of db.prepare("SELECT substr(created_at, 1, 7) m, total, COALESCE(discount, 0) discount, COALESCE(shipping_fee, 0) shipping FROM orders WHERE status != 'cancelled'").all()) {
    if (!set.has(o.m)) continue;
    const r = out[o.m]; r.orders++; r.orderValue = r2(r.orderValue + o.total); r.discounts = r2(r.discounts + o.discount); r.shipping = r2(r.shipping + o.shipping);
  }
  for (const q of db.prepare("SELECT substr(o.created_at, 1, 7) m, COALESCE(q.discount, 0) d, COALESCE(q.freight, 0) f FROM orders o JOIN quotes q ON q.id = o.quote_id WHERE o.status != 'cancelled'").all()) {
    if (!set.has(q.m)) continue;
    out[q.m].discounts = r2(out[q.m].discounts + q.d); out[q.m].shipping = r2(out[q.m].shipping + q.f);
  }
  for (const p of db.prepare('SELECT substr(ts, 1, 7) m, amount, kind, ref FROM payments').all()) {
    if (!set.has(p.m)) continue;
    const r = out[p.m];
    if (p.amount < 0) r.refunds = r2(r.refunds - p.amount);
    else { r.received = r2(r.received + p.amount); if (/^(stripe|paypal) /.test(p.ref || '') || p.kind === 'online') r.receivedOnline = r2(r.receivedOnline + p.amount); else r.receivedTransfer = r2(r.receivedTransfer + p.amount); }
  }
  return months.map((m) => ({ ...out[m], net: r2(out[m].received - out[m].refunds) }));
}

// ---------------------------------------------------------------- Kingdee receipts (收款单)
/** Push one payment to the ERP as a receipt. Refunds are left to the ERP's own refund process. */
export async function pushReceipt(paymentId) {
  const a = adapter();
  if (!a || !a.pushReceipt) return { skipped: true };
  const p = db.prepare('SELECT * FROM payments WHERE id = ?').get(Number(paymentId));
  if (!p) throw new Error('收款记录不存在');
  if (p.erp_bill_no) return { already: p.erp_bill_no };
  if (p.amount < 0) return { skipped: 'refund' };
  const o = S.getOrder(p.order_id);
  const c = S.getCustomer(o.customer_id);
  if (!c.erp_number) { const msg = '客户还没有同步到金蝶（先推送订单）'; db.prepare('UPDATE payments SET erp_error = ? WHERE id = ?').run(msg, p.id); return { error: msg }; }
  try {
    const bill = await a.pushReceipt({ ...p, order_number: o.number, erp_order: o.erp_bill_no }, c);
    db.prepare('UPDATE payments SET erp_bill_no = ?, erp_error = NULL WHERE id = ?').run(bill, p.id);
    log('push_receipt', true, `${o.number} ${p.currency} ${p.amount} → ${bill}`);
    return { bill };
  } catch (e) {
    db.prepare('UPDATE payments SET erp_error = ? WHERE id = ?').run(String(e.message).slice(0, 300), p.id);
    log('push_receipt', false, `${o.number}: ${e.message}`);
    return { error: e.message };
  }
}
export const unsyncedReceipts = () => db.prepare("SELECT p.*, o.number FROM payments p JOIN orders o ON o.id = p.order_id WHERE p.amount > 0 AND p.erp_bill_no IS NULL ORDER BY p.id DESC LIMIT 200").all();
// every payment recorded anywhere (admin, Stripe, PayPal) goes to the ERP when one is connected
S.hooks.payment.push((paymentId) => { if (adapter()?.pushReceipt) pushReceipt(paymentId).catch(() => {}); });

export function startFinanceJobs() {
  registerJob({ id: 'overdue-reminder', name: '应收逾期提醒', schedule: dailyAt(9), run: () => `${overdueReminder()} 笔新逾期` });
  registerJob({ id: 'erp-receipts', name: '收款单同步到金蝶（补推）', schedule: every(3600e3, { initialDelay: 15 * 60e3 }), enabled: () => Boolean(adapter()?.pushReceipt), quiet: true,
    run: async () => { let n = 0; for (const p of unsyncedReceipts().filter((x) => !x.erp_error || !/先推送订单/.test(x.erp_error)).slice(0, 50)) if ((await pushReceipt(p.id)).bill) n++; return String(n); } });
}
