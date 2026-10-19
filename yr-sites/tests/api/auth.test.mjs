// Black-box: staff accounts, roles, sessions, brute-force lockout, audit attribution, real-IP rate limit.
// IDs AU-xx.
import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startServer, flash } from '../helpers/server.mjs';

let api;
before(async () => { api = await startServer({ site: 'led', env: { RATE_LIMIT_PER_MIN: '3' } }); });
after(() => api.stop());

/** Log in through the form; returns a fetch helper that sends the session cookie. */
async function login(username, password, ip = '10.0.0.1') {
  const r = await fetch(`${api.url}/admin/login`, { method: 'POST', redirect: 'manual', headers: { 'content-type': 'application/x-www-form-urlencoded', 'x-forwarded-for': ip }, body: new URLSearchParams({ username, password, next: '/admin/ops' }) });
  const cookie = (r.headers.get('set-cookie') || '').split(';')[0];
  const as = (path, opts = {}) => fetch(api.url + path, { redirect: 'manual', ...opts, headers: { cookie, ...(opts.headers || {}) } });
  as.form = (path, data) => as(path, { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams(data) });
  return { res: r, cookie, as };
}
const PW = 'Str0ngPassw0rd';

describe('login, sessions, lockout', () => {
  test('AU-01 form login sets an HttpOnly session cookie scoped to /admin and redirects to "next"', async () => {
    const { res, cookie } = await login('admin', 'test-pass');
    assert.equal(res.status, 302);
    assert.equal(res.headers.get('location'), '/admin/ops');
    assert.match(res.headers.get('set-cookie'), /HttpOnly/i);
    assert.match(res.headers.get('set-cookie'), /Path=\/admin/);
    assert.match(res.headers.get('set-cookie'), /SameSite=Lax/i);
    assert.ok(cookie.startsWith('yr_staff='));
  });
  test('AU-02 open redirect via "next" is not possible', async () => {
    const r = await fetch(`${api.url}/admin/login`, { method: 'POST', redirect: 'manual', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ username: 'admin', password: 'test-pass', next: 'https://evil.test/' }) });
    assert.equal(r.headers.get('location'), '/admin');
  });
  test('AU-03 logout invalidates the session server-side', async () => {
    const { as, cookie } = await login('admin', 'test-pass');
    assert.equal((await as('/admin/ops')).status, 200);
    await as('/admin/logout', { method: 'POST' });
    const again = await fetch(`${api.url}/admin/ops`, { headers: { cookie }, redirect: 'manual' });
    assert.equal(again.status, 401, 'old cookie no longer works');
  });
  test('AU-04 five wrong passwords lock the account for 15 minutes (correct password also refused)', async () => {
    await api.form('/admin/users/new', { username: 'victim', name: 'V', role: 'sales', password: PW });
    for (let i = 0; i < 5; i++) assert.equal((await login('victim', 'wrong' + i, `10.1.0.${i}`)).res.status, 401);
    const locked = await login('victim', PW, '10.1.0.99');
    assert.equal(locked.res.status, 429);
    assert.match(await locked.res.text(), /15 分钟/);
  });
  test('AU-05 one IP guessing many usernames is locked too', async () => {
    for (let i = 0; i < 5; i++) await login(`nouser${i}`, 'x', '10.2.2.2');
    assert.equal((await login('admin', 'test-pass', '10.2.2.2')).res.status, 429);
    assert.equal((await login('admin', 'test-pass', '10.2.2.3')).res.status, 302, 'other IPs unaffected');
  });
  test('AU-06 Basic auth (scripts) goes through the same lockout', async () => {
    await api.form('/admin/users/new', { username: 'scripted', role: 'sales', password: PW });
    const h = (pw) => ({ authorization: 'Basic ' + Buffer.from(`scripted:${pw}`).toString('base64'), 'x-forwarded-for': '10.3.3.3' });
    for (let i = 0; i < 5; i++) await api.get('/admin', { headers: h('bad' + i) });
    assert.equal((await api.get('/admin', { headers: h(PW) })).status, 429);
  });
});

