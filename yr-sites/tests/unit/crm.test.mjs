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
  test('CR-01a a country-list rule assigns the lead to the rule owner', () => {
    CRM.saveAssignSettings({ mode: 'round_robin', members: ['sam', 'sue'], rules: [{ country: 'US, United States', category: '', owner: 'max' }, { country: '', category: 'high-bay', owner: 'sue' }], poolDays: 7 });
    assert.equal(CRM.getLead(lead({ country: 'united states' })).owner, 'max');
  });
  test('CR-01b a product-category rule assigns the lead to the rule owner', () => {
    assert.equal(CRM.getLead(lead({ country: 'DE', product_id: 'YR-HB-U2' })).owner, 'sue', 'UFO high bay is in the high-bay category');
  });
  test('CR-01c leads matching no rule are assigned round robin', () => {
    const rr = [lead({ country: 'DE' }), lead({ country: 'FR' }), lead({ country: 'IT' })].map((id) => CRM.getLead(id).owner);
    assert.deepEqual(rr, ['sam', 'sue', 'sam']);
  });
  test('CR-01d the assignment is logged with the rule that matched', () => {
    assert.match(CRM.leadLogOf(lead({ country: 'US' }))[0].note, /分配给 max（规则：国家 US, United States）/);
  });
  test('CR-01e manual mode sends new leads to the pool and logs it', () => {
    CRM.saveAssignSettings({ mode: 'manual', members: ['sam'], rules: [], poolDays: 7 });
    const id = lead({ country: 'US' });
    assert.equal(CRM.getLead(id).owner, null);
    assert.equal(CRM.leadLogOf(id)[0].action, 'pool');
  });
  test('CR-01f an unknown assignment mode is refused', () => {
    assert.throws(() => CRM.saveAssignSettings({ mode: 'x', poolDays: 7 }), /分配方式/);
  });
  test('CR-01g a rule pointing at an unknown user is refused', () => {
    assert.throws(() => CRM.saveAssignSettings({ mode: 'manual', poolDays: 7, rules: [{ country: 'US', owner: 'ghost' }] }), /ghost/);
  });
  test('CR-01h pool days outside 0–365 are refused', () => {
    assert.throws(() => CRM.saveAssignSettings({ mode: 'manual', poolDays: -1 }), /0–365/);
  });
  test('CR-02a a salesperson viewing "all" sees only own leads and the pool', () => {
    const sam = CRM.listLeadsFor(user('sam'), { scope: 'all' });
    assert.ok(sam.every((l) => l.owner === 'sam' || l.owner === null));
    assert.ok(sam.some((l) => l.owner === null));
  });
  test('CR-02b the "mine" scope lists only the salesperson\'s own leads', () => {
    assert.ok(CRM.listLeadsFor(user('sam'), { scope: 'mine' }).every((l) => l.owner === 'sam'));
  });
  test('CR-02c the "pool" scope lists only unowned leads', () => {
    assert.ok(CRM.listLeadsFor(user('sam'), { scope: 'pool' }).every((l) => l.owner === null));
  });
  test('CR-02d a manager sees other people\'s leads', () => {
    const max = CRM.listLeadsFor(user('max'), { scope: 'all' });
    assert.ok(max.some((l) => l.owner === 'sue'));
  });
  test('CR-02e a manager can filter leads by owner', () => {
    assert.ok(CRM.listLeadsFor(user('max'), { scope: 'all', owner: 'sue' }).every((l) => l.owner === 'sue'));
  });
  test('CR-02f canSeeLead: a colleague\'s lead is hidden from a salesperson but visible to a manager', () => {
    const sues = CRM.listLeadsFor(user('max'), { scope: 'all', owner: 'sue' })[0];
    assert.equal(CRM.canSeeLead(user('sam'), sues), false);
    assert.equal(CRM.canSeeLead(user('max'), sues), true);
  });
  const own = {};
  test('CR-03a a claimed lead cannot be claimed by someone else', () => {
    own.id = lead();
    CRM.claimLead(own.id, user('sam'));
    assert.throws(() => CRM.claimLead(own.id, user('sue')), /已被别人领取/);
  });
  test('CR-03b transferring a lead changes its owner', () => {
    CRM.transferLead(own.id, 'sue', 'sam');
    assert.equal(CRM.getLead(own.id).owner, 'sue');
  });
  test('CR-03c transfer to the current owner or to an unknown user is refused', () => {
    assert.throws(() => CRM.transferLead(own.id, 'sue'), /已经是/);
    assert.throws(() => CRM.transferLead(own.id, 'ghost'), /不存在/);
  });
  test('CR-03d only the owner can release a lead', () => {
    assert.throws(() => CRM.releaseLead(own.id, user('sam')), /只能放回自己的/);
  });
  test('CR-03e releasing a lead puts it back in the pool', () => {
    CRM.releaseLead(own.id, user('sue'), '客户已转向别家');
    assert.equal(CRM.getLead(own.id).owner, null);
  });
  test('CR-03f pool, claim, transfer and release are each logged', () => {
    assert.deepEqual(CRM.leadLogOf(own.id).map((x) => x.action), ['release', 'transfer', 'claim', 'pool']);
  });
  const rec = {};
  test('CR-04a a lead not followed up for more than N days goes back to the pool', () => {
    CRM.saveAssignSettings({ mode: 'manual', members: [], rules: [], poolDays: 7 });
    rec.stale = lead(); rec.won = lead(); rec.fresh = lead();
    for (const id of [rec.stale, rec.won, rec.fresh]) CRM.claimLead(id, user('sam'));
    rec.old = new Date(Date.now() - 8 * 86400e3).toISOString();
    db.prepare('UPDATE leads SET assigned_at = ? WHERE id IN (?, ?)').run(rec.old, rec.stale, rec.won);
    db.prepare("UPDATE leads SET status = 'won' WHERE id = ?").run(rec.won);
    assert.equal(CRM.recyclePool(), 1);
    assert.equal(CRM.getLead(rec.stale).owner, null);
  });
  test('CR-04b recycling to the pool is logged with the reason', () => {
    assert.match(CRM.leadLogOf(rec.stale)[0].note, /sam 超过 7 天未跟进/);
  });
  test('CR-04c a closed (won) lead stays with its owner', () => {
    assert.equal(CRM.getLead(rec.won).owner, 'sam');
  });
  test('CR-04d a recently assigned lead stays with its owner', () => {
    assert.equal(CRM.getLead(rec.fresh).owner, 'sam');
  });
  test('CR-04e pool days 0 switches recycling off', () => {
    CRM.saveAssignSettings({ mode: 'manual', members: [], rules: [], poolDays: 0 });
    db.prepare('UPDATE leads SET assigned_at = ? WHERE id = ?').run(rec.old, rec.fresh);
    assert.equal(CRM.recyclePool(), 0);
  });
});

