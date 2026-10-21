// Global board (全局看板) for the administrator / boss: the key figures of every department on one page — sales, marketing,
// finance, logistics, customer service, system — plus each department's backlog. The other site's figures come from its
// /api/board (same OPS_TOKEN on both sites), so the page can show one site or both added together.
import { db } from '../db.js';
import { config } from '../config.js';
import { runAs } from '../auth.js';
import { receivables } from '../finance/finance.js';
import { funnel } from '../marketing/analytics.js';
import { readyToShip, lowStock } from '../warehouse/warehouse.js';
import { ratingSummary, inbox } from '../service/desk.js';
import { performance, lastMonths } from '../sales/crm.js';
import { errorStats } from '../ops/errors.js';
import { failingServices, peerSites } from '../ops/services.js';
import { backupRuns } from '../ops/backup.js';
import { boardTodos } from '../workbench.js';

const n = (sql, ...a) => db.prepare(sql).get(...a).n;
const v = (sql, ...a) => Math.round(Number(db.prepare(sql).get(...a).v || 0) * 100) / 100;
const since = (d) => new Date(Date.now() - d * 86400e3).toISOString();
const r2 = (x) => Math.round(x * 100) / 100;

/** This site's figures. Money is in the site's currency (cur). Backlog = to-dos per workbench board, as the administrator sees them. */
export function summary() {
  const cur = config.catalog.currency || 'USD';
  const month = new Date().toISOString().slice(0, 7);
  const perf = performance(lastMonths(1)).map((p) => p.months[month]);
  const target = perf.reduce((a, p) => a + (p.target || 0), 0);
  const won = r2(perf.reduce((a, p) => a + p.wonAmount, 0));
  const paid = "status NOT IN ('cancelled','pending_payment','awaiting_deposit')";
  const ar = receivables();
  const f = funnel(30);
  const box = inbox();
  const rate = ratingSummary(30);
  const backup = backupRuns(1)[0];
  const admin = { username: 'admin', name: 'admin', role: 'admin' };
  return {
    site: config.site, brand: config.profile.brand, cur, at: new Date().toISOString(),
    sales: { gmvMonth: v(`SELECT SUM(total) v FROM orders WHERE ${paid} AND substr(created_at, 1, 7) = ?`, month), ordersMonth: n(`SELECT COUNT(*) n FROM orders WHERE ${paid} AND substr(created_at, 1, 7) = ?`, month), newLeads7: n('SELECT COUNT(*) n FROM leads WHERE created_at >= ?', since(7)), gradeA7: n("SELECT COUNT(*) n FROM leads WHERE created_at >= ? AND grade = 'A'", since(7)), won, target, quotesOpen: n("SELECT COUNT(*) n FROM quotes WHERE status = 'sent'") },
    marketing: { visitors30: f.visitors, conversion: f.conversion, inquiryRate: f.inquiryRate, shopRevenue30: r2(f.revenue || 0), leads30: f.leads },
    finance: { receivable: r2(ar.reduce((a, r) => a + r.outstanding, 0)), overdue: r2(ar.filter((r) => r.overdueDays).reduce((a, r) => a + r.outstanding, 0)), receivedMonth: v('SELECT SUM(amount) v FROM payments WHERE substr(ts, 1, 7) = ?', month), refundsPending: n("SELECT COUNT(*) n FROM rmas WHERE status = 'approved' AND resolution = 'refund'") },
    logistics: { toShip: readyToShip().length, inTransit: n("SELECT COUNT(*) n FROM shipments WHERE status IN ('booked','in_transit','arrived')"), exceptions: n("SELECT COUNT(*) n FROM shipments WHERE status = 'exception'"), lowStock: lowStock().length },
    service: { waiting: box.filter((i) => i.channel === 'chat').length, openEmails: box.filter((i) => i.channel === 'email').length, rmaOpen: n("SELECT COUNT(*) n FROM rmas WHERE status IN ('submitted','reviewing')"), rating: rate.avg, ratings: rate.count },
    system: { errors24h: errorStats(24).distinct, failing: failingServices().length, backupOk: backup ? Boolean(backup.ok) : null, backupAt: backup?.ts || null },
    approvals: n("SELECT COUNT(*) n FROM approvals WHERE status = 'pending'"),
    backlog: runAs(admin, () => boardTodos()),
  };
}

/** The other sites' figures (needs PEER_SITES and the same OPS_TOKEN). Errors are returned per site, not thrown. */
export async function peerSummaries() {
  const token = process.env.OPS_TOKEN || '';
  return Promise.all(peerSites().map(async (p) => {
    try {
      const r = await fetch(`${p.url}/api/board`, { headers: { 'x-ops-token': token }, signal: AbortSignal.timeout(6000) });
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      return { name: p.name, url: p.url, data: await r.json() };
    } catch (e) { return { name: p.name, url: p.url, error: e.message }; }
  }));
}

const MONEY = { sales: ['gmvMonth', 'won', 'target'], marketing: ['shopRevenue30'], finance: ['receivable', 'overdue', 'receivedMonth'] };
/**
 * Several sites added together. Counts are summed; money is summed per currency ({ USD: 1200, CNY: 800 }); rates are
 * weighted (conversion by visitors, rating by number of ratings); backlog is summed per board.
 */
export function merge(list) {
  const out = { site: list.map((s) => s.site).join(' + '), brand: list.map((s) => s.brand).join(' + '), at: new Date().toISOString(), merged: true };
  for (const sec of ['sales', 'marketing', 'finance', 'logistics', 'service', 'system']) {
    out[sec] = {};
    for (const s of list) for (const [k, x] of Object.entries(s[sec] || {})) {
      if (MONEY[sec]?.includes(k)) { out[sec][k] ||= {}; out[sec][k][s.cur] = r2((out[sec][k][s.cur] || 0) + (Number(x) || 0)); } else if (typeof x === 'number' && !['conversion', 'inquiryRate', 'rating'].includes(k)) out[sec][k] = (out[sec][k] || 0) + x;
    }
  }
  const visitors = out.marketing.visitors30 || 0;
  out.marketing.conversion = visitors ? list.reduce((a, s) => a + (s.marketing.conversion || 0) * s.marketing.visitors30, 0) / visitors : null;
  out.marketing.inquiryRate = visitors ? list.reduce((a, s) => a + (s.marketing.inquiryRate || 0) * s.marketing.visitors30, 0) / visitors : null;
  const ratings = out.service.ratings || 0;
  out.service.rating = ratings ? Math.round((list.reduce((a, s) => a + (s.service.rating || 0) * s.service.ratings, 0) / ratings) * 10) / 10 : null;
  out.system.backupOk = list.every((s) => s.system.backupOk !== false) ? (list.some((s) => s.system.backupOk == null) ? null : true) : false;
  out.approvals = list.reduce((a, s) => a + (s.approvals || 0), 0);
  const bl = new Map();
  for (const s of list) for (const b of s.backlog || []) bl.set(b.title, (bl.get(b.title) || 0) + b.count);
  out.backlog = [...bl].map(([title, count]) => ({ title, count }));
  return out;
}
