// Module: server/src/sales/crm.js — lead visibility, automatic assignment, transfer / claim / release, the pool, follow-ups,
// quote templates, "customer opened the link" tracking, customer tiers / birthdays / holidays, performance & targets.
// IDs CR-xx.
import { test, describe, after } from 'node:test';
import assert from 'node:assert/strict';
import { useTempEnv } from '../helpers/env.mjs';
import { mockServer } from '../helpers/mock-http.mjs';

const hooks = [];
const wecom = await mockServer((call) => { hooks.push(call.body); return { json: { errcode: 0 } }; });
useTempEnv({ site: 'led', WECOM_WEBHOOK_URL: wecom.url });
const { db, insertLead } = await import('../../server/src/db.js');
const { saveStaff, runAs } = await import('../../server/src/auth.js');
const CRM = await import('../../server/src/sales/crm.js');
const S = await import('../../server/src/ops/service.js');
after(() => wecom.close());
const settle = () => new Promise((r) => setTimeout(r, 120));

const PW = 'Str0ngPassw0rd';
for (const [u, role] of [['sam', 'sales'], ['sue', 'sales'], ['max', 'sales_manager']]) saveStaff({ username: u, role, password: PW });
const user = (u) => db.prepare('SELECT id, username, role FROM staff WHERE username = ?').get(u);
const lead = (o = {}) => insertLead({ email: `${Math.random().toString(36).slice(2)}@x.test`, grade: 'B', score: 50, consent: true, ...o });

describe('assignment and visibility', () => {
  test('CR-01 rules first (country list, product category), then round robin; manual mode sends everything to the pool', () => {
    CRM.saveAssignSettings({ mode: 'round_robin', members: ['sam', 'sue'], rules: [{ country: 'US, United States', category: '', owner: 'max' }, { country: '', category: 'high-bay', owner: 'sue' }], poolDays: 7 });
    assert.equal(CRM.getLead(lead({ country: 'united states' })).owner, 'max');
    assert.equal(CRM.getLead(lead({ country: 'DE', product_id: 'YR-HB-U2' })).owner, 'sue', 'UFO high bay is in the high-bay category');
    const rr = [lead({ country: 'DE' }), lead({ country: 'FR' }), lead({ country: 'IT' })].map((id) => CRM.getLead(id).owner);
    assert.deepEqual(rr, ['sam', 'sue', 'sam']);
    assert.match(CRM.leadLogOf(lead({ country: 'US' }))[0].note, /分配给 max（规则：国家 US, United States）/);
    CRM.saveAssignSettings({ mode: 'manual', members: ['sam'], rules: [], poolDays: 7 });
    const id = lead({ country: 'US' });
    assert.equal(CRM.getLead(id).owner, null);
    assert.equal(CRM.leadLogOf(id)[0].action, 'pool');
    assert.throws(() => CRM.saveAssignSettings({ mode: 'x', poolDays: 7 }), /分配方式/);
    assert.throws(() => CRM.saveAssignSettings({ mode: 'manual', poolDays: 7, rules: [{ country: 'US', owner: 'ghost' }] }), /ghost/);
    assert.throws(() => CRM.saveAssignSettings({ mode: 'manual', poolDays: -1 }), /0–365/);
  });
  test('CR-02 a salesperson sees own leads and the pool; a manager sees everything and can filter by owner', () => {
    const sam = CRM.listLeadsFor(user('sam'), { scope: 'all' });
    assert.ok(sam.every((l) => l.owner === 'sam' || l.owner === null));
    assert.ok(sam.some((l) => l.owner === null));
    assert.ok(CRM.listLeadsFor(user('sam'), { scope: 'mine' }).every((l) => l.owner === 'sam'));
    assert.ok(CRM.listLeadsFor(user('sam'), { scope: 'pool' }).every((l) => l.owner === null));
    const max = CRM.listLeadsFor(user('max'), { scope: 'all' });
    assert.ok(max.some((l) => l.owner === 'sue'));
    assert.ok(CRM.listLeadsFor(user('max'), { scope: 'all', owner: 'sue' }).every((l) => l.owner === 'sue'));
    const sues = CRM.listLeadsFor(user('max'), { scope: 'all', owner: 'sue' })[0];
    assert.equal(CRM.canSeeLead(user('sam'), sues), false);
    assert.equal(CRM.canSeeLead(user('max'), sues), true);
  });
  test('CR-03 claim (only once), transfer, release — each logged', () => {
    const id = lead();
    CRM.claimLead(id, user('sam'));
    assert.throws(() => CRM.claimLead(id, user('sue')), /已被别人领取/);
    CRM.transferLead(id, 'sue', 'sam');
    assert.equal(CRM.getLead(id).owner, 'sue');
    assert.throws(() => CRM.transferLead(id, 'sue'), /已经是/);
    assert.throws(() => CRM.transferLead(id, 'ghost'), /不存在/);
    assert.throws(() => CRM.releaseLead(id, user('sam')), /只能放回自己的/);
    CRM.releaseLead(id, user('sue'), '客户已转向别家');
    assert.equal(CRM.getLead(id).owner, null);
    assert.deepEqual(CRM.leadLogOf(id).map((x) => x.action), ['release', 'transfer', 'claim', 'pool']);
  });
  test('CR-04 leads nobody followed up for N days go back to the pool; closed leads stay; 0 days switches it off', () => {
    CRM.saveAssignSettings({ mode: 'manual', members: [], rules: [], poolDays: 7 });
    const stale = lead(), won = lead(), fresh = lead();
    for (const id of [stale, won, fresh]) CRM.claimLead(id, user('sam'));
    const old = new Date(Date.now() - 8 * 86400e3).toISOString();
    db.prepare('UPDATE leads SET assigned_at = ? WHERE id IN (?, ?)').run(old, stale, won);
    db.prepare("UPDATE leads SET status = 'won' WHERE id = ?").run(won);
    assert.equal(CRM.recyclePool(), 1);
    assert.equal(CRM.getLead(stale).owner, null);
    assert.equal(CRM.getLead(won).owner, 'sam');
    assert.equal(CRM.getLead(fresh).owner, 'sam');
    assert.match(CRM.leadLogOf(stale)[0].note, /sam 超过 7 天未跟进/);
    CRM.saveAssignSettings({ mode: 'manual', members: [], rules: [], poolDays: 0 });
    db.prepare('UPDATE leads SET assigned_at = ? WHERE id = ?').run(old, fresh);
    assert.equal(CRM.recyclePool(), 0);
  });
});

