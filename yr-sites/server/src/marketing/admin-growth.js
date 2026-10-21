// 后台：运营。经营数据（访客 → 浏览 → 加购 → 下单，趋势、来源、热门页面）、商品数据（可排序、导出）、推广活动（UTM 链接、
// 花费、ROI、获客成本）、自动促销（限时折扣 / 满减）。导出的表格列名跟随后台语言。
import { shell, esc, fmt } from '../admin.js';
import { config } from '../config.js';
import { currentUser } from '../auth.js';
import * as A from './analytics.js';
import * as P from './promotions.js';

const flash = (c) => `${c.req.query('m') ? `<div class="warn" style="background:#e8f5e9;border-color:#a5d6a7">${esc(c.req.query('m'))}</div>` : ''}${c.req.query('e') ? `<div class="warn" style="background:#fdecea;border-color:#f5b7b1">${esc(c.req.query('e'))}</div>` : ''}`;
const back = (c, path, k, v) => c.redirect(`${path}${path.includes('?') ? '&' : '?'}${k}=${encodeURIComponent(v)}`);
const SUB = '<p class="acts"><a href="/admin/marketing">经营数据</a> · <a href="/admin/marketing/products">商品数据</a> · <a href="/admin/marketing/campaigns">推广活动</a> · <a href="/admin/marketing/promotions">限时折扣 / 满减</a> · <a href="/admin/coupons">优惠券</a> · <a href="/admin/reviews">评价</a></p>';
const view = (title, body) => shell(title, SUB + body);
const money = (x) => `${config.catalog.currency || 'USD'} ${(Math.round((Number(x) || 0) * 100) / 100).toLocaleString('en-US')}`;
const pct = (x) => (x == null ? '—' : `${(x * 100).toFixed(1)}%`);
// formula characters at the start are neutralised (CSV injection), but plain numbers such as -12.5% stay numbers
const csvCell = (v) => { let s = String(v ?? ''); if (/^[=+\-@\t\r]/.test(s) && !/^-?\d+(\.\d+)?%?$/.test(s)) s = `'${s}`; return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s; };
const csv = (c, name, cols, rows) => { // cols: [[key, 中文, English]] — headers follow the admin language
  const en = currentUser()?.lang === 'en';
  c.header('content-type', 'text/csv; charset=utf-8');
  c.header('content-disposition', `attachment; filename="${name}-${new Date().toISOString().slice(0, 10)}.csv"`);
  return c.body('﻿' + [cols.map((x) => (en ? x[2] : x[1])).join(','), ...rows.map((r) => cols.map(([k]) => csvCell(r[k])).join(','))].join('\r\n') + '\r\n');
};
const PERIODS = [[1, '今天'], [7, '近 7 天'], [30, '近 30 天'], [90, '近 90 天']];
const period = (c, d = 30) => { const n = Number(c.req.query('days')); return PERIODS.some(([k]) => k === n) ? n : d; };
const periodLinks = (days, path) => PERIODS.map(([k, l]) => `<a href="${path}?days=${k}" style="margin-right:10px;${k === days ? 'font-weight:700;color:var(--ink);text-decoration:none' : ''}">${l}</a>`).join('');

/** Small inline bar chart (one series) with a line for a second series. */
function chart(series, bar, line) {
  const W = 760, H = 160, n = series.length, bw = W / n;
  const maxB = Math.max(1, ...series.map((r) => r[bar])), maxL = Math.max(1, ...series.map((r) => r[line]));
  const pts = series.map((r, i) => `${(i + 0.5) * bw},${H - 18 - (r[line] / maxL) * (H - 30)}`).join(' ');
  return `<svg viewBox="0 0 ${W} ${H}" style="width:100%;max-width:${W}px;background:#fff;border:1px solid var(--line);border-radius:8px" role="img" aria-label="趋势图">
${series.map((r, i) => `<rect x="${i * bw + 2}" y="${H - 18 - (r[bar] / maxB) * (H - 30)}" width="${Math.max(1, bw - 4)}" height="${(r[bar] / maxB) * (H - 30)}" fill="#90caf9"><title>${r.day}：${r[bar]}</title></rect>`).join('')}
<polyline points="${pts}" fill="none" stroke="#c62828" stroke-width="2"/>${series.map((r, i) => (i % Math.ceil(n / 6) === 0 ? `<text x="${i * bw + 2}" y="${H - 4}" font-size="10" fill="#66717d">${r.day.slice(5)}</text>` : '')).join('')}</svg>`;
}

