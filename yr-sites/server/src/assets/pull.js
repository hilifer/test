// Product link pulling (商品链接拉取): paste a supplier / factory / reference product page; the page's public data (JSON-LD
// Product, Open Graph, <img>) gives title, description, SKU and images, which are filed into the product's folders.
// Reference mode (竞品参考) reads text only and never downloads images.
// Safety: http/https only; every hop (incl. redirects) must resolve to a public address (no internal network); size and
// time limits; each image is checked by content like any upload.
import { lookup } from 'node:dns/promises';
import { isIP } from 'node:net';
import { db } from '../db.js';
import { migrate } from '../migrate.js';
import { actorName } from '../auth.js';
import * as A from './store.js';

migrate([{
  id: '2026-10-30-pull-logs',
  up: () => db.exec('CREATE TABLE pull_logs (id INTEGER PRIMARY KEY AUTOINCREMENT, ts TEXT, url TEXT, mode TEXT, product_id TEXT, ok INTEGER, reason TEXT, found TEXT, created TEXT, actor TEXT)'),
}]);

export const REASONS = {
  invalid_url: '链接无效（只支持 http / https）', blocked_address: '不允许访问内网或保留地址', timeout: '打开链接超时', not_html: '不是网页',
  too_large: '网页或图片太大', no_data: '没有找到商品信息或图片', fetch_failed: '无法打开链接', too_many_redirects: '重定向次数过多',
};
const allowPrivate = () => process.env.PULL_ALLOW_PRIVATE === 'true'; // tests only (mock servers on 127.0.0.1)
const MAX_HTML = 5 * 1048576, MAX_IMAGES = 30;

function privateIp(ip) {
  if (isIP(ip) === 6) { const v = ip.toLowerCase(); return v === '::1' || v === '::' || v.startsWith('fc') || v.startsWith('fd') || v.startsWith('fe80') || v.startsWith('::ffff:') && privateIp(v.slice(7)); }
  const [a, b] = ip.split('.').map(Number);
  return a === 10 || a === 127 || a === 0 || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 100 && b >= 64 && b <= 127) || a >= 224;
}
async function assertPublic(u) {
  if (!/^https?:$/.test(u.protocol)) throw Object.assign(new Error('invalid_url'), { reason: 'invalid_url' });
  if (allowPrivate()) return;
  const host = u.hostname.replace(/^\[|\]$/g, '');
  const addrs = isIP(host) ? [{ address: host }] : await lookup(host, { all: true }).catch(() => { throw Object.assign(new Error('fetch_failed'), { reason: 'fetch_failed' }); });
  if (!addrs.length || addrs.some((x) => privateIp(x.address))) throw Object.assign(new Error('blocked_address'), { reason: 'blocked_address' });
}
/** fetch with the public-address check on every redirect hop, a timeout and a size cap. */
export async function safeFetch(url, { max = MAX_HTML, accept = 'text/html,*/*' } = {}) {
  let u;
  try { u = new URL(url); } catch { throw Object.assign(new Error('invalid_url'), { reason: 'invalid_url' }); }
  for (let hop = 0; hop < 4; hop++) {
    await assertPublic(u);
    let r;
    try { r = await fetch(u, { redirect: 'manual', signal: AbortSignal.timeout(15000), headers: { 'user-agent': 'Mozilla/5.0 (compatible; YR-asset-puller/1.0)', accept } }); }
    catch (e) { throw Object.assign(new Error(e.name === 'TimeoutError' ? 'timeout' : 'fetch_failed'), { reason: e.name === 'TimeoutError' ? 'timeout' : 'fetch_failed' }); }
    if ([301, 302, 303, 307, 308].includes(r.status) && r.headers.get('location')) { u = new URL(r.headers.get('location'), u); continue; }
    if (!r.ok) throw Object.assign(new Error(`HTTP ${r.status}`), { reason: 'fetch_failed' });
    if (Number(r.headers.get('content-length') || 0) > max) throw Object.assign(new Error('too_large'), { reason: 'too_large' });
    const chunks = []; let n = 0;
    for await (const ch of r.body) { n += ch.length; if (n > max) throw Object.assign(new Error('too_large'), { reason: 'too_large' }); chunks.push(ch); }
    return { url: u.href, type: r.headers.get('content-type') || '', body: Buffer.concat(chunks) };
  }
  throw Object.assign(new Error('too_many_redirects'), { reason: 'too_many_redirects' });
}

const decode = (s) => String(s || '').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;|&apos;/g, "'").replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(n)).trim();
const meta = (html, key) => decode((html.match(new RegExp(`<meta[^>]+(?:property|name)=["']${key}["'][^>]*content=["']([^"']*)["']`, 'i')) || html.match(new RegExp(`<meta[^>]+content=["']([^"']*)["'][^>]*(?:property|name)=["']${key}["']`, 'i')) || [])[1]);

