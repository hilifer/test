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
  test('CA-01a a well-formed answer-first draft passes with no issues', () => {
    assert.deepEqual(validate(goodDraft(), ctx()).issues, []);
  });
  test('CA-01b the slug is normalised', () => {
    const d = goodDraft();
    validate(d, ctx());
    assert.equal(d.slug, 'choosing-ufo-wattage');
  });
  test('CA-01c unknown product ids are dropped', () => {
    const d = goodDraft();
    validate(d, ctx());
    assert.deepEqual(d.product_ids, ['YR-HB-U2']);
  });
  const linked = () => { const d = goodDraft({ body: goodBody(' [fake](/products/not-real/) and [blog](https://evil.test/x) and [src](https://news.test/a)') }); return { d, v: validate(d, ctx()) }; };
  test('CA-02a an unknown internal link is stripped (text kept) and noted', () => {
    const { d, v } = linked();
    assert.doesNotMatch(d.body, /\(\/products\/not-real\/\)/);
    assert.ok(v.notes.some((n) => n.includes('/products/not-real/')));
  });
  test('CA-02b an external link that is not a supplied source is stripped', () => {
    assert.doesNotMatch(linked().d.body, /evil\.test/);
  });
  test('CA-02c an external link to a supplied source is kept', () => {
    assert.match(linked().d.body, /\[src\]\(https:\/\/news\.test\/a\)/);
  });
  test('CA-03 banned superlatives / guarantees become hard issues', () => {
    for (const w of ['the best in the world', 'guaranteed savings', 'cheapest', 'industry-leading', '保证收益']) {
      const v = validate(goodDraft({ body: goodBody(` We are ${w}.`) }), ctx());
      assert.ok(v.issues.some((i) => i.startsWith('banned claim')), w);
    }
  });
  test('CA-04a money figures are flagged', () => {
    assert.ok(validate(goodDraft({ body: goodBody(' Costs US$ 40 each.') }), ctx()).issues.some((i) => i.includes('money')));
  });
  test('CA-04b percentages without a source are flagged', () => {
    assert.ok(validate(goodDraft({ body: goodBody(' Saves 60% energy.') }), ctx()).issues.some((i) => i.includes('without a source')));
  });
  test('CA-04c percentages with a supplied source are not flagged', () => {
    const sourced = goodDraft({ body: goodBody(' Saves 60% energy.'), sources: [{ title: 'DOE', url: 'https://news.test/a' }] });
    assert.ok(!validate(sourced, ctx()).issues.some((i) => i.includes('without a source')));
  });
  const skeleton = () => validate({ title: 'T', slug: 's', body: 'too short', faq: [] }, ctx()).issues;
  test('CA-05a structure check: a body below the minimum length is an issue', () => {
    assert.ok(skeleton().some((i) => i.includes('too short')), 'too short');
  });
  test('CA-05b structure check: a missing short answer is an issue', () => {
    assert.ok(skeleton().some((i) => i.includes('short answer')), 'short answer');
  });
  test('CA-05c structure check: missing section headings are an issue', () => {
    assert.ok(skeleton().some((i) => i.includes('section headings')), 'section headings');
  });
  test('CA-05d structure check: a missing FAQ is an issue', () => {
    assert.ok(skeleton().some((i) => i.includes('FAQ')), 'FAQ');
  });
  const dup = () => { const d = goodDraft({ slug: 'dup', sources: [{ title: 'x', url: 'https://made-up.test' }] }); validate(d, { ...ctx(), existingSlugs: new Set(['dup']) }); return d; };
  test('CA-06a a duplicate slug gets a date suffix', () => {
    assert.match(dup().slug, /^dup-\d{4}-\d{2}-\d{2}$/);
  });
  test('CA-06b sources not in the supplied list are dropped', () => {
    assert.deepEqual(dup().sources, []);
  });
  const zhIssues = () => validate({ title: '标题', slug: 'zh-a', body: '**简短回答：** 很短', faq: [{ q: 'a', a: 'b' }, { q: 'c', a: 'd' }] }, { ...ctx(), lang: 'zh' }).issues;
  test('CA-07a a Chinese article is measured in characters and flagged when too short', () => {
    assert.ok(zhIssues().some((i) => i.startsWith('too short')));
  });
  test('CA-07b the Chinese short-answer marker (简短回答) is accepted', () => {
    assert.ok(!zhIssues().some((i) => i.includes('short answer')));
  });
});

