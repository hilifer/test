// Demo videos, page tour: one video for every page of both websites (from the built sites), the web shop and customer
// portal, and every admin page (read from the server routes, so new pages are included automatically). Detail pages
// (/admin/orders/:id …) use the first record linked from their list page; demo data is created first.
import { readFileSync, readdirSync, statSync, existsSync } from 'node:fs';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { test, expect, caption, titleCard, tour, LED, GRID, ADMIN } from './helpers.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const walk = (d, out = []) => { for (const f of readdirSync(d)) { const p = join(d, f); if (statSync(p).isDirectory()) walk(p, out); else out.push(p); } return out; };
/** Pages of a built site: every index.html under dist (404 and draft pages left out). */
const sitePages = (site) => {
  const dist = join(ROOT, `sites/${site}/dist`);
  if (!existsSync(dist)) return [];
  return walk(dist).filter((f) => f.endsWith('index.html')).map((f) => f.slice(dist.length).replace(/index\.html$/, '').replace(/\\/g, '/')).sort();
};
/** Admin pages: GET routes under /admin in the server code, minus downloads, images, JSON and actions. */
const adminRoutes = () => {
  const src = walk(join(ROOT, 'server/src')).filter((f) => f.endsWith('.js')).map((f) => readFileSync(f, 'utf8')).join('\n');
  const all = [...new Set([...src.matchAll(/app\.get\('(\/admin[^']*)'/g)].map((m) => m[1]))];
  const skip = /\.(csv|png)$|\/(file|thumb|messages|json|print)(\/|$)|\/assets\/preview\/|\/backups\/|\/quotes\/new$|\/content\/edit$|\/skus\/edit$|\/login$/;
  return all.filter((r) => !skip.test(r)).sort();
};
const SHOP = ['/shop', '/shop/search?q=light', '/shop/cart', '/shop/checkout', '/shop/account/login', '/shop/account/register', '/shop/account/forgot', '/portal'];
const QUERY = { '/admin/warehouse/carriers': '?country=US&kg=5', '/admin/copy': '?product=YR-HB-U2' };

const auth = { authorization: 'Basic ' + Buffer.from(`${ADMIN.username}:${ADMIN.password}`).toString('base64') };
test.beforeAll(async ({ request }) => {
  // demo data so the detail pages have something to show: a lead, a quote sent and accepted, a paid order, a chat
  const lead = await request.post(`${LED}/api/leads`, { data: { email: 'demo.buyer@example.com', company: 'Demo Warehouse Inc.', name: 'Alex Demo', country: 'US', product_id: 'YR-HB-U2', quantity: 200, needs: '200 high bays for a new warehouse', consent: true } });
  expect(lead.ok()).toBeTruthy();
  await request.post(`${LED}/api/chat`, { data: { message: 'Do you have 150W UFO high bays with DLC?' } });
  const list = await (await request.get(`${LED}/admin?scope=all`, { headers: auth })).text();
  const id = list.match(/\/admin\/lead\/([\w-]+)"/)?.[1];
  if (!id) return;
  const q = await request.get(`${LED}/admin/quotes/new?lead=${id}`, { headers: auth, maxRedirects: 0 });
  const qid = (q.headers().location || '').split('?')[0].split('/').pop();
  if (!qid) return;
  await request.post(`${LED}/admin/quotes/${qid}/status`, { headers: { ...auth, origin: LED }, form: { to: 'sent' }, maxRedirects: 0 });
  const token = (await (await request.get(`${LED}/admin/quotes/${qid}`, { headers: auth })).text()).match(/\/portal\/pi\/([\w-]+)/)?.[1];
  if (token) await request.post(`${LED}/portal/pi/${token}`, { form: {}, maxRedirects: 0 });
});

for (const [site, base, name] of [['led', LED, 'YAORONG LED'], ['grid', GRID, 'YR GRID']]) {
  for (const path of sitePages(site)) {
    test(`PG-${site.toUpperCase()} 网站页面 ${name} ${path}`, async ({ page }) => {
      await page.goto(base + path);
      await titleCard(page, `${name} · ${(await page.title()) || path}`, 1200);
      await caption(page, `${name}  ${path}`);
      await tour(page);
    });
  }
}
for (const path of SHOP) {
  test(`PG-SHOP 网店 / 客户中心 ${path}`, async ({ page }) => {
    await page.goto(LED + path);
    await titleCard(page, `网店 · ${(await page.title()) || path}`, 1200);
    await caption(page, `YAORONG LED 网店  ${path}`);
    await tour(page, { steps: 4 });
  });
}

const resolved = new Map();
async function resolvePath(page, route) {
  if (!route.includes(':')) return route + (QUERY[route] || '');
  if (resolved.has(route)) return resolved.get(route);
  const parent = route.split('/:')[0];
  const html = await (await page.request.get(LED + parent, { headers: auth })).text();
  const m = html.match(new RegExp(`${parent.replace(/[/.]/g, '\\$&')}/([^"/?#&]+)`));
  const out = m ? route.replace(/:[a-z]+/, m[1]).replace(/\/:[a-z]+/g, '') : null;
  resolved.set(route, out);
  return out;
}
for (const route of adminRoutes()) {
  test(`PG-ADMIN 后台页面 ${route}`, async ({ staff }) => {
    const page = await staff(ADMIN);
    const path = await resolvePath(page, route);
    test.skip(!path, `没有可展示的记录：${route}`);
    const r = await page.goto(LED + path);
    expect(r.status(), path).toBeLessThan(400);
    await titleCard(page, `后台 · ${await page.title()}`, 1200);
    await caption(page, `后台页面  ${path}`);
    await tour(page, { steps: 4 });
  });
}
