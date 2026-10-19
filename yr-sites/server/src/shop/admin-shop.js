// 后台：网店（支付通道状态、运费模板、待付款订单、邮件发件箱）
import { shell, esc, fmt } from '../admin.js';
import { listZones, saveZone, deleteZone } from './freight.js';
import { stripeEnabled, paypalEnabled } from './payments.js';
import { outbox } from './mailer.js';
import { listOrders } from '../ops/service.js';
import { expireUnpaid } from './checkout.js';

const flash = (c) => `${c.req.query('m') ? `<div class="warn" style="background:#e8f5e9;border-color:#a5d6a7">${esc(c.req.query('m'))}</div>` : ''}${c.req.query('e') ? `<div class="warn" style="background:#fdecea;border-color:#f5b7b1">${esc(c.req.query('e'))}</div>` : ''}`;
const back = (c, path, k, v) => c.redirect(`${path}?${k}=${encodeURIComponent(v)}`);
const SUB = `<p>${[['/admin/shop', '网店概览'], ['/admin/shop/freight', '运费模板'], ['/admin/orders?status=pending_payment', '待付款订单']].map(([h, l]) => `<a href="${h}" style="margin-right:12px">${l}</a>`).join('')}</p>`;
const yes = (b) => (b ? '<b style="color:#2e7d32">已启用</b>' : '<span class="mute">未配置</span>');