describe('roles & permissions', () => {
  let sales, finance, warehouse, content;
  before(async () => {
    for (const [u, role] of [['sally', 'sales'], ['fiona', 'finance'], ['wade', 'warehouse'], ['cora', 'content']]) {
      const r = flash(await api.form('/admin/users/new', { username: u, name: u, role, password: PW }));
      assert.match(r.ok, /已创建/, r.err || '');
    }
    sales = (await login('sally', PW, '10.9.0.1')).as;
    finance = (await login('fiona', PW, '10.9.0.2')).as;
    warehouse = (await login('wade', PW, '10.9.0.3')).as;
    content = (await login('cora', PW, '10.9.0.4')).as;
  });
  test('AU-07 weak passwords and bad usernames are rejected', async () => {
    assert.match(flash(await api.form('/admin/users/new', { username: 'weak', role: 'sales', password: 'short1' })).err, /至少 10 位/);
    assert.match(flash(await api.form('/admin/users/new', { username: 'weak', role: 'sales', password: 'onlyletterslong' })).err, /字母和数字/);
    assert.match(flash(await api.form('/admin/users/new', { username: 'Bad Name', role: 'sales', password: PW })).err, /用户名/);
    assert.match(flash(await api.form('/admin/users/new', { username: 'sally', role: 'sales', password: PW })).err, /已存在/);
  });
  test('AU-08 permission matrix', async () => {
    const matrix = [
      // [who, method, path, allowed]
      [sales, 'GET', '/admin', true], [sales, 'GET', '/admin/quotes', true], [sales, 'GET', '/admin/orders', true],
      [sales, 'GET', '/admin/users', false], [sales, 'GET', '/admin/content', false], [sales, 'GET', '/admin/inventory', false],
      [finance, 'GET', '/admin/orders', true], [finance, 'GET', '/admin', false], [finance, 'GET', '/admin/quotes', false],
      [warehouse, 'GET', '/admin/shipments', true], [warehouse, 'GET', '/admin/orders', true], [warehouse, 'GET', '/admin/inventory', true],
      [warehouse, 'GET', '/admin', false], [warehouse, 'GET', '/admin/leads.csv', false],
      [content, 'GET', '/admin/content', true], [content, 'GET', '/admin/orders', false], [content, 'GET', '/admin/leads.csv', false],
      [sales, 'GET', '/admin/ops', true], [content, 'GET', '/admin/me', true],
    ];
    for (const [who, method, path, ok] of matrix) {
      const r = await who(path, { method });
      assert.equal(r.status, ok ? 200 : 403, `${method} ${path} → ${r.status}`);
    }
  });
  test('AU-09 money and stock actions are limited to their roles', async () => {
    // sales may not register payments; warehouse may view orders but not change them
    assert.equal((await sales.form('/admin/orders/x/payment', { amount: '1' })).status, 403);
    assert.equal((await warehouse.form('/admin/orders/x/status', { to: 'cancelled' })).status, 403);
    assert.equal((await finance.form('/admin/skus/save', { sku: 'F-1' })).status, 403);
    assert.equal((await content.form('/admin/users/new', { username: 'hack', role: 'admin', password: PW })).status, 403);
    assert.notEqual((await finance.form('/admin/orders/x/payment', { amount: '1' })).status, 403);
    assert.notEqual((await warehouse.form('/admin/inventory/sync', {})).status, 403);
  });
  test('AU-10 navigation only shows what the role can open', async () => {
    const html = await (await content('/admin/content')).text();
    assert.match(html, /href="\/admin\/content"/);
    assert.doesNotMatch(html, /href="\/admin\/users"/);
    assert.doesNotMatch(html, /href="\/admin\/leads\.csv"/);
    assert.match(html, /cora（内容运营）/);
  });
  test('AU-11 deactivating a user kills their live sessions', async () => {
    const { as } = await login('sally', PW, '10.9.0.9');
    assert.equal((await as('/admin')).status, 200);
    const list = await (await api.admin('/admin/users')).text();
    const id = list.split('<tr>').find((r) => r.includes('<b>sally</b>')).match(/\/admin\/users\/(\d+)/)[1];
    await api.form(`/admin/users/${id}`, { name: 'sally', role: 'sales' }); // active unchecked
    assert.equal((await as('/admin')).status, 401);
    assert.equal((await login('sally', PW, '10.9.0.10')).res.status, 401);
  });
  test('AU-12 the bootstrap admin cannot be downgraded or disabled', async () => {
    const list = await (await api.admin('/admin/users')).text();
    const id = list.split('<tr>').find((r) => r.includes('<b>admin</b>')).match(/\/admin\/users\/(\d+)/)[1];
    assert.match(flash(await api.form(`/admin/users/${id}`, { name: 'x', role: 'sales', active: '1' })).err, /不能降级/);
  });
  test('AU-13 the events log records the real staff member', async () => {
    await api.form('/admin/users/new', { username: 'sam', name: 'Sam', role: 'sales', password: PW });
    const sales = (await login('sam', PW, '10.9.2.1')).as;
    await api.json('/api/leads', { email: 'audit@corp.test', product_id: 'YR-HB-U2', quantity: 100, consent: true });
    const page = await (await sales('/admin')).text();
    const lead = page.split('<tr>').find((r) => r.includes('audit@corp.test')).match(/lead=([\w-]+)/)[1];
    const r = await sales(`/admin/quotes/new?lead=${lead}`);
    const qid = new URL(r.headers.get('location'), api.url).pathname.split('/').pop();
    await sales.form(`/admin/quotes/${qid}/status`, { to: 'sent' });
    const html = await (await api.admin(`/admin/quotes/${qid}`)).text();
    assert.match(html, /sam/);
  });
  test('AU-14 change own password: needs the current one', async () => {
    const { as } = await login('fiona', PW, '10.9.1.1');
    assert.match(flash(await as.form('/admin/me', { old: 'wrong', password: 'NewPassw0rd99' })).err, /当前密码不正确/);
    assert.equal((await as.form('/admin/me', { old: PW, password: 'NewPassw0rd99' })).status, 302);
    assert.equal((await login('fiona', 'NewPassw0rd99', '10.9.1.2')).res.status, 302);
  });
});

describe('other hardening', () => {
  test('AU-15 rate limit uses the proxy-appended client IP: forged X-Forwarded-For prefixes do not bypass it', async () => {
    const codes = [];
    for (let i = 0; i < 6; i++) codes.push((await api.json('/api/chat', { message: 'hi' }, { headers: { 'x-forwarded-for': `1.2.3.${i}, 77.77.77.77` } })).status);
    assert.deepEqual(codes, [200, 200, 200, 429, 429, 429]);
  });
  test('AU-16 lead status only accepts defined values', async () => {
    await api.json('/api/leads', { email: 'st@corp.test', consent: true });
    const page = await (await api.admin('/admin')).text();
    const id = page.split('<tr>').find((r) => r.includes('st@corp.test')).match(/\/admin\/lead\/([\w-]+)\/status/)[1];
    assert.equal((await api.form(`/admin/lead/${id}/status`, { status: 'HACKED' })).status, 400);
    assert.equal((await api.form(`/admin/lead/${id}/status`, { status: 'won' })).status, 302);
  });
});
