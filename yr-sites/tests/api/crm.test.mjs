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

test('CA-01 assignment rules from the settings page; salespeople see their own leads and the pool, managers see all', async () => {
  assert.equal((await fetch(`${api.url}/admin/sales/settings`, { headers: auth('sam') })).status, 403);
  const body = new URLSearchParams([['mode', 'round_robin'], ['members', 'sam'], ['members', 'sue'], ['poolDays', '7'], ['r0_country', 'US, Canada'], ['r0_category', ''], ['r0_owner', 'max']]);
  assert.match(flash(await form(auth('max'), '/admin/sales/settings', body)).ok, /已保存/);
  ctx.us = await newLead('us@buyer.test', { country: 'Canada' });
  ctx.a = await newLead('a@buyer.test', { country: 'DE' });
  ctx.b = await newLead('b@buyer.test', { country: 'DE', product_id: 'YR-HB-U2', quantity: 100 });
  const owners = await Promise.all([ctx.us, ctx.a, ctx.b].map(async (id) => (await page(`/admin/lead/${id}`, auth('max'))).match(/<b>负责人：<\/b>([^<]+)/)[1]));
  assert.deepEqual(owners, ['max', 'sam', 'sue']);
  const sam = await page('/admin', auth('sam'));
  assert.match(sam, /a@buyer\.test/);
  assert.doesNotMatch(sam, /b@buyer\.test/);
  assert.equal((await fetch(`${api.url}/admin/lead/${ctx.b}`, { headers: auth('sam') })).status, 404);
  assert.equal((await form(auth('sam'), `/admin/lead/${ctx.b}/status`, { status: 'won' })).status, 404);
  const max = await page('/admin', auth('max'));
  assert.match(max, /a@buyer\.test[\s\S]*|b@buyer\.test/);
  assert.match(await page(`/admin/lead/${ctx.a}`, auth('max')), /分配给 sam（轮流分配）/);
});

test('CA-02 follow-ups: recorded with the next date; due follow-ups show in the list and on the workbench', async () => {
  const past = new Date(Date.now() - 60e3).toISOString().slice(0, 16);
  assert.match(flash(await form(auth('sam'), `/admin/lead/${ctx.a}/followup`, { kind: 'call', content: 'Called, needs DLC certificate', next_at: past })).ok, /跟进已保存/);
  const html = await page(`/admin/lead/${ctx.a}`, auth('sam'));
  assert.match(html, /电话 · sam ·[\s\S]*Called, needs DLC certificate/);
  assert.match(await page('/admin?scope=due', auth('sam')), /a@buyer\.test/);
  assert.match(await page('/admin/home', auth('sam')), /跟进到期：a Co/);
  assert.match(flash(await form(auth('sam'), `/admin/lead/${ctx.a}/followup`, { kind: 'email', content: '' })).err, /跟进内容/);
});

test('CA-03 the pool: release, claim (only once), transfer by owner or manager', async () => {
  assert.match(flash(await form(auth('sam'), `/admin/lead/${ctx.a}/release`, { reason: 'not my market' })).ok, /放回公海/);
  assert.match(await page('/admin?scope=pool', auth('sue')), /a@buyer\.test[\s\S]*领取/);
  assert.match(flash(await form(auth('sue'), `/admin/lead/${ctx.a}/claim`, {})).ok, /已领取/);
  assert.equal((await form(auth('sam'), `/admin/lead/${ctx.a}/claim`, {})).status, 404, "sue's lead is no longer visible to sam");
  assert.match(flash(await form(auth('sue'), `/admin/lead/${ctx.a}/transfer`, { to: 'sam' })).ok, /已转交给 sam/);
  assert.match(flash(await form(auth('max'), `/admin/lead/${ctx.a}/transfer`, { to: 'sue' })).ok, /已转交给 sue/);
  assert.match(await page(`/admin/lead/${ctx.a}`, auth('max')), /转交：sam → sue[\s\S]*转交：sue → sam[\s\S]*sue 从公海领取[\s\S]*放回公海：not my market/);
});