describe('follow-ups', () => {
  const fu = {};
  test('CR-05a a follow-up moves a new lead to "contacted" and is recorded with its kind', () => {
    fu.id = lead();
    CRM.claimLead(fu.id, user('sam'));
    fu.past = new Date(Date.now() - 3600e3).toISOString();
    CRM.addFollowup(fu.id, { kind: 'whatsapp', content: 'Sent catalogue, wants samples', nextAt: fu.past }, user('sam'));
    assert.equal(CRM.getLead(fu.id).status, 'contacted');
    assert.equal(CRM.followupsOf(fu.id)[0].kind, 'whatsapp');
  });
  test('CR-05b the next follow-up date is set and the lead appears in the owner\'s due list', () => {
    assert.equal(CRM.getLead(fu.id).next_follow_at, fu.past);
    assert.ok(CRM.dueFollowups('sam').some((x) => x.id === fu.id));
  });
  test('CR-05c a salesperson cannot follow up someone else\'s lead', () => {
    assert.throws(() => CRM.addFollowup(fu.id, { content: 'x' }, user('sue')), /无权/);
  });
  test('CR-05d a manager can follow up; without a next date the lead is no longer due', () => {
    CRM.addFollowup(fu.id, { kind: 'call', content: 'manager call' }, user('max'));
    assert.equal(CRM.getLead(fu.id).next_follow_at, null, 'no next date: no longer due');
  });
  test('CR-05e an unknown follow-up kind is refused', () => {
    assert.throws(() => CRM.addFollowup(fu.id, { kind: 'fax', content: 'x' }, user('sam')), /方式无效/);
  });
  test('CR-05f an empty follow-up is refused', () => {
    assert.throws(() => CRM.addFollowup(fu.id, { content: ' ' }, user('sam')), /跟进内容/);
  });
  test('CR-05g an invalid next follow-up date is refused', () => {
    assert.throws(() => CRM.addFollowup(fu.id, { content: 'x', nextAt: 'soon' }, user('sam')), /时间无效/);
  });
  test('CR-05h following up a pool lead takes it', () => {
    const pool = lead();
    CRM.addFollowup(pool, { content: 'picked up from the pool by following up' }, user('sue'));
    assert.equal(CRM.getLead(pool).owner, 'sue', 'following up a pool lead takes it');
  });
});

