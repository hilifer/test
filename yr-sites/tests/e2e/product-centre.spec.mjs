// Browser E2E — the product centre end to end: staff create a product with a photo in the admin, press
// "save & publish", the static site is really rebuilt, and the new product page is live with its photo. IDs E2E-Pxx.
import { test, expect } from '@playwright/test';
import { PNG } from '../helpers/xlsx.mjs';

const SITE = 'http://127.0.0.1:4311';

test('E2E-P01 create → upload photo → save & publish → live on the website, found by the AI', async ({ page, request }) => {
  test.setTimeout(120_000);
  await page.goto(SITE + '/admin/login');
  await page.locator('input[name="username"]').fill('admin');
  await page.locator('input[name="password"]').fill('e2e-pass');
  await page.getByRole('button', { name: '登录' }).click();
  await page.goto(SITE + '/admin/products/new');
  const f = (n, v) => page.locator(`[name="${n}"]`).fill(v);
  await f('id', 'E2E-BOLLARD-20');
  await f('name', 'E2E Garden Bollard 20W');
  await page.locator('select[name="category"]').selectOption('area');
  await page.locator('select[name="status"]').selectOption('published');
  await f('summary', 'Aluminium garden bollard created by the end-to-end test.');
  await f('highlights', 'IP65\nAnti-glare optic');
  await f('certifications', 'CE\nRoHS');
  await f('specs', 'Power: 20 W\nIP: IP65\nHeight: 800 mm');
  await f('warranty', '3 years');
  await f('moq', '20');
  await f('lead_min', '15'); await f('lead_max', '25'); await f('sample_min', '5'); await f('sample_max', '7');
  await f('priceBands', '20-199:30-38 | 200+:27-34');
  await f('v_0_sku', 'E2E-BOLLARD-20-30K');
  await f('v_0_options', 'CCT=3000K');
  await f('v_0_price', '36');
  await f('v_0_min_qty', '20');
  await f('v_0_weight_kg', '4.5');
  await page.locator('input[name="upload"]').setInputFiles({ name: 'bollard.png', mimeType: 'image/png', buffer: PNG });
  await page.getByRole('button', { name: '保存并上架' }).click();
  await expect(page.locator('.flash').first()).toContainText('已保存并上架');
  await expect(page.locator('.imgs img')).toHaveCount(1);

  // the AI agent and MCP see it immediately
  const mcp = await (await request.post(SITE + '/mcp', { data: { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'get_product', arguments: { id: 'E2E-BOLLARD-20' } } } })).json();
  expect(mcp.result.structuredContent.name).toBe('E2E Garden Bollard 20W');

  // the static site is rebuilt in the background (~seconds); wait for the new page
  const url = SITE + '/products/e2e-garden-bollard-20w/';
  await expect.poll(async () => (await request.get(url)).status(), { timeout: 90_000, intervals: [1000] }).toBe(200);
  await page.goto(url);
  await expect(page.locator('h1')).toContainText('E2E Garden Bollard 20W');
  const img = page.locator('img[src^="/media/"]').first();
  await expect(img).toBeVisible();
  expect(await img.evaluate((i) => i.naturalWidth)).toBeGreaterThan(0);
  const ld = await page.$$eval('script[type="application/ld+json"]', (s) => s.map((x) => JSON.parse(x.textContent)));
  const product = ld.flat().find((x) => x['@type'] === 'Product');
  expect(product.sku).toBe('E2E-BOLLARD-20');
  expect(product.image[0]).toMatch(/\/media\/[a-f0-9]{24}\.png$/);
  expect(await (await request.get(SITE + '/products/e2e-garden-bollard-20w.md')).text()).toContain('Height | 800 mm');
  expect(await (await request.get(SITE + '/llms.txt')).text()).toContain('E2E Garden Bollard 20W');
});

