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

test('PL-01 JSON-LD Product (also inside @graph) gives title, SKU, brand, description and images; relative URLs resolved', () => {
  const html = `<html><head><title>Fallback</title><script type="application/ld+json">{"@context":"https://schema.org","@graph":[{"@type":"WebPage"},{"@type":"Product","name":"LED Panel 60x60 &amp; more","sku":"PN-6060","brand":{"@type":"Brand","name":"Acme"},"description":"Slim panel.","image":["/img/a.jpg",{"@type":"ImageObject","url":"https://cdn.test/b.jpg"}]}]}</script>
  <meta property="og:image" content="https://cdn.test/og.jpg"></head><body><img src="/img/logo.png"><img data-src="/img/c.jpg"><img srcset="/img/d-400.jpg 400w, /img/d-1200.jpg 1200w"><img src="data:image/png;base64,xx"></body></html>`;
  const r = P.extract(html, 'https://shop.test/p/1');
  assert.equal(r.title, 'LED Panel 60x60 & more');
  assert.equal(r.sku, 'PN-6060');
  assert.equal(r.brand, 'Acme');
  assert.equal(r.description, 'Slim panel.');
  assert.deepEqual(r.images, ['https://shop.test/img/a.jpg', 'https://cdn.test/b.jpg', 'https://cdn.test/og.jpg', 'https://shop.test/img/c.jpg', 'https://shop.test/img/d-1200.jpg']);
});

test('PL-02 without JSON-LD: Open Graph and <title> / meta description are used; videos found', () => {
  const r = P.extract('<head><meta content="Garden light" property="og:title"><meta name="description" content="Solar garden light"><meta property="og:video" content="/v/demo.mp4"></head><body><video><source src="/v/b.mov"></video></body>', 'https://x.test/');
  assert.equal(r.title, 'Garden light');
  assert.equal(r.description, 'Solar garden light');
  assert.deepEqual(r.videos, ['https://x.test/v/demo.mp4', 'https://x.test/v/b.mov']);
});

test('PL-03 SSRF guard: non-http schemes, internal addresses and redirects into the internal network are refused', async () => {
  process.env.PULL_ALLOW_PRIVATE = 'false';
  await assert.rejects(P.safeFetch('ftp://example.test/x'), (e) => e.reason === 'invalid_url');
  await assert.rejects(P.safeFetch('not a url'), (e) => e.reason === 'invalid_url');
  for (const u of ['http://127.0.0.1:1/', 'http://10.1.2.3/', 'http://192.168.1.1/', 'http://169.254.169.254/latest/meta-data/', 'http://[::1]/', 'http://172.20.0.5/']) await assert.rejects(P.safeFetch(u), (e) => e.reason === 'blocked_address', u);
  await assert.rejects(P.safeFetch(`${srv.url}/redirect-internal`), (e) => e.reason === 'blocked_address'); // the mock itself is local
  process.env.PULL_ALLOW_PRIVATE = 'true'; // test-only switch, to reach the mock server
  await assert.rejects(P.safeFetch(`${srv.url}/redirect-internal`), (e) => e.reason === 'fetch_failed' || e.reason === 'timeout'); // 10.0.0.1 is unreachable here
  await assert.rejects(P.safeFetch(`${srv.url}/big`), (e) => e.reason === 'too_large');
  assert.equal((await P.safeFetch(`${srv.url}/ok`)).body.toString(), '<html><title>ok</title></html>');
});

test('PL-04 a pull without a product, or with an unusable link, is logged with the reason', async () => {
  assert.equal((await P.pull('https://x.test/', { mode: 'own' })).reason, 'no_product');
  assert.equal((await P.pull('ftp://x', { mode: 'own', productId: 'YR-HB-U2' })).reason, 'invalid_url');
  const logs = P.pullLogs();
  assert.equal(logs[0].reason, 'invalid_url');
  assert.equal(logs[1].reason, 'no_product');
});
