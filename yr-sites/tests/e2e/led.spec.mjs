// Browser E2E — YAORONG LED site (北美外贸站). IDs E2E-Lxx.
import { test, expect } from '@playwright/test';

const SITE = 'http://127.0.0.1:4311';
const ADMIN = { username: 'admin', password: 'e2e-pass' };

// Fresh browser storage per test (not per navigation — the quote list must survive page loads).
test.beforeEach(async ({ page }) => { await page.addInitScript(() => { try { if (!sessionStorage.getItem('e2e')) { localStorage.clear(); sessionStorage.setItem('e2e', '1'); } } catch {} }); });

test('E2E-L01 home page renders; every internal link on it resolves (no 404s) @mobile', async ({ page, request }) => {
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await page.goto(SITE + '/');
  await expect(page.locator('h1')).toContainText('Commercial LED lighting');
  await expect(page.getByText(/sample data|SAMPLE/i).first()).toBeVisible();
  const hrefs = await page.$$eval('a[href^="/"]', (as) => [...new Set(as.map((a) => a.getAttribute('href').split('#')[0]))]);
  expect(hrefs.length).toBeGreaterThan(10);
  for (const h of hrefs) {
    const r = await request.get(SITE + h);
    expect(r.status(), h).toBeLessThan(400);
  }
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
  expect(overflow, 'no horizontal scroll').toBeLessThanOrEqual(1);
  expect(errors).toEqual([]);
});

test('E2E-L02 product page: specs, reference price bands, schema.org Product JSON-LD, Markdown twin', async ({ page, request }) => {
  await page.goto(SITE + '/products/ufo-high-bay-u2/');
  await expect(page.locator('h1')).toContainText('UFO');
  await expect(page.getByText('Reference only — subject to the formal PI.').first()).toBeVisible();
  const ld = await page.$$eval('script[type="application/ld+json"]', (s) => s.map((x) => JSON.parse(x.textContent)));
  const product = ld.flat().find((x) => x['@type'] === 'Product');
  expect(product.sku).toBe('YR-HB-U2');
  expect(product.offers.lowPrice).toBe(32);
  const md = await request.get(SITE + '/products/ufo-high-bay-u2.md');
  expect(md.ok()).toBeTruthy();
  expect(await md.text()).toContain('| Item | Value |');
});

test('E2E-L03 RFQ cart: add two products, edit quantity, submit one request → multi-line lead in admin', async ({ page, browser }) => {
  await page.goto(SITE + '/products/ufo-high-bay-u2/');
  await page.locator('[data-add-quote]').first().click();
  await expect(page.locator('#yrq-toast')).toContainText('Added');
  await page.goto(SITE + '/products/flood-light-f5/');
  await page.locator('[data-add-quote]').first().click();
  await expect(page.locator('[data-quote-count]').first()).toHaveText('2');
  await page.goto(SITE + '/quote/');
  const rows = page.locator('table.qlist tbody tr');
  await expect(rows).toHaveCount(2);
  await rows.first().locator('input[data-k="qty"]').fill('600');
  await rows.first().locator('input[data-k="note"]').fill('200W 5000K');
  await rows.first().locator('input[data-k="note"]').blur();
  const form = page.locator('form[data-lead-form]');
  await form.locator('input[name="email"]').fill('e2e-cart@distributor.test');
  await form.locator('input[name="company"]').fill('E2E Distribution');
  await form.locator('button[type="submit"]').click();
  await expect(form.locator('.qf__msg')).toContainText('Tick the consent box');
  await form.locator('input[name="consent"]').check();
  await form.locator('button[type="submit"]').click();
  await expect(form.locator('.qf__msg')).toContainText('Request sent');
  await expect(page.locator('[data-quote-count]').first()).toBeHidden();

  const ctx = await browser.newContext({ httpCredentials: ADMIN });
  const admin = await ctx.newPage();
  await admin.goto(SITE + '/admin');
  const row = admin.locator('tr', { hasText: 'e2e-cart@distributor.test' });
  await expect(row).toContainText('询价单 2 项');
  await expect(row).toContainText('600 × UFO');
  await row.getByRole('link', { name: '生成报价' }).click();
  await expect(admin.locator('.flash')).toContainText('2 个产品');
  await ctx.close();
});

