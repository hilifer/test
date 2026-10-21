// Black-box: role workbench, custom roles / function-level permissions (no privilege escalation), operation log.
// IDs WB-xx (workbench), RL-xx (roles), OL-xx (operation log).
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startServer, flash } from '../helpers/server.mjs';

let api;
before(async () => { api = await startServer({ site: 'led' }); });
after(async () => { await api.stop(); });
const PW = 'Str0ngPassw0rd';
const as = (u) => {
  const h = { authorization: 'Basic ' + Buffer.from(`${u}:${PW}`).toString('base64') };
  return {
    get: (p) => fetch(api.url + p, { redirect: 'manual', headers: h }),
    post: (p, data) => fetch(api.url + p, { method: 'POST', redirect: 'manual', headers: { ...h, 'content-type': 'application/x-www-form-urlencoded' }, body: data instanceof URLSearchParams ? data : new URLSearchParams(data) }),
  };
};
const body = (pairs) => new URLSearchParams(pairs);
const nav = (html) => (html.match(/<nav>([\s\S]*?)<\/nav>/) || [])[1] || '';

test('WB-01 every built-in role gets its own workbench after login; menus trimmed to the role', async () => {
  for (const [u, role] of [['sam', 'sales'], ['fay', 'finance'], ['wes', 'warehouse'], ['cat', 'content'], ['sue', 'service'], ['dee', 'designer'], ['ozz', 'ops']]) assert.ok(flash(await api.form('/admin/users/new', { username: u, name: u.toUpperCase(), role, password: PW })).ok, u);
  const r = await fetch(`${api.url}/admin/login`, { method: 'POST', redirect: 'manual', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ username: 'sam', password: PW }) });
  assert.equal(r.headers.get('location'), '/admin/home');
  const boards = {
    sam: [['销售：线索', '客服：收件箱与对话', '销售：报价与合同'], ['财务：收款', '运维：系统']],
    fay: [['财务：议价审批', '财务：收款'], ['销售：线索', '商品']],
    wes: [['仓库：发货与物流', '售后', '库存'], ['财务：收款']],
    cat: [['商品', '运营：营销', '运营：内容与 GEO'], ['销售：线索']],
    sue: [['客服：收件箱与对话', '售后'], ['财务：收款', '商品']],
    dee: [['商品'], ['销售：线索', '运营：营销']],
    ozz: [['运维：系统', '操作日志'], ['销售：线索']],
  };
  for (const [u, [yes, no]] of Object.entries(boards)) {
    const page = await (await as(u).get('/admin/home')).text();
    assert.match(page, new RegExp(`${u.toUpperCase()} 的工作台`));
    const titles = [...page.matchAll(/<h3 style="margin:0 0 8px;font-size:15px">([^<]+)<\/h3>/g)].map((m) => m[1]);
    for (const t of yes) assert.ok(titles.includes(t), `${u} should see ${t}: ${titles}`);
    for (const t of no) assert.ok(!titles.includes(t), `${u} should not see ${t}`);
    assert.match(page, /待办 <b>\d+<\/b>/);
  }
  const opsNav = nav(await (await as('ozz').get('/admin/home')).text());
  assert.match(opsNav, /系统/);
  assert.match(opsNav, /操作日志/);
  assert.doesNotMatch(opsNav, /优惠券|账号权限|业务闭环.*AI 议价/);
  const svcNav = nav(await (await as('sue').get('/admin/home')).text());
  assert.match(svcNav, /对话/);
  assert.doesNotMatch(svcNav, /商品|系统/);
});

test('WB-02 to-dos come from real records and link to them', async () => {
  await api.json('/api/leads', { name: 'Ann', company: 'Big Buyer Inc', email: 'ann@bigbuyer.test', quantity: 2000, timeline: 'this month', buyer_type: 'distributor', phone: '1', consent: true });
  const sales = await (await as('sam').get('/admin/home')).text();
  assert.match(sales, /A 级线索：Big Buyer Inc|B 级线索：Big Buyer Inc/);
  const chat = await (await api.json('/api/chat', { message: 'I want to talk to a person please' })).json();
  const sue = await (await as('sue').get('/admin/home')).text();
  assert.match(sue, new RegExp(`/admin/conv/${chat.sessionId}`));
  const ops = await (await as('ozz').get('/admin/home')).text();
  assert.match(ops, /最近 36 小时没有成功的数据库备份/);
});

test('RL-01 custom roles: create from the permission catalogue, validation, built-ins protected, several roles per user combine', async () => {
  assert.match(flash(await api.form('/admin/roles', body([['key', 'buyer'], ['name', '采购'], ['perms', 'catalog.view'], ['perms', 'catalog.export']]))).ok, /已保存岗位 buyer/);
  assert.match(flash(await api.form('/admin/roles', body([['key', 'sales'], ['name', 'x'], ['perms', 'leads']]))).err, /内置岗位不能修改/);
  assert.match(flash(await api.form('/admin/roles', body([['key', '1bad'], ['name', 'x'], ['perms', 'leads']]))).err, /岗位编码/);
  assert.match(flash(await api.form('/admin/roles', body([['key', 'empty'], ['name', 'x']]))).err, /至少勾选一项/);
  assert.match(flash(await api.form('/admin/roles', body([['key', 'bogus'], ['name', 'x'], ['perms', 'root']]))).err, /权限无效/);
  assert.match(flash(await api.form('/admin/users/new', body([['username', 'bo'], ['role', 'buyer'], ['role', 'service'], ['password', PW]]))).err, /用户名/); // too short
  assert.match(flash(await api.form('/admin/users/new', body([['username', 'bob1'], ['name', 'Bob'], ['role', 'buyer'], ['role', 'service'], ['password', PW]]))).ok, /已创建账号 bob1/);
  const bob = as('bob1');
  assert.equal((await bob.get('/admin/products/export.csv')).status, 200); // from buyer
  assert.equal((await bob.get('/admin/conversations')).status, 200); // from service
  assert.equal((await bob.post('/admin/products/bulk', { action: 'archive', ids: 'YR-HB-U2' })).status, 403); // view only
  assert.match(await (await api.admin('/admin/users')).text(), /采购 \+ 客服/);
});

