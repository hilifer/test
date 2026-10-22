// Black-box: after-sales for online orders — customer return request from the order page, admin refund with
// roles, 17TRACK refresh button (mock). IDs AA-xx.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startServer, flash } from '../helpers/server.mjs';
import { mockServer } from '../helpers/mock-http.mjs';

let api, prov;
before(async () => {
  prov = await mockServer((call) => {
    if (call.url === '/track/v2.2/register') return { json: { code: 0, data: { accepted: call.body.map((x) => ({ number: x.number })) } } };
    if (call.url === '/track/v2.2/gettrackinfo') return { json: { code: 0, data: { accepted: call.body.map((x) => ({ number: x.number, track_info: { latest_status: { status: 'InTransit' }, latest_event: { description: 'Departed', location: 'Shenzhen' } } })) } } };
    return { status: 404, text: '' };
  });
  api = await startServer({ site: 'led', env: { TRACK17_KEY: 'k', TRACK17_API_BASE: prov.url, TRUSTED_PROXY_HOPS: '0' } });
});
after(async () => { await api.stop(); await prov.close(); });

const ctx = {};
test('AA-01 setup: a paid, shipped online order', async () => {
  const jar = [];
  const b = async (path, opts = {}) => { const r = await fetch(api.url + path, { redirect: 'manual', ...opts, headers: { cookie: jar.join('; '), ...(opts.headers || {}) } }); for (const sc of r.headers.getSetCookie()) jar.push(sc.split(';')[0]); return r; };
  await b('/api/shop/cart', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ sku: 'YR-HB-U2', qty: 50 }) });
  const zone = (await (await b('/shop/checkout?country=US')).text()).match(/name="zone" value="(\d+)"/)[1];
  const r = await b('/shop/checkout', { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ email: 'rma@buyer.test', name: 'R', phone: '1', line1: 'x', city: 'y', country: 'US', zone, payment: 'tt' }) });
  ctx.orderUrl = r.headers.get('location');
  ctx.no = ctx.orderUrl.match(/SO-\d{6}-\d{3}/)[0];
  ctx.id = (await (await api.admin('/admin/orders')).text()).match(new RegExp(`/admin/orders/([\\w-]+)"><b>${ctx.no}`))[1];
  ctx.total = Number((await (await api.get(ctx.orderUrl)).text()).match(/Balance due<\/td><td class="n">US\$([\d,.]+)/)[1].replace(/,/g, ''));
  await api.form(`/admin/orders/${ctx.id}/payment`, { kind: 'balance', amount: String(ctx.total) });
  const s = flash(await api.form(`/admin/orders/${ctx.id}/ship`, { mode: 'express', carrier: 'DHL', tracking_no: 'JD0001', sku_0: 'YR-HB-U2', qty_0: '50' }));
  ctx.ship = s.path.split('/').pop();
  assert.ok(ctx.ship);
});
test('AA-02a the 17TRACK refresh button reports the shipment status as updated', async () => {
  assert.match(flash(await api.form(`/admin/shipments/${ctx.ship}/track`, {})).ok, /状态已更新/);
});
test('AA-02b after the refresh the admin shipment page shows the InTransit status', async () => {
  assert.match(await (await api.admin(`/admin/shipments/${ctx.ship}`)).text(), /InTransit/);
});
test('AA-02c after the refresh the customer order page shows "DHL JD0001 — In transit"', async () => {
  assert.match(await (await api.get(ctx.orderUrl)).text(), /DHL JD0001 — In transit/);
});
test('AA-03a customer reports a problem from the order page and gets an RMA number', async () => {
  ctx.rmaPath = ctx.orderUrl.replace(`/shop/order/${ctx.no}?t=`, `/shop/order/${ctx.no}/rma?t=`);
  const r = await fetch(api.url + ctx.rmaPath, { method: 'POST', redirect: 'manual', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ sku: 'YR-HB-U2', qty: '3', issue: 'damage', description: '3 lamps cracked' }) });
  assert.match(decodeURIComponent(r.headers.get('location')), /After-sales number: RMA-/);
});
test('AA-03b the customer RMA appears in the admin RMA list as transport damage', async () => {
  assert.match(await (await api.admin('/admin/rma')).text(), /运输损坏/);
});
test('AA-03c the customer RMA is listed on the order page with its issue and status', async () => {
  assert.match(await (await api.get(ctx.orderUrl)).text(), /RMA-\d{6}-\d{3} · Damaged in transit · Submitted/);
});
test('AA-03d an RMA post with a wrong order token is 404', async () => {
  const path = ctx.rmaPath;
  const bad = await fetch(api.url + path.replace(/t=[^&]+/, 't=wrong'), { method: 'POST', redirect: 'manual', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: 'description=x' });
  assert.equal(bad.status, 404);
});
const PW = 'Str0ngPassw0rd';
const as = (u) => ({ authorization: 'Basic ' + Buffer.from(`${u}:${PW}`).toString('base64'), 'content-type': 'application/x-www-form-urlencoded' });
const refundBody = () => new URLSearchParams({ amount: '120', reason: '3 cracked', rma_id: ctx.rmaId });
test('AA-04a a sales user cannot refund an order (403)', async () => {
  ctx.rmaId = (await (await api.admin('/admin/rma')).text()).match(/\/admin\/rma\/([\w-]+)/)[1];
  await api.form(`/admin/rma/${ctx.rmaId}/status`, { to: 'approved', resolution: 'refund' });
  await api.form('/admin/users/new', { username: 'sales1', role: 'sales', password: PW });
  await api.form('/admin/users/new', { username: 'fin1', role: 'finance', password: PW });
  assert.equal((await fetch(`${api.url}/admin/orders/${ctx.id}/refund`, { method: 'POST', redirect: 'manual', headers: as('sales1'), body: refundBody() })).status, 403);
});
test('AA-04b a finance user refunds against the RMA and the order records who refunded', async () => {
  const ok = await fetch(`${api.url}/admin/orders/${ctx.id}/refund`, { method: 'POST', redirect: 'manual', headers: as('fin1'), body: refundBody() });
  assert.match(flash(ok).ok, /已退款 120（manual）/);
  const page = await (await api.admin(`/admin/orders/${ctx.id}`)).text();
  assert.match(page, /fin1 · manual/);
});
test('AA-04c the refunded RMA is marked resolved', async () => {
  assert.match(await (await api.admin(`/admin/rma/${ctx.rmaId}`)).text(), /已解决/);
});
test('AA-04d a refund larger than the amount received is rejected', async () => {
  assert.match(flash(await api.form(`/admin/orders/${ctx.id}/refund`, { amount: '999999' })).err, /不能超过已收金额/);
});
