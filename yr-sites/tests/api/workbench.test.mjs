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

const ctx = {};

test('WB-01a a staff login goes straight to the workbench', async () => {
  for (const [u, role] of [['sam', 'sales'], ['fay', 'finance'], ['wes', 'warehouse'], ['cat', 'content'], ['sue', 'service'], ['dee', 'designer'], ['ozz', 'ops']]) assert.ok(flash(await api.form('/admin/users/new', { username: u, name: u.toUpperCase(), role, password: PW })).ok, u);
  const r = await fetch(`${api.url}/admin/login`, { method: 'POST', redirect: 'manual', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ username: 'sam', password: PW }) });
  assert.equal(r.headers.get('location'), '/admin/home');
});

test('WB-01b every built-in role gets its own workbench with its boards (and not other roles\' boards) and a to-do count', async () => {
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
});

test('WB-01c the ops menu is trimmed to system and operation log', async () => {
  const opsNav = nav(await (await as('ozz').get('/admin/home')).text());
  assert.match(opsNav, /系统/);
  assert.match(opsNav, /操作日志/);
  assert.doesNotMatch(opsNav, /优惠券|账号权限|业务闭环.*AI 议价/);
});

test('WB-01d the service menu is trimmed to conversations', async () => {
  const svcNav = nav(await (await as('sue').get('/admin/home')).text());
  assert.match(svcNav, /对话/);
  assert.doesNotMatch(svcNav, /商品|系统/);
});

test('WB-02a a new good lead becomes a to-do on the sales workbench', async () => {
  await api.json('/api/leads', { name: 'Ann', company: 'Big Buyer Inc', email: 'ann@bigbuyer.test', quantity: 2000, timeline: 'this month', buyer_type: 'distributor', phone: '1', consent: true });
  const sales = await (await as('sam').get('/admin/home')).text();
  assert.match(sales, /A 级线索：Big Buyer Inc|B 级线索：Big Buyer Inc/);
});

test('WB-02b a chat asking for a person becomes a to-do on the service workbench linking to it', async () => {
  const chat = await (await api.json('/api/chat', { message: 'I want to talk to a person please' })).json();
  const sue = await (await as('sue').get('/admin/home')).text();
  assert.match(sue, new RegExp(`/admin/conv/${chat.sessionId}`));
});

test('WB-02c a missing backup becomes a to-do on the ops workbench', async () => {
  const ops = await (await as('ozz').get('/admin/home')).text();
  assert.match(ops, /最近 36 小时没有成功的数据库备份/);
});

test('RL-01a a custom role is created from the permission catalogue', async () => {
  assert.match(flash(await api.form('/admin/roles', body([['key', 'buyer'], ['name', '采购'], ['perms', 'catalog.view'], ['perms', 'catalog.export']]))).ok, /已保存岗位 buyer/);
});

test('RL-01b a built-in role cannot be modified', async () => {
  assert.match(flash(await api.form('/admin/roles', body([['key', 'sales'], ['name', 'x'], ['perms', 'leads']]))).err, /内置岗位不能修改/);
});

test('RL-01c an invalid role key is refused', async () => {
  assert.match(flash(await api.form('/admin/roles', body([['key', '1bad'], ['name', 'x'], ['perms', 'leads']]))).err, /岗位编码/);
});

test('RL-01d a role without any permission is refused', async () => {
  assert.match(flash(await api.form('/admin/roles', body([['key', 'empty'], ['name', 'x']]))).err, /至少勾选一项/);
});

test('RL-01e a role with an unknown permission is refused', async () => {
  assert.match(flash(await api.form('/admin/roles', body([['key', 'bogus'], ['name', 'x'], ['perms', 'root']]))).err, /权限无效/);
});

test('RL-01f creating an account with a too-short username is refused', async () => {
  assert.match(flash(await api.form('/admin/users/new', body([['username', 'bo'], ['role', 'buyer'], ['role', 'service'], ['password', PW]]))).err, /用户名/); // too short
});

test('RL-01g an account can be given several roles', async () => {
  assert.match(flash(await api.form('/admin/users/new', body([['username', 'bob1'], ['name', 'Bob'], ['role', 'buyer'], ['role', 'service'], ['password', PW]]))).ok, /已创建账号 bob1/);
});

test('RL-01h the permissions of several roles combine', async () => {
  const bob = as('bob1');
  assert.equal((await bob.get('/admin/products/export.csv')).status, 200); // from buyer
  assert.equal((await bob.get('/admin/conversations')).status, 200); // from service
});

test('RL-01i a view-only permission does not allow changes (403)', async () => {
  assert.equal((await as('bob1').post('/admin/products/bulk', { action: 'archive', ids: 'YR-HB-U2' })).status, 403); // view only
});

test('RL-01j the user list shows all roles of an account', async () => {
  assert.match(await (await api.admin('/admin/users')).text(), /采购 \+ 客服/);
});

test('RL-02a a catalogue role without the export permission can view products but not export them', async () => {
  await api.form('/admin/roles', body([['key', 'editor'], ['name', '商品编辑'], ['perms', 'catalog']]));
  await api.form('/admin/users/new', body([['username', 'ed01'], ['role', 'editor'], ['password', PW]]));
  const ed = as('ed01');
  assert.equal((await ed.get('/admin/products')).status, 200);
  assert.equal((await ed.get('/admin/products/export.csv')).status, 403);
});

