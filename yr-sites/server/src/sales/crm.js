// Sales CRM (业务): lead owners and automatic assignment (rules by country / product category, then round robin), the
// public pool (公海: unassigned leads and leads nobody followed up for N days, which anyone can claim), follow-up records
// with next follow-up dates, quote templates, "customer opened the PI / contract" tracking, customer tiers / tags /
// birthdays with holiday reminders, and sales performance with monthly targets.
import { createHash } from 'node:crypto';
import { db, leadHooks } from '../db.js';
import { config } from '../config.js';
import { migrate, addColumn } from '../migrate.js';
import { alertOps } from '../alerts.js';
import { getSetting, setSetting } from '../catalog/store.js';
import { registerJob, every } from '../jobs.js';
import { can, actorName } from '../auth.js';
import * as S from '../ops/service.js';

migrate([{
  id: '2026-11-05-crm',
  up: () => {
    for (const [c, t] of [['assigned_at', 'TEXT'], ['last_follow_at', 'TEXT'], ['next_follow_at', 'TEXT'], ['pooled_at', 'TEXT']]) addColumn('leads', c, t);
    for (const [c, t] of [['tier', 'TEXT'], ['vip', 'INTEGER DEFAULT 0'], ['tags', "TEXT DEFAULT '[]'"], ['birthday', 'TEXT'], ['owner', 'TEXT'], ['crm_notes', 'TEXT']]) addColumn('customers', c, t);
    addColumn('quotes', 'owner', 'TEXT');
    db.exec(`CREATE TABLE lead_followups (id INTEGER PRIMARY KEY AUTOINCREMENT, lead_id TEXT NOT NULL, ts TEXT, by TEXT, kind TEXT, content TEXT, next_at TEXT);
      CREATE INDEX lead_followups_lead ON lead_followups(lead_id, id);
      CREATE TABLE lead_log (id INTEGER PRIMARY KEY AUTOINCREMENT, lead_id TEXT NOT NULL, ts TEXT, by TEXT, action TEXT, note TEXT);
      CREATE TABLE quote_templates (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL, terms TEXT, lines TEXT, created_by TEXT, updated_at TEXT);
      CREATE TABLE link_views (id INTEGER PRIMARY KEY AUTOINCREMENT, kind TEXT, ref_id TEXT, ts TEXT, ip_hash TEXT, ua TEXT);
      CREATE INDEX link_views_ref ON link_views(kind, ref_id);
      CREATE TABLE sales_targets (username TEXT NOT NULL, month TEXT NOT NULL, amount REAL NOT NULL, PRIMARY KEY (username, month));`);
  },
}]);
const now = () => new Date().toISOString();
const J = (s, d) => { try { return JSON.parse(s); } catch { return d; } };
const OPEN = "('new','contacted','quoted')";

// ---------------------------------------------------------------- who can see what
/** Sales managers (permission leads.all) see every lead; others see their own and the pool. */
export const seesAllLeads = (user) => can(user, ['leads.all']);
/** Active accounts that work leads (for owner pickers and the round robin). */
export const salesPeople = () => db.prepare('SELECT username, name, role FROM staff WHERE active = 1 ORDER BY username').all().filter((u) => can(u, ['leads']));
const leadLog = (id, action, note = '', by = actorName('system')) => db.prepare('INSERT INTO lead_log (lead_id, ts, by, action, note) VALUES (?,?,?,?,?)').run(id, now(), by, action, String(note).slice(0, 300));
export const leadLogOf = (id) => db.prepare('SELECT * FROM lead_log WHERE lead_id = ? ORDER BY id DESC').all(id);
export const getLead = (id) => db.prepare('SELECT * FROM leads WHERE id = ?').get(id) || null;

/**
 * Leads list. scope: 'mine' | 'pool' | 'all' | 'due' (my follow-ups due). Non-managers only ever get their own + pool.
 */