test('CA-04 quotes: owner from the lead, templates saved and applied, the customer opening the PI is tracked (staff previews are not)', async () => {
  const r = await fetch(`${api.url}/admin/quotes/new?lead=${ctx.b}`, { headers: auth('sue'), redirect: 'manual' });
  ctx.q = flash(r).path.split('/').pop();
  let html = await page(`/admin/quotes/${ctx.q}`, auth('sue'));
  assert.match(html, /负责人 sue/);
  assert.match(flash(await form(auth('sue'), `/admin/quotes/${ctx.q}/save-template`, { name: 'Standard FOB kit' })).ok, /已存为报价模板/);
  assert.match(await page('/admin/quotes/templates', auth('sue')), /<b>Standard FOB kit<\/b>/);
  const tid = (await page(`/admin/quotes/${ctx.q}`, auth('sue'))).match(/<option value="(\d+)">Standard FOB kit/)[1];
  assert.match(flash(await form(auth('sue'), `/admin/quotes/${ctx.q}/template`, { template: tid })).ok, /已套用模板「Standard FOB kit」/);
  await form(auth('sue'), `/admin/quotes/${ctx.q}/status`, { to: 'sent' });
  html = await page(`/admin/quotes/${ctx.q}`, auth('sue'));
  assert.match(html, /客户还没有打开报价单链接/);
  const link = html.match(/\/portal\/pi\/([\w-]+)/)[0];
  hooks.length = 0;
  await fetch(api.url + link, { headers: { cookie: 'yr_staff=preview' } }); // a colleague previewing: not counted
  for (let i = 0; i < 2; i++) assert.equal((await fetch(api.url + link)).status, 200);
  html = await page(`/admin/quotes/${ctx.q}`, auth('sue'));
  assert.match(html, /报价单链接已打开 <b>2<\/b> 次/);
  await waitFor(() => hooks.some((h) => /客户打开了报价/.test(h.markdown?.content || '')));
  assert.equal(hooks.filter((h) => /客户打开了报价/.test(h.markdown?.content || '')).length, 1);
  assert.match(await page('/admin/home', auth('sue')), /客户刚打开了报价/);
  assert.match(await page(`/admin/lead/${ctx.b}`, auth('sue')), /客户打开 2 次/);
});

test('CA-05 customer 360: tier, VIP, tags, birthday, owner; everything about the customer on one page; list filters', async () => {
  const html = await page('/admin/customers', auth('sue'));
  const cid = html.match(/\/admin\/customers\/([\w-]+)"><b>b Co/)[1];
  const md = new Date(Date.now() + 2 * 86400e3).toISOString().slice(5, 10);
  assert.match(flash(await form(auth('sue'), `/admin/customers/${cid}/crm`, { tier: 'contractor', vip: '1', tags: '工程, 德国', birthday: md, owner: 'sue', notes: 'Prefers WhatsApp' })).ok, /已保存/);
  const c = await page(`/admin/customers/${cid}`, auth('sue'));
  for (const s of ['客户分级与标签', '询价（线索）', '跟进记录', '报价', '客户打开 2 次', '合同', '付款', '售后', '评价', 'Prefers WhatsApp']) assert.ok(c.includes(s), s);
  assert.match(c, /<option value="contractor" selected>/);
  const vip = await page('/admin/customers?vip=1', auth('sue'));
  assert.match(vip, /b Co<\/b><\/a> <span class="pill" style="background:#ffb000;color:#1d2733">VIP<\/span> <span class="pill">工程商<\/span>/);
  assert.doesNotMatch(vip, /us Co/);
  assert.match(await page(`/admin/customers?tag=${encodeURIComponent('德国')}`, auth('sue')), /b Co/);
  assert.match(await page('/admin/home', auth('sue')), /客户生日（2 天后）：b Co/);
  assert.match(flash(await form(auth('sue'), `/admin/customers/${cid}/crm`, { birthday: '2026-01-01' })).err, /月-日/);
});

test('CA-06 performance: everyone sees their own numbers, the manager sees the team and sets targets', async () => {
  const month = new Date().toISOString().slice(0, 7);
  assert.equal((await form(auth('sue'), '/admin/sales/targets', { username: 'sue', month, amount: '5000' })).status, 403);
  assert.match(flash(await form(auth('max'), '/admin/sales/targets', { username: 'sue', month, amount: '5000' })).ok, /目标已保存/);
  const mine = await page('/admin/sales/performance', auth('sue'));
  assert.match(mine, /我的/);
  assert.match(mine, /<b>sue<\/b><\/td><td>\d+<\/td><td>\d+<\/td><td>1<\/td>/);
  assert.doesNotMatch(mine, /<b>sam<\/b>/);
  const team = await page('/admin/sales/performance', auth('max'));
  assert.match(team, /团队/);
  assert.match(team, /<b>sam<\/b>/);
  assert.match(team, /USD 5,000/);
  assert.match(team, /设置月度目标/);
});

test('CA-07 English: leads, lead detail, settings, performance, templates and customer pages have no Chinese UI left', async () => {
  const EN = { ...auth('max'), cookie: 'yr_admin_lang=en' };
  const strip = (h) => h.replace(/<textarea[\s\S]*?<\/textarea>/g, '').replace(/<(span|b|pre|td|div)\b[^>]*\stranslate="no"[^>]*>[\s\S]*?<\/\1>/g, '').replace(/\svalue="[^"]*"/g, '');
  const cid = (await page('/admin/customers', auth('max'))).match(/\/admin\/customers\/([\w-]+)"><b>b Co/)[1];
  for (const p of ['/admin', `/admin/lead/${ctx.a}`, '/admin/sales/settings', '/admin/sales/performance', '/admin/quotes/templates', `/admin/customers/${cid}`, '/admin/customers', `/admin/quotes/${ctx.q}`, '/admin/home']) {
    const text = strip(await page(p, EN)).replace(/<script[\s\S]*?<\/script>|<[^>]+>/g, ' ').replace(/工程|德国/g, '');
    const left = text.match(/[^\s]{0,20}[一-鿿]+[^\s]{0,20}/);
    assert.equal(left, null, `${p}: ${left?.[0]}`);
  }
});