describe('feeds', () => {
  test('CA-08a parseFeed decodes CDATA and entities in the title', () => {
    assert.equal(parseFeed(RSS, 'Test')[0].title, 'DOE updates LED rules & tests');
  });
  test('CA-08b parseFeed strips HTML from the summary', () => {
    assert.equal(parseFeed(RSS, 'Test')[0].summary, 'New efficacy rules');
  });
  test('CA-08c parseFeed reads the item link', () => {
    assert.equal(parseFeed(RSS, 'Test')[0].link, 'https://news.test/a');
  });
  test('CA-09 Atom entries with href links', () => {
    const items = parseFeed('<feed><entry><title>Atom</title><link href="https://a.test/1"/><updated>2026-01-01T00:00:00Z</updated><summary>s</summary></entry></feed>', 'A');
    assert.equal(items[0].link, 'https://a.test/1');
  });
  const fr = {};
  test('CA-10a freshItems keeps recent items and skips old ones', async () => {
    fr.r = await freshItems([{ name: 'ok', url: `${llm.url}/rss` }, { name: 'bad', url: `${llm.url}/broken` }]);
    assert.deepEqual(fr.r.items.map((i) => i.link), ['https://news.test/a']);
  });
  test('CA-10b freshItems skips a failing feed and reports it', () => {
    assert.ok(fr.r.errors[0].startsWith('bad: HTTP 500'));
  });
  test('CA-10c freshItems does not return items already marked seen', async () => {
    store.markSeen('https://news.test/a');
    const again = await freshItems([{ name: 'ok', url: `${llm.url}/rss` }]);
    assert.equal(again.items.length, 0, 'seen items are not reused');
  });
});

