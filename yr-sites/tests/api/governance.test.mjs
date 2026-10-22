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

const ctx = {};
test('GO-01a global board: a salesperson cannot open it (403)', async () => {
  assert.equal((await fetch(`${led.url}/admin/board`, { headers: auth('sam') })).status, 403);
});
test('GO-01b global board: the salesperson\'s navigation has no board link', async () => {
  assert.doesNotMatch(nav(await page(led, '/admin/home', auth('sam'))), /全局看板/);
});
test('GO-01c global board: the administrator\'s navigation links to it', async () => {
  const html = ctx.board = await page(led, '/admin/board');
  assert.match(nav(html), /<a href="\/admin\/board">全局看板<\/a>/);
});
test('GO-01d global board shows every department and the key figures', async () => {
  for (const k of ['销售', '运营（近 30 天）', '财务', '物流', '客服', '系统', '本月成交额', '应收合计', '待发货订单', '24 小时错误', '各岗位待办积压']) assert.ok(ctx.board.includes(k), k);
});
test('GO-01e global board without peer sites says only this site is connected', async () => {
  assert.match(ctx.board, /只接了本站/);
});
test('GO-01f global board lists the backlog by role with counts', async () => {
  assert.match(ctx.board, /<td>销售：线索<\/td><td class="n"><b>\d+<\/b><\/td>/);
});

test('GO-02a /api/board without the shared token is 404', async () => {
  assert.equal((await fetch(`${led.url}/api/board`)).status, 404);
});
test('GO-02b /api/board with a wrong token is 404', async () => {
  assert.equal((await fetch(`${led.url}/api/board`, { headers: { 'x-ops-token': 'wrong' } })).status, 404);
});
test('GO-02c /api/board with the shared token returns the site summary with its backlog', async () => {
  const s = await (await fetch(`${led.url}/api/board`, { headers: { 'x-ops-token': OPS } })).json();
  assert.equal(s.site, 'led');
  assert.ok(Array.isArray(s.backlog));
});
test('GO-02d the board of a site with a peer offers this site / the other site / both together', async () => {
  const self = await page(grid, '/admin/board');
  assert.match(self, /<a href="\?site=self" style="font-weight:700">本站<\/a> · <a href="\?site=led">led<\/a> · <a href="\?site=all">两站合计<\/a>/);
});
test('GO-02e the board shows the other site\'s figures under its name', async () => {
  const other = await page(grid, '/admin/board?site=led');
  assert.match(other, /<span class="mute" style="font-size:14px" translate="no">YAORONG/);
});
test('GO-02f the "both together" board is titled with both site names', async () => {
  const both = ctx.both = await page(grid, '/admin/board?site=all');
  assert.match(both, /translate="no">[^<]+ \+ YAORONG/);
});
test('GO-02g the "both together" board sums money per currency', async () => {
  assert.match(ctx.both, /金额按币种分别合计/);
  assert.match(ctx.both, /本月成交额<\/span><strong>USD \d/);
});

test('GO-03a approval rules: a sales manager cannot open the settings (403)', async () => {
  assert.equal((await fetch(`${led.url}/admin/approvals/settings`, { headers: auth('max') })).status, 403);
});
test('GO-03b the approvals page is open to sales and says the approval flow is not enabled yet', async () => {
  assert.equal((await fetch(`${led.url}/admin/approvals`, { headers: auth('sam') })).status, 200);
  assert.match(await page(led, '/admin/approvals', auth('sam')), /还没有开启审批流/);
});
test('GO-03c approval rules: a discount percentage outside 0–100 is rejected', async () => {
  assert.match(flash(await form(led, ADMIN, '/admin/approvals/settings', { 'quote_discount.enabled': '1', 'quote_discount.percent': '150', 'quote_discount.approver': 'leads.all' })).err, /0–100/);
});
test('GO-03d approval rules: valid rules are saved', async () => {
  assert.match(flash(await form(led, ADMIN, '/admin/approvals/settings', { 'quote_discount.enabled': '1', 'quote_discount.percent': '10', 'quote_discount.approver': 'leads.all', 'refund.enabled': '1', 'refund.amount': '100', 'refund.approver': 'admin', 'product_delete.approver': 'admin' })).ok, /已保存/);
});
test('GO-03e the settings page shows the saved rules (enabled ones checked, others not)', async () => {
  const html = await page(led, '/admin/approvals/settings');
  assert.match(html, /name="quote_discount.enabled" value="1" checked/);
  assert.match(html, /name="refund.amount" value="100"/);
  assert.doesNotMatch(html, /name="product_delete.enabled" value="1" checked/);
});
test('GO-03f the approvals page describes the active rule with its threshold and approver', async () => {
  assert.match(await page(led, '/admin/approvals', auth('sam')), /发送折扣超过比例的报价 10%（审批人：销售主管）/);
});