describe('follow-ups', () => {
  test('CR-05 a follow-up moves a new lead to "contacted", sets the next date; due list; only the owner (or a manager)', () => {
    const id = lead();
    CRM.claimLead(id, user('sam'));
    const past = new Date(Date.now() - 3600e3).toISOString();
    CRM.addFollowup(id, { kind: 'whatsapp', content: 'Sent catalogue, wants samples', nextAt: past }, user('sam'));
    const l = CRM.getLead(id);
    assert.equal(l.status, 'contacted');
    assert.equal(l.next_follow_at, past);
    assert.ok(CRM.dueFollowups('sam').some((x) => x.id === id));
    assert.equal(CRM.followupsOf(id)[0].kind, 'whatsapp');
    assert.throws(() => CRM.addFollowup(id, { content: 'x' }, user('sue')), /无权/);
    CRM.addFollowup(id, { kind: 'call', content: 'manager call' }, user('max'));
    assert.equal(CRM.getLead(id).next_follow_at, null, 'no next date: no longer due');
    assert.throws(() => CRM.addFollowup(id, { kind: 'fax', content: 'x' }, user('sam')), /方式无效/);
    assert.throws(() => CRM.addFollowup(id, { content: ' ' }, user('sam')), /跟进内容/);
    assert.throws(() => CRM.addFollowup(id, { content: 'x', nextAt: 'soon' }, user('sam')), /时间无效/);
    const pool = lead();
    CRM.addFollowup(pool, { content: 'picked up from the pool by following up' }, user('sue'));
    assert.equal(CRM.getLead(pool).owner, 'sue', 'following up a pool lead takes it');
  });
});

describe('quotes', () => {
  test('CR-06 quote owner = the lead owner; templates bring terms and products in at reference prices', () => {
    const id = lead({ email: 'tpl@x.test', company: 'Tpl Co' });
    CRM.claimLead(id, user('sue'));
    const q = S.createQuote({ customer: { email: 'tpl@x.test', company: 'Tpl Co' }, lead_id: id, lines: [{ sku: 'YR-HB-U2', qty: 10, unit_price: 50 }] });
    assert.equal(S.getQuote(q.id).owner, 'sue');
    const q2 = runAs({ username: 'sam' }, () => S.createQuote({ customer: { email: 'walkin@x.test' } }));
    assert.equal(S.getQuote(q2.id).owner, 'sam', 'no lead: whoever created it');
    CRM.saveQuoteTemplate({ name: 'US warehouse kit', terms: { currency: 'USD', incoterm: 'DDP', port: 'Houston', payment_terms: 'tt30', validity_days: 30, notes: '5-year warranty', bogus: 'x' }, lines: [{ sku: 'YR-HB-U2', qty: 50 }, { sku: '' }] });
    const t = CRM.listQuoteTemplates().find((x) => x.name === 'US warehouse kit');
    assert.deepEqual(Object.keys(t.terms).sort(), ['currency', 'incoterm', 'notes', 'payment_terms', 'port', 'validity_days']);
    assert.equal(t.lines.length, 1);
    const r = CRM.applyQuoteTemplate(q.id, t.id);
    assert.equal(r.added, 1);
    const after = S.getQuote(q.id);
    assert.deepEqual([after.incoterm, after.port, after.validity_days, after.notes], ['DDP', 'Houston', 30, '5-year warranty']);
    assert.deepEqual(after.lines.map((l) => [l.sku, l.qty, l.unit_price]), [['YR-HB-U2', 10, 50], ['YR-HB-U2', 50, S.getSku('YR-HB-U2').ref_price]]);
    CRM.saveQuoteTemplate({ name: 'US warehouse kit', terms: { incoterm: 'FOB' }, lines: [] });
    assert.equal(CRM.listQuoteTemplates().filter((x) => x.name === 'US warehouse kit').length, 1, 'same name replaces');
    assert.throws(() => CRM.saveQuoteTemplate({ name: ' ' }), /名称/);
    assert.throws(() => CRM.applyQuoteTemplate(q.id, 9999), /模板不存在/);
  });
  test('CR-07 customer link views: counted, first open alerts once with the owner', async () => {
    const q = S.listQuotes().find((x) => x.company === 'Tpl Co');
    hooks.length = 0;
    CRM.recordView('quote', q.id, { ip: '1.2.3.4', ua: 'Safari' });
    CRM.recordView('quote', q.id, { ip: '1.2.3.4', ua: 'Safari' });
    await settle();
    const v = CRM.viewsOf('quote', q.id);
    assert.equal(v.count, 2);
    assert.ok(v.first <= v.last);
    assert.equal(hooks.length, 1);
    assert.match(hooks[0].markdown.content, /客户打开了报价[\s\S]*Tpl Co[\s\S]*负责人：sue/);
    assert.equal(CRM.viewsOf('contract', 'none').count, 0);
  });
});

