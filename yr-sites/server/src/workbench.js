// 岗位工作台：登录后首页。每个板块对应一项权限，所以内置岗位、自定义岗位和一人多岗都自动得到自己的工作台：
// 上方是关键指标，中间是"今天要处理的事"（点一下直达），下方是常用入口。
import { db } from './db.js';
import { config } from './config.js';
import { shell, esc, fmt } from './admin.js';
import { currentUser, can, roleNames } from './auth.js';
import { stockView } from './ops/service.js';
import { listArticles } from './content/store.js';
import { backupRuns } from './ops/backup.js';
import { isDirty } from './catalog/store.js';
import { usage } from './assets/store.js';
import { listTasks } from './tasks.js';
import { systemStatus } from './ops/backup.js';
import { errorStats } from './ops/errors.js';
import { failingServices, peerSites, lastChecks } from './ops/services.js';
import { listJobs } from './jobs.js';
import { funnel, productStats } from './marketing/analytics.js';
import { running as runningPromos } from './marketing/promotions.js';
import { seesAllLeads, dueFollowups, performance, upcomingDates } from './sales/crm.js';
import { backupOverdue, drillOverdue } from './ops/security.js';

// storage usage walks the files: cache it for a minute
let usageMemo = { t: 0, v: null };
const usageCached = () => { if (!usageMemo.v || Date.now() - usageMemo.t > 60e3) usageMemo = { t: Date.now(), v: usage() }; return usageMemo.v; };

const n = (sql, ...a) => db.prepare(sql).get(...a).n;
const v = (sql, ...a) => Number(db.prepare(sql).get(...a).v || 0);
const since = (h) => new Date(Date.now() - h * 3600e3).toISOString();
const money = (x) => `${config.catalog.currency || 'USD'} ${Math.round(x).toLocaleString('en-US')}`;
const todo = (rows, text, href) => rows.map((r) => ({ text: text(r), href: href(r) }));

