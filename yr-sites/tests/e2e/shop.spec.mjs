// Browser E2E — buying online: buy box on the static product page → cart badge → cart → checkout → order page.
// IDs E2E-Sxx.
import { test, expect } from '@playwright/test';

const LED = 'http://127.0.0.1:4311';
const GRID = 'http://127.0.0.1:4312';

test('E2E-S01 guest buys a product online (bank transfer) @mobile', async ({ page }) => {
  await page.goto(LED + '/products/ufo-high-bay-u2/');
  const box = page.locator('[data-buy-box]');
  await expect(box).toBeVisible();
  await expect(box).toContainText('Buy online');
  await expect(box).toContainText('Min. order 50');
  const qty = box.locator('[data-q]');
  await expect(qty).toHaveValue('50');
  await qty.fill('100000');
  await expect(box.locator('[data-msg]')).toContainText(/Only \d+ available/);
  await expect(box.locator('[data-add]')).toBeDisabled();
  await qty.fill('100');
  await expect(box.locator('[data-price]')).toHaveText('US$52.00');
  await qty.fill('500');
  await expect(box.locator('[data-price]')).toHaveText('US$46.00'); // tier price for 500+
  await qty.fill('100');
  await box.locator('[data-add]').click();
  await expect(box.locator('[data-msg]')).toContainText('Added to cart');
  await expect(page.locator('[data-cart-count]').first()).toHaveText('1');

  await page.goto(LED + '/shop/cart');
  await expect(page.locator('main')).toContainText('UFO High Bay U2');
  await expect(page.locator('input[name="qty"]')).toHaveValue('100');
  await page.getByRole('link', { name: 'Checkout' }).click();
  await page.locator('input[name="email"]').fill('e2e-buyer@shop.test');
  await page.locator('input[name="name"]').fill('E2E Buyer');
  await page.locator('input[name="phone"]').fill('+1 512 555 0199');
  await page.locator('input[name="line1"]').fill('500 Congress Ave');
  await page.locator('input[name="city"]').fill('Austin');
  await page.locator('select[name="country"]').selectOption('US');
  await page.waitForURL(/country=US/);
  // the page reloads with shipping options; re-fill the fields that are not kept in the URL
  await page.locator('input[name="email"]').fill('e2e-buyer@shop.test');
  await page.locator('input[name="name"]').fill('E2E Buyer');
  await page.locator('input[name="phone"]').fill('+1 512 555 0199');
  await page.locator('input[name="line1"]').fill('500 Congress Ave');
  await page.locator('input[name="city"]').fill('Austin');
  await expect(page.locator('input[name="zone"]').first()).toBeVisible();
  await page.locator('input[name="payment"][value="tt"]').check();
  await page.getByRole('button', { name: 'Place order' }).click();
  await expect(page).toHaveURL(/\/shop\/order\/SO-\d{6}-\d{3}\?t=/);
  await expect(page.locator('h1')).toContainText(/Order SO-/);
  await expect(page.locator('main')).toContainText('Awaiting payment');
  await expect(page.locator('main')).toContainText('Payment reference');
  await expect(page.locator('main')).toContainText('500 Congress Ave');
});

test('E2E-S02 中文站购买区与购物车', async ({ page }) => {
  await page.goto(GRID + '/zh/products/ac-wallbox-22/');
  const box = page.locator('[data-buy-box]');
  await expect(box).toBeVisible();
  await expect(box).toContainText('在线购买');
  await box.locator('[data-add]').click();
  await expect(box.locator('[data-msg]')).toContainText('已加入购物车');
  await box.locator('[data-msg] a').click();
  await expect(page).toHaveURL(/\/shop\/cart\?lang=zh/);
  await expect(page.locator('h1')).toHaveText('购物车');
  await expect(page.locator('main')).toContainText('去结算');
});

test('E2E-S03 products sold by quotation only show no buy box', async ({ page, request }) => {
  const p = await (await request.get(LED + '/api/shop/product/YR-SP-X8')).json();
  if (p.salesMode === 'inquiry') {
    await page.goto(LED + '/products/sports-light-x8/');
    await expect(page.locator('[data-buy-box]')).toBeHidden();
  } else {
    await page.goto(LED + '/products/sports-light-x8/');
    await expect(page.locator('[data-buy-box]')).toBeVisible();
  }
  await expect(page.getByRole('button', { name: 'Add to quote list' }).first()).toBeVisible();
});
