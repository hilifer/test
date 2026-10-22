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
  let first;
  test('AU-01a form login redirects (302) to the "next" page', async () => {
    first = await login('admin', 'test-pass');
    const { res } = first;
    assert.equal(res.status, 302);
    assert.equal(res.headers.get('location'), '/admin/ops');
  });
  test('AU-01b form login sets the yr_staff session cookie', async () => {
    assert.ok(first.cookie.startsWith('yr_staff='));
  });
  test('AU-01c the session cookie is HttpOnly', async () => {
    assert.match(first.res.headers.get('set-cookie'), /HttpOnly/i);
  });
  test('AU-01d the session cookie is scoped to Path=/admin', async () => {
    assert.match(first.res.headers.get('set-cookie'), /Path=\/admin/);
  });
  test('AU-01e the session cookie is SameSite=Lax', async () => {
    assert.match(first.res.headers.get('set-cookie'), /SameSite=Lax/i);
  });
  test('AU-02 open redirect via "next" is not possible', async () => {
    const r = await fetch(`${api.url}/admin/login`, { method: 'POST', redirect: 'manual', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ username: 'admin', password: 'test-pass', next: 'https://evil.test/' }) });
    assert.equal(r.headers.get('location'), '/admin/home'); // falls back to the workbench
  });
  test('AU-03 logout invalidates the session server-side', async () => {
    const { as, cookie } = await login('admin', 'test-pass');
    assert.equal((await as('/admin/ops')).status, 200);
    await as('/admin/logout', { method: 'POST' });
    const again = await fetch(`${api.url}/admin/ops`, { headers: { cookie }, redirect: 'manual' });
    assert.equal(again.status, 401, 'old cookie no longer works');
  });
  test('AU-04a each of five wrong passwords for an account is rejected with 401', async () => {
    await api.form('/admin/users/new', { username: 'victim', name: 'V', role: 'sales', password: PW });
    for (let i = 0; i < 5; i++) assert.equal((await login('victim', 'wrong' + i, `10.1.0.${i}`)).res.status, 401);
  });
  test('AU-04b after five wrong passwords the account is locked for 15 minutes, even with the correct password (429)', async () => {
    const locked = await login('victim', PW, '10.1.0.99');
    assert.equal(locked.res.status, 429);
    assert.match(await locked.res.text(), /15 分钟/);
  });
  test('AU-05a one IP guessing many usernames is locked out (429) even for a valid login', async () => {
    for (let i = 0; i < 5; i++) await login(`nouser${i}`, 'x', '10.2.2.2');
    assert.equal((await login('admin', 'test-pass', '10.2.2.2')).res.status, 429);
  });
  test('AU-05b the IP lockout does not affect other IPs', async () => {
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
  test('AU-07a a password shorter than 10 characters is rejected', async () => {
    assert.match(flash(await api.form('/admin/users/new', { username: 'weak', role: 'sales', password: 'short1' })).err, /至少 10 位/);
  });
  test('AU-07b a password without both letters and digits is rejected', async () => {
    assert.match(flash(await api.form('/admin/users/new', { username: 'weak', role: 'sales', password: 'onlyletterslong' })).err, /字母和数字/);
  });
  test('AU-07c an invalid username (space, capitals) is rejected', async () => {
    assert.match(flash(await api.form('/admin/users/new', { username: 'Bad Name', role: 'sales', password: PW })).err, /用户名/);
  });
  test('AU-07d a duplicate username is rejected', async () => {
    assert.match(flash(await api.form('/admin/users/new', { username: 'sally', role: 'sales', password: PW })).err, /已存在/);
  });
  const checkMatrix = async (rows) => {
    for (const [who, method, path, ok] of rows) {
      const r = await who(path, { method });
      assert.equal(r.status, ok ? 200 : 403, `${method} ${path} → ${r.status}`);
    }
  };
  // [who, method, path, allowed]
  test('AU-08a permission matrix: sales opens leads, quotes, orders, ops but not users, content, inventory', async () => {
    await checkMatrix([
      [sales, 'GET', '/admin', true], [sales, 'GET', '/admin/quotes', true], [sales, 'GET', '/admin/orders', true],
      [sales, 'GET', '/admin/users', false], [sales, 'GET', '/admin/content', false], [sales, 'GET', '/admin/inventory', false],
      [sales, 'GET', '/admin/ops', true],
    ]);
  });
  test('AU-08b permission matrix: finance opens orders but not leads or quotes', async () => {
    await checkMatrix([[finance, 'GET', '/admin/orders', true], [finance, 'GET', '/admin', false], [finance, 'GET', '/admin/quotes', false]]);
  });
  test('AU-08c permission matrix: warehouse opens shipments, orders, inventory but not leads or the CSV export', async () => {
    await checkMatrix([
      [warehouse, 'GET', '/admin/shipments', true], [warehouse, 'GET', '/admin/orders', true], [warehouse, 'GET', '/admin/inventory', true],
      [warehouse, 'GET', '/admin', false], [warehouse, 'GET', '/admin/leads.csv', false],
    ]);
  });
  test('AU-08d permission matrix: content opens content and own profile but not orders or the CSV export', async () => {
    await checkMatrix([[content, 'GET', '/admin/content', true], [content, 'GET', '/admin/orders', false], [content, 'GET', '/admin/leads.csv', false], [content, 'GET', '/admin/me', true]]);
  });
  test('AU-09a sales may not register payments (403)', async () => {
    assert.equal((await sales.form('/admin/orders/x/payment', { amount: '1' })).status, 403);
  });
  test('AU-09b warehouse may view orders but not change their status (403)', async () => {
    assert.equal((await warehouse.form('/admin/orders/x/status', { to: 'cancelled' })).status, 403);
  });
  test('AU-09c finance may not edit SKUs (403)', async () => {
    assert.equal((await finance.form('/admin/skus/save', { sku: 'F-1' })).status, 403);
  });
  test('AU-09d content may not create users (403)', async () => {
    assert.equal((await content.form('/admin/users/new', { username: 'hack', role: 'admin', password: PW })).status, 403);
  });
  test('AU-09e finance is allowed to register payments', async () => {
    assert.notEqual((await finance.form('/admin/orders/x/payment', { amount: '1' })).status, 403);
  });
  test('AU-09f warehouse is allowed to sync inventory', async () => {
    assert.notEqual((await warehouse.form('/admin/inventory/sync', {})).status, 403);
  });
  test('AU-10a navigation shows the links the role can open', async () => {
    const html = await (await content('/admin/content')).text();
    assert.match(html, /href="\/admin\/content"/);
  });
  test('AU-10b navigation hides the users and CSV export links from a content user', async () => {
    const html = await (await content('/admin/content')).text();
    assert.doesNotMatch(html, /href="\/admin\/users"/);
    assert.doesNotMatch(html, /href="\/admin\/leads\.csv"/);
  });
  test('AU-10c the header shows the logged-in user with the role name', async () => {
    const html = await (await content('/admin/content')).text();
    assert.match(html, /cora（内容运营）/);
  });
  test('AU-11a deactivating a user kills their live sessions', async () => {
    const { as } = await login('sally', PW, '10.9.0.9');
    assert.equal((await as('/admin')).status, 200);
    const list = await (await api.admin('/admin/users')).text();
    const id = list.split('<tr>').find((r) => r.includes('<b>sally</b>')).match(/\/admin\/users\/(\d+)/)[1];
    await api.form(`/admin/users/${id}`, { name: 'sally', role: 'sales' }); // active unchecked
    assert.equal((await as('/admin')).status, 401);
  });
  test('AU-11b a deactivated user cannot log in again', async () => {
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
  let fiona;
  test('AU-14a changing own password with a wrong current password is rejected', async () => {
    const { as } = fiona = await login('fiona', PW, '10.9.1.1');
    assert.match(flash(await as.form('/admin/me', { old: 'wrong', password: 'NewPassw0rd99' })).err, /当前密码不正确/);
  });
  test('AU-14b changing own password with the correct current password works and the new password logs in', async () => {
    const { as } = fiona;
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
  let leadId;
  test('AU-16a lead status rejects an undefined value (400)', async () => {
    await api.json('/api/leads', { email: 'st@corp.test', consent: true });
    const page = await (await api.admin('/admin')).text();
    const id = leadId = page.split('<tr>').find((r) => r.includes('st@corp.test')).match(/\/admin\/lead\/([\w-]+)\/status/)[1];
    assert.equal((await api.form(`/admin/lead/${id}/status`, { status: 'HACKED' })).status, 400);
  });
  test('AU-16b lead status accepts a defined value (302)', async () => {
    const id = leadId;
    assert.equal((await api.form(`/admin/lead/${id}/status`, { status: 'won' })).status, 302);
  });
});