describe('quotes', () => {
  const qt = {};
  test('CR-06a a quote for a lead belongs to the lead owner', () => {
    const id = lead({ email: 'tpl@x.test', company: 'Tpl Co' });
    CRM.claimLead(id, user('sue'));
    qt.q = S.createQuote({ customer: { email: 'tpl@x.test', company: 'Tpl Co' }, lead_id: id, lines: [{ sku: 'YR-HB-U2', qty: 10, unit_price: 50 }] });
    assert.equal(S.getQuote(qt.q.id).owner, 'sue');
  });
  test('CR-06b a quote without a lead belongs to whoever created it', () => {
    const q2 = runAs({ username: 'sam' }, () => S.createQuote({ customer: { email: 'walkin@x.test' } }));
    assert.equal(S.getQuote(q2.id).owner, 'sam', 'no lead: whoever created it');
  });
  test('CR-06c a saved quote template keeps only known terms and non-empty lines', () => {
    CRM.saveQuoteTemplate({ name: 'US warehouse kit', terms: { currency: 'USD', incoterm: 'DDP', port: 'Houston', payment_terms: 'tt30', validity_days: 30, notes: '5-year warranty', bogus: 'x' }, lines: [{ sku: 'YR-HB-U2', qty: 50 }, { sku: '' }] });
    const t = qt.t = CRM.listQuoteTemplates().find((x) => x.name === 'US warehouse kit');
    assert.deepEqual(Object.keys(t.terms).sort(), ['currency', 'incoterm', 'notes', 'payment_terms', 'port', 'validity_days']);
    assert.equal(t.lines.length, 1);
  });
  test('CR-06d applying a template sets its terms and adds its products at the reference price', () => {
    const r = CRM.applyQuoteTemplate(qt.q.id, qt.t.id);
    assert.equal(r.added, 1);
    const after = S.getQuote(qt.q.id);
    assert.deepEqual([after.incoterm, after.port, after.validity_days, after.notes], ['DDP', 'Houston', 30, '5-year warranty']);
    assert.deepEqual(after.lines.map((l) => [l.sku, l.qty, l.unit_price]), [['YR-HB-U2', 10, 50], ['YR-HB-U2', 50, S.getSku('YR-HB-U2').ref_price]]);
  });
  test('CR-06e saving a template with an existing name replaces it', () => {
    CRM.saveQuoteTemplate({ name: 'US warehouse kit', terms: { incoterm: 'FOB' }, lines: [] });
    assert.equal(CRM.listQuoteTemplates().filter((x) => x.name === 'US warehouse kit').length, 1, 'same name replaces');
  });
  test('CR-06f a template without a name is refused', () => {
    assert.throws(() => CRM.saveQuoteTemplate({ name: ' ' }), /名称/);
  });
  test('CR-06g applying an unknown template is refused', () => {
    assert.throws(() => CRM.applyQuoteTemplate(qt.q.id, 9999), /模板不存在/);
  });
  const vw = {};
  test('CR-07a customer link views are counted with first and last time', async () => {
    vw.q = S.listQuotes().find((x) => x.company === 'Tpl Co');
    hooks.length = 0;
    CRM.recordView('quote', vw.q.id, { ip: '1.2.3.4', ua: 'Safari' });
    CRM.recordView('quote', vw.q.id, { ip: '1.2.3.4', ua: 'Safari' });
    await settle();
    const v = CRM.viewsOf('quote', vw.q.id);
    assert.equal(v.count, 2);
    assert.ok(v.first <= v.last);
  });
  test('CR-07b the first open sends one alert naming the customer and the owner', () => {
    assert.equal(hooks.length, 1);
    assert.match(hooks[0].markdown.content, /客户打开了报价[\s\S]*Tpl Co[\s\S]*负责人：sue/);
  });
  test('CR-07c a document never opened has zero views', () => {
    assert.equal(CRM.viewsOf('contract', 'none').count, 0);
  });
});

