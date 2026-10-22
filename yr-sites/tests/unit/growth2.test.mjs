// Modules: server/src/marketing/email.js (e-mail marketing), seo.js (keywords, AI mention trend) and the new arrivals
// zone in catalog/store.js. IDs EM-xx, SE-xx, NA-xx.
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { useTempEnv } from '../helpers/env.mjs';
import { waitFor } from '../helpers/server.mjs';

useTempEnv({ site: 'led', SMTP_URL: '' });
const E = await import('../../server/src/marketing/email.js');
const SEO = await import('../../server/src/marketing/seo.js');
const T = await import('../../server/src/tasks.js');
const S = await import('../../server/src/ops/service.js');
const C = await import('../../server/src/catalog/store.js');
const CRM = await import('../../server/src/sales/crm.js');
const { db } = await import('../../server/src/db.js');

const customer = (email, { opt = 1, tags = '', tier = '', vip = false, lang = 'en', contact = '' } = {}) => {
  const c = S.findOrCreateCustomer({ email, contact, lang });
  db.prepare('UPDATE customers SET marketing_opt_in = ?, lang = ? WHERE id = ?').run(opt, lang, c.id);
  CRM.saveCustomerCrm(c.id, { tier, vip, tags });
  return c.id;
};
const ids = {
  dealer: customer('dealer@x.test', { tags: '中东, 大客户', tier: 'dealer', vip: true, contact: 'Omar' }),
  contractor: customer('con@x.test', { tier: 'contractor', lang: 'zh', contact: '王工' }),
  noOpt: customer('noopt@x.test', { opt: 0, tier: 'dealer' }),
};