function overviewPage(c) {
  const days = period(c, 1);
  const f = A.funnel(days);
  const series = A.dailySeries(30);
  const tile = (l, v) => `<div class="tile"><span>${l}</span><strong>${v}</strong></div>`;
  return view('经营数据', `<h2>经营数据</h2><p>${periodLinks(days, '/admin/marketing')}</p>
<div class="tiles">${tile('访客', f.visitors)}${tile('页面浏览', f.views)}${tile('商品浏览', f.productViews)}${tile('加入购物车', f.carts)}${tile('网店订单', f.orders)}${tile('下单转化率', pct(f.conversion))}${tile('询价', f.leads)}${tile('询价率', pct(f.inquiryRate))}${tile('在线成交额（已付款）', money(f.revenue))}</div>
<h3>近 30 天趋势 <span class="mute" style="font-size:13px">蓝色柱：访客；红线：网店订单</span></h3>${chart(series, 'visitors', 'orders')}
<div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(320px,1fr));gap:16px;margin-top:16px">
<div><h3>访客来源（近 30 天）</h3><div class="wrap"><table><thead><tr><th>来源</th><th class="n">访客</th></tr></thead><tbody>${A.topSources(30).map((r) => `<tr><td>${esc(r.src)}</td><td class="n">${r.visitors}</td></tr>`).join('') || '<tr><td colspan="2" class="mute">暂无数据</td></tr>'}</tbody></table></div></div>
<div><h3>热门页面（近 30 天）</h3><div class="wrap"><table><thead><tr><th>页面</th><th class="n">浏览</th><th class="n">访客</th></tr></thead><tbody>${A.topPages(30).map((r) => `<tr><td translate="no">${esc(r.path)}</td><td class="n">${r.views}</td><td class="n">${r.visitors}</td></tr>`).join('') || '<tr><td colspan="3" class="mute">暂无数据</td></tr>'}</tbody></table></div></div></div>
<p class="mute">数据来自网站自己的统计（不使用第三方统计代码，不记录个人信息）：访客按"当天 + 网络地址 + 浏览器"去重；机器人和后台页面不计入。</p>`);
}

const SORTS = { views: '浏览', carts: '加购', orders: '订单', conversion: '转化率', revenue: '销售额', cartRate: '加购率' };
function productsPage(c) {
  const days = period(c, 30);
  const sort = SORTS[c.req.query('sort')] ? c.req.query('sort') : 'views';
  const stats = A.productStats(days);
  const rows = config.catalog.products.map((p) => ({ id: p.id, name: p.name, ...(stats.get(p.id) || { views: 0, carts: 0, orders: 0, units: 0, revenue: 0, cartRate: null, conversion: null }) }))
    .sort((a, b) => (b[sort] ?? -1) - (a[sort] ?? -1));
  const th = (k, l) => `<th class="n"><a href="?days=${days}&sort=${k}"${k === sort ? ' style="font-weight:700;color:var(--ink)"' : ''}>${l}</a></th>`;
  const hint = (r) => (r.views >= 30 && !r.carts ? '浏览多但没人加购：检查价格、主图和详情' : r.carts >= 5 && !r.orders ? '加购多但没下单：检查运费和结算' : '');
  return view('商品数据', `<h2>商品数据</h2><p>${periodLinks(days, '/admin/marketing/products')} · <a href="/admin/marketing/products.csv?days=${days}&sort=${sort}">导出表格</a></p>
<div class="wrap"><table><thead><tr><th>商品</th>${th('views', '浏览')}${th('carts', '加购')}${th('cartRate', '加购率')}${th('orders', '订单')}${th('conversion', '转化率')}<th class="n">件数</th>${th('revenue', '销售额')}<th>提示</th></tr></thead><tbody>
${rows.map((r) => `<tr><td><a href="/admin/products/${encodeURIComponent(r.id)}"><b>${esc(r.name)}</b></a><div class="mute">${esc(r.id)}</div></td><td class="n">${r.views}</td><td class="n">${r.carts}</td><td class="n">${pct(r.cartRate)}</td><td class="n">${r.orders}</td><td class="n">${pct(r.conversion)}</td><td class="n">${r.units}</td><td class="n">${money(r.revenue)}</td><td class="mute">${hint(r)}</td></tr>`).join('')}</tbody></table></div>
<p class="mute">"浏览"来自网站商品页，"加购"是加入购物车次数，"订单"包括网店订单和报价转成的订单（取消的不算）。</p>`);
}

