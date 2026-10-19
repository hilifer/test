// Modules: server/src/content/{writer validate, feeds, store, publisher, scheduler, geo} — SEO/GEO content agent.
// IDs CA-xx. Uses an isolated news dir + DB and a mock LLM / RSS / IndexNow server.
import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { useTempEnv } from '../helpers/env.mjs';
import { mockServer } from '../helpers/mock-http.mjs';

const llmReplies = [];
const llm = await mockServer((call) => {
  if (call.url.startsWith('/rss')) return { text: RSS, headers: { 'content-type': 'application/rss+xml' } };
  if (call.url.startsWith('/broken')) return { status: 500, text: 'down' };
  if (call.url === '/v1/messages') {
    const next = llmReplies.shift() ?? '{}';
    return { json: { content: [{ type: 'text', text: typeof next === 'string' ? next : JSON.stringify(next) }], stop_reason: 'end_turn' } };
  }
  return { status: 404, text: 'nope' };
});
const today = new Date().toUTCString();
const RSS = `<?xml version="1.0"?><rss><channel>
<item><title><![CDATA[DOE updates LED rules &amp; tests]]></title><link>https://news.test/a</link><pubDate>${today}</pubDate><description>&lt;p&gt;New efficacy rules&lt;/p&gt;</description></item>
<item><title>Old item</title><link>https://news.test/old</link><pubDate>Mon, 01 Jan 2001 00:00:00 GMT</pubDate><description>old</description></item>
</channel></rss>`;

const { env } = useTempEnv({ site: 'led', LLM_PROVIDER: 'anthropic', LLM_API_KEY: 'test', LLM_MODEL: 'claude-opus-5-5', LLM_BASE_URL: llm.url });
const { validate, generateArticle } = await import('../../server/src/content/writer.js');
const { parseFeed, freshItems } = await import('../../server/src/content/feeds.js');
const store = await import('../../server/src/content/store.js');
const publisher = await import('../../server/src/content/publisher.js');
const { contentJob } = await import('../../server/src/content/scheduler.js');
const { runGeoCheck, geoHistory } = await import('../../server/src/content/geo.js');
const { config } = await import('../../server/src/config.js');
after(() => llm.close());

const goodBody = (extra = '') => `**Short answer:** For a 10 m warehouse ceiling a 200–240W UFO high bay is typical. See the [UFO high bay](/products/ufo-high-bay-u2/).\n\n## How high is your ceiling?\n\n${'Typical practice is to match lumen output to mounting height and the light level you need. '.repeat(60)}\n\n## Next step\n\nAsk for a [quote](/quote/).${extra}`;
const goodDraft = (o = {}) => ({ title: 'Choosing UFO high bay wattage', description: 'How to pick high bay wattage for your ceiling height.', slug: 'Choosing UFO Wattage!', faq: [{ q: 'Q1?', a: 'A1.' }, { q: 'Q2?', a: 'A2.' }], sources: [], product_ids: ['YR-HB-U2', 'FAKE-1'], body: goodBody(), ...o });
const ctx = () => ({ lang: 'en', allowed: new Set(['/products/ufo-high-bay-u2/', '/quote/']), sourceUrls: new Set(['https://news.test/a']), existingSlugs: new Set() });

describe('validate (guardrails)', () => {
  test('CA-01 a well-formed answer-first draft passes; slug normalised; unknown product ids dropped', () => {
    const d = goodDraft();
    const v = validate(d, ctx());
    assert.deepEqual(v.issues, []);
    assert.equal(d.slug, 'choosing-ufo-wattage');
    assert.deepEqual(d.product_ids, ['YR-HB-U2']);
  });
  test('CA-02 unknown internal links and unsourced external links are stripped (text kept)', () => {
    const d = goodDraft({ body: goodBody(' [fake](/products/not-real/) and [blog](https://evil.test/x) and [src](https://news.test/a)') });
    const v = validate(d, ctx());
    assert.doesNotMatch(d.body, /\(\/products\/not-real\/\)/);
    assert.doesNotMatch(d.body, /evil\.test/);
    assert.match(d.body, /\[src\]\(https:\/\/news\.test\/a\)/);
    assert.ok(v.notes.some((n) => n.includes('/products/not-real/')));
  });
  test('CA-03 banned superlatives / guarantees become hard issues', () => {
    for (const w of ['the best in the world', 'guaranteed savings', 'cheapest', 'industry-leading', '保证收益']) {
      const v = validate(goodDraft({ body: goodBody(` We are ${w}.`) }), ctx());
      assert.ok(v.issues.some((i) => i.startsWith('banned claim')), w);
    }
  });
  test('CA-04 money figures and unsourced percentages are flagged', () => {
    assert.ok(validate(goodDraft({ body: goodBody(' Costs US$ 40 each.') }), ctx()).issues.some((i) => i.includes('money')));
    assert.ok(validate(goodDraft({ body: goodBody(' Saves 60% energy.') }), ctx()).issues.some((i) => i.includes('without a source')));
    const sourced = goodDraft({ body: goodBody(' Saves 60% energy.'), sources: [{ title: 'DOE', url: 'https://news.test/a' }] });
    assert.ok(!validate(sourced, ctx()).issues.some((i) => i.includes('without a source')));
  });
  test('CA-05 structure checks: short answer, headings, FAQ, length', () => {
    const v = validate({ title: 'T', slug: 's', body: 'too short', faq: [] }, ctx());
    for (const k of ['too short', 'short answer', 'section headings', 'FAQ']) assert.ok(v.issues.some((i) => i.includes(k)), k);
  });
  test('CA-06 duplicate slugs get a date suffix; sources not in the supplied list are dropped', () => {
    const d = goodDraft({ slug: 'dup', sources: [{ title: 'x', url: 'https://made-up.test' }] });
    validate(d, { ...ctx(), existingSlugs: new Set(['dup']) });
    assert.match(d.slug, /^dup-\d{4}-\d{2}-\d{2}$/);
    assert.deepEqual(d.sources, []);
  });
  test('CA-07 Chinese article rules (short-answer marker, char count)', () => {
    const v = validate({ title: '标题', slug: 'zh-a', body: '**简短回答：** 很短', faq: [{ q: 'a', a: 'b' }, { q: 'c', a: 'd' }] }, { ...ctx(), lang: 'zh' });
    assert.ok(v.issues.some((i) => i.startsWith('too short')));
    assert.ok(!v.issues.some((i) => i.includes('short answer')));
  });
});