describe('store', () => {
  test('CA-11a front matter and body survive a save / read round-trip', () => {
    store.saveArticle('unit-a', { title: 'A: colon', status: 'draft', date: '2026-01-01', faq: [{ q: 'x', a: 'y' }] }, 'Body');
    const a = store.readArticle('unit-a');
    assert.equal(a.data.title, 'A: colon');
    assert.equal(a.body.trim(), 'Body');
  });
  test('CA-11b article ids with path traversal are rejected on read and save', () => {
    assert.equal(store.readArticle('../etc/passwd'), null);
    assert.throws(() => store.saveArticle('../x', {}, ''), /bad id/);
  });
  test('CA-12a setStatus(published) stamps publishedAt', () => {
    store.setStatus('unit-a', 'published');
    assert.ok(store.readArticle('unit-a').data.publishedAt);
  });
  test('CA-12b articleUrl builds /news/ URLs and /zh/news/ for zh/ ids', () => {
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
  const gen = {};
  test('CA-14a plan → write → validate returns a draft with no issues (autoPublish off)', async () => {
    llmReplies.push({ kind: 'evergreen', item_ids: [], topic: 'High bay wattage', target_question: 'What wattage?', angle: '', product_ids: ['YR-HB-U2'] });
    llmReplies.push(goodDraft({ slug: 'high-bay-wattage-guide' }));
    const r = gen.r = await generateArticle({ lang: 'en' });
    assert.equal(r.status, 'draft');
    assert.deepEqual(r.issues, []);
  });
  test('CA-14b the generated article is saved as a draft with its topic and the generating model', () => {
    const a = store.readArticle(gen.r.id);
    assert.equal(a.data.status, 'draft');
    assert.equal(a.data.topic, 'High bay wattage');
    assert.ok(a.data.generatedBy.includes('claude-opus-5-5'));
  });
  test('CA-15a a draft that still fails after self-correction stays a draft with its issues', async () => {
    llmReplies.push(goodDraft({ slug: 'bad-one', body: goodBody(' We are the cheapest.') }));
    llmReplies.push(goodDraft({ slug: 'bad-one', body: goodBody(' Still the cheapest.') }));
    const r = await generateArticle({ lang: 'en', topic: 'Pricing' });
    assert.equal(r.status, 'draft');
    assert.ok(r.issues.some((i) => i.startsWith('banned claim')));
  });
  test('CA-15b a failing draft gets one self-correction pass that lists the failed checks', () => {
    const writes = llm.calls.filter((c) => c.url === '/v1/messages').slice(-2);
    assert.match(writes[1].body.messages[0].content, /failed these checks/);
  });
  test('CA-16a autoPublish publishes a draft with zero issues', async () => {
    config.content.autoPublish = true;
    try {
      llmReplies.push(goodDraft({ slug: 'auto-ok' }));
      assert.equal((await generateArticle({ lang: 'en', topic: 'x' })).status, 'published');
    } finally { config.content.autoPublish = false; }
  });
  test('CA-16b autoPublish leaves a draft with issues unpublished', async () => {
    config.content.autoPublish = true;
    try {
      llmReplies.push(goodDraft({ slug: 'auto-bad', body: 'short' }), goodDraft({ slug: 'auto-bad', body: 'short' }));
      assert.equal((await generateArticle({ lang: 'en', topic: 'y' })).status, 'draft');
    } finally { config.content.autoPublish = false; }
  });
  test('CA-17a Anthropic requests carry the configured model and API key', () => {
    const c = llm.calls.filter((x) => x.url === '/v1/messages').at(-1);
    assert.equal(c.body.model, 'claude-opus-5-5');
    assert.equal(c.headers['x-api-key'], 'test');
  });
  test('CA-17b Anthropic requests send no temperature (rejected by the model)', () => {
    const c = llm.calls.filter((x) => x.url === '/v1/messages').at(-1);
    assert.equal(c.body.temperature, undefined, 'Opus 5.5 rejects temperature');
  });
});

describe('publisher / scheduler / geo', () => {
  test('CA-18a rebuild runs BUILD_CMD and produces the dist folder', async () => {
    await Promise.all([publisher.rebuild(), publisher.rebuild(), publisher.rebuild()]);
    assert.ok(existsSync(join(env.SITE_DIR, 'dist')));
  });
  test('CA-18b concurrent rebuild calls are coalesced into at most two builds', () => {
    const builds = store.recentRuns().filter((r) => r.kind === 'build' && r.status === 'ok');
    assert.ok(builds.length >= 1 && builds.length <= 2, `got ${builds.length} builds`);
  });
  const releases = join(env.SITE_DIR, 'srv');
  test('CA-19a rebuild into RELEASES_DIR points the "current" symlink at the new release', async () => {
    config.content.releasesDir = releases;
    try {
      for (let i = 0; i < 4; i++) await publisher.rebuild();
      assert.ok(existsSync(join(config.content.releasesDir, 'current')));
    } finally { config.content.releasesDir = ''; }
  });
  test('CA-19b rebuild into RELEASES_DIR keeps only the last 3 releases', () => {
    assert.equal(readdirSync(join(releases, 'releases')).length, 3);
  });
  test('CA-20 failed build is logged and rejects (site unchanged)', async () => {
    const old = config.content.buildCmd;
    config.content.buildCmd = 'node -e "process.exit(3)"';
    try { await assert.rejects(publisher.rebuild(), /build exited 3/); } finally { config.content.buildCmd = old; }
    assert.equal(store.recentRuns()[0].status, 'error');
  });
  test('CA-21a IndexNow is skipped without a key', async () => {
    assert.deepEqual(await publisher.indexNow(['/news/']), { skipped: true });
  });
  test('CA-21b with a key IndexNow posts absolute URLs and the key location', async () => {
    const realFetch = globalThis.fetch;
    let sent;
    globalThis.fetch = async (url, init) => { sent = { url, body: JSON.parse(init.body) }; return new Response('', { status: 202 }); };
    config.content.indexNowKey = 'k123';
    try { assert.equal((await publisher.indexNow(['/news/a/'])).status, 202); } finally { globalThis.fetch = realFetch; config.content.indexNowKey = ''; }
    assert.equal(sent.url, 'https://api.indexnow.org/indexnow');
    assert.deepEqual(sent.body.urlList, ['https://example.test/news/a/']);
    assert.equal(sent.body.keyLocation, 'https://example.test/k123.txt');
  });
  const job = {};
  test('CA-22a scheduled content job logs an error per failed article', async () => {
    job.before = store.recentRuns().filter((r) => r.kind === 'build').length;
    llmReplies.push('not json at all');
    const out = await contentJob();
    assert.ok(out[0].error);
  });
  test('CA-22b scheduled content job does not rebuild when nothing was published', () => {
    assert.equal(store.recentRuns().filter((r) => r.kind === 'build').length, job.before);
  });
  const geo = {};
  test('CA-23a GEO monitor records whether the brand is mentioned in each answer', async () => {
    llmReplies.length = 0;
    config.profile.content.geo = { questions: [{ q: 'Best UFO high bay supplier?' }, { q: 'Who sells DLC high bays?' }], brandAliases: ['Yaorong'], competitors: ['Acme Lights'] };
    llmReplies.push('Try YAORONG LED or Acme Lights.', 'Many vendors exist.');
    geo.r = await runGeoCheck();
    assert.deepEqual(geo.r.map((x) => x.mentioned), [1, 0]);
  });
  test('CA-23b GEO monitor records which competitors appear', () => {
    assert.deepEqual(geo.r[0].competitors, ['Acme Lights']);
  });
  test('CA-23c GEO check results are kept in the history', () => {
    assert.equal(geoHistory().length, 2);
  });
});