function campaignsPage(c) {
  const list = A.listCampaigns().map((x) => ({ ...x, s: A.campaignStats(x.code, x.spend) }));
  const edit = c.req.query('edit') ? A.getCampaign(c.req.query('edit')) : null;
  const unreg = A.unregisteredCodes();
  const inp = (n, l, v = '', a = '') => `<label class="fl2" style="display:inline-flex;flex-direction:column;margin:0 10px 8px 0;font-size:12px;color:var(--mute)">${l}<input name="${n}" value="${esc(v ?? '')}" ${a}></label>`;
  return view('推广活动', `${flash(c)}<h2>推广活动</h2><p class="mute">每个推广渠道（谷歌广告、Facebook、展会二维码、邮件、合作伙伴…）建一个活动，把生成的链接用在广告或二维码里。通过链接进来的访客在 30 天内的询价和下单都算在这个活动上；填写花费后自动计算投入产出比和获客成本。</p>
<div class="wrap"><table><thead><tr><th>活动</th><th>推广链接</th><th class="n">访客</th><th class="n">询价</th><th class="n">订单</th><th class="n">成交额（已收款）</th><th class="n">花费</th><th class="n">投入产出比</th><th class="n">单个询价成本</th><th class="n">获客成本</th><th></th></tr></thead><tbody>
${list.map((x) => `<tr><td><b>${esc(x.name)}</b><div class="mute">${esc(x.code)}${x.source ? ` · ${esc(x.source)}` : ''}${x.medium ? ` / ${esc(x.medium)}` : ''}${x.starts_at ? ` · ${esc(x.starts_at)}` : ''}${x.ends_at ? ` – ${esc(x.ends_at)}` : ''}</div></td><td><input readonly value="${esc(A.campaignLink(x))}" style="width:260px" onclick="this.select()" aria-label="推广链接"></td>
<td class="n">${x.s.visitors}</td><td class="n">${x.s.leads}</td><td class="n">${x.s.orders}</td><td class="n">${money(x.s.revenue)}</td><td class="n">${money(x.spend)}</td><td class="n">${x.s.roi == null ? '—' : pct(x.s.roi)}</td><td class="n">${x.s.costPerLead == null ? '—' : money(x.s.costPerLead)}</td><td class="n">${x.s.cac == null ? '—' : money(x.s.cac)}</td>
<td><a href="?edit=${x.id}#form">编辑</a> <form method="post" action="/admin/marketing/campaigns/${x.id}/delete" style="display:inline" onsubmit="return confirm('删除这个活动？已记录的访问数据保留。')"><button>删除</button></form></td></tr>`).join('') || '<tr><td colspan="11" class="mute">还没有推广活动</td></tr>'}</tbody></table></div>
<p><a href="/admin/marketing/campaigns.csv">导出表格</a></p>
${unreg.length ? `<h3>未登记的推广代码</h3><p class="mute">这些代码出现在访问链接里，但还没有建活动：</p><p>${unreg.map((u) => `<span class="pill" translate="no">${esc(u.code)}</span> ${u.visitors}`).join('　')}</p>` : ''}
<form method="post" action="/admin/marketing/campaigns" id="form" class="msg" style="max-width:none"><h3 style="margin-top:0">${edit ? `编辑「${esc(edit.name)}」` : '新建推广活动'}</h3>${edit ? `<input type="hidden" name="id" value="${edit.id}">` : ''}
${inp('name', '活动名称 *', edit?.name, 'required')}${inp('code', '活动代码 *（链接里的 utm_campaign）', edit?.code, 'required placeholder="google-uk-2026q4"')}${inp('source', '来源（utm_source）', edit?.source, 'placeholder="google"')}${inp('medium', '方式（utm_medium）', edit?.medium, 'placeholder="cpc"')}
${inp('landing', '落地页', edit?.landing || '/', 'placeholder="/products/ufo-high-bay-u2/"')}${inp('spend', '投放花费', edit?.spend ?? 0, 'inputmode="decimal"')}${inp('starts_at', '开始日期', edit?.starts_at, 'type="date"')}${inp('ends_at', '结束日期', edit?.ends_at, 'type="date"')}${inp('notes', '备注', edit?.notes)}<div><button>${edit ? '保存' : '创建并生成链接'}</button></div></form>`);
}

