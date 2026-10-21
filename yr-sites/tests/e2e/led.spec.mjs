// Browser E2E — YAORONG LED site (北美外贸站). IDs E2E-Lxx.
import { test, expect } from '@playwright/test';

const SITE = 'http://127.0.0.1:4311';
const ADMIN = { username: 'admin', password: 'e2e-pass' };
/** Staff log in through the login page (sessions), like a real employee. */
async function adminPage(browser) {
  const ctx = await browser.newContext();
  const page = await ctx.newPage();
  await page.goto(SITE + '/admin/login');
  await page.locator('input[name="username"]').fill(ADMIN.username);
  await page.locator('input[name="password"]').fill(ADMIN.password);
  await page.getByRole('button', { name: '登录' }).click();
  await page.waitForURL(/\/admin/);
  return { ctx, page };
}

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

  const { ctx, page: admin } = await adminPage(browser);
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
  const { ctx, page: admin } = await adminPage(browser);
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
  expect((await mcp.json()).result.tools.length).toBe(6); // search, product, estimate, inquiry, prepare_offer, issue_contract
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
  const { ctx, page: admin } = await adminPage(browser);
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

test('E2E-L11 sales contract: staff create a PI and a contract → the buyer signs online → order created', async ({ browser, page }) => {
  const { ctx, page: admin } = await adminPage(browser);
  await admin.goto(SITE + '/admin/quotes');
  await admin.locator('input[name="email"]').fill('contract-e2e@buyer-co.test');
  await admin.locator('input[name="company"]').fill('E2E Contract Co');
  await admin.getByRole('button', { name: '新建报价' }).click();
  await admin.waitForURL(/\/admin\/quotes\/[\w-]+$/);
  await admin.locator('select[name="sku_0"]').selectOption('YR-HB-U2');
  await admin.locator('input[name="qty_0"]').fill('100');
  await admin.locator('input[name="price_0"]').fill('45');
  await admin.getByRole('button', { name: '保存', exact: true }).click();
  await admin.getByRole('button', { name: '生成合同并发给客户签署' }).click();
  await expect(admin.locator('main')).toContainText('已生成并发到客户邮箱');
  const link = (await admin.locator('code').filter({ hasText: '/portal/contract/' }).first().textContent()).replace(/^https?:\/\/[^/]+/, '');
  await ctx.close();

  await page.goto(SITE + link);
  await expect(page.locator('.doc h1')).toHaveText('Sales Contract');
  await expect(page.locator('.doc')).toContainText('E2E Contract Co');
  await expect(page.locator('.doc')).toContainText('USD 4,500.00');
  await page.locator('input[name="name"]').fill('Jordan Buyer');
  await page.locator('input[name="title"]').fill('Director');
  await page.getByRole('button', { name: 'Sign contract' }).click();
  await expect(page).toHaveURL(new RegExp(link.replace(/[/]/g, '\\/') + '$')); // consent box is required — the form does not submit
  await page.locator('input[name="agree"]').check();
  await page.getByRole('button', { name: 'Sign contract' }).click();
  await expect(page.locator('.note')).toContainText(/Signed — thank you\. Your order number is SO-\d{6}-\d{3}/);
  await expect(page.locator('.doc')).toContainText('Signed electronically by Jordan Buyer, Director');
  await expect(page.locator('.doc')).toContainText('— intact');
  await expect(page.locator('form')).toHaveCount(0);
  await page.locator('.note a').click();
  await expect(page.locator('main')).toContainText(/Awaiting deposit|待付定金/);
});