/** Board definitions: perm → { title, kpis, todos, links }. Order = display order. */
const BOARDS = [
  { perm: 'leads', title: '销售：线索', build: () => {
    const me = currentUser();
    const all = seesAllLeads(me);
    const mine = all ? '' : 'AND owner = ?';
    const args = all ? [] : [me.username];
    const month = new Date().toISOString().slice(0, 7);
    const perf = performance([month], { users: all ? null : [me.username] });
    const sum = (k) => perf.reduce((a, p) => a + p.months[month][k], 0);
    const pool = n('SELECT COUNT(*) n FROM leads WHERE owner IS NULL AND status IN (\'new\',\'contacted\',\'quoted\')');
    const dueRows = dueFollowups(me.username);
    const fresh = db.prepare(`SELECT id, grade, company, name, email, owner FROM leads WHERE status = 'new' AND grade IN ('A','B') AND created_at >= ? ${all ? '' : 'AND (owner = ? OR owner IS NULL)'} ORDER BY created_at DESC LIMIT 5`).all(since(72), ...args);
    const unsigned = n(`SELECT COUNT(*) n FROM contracts k JOIN quotes q ON q.id = k.quote_id WHERE k.status = 'sent' ${all ? '' : 'AND q.owner = ?'}`, ...args);
    const deposit = n(`SELECT COUNT(*) n FROM orders o JOIN quotes q ON q.id = o.quote_id WHERE o.status = 'awaiting_deposit' ${all ? '' : 'AND q.owner = ?'}`, ...args);
    const opened = db.prepare(`SELECT q.id, q.number, MAX(v.ts) ts FROM link_views v JOIN quotes q ON q.id = v.ref_id WHERE v.kind = 'quote' AND v.ts >= ? AND q.status = 'sent' ${all ? '' : 'AND q.owner = ?'} GROUP BY q.id ORDER BY ts DESC LIMIT 5`).all(since(48), ...args);
    const dates = upcomingDates(7, Date.now(), all ? null : me.username);
    return {
      kpis: [['今日新线索（A/B）', n(`SELECT COUNT(*) n FROM leads WHERE created_at >= ? AND grade IN ('A','B') ${mine}`, since(24), ...args), '/admin?scope=all&grade=A'], ['今天要跟进', dueRows.length, '/admin?scope=due'], ['公海线索', pool, '/admin?scope=pool'],
        ['本月报价额', money(sum('quoted')), '/admin/sales/performance'], ['本月成交额', money(sum('wonAmount')), '/admin/sales/performance'], ['待客户签合同', unsigned, '/admin/contracts'], ['待收定金', deposit, '/admin/orders?status=awaiting_deposit']],
      todos: [...dueRows.slice(0, 6).map((l) => ({ text: `跟进到期：${l.company || l.name || l.email}`, href: `/admin/lead/${l.id}` })), ...fresh.map((r) => ({ text: `${r.grade} 级线索：${r.company || r.name || r.email}${r.owner ? '' : '（公海，可领取）'}`, href: `/admin/lead/${r.id}` })),
        ...opened.map((q) => ({ text: `客户刚打开了报价 ${q.number}，可以跟进了`, href: `/admin/quotes/${q.id}` })),
        ...dates.map((d) => { const when = d.in ? `${d.in} 天后` : '今天'; return d.kind === 'birthday' ? { text: `客户生日（${when}）：${d.customer.company || d.customer.contact || d.customer.email}`, href: `/admin/customers/${d.customer.id}` } : { text: `${d.name}（${when}）：给 VIP 客户发祝福 · ${d.vipCount}`, href: '/admin/customers?vip=1' }; })],
      links: [['线索', '/admin'], ['公海', '/admin?scope=pool'], ['销售业绩', '/admin/sales/performance'], ['报价', '/admin/quotes'], ['报价模板', '/admin/quotes/templates'], ['客户', '/admin/customers']] };
  } },
  { perm: 'chat', title: '客服：在线对话', build: () => ({
    kpis: [['等待人工回复', n('SELECT COUNT(*) n FROM conversations WHERE waiting = 1 AND agent IS NOT NULL'), '/admin/conversations'], ['待接待（转人工）', n('SELECT COUNT(*) n FROM conversations WHERE handoff = 1 AND agent IS NULL AND updated_at >= ?', since(72)), '/admin/conversations'], ['今日对话', n('SELECT COUNT(*) n FROM conversations WHERE started_at >= ?', since(24)), '/admin/conversations']],
    todos: todo(db.prepare('SELECT id, handoff_reason, agent, waiting FROM conversations WHERE (waiting = 1 AND agent IS NOT NULL) OR (handoff = 1 AND agent IS NULL AND updated_at >= ?) ORDER BY updated_at DESC LIMIT 6').all(since(72)), (r) => (r.waiting ? '客户等待回复' : `转人工：${r.handoff_reason || ''}`), (r) => `/admin/conv/${r.id}`),
    links: [['对话', '/admin/conversations']] }) },
  { perm: 'quotes', title: '销售：报价与合同', build: () => ({
    kpis: [['草稿报价待发送', n("SELECT COUNT(*) n FROM quotes WHERE status = 'draft'"), '/admin/quotes'], ['待客户签署合同', n("SELECT COUNT(*) n FROM contracts WHERE status = 'sent'"), '/admin/contracts'], ['本月成交额', money(v("SELECT SUM(total) v FROM orders WHERE status != 'cancelled' AND created_at >= ?", new Date(new Date().getFullYear(), new Date().getMonth(), 1).toISOString())), '/admin/orders']],
    todos: todo(db.prepare("SELECT id, number FROM quotes WHERE status = 'draft' ORDER BY created_at DESC LIMIT 5").all(), (r) => `报价 ${r.number} 待发送`, (r) => `/admin/quotes/${r.id}`),
    links: [['报价/PI', '/admin/quotes'], ['合同', '/admin/contracts'], ['客户', '/admin/customers']] }) },
  { perm: 'deals', title: '财务：议价审批', build: () => ({
    kpis: [['待审批报价', n("SELECT COUNT(*) n FROM deal_offers WHERE status = 'needs_approval'"), '/admin/deals?status=needs_approval']],
    todos: todo(db.prepare("SELECT id, number, total, currency FROM deal_offers WHERE status = 'needs_approval' ORDER BY created_at LIMIT 6").all(), (r) => `议价 ${r.number} 待审批（${r.currency} ${r.total}）`, (r) => `/admin/deals/${r.id}`),
    links: [['AI 议价', '/admin/deals'], ['授权政策与底价', '/admin/deals/policy']] }) },
  { perm: 'payments', title: '财务：收款', build: () => ({
    kpis: [['待收定金', n("SELECT COUNT(*) n FROM orders WHERE status = 'awaiting_deposit'"), '/admin/orders?status=awaiting_deposit'], ['待收尾款', n("SELECT COUNT(*) n FROM orders WHERE status IN ('in_production','ready_to_ship') AND paid < total AND channel IS NOT 'shop'"), '/admin/orders'], ['今日到账', money(v("SELECT SUM(amount) v FROM payments WHERE ts >= ? AND amount > 0", since(24))), '/admin/orders']],
    todos: todo(db.prepare("SELECT id, number, total, paid, currency FROM orders WHERE status = 'awaiting_deposit' ORDER BY created_at LIMIT 6").all(), (r) => `订单 ${r.number} 待收定金`, (r) => `/admin/orders/${r.id}`),
    links: [['订单', '/admin/orders'], ['网店', '/admin/shop']] }) },
  { perm: 'shipments', title: '仓库：发货与物流', build: () => ({
    kpis: [['待发货订单', n("SELECT COUNT(*) n FROM orders WHERE status = 'ready_to_ship'"), '/admin/orders?status=ready_to_ship'], ['运输中', n("SELECT COUNT(*) n FROM shipments WHERE status = 'in_transit'"), '/admin/shipments'], ['物流异常', n("SELECT COUNT(*) n FROM shipments WHERE status = 'exception'"), '/admin/shipments']],
    todos: [...todo(db.prepare("SELECT id, number FROM orders WHERE status = 'ready_to_ship' ORDER BY created_at LIMIT 5").all(), (r) => `订单 ${r.number} 待发货`, (r) => `/admin/orders/${r.id}`),
      ...todo(db.prepare("SELECT id, number FROM shipments WHERE status = 'exception' LIMIT 3").all(), (r) => `发货单 ${r.number} 物流异常`, (r) => `/admin/shipments/${r.id}`)],
    links: [['发货物流', '/admin/shipments'], ['运费模板', '/admin/shop/freight']] }) },
  { perm: 'rma', title: '售后', build: () => ({
    kpis: [['未结售后', n("SELECT COUNT(*) n FROM rmas WHERE status IN ('submitted','reviewing','approved')"), '/admin/rma']],
    todos: todo(db.prepare("SELECT id, number, issue FROM rmas WHERE status IN ('submitted','reviewing') ORDER BY created_at LIMIT 6").all(), (r) => `售后 ${r.number} 待处理`, (r) => `/admin/rma/${r.id}`),
    links: [['售后', '/admin/rma']] }) },
  { perm: 'inventory', title: '库存', build: () => { const low = stockView().filter((s) => s.active && s.available < 20); return {
    kpis: [['低库存 SKU（可售 &lt; 20）', low.length, '/admin/inventory']],
    todos: low.slice(0, 6).map((s) => ({ text: `${s.sku} 可售 ${s.available}`, href: '/admin/inventory' })),
    links: [['SKU 中心', '/admin/skus'], ['库存 / 金蝶', '/admin/inventory']] }; } },
  { perm: 'catalog', title: '商品', build: () => ({
    kpis: [['草稿商品', n("SELECT COUNT(*) n FROM products WHERE status = 'draft'"), '/admin/products?status=draft'], ['AI 上架待审核', n("SELECT COUNT(*) n FROM listing_jobs WHERE status = 'drafted'"), '/admin/products/autolist?status=drafted'], ['未发布的修改', isDirty() ? '有' : '无', '/admin/products']],
    todos: todo(db.prepare("SELECT product_id FROM listing_jobs WHERE status = 'drafted' ORDER BY updated_at DESC LIMIT 5").all(), (r) => `AI 生成的 ${r.product_id} 待审核上架`, (r) => `/admin/products/${encodeURIComponent(r.product_id)}`),
    links: [['商品', '/admin/products'], ['新增商品', '/admin/products/new'], ['AI 自动上架', '/admin/products/autolist']] }) },
  { perm: 'assets', title: '美工：素材', build: () => {
    const noImage = db.prepare("SELECT id, data FROM products WHERE status = 'published'").all().filter((r) => !(JSON.parse(r.data).images || []).length).map((r) => r.id);
    const lowRes = db.prepare("SELECT id, original_name, product_id FROM assets WHERE status = 'active' AND product_id IS NOT NULL AND auto_tags LIKE '%低分辨率%' ORDER BY created_at DESC LIMIT 4").all();
    const u = usageCached();
    const failedTasks = listTasks({ user: currentUser()?.username, status: 'failed', limit: 3 });
    return {
      kpis: [['本周上传', n("SELECT COUNT(*) n FROM assets WHERE created_at >= ?", since(24 * 7)), '/admin/assets?sort=new'], ['空间使用', `${u.pct}%`, '/admin/assets/settings'], ['缺主图的在售商品', noImage.length, '/admin/products?status=published'], ['回收站', u.trashed, '/admin/assets/trash']],
      todos: [...noImage.slice(0, 5).map((id) => ({ text: `${id} 还没有主图`, href: `/admin/assets?product=${encodeURIComponent(id)}` })), ...lowRes.map((a) => ({ text: `${a.product_id} 的 ${a.original_name} 分辨率不足 800 px`, href: `/admin/assets/${a.id}` })), ...(u.pct >= 80 ? [{ text: `素材空间已用 ${u.pct}%`, href: '/admin/assets/settings' }] : []), ...failedTasks.map((t) => ({ text: `任务"${t.title}"有失败项，可重试`, href: `/admin/tasks/${t.id}` }))],
      links: [['素材仓库', '/admin/assets'], ['链接拉取', '/admin/assets/pull'], ['水印', '/admin/assets/watermarks'], ['任务中心', '/admin/tasks']] };
  } },
  { perm: 'marketing', title: '运营：营销', build: () => {
    const f = funnel(1);
    const ending = runningPromos().filter((p) => Date.parse(p.ends_at) - Date.now() < 48 * 3600e3);
    const stats = productStats(30);
    const weak = [...stats.entries()].filter(([, s]) => s.views >= 30 && !s.carts).slice(0, 3);
    return {
      kpis: [['今日访客', f.visitors, '/admin/marketing'], ['商品浏览', f.productViews, '/admin/marketing'], ['加购', f.carts, '/admin/marketing'], ['下单转化率', f.conversion == null ? '—' : `${(f.conversion * 100).toFixed(1)}%`, '/admin/marketing'],
        ['在线成交额', money(f.revenue), '/admin/marketing'], ['待审核评价', n("SELECT COUNT(*) n FROM reviews WHERE status = 'pending'"), '/admin/reviews'], ['待发布文章', listArticles().filter((x) => x.data.status === 'draft').length, '/admin/content']],
      todos: [...todo(db.prepare("SELECT id, product_id, rating FROM reviews WHERE status = 'pending' ORDER BY created_at LIMIT 5").all(), (r) => `${r.product_id} 的 ${r.rating} 星评价待审核`, () => '/admin/reviews'),
        ...ending.map((p) => ({ text: `促销"${p.name}"将在 48 小时内结束`, href: '/admin/marketing/promotions' })), ...weak.map(([id]) => ({ text: `${id} 浏览多但没人加购，检查价格和主图`, href: `/admin/products/${encodeURIComponent(id)}` }))],
      links: [['经营数据', '/admin/marketing'], ['商品数据', '/admin/marketing/products'], ['推广活动', '/admin/marketing/campaigns'], ['限时折扣 / 满减', '/admin/marketing/promotions'], ['优惠券', '/admin/coupons'], ['评价', '/admin/reviews']] };
  } },
  { perm: 'content', title: '运营：内容与 GEO', build: () => { const drafts = listArticles().filter((a) => a.data.status === 'draft'); return {
    kpis: [['待审核文章', drafts.length, '/admin/content']],
    todos: drafts.slice(0, 5).map((a) => ({ text: `文章待审核：${a.data.title}`, href: `/admin/content/${encodeURIComponent(a.id)}` })),
    links: [['内容', '/admin/content'], ['GEO 监测', '/admin/geo']] }; } },
  { perm: 'system', title: '运维：系统', build: () => {
    const last = backupRuns(1)[0];
    const st = systemStatus();
    const errs = errorStats(24);
    const bad = failingServices();
    const jobFails = listJobs().filter((j) => j.enabled && j.last && !j.last.ok);
    const paused = listJobs().filter((j) => j.paused);
    const peers = peerSites().map((p) => ({ ...p, check: lastChecks(`peer:${p.name}`).last }));
    return {
      kpis: [['站点在线', `${1 + peers.filter((p) => p.check?.ok).length} / ${1 + peers.length}`, '/admin/system/sites'], ['最近备份', last ? `${last.ok ? '成功' : '失败'} ${fmt(last.ts)}` : '还没有备份', '/admin/system'],
        ['磁盘剩余', st.disk ? `${(st.disk.free / 1073741824).toFixed(1)} GB` : '—', '/admin/system'], ['内存', `${st.rssMb} MB`, '/admin/system'], ['24 小时错误', errs.distinct, '/admin/system/errors'], ['外部服务异常', bad.length, '/admin/system/services']],
      todos: [...(backupOverdue() ? [{ text: '最近 36 小时没有成功的数据库备份', href: '/admin/system' }] : []), ...(drillOverdue() ? [{ text: '超过 90 天没有做恢复演练', href: '/admin/system' }] : []),
        ...bad.map((s) => ({ text: `外部服务${s.last.level === 'warn' ? '需处理' : '异常'}：${s.name}（${s.last.detail}）`, href: '/admin/system/services' })),
        ...(errs.open ? [{ text: `${errs.open} 个未解决的服务器错误`, href: '/admin/system/errors' }] : []), ...jobFails.map((j) => ({ text: `定时任务失败：${j.name}`, href: `/admin/system/jobs?job=${encodeURIComponent(j.id)}` })),
        ...paused.map((j) => ({ text: `定时任务已暂停：${j.name}`, href: '/admin/system/jobs' })), ...peers.filter((p) => p.check && !p.check.ok).map((p) => ({ text: `站点 ${p.name} 无法访问`, href: '/admin/system/sites' }))],
      links: [['系统状态', '/admin/system'], ['服务连通性', '/admin/system/services'], ['错误日志', '/admin/system/errors'], ['定时任务', '/admin/system/jobs'], ['登录与会话', '/admin/system/security'], ['操作日志', '/admin/audit']] };
  } },
  { perm: 'audit', title: '操作日志', build: () => ({
    kpis: [['今日操作', n('SELECT COUNT(*) n FROM audit_log WHERE ts >= ?', since(24)), '/admin/audit'], ['今日登录失败 / 越权', n('SELECT COUNT(*) n FROM audit_log WHERE ts >= ? AND ok = 0', since(24)), '/admin/audit?ok=0']],
    todos: [], links: [['操作日志', '/admin/audit']] }) },
];