test('E2E-P02 AI auto-listing: paste product data → process queue → review the draft → it goes live', async ({ page, request }) => {
  test.setTimeout(120_000);
  await page.goto(SITE + '/admin/login');
  await page.locator('input[name="username"]').fill('admin');
  await page.locator('input[name="password"]').fill('e2e-pass');
  await page.getByRole('button', { name: '登录' }).click();
  await page.waitForURL(/\/admin/);
  await page.goto(SITE + '/admin/products/autolist');
  await page.locator('textarea[name="text"]').fill('E2E-AUTO-50 Canopy light 50W\nPower: 50W\nIP rating: IP65\nCCT: 5000K');
  await page.getByRole('button', { name: '加入队列' }).click();
  await expect(page.locator('main')).toContainText('已加入队列');
  await page.getByRole('button', { name: /AI 处理队列/ }).click();
  await expect(page.locator('main')).toContainText('草稿待审核');
  await page.getByRole('link', { name: '审核并上架' }).first().click();
  await expect(page).toHaveURL(/\/admin\/products\/E2E-AUTO-50/);
  await expect(page.locator('[name="id"]')).toHaveValue('E2E-AUTO-50');
  await expect(page.locator('[name="name"]')).toHaveValue('Canopy light 50W');
  await expect(page.locator('[name="specs"]')).toHaveValue(/Power: 50W[\s\S]*IP rating: IP65[\s\S]*CCT: 5000K/);
  await page.getByRole('button', { name: '上架', exact: true }).click();
  await page.locator('.pub').getByRole('button', { name: '发布到网站' }).click();
  await expect.poll(async () => (await request.get(SITE + '/api/shop/product/E2E-AUTO-50')).status(), { timeout: 30_000 }).toBe(200);
  await page.goto(SITE + '/admin/products/autolist');
  await expect(page.locator('main')).toContainText('E2E-AUTO-50');
});

test('E2E-P03 recommend products in bulk → publish → homepage "Recommended products" section; buy box is styled', async ({ page }) => {
  test.setTimeout(120_000);
  await page.goto(SITE + '/admin/login');
  await page.locator('input[name="username"]').fill('admin');
  await page.locator('input[name="password"]').fill('e2e-pass');
  await page.getByRole('button', { name: '登录' }).click();
  await page.waitForURL(/\/admin/);
  await page.goto(SITE + '/admin/products?status=published');
  const rows = page.locator('#rows tr[data-id]');
  const first = await rows.nth(0).getAttribute('data-id');
  const second = await rows.nth(1).getAttribute('data-id');
  await rows.nth(0).locator('input[name="ids"]').check();
  await rows.nth(1).locator('input[name="ids"]').check();
  await page.getByRole('button', { name: '设为推荐' }).click();
  await expect(page.locator('main')).toContainText('已设为推荐 2 个');
  // drag the second row above the first, save the new order
  await page.locator(`#rows tr[data-id="${second}"] .drag`).dragTo(page.locator(`#rows tr[data-id="${first}"] .drag`), { targetPosition: { x: 5, y: 2 } });
  await page.getByRole('button', { name: '保存排序号' }).click();
  await expect(page.locator('main')).toContainText('排序号');
  await page.locator('.pub').getByRole('button', { name: '发布到网站' }).click();
  await expect.poll(async () => (await (await page.request.get(SITE + '/')).text()).includes('Recommended products'), { timeout: 60_000 }).toBe(true);
  await page.goto(SITE + '/');
  const sec = page.locator('[data-featured]');
  await expect(sec.locator('.pc')).toHaveCount(2);
  await page.goto(SITE + '/products/ufo-high-bay-u2/');
  await expect(page.locator('[data-buy-box] .buybox')).toHaveCSS('border-radius', '12px'); // shop widget styles are global, not scoped
});