describe('feeds', () => {
  test('CA-08 parseFeed decodes CDATA, entities and strips HTML', () => {
    const items = parseFeed(RSS, 'Test');
    assert.equal(items[0].title, 'DOE updates LED rules & tests');
    assert.equal(items[0].summary, 'New efficacy rules');
    assert.equal(items[0].link, 'https://news.test/a');
  });
  test('CA-09 Atom entries with href links', () => {
    const items = parseFeed('<feed><entry><title>Atom</title><link href="https://a.test/1"/><updated>2026-01-01T00:00:00Z</updated><summary>s</summary></entry></feed>', 'A');
    assert.equal(items[0].link, 'https://a.test/1');
  });
  test('CA-10 freshItems keeps recent unseen items, skips failing feeds and reports them', async () => {
    const r = await freshItems([{ name: 'ok', url: `${llm.url}/rss` }, { name: 'bad', url: `${llm.url}/broken` }]);
    assert.deepEqual(r.items.map((i) => i.link), ['https://news.test/a']);
    assert.ok(r.errors[0].startsWith('bad: HTTP 500'));
    store.markSeen('https://news.test/a');
    const again = await freshItems([{ name: 'ok', url: `${llm.url}/rss` }]);
    assert.equal(again.items.length, 0, 'seen items are not reused');
  });
});

describe('store', () => {
  test('CA-11 front matter round-trip, path traversal rejected', () => {
    store.saveArticle('unit-a', { title: 'A: colon', status: 'draft', date: '2026-01-01', faq: [{ q: 'x', a: 'y' }] }, 'Body');
    const a = store.readArticle('unit-a');
    assert.equal(a.data.title, 'A: colon');
    assert.equal(a.body.trim(), 'Body');
    assert.equal(store.readArticle('../etc/passwd'), null);
    assert.throws(() => store.saveArticle('../x', {}, ''), /bad id/);
  });
  test('CA-12 setStatus(published) stamps publishedAt; articleUrl handles zh/', () => {
    store.setStatus('unit-a', 'published');
    assert.ok(store.readArticle('unit-a').data.publishedAt);
    assert.equal(store.articleUrl('zh/x'), '/zh/news/x/');
    assert.equal(store.articleUrl('x'), '/news/x/');
  });
  test('CA-13 seed articles are listed newest first', () => {
    const list = store.listArticles();
    assert.ok(list.length >= 3);
    for (let i = 1; i < list.length; i++) assert.ok(String(list[i - 1].data.date) >= String(list[i].data.date));
  });
});