function promotionsPage(c) {
  const list = P.listPromotions();
  const edit = c.req.query('edit') ? P.getPromotion(c.req.query('edit')) : null;
  const local = (iso) => (iso ? new Date(new Date(iso).getTime() - new Date(iso).getTimezoneOffset() * 60e3).toISOString().slice(0, 16) : '');
  const inp = (n, l, v = '', a = '') => `<label style="display:inline-flex;flex-direction:column;margin:0 10px 8px 0;font-size:12px;color:var(--mute)">${l}<input name="${n}" value="${esc(v ?? '')}" ${a}></label>`;
  const COL = { running: '#e3f2e5', scheduled: '#e3f2fd', ended: '#eceff1', off: '#eceff1' };
  return view('限时折扣 / 满减', `${flash(c)}<h2>限时折扣 / 满减</h2><p class="mute">到开始时间自动生效、到结束时间自动结束，客户不需要输入优惠码。购物车和结算按当时最划算的一个活动自动减价（可以和优惠码同时使用，但优惠总额不超过商品金额）；商品页显示促销标签，网站首页显示"正在促销"专区。</p>
<div class="wrap"><table><thead><tr><th>活动</th><th>优惠</th><th>适用范围</th><th>时间</th><th>状态</th><th></th></tr></thead><tbody>
${list.map((p) => { const s = P.promoState(p); return `<tr><td><b>${esc(p.name)}</b>${p.name_en ? `<div class="mute" translate="no">${esc(p.name_en)}</div>` : ''}</td><td>${p.kind === 'percent' ? `减 ${p.value}%` : `满 ${p.threshold} 减 ${p.value}`}</td><td>${p.products.length ? esc(p.products.join('、')) : ''}${p.categories.length ? `品类 ${esc(p.categories.join('、'))}` : ''}${!p.products.length && !p.categories.length ? '全部商品' : ''}</td>
<td>${fmt(p.starts_at)}<br>${fmt(p.ends_at)}</td><td><span class="pill" style="background:${COL[s]}">${P.STATES[s]}</span></td><td><a href="?edit=${p.id}#form">编辑</a> <form method="post" action="/admin/marketing/promotions/${p.id}/${p.active ? 'stop' : 'start'}" style="display:inline"><button>${p.active ? '停用' : '启用'}</button></form></td></tr>`; }).join('') || '<tr><td colspan="6" class="mute">还没有促销活动</td></tr>'}</tbody></table></div>
<form method="post" action="/admin/marketing/promotions" id="form" class="msg" style="max-width:none"><h3 style="margin-top:0">${edit ? `编辑「${esc(edit.name)}」` : '新建促销活动'}</h3>${edit ? `<input type="hidden" name="id" value="${edit.id}">` : ''}
${inp('name', '名称（中文）*', edit?.name, 'required placeholder="双十一大促"')}${inp('name_en', '名称（英文，客户看到的）', edit?.name_en, 'placeholder="Black Friday"')}
<label style="display:inline-flex;flex-direction:column;margin:0 10px 8px 0;font-size:12px;color:var(--mute)">类型<select name="kind">${Object.entries(P.KINDS).map(([k, l]) => `<option value="${k}"${(edit?.kind || 'percent') === k ? ' selected' : ''}>${l}</option>`).join('')}</select></label>
${inp('value', '折扣 %（打折）或减免金额（满减）*', edit?.value, 'required inputmode="decimal"')}${inp('threshold', '满减门槛金额', edit?.threshold || '', 'inputmode="decimal"')}<br>
${inp('products', '指定商品（型号，逗号分隔，可留空）', edit?.products?.join(', '), 'size="30"')}${inp('categories', '或指定品类（编码，逗号分隔）', edit?.categories?.join(', '))}<br>
${inp('starts_at', '开始时间 *', local(edit?.starts_at), 'type="datetime-local" required')}${inp('ends_at', '结束时间 *', local(edit?.ends_at), 'type="datetime-local" required')}<div><button>${edit ? '保存' : '创建'}</button></div></form>`);
}

