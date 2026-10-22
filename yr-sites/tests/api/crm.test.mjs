// Black-box: sales over HTTP — who sees which leads, assignment rules, follow-ups and due reminders, pool claim / transfer /
// release, quote owner and templates, "customer opened the PI" tracking, customer 360 with tiers and tags, performance and
// targets, English UI. Mock WeCom. IDs CA-xx.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startServer, flash, waitFor } from '../helpers/server.mjs';
import { mockServer } from '../helpers/mock-http.mjs';

let api, wecom;
const hooks = [];
before(async () => {
  wecom = await mockServer((call) => { hooks.push(call.body); return { json: { errcode: 0 } }; });
  api = await startServer({ site: 'led', env: { WECOM_WEBHOOK_URL: wecom.url } });
  for (const [u, role] of [['sam', 'sales'], ['sue', 'sales'], ['max', 'sales_manager']]) await api.form('/admin/users/new', { username: u, role, password: PW });
});
after(async () => { await api.stop(); await wecom.close(); });

const PW = 'Str0ngPassw0rd';
const auth = (u) => ({ authorization: 'Basic ' + Buffer.from(`${u}:${PW}`).toString('base64') });
const form = (h, path, data) => fetch(api.url + path, { method: 'POST', redirect: 'manual', headers: { ...h, 'content-type': 'application/x-www-form-urlencoded' }, body: data instanceof URLSearchParams ? data : new URLSearchParams(data) });
const page = async (path, h) => (await fetch(api.url + path, { headers: h })).text();
const newLead = async (email, o = {}) => { await api.json('/api/leads', { email, company: `${email.split('@')[0]} Co`, consent: true, ...o }); return (await page(`/admin?scope=all&q=${encodeURIComponent(email)}`, auth('max'))).match(/\/admin\/lead\/([\w-]+)"/)[1]; };
const ctx = {};

test('CA-01a a salesperson cannot open the sales settings (403)', async () => {
  assert.equal((await fetch(`${api.url}/admin/sales/settings`, { headers: auth('sam') })).status, 403);
});
test('CA-01b the sales manager saves the assignment rules (round robin + country rule)', async () => {
  const body = new URLSearchParams([['mode', 'round_robin'], ['members', 'sam'], ['members', 'sue'], ['poolDays', '7'], ['r0_country', 'US, Canada'], ['r0_category', ''], ['r0_owner', 'max']]);
  assert.match(flash(await form(auth('max'), '/admin/sales/settings', body)).ok, /已保存/);
});
test('CA-01c new leads are assigned by the country rule first, then round robin', async () => {
  ctx.us = await newLead('us@buyer.test', { country: 'Canada' });
  ctx.a = await newLead('a@buyer.test', { country: 'DE' });
  ctx.b = await newLead('b@buyer.test', { country: 'DE', product_id: 'YR-HB-U2', quantity: 100 });
  const owners = await Promise.all([ctx.us, ctx.a, ctx.b].map(async (id) => (await page(`/admin/lead/${id}`, auth('max'))).match(/<b>负责人：<\/b>([^<]+)/)[1]));
  assert.deepEqual(owners, ['max', 'sam', 'sue']);
});
test('CA-01d a salesperson\'s lead list shows their own leads but not a colleague\'s', async () => {
  const sam = await page('/admin', auth('sam'));
  assert.match(sam, /a@buyer\.test/);
  assert.doesNotMatch(sam, /b@buyer\.test/);
});
test('CA-01e a salesperson cannot open a colleague\'s lead (404)', async () => {
  assert.equal((await fetch(`${api.url}/admin/lead/${ctx.b}`, { headers: auth('sam') })).status, 404);
});
test('CA-01f a salesperson cannot change the status of a colleague\'s lead (404)', async () => {
  assert.equal((await form(auth('sam'), `/admin/lead/${ctx.b}/status`, { status: 'won' })).status, 404);
});
test('CA-01g the sales manager sees all leads', async () => {
  const max = await page('/admin', auth('max'));
  assert.match(max, /a@buyer\.test[\s\S]*|b@buyer\.test/);
});
test('CA-01h the lead detail records who it was assigned to and why', async () => {
  assert.match(await page(`/admin/lead/${ctx.a}`, auth('max')), /分配给 sam（轮流分配）/);
});

test('CA-02a a follow-up is recorded with its type, author and content', async () => {
  const past = new Date(Date.now() - 60e3).toISOString().slice(0, 16);
  assert.match(flash(await form(auth('sam'), `/admin/lead/${ctx.a}/followup`, { kind: 'call', content: 'Called, needs DLC certificate', next_at: past })).ok, /跟进已保存/);
  const html = await page(`/admin/lead/${ctx.a}`, auth('sam'));
  assert.match(html, /电话 · sam ·[\s\S]*Called, needs DLC certificate/);
});
test('CA-02b a lead whose next follow-up date has passed shows in the "due" list', async () => {
  assert.match(await page('/admin?scope=due', auth('sam')), /a@buyer\.test/);
});
test('CA-02c a due follow-up is reminded on the workbench', async () => {
  assert.match(await page('/admin/home', auth('sam')), /跟进到期：a Co/);
});
test('CA-02d a follow-up without content is rejected', async () => {
  assert.match(flash(await form(auth('sam'), `/admin/lead/${ctx.a}/followup`, { kind: 'email', content: '' })).err, /跟进内容/);
});

test('CA-03a the owner releases a lead to the pool with a reason', async () => {
  assert.match(flash(await form(auth('sam'), `/admin/lead/${ctx.a}/release`, { reason: 'not my market' })).ok, /放回公海/);
});
test('CA-03b a released lead shows in the pool for other salespeople with a claim button', async () => {
  assert.match(await page('/admin?scope=pool', auth('sue')), /a@buyer\.test[\s\S]*领取/);
});
test('CA-03c another salesperson claims the pool lead', async () => {
  assert.match(flash(await form(auth('sue'), `/admin/lead/${ctx.a}/claim`, {})).ok, /已领取/);
});
test('CA-03d an already claimed lead cannot be claimed again (404)', async () => {
  assert.equal((await form(auth('sam'), `/admin/lead/${ctx.a}/claim`, {})).status, 404, "sue's lead is no longer visible to sam");
});
test('CA-03e the owner transfers the lead to a colleague', async () => {
  assert.match(flash(await form(auth('sue'), `/admin/lead/${ctx.a}/transfer`, { to: 'sam' })).ok, /已转交给 sam/);
});
test('CA-03f the manager transfers a lead they do not own', async () => {
  assert.match(flash(await form(auth('max'), `/admin/lead/${ctx.a}/transfer`, { to: 'sue' })).ok, /已转交给 sue/);
});
test('CA-03g the lead history records release, claim and both transfers in order', async () => {
  assert.match(await page(`/admin/lead/${ctx.a}`, auth('max')), /转交：sam → sue[\s\S]*转交：sue → sam[\s\S]*sue 从公海领取[\s\S]*放回公海：not my market/);
});

test('CA-04a a quote created from a lead takes the lead owner', async () => {
  const r = await fetch(`${api.url}/admin/quotes/new?lead=${ctx.b}`, { headers: auth('sue'), redirect: 'manual' });
  ctx.q = flash(r).path.split('/').pop();
  const html = await page(`/admin/quotes/${ctx.q}`, auth('sue'));
  assert.match(html, /负责人 sue/);
});
test('CA-04b a quote can be saved as a template and the template is listed', async () => {
  assert.match(flash(await form(auth('sue'), `/admin/quotes/${ctx.q}/save-template`, { name: 'Standard FOB kit' })).ok, /已存为报价模板/);
  assert.match(await page('/admin/quotes/templates', auth('sue')), /<b>Standard FOB kit<\/b>/);
});
test('CA-04c a saved template can be applied to a quote', async () => {
  const tid = (await page(`/admin/quotes/${ctx.q}`, auth('sue'))).match(/<option value="(\d+)">Standard FOB kit/)[1];
  assert.match(flash(await form(auth('sue'), `/admin/quotes/${ctx.q}/template`, { template: tid })).ok, /已套用模板「Standard FOB kit」/);
});
test('CA-04d a sent quote shows that the customer has not opened the PI link yet', async () => {
  await form(auth('sue'), `/admin/quotes/${ctx.q}/status`, { to: 'sent' });
  const html = await page(`/admin/quotes/${ctx.q}`, auth('sue'));
  assert.match(html, /客户还没有打开报价单链接/);
  ctx.link = html.match(/\/portal\/pi\/([\w-]+)/)[0];
});
test('CA-04e customer opens of the PI link are counted, staff previews are not', async () => {
  const link = ctx.link;
  hooks.length = 0;
  await fetch(api.url + link, { headers: { cookie: 'yr_staff=preview' } }); // a colleague previewing: not counted
  for (let i = 0; i < 2; i++) assert.equal((await fetch(api.url + link)).status, 200);
  const html = await page(`/admin/quotes/${ctx.q}`, auth('sue'));
  assert.match(html, /报价单链接已打开 <b>2<\/b> 次/);
});
test('CA-04f the first customer open sends exactly one WeCom notification', async () => {
  await waitFor(() => hooks.some((h) => /客户打开了报价/.test(h.markdown?.content || '')));
  assert.equal(hooks.filter((h) => /客户打开了报价/.test(h.markdown?.content || '')).length, 1);
});
test('CA-04g the workbench tells the owner that the customer just opened the quote', async () => {
  assert.match(await page('/admin/home', auth('sue')), /客户刚打开了报价/);
});
test('CA-04h the lead shows how many times the customer opened the quote', async () => {
  assert.match(await page(`/admin/lead/${ctx.b}`, auth('sue')), /客户打开 2 次/);
});

test('CA-05a customer 360: tier, VIP, tags, birthday, owner and notes are saved', async () => {
  const html = await page('/admin/customers', auth('sue'));
  const cid = ctx.cid = html.match(/\/admin\/customers\/([\w-]+)"><b>b Co/)[1];
  const md = new Date(Date.now() + 2 * 86400e3).toISOString().slice(5, 10);
  assert.match(flash(await form(auth('sue'), `/admin/customers/${cid}/crm`, { tier: 'contractor', vip: '1', tags: '工程, 德国', birthday: md, owner: 'sue', notes: 'Prefers WhatsApp' })).ok, /已保存/);
});
test('CA-05b the customer page shows everything about the customer on one page', async () => {
  const c = ctx.c360 = await page(`/admin/customers/${ctx.cid}`, auth('sue'));
  for (const s of ['客户分级与标签', '询价（线索）', '跟进记录', '报价', '客户打开 2 次', '合同', '付款', '售后', '评价', 'Prefers WhatsApp']) assert.ok(c.includes(s), s);
});
test('CA-05c the customer page shows the saved tier as selected', async () => {
  assert.match(ctx.c360, /<option value="contractor" selected>/);
});
test('CA-05d the VIP filter lists VIP customers with VIP and tier badges and leaves others out', async () => {
  const vip = await page('/admin/customers?vip=1', auth('sue'));
  assert.match(vip, /b Co<\/b><\/a> <span class="pill" style="background:#ffb000;color:#1d2733">VIP<\/span> <span class="pill">工程商<\/span>/);
  assert.doesNotMatch(vip, /us Co/);
});
test('CA-05e the tag filter finds the customer by tag', async () => {
  assert.match(await page(`/admin/customers?tag=${encodeURIComponent('德国')}`, auth('sue')), /b Co/);
});
test('CA-05f an upcoming customer birthday is reminded on the workbench', async () => {
  assert.match(await page('/admin/home', auth('sue')), /客户生日（2 天后）：b Co/);
});
test('CA-05g a birthday not in MM-DD format is rejected', async () => {
  assert.match(flash(await form(auth('sue'), `/admin/customers/${ctx.cid}/crm`, { birthday: '2026-01-01' })).err, /月-日/);
});

test('CA-06a a salesperson cannot set sales targets (403)', async () => {
  const month = new Date().toISOString().slice(0, 7);
  assert.equal((await form(auth('sue'), '/admin/sales/targets', { username: 'sue', month, amount: '5000' })).status, 403);
});
test('CA-06b the sales manager sets a monthly target', async () => {
  const month = new Date().toISOString().slice(0, 7);
  assert.match(flash(await form(auth('max'), '/admin/sales/targets', { username: 'sue', month, amount: '5000' })).ok, /目标已保存/);
});
test('CA-06c a salesperson sees only their own performance numbers', async () => {
  const mine = await page('/admin/sales/performance', auth('sue'));
  assert.match(mine, /我的/);
  assert.match(mine, /<b>sue<\/b><\/td><td>\d+<\/td><td>\d+<\/td><td>1<\/td>/);
  assert.doesNotMatch(mine, /<b>sam<\/b>/);
});
test('CA-06d the sales manager sees the whole team\'s performance', async () => {
  const team = await page('/admin/sales/performance', auth('max'));
  assert.match(team, /团队/);
  assert.match(team, /<b>sam<\/b>/);
});
test('CA-06e the manager\'s performance page shows the target and the set-target form', async () => {
  const team = await page('/admin/sales/performance', auth('max'));
  assert.match(team, /USD 5,000/);
  assert.match(team, /设置月度目标/);
});

test('CA-07 English: leads, lead detail, settings, performance, templates and customer pages have no Chinese UI left', async () => {
  const EN = { ...auth('max'), cookie: 'yr_admin_lang=en' };
  const strip = (h) => h.replace(/<textarea[\s\S]*?<\/textarea>/g, '').replace(/<(span|b|pre|td|div)\b[^>]*\stranslate="no"[^>]*>[\s\S]*?<\/\1>/g, '').replace(/\svalue="[^"]*"/g, '');
  const cid = (await page('/admin/customers', auth('max'))).match(/\/admin\/customers\/([\w-]+)"><b>b Co/)[1];
  for (const p of ['/admin', `/admin/lead/${ctx.a}`, '/admin/sales/settings', '/admin/sales/performance', '/admin/quotes/templates', `/admin/customers/${cid}`, '/admin/customers', `/admin/quotes/${ctx.q}`, '/admin/home']) {
    const text = strip(await page(p, EN)).replace(/<script[\s\S]*?<\/script>|<[^>]+>/g, ' ').replace(/工程|德国/g, '');
    const left = text.match(/[^\s]{0,20}[\u4e00-\u9fff]+[^\s]{0,20}/);
    assert.equal(left, null, `${p}: ${left?.[0]}`);
  }
});