test('E2E-L04 AI chat widget: AI disclosure, product cards, reference price with disclaimer, lead card', async ({ page }) => {
  await page.goto(SITE + '/products/');
  await page.locator('.yrc-launch').click();
  const box = page.locator('.yrc.open');
  await expect(box).toContainText("You're chatting with an AI assistant");
  await box.locator('textarea').fill('UFO high bay for a warehouse, 600 pcs, what is the price?');
  await box.locator('textarea').press('Enter');
  const bot = box.locator('.yrc-m.bot').last();
  await expect(bot).toContainText('US$', { timeout: 10_000 });
  await expect(bot).toContainText('Reference only');
  await expect(box.locator('.yrc-lead')).toBeVisible();
});

test('E2E-L05 chat keeps working when the API is down (in-browser rules fallback)', async ({ page }) => {
  await page.route('**/api/chat', (r) => r.abort());
  await page.goto(SITE + '/');
  await page.locator('.yrc-launch').click();
  const box = page.locator('.yrc.open');
  await box.locator('textarea').fill('price for 600 pcs ufo high bay');
  await box.locator('textarea').press('Enter');
  await expect(box.locator('.yrc-m.bot').last()).toContainText('Reference only', { timeout: 10_000 });
});

test('E2E-L06 chat lead card saves the contact with consent', async ({ page, browser }) => {
  await page.goto(SITE + '/');
  await page.locator('.yrc-launch').click();
  const box = page.locator('.yrc.open');
  await box.locator('textarea').fill('price for 600 pcs ufo high bay');
  await box.locator('textarea').press('Enter');
  const lead = box.locator('.yrc-lead');
  await expect(lead).toBeVisible({ timeout: 10_000 });
  await lead.locator('input[type=email]').fill('chat-lead@warehouse.test');
  await lead.locator('input[type=checkbox]').check();
  await lead.locator('button').last().click();
  await expect(box).toContainText(/thank|sales engineer/i);
  const ctx = await browser.newContext({ httpCredentials: ADMIN });
  const admin = await ctx.newPage();
  await admin.goto(SITE + '/admin');
  await expect(admin.locator('tr', { hasText: 'chat-lead@warehouse.test' })).toBeVisible();
  await ctx.close();
});

test('E2E-L07 machine-readable layer for AI agents is served', async ({ request }) => {
  const txt = await (await request.get(SITE + '/llms.txt')).text();
  expect(txt).toContain('/mcp');
  expect(txt).toContain('/products/ufo-high-bay-u2.md');
  expect((await request.get(SITE + '/llms-full.txt')).ok()).toBeTruthy();
  expect(await (await request.get(SITE + '/robots.txt')).text()).toContain('GPTBot');
  expect(await (await request.get(SITE + '/sitemap.xml')).text()).toContain('/products/ufo-high-bay-u2/');
  const json = await (await request.get(SITE + '/products.json')).json();
  expect(json.products.length).toBeGreaterThan(5);
  const mcp = await request.post(SITE + '/mcp', { data: { jsonrpc: '2.0', id: 1, method: 'tools/list' } });
  expect((await mcp.json()).result.tools.length).toBe(4);
});

test('E2E-L08 customer portal lookup in the browser (wrong details → friendly error) @mobile', async ({ page }) => {
  await page.goto(SITE + '/portal');
  await page.locator('input[name="order"]').fill('SO-000000-001');
  await page.locator('input[name="email"]').fill('nobody@nowhere.test');
  await page.getByRole('button', { name: 'Find my order' }).click();
  await expect(page.locator('.note.err')).toContainText('could not find');
});

test('E2E-L09 admin requires login; dashboard works for staff', async ({ request, browser }) => {
  expect((await request.get(SITE + '/admin')).status()).toBe(401);
  const ctx = await browser.newContext({ httpCredentials: ADMIN });
  const admin = await ctx.newPage();
  await admin.goto(SITE + '/admin/ops');
  await expect(admin.getByText('闭环看板').first()).toBeVisible();
  await admin.goto(SITE + '/admin/inventory');
  await admin.getByRole('button', { name: /同步/ }).first().click();
  await expect(admin.locator('.flash')).toContainText('已同步');
  await ctx.close();
});

test('E2E-L10 unknown URL shows the branded 404 page', async ({ page }) => {
  const r = await page.goto(SITE + '/no-such-page/');
  expect(r.status()).toBe(404);
  await expect(page.locator('body')).toContainText("That page isn't here");
  await expect(page.locator('.yrc-launch')).toBeVisible();
});