test('E2E-P04 designer flow: upload to the asset library → preview → list as main image → publish → live on the product page', async ({ page }) => {
  test.setTimeout(150_000);
  const { default: sharp } = await import('sharp');
  const photo = await sharp({ create: { width: 1200, height: 1200, channels: 3, background: '#ffffff' } })
    .composite([{ input: Buffer.from('<svg width="1200" height="1200"><circle cx="600" cy="600" r="300" fill="#ef8f00"/></svg>') }]).jpeg().toBuffer();
  await page.goto(SITE + '/admin/login');
  await page.locator('input[name="username"]').fill('admin');
  await page.locator('input[name="password"]').fill('e2e-pass');
  await page.getByRole('button', { name: '登录' }).click();
  await page.waitForURL(/\/admin\/home/);
  await page.goto(SITE + '/admin/assets');
  await page.locator('#drop input[name="product"]').fill('YR-HB-L4');
  await page.locator('#drop input[type="file"]').first().setInputFiles({ name: 'e2e-main.jpg', mimeType: 'image/jpeg', buffer: photo });
  await page.locator('#drop').getByRole('button', { name: '上传' }).click();
  await expect(page.locator('main')).toContainText('已上传 1 个');
  await page.goto(SITE + '/admin/assets?product=YR-HB-L4');
  const card = page.locator('.card', { hasText: 'e2e-main.jpg' });
  await expect(card).toContainText('白底图');
  await card.locator('a.th').click();
  await expect(page.locator('#stage img')).toBeVisible();
  await page.goBack();
  await card.locator('input[name="ids"]').check();
  await page.locator('#bulk select[name="position"]').selectOption('main');
  await page.locator('#bulk input[name="index"]').fill('1');
  await page.locator('#bulk').getByRole('button', { name: '上架', exact: true }).click();
  await expect(page).toHaveURL(/\/admin\/products\/YR-HB-L4/);
  await expect(page.locator('.flash').first()).toContainText('已上架 1 张到主图');
  const src = await page.locator('.imgs figure img').first().getAttribute('src');
  expect(src).toMatch(/^\/media\/[a-f0-9]{24}\.jpg$/);
  await page.locator('.pub').getByRole('button', { name: '发布到网站' }).click();
  await expect.poll(async () => (await (await page.request.get(SITE + '/products/linear-high-bay-l4/')).text()).includes(src), { timeout: 60_000 }).toBe(true);
  const img = await page.request.get(SITE + src);
  expect(img.headers()['content-type']).toBe('image/jpeg');
});