describe('e-mail marketing', () => {
  const emails = (a) => E.audienceOf(a).map((c) => c.email).sort();
  test('EM-01a the audience without filters is every customer who opted in', () => {
    assert.deepEqual(emails({}), ['con@x.test', 'dealer@x.test']);
  });
  test('EM-01b the audience filters by customer type and skips those who did not opt in', () => {
    assert.deepEqual(emails({ tier: 'dealer' }), ['dealer@x.test'], 'noopt@ is a dealer but did not opt in');
  });
  test('EM-01c the audience filters by tag', () => {
    assert.deepEqual(emails({ tags: '大客户' }), ['dealer@x.test']);
  });
  test('EM-01d the audience filters by VIP', () => {
    assert.deepEqual(emails({ vip: '1' }), ['dealer@x.test']);
  });
  test('EM-01e the audience filters by language', () => {
    assert.deepEqual(emails({ lang: 'zh' }), ['con@x.test']);
  });
  test('EM-02a a draft without a subject is rejected', () => {
    assert.throws(() => E.saveEmailCampaign({ subject: '', body: 'long enough body' }), /标题/);
  });
  test('EM-02b a draft with a body under 10 characters is rejected', () => {
    assert.throws(() => E.saveEmailCampaign({ subject: 'Hi', body: 'short' }), /至少 10/);
  });
  let c2, m2;
  test('EM-02c saving a draft again with its id edits it', () => {
    const id = E.saveEmailCampaign({ subject: 'New UFO high bay', body: 'Hello {{name}},\n\nOur new UFO is out: https://example.test/products/ufo/\n\nBest regards', audience: { tier: 'dealer' } });
    E.saveEmailCampaign({ id, subject: 'New UFO high bay — 15% off', body: 'Hello {{name}},\n\nOur new UFO is out: https://example.test/products/ufo/', audience: { tier: 'dealer' } });
    c2 = E.getEmailCampaign(id);
    assert.equal(c2.subject, 'New UFO high bay — 15% off');
  });
  test('EM-02d the rendered message greets the recipient by name', () => {
    m2 = E.renderEmail(c2, { token: 'TOK', contact: 'Omar', lang: 'en' });
    assert.match(m2.text, /^Hello Omar,/);
  });
  test('EM-02e the text part ends with a personal unsubscribe link', () => {
    assert.match(m2.text, /Unsubscribe: https:\/\/example\.test\/m\/u\/TOK/);
  });
  test('EM-02f the HTML part turns URLs into links', () => {
    assert.match(m2.html, /<a href="https:\/\/example\.test\/products\/ufo\/">/);
  });
  test('EM-02g the HTML part carries a tracking pixel', () => {
    assert.match(m2.html, /<img src="https:\/\/example\.test\/m\/o\/TOK\.gif"/);
  });
  test('EM-02h the message has a List-Unsubscribe header', () => {
    assert.equal(m2.headers['List-Unsubscribe'], '<https://example.test/m/u/TOK>');
  });
  test('EM-02i a Chinese recipient gets the unsubscribe line in Chinese', () => {
    assert.match(E.renderEmail(c2, { token: 'T2', contact: '', lang: 'zh' }).text, /退订：/);
  });
  let id3, r3;
  test('EM-03a sending freezes the recipient list', () => {
    id3 = E.listEmailCampaigns().find((x) => x.subject.startsWith('New UFO')).id;
    r3 = E.sendEmailCampaign(id3);
    assert.equal(r3.recipients, 1);
  });
  test('EM-03b messages go out through the task center', async () => {
    await waitFor(() => T.tasksIdle());
    const t = T.getTask(r3.taskId);
    assert.equal(t.status, 'done');
    assert.match(t.items[0].result, /已记录/);
  });
  test('EM-03c stats after sending show sent, not yet opened', () => {
    const st = E.emailStats(id3);
    assert.deepEqual([st.total, st.sent, st.opened, st.openRate], [1, 1, 0, 0]);
  });
  test('EM-03d the message is in the mail outbox', () => {
    assert.ok(db.prepare("SELECT 1 FROM mail_outbox WHERE to_addr = 'dealer@x.test' AND subject LIKE 'New UFO%'").get());
  });
  test('EM-03e a sent campaign cannot be sent again', () => {
    assert.throws(() => E.sendEmailCampaign(id3), /已经发送/);
  });
  test('EM-03f a sent campaign cannot be edited', () => {
    assert.throws(() => E.saveEmailCampaign({ id: id3, subject: 'x', body: 'changed body text' }), /不能修改/);
  });
  test('EM-03g a sent campaign cannot be deleted', () => {
    assert.throws(() => E.deleteEmailCampaign(id3), /不能删除/);
  });
  test('EM-03h a campaign with nobody in its audience is refused', () => {
    const none = E.saveEmailCampaign({ subject: 'Nobody', body: 'nobody gets this one', audience: { tags: 'nonexistent' } });
    assert.throws(() => E.sendEmailCampaign(none), /没有符合条件/);
  });
  let id4, tok;
  test('EM-04a opens count once per recipient while every open is stored', () => {
    id4 = E.listEmailCampaigns().find((x) => x.subject.startsWith('New UFO')).id;
    tok = db.prepare('SELECT token FROM email_recipients WHERE campaign_id = ?').get(id4).token;
    E.recordOpen(tok); E.recordOpen(tok);
    assert.deepEqual([E.emailStats(id4).opened, E.emailStats(id4).openRate], [1, 1]);
    assert.equal(db.prepare('SELECT opens FROM email_recipients WHERE token = ?').get(tok).opens, 2);
  });
  test('EM-04b unsubscribing returns the recipient language; an unknown token returns null', () => {
    assert.equal(E.unsubscribe(tok), 'en');
    assert.equal(E.unsubscribe('nope'), null);
  });
  test('EM-04c unsubscribing is counted and turns marketing e-mail off for the customer', () => {
    assert.equal(E.emailStats(id4).unsubscribed, 1);
    assert.equal(db.prepare('SELECT marketing_opt_in FROM customers WHERE id = ?').get(ids.dealer).marketing_opt_in, 0);
  });
  test('EM-04d later audiences skip the unsubscribed customer', () => {
    assert.deepEqual(E.audienceOf({}).map((c) => c.email), ['con@x.test']);
  });
});