export function listLeadsFor(user, { scope = 'mine', q = '', grade = '', status = '', owner = '', limit = 300 } = {}) {
  const w = [], a = [];
  const all = seesAllLeads(user);
  if (scope === 'pool') w.push('owner IS NULL');
  else if (scope === 'due') { w.push('owner = ? AND next_follow_at IS NOT NULL AND next_follow_at <= ?'); a.push(user.username, now()); }
  else if (scope === 'all' && all) { if (owner) { w.push('owner = ?'); a.push(owner); } }
  else if (scope === 'all') { w.push('(owner = ? OR owner IS NULL)'); a.push(user.username); }
  else { w.push('owner = ?'); a.push(user.username); }
  if (q) { w.push('(company LIKE ? OR name LIKE ? OR email LIKE ? OR country LIKE ? OR product_id LIKE ?)'); a.push(...Array(5).fill(`%${q}%`)); }
  if (grade) { w.push('grade = ?'); a.push(grade); }
  if (status) { w.push('status = ?'); a.push(status); }
  return db.prepare(`SELECT * FROM leads ${w.length ? `WHERE ${w.join(' AND ')}` : ''} ORDER BY created_at DESC LIMIT ?`).all(...a, limit);
}
export function canSeeLead(user, lead) { return Boolean(lead) && (seesAllLeads(user) || !lead.owner || lead.owner === user.username); }

// ---------------------------------------------------------------- assignment
export const assignSettings = () => ({ mode: 'round_robin', members: [], rules: [], poolDays: 7, ...(getSetting('crm_assign') || {}) });
export function saveAssignSettings({ mode, members, rules, poolDays }) {
  if (!['manual', 'round_robin'].includes(mode)) throw new Error('分配方式无效');
  const pd = Number(poolDays);
  if (!(Number.isInteger(pd) && pd >= 0 && pd <= 365)) throw new Error('回收天数须为 0–365 的整数（0 = 不回收）');
  const users = new Set(db.prepare('SELECT username FROM staff WHERE active = 1').all().map((u) => u.username));
  const m = [].concat(members || []).map(String).filter((u) => users.has(u));
  const rs = [].concat(rules || []).map((r) => ({ country: String(r.country || '').trim(), category: String(r.category || '').trim(), owner: String(r.owner || '').trim() })).filter((r) => r.owner && (r.country || r.category));
  for (const r of rs) if (!users.has(r.owner)) throw new Error(`账号 ${r.owner} 不存在或已停用`);
  setSetting('crm_assign', { mode, members: m, rules: rs, poolDays: pd });
}
const categoryOf = (productId) => config.catalog.products.find((p) => p.id === productId)?.category || '';
const listMatch = (list, v) => Boolean(v) && String(list).split(/[,，]/).map((x) => x.trim()).filter(Boolean).some((x) => x.toLowerCase() === String(v).trim().toLowerCase());
/** Pick an owner for a new lead: first matching rule, else the next person in the round robin, else nobody (pool). */
export function pickOwner(lead) {
  const s = assignSettings();
  if (s.mode === 'manual') return null;
  const cat = categoryOf(lead.product_id);
  for (const r of s.rules) if ((!r.country || listMatch(r.country, lead.country)) && (!r.category || listMatch(r.category, cat))) return { owner: r.owner, why: `规则：${[r.country && `国家 ${r.country}`, r.category && `品类 ${r.category}`].filter(Boolean).join('，')}` };
  if (!s.members.length) return null;
  const i = (Number(getSetting('crm_rr_index', -1)) + 1) % s.members.length;
  setSetting('crm_rr_index', i);
  return { owner: s.members[i], why: '轮流分配' };
}
/** Called right after a lead is created. */
export function assignNewLead(id) {
  const lead = getLead(id);
  if (!lead || lead.owner) return null;
  const p = pickOwner(lead);
  if (!p) { leadLog(id, 'pool', '未分配，进入公海', 'system'); return null; }
  db.prepare('UPDATE leads SET owner = ?, assigned_at = ? WHERE id = ?').run(p.owner, now(), id);
  leadLog(id, 'assign', `分配给 ${p.owner}（${p.why}）`, 'system');
  return p.owner;
}
export function transferLead(id, to, by = actorName('system')) {
  const lead = getLead(id);
  if (!lead) throw new Error('线索不存在');
  if (!db.prepare('SELECT 1 FROM staff WHERE username = ? AND active = 1').get(to)) throw new Error('目标账号不存在或已停用');
  if (lead.owner === to) throw new Error(`已经是 ${to} 的线索`);
  db.prepare('UPDATE leads SET owner = ?, assigned_at = ?, pooled_at = NULL WHERE id = ?').run(to, now(), id);
  leadLog(id, 'transfer', `${lead.owner || '公海'} → ${to}`, by);
}
export function claimLead(id, user) {
  const r = db.prepare('UPDATE leads SET owner = ?, assigned_at = ?, pooled_at = NULL WHERE id = ? AND owner IS NULL').run(user.username, now(), id);
  if (!r.changes) throw new Error('这条线索已被别人领取');
  leadLog(id, 'claim', `${user.username} 从公海领取`, user.username);
}
export function releaseLead(id, user, reason = '') {
  const lead = getLead(id);
  if (!lead) throw new Error('线索不存在');
  if (lead.owner !== user.username && !seesAllLeads(user)) throw new Error('只能放回自己的线索');
  db.prepare('UPDATE leads SET owner = NULL, pooled_at = ? WHERE id = ?').run(now(), id);
  leadLog(id, 'release', `放回公海${reason ? `：${reason}` : ''}`, user.username);
}
/** Leads with an owner but no follow-up for poolDays go back to the pool. Returns how many. */
export function recyclePool(t = Date.now()) {
  const days = assignSettings().poolDays;
  if (!days) return 0;
  const cutoff = new Date(t - days * 86400e3).toISOString();
  const rows = db.prepare(`SELECT id, owner FROM leads WHERE owner IS NOT NULL AND status IN ${OPEN} AND COALESCE(last_follow_at, assigned_at, created_at) < ?`).all(cutoff);
  for (const r of rows) {
    db.prepare('UPDATE leads SET owner = NULL, pooled_at = ? WHERE id = ?').run(now(), r.id);
    leadLog(r.id, 'recycle', `${r.owner} 超过 ${days} 天未跟进，自动回到公海`, 'system');
  }
  return rows.length;
}