test('RL-02 export and delete are separate permissions', async () => {
  await api.form('/admin/roles', body([['key', 'editor'], ['name', '商品编辑'], ['perms', 'catalog']]));
  await api.form('/admin/users/new', body([['username', 'ed01'], ['role', 'editor'], ['password', PW]]));
  const ed = as('ed01');
  assert.equal((await ed.get('/admin/products')).status, 200);
  assert.equal((await ed.get('/admin/products/export.csv')).status, 403);
  assert.equal((await ed.post('/admin/products/YR-HB-U2/delete', {})).status, 403);
  assert.equal((await as('fay').get('/admin/leads.csv')).status, 403);
  assert.equal((await as('sam').get('/admin/leads.csv')).status, 200);
});

test('RL-03 no privilege escalation: an account manager cannot grant more than they have, or touch admins', async () => {
  await api.form('/admin/roles', body([['key', 'hr'], ['name', '人事'], ['perms', 'users'], ['perms', 'catalog.view']]));
  await api.form('/admin/users/new', body([['username', 'hr01'], ['role', 'hr'], ['password', PW]]));
  const hr = as('hr01');
  assert.equal((await hr.get('/admin/users')).status, 200);
  assert.match(flash(await hr.post('/admin/users/new', body([['username', 'evil1'], ['role', 'admin'], ['password', PW]]))).err, /不能授予超出自己权限/);
  assert.match(flash(await hr.post('/admin/users/new', body([['username', 'evil2'], ['role', 'sales'], ['password', PW]]))).err, /不能授予超出自己权限/);
  assert.match(flash(await hr.post('/admin/roles', body([['key', 'boss'], ['name', 'x'], ['perms', 'payments']]))).err, /不能授予超出自己权限的功能/);
  const adminId = (await (await api.admin('/admin/users')).text()).match(/\/admin\/users\/(\d+)">编辑<\/a><\/td><\/tr>/)[1];
  assert.match(flash(await hr.post(`/admin/users/${adminId}`, body([['name', 'x'], ['role', 'hr'], ['active', '1']]))).err, /不能授予超出自己权限/);
  assert.match(flash(await hr.post('/admin/users/new', body([['username', 'newhr'], ['role', 'hr'], ['password', PW]]))).ok, /已创建账号 newhr/); // within own rights is fine
  const meId = (await (await api.admin('/admin/users')).text()).match(/<b>hr01<\/b>[\s\S]*?\/admin\/users\/(\d+)/)[1];
  assert.match(flash(await hr.post(`/admin/users/${meId}`, body([['name', 'me'], ['role', 'hr'], ['role', 'admin'], ['active', '1']]))).err, /不能授予超出自己权限/);
});

test('RL-04 a role in use cannot be deleted; an unused one can', async () => {
  assert.match(flash(await api.form('/admin/roles/buyer/delete', {})).err, /还有账号在使用这个岗位：bob1/);
  await api.form('/admin/roles', body([['key', 'temp'], ['name', '临时'], ['perms', 'catalog.view']]));
  assert.match(flash(await api.form('/admin/roles/temp/delete', {})).ok, /已删除岗位/);
  assert.match(flash(await api.form('/admin/roles/sales/delete', {})).err, /内置岗位不能删除/);
});

test('OL-01 operation log: changes, logins (incl. failed) and refused actions are recorded; no passwords', async () => {
  await fetch(`${api.url}/admin/login`, { method: 'POST', redirect: 'manual', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ username: 'sam', password: 'wrong-password-1' }) });
  const ops = as('ozz');
  const log = await (await ops.get('/admin/audit')).text();
  assert.match(log, /登录失败[\s\S]*sam|sam[\s\S]*登录失败/);
  assert.match(log, /新建[\s\S]*users/);
  assert.match(log, /password=\*\*\*/);
  assert.doesNotMatch(log, new RegExp(PW));
  assert.match(log, /无权限/); // the refused bulk archive / delete from RL-01 / RL-02
  const failed = await (await ops.get('/admin/audit?ok=0&user=ed01')).text();
  assert.match(failed, /\/admin\/products\/YR-HB-U2\/delete/);
  assert.match(await (await ops.get('/admin/audit?entity=roles')).text(), /已保存岗位 buyer/);
});

test('OL-02 filters, CSV export and access: only staff with the log permission', async () => {
  const ops = as('ozz');
  const csv = await (await ops.get('/admin/audit.csv?user=hr01')).text();
  assert.match(csv, /^﻿?ts,username,roles,action/);
  assert.ok(csv.split('\n').slice(1).filter(Boolean).every((l) => l.includes(',hr01,')));
  assert.equal((await as('sam').get('/admin/audit')).status, 403);
  assert.equal((await as('sam').get('/admin/audit.csv')).status, 403);
  assert.equal((await as('sue').get('/admin/system')).status, 403);
  assert.equal((await ops.get('/admin/system')).status, 200);
});
