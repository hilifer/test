// Black-box: finance over HTTP — roles, receivables with CSV, bank and Stripe reconciliation, monthly report, receipts to
// the (mock) ERP, commercial invoice and packing list, English UI. IDs FA-xx.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startServer, flash } from '../helpers/server.mjs';
import { mockServer } from '../helpers/mock-http.mjs';

let api, prov;
const ctx = {};
before(async () => {
  prov = await mockServer((call) => (call.url.startsWith('/v1/balance_transactions') ? { json: { has_more: false, data: (ctx.stripe || []).map((t) => ({ id: t.id, type: 'charge', amount: t.amount * 100, currency: 'usd', created: Math.floor(Date.now() / 1000), source: { id: `ch_${t.id}`, payment_intent: t.pi } })) } } : { status: 404 }));
  api = await startServer({ site: 'led', env: { ERP_MODE: 'mock', STRIPE_SECRET_KEY: 'sk_test_x', STRIPE_API_BASE: prov.url } });
  for (const [u, role] of [['fin', 'finance'], ['sam', 'sales'], ['wes', 'warehouse']]) await api.form('/admin/users/new', { username: u, role, password: PW });
});
after(async () => { await api.stop(); await prov.close(); });

const PW = 'Str0ngPassw0rd';
const auth = (u) => ({ authorization: 'Basic ' + Buffer.from(`${u}:${PW}`).toString('base64') });
const ADMIN = { authorization: 'Basic ' + Buffer.from('admin:test-pass').toString('base64') };
const form = (h, path, data) => fetch(api.url + path, { method: 'POST', redirect: 'manual', headers: { ...h, 'content-type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams(data) });
const page = async (path, h = auth('fin')) => (await fetch(api.url + path, { headers: h })).text();
/** Inquiry → PI → customer accepts online → order. */
async function newOrder(email) {
  await api.json('/api/leads', { email, company: `${email.split('@')[0]} Ltd`, product_id: 'YR-HB-U2', quantity: 100, consent: true });
  const lead = (await page(`/admin?scope=all&q=${encodeURIComponent(email)}`, ADMIN)).match(/\/admin\/lead\/([\w-]+)"/)[1];
  const q = flash(await fetch(`${api.url}/admin/quotes/new?lead=${lead}`, { headers: ADMIN, redirect: 'manual' })).path.split('/').pop();
  await form(ADMIN, `/admin/quotes/${q}/status`, { to: 'sent' });
  const token = (await page(`/admin/quotes/${q}`, ADMIN)).match(/\/portal\/pi\/([\w-]+)/)[1];
  await fetch(`${api.url}/portal/pi/${token}`, { method: 'POST', redirect: 'manual', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: '' });
  const html = await page(`/admin/orders`, ADMIN);
  const row = html.split('<tr>').find((r) => r.includes(email.split('@')[0]));
  return { id: row.match(/\/admin\/orders\/([\w-]+)/)[1], number: row.match(/<b>([^<]+)<\/b>/)[1] };
}

const FIN_PAGES = ['/admin/finance', '/admin/finance/reconcile', '/admin/finance/report'];
test('FA-01a roles: finance can open the receivables, reconciliation and report pages', async () => {
  ctx.o = await newOrder('alpha@buyer.test');
  for (const p of FIN_PAGES) assert.equal((await fetch(api.url + p, { headers: auth('fin') })).status, 200, p);
});
test('FA-01b roles: sales cannot open the finance pages (403)', async () => {
  for (const p of FIN_PAGES) assert.equal((await fetch(api.url + p, { headers: auth('sam') })).status, 403, p);
});
test('FA-01c roles: warehouse, sales and finance can print the packing list of an order', async () => {
  for (const u of ['wes', 'sam', 'fin']) assert.equal((await fetch(`${api.url}/admin/orders/${ctx.o.id}/packing-list`, { headers: auth(u) })).status, 200, u);
});
test('FA-01d the order page links to the commercial invoice and packing list', async () => {
  assert.match(await page(`/admin/orders/${ctx.o.id}`, ADMIN), /href="\/admin\/orders\/[\w-]+\/invoice"[^>]*>商业发票[\s\S]*packing-list[^>]*>装箱单/);
});

test('FA-02a receivables: the new order is outstanding with "deposit due" and its due date', async () => {
  const html = await page('/admin/finance');
  assert.match(html, new RegExp(`<b>${ctx.o.number}</b>[\\s\\S]*?待付定金[\\s\\S]*?\\d{4}/\\d{1,2}/\\d{1,2}`));
});
test('FA-02b receivables: the by-customer view lists the customer', async () => {
  const html = await page('/admin/finance');
  assert.match(html, /alpha Ltd/);
});
test('FA-02c receivables: the total receivable is shown in USD', async () => {
  const html = await page('/admin/finance');
  assert.match(html, /<span>应收合计<\/span><strong[^>]*>USD [\d,]+\.\d{2}<\/strong>/);
});
test('FA-02d the receivables CSV has headers in the admin language and the order row', async () => {
  const csv = (await (await fetch(`${api.url}/admin/finance/receivables.csv`, { headers: auth('fin') })).text()).replace(/^﻿/, '');
  assert.match(csv, new RegExp(`^订单,客户,币种,订单金额,已收,未收,到期日,逾期天数,账龄（天）\\r\\n${ctx.o.number},alpha Ltd,USD,`));
});
test('FA-02e finance settings reject a deposit term outside 1–90 days', async () => {
  assert.match(flash(await form(auth('fin'), '/admin/finance/settings', { deposit_days: '0' })).err, /1–90/);
});

const today = () => new Date().toISOString().slice(0, 10);
const weekAgo = () => new Date(Date.now() - 7 * 86400e3).toISOString().slice(0, 10);
test('FA-03a bank reconciliation: a recorded transfer matches the statement line by order number', async () => {
  assert.equal((await form(auth('fin'), `/admin/orders/${ctx.o.id}/payment`, { kind: 'deposit', amount: '500', ref: 'TT ref 1' })).status, 302);
  const r = await form(auth('fin'), '/admin/finance/reconcile', { source: 'bank', from: weekAgo(), to: today(), csv: `${today()}, ${ctx.o.number} DEPOSIT, 500, USD\n${today()}, WIRE UNKNOWN, 777, USD` });
  const html = ctx.bank = await r.text();
  assert.match(html, /<span>对上<\/span><strong>1<\/strong>/);
});
test('FA-03b bank reconciliation: an unknown credit is flagged as possibly unrecorded', async () => {
  assert.match(ctx.bank, /对方有、我们没记（可能漏登记收款）[\s\S]*WIRE UNKNOWN · USD 777/);
});
test('FA-03c the reconciliation run is logged with source, matched / unmatched counts and user', async () => {
  assert.match(await page('/admin/finance/reconcile'), /银行流水（粘贴）<\/td><td>[^<]+<\/td><td class="n">1<\/td><td class="n" style="color:#c62828;font-weight:700">1<\/td><td>fin<\/td>/);
});
test('FA-03d a bank statement without readable lines is rejected (400)', async () => {
  const bad = await form(auth('fin'), '/admin/finance/reconcile', { source: 'bank', from: weekAgo(), to: today(), csv: 'nothing useful' });
  assert.equal(bad.status, 400);
  assert.match(await bad.text(), /没有读到流水/);
});

test('FA-04a Stripe reconciliation reads the provider and matches a recorded payment by payment intent', async () => {
  const o = await newOrder('beta@buyer.test');
  await form(auth('fin'), `/admin/orders/${o.id}/payment`, { kind: 'deposit', amount: '120', ref: 'stripe pi_A' });
  ctx.stripe = [{ id: 'bt1', pi: 'pi_A', amount: 120 }, { id: 'bt2', pi: 'pi_B', amount: 33 }];
  const today = new Date().toISOString().slice(0, 10);
  const html = ctx.stripeHtml = await (await form(auth('fin'), '/admin/finance/reconcile', { source: 'stripe', from: today, to: today })).text();
  assert.match(html, /<span>对上<\/span><strong>1<\/strong>/);
});
test('FA-04b Stripe reconciliation flags a Stripe charge that has no recorded payment', async () => {
  assert.match(ctx.stripeHtml, /pi_B · USD 33/);
});

test('FA-05a the monthly report shows money received this month split into online and bank transfer', async () => {
  const html = await page('/admin/finance/report');
  const month = new Date().toISOString().slice(0, 7);
  assert.match(html, new RegExp(`<td>${month}</td><td class="n">\\d+</td><td class="n">USD [\\d,.]+</td><td class="n">USD 620\\.00</td><td class="n">USD 120\\.00</td><td class="n">USD 500\\.00</td>`));
});
test('FA-05b all recorded payments are synced to the mock ERP as receipts', async () => {
  const html = await page('/admin/finance/report');
  // mock ERP: accepting the PI pushed the customer and the order, so each recorded payment became a receipt right away
  assert.match(html, /收款单同步金蝶[\s\S]*全部已同步/);
});
test('FA-05c the report lists the ERP receipt number for the order payment', async () => {
  const html = await page('/admin/finance/report');
  assert.match(html, new RegExp(`${ctx.o.number} USD 500 → SKD\\d+`));
});
test('FA-05d the report CSV in English has the English header row', async () => {
  const csv = (await (await fetch(`${api.url}/admin/finance/report.csv`, { headers: { ...auth('fin'), cookie: 'yr_admin_lang=en' } })).text()).replace(/^﻿/, '');
  assert.match(csv, /^Month,Orders,Order value,Received,Online,Bank transfer,Refunds,Net received,Discounts,Shipping\r\n/);
});

test('FA-06a the commercial invoice shows the order number, items and amount paid', async () => {
  const ci = await page(`/admin/orders/${ctx.o.id}/invoice`);
  assert.match(ci, /Commercial Invoice/);
  assert.match(ci, new RegExp(ctx.o.number));
  assert.match(ci, /YR-HB-U2/);
  assert.match(ci, /Paid<\/dt><dd>USD 500\.00/);
});
test('FA-06b the packing list shows carton numbers and shipping marks', async () => {
  const pl = await page(`/admin/orders/${ctx.o.id}/packing-list`);
  assert.match(pl, /Packing List[\s\S]*Carton No\.[\s\S]*Shipping marks/);
});
test('FA-06c the commercial invoice can be printed in Chinese', async () => {
  assert.match(await page(`/admin/orders/${ctx.o.id}/invoice?lang=zh`), /商业发票/);
});
test('FA-06d the invoice of an unknown order is 404', async () => {
  assert.equal((await fetch(`${api.url}/admin/orders/nope/invoice`, { headers: auth('fin') })).status, 404);
});

test('FA-07a in English the finance pages have no Chinese UI left', async () => {
  const EN = { ...auth('fin'), cookie: 'yr_admin_lang=en' };
  for (const p of ['/admin/finance', '/admin/finance/reconcile', '/admin/finance/report']) {
    const text = (await page(p, EN)).replace(/<textarea[\s\S]*?<\/textarea>|<script[\s\S]*?<\/script>|<[^>]+>/g, ' ');
    const left = text.match(/[^\s]{0,20}[\u4e00-\u9fff]+[^\s]{0,20}/);
    assert.equal(left, null, `${p}: ${left?.[0]}`);
  }
});
test('FA-07b the finance workbench shows the receivables, overdue, monthly received and refund cards', async () => {
  const home = await page('/admin/home');
  for (const k of ['财务：收款', '应收合计', '已逾期', '本月回款', '待退款']) assert.ok(home.includes(k), k);
});