describe('customers', () => {
  const cu = {};
  const md = (d) => new Date(Date.now() + d * 86400e3).toISOString().slice(5, 10);
  test('CR-08a tier, VIP, tags (de-duplicated), birthday and owner are saved on the customer', () => {
    const c = cu.c = S.findOrCreateCustomer({ email: 'vip@x.test', company: 'VIP Lighting' });
    CRM.saveCustomerCrm(c.id, { tier: 'dealer', vip: true, tags: '大客户, 中东，大客户', birthday: md(3), owner: 'sam' });
    const row = S.getCustomer(c.id);
    assert.deepEqual([row.tier, row.vip, JSON.parse(row.tags), row.owner], ['dealer', 1, ['大客户', '中东'], 'sam']);
  });
  test('CR-08b customer tags appear in the tag list', () => {
    assert.deepEqual(CRM.customerTags().filter((t) => ['大客户', '中东'].includes(t)).sort(), ['中东', '大客户'].sort());
  });
  test('CR-08c an upcoming customer birthday is listed with the days left', () => {
    CRM.saveHolidays(`${md(5)} 斋月结束\n01-01 元旦`);
    cu.up = CRM.upcomingDates(7);
    assert.ok(cu.up.some((x) => x.kind === 'birthday' && x.in === 3 && x.customer.company === 'VIP Lighting'));
  });
  test('CR-08d an upcoming holiday is listed with the days left and the VIP count', () => {
    assert.ok(cu.up.some((x) => x.kind === 'holiday' && x.name === '斋月结束' && x.in === 5 && x.vipCount >= 1));
  });
  test('CR-08e birthdays of another salesperson\'s customers are not listed', () => {
    assert.equal(CRM.upcomingDates(7, Date.now(), 'sue').filter((x) => x.kind === 'birthday').length, 0, "someone else's customer");
  });
  test('CR-08f an unknown customer tier is refused', () => {
    assert.throws(() => CRM.saveCustomerCrm(cu.c.id, { tier: 'king' }), /客户类型/);
  });
  test('CR-08g a birthday not in MM-DD format is refused', () => {
    assert.throws(() => CRM.saveCustomerCrm(cu.c.id, { birthday: '1990-03-18' }), /月-日/);
  });
  test('CR-08h an unknown customer owner is refused', () => {
    assert.throws(() => CRM.saveCustomerCrm(cu.c.id, { owner: 'ghost' }), /负责人/);
  });
  test('CR-08i a holiday line in the wrong format is refused', () => {
    assert.throws(() => CRM.saveHolidays('Christmas 12-25'), /格式/);
  });
});

describe('performance', () => {
  const pf = {};
  test('CR-09a performance counts leads and quotes per person and month', () => {
    pf.month = new Date().toISOString().slice(0, 7);
    CRM.setTarget('sue', pf.month, 1000);
    pf.q = S.listQuotes().find((x) => x.company === 'Tpl Co');
    S.setQuoteStatus(pf.q.id, 'sent');
    const o = S.acceptQuote(pf.q.id);
    S.recordPayment(o.id, { kind: 'deposit', amount: 100 });
    pf.p = CRM.performance([pf.month]);
    pf.sue = pf.p.find((x) => x.username === 'sue').months[pf.month];
    assert.ok(pf.sue.leads >= 1);
    assert.equal(pf.sue.quotes, 1);
  });
  test('CR-09b performance counts won deals and their amount', () => {
    assert.equal(pf.sue.won, 1);
    assert.equal(pf.sue.wonAmount, S.getQuote(pf.q.id).total);
  });
  test('CR-09c performance sums the money received', () => {
    assert.equal(pf.sue.received, 100);
  });
  test('CR-09d performance shows the target and its completion rate', () => {
    assert.equal(pf.sue.target, 1000);
    assert.equal(pf.sue.completion, pf.sue.wonAmount / 1000);
  });
  test('CR-09e performance shows the quote-to-won conversion rate', () => {
    assert.equal(pf.sue.quoteToWon, 1);
  });
  test('CR-09f performance counts follow-ups', () => {
    assert.ok(pf.p.find((x) => x.username === 'sam').months[pf.month].followed >= 1);
  });
  test('CR-09g performance can be limited to selected users', () => {
    assert.deepEqual(CRM.performance([pf.month], { users: ['sam'] }).map((x) => x.username), ['sam']);
  });
  test('CR-09h lastMonths returns the last N months across a year boundary', () => {
    assert.deepEqual(CRM.lastMonths(3, Date.parse('2026-01-15T00:00:00Z')), ['2025-11', '2025-12', '2026-01']);
  });
  test('CR-09i a target with an invalid month is refused', () => {
    assert.throws(() => CRM.setTarget('sue', '2026/11', 1), /月份/);
  });
  test('CR-09j a negative target is refused', () => {
    assert.throws(() => CRM.setTarget('sue', pf.month, -5), /不小于 0/);
  });
});
