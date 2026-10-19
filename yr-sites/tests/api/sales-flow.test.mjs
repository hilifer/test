// Black-box end-to-end of the sales-to-delivery loop over HTTP, exactly as staff and customers use it:
// lead → PI → customer accepts → Kingdee (mock) → deposit → production → shipment → tracking →
// delivered → AI order lookup → after-sales → replacement → balance → completed. IDs SF-xx.
import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startServer, flash } from '../helpers/server.mjs';

let api;
const ctx = {};
before(async () => { api = await startServer({ site: 'led' }); });
after(() => api.stop());

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const html = async (p) => (await api.admin(p)).text();
const leadIdFor = async (email) => {
  const page = await html('/admin');
  const row = page.split('<tr>').find((r) => r.includes(email));
  return row.match(/\/admin\/quotes\/new\?lead=([\w-]+)/)[1];
};

describe('sales-to-delivery loop', () => {
  test('SF-01 website quote form creates a graded lead', async () => {
    const r = await api.json('/api/leads', { name: 'Maria Lopez', company: 'Lopez Electric LLC', email: 'maria@lopez-electric.test', country: 'USA', product_id: 'YR-HB-U2', quantity: 600, timeline: 'this month', consent: true, source: 'quote-form' });
    assert.equal(r.status, 200);
    ctx.leadId = await leadIdFor('maria@lopez-electric.test');
  });
  test('SF-02 "生成报价" turns the lead into a draft PI with the reference price, lead → quoted', async () => {
    const r = flash(await api.admin(`/admin/quotes/new?lead=${ctx.leadId}`));
    assert.match(r.ok, /已从线索生成报价 PI-\d{6}-\d{3}（1 个产品）/);
    ctx.quoteId = r.path.split('/').pop();
    const page = await html(`/admin/quotes/${ctx.quoteId}`);
    assert.match(page, /YR-HB-U2/);
    assert.match(page, /value="600"/);
    assert.match(await html('/admin'), /<option value="quoted" selected>/);
  });
  test('SF-03 a draft PI has no customer link', async () => {
    assert.doesNotMatch(await html(`/admin/quotes/${ctx.quoteId}`), /\/portal\/pi\//);
  });
  const sendForm = (price) => ({ sku_0: 'YR-HB-U2', qty_0: '600', price_0: price, variant_0: '150W 5000K', currency: 'USD', incoterm: 'FOB', port: 'Shenzhen', payment_terms: 'tt30', validity_days: '15', freight: '0', discount: '0', notes: '' });
  test('SF-04 staff edit price/terms and send; customer sees the PI (en + zh) and the e-mail template', async () => {
    const r = flash(await api.form(`/admin/quotes/${ctx.quoteId}/save`, { ...sendForm('41'), action: 'send' }));
    assert.match(r.ok, /已发送/);
    const page = await html(`/admin/quotes/${ctx.quoteId}`);
    ctx.piToken = page.match(/\/portal\/pi\/([\w-]+)/)[1];
    assert.match(page, /Proforma Invoice PI-/);
    const en = await (await api.get(`/portal/pi/${ctx.piToken}`)).text();
    assert.match(en, /24,600/);
    assert.match(en, /150W 5000K/);
    const zh = await (await api.get(`/portal/pi/${ctx.piToken}?lang=zh`)).text();
    assert.match(zh, /[\u4e00-\u9fff]/);
  });
  test('SF-04b editing a sent PI withdraws it (link 404) until it is sent again', async () => {
    flash(await api.form(`/admin/quotes/${ctx.quoteId}/save`, { ...sendForm('40'), action: 'save' }));
    assert.equal((await api.get(`/portal/pi/${ctx.piToken}`)).status, 404);
    assert.equal((await api.form(`/portal/pi/${ctx.piToken}`, {}, { auth: false })).status, 200);
    assert.doesNotMatch(await html('/admin/orders'), /SO-\d/, 'a withdrawn PI cannot be accepted');
    flash(await api.form(`/admin/quotes/${ctx.quoteId}/save`, { ...sendForm('40'), action: 'send' }));
    assert.match(await (await api.get(`/portal/pi/${ctx.piToken}`)).text(), /24,000/);
  });
  test('SF-05 customer accepts online → order SO-… created (30% deposit) and pushed to Kingdee (mock)', async () => {
    const r = await api.form(`/portal/pi/${ctx.piToken}`, {}, { auth: false });
    assert.equal(r.status, 200);
    const body = await r.text();
    ctx.orderNo = body.match(/SO-\d{6}-\d{3}/)[0];
    const list = await html('/admin/orders');
    ctx.orderId = list.match(new RegExp(`/admin/orders/([\\w-]+)">(?:<b>)?${ctx.orderNo}`))[1];
    await sleep(300);
    const page = await html(`/admin/orders/${ctx.orderId}`);
    assert.match(page, /待付定金/);
    assert.match(page, /7,200/, 'deposit due = 30% of 24,000');
    assert.match(page, /XSDD\d+/, 'Kingdee sales order number shown');
  });
  test('SF-06 accepting twice does not create a second order', async () => {
    await api.form(`/portal/pi/${ctx.piToken}`, {}, { auth: false });
    const list = await html('/admin/orders');
    assert.equal((list.match(/SO-\d{6}-\d{3}/g) || []).filter((n, i, a) => a.indexOf(n) === i).length, 1);
  });
  test('SF-07 cannot ship before deposit / production', async () => {
    const r = flash(await api.form(`/admin/orders/${ctx.orderId}/ship`, { mode: 'sea' }));
    assert.match(r.err, /待发货/);
    const s = flash(await api.form(`/admin/orders/${ctx.orderId}/status`, { to: 'shipped' }));
    assert.match(s.err, /不能从/);
  });
  test('SF-08 deposit received → production starts automatically', async () => {
    const r = flash(await api.form(`/admin/orders/${ctx.orderId}/payment`, { kind: 'deposit', amount: '7200', ref: 'TT-001' }));
    assert.match(r.ok, /已登记收款/);
    assert.match(await html(`/admin/orders/${ctx.orderId}`), /生产\/备货中/);
  });
  test('SF-09 ready to ship with open balance shows the balance warning', async () => {
    flash(await api.form(`/admin/orders/${ctx.orderId}/status`, { to: 'ready_to_ship' }));
    const page = await html(`/admin/orders/${ctx.orderId}`);
    assert.match(page, /待发货/);
    assert.match(page, /尾款/);
  });
  test('SF-10 shipment with automatic packing; tracking updates cascade to the order', async () => {
    const r = flash(await api.form(`/admin/orders/${ctx.orderId}/ship`, { mode: 'sea', carrier: 'COSCO', tracking_no: 'COSU123', container_no: 'CSNU7654321', etd: '2026-11-01', eta: '2026-11-25' }));
    assert.match(r.ok, /已创建发货单 SH-/);
    ctx.shipId = r.path.split('/').pop();
    assert.match(flash(await api.form(`/admin/shipments/${ctx.shipId}/event`, { status: 'in_transit', location: 'Yantian' })).ok, /物流动态已更新/);
    assert.match(await html(`/admin/orders/${ctx.orderId}`), /已发货/);
    assert.match(flash(await api.form(`/admin/shipments/${ctx.shipId}/event`, { status: 'booked' })).err, /物流状态不能从/);
  });
  test('SF-11 customer portal: order number + email lookup; wrong email rejected', async () => {
    const bad = await api.form('/portal', { order: ctx.orderNo, email: 'someone@else.test', lang: 'en' }, { auth: false });
    assert.equal(bad.status, 404);
    const ok = await api.form('/portal', { order: ctx.orderNo.toLowerCase(), email: 'MARIA@lopez-electric.test', lang: 'en' }, { auth: false });
    assert.equal(ok.status, 302);
    ctx.portalOrder = ok.headers.get('location');
    ctx.portalToken = ctx.portalOrder.match(/\/portal\/c\/([\w-]+)\//)[1];
    const page = await (await api.get(ctx.portalOrder)).text();
    assert.match(page, /COSU123/);
    assert.match(page, /CSNU7654321/);
    assert.match(page, /In transit/);
    assert.match(await (await api.get(ctx.portalOrder.replace('lang=en', 'lang=zh'))).text(), /运输中/);
  });
  test('SF-12 AI chat order tracking verifies order number + email (rules mode)', async () => {
    const a = await (await api.json('/api/chat', { message: `Where is my order ${ctx.orderNo}?` })).json();
    assert.match(a.reply, /email address used on order/);
    const wrong = await (await api.json('/api/chat', { sessionId: a.sessionId, message: 'it is hacker@evil.test' })).json();
    assert.match(wrong.reply, /could not find/);
    const b = await (await api.json('/api/chat', { message: `Track ${ctx.orderNo}, email maria@lopez-electric.test` })).json();
    assert.match(b.reply, new RegExp(`Order ${ctx.orderNo}: Shipped`));
    assert.match(b.reply, /ETA 2026-11-25/);
    assert.match(b.link.href, /\/portal\/c\//);
  });
  test('SF-13 delivered event → order delivered; balance still blocks completion', async () => {
    flash(await api.form(`/admin/shipments/${ctx.shipId}/event`, { status: 'delivered', location: 'Los Angeles' }));
    assert.match(await html(`/admin/orders/${ctx.orderId}`), /已签收/);
    assert.match(flash(await api.form(`/admin/orders/${ctx.orderId}/status`, { to: 'completed' })).err, /尾款未收清（待收 USD 16800）/);
  });
  test('SF-14 after-sales via AI chat creates an RMA for a verified, delivered order', async () => {
    const r = await (await api.json('/api/chat', { message: `Order ${ctx.orderNo}, maria@lopez-electric.test: 3 lights arrived damaged` })).json();
    assert.match(r.reply, /after-sales case RMA-\d{6}-\d{3}/);
    assert.match(await html('/admin/rma'), /运输损坏/);
  });
  test('SF-15 after-sales via the portal form', async () => {
    const r = await api.form(`/portal/c/${ctx.portalToken}/o/${ctx.orderNo}/rma?lang=en`, { sku: 'YR-HB-U2', qty: '2', issue: 'defect', description: 'Two units flicker', photos: 'https://photos.test/1.jpg javascript:alert(1)' }, { auth: false });
    assert.equal(r.status, 302);
    assert.match(r.headers.get('location'), /rma=RMA-/);
    const empty = await api.form(`/portal/c/${ctx.portalToken}/o/${ctx.orderNo}/rma?lang=en`, { description: '  ' }, { auth: false });
    assert.equal(empty.status, 200, 'empty description re-renders the form');
  });
  test('SF-16 staff approve the RMA and create a replacement shipment', async () => {
    const list = await html('/admin/rma');
    const rmaId = list.match(/\/admin\/rma\/([\w-]+)/)[1];
    assert.match(flash(await api.form(`/admin/rma/${rmaId}/status`, { to: 'approved', resolution: 'replace', note: 'replace 2 pcs' })).ok, /已更新/);
    const r = flash(await api.form(`/admin/rma/${rmaId}/ship`, {}));
    assert.match(r.ok, /已创建补发单 SH-/);
    assert.match(await html(`/admin/rma/${rmaId}`), /处理中/);
  });
  test('SF-17 balance received → order can be completed; portal shows completed', async () => {
    flash(await api.form(`/admin/orders/${ctx.orderId}/payment`, { kind: 'balance', amount: '16800', ref: 'TT-002' }));
    assert.match(flash(await api.form(`/admin/orders/${ctx.orderId}/status`, { to: 'completed' })).ok, /状态已更新/);
    assert.match(await (await api.get(`/portal/c/${ctx.portalToken}/?lang=en`)).text(), /Completed/);
  });
  test('SF-18 portal access control: other customers\' tokens and bad tokens cannot open the order', async () => {
    await api.json('/api/leads', { email: 'other@buyer.test', product_id: 'YR-FL-F5', quantity: 100, consent: true });
    const r = flash(await api.admin(`/admin/quotes/new?lead=${await leadIdFor('other@buyer.test')}`));
    const page = await html(r.path);
    const custRow = (await html('/admin/customers')).split('<tr>').find((row) => row.includes('<td>other@buyer.test</td>'));
    const custLink = custRow && custRow.match(/\/admin\/customers\/([\w-]+)"/);
    const otherId = custLink ? custLink[1] : null;
    assert.ok(otherId, page.slice(0, 50));
    const otherToken = (await html(`/admin/customers/${otherId}`)).match(/\/portal\/c\/([\w-]+)\//)[1];
    assert.equal((await api.get(`/portal/c/${otherToken}/o/${ctx.orderNo}`)).status, 404);
    assert.equal((await api.get(`/portal/c/not-a-token/o/${ctx.orderNo}`)).status, 404);
    assert.equal((await api.get('/portal/c/not-a-token/')).status, 404);
  });
  test('SF-19 multi-product quote list (RFQ cart) → multi-line PI', async () => {
    await api.json('/api/leads', { email: 'cart@distributor.test', company: 'Cart Dist', consent: true, source: 'quote-page', extra: { lines: [{ sku: 'YR-HB-U2', qty: 200, note: '200W' }, { sku: 'YR-FL-F5', qty: 100 }, { sku: 'NOT-REAL', qty: 5 }] } });
    const r = flash(await api.admin(`/admin/quotes/new?lead=${await leadIdFor('cart@distributor.test')}`));
    assert.match(r.ok, /（2 个产品）/, 'unknown SKUs are dropped, real ones kept');
  });
  test('SF-20 events timeline records who changed what', async () => {
    const page = await html(`/admin/orders/${ctx.orderId}`);
    for (const s of ['待付定金', '生产/备货中', '待发货', '已发货', '已签收', '已完成']) assert.ok(page.includes(s), s);
    assert.match(page, /system/);
    assert.match(page, /customer/);
  });
});
