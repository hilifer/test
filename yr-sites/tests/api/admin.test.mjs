// Black-box: internal admin — auth, leads, conversations, CSV, CSRF protection, content review
// (SEO/GEO), ops pages, SKU centre, inventory / Kingdee (mock). IDs AD-xx.
import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { startServer, flash } from '../helpers/server.mjs';

let api;
before(async () => { api = await startServer({ site: 'led' }); });
after(() => api.stop());

describe('auth & leads', () => {
  test('AD-01a /admin without credentials is 401 and shows the login page instead of a browser Basic-auth dialog', async () => {
    const none = await api.get('/admin');
    assert.equal(none.status, 401);
    assert.match(await none.text(), /后台登录/);
    assert.equal(none.headers.get('www-authenticate'), null);
  });
  test('AD-01b a wrong admin password is rejected with 401', async () => {
    const wrong = await api.get('/admin', { headers: { authorization: 'Basic ' + Buffer.from('admin:nope').toString('base64') } });
    assert.equal(wrong.status, 401);
  });
  test('AD-01c other admin pages (ops, orders, content, CSV, users) are 401 without a login', async () => {
    for (const p of ['/admin/ops', '/admin/orders', '/admin/content', '/admin/leads.csv', '/admin/users']) assert.equal((await api.get(p)).status, 401, p);
  });
  test('AD-02 without ADMIN_PASSWORD and without staff accounts nobody can log in', async () => {
    const s = await startServer({ site: 'led', env: { ADMIN_PASSWORD: '' } });
    try {
      assert.equal((await s.get('/admin')).status, 401);
      assert.equal((await s.form('/admin/login', { username: 'admin', password: '' }, { auth: false })).status, 401);
    } finally { await s.stop(); }
  });
  test('AD-03 every admin page renders (200) for the logged-in user', async () => {
    for (const p of ['/admin', '/admin/conversations', '/admin/ops', '/admin/quotes', '/admin/orders', '/admin/shipments', '/admin/rma', '/admin/skus', '/admin/skus/edit?sku=YR-HB-U2', '/admin/inventory', '/admin/customers', '/admin/content', '/admin/geo']) {
      const r = await api.admin(p);
      assert.equal(r.status, 200, p);
      assert.match(await r.text(), /AI 销售后台/, p);
    }
  });
  test('AD-04a a chat conversation transcript is visible in the admin', async () => {
    const chat = await (await api.json('/api/chat', { message: 'need flood lights for a stadium' })).json();
    assert.match(await (await api.admin(`/admin/conv/${chat.sessionId}`)).text(), /need flood lights for a stadium/);
  });
  test('AD-04b a lead status can be changed to "contacted" and the change is shown', async () => {
    await api.json('/api/leads', { email: 'status@corp.test', consent: true });
    const html = await (await api.admin('/admin')).text();
    const id = html.match(/\/admin\/lead\/([\w-]+)\/status/)[1];
    const r = await api.form(`/admin/lead/${id}/status`, { status: 'contacted' });
    assert.equal(r.status, 302);
    assert.match(await (await api.admin('/admin')).text(), /<option value="contacted" selected>/);
  });
  test('AD-05a CSV export is served as text/csv attachment named leads-led.csv', async () => {
    const r = await api.admin('/admin/leads.csv');
    assert.match(r.headers.get('content-type'), /text\/csv/);
    assert.match(r.headers.get('content-disposition'), /leads-led\.csv/);
  });
  test('AD-05b CSV export starts with a UTF-8 BOM', async () => {
    const bytes = Buffer.from(await (await api.admin('/admin/leads.csv')).arrayBuffer());
    assert.deepEqual([...bytes.subarray(0, 3)], [0xef, 0xbb, 0xbf], 'UTF-8 BOM so Excel opens Chinese text correctly');
  });
  test('AD-05c CSV export has the header row right after the BOM', async () => {
    const bytes = Buffer.from(await (await api.admin('/admin/leads.csv')).arrayBuffer());
    assert.match(bytes.toString('utf8', 3), /^created_at,grade,score/);
  });
  test('AD-06a CSRF: a cross-site form post to the admin is refused with 403 and has no effect', async () => {
    const evil = await fetch(`${api.url}/admin/skus/save`, {
      method: 'POST', redirect: 'manual',
      headers: { 'content-type': 'application/x-www-form-urlencoded', authorization: 'Basic ' + Buffer.from('admin:test-pass').toString('base64'), origin: 'https://evil.test' },
      body: 'sku=CSRF-1&name=pwned',
    });
    assert.equal(evil.status, 403);
    assert.doesNotMatch(await (await api.admin('/admin/skus')).text(), /CSRF-1/);
  });
  test('AD-06b CSRF: a same-origin form post to the admin is accepted (302)', async () => {
    const same = await fetch(`${api.url}/admin/skus/save`, {
      method: 'POST', redirect: 'manual',
      headers: { 'content-type': 'application/x-www-form-urlencoded', authorization: 'Basic ' + Buffer.from('admin:test-pass').toString('base64'), origin: api.url },
      body: 'sku=SAME-1&name=ok',
    });
    assert.equal(same.status, 302);
  });
});