test('E2E-L12 live chat: visitor asks for a person → salesperson replies in the admin → reply appears in the website widget', async ({ browser, page }) => {
  await page.goto(SITE + '/');
  await page.locator('.yrc-launch').click();
  const box = page.locator('.yrc.open');
  await box.locator('textarea').fill('Can I talk to a person please?');
  await box.locator('textarea').press('Enter');
  await expect(box.locator('.yrc-m.bot').nth(1)).toBeVisible();
  const sid = await page.evaluate(() => JSON.parse(localStorage.getItem('yrchat:sid')));
  expect(sid).toBeTruthy();

  const { ctx, page: admin } = await adminPage(browser);
  await admin.goto(`${SITE}/admin/conv/${sid}`);
  await expect(admin.locator('#log')).toContainText('Can I talk to a person please?');
  await admin.locator('textarea[name="text"]').fill('Hi, this is our sales engineer. How many fixtures do you need?');
  await admin.getByRole('button', { name: '发送' }).click();
  await expect(admin.locator('main')).toContainText('正在人工接待');

  await expect(box.locator('.yrc-m.agent')).toContainText('How many fixtures do you need?', { timeout: 15_000 });
  await expect(box.locator('.yrc-head small')).toContainText('a person is replying');
  const bots = await box.locator('.yrc-m.bot').count();
  await box.locator('textarea').fill('About 400 pieces.');
  await box.locator('textarea').press('Enter');
  await expect(admin.locator('#log')).toContainText('About 400 pieces.', { timeout: 15_000 }); // staff page updates live
  expect(await box.locator('.yrc-m.bot').count()).toBe(bots); // the AI stayed silent
  await ctx.close();
});

test('E2E-L13 admin language: switch to English without a page reload, remembered on the next visit; switch back', async ({ browser }) => {
  const { ctx, page } = await adminPage(browser);
  await page.goto(SITE + '/admin/products');
  await page.evaluate(() => { window.__noReload = true; });
  await page.locator('[data-lang-form] button').click();
  await expect(page.locator('header nav')).toContainText('Leads');
  await expect(page.locator('main h2').first()).toContainText('Products');
  expect(page.url()).toMatch(/\/admin\/products$/);
  await page.goto(SITE + '/admin/dashboard');
  await expect(page.locator('main')).toContainText('Business dashboard');
  await page.locator('[data-lang-form] button').click();
  await expect(page.locator('main')).toContainText('经营看板');
  await ctx.close();
});

test('E2E-L14 customer service: quick reply inserted in the chat reply box → staff end the chat asking for a rating → the visitor rates it in the widget', async ({ browser, page }) => {
  const { ctx, page: admin } = await adminPage(browser);
  await admin.goto(`${SITE}/admin/service/quick-replies`);
  await admin.locator('input[name="title"]').fill('Greeting');
  await admin.locator('textarea[name="body"]').fill('Thanks for reaching out!');
  await admin.getByRole('button', { name: '保存' }).click();
  await expect(admin.locator('main')).toContainText('已保存');

  await page.goto(SITE + '/');
  await page.locator('.yrc-launch').click();
  const box = page.locator('.yrc.open');
  await box.locator('textarea').fill('Can I talk to a person please?');
  await box.locator('textarea').press('Enter');
  await expect(box.locator('.yrc-m.bot').nth(1)).toBeVisible();
  const sid = await page.evaluate(() => JSON.parse(localStorage.getItem('yrchat:sid')));

  await admin.goto(`${SITE}/admin/conv/${sid}`);
  await admin.locator('select[data-quick]').selectOption({ label: 'Greeting（英文）' });
  await expect(admin.locator('textarea[name="text"]')).toHaveValue('Thanks for reaching out!');
  await admin.locator('textarea[name="text"]').press('End');
  await admin.locator('textarea[name="text"]').pressSequentially(' What quantity?');
  await admin.getByRole('button', { name: '发送' }).click();
  await expect(box.locator('.yrc-m.agent')).toContainText('Thanks for reaching out! What quantity?', { timeout: 15_000 });
  await admin.getByRole('button', { name: '结束并请客户评价' }).click();

  const rate = box.locator('[data-rate]');
  await expect(rate).toBeVisible({ timeout: 15_000 });
  await rate.getByRole('button', { name: 'Send rating' }).click();
  await expect(rate).toContainText('Please choose a star rating');
  await rate.getByRole('button', { name: 'Yes' }).click();
  await rate.getByRole('button', { name: '5/5' }).click();
  await rate.locator('textarea').fill('Very helpful');
  await rate.getByRole('button', { name: 'Send rating' }).click();
  await expect(box).toContainText('Thank you for your feedback!');

  await admin.goto(`${SITE}/admin/service/performance`);
  await expect(admin.locator('main')).toContainText('Very helpful');
  await ctx.close();
});