export function mountGrowthAdmin(app) {
  app.get('/admin/marketing', (c) => c.html(overviewPage(c)));
  app.get('/admin/marketing/products', (c) => c.html(productsPage(c)));
  app.get('/admin/marketing/products.csv', (c) => {
    const days = period(c, 30);
    const stats = A.productStats(days);
    const rows = config.catalog.products.map((p) => { const s = stats.get(p.id) || {}; return { id: p.id, name: p.name, views: s.views || 0, carts: s.carts || 0, orders: s.orders || 0, units: s.units || 0, revenue: Math.round((s.revenue || 0) * 100) / 100, conversion: s.conversion == null ? '' : (s.conversion * 100).toFixed(1) + '%' }; });
    return csv(c, 'product-data', [['id', '型号', 'Model'], ['name', '名称', 'Name'], ['views', '浏览', 'Views'], ['carts', '加购', 'Add to cart'], ['orders', '订单', 'Orders'], ['units', '件数', 'Units'], ['revenue', '销售额', 'Revenue'], ['conversion', '转化率', 'Conversion']], rows);
  });
  app.get('/admin/marketing/campaigns', (c) => c.html(campaignsPage(c)));
  app.get('/admin/marketing/campaigns.csv', (c) => csv(c, 'campaigns', [['name', '活动', 'Campaign'], ['code', '代码', 'Code'], ['visitors', '访客', 'Visitors'], ['leads', '询价', 'Inquiries'], ['orders', '订单', 'Orders'], ['revenue', '成交额', 'Revenue'], ['spend', '花费', 'Spend'], ['roi', '投入产出比', 'ROI'], ['cac', '获客成本', 'Cost per customer']],
    A.listCampaigns().map((x) => { const s = A.campaignStats(x.code, x.spend); return { ...x, ...s, roi: s.roi == null ? '' : (s.roi * 100).toFixed(1) + '%', cac: s.cac == null ? '' : Math.round(s.cac * 100) / 100 }; })));
  app.post('/admin/marketing/campaigns', async (c) => {
    const f = Object.fromEntries(Object.entries(await c.req.parseBody()).map(([k, v]) => [k, String(v)]));
    try { A.saveCampaign(f); return back(c, '/admin/marketing/campaigns', 'm', f.id ? '已保存' : '活动已创建，复制下面的推广链接使用'); } catch (e) { return back(c, `/admin/marketing/campaigns${f.id ? `?edit=${f.id}` : ''}`, 'e', e.message); }
  });
  app.post('/admin/marketing/campaigns/:id/delete', (c) => { A.deleteCampaign(c.req.param('id')); return back(c, '/admin/marketing/campaigns', 'm', '已删除'); });
  app.get('/admin/marketing/promotions', (c) => c.html(promotionsPage(c)));
  app.post('/admin/marketing/promotions', async (c) => {
    const f = Object.fromEntries(Object.entries(await c.req.parseBody()).map(([k, v]) => [k, String(v)]));
    try { P.savePromotion(f); return back(c, '/admin/marketing/promotions', 'm', '促销活动已保存，到时间自动生效'); } catch (e) { return back(c, `/admin/marketing/promotions${f.id ? `?edit=${f.id}` : ''}`, 'e', e.message); }
  });
  app.post('/admin/marketing/promotions/:id/stop', (c) => { P.setPromotionActive(c.req.param('id'), false); return back(c, '/admin/marketing/promotions', 'm', '已停用'); });
  app.post('/admin/marketing/promotions/:id/start', (c) => { P.setPromotionActive(c.req.param('id'), true); return back(c, '/admin/marketing/promotions', 'm', '已启用'); });
}