// ---------------------------------------------------------------- follow-ups
export const FOLLOW_KINDS = { call: '电话', email: '邮件', whatsapp: 'WhatsApp', meeting: '见面 / 视频', note: '备注' };
export function addFollowup(id, { kind = 'note', content, nextAt = '' }, user) {
  const lead = getLead(id);
  if (!lead) throw new Error('线索不存在');
  if (!canSeeLead(user, lead)) throw new Error('无权跟进这条线索');
  if (!FOLLOW_KINDS[kind]) throw new Error('跟进方式无效');
  const text = String(content || '').trim();
  if (!text) throw new Error('请填写跟进内容');
  let next = null;
  if (nextAt) { const d = new Date(nextAt); if (Number.isNaN(d.getTime())) throw new Error('下次跟进时间无效'); next = d.toISOString(); }
  const ts = now();
  db.prepare('INSERT INTO lead_followups (lead_id, ts, by, kind, content, next_at) VALUES (?,?,?,?,?,?)').run(id, ts, user.username, kind, text.slice(0, 2000), next);
  db.prepare(`UPDATE leads SET last_follow_at = ?, next_follow_at = ?, status = CASE WHEN status = 'new' THEN 'contacted' ELSE status END, owner = COALESCE(owner, ?), assigned_at = COALESCE(assigned_at, ?) WHERE id = ?`).run(ts, next, user.username, ts, id);
}
export const followupsOf = (id) => db.prepare('SELECT * FROM lead_followups WHERE lead_id = ? ORDER BY id DESC').all(id);
export const dueFollowups = (username, t = now()) => db.prepare(`SELECT * FROM leads WHERE owner = ? AND next_follow_at IS NOT NULL AND next_follow_at <= ? AND status IN ${OPEN} ORDER BY next_follow_at`).all(username, t);

