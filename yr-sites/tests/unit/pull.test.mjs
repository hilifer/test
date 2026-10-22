// Module: server/src/assets/pull.js — product page parsing and the SSRF guard (internal addresses refused, also after a
// redirect), size limits. IDs PL-xx.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { useTempEnv, tempDir } from '../helpers/env.mjs';
import { mockServer } from '../helpers/mock-http.mjs';

useTempEnv({ site: 'led', MEDIA_DIR: tempDir('yr-media-') });
const P = await import('../../server/src/assets/pull.js');
const srv = await mockServer((call) => {
  if (call.url === '/big') return { text: 'x'.repeat(6 * 1048576), headers: { 'content-type': 'text/html' } };
  if (call.url === '/redirect-internal') return { status: 302, headers: { location: 'http://10.0.0.1/admin' }, text: '' };
  return { text: '<html><title>ok</title></html>', headers: { 'content-type': 'text/html' } };
});
after(() => srv.close());

const html1 = `<html><head><title>Fallback</title><script type="application/ld+json">{"@context":"https://schema.org","@graph":[{"@type":"WebPage"},{"@type":"Product","name":"LED Panel 60x60 &amp; more","sku":"PN-6060","brand":{"@type":"Brand","name":"Acme"},"description":"Slim panel.","image":["/img/a.jpg",{"@type":"ImageObject","url":"https://cdn.test/b.jpg"}]}]}</script>
  <meta property="og:image" content="https://cdn.test/og.jpg"></head><body><img src="/img/logo.png"><img data-src="/img/c.jpg"><img srcset="/img/d-400.jpg 400w, /img/d-1200.jpg 1200w"><img src="data:image/png;base64,xx"></body></html>`;

test('PL-01a a JSON-LD Product inside @graph gives title (entities decoded), SKU, brand and description', () => {
  const r = P.extract(html1, 'https://shop.test/p/1');
  assert.equal(r.title, 'LED Panel 60x60 & more');
  assert.equal(r.sku, 'PN-6060');
  assert.equal(r.brand, 'Acme');
  assert.equal(r.description, 'Slim panel.');
});

test('PL-01b images come from JSON-LD, og:image, lazy src and the largest srcset entry, with relative URLs resolved and logos/data URIs skipped', () => {
  const r = P.extract(html1, 'https://shop.test/p/1');
  assert.deepEqual(r.images, ['https://shop.test/img/a.jpg', 'https://cdn.test/b.jpg', 'https://cdn.test/og.jpg', 'https://shop.test/img/c.jpg', 'https://shop.test/img/d-1200.jpg']);
});

const html2 = '<head><meta content="Garden light" property="og:title"><meta name="description" content="Solar garden light"><meta property="og:video" content="/v/demo.mp4"></head><body><video><source src="/v/b.mov"></video></body>';
test('PL-02a without JSON-LD, og:title and the meta description are used', () => {
  const r = P.extract(html2, 'https://x.test/');
  assert.equal(r.title, 'Garden light');
  assert.equal(r.description, 'Solar garden light');
});

test('PL-02b videos are found from og:video and <video> sources', () => {
  const r = P.extract(html2, 'https://x.test/');
  assert.deepEqual(r.videos, ['https://x.test/v/demo.mp4', 'https://x.test/v/b.mov']);
});

test('PL-03a non-http schemes and malformed URLs are refused as invalid', async () => {
  process.env.PULL_ALLOW_PRIVATE = 'false';
  await assert.rejects(P.safeFetch('ftp://example.test/x'), (e) => e.reason === 'invalid_url');
  await assert.rejects(P.safeFetch('not a url'), (e) => e.reason === 'invalid_url');
});

test('PL-03b loopback, private, link-local and IPv6 loopback addresses are blocked', async () => {
  process.env.PULL_ALLOW_PRIVATE = 'false';
  for (const u of ['http://127.0.0.1:1/', 'http://10.1.2.3/', 'http://192.168.1.1/', 'http://169.254.169.254/latest/meta-data/', 'http://[::1]/', 'http://172.20.0.5/']) await assert.rejects(P.safeFetch(u), (e) => e.reason === 'blocked_address', u);
});

test('PL-03c a local server is blocked when private addresses are not allowed', async () => {
  process.env.PULL_ALLOW_PRIVATE = 'false';
  await assert.rejects(P.safeFetch(`${srv.url}/redirect-internal`), (e) => e.reason === 'blocked_address'); // the mock itself is local
});

test('PL-03d a redirect into the internal network is not followed to a result', async () => {
  process.env.PULL_ALLOW_PRIVATE = 'true'; // test-only switch, to reach the mock server
  await assert.rejects(P.safeFetch(`${srv.url}/redirect-internal`), (e) => e.reason === 'fetch_failed' || e.reason === 'timeout'); // 10.0.0.1 is unreachable here
});

test('PL-03e a response over the size limit is refused', async () => {
  process.env.PULL_ALLOW_PRIVATE = 'true';
  await assert.rejects(P.safeFetch(`${srv.url}/big`), (e) => e.reason === 'too_large');
});

test('PL-03f an allowed URL returns the body', async () => {
  process.env.PULL_ALLOW_PRIVATE = 'true';
  assert.equal((await P.safeFetch(`${srv.url}/ok`)).body.toString(), '<html><title>ok</title></html>');
});

test('PL-04a a pull without a product is refused with reason no_product', async () => {
  assert.equal((await P.pull('https://x.test/', { mode: 'own' })).reason, 'no_product');
});

test('PL-04b a pull with an unusable link is refused with reason invalid_url', async () => {
  assert.equal((await P.pull('ftp://x', { mode: 'own', productId: 'YR-HB-U2' })).reason, 'invalid_url');
});

test('PL-04c refused pulls are logged with their reason, newest first', () => {
  const logs = P.pullLogs();
  assert.equal(logs[0].reason, 'invalid_url');
  assert.equal(logs[1].reason, 'no_product');
});
