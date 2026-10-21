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

const n = (sql, ...a) => db.prepare(sql).get(...a).n;
const v = (sql, ...a) => Number(db.prepare(sql).get(...a).v || 0);
const since = (h) => new Date(Date.now() - h * 3600e3).toISOString();
const money = (x) => `${config.catalog.currency || 'USD'} ${Math.round(x).toLocaleString('en-US')}`;
const todo = (rows, text, href) => rows.map((r) => ({ text: text(r), href: href(r) }));

/** Board definitions: perm → { title, kpis, todos, links }. Order = display order. */
const BOARDS = [
  { perm: 'leads', title: '销售：线索', build: () => ({
    kpis: [['今日新线索', n('SELECT COUNT(*) n FROM leads WHERE created_at >= ?', since(24)), '/admin'], ['今日 A/B 级', n("SELECT COUNT(*) n FROM leads WHERE created_at >= ? AND grade IN ('A','B')", since(24)), '/admin'], ['未处理线索', n("SELECT COUNT(*) n FROM leads WHERE status = 'new'"), '/admin']],
    todos: todo(db.prepare("SELECT id, grade, company, name, email, created_at FROM leads WHERE status = 'new' AND grade IN ('A','B') ORDER BY created_at DESC LIMIT 6").all(), (r) => `${r.grade} 级线索：${r.company || r.name || r.email}`, () => '/admin'),
    links: [['线索', '/admin'], ['导出 CSV', '/admin/leads.csv']] }) },
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
  { perm: 'marketing', title: '运营：营销', build: () => ({
    kpis: [['待审核评价', n("SELECT COUNT(*) n FROM reviews WHERE status = 'pending'"), '/admin/reviews'], ['今日网店订单', n("SELECT COUNT(*) n FROM orders WHERE channel = 'shop' AND created_at >= ?", since(24)), '/admin/orders']],
    todos: todo(db.prepare("SELECT id, product_id, rating FROM reviews WHERE status = 'pending' ORDER BY created_at LIMIT 5").all(), (r) => `${r.product_id} 的 ${r.rating} 星评价待审核`, () => '/admin/reviews'),
    links: [['优惠券', '/admin/coupons'], ['评价', '/admin/reviews']] }) },
  { perm: 'content', title: '运营：内容与 GEO', build: () => { const drafts = listArticles().filter((a) => a.data.status === 'draft'); return {
    kpis: [['待审核文章', drafts.length, '/admin/content']],
    todos: drafts.slice(0, 5).map((a) => ({ text: `文章待审核：${a.data.title}`, href: `/admin/content/${encodeURIComponent(a.id)}` })),
    links: [['内容', '/admin/content'], ['GEO 监测', '/admin/geo']] }; } },
  { perm: 'system', title: '运维：系统', build: () => { const last = backupRuns(1)[0]; const fails = n("SELECT COUNT(*) n FROM content_runs WHERE status = 'error' AND ts >= ?", since(24)) + n('SELECT COUNT(*) n FROM erp_log WHERE ok = 0 AND ts >= ?', since(24)); return {
    kpis: [['最近备份', last ? `${last.ok ? '成功' : '失败'} ${fmt(last.ts)}` : '还没有备份', '/admin/system'], ['24 小时内任务失败', fails, '/admin/system']],
    todos: [...(!last || !last.ok || Date.now() - new Date(last.ts).getTime() > 36 * 3600e3 ? [{ text: '最近 36 小时没有成功的数据库备份', href: '/admin/system' }] : []), ...(fails ? [{ text: `${fails} 个后台任务失败`, href: '/admin/system' }] : [])],
    links: [['系统', '/admin/system'], ['操作日志', '/admin/audit']] }; } },
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
