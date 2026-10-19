// 后台：经营看板、优惠券、商品评价审核
import { shell, esc, fmt } from '../admin.js';
import { config } from '../config.js';
import * as M from './marketing.js';

const flash = (c) => `${c.req.query('m') ? `<div class="warn" style="background:#e8f5e9;border-color:#a5d6a7">${esc(c.req.query('m'))}</div>` : ''}${c.req.query('e') ? `<div class="warn" style="background:#fdecea;border-color:#f5b7b1">${esc(c.req.query('e'))}</div>` : ''}`;
const back = (c, path, k, v) => c.redirect(`${path}?${k}=${encodeURIComponent(v)}`);
const cur = () => config.catalog.currency || 'USD';
const m = (n) => `${cur()} ${Number(n || 0).toLocaleString('en-US', { maximumFractionDigits: 2 })}`;

/** Daily revenue bars (inline SVG, readable without JS). */
function bars(daily) {
  if (!daily.length) return '<p class="mute">最近 30 天还没有成交订单。</p>';
  const W = 760, H = 160, max = Math.max(...daily.map((d) => d.v)) || 1, bw = Math.max(6, Math.floor(W / daily.length) - 4);
  return `<svg viewBox="0 0 ${W} ${H + 30}" role="img" aria-label="近 30 天每日成交额" style="width:100%;max-width:${W}px;height:auto">${daily.map((d, i) => {
    const h = Math.max(2, Math.round((d.v / max) * H)), x = i * (bw + 4);
    return `<rect x="${x}" y="${H - h}" width="${bw}" height="${h}" rx="2" fill="#1565c0"><title>${d.d}：${m(d.v)}（${d.n} 单）</title></rect>${i % Math.ceil(daily.length / 8) === 0 ? `<text x="${x}" y="${H + 16}" font-size="11" fill="#66717d">${d.d.slice(5)}</text>` : ''}`;
  }).join('')}</svg>`;
}

