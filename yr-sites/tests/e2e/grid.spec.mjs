// Browser E2E — YR GRID site (东南亚光储充站, EN + 中文). IDs E2E-Gxx.
import { test, expect } from '@playwright/test';

const SITE = 'http://127.0.0.1:4312';

// Fresh browser storage per test (not per navigation — the quote list must survive page loads).
test.beforeEach(async ({ page }) => { await page.addInitScript(() => { try { if (!sessionStorage.getItem('e2e')) { localStorage.clear(); sessionStorage.setItem('e2e', '1'); } } catch {} }); });

test('E2E-G01 EN and 中文 home pages render with the YR GRID trademark logo @mobile', async ({ page }) => {
  for (const [path, h1] of [['/', 'Generate it'], ['/zh/', '发电']]) {
    await page.goto(SITE + path);
    await expect(page.locator('h1')).toContainText(h1);
    const logo = page.locator('img[src*="yr-grid-logo"]').first();
    await expect(logo).toBeVisible();
    expect(await logo.evaluate((i) => i.naturalWidth)).toBeGreaterThan(0);
    const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
    expect(overflow).toBeLessThanOrEqual(1);
  }
  await expect(page.locator('html')).toHaveAttribute('lang', /zh/);
});

test('E2E-G02 every internal link on the EN and 中文 home pages resolves', async ({ page, request }) => {
  for (const path of ['/', '/zh/']) {
    await page.goto(SITE + path);
    const hrefs = await page.$$eval('a[href^="/"]', (as) => [...new Set(as.map((a) => a.getAttribute('href').split('#')[0]))]);
    for (const h of hrefs) expect((await request.get(SITE + h)).status(), `${path} → ${h}`).toBeLessThan(400);
  }
});

test('E2E-G03 ROI calculator recalculates live from bill and roof area @mobile', async ({ page }) => {
  await page.goto(SITE + '/calculator/');
  const calc = page.locator('[data-o="payback"]').first();
  await expect(calc).not.toHaveText('–');
  const kwp = page.locator('[data-o="kwp"]').first();
  const before = await kwp.textContent();
  await page.locator('input[name="bill"]').first().fill('30000');
  await page.locator('input[name="roof"]').first().fill('8000');
  await page.locator('input[name="roof"]').first().dispatchEvent('input');
  await expect(kwp).not.toHaveText(before);
  await expect(page.locator('[data-o="capex"]').first()).not.toHaveText('–');
});

test('E2E-G04 中文 chat answers in Chinese with the PI disclaimer', async ({ page }) => {
  await page.goto(SITE + '/zh/');
  await page.locator('.yrc-launch').click();
  const box = page.locator('.yrc.open');
  await expect(box).toContainText('您正在与 AI 助手对话');
  await box.locator('textarea').fill('工商业储能柜 215kWh 2 台 报价多少');
  await box.locator('textarea').press('Enter');
  await expect(box.locator('.yrc-m.bot').last()).toContainText('仅供参考', { timeout: 10_000 });
});

test('E2E-G05 中文 product page + JSON-LD + Markdown twin', async ({ page, request }) => {
  await page.goto(SITE + '/zh/products/ci-storage-cabinet-215/');
  await expect(page.locator('h1')).toBeVisible();
  const ld = await page.$$eval('script[type="application/ld+json"]', (s) => s.map((x) => JSON.parse(x.textContent)));
  expect(ld.flat().some((x) => x['@type'] === 'Product' && x.sku === 'YRG-CS-215L')).toBeTruthy();
  expect((await request.get(SITE + '/products/ci-storage-cabinet-215.md')).ok()).toBeTruthy();
});

test('E2E-G06 sitemap lists both languages with hreflang alternates', async ({ request }) => {
  const xml = await (await request.get(SITE + '/sitemap.xml')).text();
  expect(xml).toContain('/zh/products/');
  expect(xml).toContain('hreflang="zh-CN" href="https://');
  expect(xml).toContain('hreflang="x-default"');
});