describe('generateArticle (LLM mocked)', () => {
  test('CA-14 plan → write → validate → saved as draft awaiting review (autoPublish off)', async () => {
    llmReplies.push({ kind: 'evergreen', item_ids: [], topic: 'High bay wattage', target_question: 'What wattage?', angle: '', product_ids: ['YR-HB-U2'] });
    llmReplies.push(goodDraft({ slug: 'high-bay-wattage-guide' }));
    const r = await generateArticle({ lang: 'en' });
    assert.equal(r.status, 'draft');
    assert.deepEqual(r.issues, []);
    const a = store.readArticle(r.id);
    assert.equal(a.data.status, 'draft');
    assert.equal(a.data.topic, 'High bay wattage');
    assert.ok(a.data.generatedBy.includes('claude-opus-5-5'));
  });
  test('CA-15 failing draft gets one self-correction pass; still failing → stays draft with issues', async () => {
    llmReplies.push(goodDraft({ slug: 'bad-one', body: goodBody(' We are the cheapest.') }));
    llmReplies.push(goodDraft({ slug: 'bad-one', body: goodBody(' Still the cheapest.') }));
    const r = await generateArticle({ lang: 'en', topic: 'Pricing' });
    assert.equal(r.status, 'draft');
    assert.ok(r.issues.some((i) => i.startsWith('banned claim')));
    const writes = llm.calls.filter((c) => c.url === '/v1/messages').slice(-2);
    assert.match(writes[1].body.messages[0].content, /failed these checks/);
  });
  test('CA-16 autoPublish publishes only drafts with zero issues', async () => {
    config.content.autoPublish = true;
    try {
      llmReplies.push(goodDraft({ slug: 'auto-ok' }));
      assert.equal((await generateArticle({ lang: 'en', topic: 'x' })).status, 'published');
      llmReplies.push(goodDraft({ slug: 'auto-bad', body: 'short' }), goodDraft({ slug: 'auto-bad', body: 'short' }));
      assert.equal((await generateArticle({ lang: 'en', topic: 'y' })).status, 'draft');
    } finally { config.content.autoPublish = false; }
  });
  test('CA-17 Anthropic requests carry the configured model and no sampling params the model rejects', () => {
    const c = llm.calls.filter((x) => x.url === '/v1/messages').at(-1);
    assert.equal(c.body.model, 'claude-opus-5-5');
    assert.equal(c.headers['x-api-key'], 'test');
    assert.equal(c.body.temperature, undefined, 'Opus 5.5 rejects temperature');
  });
});

describe('publisher / scheduler / geo', () => {
  test('CA-18 rebuild runs BUILD_CMD and coalesces concurrent calls', async () => {
    await Promise.all([publisher.rebuild(), publisher.rebuild(), publisher.rebuild()]);
    assert.ok(existsSync(join(env.SITE_DIR, 'dist')));
    const builds = store.recentRuns().filter((r) => r.kind === 'build' && r.status === 'ok');
    assert.ok(builds.length >= 1 && builds.length <= 2, `got ${builds.length} builds`);
  });
  test('CA-19 rebuild into RELEASES_DIR swaps the "current" symlink atomically and keeps 3 releases', async () => {
    config.content.releasesDir = join(env.SITE_DIR, 'srv');
    try {
      for (let i = 0; i < 4; i++) await publisher.rebuild();
      assert.ok(existsSync(join(config.content.releasesDir, 'current')));
      assert.equal(readdirSync(join(config.content.releasesDir, 'releases')).length, 3);
    } finally { config.content.releasesDir = ''; }
  });
  test('CA-20 failed build is logged and rejects (site unchanged)', async () => {
    const old = config.content.buildCmd;
    config.content.buildCmd = 'node -e "process.exit(3)"';
    try { await assert.rejects(publisher.rebuild(), /build exited 3/); } finally { config.content.buildCmd = old; }
    assert.equal(store.recentRuns()[0].status, 'error');
  });
  test('CA-21 IndexNow is skipped without a key, posts absolute URLs with a key', async () => {
    assert.deepEqual(await publisher.indexNow(['/news/']), { skipped: true });
    const realFetch = globalThis.fetch;
    let sent;
    globalThis.fetch = async (url, init) => { sent = { url, body: JSON.parse(init.body) }; return new Response('', { status: 202 }); };
    config.content.indexNowKey = 'k123';
    try { assert.equal((await publisher.indexNow(['/news/a/'])).status, 202); } finally { globalThis.fetch = realFetch; config.content.indexNowKey = ''; }
    assert.equal(sent.url, 'https://api.indexnow.org/indexnow');
    assert.deepEqual(sent.body.urlList, ['https://example.test/news/a/']);
    assert.equal(sent.body.keyLocation, 'https://example.test/k123.txt');
  });
  test('CA-22 scheduled content job: errors are logged per article, nothing published → no rebuild', async () => {
    const before = store.recentRuns().filter((r) => r.kind === 'build').length;
    llmReplies.push('not json at all');
    const out = await contentJob();
    assert.ok(out[0].error);
    assert.equal(store.recentRuns().filter((r) => r.kind === 'build').length, before);
  });
  test('CA-23 GEO monitor records whether the brand is mentioned and which competitors appear', async () => {
    llmReplies.length = 0;
    config.profile.content.geo = { questions: [{ q: 'Best UFO high bay supplier?' }, { q: 'Who sells DLC high bays?' }], brandAliases: ['Yaorong'], competitors: ['Acme Lights'] };
    llmReplies.push('Try YAORONG LED or Acme Lights.', 'Many vendors exist.');
    const r = await runGeoCheck();
    assert.deepEqual(r.map((x) => x.mentioned), [1, 0]);
    assert.deepEqual(r[0].competitors, ['Acme Lights']);
    assert.equal(geoHistory().length, 2);
  });
});