const quoteBody = { sku_0: 'YR-HB-U2', qty_0: '100', price_0: '50', discount: '1000', currency: 'USD', incoterm: 'FOB', payment_terms: 'tt30', validity_days: '15', action: 'send' };
test('GO-04a sending a quote with a 20% discount creates an approval request instead of sending', async () => {
  const id = ctx.quote = await newQuote();
  const quote = await page(led, `/admin/quotes/${id}`, auth('sam'));
  assert.ok(quote.includes('YR-HB-U2'));
  const r = flash(await form(led, auth('sam'), `/admin/quotes/${id}/save`, quoteBody));
  assert.match(r.err, /需要审批：已提交审批（审批人：销售主管，审批单 #\d+）/);
});
test('GO-04b the manager\'s workbench shows the pending approval', async () => {
  assert.match(await page(led, '/admin/home', auth('max')), /待审批 #\d+：报价 [^（]+（sam）/);
});
test('GO-04c the manager\'s approvals list shows the request with the discount detail', async () => {
  const ap = await page(led, '/admin/approvals', auth('max'));
  assert.match(ap, /待我审批（1）/);
  assert.match(ap, /折扣 USD 1000（20%）/);
  ctx.aid = ap.match(/action="\/admin\/approvals\/(\d+)\/decide"/)[1];
});
test('GO-04d finance has nothing to approve for a quote discount', async () => {
  assert.match(await page(led, '/admin/approvals', auth('fay')), /待我审批（0）/);
});
test('GO-04e the requesting salesperson cannot approve the request', async () => {
  assert.match(flash(await form(led, auth('sam'), `/admin/approvals/${ctx.aid}/decide`, { decision: 'approve' })).err, /没有审批权限/);
});
test('GO-04f the manager approves the request with a note', async () => {
  assert.match(flash(await form(led, auth('max'), `/admin/approvals/${ctx.aid}/decide`, { decision: 'approve', note: 'strategic account' })).ok, /已通过/);
});
test('GO-04g the salesperson\'s workbench says the approval went through', async () => {
  assert.match(await page(led, '/admin/home', auth('sam')), /审批已通过 #\d+：报价 [^，]+，可以操作了/);
});
test('GO-04h after approval the quote can be sent', async () => {
  assert.match(flash(await form(led, auth('sam'), `/admin/quotes/${ctx.quote}/save`, quoteBody)).ok, /已发送/);
});
test('GO-04i the approvals history shows the request as executed with approver and note', async () => {
  assert.match(await page(led, '/admin/approvals', auth('sam')), /<span class="pill">已执行<\/span><\/td><td>max<\/td><td translate="no">strategic account<\/td>/);
});

test('GO-05a a refund under the limit by finance is recorded directly', async () => {
  const id = await newQuote();
  await form(led, ADMIN, `/admin/quotes/${id}/status`, { to: 'sent' });
  const token = (await page(led, `/admin/quotes/${id}`)).match(/\/portal\/pi\/([\w-]+)/)[1];
  await fetch(`${led.url}/portal/pi/${token}`, { method: 'POST', redirect: 'manual', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: '' });
  const order = ctx.order = (await page(led, '/admin/orders')).match(/\/admin\/orders\/([\w-]+)/)[1];
  await form(led, ADMIN, `/admin/orders/${order}/payment`, { kind: 'deposit', amount: '1000' });
  assert.match(flash(await form(led, auth('fay'), `/admin/orders/${order}/payment`, { kind: 'refund', amount: '50' })).ok, /已登记/);
});
test('GO-05b a refund over the limit by finance waits for the administrator\'s approval', async () => {
  assert.match(flash(await form(led, auth('fay'), `/admin/orders/${ctx.order}/payment`, { kind: 'refund', amount: '300' })).err, /需要审批.*审批人：管理员/);
});
test('GO-05c the administrator\'s refund over the limit goes straight through', async () => {
  assert.match(flash(await form(led, ADMIN, `/admin/orders/${ctx.order}/payment`, { kind: 'refund', amount: '300' })).ok, /已登记收款，当前已收 USD 650/);
});
test('GO-05d the pending refund request is listed in the administrator\'s approvals', async () => {
  const ap = await page(led, '/admin/approvals');
  assert.match(ap, /订单 [^ ]+ 退款/);
  ctx.refundAid = ap.match(/action="\/admin\/approvals\/(\d+)\/decide"/)[1];
});
test('GO-05e the administrator rejects the refund request', async () => {
  assert.match(flash(await form(led, ADMIN, `/admin/approvals/${ctx.refundAid}/decide`, { decision: 'reject', note: 'refunded by admin' })).ok, /已驳回/);
});
test('GO-05f the finance workbench shows the rejection with the note', async () => {
  assert.match(await page(led, '/admin/home', auth('fay')), /审批被驳回 #\d+：订单 [^（]+（refunded by admin）/);
});

test('GO-06 English board and approvals', async () => {
  const EN = { ...ADMIN, cookie: 'yr_admin_lang=en' };
  for (const [api, p] of [[led, '/admin/board'], [grid, '/admin/board?site=all'], [led, '/admin/approvals'], [led, '/admin/approvals/settings']]) {
    const text = (await page(api, p, EN)).replace(/<textarea[\s\S]*?<\/textarea>|<script[\s\S]*?<\/script>|<[^>]+translate="no"[^>]*>[\s\S]*?<\/[a-z]+>|<[^>]+>/g, ' ');
    const left = text.match(/[^\s]{0,20}[\u3400-\u9fff]+[^\s]{0,20}/);
    assert.equal(left, null, `${p}: ${left?.[0]}`);
  }
});
