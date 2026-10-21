// Black-box: administrator over HTTP — global board (one site, the other site, both together via /api/board and the
// shared OPS_TOKEN), approval rules, a quote discount and a refund going through approval, approvals workbench, English.
// IDs GO-xx.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startServer, flash } from '../helpers/server.mjs';

let led, grid;
const OPS = 'ops-shared-token-1';
before(async () => {
  led = await startServer({ site: 'led', env: { ERP_MODE: 'local', OPS_TOKEN: OPS } });
  grid = await startServer({ site: 'grid', env: { ERP_MODE: 'local', OPS_TOKEN: OPS, PEER_SITES: `led|${led.url}` } });
  for (const [u, role] of [['sam', 'sales'], ['max', 'sales_manager'], ['fay', 'finance']]) await led.form('/admin/users/new', { username: u, name: u.toUpperCase(), role, password: PW });
});
after(async () => { await led.stop(); await grid.stop(); });

const PW = 'Str0ngPassw0rd';
const auth = (u) => ({ authorization: 'Basic ' + Buffer.from(`${u}:${PW}`).toString('base64') });
const ADMIN = { authorization: 'Basic ' + Buffer.from('admin:test-pass').toString('base64') };
const form = (api, h, path, data) => fetch(api.url + path, { method: 'POST', redirect: 'manual', headers: { ...h, 'content-type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams(data) });
const page = async (api, path, h = ADMIN) => (await fetch(api.url + path, { headers: h })).text();
const nav = (html) => (html.match(/<nav>([\s\S]*?)<\/nav>/) || [])[1] || '';
/** A quote for 100 × YR-HB-U2 (as sam), returns its id. */
async function newQuote() {
  await led.json('/api/leads', { email: `b${Date.now()}@buyer.test`, company: 'Buyer Ltd', product_id: 'YR-HB-U2', quantity: 100, consent: true });
  const lead = (await page(led, '/admin?scope=all')).match(/\/admin\/lead\/([\w-]+)"/)[1];
  return flash(await fetch(`${led.url}/admin/quotes/new?lead=${lead}`, { headers: auth('sam'), redirect: 'manual' })).path.split('/').pop();
}

test('GO-01 global board: administrator only; every department and the backlog by role', async () => {
  assert.equal((await fetch(`${led.url}/admin/board`, { headers: auth('sam') })).status, 403);
  assert.doesNotMatch(nav(await page(led, '/admin/home', auth('sam'))), /全局看板/);
  const html = await page(led, '/admin/board');
  assert.match(nav(html), /<a href="\/admin\/board">全局看板<\/a>/);
  for (const k of ['销售', '运营（近 30 天）', '财务', '物流', '客服', '系统', '本月成交额', '应收合计', '待发货订单', '24 小时错误', '各岗位待办积压']) assert.ok(html.includes(k), k);
  assert.match(html, /只接了本站/);
  assert.match(html, /<td>销售：线索<\/td><td class="n"><b>\d+<\/b><\/td>/);
});

test('GO-02 two sites: /api/board needs the shared token; the other site and both together are shown', async () => {
  assert.equal((await fetch(`${led.url}/api/board`)).status, 404);
  assert.equal((await fetch(`${led.url}/api/board`, { headers: { 'x-ops-token': 'wrong' } })).status, 404);
  const s = await (await fetch(`${led.url}/api/board`, { headers: { 'x-ops-token': OPS } })).json();
  assert.equal(s.site, 'led');
  assert.ok(Array.isArray(s.backlog));
  const self = await page(grid, '/admin/board');
  assert.match(self, /<a href="\?site=self" style="font-weight:700">本站<\/a> · <a href="\?site=led">led<\/a> · <a href="\?site=all">两站合计<\/a>/);
  const other = await page(grid, '/admin/board?site=led');
  assert.match(other, /<span class="mute" style="font-size:14px" translate="no">YAORONG/);
  const both = await page(grid, '/admin/board?site=all');
  assert.match(both, /translate="no">[^<]+ \+ YAORONG/);
  assert.match(both, /金额按币种分别合计/);
  assert.match(both, /本月成交额<\/span><strong>USD \d/);
});

test('GO-03 approval rules: administrator only; values checked', async () => {
  assert.equal((await fetch(`${led.url}/admin/approvals/settings`, { headers: auth('max') })).status, 403);
  assert.equal((await fetch(`${led.url}/admin/approvals`, { headers: auth('sam') })).status, 200);
  assert.match(await page(led, '/admin/approvals', auth('sam')), /还没有开启审批流/);
  assert.match(flash(await form(led, ADMIN, '/admin/approvals/settings', { 'quote_discount.enabled': '1', 'quote_discount.percent': '150', 'quote_discount.approver': 'leads.all' })).err, /0–100/);
  assert.match(flash(await form(led, ADMIN, '/admin/approvals/settings', { 'quote_discount.enabled': '1', 'quote_discount.percent': '10', 'quote_discount.approver': 'leads.all', 'refund.enabled': '1', 'refund.amount': '100', 'refund.approver': 'admin', 'product_delete.approver': 'admin' })).ok, /已保存/);
  const html = await page(led, '/admin/approvals/settings');
  assert.match(html, /name="quote_discount.enabled" value="1" checked/);
  assert.match(html, /name="refund.amount" value="100"/);
  assert.doesNotMatch(html, /name="product_delete.enabled" value="1" checked/);
  assert.match(await page(led, '/admin/approvals', auth('sam')), /发送折扣超过比例的报价 10%（审批人：销售主管）/);
});

test('GO-04 a salesperson sends a quote with a 20% discount → request → the manager approves → sent; both see it on the workbench', async () => {
  const id = await newQuote();
  const quote = await page(led, `/admin/quotes/${id}`, auth('sam'));
  const body = { sku_0: 'YR-HB-U2', qty_0: '100', price_0: '50', discount: '1000', currency: 'USD', incoterm: 'FOB', payment_terms: 'tt30', validity_days: '15', action: 'send' };
  assert.ok(quote.includes('YR-HB-U2'));
  const r = flash(await form(led, auth('sam'), `/admin/quotes/${id}/save`, body));
  assert.match(r.err, /需要审批：已提交审批（审批人：销售主管，审批单 #\d+）/);
  assert.match(await page(led, '/admin/home', auth('max')), /待审批 #\d+：报价 [^（]+（sam）/);
  const ap = await page(led, '/admin/approvals', auth('max'));
  assert.match(ap, /待我审批（1）/);
  assert.match(ap, /折扣 USD 1000（20%）/);
  assert.match(await page(led, '/admin/approvals', auth('fay')), /待我审批（0）/);
  const aid = ap.match(/action="\/admin\/approvals\/(\d+)\/decide"/)[1];
  assert.match(flash(await form(led, auth('sam'), `/admin/approvals/${aid}/decide`, { decision: 'approve' })).err, /没有审批权限/);
  assert.match(flash(await form(led, auth('max'), `/admin/approvals/${aid}/decide`, { decision: 'approve', note: 'strategic account' })).ok, /已通过/);
  assert.match(await page(led, '/admin/home', auth('sam')), /审批已通过 #\d+：报价 [^，]+，可以操作了/);
  assert.match(flash(await form(led, auth('sam'), `/admin/quotes/${id}/save`, body)).ok, /已发送/);
  assert.match(await page(led, '/admin/approvals', auth('sam')), /<span class="pill">已执行<\/span><\/td><td>max<\/td><td translate="no">strategic account<\/td>/);
});

test('GO-05 a refund over the limit by finance waits for the administrator; the administrator goes straight through', async () => {
  const id = await newQuote();
  await form(led, ADMIN, `/admin/quotes/${id}/status`, { to: 'sent' });
  const token = (await page(led, `/admin/quotes/${id}`)).match(/\/portal\/pi\/([\w-]+)/)[1];
  await fetch(`${led.url}/portal/pi/${token}`, { method: 'POST', redirect: 'manual', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: '' });
  const order = (await page(led, '/admin/orders')).match(/\/admin\/orders\/([\w-]+)/)[1];
  await form(led, ADMIN, `/admin/orders/${order}/payment`, { kind: 'deposit', amount: '1000' });
  assert.match(flash(await form(led, auth('fay'), `/admin/orders/${order}/payment`, { kind: 'refund', amount: '50' })).ok, /已登记/);
  assert.match(flash(await form(led, auth('fay'), `/admin/orders/${order}/payment`, { kind: 'refund', amount: '300' })).err, /需要审批.*审批人：管理员/);
  assert.match(flash(await form(led, ADMIN, `/admin/orders/${order}/payment`, { kind: 'refund', amount: '300' })).ok, /已登记收款，当前已收 USD 650/);
  const ap = await page(led, '/admin/approvals');
  assert.match(ap, /订单 [^ ]+ 退款/);
  const aid = ap.match(/action="\/admin\/approvals\/(\d+)\/decide"/)[1];
  assert.match(flash(await form(led, ADMIN, `/admin/approvals/${aid}/decide`, { decision: 'reject', note: 'refunded by admin' })).ok, /已驳回/);
  assert.match(await page(led, '/admin/home', auth('fay')), /审批被驳回 #\d+：订单 [^（]+（refunded by admin）/);
});

test('GO-06 English board and approvals', async () => {
  const EN = { ...ADMIN, cookie: 'yr_admin_lang=en' };
  for (const [api, p] of [[led, '/admin/board'], [grid, '/admin/board?site=all'], [led, '/admin/approvals'], [led, '/admin/approvals/settings']]) {
    const text = (await page(api, p, EN)).replace(/<textarea[\s\S]*?<\/textarea>|<script[\s\S]*?<\/script>|<[^>]+translate="no"[^>]*>[\s\S]*?<\/[a-z]+>|<[^>]+>/g, ' ');
    const left = text.match(/[^\s]{0,20}[㐀-鿿]+[^\s]{0,20}/);
    assert.equal(left, null, `${p}: ${left?.[0]}`);
  }
});