// ---------------------------------------------------------------- quote templates
export const listQuoteTemplates = () => db.prepare('SELECT * FROM quote_templates ORDER BY name').all().map((t) => ({ ...t, terms: J(t.terms, {}), lines: J(t.lines, []) }));
export function saveQuoteTemplate({ name, terms = {}, lines = [] }) {
  const n = String(name || '').trim();
  if (!n) throw new Error('模板名称必填');
  const keep = ['currency', 'incoterm', 'port', 'payment_terms', 'validity_days', 'notes'];
  const t = Object.fromEntries(keep.filter((k) => terms[k] != null && terms[k] !== '').map((k) => [k, terms[k]]));
  const ls = lines.filter((l) => l.sku).map((l) => ({ sku: String(l.sku), qty: Number(l.qty) || 1, variant: String(l.variant || '') }));
  const cur = db.prepare('SELECT id FROM quote_templates WHERE name = ?').get(n);
  if (cur) db.prepare('UPDATE quote_templates SET terms = ?, lines = ?, created_by = ?, updated_at = ? WHERE id = ?').run(JSON.stringify(t), JSON.stringify(ls), actorName('system'), now(), cur.id);
  else db.prepare('INSERT INTO quote_templates (name, terms, lines, created_by, updated_at) VALUES (?,?,?,?,?)').run(n.slice(0, 80), JSON.stringify(t), JSON.stringify(ls), actorName('system'), now());
}
export const deleteQuoteTemplate = (id) => db.prepare('DELETE FROM quote_templates WHERE id = ?').run(Number(id));
/** Bring a template into a quote: its terms, plus its products (added after existing lines, at reference prices). */
export function applyQuoteTemplate(quoteId, templateId) {
  const q = S.getQuote(quoteId);
  if (!q) throw new Error('报价不存在');
  if (!['draft', 'sent', 'expired'].includes(q.status)) throw new Error('这份报价已不能修改');
  const t = listQuoteTemplates().find((x) => x.id === Number(templateId));
  if (!t) throw new Error('模板不存在');
  const lines = [...q.lines.map(({ sku, variant, qty, unit_price }) => ({ sku, variant, qty, unit_price })), ...t.lines.map((l) => ({ sku: l.sku, variant: l.variant, qty: l.qty, unit_price: S.getSku(l.sku)?.ref_price ?? 0 }))];
  S.updateQuote(quoteId, { ...q, ...t.terms, lines });
  return { added: t.lines.length, name: t.name };
}

// ---------------------------------------------------------------- "customer opened the link"
/** Record that a customer opened a PI or contract link (staff previews are not counted). First open alerts the owner. */
export function recordView(kind, refId, { ip = '', ua = '' } = {}) {
  const first = !db.prepare('SELECT 1 FROM link_views WHERE kind = ? AND ref_id = ?').get(kind, refId);
  db.prepare('INSERT INTO link_views (kind, ref_id, ts, ip_hash, ua) VALUES (?,?,?,?,?)').run(kind, refId, now(), createHash('sha256').update(String(ip) + config.site).digest('hex').slice(0, 16), String(ua).slice(0, 200));
  if (first) {
    const q = kind === 'quote' ? S.getQuote(refId) : null;
    const k = kind === 'contract' ? db.prepare('SELECT number, quote_id FROM contracts WHERE id = ?').get(refId) : null;
    const quote = q || (k && S.getQuote(k.quote_id));
    const cust = quote && S.getCustomer(quote.customer_id);
    const owner = quote?.owner || (quote?.lead_id && getLead(quote.lead_id)?.owner) || '';
    alertOps(`客户打开了${kind === 'quote' ? '报价' : '合同'}`, [`${kind === 'quote' ? q.number : k?.number}`, cust ? `客户：${cust.company || cust.email}` : '', owner ? `负责人：${owner}` : '']).catch(() => {});
  }
}
export function viewsOf(kind, refId) {
  const r = db.prepare('SELECT COUNT(*) n, MIN(ts) first, MAX(ts) last FROM link_views WHERE kind = ? AND ref_id = ?').get(kind, refId);
  return { count: r.n, first: r.first, last: r.last };
}