test('E2E-P05 designer retouches a blemish by painting on the image, then batch-processes in the task center', async ({ page }) => {
  test.setTimeout(120_000);
  const { default: sharp } = await import('sharp');
  const photo = await sharp({ create: { width: 900, height: 900, channels: 3, background: '#f4f4f4' } })
    .composite([{ input: Buffer.from('<svg width="900" height="900"><rect x="300" y="300" width="300" height="300" fill="#1565c0"/><circle cx="450" cy="150" r="14" fill="#000"/></svg>') }]).jpeg({ quality: 95 }).toBuffer();
  await page.goto(SITE + '/admin/login');
  await page.locator('input[name="username"]').fill('admin');
  await page.locator('input[name="password"]').fill('e2e-pass');
  await page.getByRole('button', { name: '登录' }).click();
  await page.waitForURL(/\/admin\/home/);
  await page.goto(SITE + '/admin/assets');
  await page.locator('#drop input[type="file"]').first().setInputFiles({ name: 'e2e-retouch.jpg', mimeType: 'image/jpeg', buffer: photo });
  await page.locator('#drop').getByRole('button', { name: '上传' }).click();
  await expect(page.locator('main')).toContainText('已上传 1 个');
  await page.goto(SITE + '/admin/assets?q=e2e-retouch');
  await page.locator('.card', { hasText: 'e2e-retouch.jpg' }).locator('a.th').click();
  await expect(page.locator('#stage img')).toBeVisible();
  await page.locator('#proc summary').click();
  await page.locator('#op').selectOption('retouch');
  await expect(page.locator('fieldset[data-op="retouch"]')).toBeVisible();
  await expect(page.locator('fieldset[data-op="resize"]')).toBeHidden();
  await expect.poll(() => page.locator('#stage canvas').evaluate((c) => c.width)).toBe(900); // overlay sized to the loaded image
  // paint over the black dot (image point 450,150) on the overlay canvas
  await page.locator('#stage').scrollIntoViewIfNeeded();
  const box = await page.locator('#stage canvas').boundingBox();
  const at = (x, y) => [box.x + (x / 900) * box.width, box.y + (y / 900) * box.height];
  await page.mouse.move(...at(430, 150));
  await page.mouse.down();
  await page.mouse.move(...at(470, 150), { steps: 6 });
  await page.mouse.move(...at(450, 165), { steps: 4 });
  await page.mouse.up();
  await page.locator('#procform').getByRole('button', { name: '开始处理' }).click();
  await expect(page.locator('main')).toContainText('处理完成，已生成 v2');
  const id = page.url().split('/').pop().split('?')[0];
  const v2 = await page.request.get(`${SITE}/admin/assets/file/${id}/2`);
  const { data, info } = await sharp(Buffer.from(await v2.body())).raw().toBuffer({ resolveWithObject: true });
  expect(data[(150 * info.width + 450) * info.channels]).toBeGreaterThan(150); // dot gone
  expect(data[(450 * info.width + 450) * info.channels + 2]).toBeGreaterThan(150); // product still blue
  // batch: white background via the task center
  await page.goto(SITE + '/admin/assets?q=e2e-retouch');
  await page.locator('.card', { hasText: 'e2e-retouch.jpg' }).locator('input[name="ids"]').check();
  await page.locator('#bulk select[name="op"]').selectOption('resize');
  await page.locator('#bulk select[name="preset"]').selectOption('main');
  await page.locator('#bulk').getByRole('button', { name: '加入任务' }).click();
  await expect(page).toHaveURL(/\/admin\/tasks\//);
  await expect(page.locator('main h2')).toContainText('已完成', { timeout: 30_000 }); // the page refreshes itself while running
  await expect(page.locator('main table').first()).toContainText('已生成 v3');
});

test('E2E-P06 title optimisation: product → "Optimise title" → generate → banned words marked → use a title → product renamed, history kept', async ({ page }) => {
  await page.goto(SITE + '/admin/login');
  await page.locator('input[name="username"]').fill('admin');
  await page.locator('input[name="password"]').fill('e2e-pass');
  await page.getByRole('button', { name: '登录' }).click();
  await page.waitForURL(/\/admin\/home/);
  await page.goto(SITE + '/admin/products/YR-PN-B6');
  await page.getByRole('link', { name: '优化标题' }).click();
  await expect(page).toHaveURL(/\/admin\/copy\?product=YR-PN-B6/);
  await page.locator('select[name="direction"]').selectOption('b2b');
  await page.getByRole('button', { name: '生成标题' }).click();
  await expect(page.locator('h3', { hasText: '建议标题' })).toContainText('按商品资料生成');
  const first = page.locator('.tt').first();
  const title = (await first.locator('b').textContent()).trim();
  expect(title).toMatch(/Wholesale & OEM/);
  await first.getByRole('button', { name: '应用到商品' }).click();
  await expect(page.locator('main')).toContainText('标题已应用到商品');
  await expect(page.locator('main')).toContainText(`英文：${title}`);
  await expect(page.locator('table').last()).toContainText('按资料生成');
  // banned words are flagged while typing a manual title
  await page.getByPlaceholder('手动输入标题').fill('Best panel light, FDA approved');
  await page.getByRole('button', { name: '检查并应用' }).click();
  await expect(page.locator('main')).toContainText('标题含违禁词：FDA approved');
  await page.goto(SITE + '/admin/products/YR-PN-B6');
  await expect(page.locator('input[name="name"]')).toHaveValue(title);
});

test('E2E-P07 sales: a new lead waits in the pool → claim it → log a call with a next follow-up → it shows as due → quote from the lead', async ({ page, request }) => {
  const email = `pool-${Date.now()}@buyer.test`;
  expect((await request.post(SITE + '/api/leads', { data: { email, company: 'Pool Buyer LLC', product_id: 'YR-HB-U2', quantity: 120, consent: true } })).ok()).toBe(true);
  await page.goto(SITE + '/admin/login');
  await page.locator('input[name="username"]').fill('admin');
  await page.locator('input[name="password"]').fill('e2e-pass');
  await page.getByRole('button', { name: '登录' }).click();
  await page.waitForURL(/\/admin\/home/);
  await page.goto(SITE + '/admin?scope=pool');
  const row = page.locator('tr', { hasText: email });
  await row.getByRole('button', { name: '领取' }).click();
  await expect(page.locator('main')).toContainText('已领取');
  await expect(page.locator('main')).toContainText('Pool Buyer LLC');
  await page.locator('select[name="kind"]').selectOption('call');
  const past = new Date(Date.now() - 5 * 60e3);
  const local = new Date(past.getTime() - past.getTimezoneOffset() * 60e3).toISOString().slice(0, 16);
  await page.locator('input[name="next_at"]').fill(local);
  await page.locator('textarea[name="content"]').fill('Called the buyer: wants 120 pcs, DLC needed');
  await page.getByRole('button', { name: '保存跟进' }).click();
  await expect(page.locator('main')).toContainText('跟进已保存');
  await expect(page.locator('main')).toContainText('Called the buyer: wants 120 pcs');
  await page.goto(SITE + '/admin?scope=due');
  await expect(page.locator('tr', { hasText: email })).toBeVisible();
  await page.locator('tr', { hasText: email }).getByRole('link', { name: '跟进' }).click();
  await page.getByRole('link', { name: '生成报价' }).first().click();
  await expect(page).toHaveURL(/\/admin\/quotes\//);
  await expect(page.locator('main')).toContainText('负责人 admin');
  await expect(page.locator('main')).toContainText('客户打开记录');
});

test.describe('E2E-P08 operations', () => {
  test.use({ userAgent: 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Safari/537.36' }); // a normal browser, so the page-view beacon counts
  test('E2E-P08 a flash sale created in the admin appears on the home page and the product page, the visit is counted, then it is stopped', async ({ page }) => {
    await page.goto(SITE + '/admin/login');
    await page.locator('input[name="username"]').fill('admin');
    await page.locator('input[name="password"]').fill('e2e-pass');
    await page.getByRole('button', { name: '登录' }).click();
    await page.waitForURL(/\/admin\/home/);
    await page.goto(SITE + '/admin/marketing/promotions');
    const local = (h) => { const d = new Date(Date.now() + h * 3600e3); return new Date(d.getTime() - d.getTimezoneOffset() * 60e3).toISOString().slice(0, 16); };
    await page.locator('input[name="name"]').fill('E2E 工矿灯特价');
    await page.locator('input[name="name_en"]').fill('E2E High bay sale');
    await page.locator('input[name="value"]').fill('20');
    await page.locator('input[name="products"]').fill('YR-HB-U2');
    await page.locator('input[name="starts_at"]').fill(local(-1));
    await page.locator('input[name="ends_at"]').fill(local(24));
    await page.getByRole('button', { name: '创建' }).click();
    await expect(page.locator('main')).toContainText('促销活动已保存');
    try {
      await page.goto(SITE + '/?utm_source=e2e&utm_campaign=e2e-home');
      const zone = page.locator('.promo-zone');
      await expect(zone).toBeVisible();
      await expect(zone).toContainText('E2E High bay sale: 20% off');
      await expect(zone).toContainText('UFO High Bay U2');
      await zone.getByRole('link', { name: /UFO High Bay U2/ }).click();
      await expect(page).toHaveURL(/\/products\/ufo-high-bay-u2\//);
      await expect(page.locator('[data-promo]')).toContainText('E2E High bay sale: 20% off');
      await expect.poll(async () => (await (await page.request.get(SITE + '/admin/marketing')).text()).match(/<span>访客<\/span><strong>(\d+)<\/strong>/)?.[1] * 1 || 0).toBeGreaterThan(0);
      await page.goto(SITE + '/admin/marketing/campaigns');
      await expect(page.locator('main')).toContainText('e2e-home'); // seen in links but not registered yet
    } finally {
      await page.goto(SITE + '/admin/marketing/promotions');
      await page.locator('tr', { hasText: 'E2E 工矿灯特价' }).getByRole('button', { name: '停用' }).click();
      await expect(page.locator('main')).toContainText('已停用');
    }
  });
});