export function mountShopAdmin(app) {
  app.get('/admin/shop', (c) => {
    const pending = listOrders("WHERE o.channel = 'shop' AND o.status = 'pending_payment'");
    const recent = listOrders("WHERE o.channel = 'shop'").slice(0, 20);
    const mails = outbox(15);
    return c.html(shell('网店', `${SUB}${flash(c)}<h2>网店概览</h2>
<div class="tiles"><div class="tile"><span>待付款订单</span><strong>${pending.length}</strong></div><div class="tile"><span>Stripe（银行卡/Apple Pay/Google Pay）</span><strong>${yes(stripeEnabled())}</strong></div><div class="tile"><span>PayPal</span><strong>${yes(paypalEnabled())}</strong></div><div class="tile"><span>银行电汇</span><strong>${yes(true)}</strong></div><div class="tile"><span>邮件发送</span><strong>${yes(Boolean(process.env.SMTP_URL))}</strong></div></div>
<p class="mute">支付和邮件账号在服务器环境变量中配置（STRIPE_SECRET_KEY / STRIPE_WEBHOOK_SECRET、PAYPAL_CLIENT_ID / PAYPAL_CLIENT_SECRET / PAYPAL_API_BASE、SMTP_URL），见《部署手册》。电汇收款账户在站点设置文件的 bank 字段中维护。</p>
<form method="post" action="/admin/shop/expire" style="margin:10px 0"><button>立即取消已超时的未付款订单</button></form>
<h3>最近网店订单</h3><div class="wrap"><table><thead><tr><th>订单</th><th>时间</th><th>客户</th><th>状态</th><th>付款方式</th><th class="n">金额</th></tr></thead><tbody>${recent.map((o) => `<tr><td><a href="/admin/orders/${o.id}">${esc(o.number)}</a></td><td>${fmt(o.created_at)}</td><td>${esc(o.email || '')}</td><td>${esc(o.status)}</td><td>${esc(o.payment_method || '')}</td><td class="n">${esc(o.currency)} ${o.total}</td></tr>`).join('') || '<tr><td colspan="6" class="mute">暂无</td></tr>'}</tbody></table></div>
<h3>最近邮件</h3><div class="wrap"><table><tbody>${mails.map((m) => `<tr><td>${fmt(m.created_at)}</td><td>${esc(m.to_addr)}</td><td>${esc(m.subject)}</td><td>${esc(m.status)}${m.error ? ` <span class="mute">${esc(m.error)}</span>` : ''}</td></tr>`).join('') || '<tr><td class="mute">暂无</td></tr>'}</tbody></table></div>`));
  });
  app.post('/admin/shop/expire', (c) => back(c, '/admin/shop', 'm', `已取消 ${expireUnpaid()} 个超时订单`));

  app.get('/admin/shop/freight', (c) => {
    const edit = listZones({ all: true }).find((z) => String(z.id) === c.req.query('edit')) || {};
    const row = (z) => `<tr><td>${z.sort}</td><td><b>${esc(z.name)}</b>${z.active ? '' : ' <span class="mute">（停用）</span>'}</td><td><code>${esc(z.countries)}</code></td><td>首重 ${z.first_kg} kg ${z.first_fee}，续重每 kg ${z.extra_fee_per_kg}</td><td>体积重除数 ${z.volumetric_divisor}</td><td>${z.free_over != null ? `满 ${z.free_over} 包邮` : '—'}</td><td>${z.days_min}–${z.days_max} 天</td><td><a href="/admin/shop/freight?edit=${z.id}">编辑</a></td></tr>`;
    const f = (k, l, v = edit[k] ?? '') => `<label style="display:grid;gap:4px;font-size:13px">${l}<input name="${k}" value="${esc(v)}"></label>`;
    return c.html(shell('运费模板', `${SUB}${flash(c)}<h2>运费模板</h2><p class="mute">按收货国家匹配模板（"*" 为其他所有国家）。计费重量 = 实重与体积重（箱体积 m³ × 1,000,000 ÷ 除数）取大，首重之后按每公斤加收；订单商品金额达到包邮门槛免运费。同一国家可配多个模板（如快递和海运），客户结算时选择。</p>
<div class="wrap"><table><thead><tr><th>排序</th><th>名称</th><th>国家</th><th>计费</th><th>体积重</th><th>包邮</th><th>时效</th><th></th></tr></thead><tbody>${listZones({ all: true }).map(row).join('')}</tbody></table></div>
<h3>${edit.id ? `编辑：${esc(edit.name)}` : '新增模板'}</h3><form method="post" action="/admin/shop/freight" style="display:grid;grid-template-columns:repeat(auto-fit,minmax(180px,1fr));gap:10px;max-width:980px"><input type="hidden" name="id" value="${esc(edit.id ?? '')}">
${f('name', '名称')}${f('countries', '国家代码（逗号分隔，* = 其他）')}${f('method', '方式（express / sea / air）', edit.method || 'express')}${f('first_kg', '首重 kg', edit.first_kg ?? 1)}${f('first_fee', '首重运费')}${f('extra_fee_per_kg', '续重每 kg 运费')}${f('volumetric_divisor', '体积重除数', edit.volumetric_divisor ?? 5000)}${f('free_over', '包邮门槛（留空不包邮）')}${f('days_min', '时效最短天数')}${f('days_max', '时效最长天数')}${f('sort', '排序', edit.sort ?? 0)}
<label style="display:flex;gap:6px;align-items:center"><input type="checkbox" name="active" value="1"${edit.id ? (edit.active ? ' checked' : '') : ' checked'}> 启用</label><button>保存</button></form>
${edit.id ? `<form method="post" action="/admin/shop/freight/${edit.id}/delete" onsubmit="return confirm('删除该模板？')" style="margin-top:10px"><button>删除模板</button></form>` : ''}`));
  });
  app.post('/admin/shop/freight', async (c) => {
    const f = await c.req.parseBody();
    try { saveZone({ ...f, active: f.active === '1' }); return back(c, '/admin/shop/freight', 'm', '已保存，结算页立即生效'); } catch (e) { return c.redirect(`/admin/shop/freight?${new URLSearchParams({ e: e.message, ...(f.id ? { edit: String(f.id) } : {}) })}`); }
  });
  app.post('/admin/shop/freight/:id/delete', (c) => { deleteZone(c.req.param('id')); return back(c, '/admin/shop/freight', 'm', '已删除'); });
}