test('RL-02b a catalogue role without the delete permission cannot delete products (403)', async () => {
  assert.equal((await as('ed01').post('/admin/products/YR-HB-U2/delete', {})).status, 403);
});

test('RL-02c lead export is allowed for sales and refused for finance', async () => {
  assert.equal((await as('fay').get('/admin/leads.csv')).status, 403);
  assert.equal((await as('sam').get('/admin/leads.csv')).status, 200);
});

test('RL-03a an account manager role can open the user list', async () => {
  await api.form('/admin/roles', body([['key', 'hr'], ['name', '人事'], ['perms', 'users'], ['perms', 'catalog.view']]));
  await api.form('/admin/users/new', body([['username', 'hr01'], ['role', 'hr'], ['password', PW]]));
  assert.equal((await as('hr01').get('/admin/users')).status, 200);
});

test('RL-03b an account manager cannot create accounts with roles beyond their own rights', async () => {
  const hr = as('hr01');
  assert.match(flash(await hr.post('/admin/users/new', body([['username', 'evil1'], ['role', 'admin'], ['password', PW]]))).err, /不能授予超出自己权限/);
  assert.match(flash(await hr.post('/admin/users/new', body([['username', 'evil2'], ['role', 'sales'], ['password', PW]]))).err, /不能授予超出自己权限/);
});

test('RL-03c an account manager cannot create a role with permissions they do not have', async () => {
  assert.match(flash(await as('hr01').post('/admin/roles', body([['key', 'boss'], ['name', 'x'], ['perms', 'payments']]))).err, /不能授予超出自己权限的功能/);
});

test('RL-03d an account manager cannot edit an administrator', async () => {
  const adminId = (await (await api.admin('/admin/users')).text()).match(/\/admin\/users\/(\d+)">编辑<\/a><\/td><\/tr>/)[1];
  assert.match(flash(await as('hr01').post(`/admin/users/${adminId}`, body([['name', 'x'], ['role', 'hr'], ['active', '1']]))).err, /不能授予超出自己权限/);
});

test('RL-03e an account manager can create accounts within their own rights', async () => {
  assert.match(flash(await as('hr01').post('/admin/users/new', body([['username', 'newhr'], ['role', 'hr'], ['password', PW]]))).ok, /已创建账号 newhr/); // within own rights is fine
});

test('RL-03f an account manager cannot grant themselves the admin role', async () => {
  const meId = (await (await api.admin('/admin/users')).text()).match(/<b>hr01<\/b>[\s\S]*?\/admin\/users\/(\d+)/)[1];
  assert.match(flash(await as('hr01').post(`/admin/users/${meId}`, body([['name', 'me'], ['role', 'hr'], ['role', 'admin'], ['active', '1']]))).err, /不能授予超出自己权限/);
});

test('RL-04a a role still in use cannot be deleted', async () => {
  assert.match(flash(await api.form('/admin/roles/buyer/delete', {})).err, /还有账号在使用这个岗位：bob1/);
});

test('RL-04b an unused role can be deleted', async () => {
  await api.form('/admin/roles', body([['key', 'temp'], ['name', '临时'], ['perms', 'catalog.view']]));
  assert.match(flash(await api.form('/admin/roles/temp/delete', {})).ok, /已删除岗位/);
});

test('RL-04c a built-in role cannot be deleted', async () => {
  assert.match(flash(await api.form('/admin/roles/sales/delete', {})).err, /内置岗位不能删除/);
});

test('OL-01a the operation log records failed logins', async () => {
  await fetch(`${api.url}/admin/login`, { method: 'POST', redirect: 'manual', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ username: 'sam', password: 'wrong-password-1' }) });
  ctx.log = await (await as('ozz').get('/admin/audit')).text();
  assert.match(ctx.log, /登录失败[\s\S]*sam|sam[\s\S]*登录失败/);
});

test('OL-01b the operation log records changes (new accounts)', async () => {
  assert.match(ctx.log, /新建[\s\S]*users/);
});

test('OL-01c the operation log masks passwords and never shows them', async () => {
  assert.match(ctx.log, /password=\*\*\*/);
  assert.doesNotMatch(ctx.log, new RegExp(PW));
});

test('OL-01d the operation log records refused actions and they can be filtered by user', async () => {
  assert.match(ctx.log, /无权限/); // the refused bulk archive / delete from RL-01 / RL-02
  const failed = await (await as('ozz').get('/admin/audit?ok=0&user=ed01')).text();
  assert.match(failed, /\/admin\/products\/YR-HB-U2\/delete/);
});

test('OL-01e the operation log can be filtered by entity (roles)', async () => {
  assert.match(await (await as('ozz').get('/admin/audit?entity=roles')).text(), /已保存岗位 buyer/);
});

test('OL-02a the operation log exports as CSV filtered by user', async () => {
  const csv = await (await as('ozz').get('/admin/audit.csv?user=hr01')).text();
  assert.match(csv, /^﻿?ts,username,roles,action/);
  assert.ok(csv.split('\n').slice(1).filter(Boolean).every((l) => l.includes(',hr01,')));
});

test('OL-02b staff without the log permission cannot open the log or its CSV (403)', async () => {
  assert.equal((await as('sam').get('/admin/audit')).status, 403);
  assert.equal((await as('sam').get('/admin/audit.csv')).status, 403);
});

test('OL-02c the system page is open to ops but not to service (403)', async () => {
  assert.equal((await as('sue').get('/admin/system')).status, 403);
  assert.equal((await as('ozz').get('/admin/system')).status, 200);
});