export function workbench() {
  const u = currentUser();
  const boards = BOARDS.filter((b) => can(u, [b.perm])).map((b) => { try { return { ...b, ...b.build() }; } catch (e) { return { ...b, kpis: [], todos: [{ text: `加载失败：${e.message}`, href: '#' }], links: [] }; } });
  const todos = boards.flatMap((b) => b.todos.map((t) => ({ ...t, board: b.title })));
  return shell('工作台', `<h2>${esc(u.name || u.username)} 的工作台 <span class="mute" style="font-size:14px">${esc(roleNames(u.role))}</span></h2>
<div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(300px,1fr));gap:14px;margin-bottom:8px">${boards.map((b) => `<section style="background:#fff;border:1px solid var(--line);border-radius:10px;padding:12px 14px" data-board="${esc(b.perm)}"><h3 style="margin:0 0 8px;font-size:15px">${esc(b.title)}</h3><div class="tiles" style="margin:0;grid-template-columns:repeat(auto-fit,minmax(120px,1fr))">${b.kpis.map(([l, val, href]) => `<a class="tile" href="${esc(href)}" style="text-decoration:none;color:inherit"><span>${l}</span><strong>${esc(String(val))}</strong></a>`).join('')}</div></section>`).join('')}</div>
<h3>今天要处理的事（${todos.length}）</h3>${todos.length ? `<div class="wrap"><table><tbody>${todos.slice(0, 30).map((t) => `<tr><td class="mute">${esc(t.board)}</td><td><a href="${esc(t.href)}">${esc(t.text)}</a></td></tr>`).join('')}</tbody></table></div>` : '<p class="mute">没有待办，做得好。</p>'}
<h3>常用入口</h3><p>${boards.flatMap((b) => b.links).filter((l, i, a) => a.findIndex((x) => x[1] === l[1]) === i).map(([l, h]) => `<a href="${esc(h)}" style="margin-right:14px">${esc(l)}</a>`).join('')}</p>`);
}

export const todoCount = () => { const u = currentUser(); if (!u) return 0; try { return BOARDS.filter((b) => can(u, [b.perm])).reduce((a, b) => a + b.build().todos.length, 0); } catch { return 0; } };