describe('SKU centre & inventory (Kingdee mock)', () => {
  test('AD-07a a valid SKU is saved and listed with its ERP number', async () => {
    const ok = flash(await api.form('/admin/skus/save', { sku: 'YR-HB-U2-150', product_id: 'YR-HB-U2', name: 'UFO 150W', ref_price: '44', pcs_per_carton: '4', carton_cbm: '0.06', carton_gw: '12', erp_number: '1.01.HBU2150' }));
    assert.match(ok.ok, /已保存 YR-HB-U2-150/);
    assert.match(await (await api.admin('/admin/skus')).text(), /1\.01\.HBU2150/);
  });
  test('AD-07b an invalid SKU code is rejected with a validation error flash', async () => {
    const bad = flash(await api.form('/admin/skus/save', { sku: 'bad sku' }));
    assert.match(bad.err, /SKU 编码/);
  });
  test('AD-08a inventory "test connection" reports mock mode and the page labels Kingdee as mock', async () => {
    assert.match(flash(await api.form('/admin/inventory/test', {})).ok, /模拟模式/);
    const page = await (await api.admin('/admin/inventory')).text();
    assert.match(page, /金蝶（模拟）/);
  });
  test('AD-08b inventory sync reports the number of stock rows synced', async () => {
    assert.match(flash(await api.form('/admin/inventory/sync', {})).ok, /已同步 \d+ 行库存/);
  });
  test('AD-08c inventory "pull materials" returns the material list', async () => {
    const mats = await api.form('/admin/inventory/materials', {});
    assert.equal(mats.status, 200);
    assert.match(await mats.text(), /YR-HB-U2/);
  });
});

describe('content review (SEO/GEO agent)', () => {
  const read = (id) => readFileSync(join(api.dir, 'news', id + '.md'), 'utf8');
  let id;
  test('AD-09 seed articles are listed with edit links', async () => {
    const html = await (await api.admin('/admin/content')).text();
    id = html.match(/\/admin\/content\/edit\?id=([\w/-]+)/)[1];
    assert.ok(id);
    assert.equal((await api.admin(`/admin/content/edit?id=${id}`)).status, 200);
  });
  const front = (status) => `title: Test article\ndescription: d\ndate: 2026-10-01\nstatus: ${status}\nlang: en\n`;
  test('AD-10a "save" writes the edited article as a draft', async () => {
    const r = await api.form(`/admin/content/save?id=${id}`, { front: front('draft'), body: '**Short answer:** edited body', action: 'save' });
    assert.equal(r.status, 302);
    assert.match(read(id), /status: draft[\s\S]*edited body/);
  });
  test('AD-10b "publish" sets status published with publishedAt and triggers a rebuild', async () => {
    const r = await api.form(`/admin/content/save?id=${id}`, { front: front('draft'), body: '**Short answer:** edited body', action: 'publish' });
    assert.match(decodeURIComponent(r.headers.get('location')), /重新构建/);
    assert.match(read(id), /status: published/);
    assert.match(read(id), /publishedAt:/);
  });
  test('AD-10c the rebuild after publishing shows up in the content run log', async () => {
    await new Promise((res) => setTimeout(res, 800));
    assert.match(await (await api.admin('/admin/content')).text(), /build/);
  });
  test('AD-10d "unpublish" turns a published article back into a draft', async () => {
    await api.form(`/admin/content/save?id=${id}`, { front: front('published'), body: 'x', action: 'unpublish' });
    assert.match(read(id), /status: draft/);
  });
  test('AD-10e "reject" marks the article as rejected', async () => {
    await api.form(`/admin/content/save?id=${id}`, { front: front('draft'), body: 'x', action: 'reject' });
    assert.match(read(id), /status: rejected/);
  });
  test('AD-11a invalid YAML front matter is reported', async () => {
    const r = await api.form(`/admin/content/save?id=${id}`, { front: 'title: [unclosed', body: 'x', action: 'save' });
    assert.match(await r.text(), /YAML/);
  });
  test('AD-11b saving an unknown article id is 404', async () => {
    assert.equal((await api.form('/admin/content/save?id=nope', { front: 'a: 1', body: '' })).status, 404);
  });
  test('AD-11c saving a path-traversal article id is 404', async () => {
    assert.equal((await api.form('/admin/content/save?id=../../etc/passwd', { front: 'a: 1', body: '' })).status, 404);
  });
  test('AD-12 "generate" without an LLM key records an error run instead of crashing', async () => {
    const r = await api.form('/admin/content/generate', { lang: 'en', topic: 'test' });
    assert.equal(r.status, 302);
    assert.equal((await api.get('/api/health')).status, 200);
  });
});