// ---------------------------------------------------------------- customers: tiers, tags, birthdays, holidays
export const TIERS = { dealer: '经销商', contractor: '工程商', end_user: '终端客户', other: '其他' };
export function saveCustomerCrm(id, { tier = '', vip = false, tags = '', birthday = '', owner = '', notes = '' }) {
  if (tier && !TIERS[tier]) throw new Error('客户类型无效');
  const b = String(birthday || '').trim();
  if (b && !/^(0[1-9]|1[0-2])-(0[1-9]|[12]\d|3[01])$/.test(b)) throw new Error('生日格式为 月-日，如 03-18');
  if (owner && !db.prepare('SELECT 1 FROM staff WHERE username = ?').get(owner)) throw new Error('负责人账号不存在');
  const t = [...new Set(String(tags).split(/[,，]/).map((x) => x.trim()).filter(Boolean))].slice(0, 20);
  db.prepare('UPDATE customers SET tier = ?, vip = ?, tags = ?, birthday = ?, owner = ?, crm_notes = ? WHERE id = ?').run(tier || null, vip ? 1 : 0, JSON.stringify(t), b || null, owner || null, String(notes || '').slice(0, 2000), id);
}
export const customerTags = () => [...new Set(db.prepare('SELECT tags FROM customers').all().flatMap((r) => J(r.tags, [])))].sort();
export const DEFAULT_HOLIDAYS = [['01-01', '元旦'], ['12-25', '圣诞节']];
export const holidays = () => getSetting('crm_holidays', DEFAULT_HOLIDAYS);
export function saveHolidays(text) {
  const out = [];
  for (const line of String(text || '').split(/\r?\n/).map((l) => l.trim()).filter(Boolean)) {
    const m = line.match(/^(\d{2}-\d{2})\s+(.+)$/);
    if (!m || !/^(0[1-9]|1[0-2])-(0[1-9]|[12]\d|3[01])$/.test(m[1])) throw new Error(`格式应为"月-日 名称"：${line}`);
    out.push([m[1], m[2].slice(0, 40)]);
  }
  setSetting('crm_holidays', out);
}
/** Birthdays and holidays in the next `days` days (inclusive), for reminders. */
export function upcomingDates(days = 7, t = Date.now(), username = null) {
  const md = (ms) => new Date(ms).toISOString().slice(5, 10);
  const ahead = Array.from({ length: days + 1 }, (_, i) => [md(t + i * 86400e3), i]);
  const at = new Map(ahead);
  const cust = db.prepare(`SELECT id, company, contact, email, birthday, vip, owner FROM customers WHERE birthday IS NOT NULL ${username ? 'AND (owner = ? OR owner IS NULL)' : ''}`).all(...(username ? [username] : []));
  return [
    ...cust.filter((c) => at.has(c.birthday)).map((c) => ({ kind: 'birthday', in: at.get(c.birthday), date: c.birthday, customer: c })),
    ...holidays().filter(([d]) => at.has(d)).map(([d, name]) => ({ kind: 'holiday', in: at.get(d), date: d, name, vipCount: db.prepare('SELECT COUNT(*) n FROM customers WHERE vip = 1').get().n })),
  ].sort((a, b) => a.in - b.in);
}

// ---------------------------------------------------------------- performance & targets
export const monthOf = (iso) => String(iso || '').slice(0, 7);
export function setTarget(username, month, amount) {
  if (!/^\d{4}-\d{2}$/.test(month)) throw new Error('月份格式为 2026-11');
  const a = Number(amount);
  if (!(a >= 0)) throw new Error('目标金额须为不小于 0 的数字');
  if (!db.prepare('SELECT 1 FROM staff WHERE username = ?').get(username)) throw new Error('账号不存在');
  db.prepare('INSERT INTO sales_targets (username, month, amount) VALUES (?,?,?) ON CONFLICT(username, month) DO UPDATE SET amount = excluded.amount').run(username, month, a);
}
const ownerOfQuote = (q) => q.owner || (q.lead_id && getLead(q.lead_id)?.owner) || null;
/**
 * Per person per month: leads received, leads followed up, quotes, quote amount, won (accepted) quotes and amount,
 * payments received on their orders, target and completion; plus conversion rates.
 */