describe('keywords & AI mentions', () => {
  let k;
  test('SE-01a a keyword differing only in case is refused as a duplicate', () => {
    k = SEO.addKeyword({ keyword: 'UFO High Bay Light', lang: 'en', target_url: '/products/ufo-high-bay-u2/' });
    assert.throws(() => SEO.addKeyword({ keyword: 'ufo high bay light' }), /已存在/);
  });
  test('SE-01b a second position on the same day overwrites; change is measured since last time', () => {
    SEO.recordRank(k, { day: '2026-10-01', position: 18 });
    SEO.recordRank(k, { day: '2026-10-08', position: 12 });
    SEO.recordRank(k, { day: '2026-10-08', position: 9 });
    const row = SEO.keywordTable().find((x) => x.id === k);
    assert.deepEqual([row.last.position, row.prev.position, row.change, row.hist.length], [9, 18, 9, 2]);
  });
  test('SE-01c a position outside 1–100 is rejected', () => {
    assert.throws(() => SEO.recordRank(k, { position: 101 }), /1–100/);
  });
  test('SE-01d an unknown search engine is rejected', () => {
    assert.throws(() => SEO.recordRank(k, { engine: 'yahoo' }), /搜索引擎/);
  });
  let r1;
  test('SE-01e import records good lines, adds new keywords and reports bad lines by number', () => {
    r1 = SEO.importRanks('keyword, position, url, engine, date\nufo high bay light, 7, https://x/, google, 2026-10-15\n工矿灯, 3, , baidu, 2026-10-15\nbad line, 500');
    assert.deepEqual([r1.recorded, r1.added, r1.errors.length], [2, 2, 1]);
    assert.match(r1.errors[0], /第 4 行/);
  });
  test('SE-01f imported positions show per engine and new keywords get their language detected', () => {
    const row = SEO.keywordTable().find((x) => x.id === k);
    assert.equal(row.last.position, 7);
    assert.equal(SEO.keywordTable('baidu').find((x) => x.keyword === '工矿灯').last.position, 3);
    assert.equal(SEO.keywordTable().find((x) => x.keyword === '工矿灯').lang, 'zh');
  });
  test('SE-02 AI mention rate per week from the GEO checks', () => {
    const ins = (ts, m) => db.prepare('INSERT INTO geo_checks (ts, question, lang, mentioned, competitors, answer, model) VALUES (?,?,?,?,?,?,?)').run(ts, 'q', 'en', m, '[]', 'a', 'm');
    const wk = (d) => new Date(Date.now() - d * 86400e3).toISOString();
    ins(wk(14), 0); ins(wk(14), 1); ins(wk(7), 1); ins(wk(7), 1); ins(wk(0), 0);
    const t = SEO.aiMentionTrend(12);
    assert.ok(t.length >= 2);
    assert.deepEqual(t.map((w) => w.checks).reduce((a, b) => a + b, 0), 5);
    assert.ok(t.every((w) => /^\d{4}-\d{2}-\d{2}$/.test(w.week)));
    assert.ok(t.some((w) => w.rate === 1));
  });
});

describe('new arrivals zone', () => {
  test('NA-01a automatic mode shows the latest published products', () => {
    const latest = db.prepare("SELECT id FROM products WHERE status = 'published' ORDER BY COALESCE(published_at, created_at) DESC, id LIMIT 2").all().map((r) => r.id);
    C.saveNewArrivals({ mode: 'auto', count: 2, ids: '' });
    assert.deepEqual(C.newArrivalIds(), latest);
  });
  test('NA-01b manual mode keeps the hand-picked order', () => {
    C.saveNewArrivals({ mode: 'manual', count: 3, ids: 'YR-AR-S3, YR-HB-U2' });
    assert.deepEqual(C.newArrivalIds(), ['YR-AR-S3', 'YR-HB-U2']);
  });
  test('NA-01c the website catalog carries the new-arrival order and needs publishing', () => {
    const cat = C.buildCatalog();
    assert.deepEqual(cat.products.filter((p) => p.newRank != null).sort((a, b) => a.newRank - b.newRank).map((p) => p.id), ['YR-AR-S3', 'YR-HB-U2']);
    assert.equal(C.isDirty(), true, 'needs publishing');
  });
  test('NA-01d off mode shows no new arrivals', () => {
    C.saveNewArrivals({ mode: 'off', count: 3, ids: '' });
    assert.deepEqual(C.newArrivalIds(), []);
  });
  test('NA-01e an unknown hand-picked product is rejected', () => {
    assert.throws(() => C.saveNewArrivals({ mode: 'manual', count: 3, ids: 'NOPE' }), /商品不存在/);
  });
  test('NA-01f a count outside 1–12 is rejected', () => {
    assert.throws(() => C.saveNewArrivals({ mode: 'auto', count: 50 }), /1–12/);
  });
});