describe('customers', () => {
  test('CR-08 tier, VIP, tags, birthday; upcoming birthdays and holidays; holiday list validation', () => {
    const c = S.findOrCreateCustomer({ email: 'vip@x.test', company: 'VIP Lighting' });
    const md = (d) => new Date(Date.now() + d * 86400e3).toISOString().slice(5, 10);
    CRM.saveCustomerCrm(c.id, { tier: 'dealer', vip: true, tags: '大客户, 中东，大客户', birthday: md(3), owner: 'sam' });
    const row = S.getCustomer(c.id);
    assert.deepEqual([row.tier, row.vip, JSON.parse(row.tags), row.owner], ['dealer', 1, ['大客户', '中东'], 'sam']);
    assert.deepEqual(CRM.customerTags().filter((t) => ['大客户', '中东'].includes(t)).sort(), ['中东', '大客户'].sort());
    CRM.saveHolidays(`${md(5)} 斋月结束\n01-01 元旦`);
    const up = CRM.upcomingDates(7);
    assert.ok(up.some((x) => x.kind === 'birthday' && x.in === 3 && x.customer.company === 'VIP Lighting'));
    assert.ok(up.some((x) => x.kind === 'holiday' && x.name === '斋月结束' && x.in === 5 && x.vipCount >= 1));
    assert.equal(CRM.upcomingDates(7, Date.now(), 'sue').filter((x) => x.kind === 'birthday').length, 0, "someone else's customer");
    assert.throws(() => CRM.saveCustomerCrm(c.id, { tier: 'king' }), /客户类型/);
    assert.throws(() => CRM.saveCustomerCrm(c.id, { birthday: '1990-03-18' }), /月-日/);
    assert.throws(() => CRM.saveCustomerCrm(c.id, { owner: 'ghost' }), /负责人/);
    assert.throws(() => CRM.saveHolidays('Christmas 12-25'), /格式/);
  });
});

describe('performance', () => {
  test('CR-09 per person and month: leads, follow-ups, quotes, won, received, target and conversion rates', () => {
    const month = new Date().toISOString().slice(0, 7);
    CRM.setTarget('sue', month, 1000);
    const q = S.listQuotes().find((x) => x.company === 'Tpl Co');
    S.setQuoteStatus(q.id, 'sent');
    const o = S.acceptQuote(q.id);
    S.recordPayment(o.id, { kind: 'deposit', amount: 100 });
    const p = CRM.performance([month]);
    const sue = p.find((x) => x.username === 'sue').months[month];
    assert.ok(sue.leads >= 1);
    assert.equal(sue.quotes, 1);
    assert.equal(sue.won, 1);
    assert.equal(sue.wonAmount, S.getQuote(q.id).total);
    assert.equal(sue.received, 100);
    assert.equal(sue.target, 1000);
    assert.equal(sue.completion, sue.wonAmount / 1000);
    assert.equal(sue.quoteToWon, 1);
    assert.ok(p.find((x) => x.username === 'sam').months[month].followed >= 1);
    assert.deepEqual(CRM.performance([month], { users: ['sam'] }).map((x) => x.username), ['sam']);
    assert.deepEqual(CRM.lastMonths(3, Date.parse('2026-01-15T00:00:00Z')), ['2025-11', '2025-12', '2026-01']);
    assert.throws(() => CRM.setTarget('sue', '2026/11', 1), /月份/);
    assert.throws(() => CRM.setTarget('sue', month, -5), /不小于 0/);
  });
});