/** Extract product data from a page. Exported for tests. */
export function extract(html, base) {
  const abs = (x) => { try { return new URL(decode(x), base).href; } catch { return null; } };
  let product = null;
  for (const [, json] of html.matchAll(/<script[^>]+type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi)) {
    try {
      const data = JSON.parse(json.trim());
      const nodes = [data, ...(Array.isArray(data) ? data : []), ...(data['@graph'] || [])].flat();
      product = nodes.find((n) => n && [].concat(n['@type'] || []).includes('Product')) || product;
    } catch { /* invalid JSON-LD is ignored */ }
    if (product) break;
  }
  const ldImages = product ? [].concat(product.image || []).map((i) => (typeof i === 'string' ? i : i?.url || i?.contentUrl)).filter(Boolean) : [];
  const og = [meta(html, 'og:image'), meta(html, 'twitter:image')].filter(Boolean);
  const imgs = [...html.matchAll(/<img\b[^>]*>/gi)].map(([tag]) => {
    const srcset = (tag.match(/\ssrcset=["']([^"']+)["']/i) || [])[1];
    const best = srcset ? srcset.split(',').map((x) => x.trim().split(/\s+/)).sort((a, b) => parseInt(b[1] || '0', 10) - parseInt(a[1] || '0', 10))[0]?.[0] : null;
    return best || (tag.match(/\s(?:data-src|data-original|src)=["']([^"']+)["']/i) || [])[1];
  }).filter((x) => x && !/^data:/.test(x) && !/(logo|icon|sprite|avatar|pixel|blank)\b/i.test(x));
  const videos = [meta(html, 'og:video'), ...[...html.matchAll(/<(?:video|source)\b[^>]*\ssrc=["']([^"']+\.(?:mp4|mov)[^"']*)["']/gi)].map((m) => m[1])].filter(Boolean);
  const images = [...new Set([...ldImages, ...og, ...imgs].map(abs).filter(Boolean))].slice(0, MAX_IMAGES);
  return {
    title: decode(product?.name || meta(html, 'og:title') || (html.match(/<title[^>]*>([^<]*)<\/title>/i) || [])[1]),
    description: decode(product?.description || meta(html, 'og:description') || meta(html, 'description')).slice(0, 2000),
    sku: decode(product?.sku || product?.mpn || ''), brand: decode(typeof product?.brand === 'object' ? product.brand?.name : product?.brand || ''),
    keywords: decode(meta(html, 'keywords')), images, videos: [...new Set(videos.map(abs).filter(Boolean))].slice(0, 5), firstFromData: ldImages.length + og.length,
  };
}

/** Pull a page. mode 'own' downloads images into the product's folders; 'reference' stores text only. */
export async function pull(url, { mode = 'own', productId = '' } = {}) {
  const log = (ok, reason, found = null, created = []) => {
    const r = db.prepare('INSERT INTO pull_logs (ts, url, mode, product_id, ok, reason, found, created, actor) VALUES (?,?,?,?,?,?,?,?,?)')
      .run(new Date().toISOString(), String(url).slice(0, 1000), mode, productId || null, ok ? 1 : 0, reason || null, found ? JSON.stringify(found) : null, JSON.stringify(created), actorName('system'));
    return { id: Number(r.lastInsertRowid), ok, reason, found, created };
  };
  if (mode === 'own' && !productId) return log(false, 'no_product');
  let page;
  try { page = await safeFetch(url); } catch (e) { return log(false, e.reason || 'fetch_failed'); }
  if (!/html/i.test(page.type)) return log(false, 'not_html');
  const found = extract(page.body.toString('utf8'), page.url);
  if (mode === 'reference') return log(Boolean(found.title || found.description), found.title || found.description ? null : 'no_data', { title: found.title, description: found.description, keywords: found.keywords, brand: found.brand });
  if (!found.images.length && !found.videos.length) return log(false, 'no_data', found);
  const { subs } = A.ensureProductFolders(productId);
  const created = [], errors = [];
  let i = 0;
  for (const src of [...found.images, ...found.videos]) {
    try {
      const f = await safeFetch(src, { max: A.MAX_BYTES.video, accept: 'image/*,video/*' });
      const kind = A.detect(f.body)?.kind;
      if (!kind || kind === 'source') { errors.push(`${src}: 不是图片或视频`); continue; }
      if (kind === 'image') { const m = await A.imageTags(f.body); if (Math.min(m.width, m.height) < 300) continue; } // icons, thumbnails
      const sub = kind === 'video' ? '视频' : i === 0 ? '主图' : '副图';
      const a = await A.ingest(f.body, { name: decodeURIComponent(new URL(f.url).pathname.split('/').pop() || 'image'), folderId: subs[sub], source: 'pull', note: `拉取自 ${page.url}`, tags: ['链接拉取'] });
      if (a.auto_tags.includes('长图（详情图）')) A.updateAsset(a.id, { folderId: subs['详情图'] });
      created.push(a.id);
      if (kind === 'image') i++;
    } catch (e) { errors.push(`${src}: ${REASONS[e.reason] || e.message}`); }
  }
  return log(created.length > 0, created.length ? null : 'no_data', { ...found, errors: errors.slice(0, 10) }, created);
}
export const pullLogs = (n = 50) => db.prepare('SELECT * FROM pull_logs ORDER BY id DESC LIMIT ?').all(n).map((r) => ({ ...r, found: r.found ? JSON.parse(r.found) : null, created: JSON.parse(r.created || '[]') }));
REASONS.no_product = '请填写要放入的商品型号';
