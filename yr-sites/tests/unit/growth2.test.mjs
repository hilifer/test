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
  test('EM-01 audience: only customers who opted in, filtered by tag, type, VIP and language', () => {
    const emails = (a) => E.audienceOf(a).map((c) => c.email).sort();
    assert.deepEqual(emails({}), ['con@x.test', 'dealer@x.test']);
    assert.deepEqual(emails({ tier: 'dealer' }), ['dealer@x.test'], 'noopt@ is a dealer but did not opt in');
    assert.deepEqual(emails({ tags: '大客户' }), ['dealer@x.test']);
    assert.deepEqual(emails({ vip: '1' }), ['dealer@x.test']);
    assert.deepEqual(emails({ lang: 'zh' }), ['con@x.test']);
  });
  test('EM-02 drafts: validation, editing; a message has the name, an unsubscribe link, a tracking pixel and a List-Unsubscribe header', () => {
    assert.throws(() => E.saveEmailCampaign({ subject: '', body: 'long enough body' }), /标题/);
    assert.throws(() => E.saveEmailCampaign({ subject: 'Hi', body: 'short' }), /至少 10/);
    const id = E.saveEmailCampaign({ subject: 'New UFO high bay', body: 'Hello {{name}},\n\nOur new UFO is out: https://example.test/products/ufo/\n\nBest regards', audience: { tier: 'dealer' } });
    E.saveEmailCampaign({ id, subject: 'New UFO high bay — 15% off', body: 'Hello {{name}},\n\nOur new UFO is out: https://example.test/products/ufo/', audience: { tier: 'dealer' } });
    const c = E.getEmailCampaign(id);
    assert.equal(c.subject, 'New UFO high bay — 15% off');
    const m = E.renderEmail(c, { token: 'TOK', contact: 'Omar', lang: 'en' });
    assert.match(m.text, /^Hello Omar,/);
    assert.match(m.text, /Unsubscribe: https:\/\/example\.test\/m\/u\/TOK/);
    assert.match(m.html, /<a href="https:\/\/example\.test\/products\/ufo\/">/);
    assert.match(m.html, /<img src="https:\/\/example\.test\/m\/o\/TOK\.gif"/);
    assert.equal(m.headers['List-Unsubscribe'], '<https://example.test/m/u/TOK>');
    assert.match(E.renderEmail(c, { token: 'T2', contact: '', lang: 'zh' }).text, /退订：/);
  });
  test('EM-03 sending: the recipient list is frozen, messages go out through the task center, the draft is locked', async () => {
    const id = E.listEmailCampaigns().find((x) => x.subject.startsWith('New UFO')).id;
    const r = E.sendEmailCampaign(id);
    assert.equal(r.recipients, 1);
    await waitFor(() => T.tasksIdle());
    const t = T.getTask(r.taskId);
    assert.equal(t.status, 'done');
    assert.match(t.items[0].result, /已记录/);
    const st = E.emailStats(id);
    assert.deepEqual([st.total, st.sent, st.opened, st.openRate], [1, 1, 0, 0]);
    assert.ok(db.prepare("SELECT 1 FROM mail_outbox WHERE to_addr = 'dealer@x.test' AND subject LIKE 'New UFO%'").get());
    assert.throws(() => E.sendEmailCampaign(id), /已经发送/);
    assert.throws(() => E.saveEmailCampaign({ id, subject: 'x', body: 'changed body text' }), /不能修改/);
    assert.throws(() => E.deleteEmailCampaign(id), /不能删除/);
    const none = E.saveEmailCampaign({ subject: 'Nobody', body: 'nobody gets this one', audience: { tags: 'nonexistent' } });
    assert.throws(() => E.sendEmailCampaign(none), /没有符合条件/);
  });
  test('EM-04 opens are counted; unsubscribing turns marketing e-mail off for good and later sends skip them', async () => {
    const id = E.listEmailCampaigns().find((x) => x.subject.startsWith('New UFO')).id;
    const tok = db.prepare('SELECT token FROM email_recipients WHERE campaign_id = ?').get(id).token;
    E.recordOpen(tok); E.recordOpen(tok);
    assert.deepEqual([E.emailStats(id).opened, E.emailStats(id).openRate], [1, 1]);
    assert.equal(db.prepare('SELECT opens FROM email_recipients WHERE token = ?').get(tok).opens, 2);
    assert.equal(E.unsubscribe(tok), 'en');
    assert.equal(E.unsubscribe('nope'), null);
    assert.equal(E.emailStats(id).unsubscribed, 1);
    assert.equal(db.prepare('SELECT marketing_opt_in FROM customers WHERE id = ?').get(ids.dealer).marketing_opt_in, 0);
    assert.deepEqual(E.audienceOf({}).map((c) => c.email), ['con@x.test']);
  });
});

describe('keywords & AI mentions', () => {
  test('SE-01 keywords and positions: duplicates refused, same day overwrites, change since last time, import with errors', () => {
    const k = SEO.addKeyword({ keyword: 'UFO High Bay Light', lang: 'en', target_url: '/products/ufo-high-bay-u2/' });
    assert.throws(() => SEO.addKeyword({ keyword: 'ufo high bay light' }), /已存在/);
    SEO.recordRank(k, { day: '2026-10-01', position: 18 });
    SEO.recordRank(k, { day: '2026-10-08', position: 12 });
    SEO.recordRank(k, { day: '2026-10-08', position: 9 });
    let row = SEO.keywordTable().find((x) => x.id === k);
    assert.deepEqual([row.last.position, row.prev.position, row.change, row.hist.length], [9, 18, 9, 2]);
    assert.throws(() => SEO.recordRank(k, { position: 101 }), /1–100/);
    assert.throws(() => SEO.recordRank(k, { engine: 'yahoo' }), /搜索引擎/);
    const r = SEO.importRanks('keyword, position, url, engine, date\nufo high bay light, 7, https://x/, google, 2026-10-15\n工矿灯, 3, , baidu, 2026-10-15\nbad line, 500');
    assert.deepEqual([r.recorded, r.added, r.errors.length], [2, 2, 1]);
    assert.match(r.errors[0], /第 4 行/);
    row = SEO.keywordTable().find((x) => x.id === k);
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
  test('NA-01 automatic (latest published), hand-picked order, off; the website catalog carries the order', () => {
    const latest = db.prepare("SELECT id FROM products WHERE status = 'published' ORDER BY COALESCE(published_at, created_at) DESC, id LIMIT 2").all().map((r) => r.id);
    C.saveNewArrivals({ mode: 'auto', count: 2, ids: '' });
    assert.deepEqual(C.newArrivalIds(), latest);
    C.saveNewArrivals({ mode: 'manual', count: 3, ids: 'YR-AR-S3, YR-HB-U2' });
    assert.deepEqual(C.newArrivalIds(), ['YR-AR-S3', 'YR-HB-U2']);
    const cat = C.buildCatalog();
    assert.deepEqual(cat.products.filter((p) => p.newRank != null).sort((a, b) => a.newRank - b.newRank).map((p) => p.id), ['YR-AR-S3', 'YR-HB-U2']);
    assert.equal(C.isDirty(), true, 'needs publishing');
    C.saveNewArrivals({ mode: 'off', count: 3, ids: '' });
    assert.deepEqual(C.newArrivalIds(), []);
    assert.throws(() => C.saveNewArrivals({ mode: 'manual', count: 3, ids: 'NOPE' }), /商品不存在/);
    assert.throws(() => C.saveNewArrivals({ mode: 'auto', count: 50 }), /1–12/);
  });
});
