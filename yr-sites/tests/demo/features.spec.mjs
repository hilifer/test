// Demo videos, feature walkthroughs: each role's daily work, step by step with captions — the workbench of every role,
// warehouse picking and bulk shipping, finance, customer service, approvals, the global board, notifications, the ops
// center, marketing promotions. (The browser E2E flows in tests/e2e are recorded too; see the CI demo bundle.)
import { test, expect, caption, titleCard, tour, ensureStaff, LED, ADMIN, PW } from './helpers.mjs';

const auth = { authorization: 'Basic ' + Buffer.from(`${ADMIN.username}:${ADMIN.password}`).toString('base64') };
const ROLES = [['sam', 'sales', '销售'], ['max', 'sales_manager', '销售主管'], ['fay', 'finance', '财务'], ['wes', 'warehouse', '仓库 / 物流'], ['sue', 'service', '客服'], ['dee', 'designer', '美工'], ['cat', 'content', '内容运营'], ['ozz', 'ops', '运维']];
const as = (u) => ({ username: u, password: PW });

/** Inquiry → PI sent → accepted by the customer → paid in full → ready to ship. */
async function readyOrder(request, email) {
  await request.post(`${LED}/api/leads`, { data: { email, company: `${email.split('@')[0]} Ltd`, product_id: 'YR-HB-U2', quantity: 100, consent: true } });
  const list = await (await request.get(`${LED}/admin?scope=all&q=${encodeURIComponent(email)}`, { headers: auth })).text();
  const lead = list.match(/\/admin\/lead\/([\w-]+)"/)[1];
  const q = (await request.get(`${LED}/admin/quotes/new?lead=${lead}`, { headers: auth, maxRedirects: 0 })).headers().location.split('?')[0].split('/').pop();
  await request.post(`${LED}/admin/quotes/${q}/status`, { headers: { ...auth, origin: LED }, form: { to: 'sent' }, maxRedirects: 0 });
  const token = (await (await request.get(`${LED}/admin/quotes/${q}`, { headers: auth })).text()).match(/\/portal\/pi\/([\w-]+)/)[1];
  await request.post(`${LED}/portal/pi/${token}`, { form: {}, maxRedirects: 0 });
  const row = (await (await request.get(`${LED}/admin/orders`, { headers: auth })).text()).split('<tr>').find((r) => r.includes(email.split('@')[0]));
  const id = row.match(/\/admin\/orders\/([\w-]+)/)[1];
  const total = (await (await request.get(`${LED}/admin/orders/${id}`, { headers: auth })).text()).match(/合计[^\d]*([\d,]+(?:\.\d+)?)/)[1].replace(/,/g, '');
  await request.post(`${LED}/admin/orders/${id}/payment`, { headers: { ...auth, origin: LED }, form: { kind: 'deposit', amount: total }, maxRedirects: 0 });
  await request.post(`${LED}/admin/orders/${id}/status`, { headers: { ...auth, origin: LED }, form: { to: 'ready_to_ship' }, maxRedirects: 0 });
  return id;
}

test.beforeAll(async ({ request }) => {
  await ensureStaff(request, LED, ROLES.map(([u, r]) => [u, r]));
  for (const e of ['northwind@example.com', 'contoso@example.com']) await readyOrder(request, e);
});

test('FT-01 每个岗位登录后看到自己的工作台和菜单', async ({ staff }) => {
  for (const [u, , label] of ROLES) {
    const page = await staff(as(u));
    await page.goto(`${LED}/admin/home`);
    await titleCard(page, `${label}的工作台`, 1000);
    await caption(page, `${label}（${u}）：只看到自己岗位的指标、待办和菜单`);
    await expect(page.locator('main h2').first()).toContainText('的工作台');
    await tour(page, { steps: 3 });
  }
});

test('FT-02 仓库：打印拣货单，填运单号批量发货，库存自动扣减', async ({ staff }) => {
  const page = await staff(as('wes'));
  await page.goto(`${LED}/admin/warehouse`);
  await titleCard(page, '仓库：拣货与批量发货');
  await caption(page, '发货台列出待发货的订单，可以勾选后打印拣货单');
  await page.locator('input[name=ids]').first().check();
  await page.locator('input[name=ids]').nth(1).check();
  const [pick] = await Promise.all([page.waitForEvent('popup'), page.getByRole('button', { name: '打印选中订单的拣货单' }).click()]);
  await pick.waitForLoadState();
  await caption(pick, '拣货单：按 SKU 汇总数量和箱数，再按订单列出明细');
  await tour(pick, { steps: 3 });
  await pick.close();
  await caption(page, '在每行填物流商和运单号，一次提交');
  const carriers = page.locator('input[name^=carrier_]'), tracks = page.locator('input[name^=tracking_]');
  await carriers.first().fill('DHL'); await tracks.first().fill('DHL-DEMO-001');
  await carriers.nth(1).fill('UPS'); await tracks.nth(1).fill('1Z-DEMO-002');
  await page.getByRole('button', { name: '按填写的运单号批量发货' }).click();
  await expect(page.locator('main')).toContainText('批量发货结果：成功 2');
  await caption(page, '两单都已发货，客户会收到物流通知');
  await page.goto(`${LED}/admin/warehouse/stock?kind=ship`);
  await caption(page, '库存与出入库：发货自动扣减库存并留下记录');
  await tour(page, { steps: 3 });
});

test('FT-03 财务：应收账龄、对账、月报、商业发票', async ({ staff }) => {
  const page = await staff(as('fay'));
  await page.goto(`${LED}/admin/finance`);
  await titleCard(page, '财务：应收、对账与报表');
  await caption(page, '应收账款按账龄分组，逾期的标红，可以一键催款');
  await tour(page, { steps: 3 });
  await page.goto(`${LED}/admin/finance/reconcile`);
  await caption(page, '对账：上传 Stripe / PayPal / 银行流水，自动匹配收款');
  await tour(page, { steps: 2 });
  await page.goto(`${LED}/admin/finance/report`);
  await caption(page, '月度报表：订单额、回款、退款、折扣和运费');
  await tour(page, { steps: 2 });
  await page.goto(`${LED}/admin/orders`);
  await page.locator('a[href^="/admin/orders/"]').first().click();
  await caption(page, '订单页可以生成商业发票和装箱单');
  const href = await page.locator('a[href$="/invoice"]').first().getAttribute('href');
  await page.goto(LED + href);
  await caption(page, '商业发票：海关编码、发票号、合计');
  await tour(page, { steps: 2 });
});

test('FT-04 客服：收件箱、快捷回复、知识库让 AI 先回答、绩效', async ({ staff }) => {
  const page = await staff(as('sue'));
  await page.goto(`${LED}/admin/service/kb`);
  await titleCard(page, '客服：收件箱、快捷回复、知识库');
  await caption(page, '在知识库里添加一条问答，AI 回答客户时会优先使用');
  await page.locator('input[name=question]').fill('How long is the warranty?');
  await page.locator('textarea[name=answer]').fill('All YAORONG fixtures carry a 5-year warranty.');
  await page.locator('input[name=keywords]').fill('guarantee, years');
  await page.getByRole('button', { name: '保存' }).last().click();
  await page.locator('input[name=test]').fill('what warranty do you offer');
  await page.getByRole('button', { name: '试一试' }).click();
  await caption(page, '“试一试”：输入客户问题，看会匹配到哪一条');
  await page.goto(`${LED}/admin/service/quick-replies`);
  await caption(page, '快捷回复：常用回答在对话和邮件回复框里一键插入');
  await page.locator('input[name=title]').fill('Lead time');
  await page.locator('textarea[name=body]').fill('Standard lead time is 15–20 days after the deposit.');
  await page.getByRole('button', { name: '保存' }).last().click();
  await page.goto(`${LED}/admin/service`);
  await caption(page, '统一收件箱：网站聊天、客户邮件、联系表单、售后申请在一个列表');
  await tour(page, { steps: 2 });
  await page.goto(`${LED}/admin/service/performance`);
  await caption(page, '客服绩效：首次响应、解决率、客户评分');
  await tour(page, { steps: 2 });
});

test('FT-05 审批流：销售发送大折扣报价被拦下，主管审批后再发送成功', async ({ staff, request }) => {
  const boss = await staff(ADMIN);
  await boss.goto(`${LED}/admin/approvals/settings`);
  await titleCard(boss, '审批流：大额折扣需要销售主管审批');
  await caption(boss, '管理员开启"报价折扣超过 10% 需要销售主管审批"');
  await boss.locator('input[name="quote_discount.enabled"]').check();
  await boss.locator('input[name="quote_discount.percent"]').fill('10');
  await boss.getByRole('button', { name: '保存' }).click();
  await expect(boss.locator('main')).toContainText('已保存');
  await request.post(`${LED}/api/leads`, { data: { email: 'bigdeal@example.com', company: 'Big Deal Corp', product_id: 'YR-HB-U2', quantity: 100, consent: true } });
  const sam = await staff(as('sam'));
  await sam.goto(`${LED}/admin?scope=all&q=bigdeal`);
  await sam.locator('a[href^="/admin/lead/"]').first().click();
  await sam.getByRole('link', { name: '生成报价' }).click();
  await caption(sam, '销售填写 20% 的折扣并点发送');
  const sub = Number((await sam.locator('main').innerText()).match(/小计[^\d]*([\d,]+)/)?.[1]?.replace(/,/g, '') || 5000);
  await sam.locator('input[name=discount]').fill(String(Math.round(sub * 0.2)));
  await sam.getByRole('button', { name: /发送/ }).first().click();
  await expect(sam.locator('main')).toContainText('需要审批');
  await caption(sam, '系统自动提交审批单，并推送企业微信');
  const max = await staff(as('max'));
  await max.goto(`${LED}/admin/approvals`);
  await caption(max, '销售主管在"待我审批"里看到申请，填写意见后通过');
  await max.locator('input[name=note]').first().fill('重点客户，同意');
  await max.getByRole('button', { name: '通过' }).first().click();
  await expect(max.locator('main')).toContainText('已通过');
  await sam.reload();
  await caption(sam, '销售再发送一次，报价顺利发出');
  await sam.getByRole('button', { name: /发送/ }).first().click();
  await expect(sam.locator('main')).toContainText('已发送');
});

test('FT-06 老板：全局看板和各岗位待办积压', async ({ staff }) => {
  const page = await staff(ADMIN);
  await page.goto(`${LED}/admin/board`);
  await titleCard(page, '全局看板');
  await caption(page, '销售、运营、财务、物流、客服、系统的关键指标一页看全');
  await tour(page, { steps: 4 });
  await caption(page, '最下面是各岗位工作台的待办积压，超过 10 条标黄');
});

test('FT-07 消息提醒：每个人选择要接收的事件，群里 @ 到本人', async ({ staff }) => {
  const page = await staff(as('wes'));
  await page.goto(`${LED}/admin/me#notify`);
  await titleCard(page, '重要事件提醒');
  await caption(page, '只列出自己有权限看的事件，勾选后填企业微信账号或手机号');
  await page.locator('input[value=shipment_exception]').check();
  await page.locator('input[name=wecom_id]').fill('wes.li');
  await page.getByRole('button', { name: '保存提醒设置' }).click();
  await expect(page.locator('main')).toContainText('提醒设置已保存');
  const boss = await staff(ADMIN);
  await boss.goto(`${LED}/admin/users/notify`);
  await caption(boss, '管理员设置每类事件是否发到群里，并能看到谁订阅了、最近推送了什么');
  await tour(boss, { steps: 3 });
});

test('FT-08 运维：服务连通性、定时任务、错误日志、两站状态、配置检查', async ({ staff }) => {
  const page = await staff(as('ozz'));
  for (const [path, text] of [['/admin/system', '系统状态：版本、内存、磁盘、数据库备份，可以立即备份'], ['/admin/system/services', '服务连通性：一键测试大模型、金蝶、支付、物流、邮件、企业微信'], ['/admin/system/jobs', '定时任务：看上次结果和下次时间，可以立即运行或暂停'], ['/admin/system/errors', '错误日志：相同错误合并计数，可以标记已解决'], ['/admin/system/security', '登录与会话：最近登录、失败次数，可以强制下线'], ['/admin/system/config', '配置检查：哪些必填项没配、哪些是弱口令']]) {
    await page.goto(LED + path);
    if (path === '/admin/system') await titleCard(page, '运维中心');
    await caption(page, text);
    await tour(page, { steps: 2 });
  }
  await page.goto(`${LED}/admin/system/jobs`);
  await page.getByRole('button', { name: '立即运行' }).first().click();
  await caption(page, '手动运行一个定时任务，结果写入运行记录');
});

test('FT-09 运营：促销活动、首页推荐位、关键词排名、邮件营销', async ({ staff }) => {
  const page = await staff(as('cat'));
  for (const [path, text] of [['/admin/marketing', '运营看板：访客、转化漏斗、热门商品'], ['/admin/marketing/promotions', '促销活动：满减和折扣，到时间自动生效，网店价格自动计算'], ['/admin/marketing/zones', '首页推荐位和新品区：手动指定或按规则自动'], ['/admin/marketing/emails', '邮件营销：按客户分组发送，统计打开和退订'], ['/admin/marketing/seo', '关键词排名和 AI 搜索提及趋势'], ['/admin/marketing/campaigns', '广告来源统计：每个来源带来的询盘和订单']]) {
    await page.goto(LED + path);
    if (path === '/admin/marketing') await titleCard(page, '运营：营销与增长');
    await caption(page, text);
    await tour(page, { steps: 2 });
  }
});

test('FT-10 销售：线索分配规则、业绩目标、报价模板、客户 360', async ({ staff }) => {
  const page = await staff(as('max'));
  for (const [path, text] of [['/admin', '线索列表：评级、负责人、公海，可筛选和批量分配'], ['/admin/sales/settings', '分配规则：按国家、产品轮流分配，超时未跟进回收到公海'], ['/admin/sales/performance', '销售业绩：报价额、成交额、回款和目标完成度'], ['/admin/quotes/templates', '报价模板：常用条款和产品组合一键带入'], ['/admin/customers', '客户档案：等级、VIP、标签、生日和节日提醒']]) {
    await page.goto(LED + path);
    if (path === '/admin') await titleCard(page, '销售：线索到成交');
    await caption(page, text);
    await tour(page, { steps: 2 });
  }
});