export function performance(months, { users = null } = {}) {
  const people = new Map();
  const row = (u, m) => {
    if (!people.has(u)) people.set(u, {});
    const p = people.get(u);
    return (p[m] ||= { leads: 0, followed: 0, quotes: 0, quoted: 0, won: 0, wonAmount: 0, received: 0, target: null });
  };
  const ms = new Set(months);
  for (const l of db.prepare('SELECT id, owner, assigned_at, created_at FROM leads WHERE owner IS NOT NULL').all()) { const m = monthOf(l.assigned_at || l.created_at); if (ms.has(m)) row(l.owner, m).leads++; }
  for (const f of db.prepare('SELECT DISTINCT lead_id, by, substr(ts, 1, 7) m FROM lead_followups').all()) if (ms.has(f.m)) row(f.by, f.m).followed++;
  for (const q of db.prepare("SELECT * FROM quotes WHERE status != 'draft' AND status != 'cancelled'").all()) {
    const u = ownerOfQuote(q);
    if (!u) continue;
    const m = monthOf(q.sent_at || q.created_at);
    if (ms.has(m)) { const r = row(u, m); r.quotes++; r.quoted += Number(q.total) || 0; }
    if (q.accepted_at && ms.has(monthOf(q.accepted_at))) { const r = row(u, monthOf(q.accepted_at)); r.won++; r.wonAmount += Number(q.total) || 0; }
  }
  for (const p of db.prepare('SELECT p.amount, p.ts, p.kind, o.quote_id FROM payments p JOIN orders o ON o.id = p.order_id').all()) {
    const q = p.quote_id && S.getQuote(p.quote_id);
    const u = q && ownerOfQuote(q);
    if (u && ms.has(monthOf(p.ts))) row(u, monthOf(p.ts)).received += (p.kind === 'refund' ? -1 : 1) * (Number(p.amount) || 0);
  }
  for (const t of db.prepare('SELECT * FROM sales_targets').all()) if (ms.has(t.month)) row(t.username, t.month).target = t.amount;
  const out = [...people.entries()].filter(([u]) => !users || users.includes(u)).map(([username, byMonth]) => ({ username, months: Object.fromEntries(months.map((m) => {
    const r = byMonth[m] || { leads: 0, followed: 0, quotes: 0, quoted: 0, won: 0, wonAmount: 0, received: 0, target: null };
    return [m, { ...r, leadToQuote: r.leads ? r.quotes / r.leads : null, quoteToWon: r.quotes ? r.won / r.quotes : null, completion: r.target ? r.wonAmount / r.target : null }];
  })) }));
  return out.sort((a, b) => a.username.localeCompare(b.username));
}
export const lastMonths = (n, t = Date.now()) => { const d = new Date(t); return Array.from({ length: n }, (_, i) => { const x = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() - (n - 1 - i), 1)); return x.toISOString().slice(0, 7); }); };

leadHooks.push(assignNewLead);
// a quote belongs to the lead's owner, or to whoever created it
S.hooks.quote.push((qid) => { const q = S.getQuote(qid); const owner = (q.lead_id && getLead(q.lead_id)?.owner) || (actorName('') || null); if (owner) db.prepare('UPDATE quotes SET owner = ? WHERE id = ?').run(owner, qid); });

export function startCrmJobs() {
  registerJob({ id: 'lead-pool', name: '超期未跟进线索回到公海', schedule: every(3600e3, { initialDelay: 10 * 60e3 }), quiet: true, run: () => String(recyclePool()) });
}