export function mountMarketingAdmin(app) {
  app.get('/admin/dashboard', (c) => {
    const s = M.dashboardStats();
    const tile = (l, v) => `<div class="tile"><span>${l}</span><strong>${v}</strong></div>`;
    return c.html(shell('经营看板', `<h2>经营看板</h2>
<div class="tiles">${tile('今日成交额', m(s.today.gmv))}${tile('近 7 天成交额', m(s.week.gmv))}${tile('近 30 天成交额', m(s.month.gmv))}${tile('近 30 天成交订单', s.month.orders)}${tile('客单价', m(s.month.aov))}${tile('网店下单转化率（订单/购物车）', `${s.month.conversion}%`)}</div>
<div class="tiles">${tile('待付款', `<a href="/admin/orders?status=pending_payment">${s.todo.unpaid}</a>`)}${tile('待发货', `<a href="/admin/orders?status=ready_to_ship">${s.todo.toShip}</a>`)}${tile('待处理售后', `<a href="/admin/rma">${s.todo.rma}</a>`)}${tile('待审核评价', `<a href="/admin/reviews">${s.todo.reviews}</a>`)}</div>
<h3>近 30 天每日成交额</h3><div class="card" style="background:#fff;border:1px solid var(--line);border-radius:8px;padding:14px">${bars(s.daily)}</div>
<h3>热销商品（近 30 天）</h3><div class="wrap"><table><thead><tr><th>SKU</th><th>商品</th><th class="n">数量</th><th class="n">金额</th></tr></thead><tbody>${s.top.map((t) => `<tr><td>${esc(t.sku)}</td><td>${esc(t.name)}</td><td class="n">${t.qty}</td><td class="n">${m(t.revenue)}</td></tr>`).join('') || '<tr><td colspan="4" class="mute">暂无</td></tr>'}</tbody></table></div>
<h3>库存预警（可售 &lt; 20）</h3><div class="wrap"><table><tbody>${s.lowStock.map((x) => `<tr><td>${esc(x.sku)}</td><td>${esc(x.name)}</td><td class="n" style="color:#c62828">${x.available}</td></tr>`).join('') || '<tr><td class="mute">没有低库存商品</td></tr>'}</tbody></table></div>`));
  });

  app.get('/admin/coupons', (c) => {
    const edit = M.listCoupons().find((x) => x.code === c.req.query('edit')) || {};
    const f = (k, l, v = edit[k] ?? '', a = '') => `<label style="display:grid;gap:4px;font-size:13px">${l}<input name="${k}" value="${esc(v)}" ${a}></label>`;
    return c.html(shell('优惠券', `${flash(c)}<h2>优惠券</h2><div class="wrap"><table><thead><tr><th>券码</th><th>优惠</th><th>门槛</th><th>已用 / 上限</th><th>每人</th><th>有效期</th><th>适用品类</th><th>状态</th><th></th></tr></thead><tbody>${M.listCoupons().map((x) => `<tr><td><b>${esc(x.code)}</b><div class="mute">${esc(x.note || '')}</div></td><td>${x.kind === 'percent' ? `${x.value}%` : m(x.value)}</td><td>${x.min_subtotal ? m(x.min_subtotal) : '—'}</td><td>${x.used} / ${x.max_uses ?? '不限'}</td><td>${x.per_customer ?? '不限'}</td><td>${esc((x.starts_at || '').slice(0, 10))} ~ ${esc((x.ends_at || '').slice(0, 10))}</td><td>${esc(x.categories.join(', ') || '全部')}</td><td>${x.active ? '启用' : '<span class="mute">停用</span>'}</td><td><a href="/admin/coupons?edit=${encodeURIComponent(x.code)}">编辑</a></td></tr>`).join('') || '<tr><td colspan="9" class="mute">暂无优惠券</td></tr>'}</tbody></table></div>
<h3>${edit.code ? `编辑 ${esc(edit.code)}` : '新建优惠券'}</h3><form method="post" action="/admin/coupons" style="display:grid;grid-template-columns:repeat(auto-fit,minmax(180px,1fr));gap:10px;max-width:980px">
${f('code', '券码', edit.code, edit.code ? 'readonly' : 'required')}<label style="display:grid;gap:4px;font-size:13px">类型<select name="kind"><option value="percent"${edit.kind === 'fixed' ? '' : ' selected'}>百分比折扣</option><option value="fixed"${edit.kind === 'fixed' ? ' selected' : ''}>固定金额</option></select></label>${f('value', '优惠值（% 或金额）')}${f('min_subtotal', '最低消费')}${f('max_uses', '总次数上限（留空不限）')}${f('per_customer', '每位客户次数（留空不限）', edit.per_customer ?? 1)}
${f('starts_at', '开始时间', (edit.starts_at || '').slice(0, 10), 'type="date"')}${f('ends_at', '结束时间', (edit.ends_at || '').slice(0, 10), 'type="date"')}${f('categories', '适用品类编码（逗号分隔，留空=全部）', (edit.categories || []).join(','))}${f('note', '备注')}
<label style="display:flex;gap:6px;align-items:center"><input type="checkbox" name="active" value="1"${edit.code ? (edit.active ? ' checked' : '') : ' checked'}> 启用</label><button>保存</button></form>`));
  });
  app.post('/admin/coupons', async (c) => {
    const f = await c.req.parseBody();
    try {
      const ends = f.ends_at ? `${f.ends_at}T23:59:59.999Z` : '';
      const code = M.saveCoupon({ ...f, starts_at: f.starts_at ? `${f.starts_at}T00:00:00.000Z` : '', ends_at: ends, active: f.active === '1' });
      return back(c, '/admin/coupons', 'm', `已保存 ${code}`);
    } catch (e) { return back(c, '/admin/coupons', 'e', e.message); }
  });

  app.get('/admin/reviews', (c) => {
    const status = c.req.query('status') ?? 'pending';
    const rows = M.listReviews(status).map((r) => `<tr><td>${fmt(r.created_at)}</td><td>${esc(r.product_id)}</td><td>${'★'.repeat(r.rating)}</td><td><b>${esc(r.title || '')}</b><div>${esc(r.body)}</div>${r.reply ? `<div class="mute">回复：${esc(r.reply)}</div>` : ''}</td><td>${esc(r.email || '')}</td><td>${esc(r.status)}${r.moderated_by ? `<div class="mute">${esc(r.moderated_by)}</div>` : ''}</td>
<td><form method="post" action="/admin/reviews/${r.id}" style="display:grid;gap:4px"><input name="reply" placeholder="公开回复（选填）" value="${esc(r.reply || '')}"><div><button name="status" value="approved">通过</button> <button name="status" value="rejected">拒绝</button></div></form></td></tr>`).join('');
    return c.html(shell('商品评价', `${flash(c)}<h2>商品评价</h2><p>${[['pending', '待审核'], ['approved', '已通过'], ['rejected', '已拒绝'], ['', '全部']].map(([k, l]) => `<a href="/admin/reviews?status=${k}" style="margin-right:10px">${l}</a>`).join('')}</p><p class="mute">只有订单已签收的买家才能评价，每个商品一次。通过后在产品页公开显示（只显示名字和国家）。</p>
<div class="wrap"><table><thead><tr><th>时间</th><th>商品</th><th>评分</th><th>内容</th><th>客户</th><th>状态</th><th>审核</th></tr></thead><tbody>${rows || '<tr><td colspan="7" class="mute">暂无</td></tr>'}</tbody></table></div>`));
  });
  app.post('/admin/reviews/:id', async (c) => {
    const f = await c.req.parseBody();
    try { M.moderateReview(c.req.param('id'), String(f.status), String(f.reply || '')); return back(c, '/admin/reviews', 'm', '已更新'); } catch (e) { return back(c, '/admin/reviews', 'e', e.message); }
  });
}
